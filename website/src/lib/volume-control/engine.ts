/**
 * VolumeEngine — a faithful web-page port of the Volume Control extension's
 * MAIN-world audio processing (page-audio-hook.js v7.1) plus the isolated
 * content script's native fallback volume (cs.js).
 *
 * What is replicated 1:1:
 *  - Shared AudioContext for all media element routes (mediaAudioContext).
 *  - Per-element 8-node graph:
 *      MediaElementSource → inputAnalyser(fft 8192, smooth .35) →
 *      gain(channelInterpretation "speakers") →
 *      [mono: splitter(2) → L/R gains (0.5) → merger(2)] →
 *      limiter(DynamicsCompressor: ceiling/knee 0/ratio 20/attack 3ms/release 120ms) →
 *      outputAnalyser(fft 1024, smooth .35) → destination
 *  - Lazy routing: a WebAudio route is only created when the extension would
 *    need one (muted || mono || normalize || boost > 0 dB) and the element is
 *    audible. Once captured, an element can never return to native audio.
 *  - Native fallback volume (element.volume, attenuation-only, composes with
 *    the site's own volume, rate-limited to one write per 250 ms) for media
 *    that stays uncaptured — exactly cs.js applyFallbackVolume.
 *  - 100 ms sampler: pre-gain RMS/peak feeds computeSafeNormalizerGainDb;
 *    post-limiter peak feeds the popup's dBFS meter.
 *  - 15 ms anti-zipper manual gain ramps; setTargetAtTime 8 ms down / 35 ms up
 *    for automatic gain; seek/track-change AGC resets.
 *  - Simulated media restrictions: boost limit clamps the slider to 0 dB,
 *    mono and Normalize become unavailable (reason "restricted" for DRM,
 *    "cross-origin" for tainted media) and media falls back to native volume
 *    control — the extension's real behavior on DRM/CORS-protected pages.
 *  - Debug "HTML Media Route Override" (page-audio-hook ~1450-1470):
 *    "native" keeps HTML media on native volume (no new WebAudio capture,
 *    boost capped at 0 dB, mono/Normalize unavailable — cs.js 600-605);
 *    "webaudio" captures eagerly, even for pure attenuation.
 */

import {
  MAX_DB,
  DEFAULT_NORMALIZER_CONFIG,
  normalizeDb,
  getGainValue,
  dbToGain,
  normalizeNormalizerConfig,
  computeSafeNormalizerGainDb,
  applyLimiterParams,
  createMusicLevelState,
} from "./core";
import type {
  AudioControlState,
  ChainSnapshot,
  ExtensionState,
  MeterState,
  RoutingMode,
} from "./types";
import type { MusicLevelState } from "./core";

/** The WebAudio processing chain for one captured media element. */
interface MediaRoute {
  element: HTMLMediaElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  inputAnalyser: AnalyserNode;
  gain: GainNode;
  splitter: ChannelSplitterNode;
  leftGain: GainNode;
  rightGain: GainNode;
  merger: ChannelMergerNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  currentMode: RoutingMode | null;
  outputConnected: boolean;
  normalizerGainDb: number;
  musicLevelState: MusicLevelState | null;
  meterBuffer: Float32Array<ArrayBuffer>;
  inputBuffer: Float32Array<ArrayBuffer>;
}

/** Per-element bookkeeping (fallback volume state exists even uncaptured). */
interface ElementEntry {
  element: HTMLMediaElement;
  route: MediaRoute | null;
  /** The site's intended base volume while fallback is engaged. */
  siteBaseVolume: number;
  /** Last fallback volume we wrote (null = fallback not engaged). */
  lastAppliedFallback: number | null;
  pendingFallbackWrite: number | null;
  fallbackWriteTimer: ReturnType<typeof setTimeout> | null;
}

export class VolumeEngine {
  private static instance: VolumeEngine | null = null;

  static getInstance(): VolumeEngine {
    if (!VolumeEngine.instance) VolumeEngine.instance = new VolumeEngine();
    return VolumeEngine.instance;
  }

  private context: AudioContext | null = null;
  private entries = new Map<HTMLMediaElement, ElementEntry>();
  private state: ExtensionState = {
    extensionActive: true,
    enabled: true,
    dB: 0,
    requestedDb: 0,
    mono: false,
    muted: false,
    normalizerEnabled: false,
    normalizerConfig: { ...DEFAULT_NORMALIZER_CONFIG },
    debugRouteMode: "auto",
  };
  /** Simulated DRM/cross-origin restriction for the current site
   *  ("" | "restricted" | "cross-origin") — the boost-limit verdict the
   *  store resolves after the debug bypasses (cs.js isBoostLimitReasonBypassed). */
  private restriction = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private meterListeners = new Set<(m: MeterState) => void>();
  private chainListeners = new Set<(s: ChainSnapshot) => void>();
  private lastMeter: MeterState = { peakDb: -Infinity, normalizerGainDb: 0 };

  private constructor() {}

  // ---------------------------------------------------------------- state ---

  setState(partial: Partial<ExtensionState>): void {
    const prev = this.state;
    const next: ExtensionState = { ...this.state, ...partial };
    next.normalizerConfig = normalizeNormalizerConfig(
      partial.normalizerConfig ?? this.state.normalizerConfig,
    );
    next.dB = this.clampByLimit(next.requestedDb);
    this.state = next;

    const normalizerToggled = prev.normalizerEnabled !== next.normalizerEnabled;
    const modeChanged = prev.normalizerConfig.mode !== next.normalizerConfig.mode;

    for (const entry of this.entries.values()) {
      if (entry.route && (normalizerToggled || modeChanged)) {
        // Toggling or switching styles resets stale automatic gain.
        entry.route.normalizerGainDb = 0;
        entry.route.musicLevelState = null;
      }
      this.syncEntry(entry);
    }
    this.syncTimer();
    this.notifyChain();
  }

  /** cs.js verdict layer: the raw DRM/CORS restriction (already bypass
   *  filtered) plus the native-route route policy — a more informative
   *  DRM/CORS verdict outranks native-route (cs.js 600-605). */
  setRestriction(reason: string): void {
    const next = reason === "restricted" || reason === "cross-origin" ? reason : "";
    if (this.restriction === next) return;
    this.restriction = next;
    this.state = { ...this.state, dB: this.clampByLimit(this.state.requestedDb) };
    for (const entry of this.entries.values()) this.syncEntry(entry);
    this.syncTimer();
    this.notifyChain();
  }

  getRestriction(): string {
    return this.restriction;
  }

  /** cs.js getBoostLimitInfo: the final limitation reason for the popup. */
  private limitationReason(): string {
    if (this.restriction) return this.restriction;
    if (this.state.debugRouteMode === "native") return "native-route";
    return "";
  }

  private clampByLimit(requestedDb: number): number {
    return Math.min(normalizeDb(requestedDb), this.maxDb());
  }

  private maxDb(): number {
    return this.limitationReason() ? 0 : MAX_DB;
  }

  /** page-audio-hook.js effectiveGain. */
  private effectiveGain(): number {
    if (!this.state.extensionActive || !this.state.enabled) return 1.0;
    if (this.state.muted) return 0;
    return getGainValue(this.state.dB);
  }

  /** page-audio-hook.js mediaNeedsAudioRoute — route only when processing is
   *  actually required. Pure attenuation stays native (fallback volume).
   *  The debug route override (state.debugRouteMode) sits on top exactly like
   *  the hook: "native" forbids new capture, "webaudio" captures eagerly;
   *  a DRM/CORS restriction dominates the forced route (the options-page
   *  warning: Force WebAudio does not by itself bypass DRM or CORS). */
  private mediaNeedsAudioRoute(): boolean {
    if (!this.state.extensionActive || !this.state.enabled) return false;
    if (this.restriction) return false;
    if (this.state.debugRouteMode === "native") return false;
    if (this.state.debugRouteMode === "webaudio") return true;
    return this.state.muted || this.state.mono || this.state.normalizerEnabled ||
      getGainValue(this.state.dB) > 1;
  }

  /** page-audio-hook.js safetyLimiterRequired. */
  private safetyLimiterRequired(): boolean {
    return this.state.extensionActive && this.state.enabled &&
      !this.restriction &&
      (this.state.normalizerEnabled || (!this.state.muted && this.state.dB > 0));
  }

  /** page-audio-hook.js currentRoutingMode. */
  private currentRoutingMode(): RoutingMode {
    if (!this.state.extensionActive || !this.state.enabled) return "bypass";
    return ((this.state.mono ? "mono" : "stereo") +
      (this.safetyLimiterRequired() ? "-limited" : "-direct")) as RoutingMode;
  }

  // -------------------------------------------------------------- elements ---

  attach(element: HTMLMediaElement): void {
    if (this.entries.has(element)) return;
    this.entries.set(element, {
      element,
      route: null,
      siteBaseVolume: element.volume,
      lastAppliedFallback: null,
      pendingFallbackWrite: null,
      fallbackWriteTimer: null,
    });
    element.addEventListener("play", this.handlePlay);
    element.addEventListener("seeking", this.handleSeeking);
    element.addEventListener("ended", this.handleTrackChange);
    element.addEventListener("emptied", this.handleTrackChange);
    element.addEventListener("volumechange", this.handleVolumeChange);
    this.syncEntry(this.entries.get(element)!);
    this.syncTimer();
    this.notifyChain();
  }

  detach(element: HTMLMediaElement): void {
    const entry = this.entries.get(element);
    if (!entry) return;
    element.removeEventListener("play", this.handlePlay);
    element.removeEventListener("seeking", this.handleSeeking);
    element.removeEventListener("ended", this.handleTrackChange);
    element.removeEventListener("emptied", this.handleTrackChange);
    element.removeEventListener("volumechange", this.handleVolumeChange);
    if (entry.fallbackWriteTimer) clearTimeout(entry.fallbackWriteTimer);
    try { delete element.dataset.vcHooked; } catch { /* ignore */ }
    // Restore the site's intended volume before releasing the element.
    if (entry.lastAppliedFallback !== null &&
        Math.abs(element.volume - entry.lastAppliedFallback) < 1e-6) {
      try { element.volume = entry.siteBaseVolume; } catch { /* ignore */ }
    }
    if (entry.route) this.disconnectRouteOutput(entry.route);
    this.entries.delete(element);
    this.syncTimer();
    this.notifyChain();
  }

  private handlePlay = (event: Event): void => {
    if (this.context && this.context.state === "suspended") {
      void this.context.resume();
    }
    const element = event.target as HTMLMediaElement;
    const entry = this.entries.get(element);
    if (entry) this.syncEntry(entry);
    this.syncTimer();
  };

  private handleSeeking = (event: Event): void => {
    const entry = this.entries.get(event.target as HTMLMediaElement);
    if (entry?.route) {
      // Seek discards positive auto gain so the next section starts clean.
      if (entry.route.normalizerGainDb > 0) {
        entry.route.normalizerGainDb = 0;
        entry.route.musicLevelState = null;
      }
    }
  };

  private handleTrackChange = (event: Event): void => {
    const entry = this.entries.get(event.target as HTMLMediaElement);
    if (entry?.route) {
      entry.route.normalizerGainDb = 0;
      entry.route.musicLevelState = null;
    }
  };

  private handleVolumeChange = (event: Event): void => {
    const entry = this.entries.get(event.target as HTMLMediaElement);
    if (!entry || entry.lastAppliedFallback === null) return;
    const element = entry.element;
    // A volume change we did not write ourselves is the site (or its native
    // controls) setting a new base volume — record it and re-derive fallback.
    if (Math.abs(element.volume - entry.lastAppliedFallback) > 1e-6) {
      entry.siteBaseVolume = element.volume;
      this.applyFallback(entry);
    }
  };

  // ------------------------------------------------------------ graph sync ---

  /** Bring one element to its correct state: captured graph or native fallback. */
  private syncEntry(entry: ElementEntry): void {
    if (entry.route) {
      this.wireRoute(entry.route);
      // A captured element is fully handled by its gain node — make sure no
      // stale fallback volume is still attenuating the source.
      this.clearFallback(entry);
      return;
    }
    if (this.mediaNeedsAudioRoute() && this.isAudible(entry.element)) {
      this.captureElement(entry);
      if (entry.route) {
        this.wireRoute(entry.route);
        this.clearFallback(entry);
        return;
      }
    }
    this.applyFallback(entry);
  }

  private captureElement(entry: ElementEntry): void {
    try {
      const context = this.ensureContext();
      const element = entry.element;
      const source = context.createMediaElementSource(element);
      const inputAnalyser = context.createAnalyser();
      const gain = context.createGain();
      const splitter = context.createChannelSplitter(2);
      const leftGain = context.createGain();
      const rightGain = context.createGain();
      const merger = context.createChannelMerger(2);
      const limiter = context.createDynamicsCompressor();
      const analyser = context.createAnalyser();

      gain.channelInterpretation = "speakers";
      leftGain.gain.value = 0.5;
      rightGain.gain.value = 0.5;
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      // 8192 frames span ~171ms at 48kHz, overlapping adjacent 100ms AGC
      // samples rather than leaving ~15ms peak blind spots.
      inputAnalyser.fftSize = 8192;
      inputAnalyser.smoothingTimeConstant = 0.35;

      const route: MediaRoute = {
        element,
        context,
        source,
        inputAnalyser,
        gain,
        splitter,
        leftGain,
        rightGain,
        merger,
        limiter,
        analyser,
        currentMode: null,
        outputConnected: false,
        normalizerGainDb: 0,
        musicLevelState: null,
        meterBuffer: new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer>,
        inputBuffer: new Float32Array(inputAnalyser.fftSize) as Float32Array<ArrayBuffer>,
      };
      // Persistent wiring: source → inputAnalyser → gain. Output wiring is
      // recomputed by wireRoute whenever the routing mode changes.
      source.connect(inputAnalyser);
      inputAnalyser.connect(gain);
      entry.route = route;
      // page-audio-hook.js marks successfully hooked elements — the debug
      // highlight (options "Show Debug Highlight") paints exactly these.
      try { element.dataset.vcHooked = "true"; } catch { /* ignore */ }
    } catch {
      // createMediaElementSource failed (already captured elsewhere) — the
      // element keeps native playback and only fallback volume applies.
      entry.route = null;
    }
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }

  private disconnectRouteOutput(route: MediaRoute): void {
    try { route.gain.disconnect(); } catch { /* not connected */ }
    try { route.splitter.disconnect(); } catch { /* not connected */ }
    try { route.leftGain.disconnect(); } catch { /* not connected */ }
    try { route.rightGain.disconnect(); } catch { /* not connected */ }
    try { route.merger.disconnect(); } catch { /* not connected */ }
    try { route.limiter.disconnect(); } catch { /* not connected */ }
    try { route.analyser.disconnect(); } catch { /* not connected */ }
    route.outputConnected = false;
  }

  /** page-audio-hook.js connectMonoChain — both channels duplicated into both
   *  merger inputs at 0.5 amplitude. */
  private connectMonoChain(route: MediaRoute, destination: AudioNode): void {
    const { gain, splitter, leftGain, rightGain, merger } = route;
    gain.connect(splitter);
    splitter.connect(leftGain, 0);
    splitter.connect(rightGain, 1);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 0);
    leftGain.connect(merger, 0, 1);
    rightGain.connect(merger, 0, 1);
    merger.connect(destination);
  }

  /** page-audio-hook.js wireMediaRoute (simplified for the single-page case:
   *  no MediaStream routes, no recovery ladder — errors fall back to a direct
   *  unity-clamped connection). */
  private wireRoute(route: MediaRoute): void {
    this.configureLimiter(route);
    const wantMode = this.currentRoutingMode();
    if (route.currentMode === wantMode && route.outputConnected) {
      this.setGainValue(route);
      return;
    }

    this.disconnectRouteOutput(route);
    try {
      const useLimiter = this.safetyLimiterRequired();
      const output = useLimiter ? route.limiter : route.context.destination;
      if (this.state.extensionActive && this.state.enabled && this.state.mono) {
        this.connectMonoChain(route, output);
      } else {
        route.gain.connect(output);
      }
      if (useLimiter) {
        this.configureLimiter(route);
        route.limiter.connect(route.analyser);
        route.analyser.connect(route.context.destination);
      }
      route.outputConnected = true;
      route.currentMode = wantMode;
    } catch {
      route.currentMode = null;
      this.disconnectRouteOutput(route);
      // Safety fallback: direct connection, never expose gain > 1 unprotected.
      const target = Math.min(1, this.effectiveGain() *
        (this.state.normalizerEnabled ? dbToGain(route.normalizerGainDb) : 1));
      try {
        route.gain.gain.value = target;
        route.gain.connect(route.context.destination);
        route.outputConnected = true;
      } catch { /* give up; element stays silent-safe */ }
    }
    this.setGainValue(route);
  }

  /** page-audio-hook.js configureLimiter — exact DynamicsCompressor settings,
   *  including the "transparent music" threshold lift at unity/attenuation. */
  private configureLimiter(route: MediaRoute): void {
    const config = normalizeNormalizerConfig(this.state.normalizerConfig);
    const transparentMusic = this.state.normalizerEnabled && config.mode === "music" &&
      this.state.dB <= 0 && route.normalizerGainDb <= 0;
    try {
      applyLimiterParams(route.limiter, config, transparentMusic);
    } catch { /* ignore */ }
  }

  /** page-audio-hook.js setMediaGainValue — 15 ms anti-zipper ramp. */
  private setGainValue(route: MediaRoute): void {
    const autoGain = this.state.normalizerEnabled ? dbToGain(route.normalizerGainDb || 0) : 1;
    const targetGain = this.effectiveGain() * autoGain;
    try {
      const now = route.context.currentTime;
      if (route.context.state === "running") {
        route.gain.gain.cancelScheduledValues(now);
        route.gain.gain.setValueAtTime(route.gain.gain.value, now);
        route.gain.gain.linearRampToValueAtTime(targetGain, now + 0.015);
      } else {
        route.gain.gain.value = targetGain;
      }
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------- fallback ---

  /** cs.js applyFallbackVolume — attenuation-only native volume for media the
   *  extension does not route (restricted media, or pure attenuation). */
  private applyFallback(entry: ElementEntry): void {
    if (!this.isFallbackEngaged(entry)) {
      this.clearFallback(entry);
      return;
    }
    const gain = this.state.muted ? 0 : getGainValue(this.state.dB);
    const newVol = Math.min(1, Math.max(0, entry.siteBaseVolume * Math.min(gain, 1)));
    this.writeFallbackVolume(entry, newVol);
  }

  private isFallbackEngaged(entry: ElementEntry): boolean {
    // Captured elements are handled entirely by their gain node.
    if (entry.route) return false;
    if (!this.state.extensionActive || !this.state.enabled) return false;
    const gain = this.state.muted ? 0 : getGainValue(this.state.dB);
    return gain < 1 || this.restriction !== "";
  }

  /** Rate-limited native volume writes (one per 250 ms, trailing correction),
   *  mirroring the extension's anti-write-war behavior. */
  private writeFallbackVolume(entry: ElementEntry, volume: number): void {
    const applyTrailing = () => {
      entry.fallbackWriteTimer = null;
      const pending = entry.pendingFallbackWrite;
      entry.pendingFallbackWrite = null;
      if (pending === null) return;
      try {
        entry.element.volume = pending;
        entry.lastAppliedFallback = pending;
      } catch { /* ignore */ }
    };
    if (entry.fallbackWriteTimer) {
      entry.pendingFallbackWrite = volume;
      return;
    }
    try {
      entry.element.volume = volume;
      entry.lastAppliedFallback = volume;
    } catch { /* ignore */ }
    entry.pendingFallbackWrite = null;
    entry.fallbackWriteTimer = setTimeout(applyTrailing, 250);
  }

  private clearFallback(entry: ElementEntry): void {
    if (entry.fallbackWriteTimer) {
      clearTimeout(entry.fallbackWriteTimer);
      entry.fallbackWriteTimer = null;
    }
    entry.pendingFallbackWrite = null;
    if (entry.lastAppliedFallback !== null) {
      // Only restore if the site has not set a new volume in the meantime.
      if (Math.abs(entry.element.volume - entry.lastAppliedFallback) < 1e-6) {
        try { entry.element.volume = entry.siteBaseVolume; } catch { /* ignore */ }
      }
      entry.lastAppliedFallback = null;
    }
  }

  private isAudible(element: HTMLMediaElement): boolean {
    return !element.paused && !element.ended && element.readyState > 2;
  }

  // ------------------------------------------------------ normalizer/meter ---

  private syncTimer(): void {
    const needed = this.entries.size > 0;
    if (needed && !this.timer) {
      this.timer = setInterval(() => this.tick(), 100);
    } else if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.lastMeter = { peakDb: -Infinity, normalizerGainDb: 0 };
      this.notifyMeter();
    }
  }

  /** page-audio-hook.js sampleProcessor + updateNormalizerAndMeter (100 ms). */
  private tick(): void {
    let peakDb = -Infinity;
    let gainSum = 0;
    let gainCount = 0;

    for (const entry of this.entries.values()) {
      const route = entry.route;
      if (!route || route.context.state !== "running") continue;
      const audible = this.isAudible(entry.element);

      // Output peak (post-limiter) — drives the popup meter.
      let outPeak = 0;
      try {
        route.analyser.getFloatTimeDomainData(route.meterBuffer);
        for (let i = 0; i < route.meterBuffer.length; i++) {
          const abs = Math.abs(route.meterBuffer[i]);
          if (abs > outPeak) outPeak = abs;
        }
      } catch { /* analyser unavailable */ }
      const routePeakDb = outPeak > 0.000001 ? 20 * Math.log10(outPeak) : -Infinity;
      if (routePeakDb > peakDb) peakDb = routePeakDb;

      // Source measurement (pre-gain) — feeds AGC so the user's slider never
      // feeds back into the normalizer.
      let sourceRmsDb = -120;
      let sourcePeakDb = -Infinity;
      let sourceReadValid = false;
      try {
        route.inputAnalyser.getFloatTimeDomainData(route.inputBuffer);
        let sum = 0;
        let srcPeak = 0;
        for (let i = 0; i < route.inputBuffer.length; i++) {
          const sample = route.inputBuffer[i];
          if (!Number.isFinite(sample)) throw new Error("invalid source sample");
          sum += sample * sample;
          srcPeak = Math.max(srcPeak, Math.abs(sample));
        }
        const rms = Math.sqrt(sum / Math.max(1, route.inputBuffer.length));
        sourceRmsDb = rms > 0.000001 ? 20 * Math.log10(rms) : -120;
        sourcePeakDb = srcPeak > 0.000001 ? 20 * Math.log10(srcPeak) : -Infinity;
        sourceReadValid = true;
      } catch { /* keep defaults */ }

      const config = normalizeNormalizerConfig(this.state.normalizerConfig);
      let gainDb = Number(route.normalizerGainDb) || 0;
      const previousGainDb = gainDb;
      if (this.state.normalizerEnabled && this.state.extensionActive &&
        this.state.enabled && !this.state.muted && !this.restriction && audible) {
        if (!route.musicLevelState) route.musicLevelState = createMusicLevelState();
        gainDb = computeSafeNormalizerGainDb(
          gainDb,
          sourceReadValid ? sourceRmsDb : NaN,
          sourceReadValid ? sourcePeakDb : NaN,
          config,
          route.musicLevelState,
        );
      } else {
        gainDb = 0;
      }

      if (Math.abs(gainDb) < 0.01) gainDb = 0;
      route.normalizerGainDb = gainDb;
      this.configureLimiter(route);

      try {
        const now = route.context.currentTime;
        const target = this.effectiveGain() *
          (this.state.normalizerEnabled ? dbToGain(gainDb) : 1);
        route.gain.gain.cancelScheduledValues(now);
        route.gain.gain.setTargetAtTime(
          target, now, gainDb < previousGainDb ? 0.008 : 0.035);
      } catch { /* ignore */ }

      if (audible) {
        gainSum += gainDb;
        gainCount++;
      }
    }

    this.lastMeter = {
      peakDb,
      normalizerGainDb: gainCount ? gainSum / gainCount : 0,
    };
    this.notifyMeter();
    this.notifyChain();
  }

  // ------------------------------------------------------------------ api ---

  /** Mirrors the extension's getAudioControlState response (cs.js):
   *  availability + reasons fold in the native-route policy. */
  getAudioControlState(): AudioControlState {
    const limited = this.limitationReason();
    return {
      volume: this.state.dB,
      requestedVolume: this.state.requestedDb,
      mono: this.state.mono,
      monoAvailable: !limited,
      monoUnavailableReason: limited,
      muted: this.state.muted,
      normalizerEnabled: this.state.normalizerEnabled,
      normalizerAvailable: !limited,
      normalizerUnavailableReason: limited,
      peakDb: this.lastMeter.peakDb,
      normalizerGainDb: this.lastMeter.normalizerGainDb,
      boostLimited: limited !== "",
      maxDb: this.maxDb(),
      limitationReason: limited,
    };
  }

  getMeterState(): MeterState {
    return this.lastMeter;
  }

  getChainSnapshot(): ChainSnapshot {
    let captured = false;
    let routingMode: RoutingMode = this.currentRoutingMode();
    let limiterActive = this.safetyLimiterRequired();
    let limiterThresholdDb = 0;
    let gainValue = 1;
    let fallbackVolume: number | null = null;

    for (const entry of this.entries.values()) {
      if (entry.route) {
        captured = true;
        routingMode = entry.route.currentMode ?? this.currentRoutingMode();
        limiterActive = this.safetyLimiterRequired();
        limiterThresholdDb = entry.route.limiter.threshold.value;
        gainValue = entry.route.gain.gain.value;
        break;
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.lastAppliedFallback !== null) {
        fallbackVolume = entry.lastAppliedFallback;
        break;
      }
    }

    return {
      captured,
      routingMode,
      limiterActive,
      limiterThresholdDb,
      gainValue,
      routes: this.entries.size,
      contextState: this.context ? this.context.state : "none",
      restricted: this.limitationReason() !== "",
      fallbackVolume,
    };
  }

  onMeter(cb: (m: MeterState) => void): () => void {
    this.meterListeners.add(cb);
    cb(this.lastMeter);
    return () => this.meterListeners.delete(cb);
  }

  onChain(cb: (s: ChainSnapshot) => void): () => void {
    this.chainListeners.add(cb);
    cb(this.getChainSnapshot());
    return () => this.chainListeners.delete(cb);
  }

  private notifyMeter(): void {
    for (const cb of this.meterListeners) cb(this.lastMeter);
  }

  private notifyChain(): void {
    const snapshot = this.getChainSnapshot();
    for (const cb of this.chainListeners) cb(snapshot);
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const element of Array.from(this.entries.keys())) this.detach(element);
    void this.context?.close();
    this.context = null;
    VolumeEngine.instance = null;
  }
}
