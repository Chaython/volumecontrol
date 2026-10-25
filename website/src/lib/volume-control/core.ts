/**
 * Volume Control — core math, ported 1:1 from the extension.
 *
 * Sources:
 *  - shared.js: MIN_DB/MAX_DB, normalizeDb, getGainValue, formatDb,
 *    DEFAULT_NORMALIZER_CONFIG, normalizeNormalizerConfig
 *  - page-audio-hook.js: dbToGain, computeSafeNormalizerGainDb (verbatim),
 *    limiter parameters, RMS/peak measurement formulas
 *
 * Keep the numeric behavior identical to the extension — the live preview must
 * sound and meter exactly like the real thing.
 */

import type { NormalizerConfig } from "./types";

export const MIN_DB = -32;
export const MAX_DB = 32;

export const DEFAULT_NORMALIZER_CONFIG: NormalizerConfig = Object.freeze({
  mode: "music",
  targetDb: -16,
  maxBoostDb: 12,
  ceilingDb: -1,
  responseMs: 600,
});

export function normalizeDb(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
}

export function getGainValue(dB: number): number {
  return Math.pow(10, normalizeDb(dB) / 20);
}

export function dbToGain(dB: number): number {
  const n = Number(dB);
  return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
}

export function formatDb(value: number): string {
  const n = normalizeDb(value);
  return `${n >= 0 ? "+" : ""}${n} dB`;
}

export function formatBadgeText(value: number): string {
  const n = normalizeDb(value);
  return n > 0 ? `+${n}` : String(n);
}

/** shared.js normalizeNormalizerConfig — clamps user config to safe ranges. */
export function normalizeNormalizerConfig(value: Partial<NormalizerConfig> | null | undefined): NormalizerConfig {
  const input = (value && typeof value === "object" ? value : {}) as Partial<NormalizerConfig>;
  const numberOr = (candidate: unknown, fallback: number) => {
    if (candidate == null || (typeof candidate === "string" && !candidate.trim())) return fallback;
    const n = Number(candidate);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    mode: input.mode === "music" ? "music" : "adaptive",
    targetDb: Math.max(-30, Math.min(-6, numberOr(input.targetDb, DEFAULT_NORMALIZER_CONFIG.targetDb))),
    maxBoostDb: Math.max(0, Math.min(24, numberOr(input.maxBoostDb, DEFAULT_NORMALIZER_CONFIG.maxBoostDb))),
    ceilingDb: Math.max(-6, Math.min(-0.1, numberOr(input.ceilingDb, DEFAULT_NORMALIZER_CONFIG.ceilingDb))),
    responseMs: Math.max(100, Math.min(3000, Math.round(numberOr(input.responseMs, DEFAULT_NORMALIZER_CONFIG.responseMs)))),
    experimentalTruePeak: Boolean(input.experimentalTruePeak),
  };
}

/** Per-route loudness-tracking state for Music-mode normalization. */
export interface MusicLevelState {
  mode?: "music" | "adaptive";
  rmsDb: number | null;
  peakDb: number;
  peakHoldSamples: number;
  audibleSamples: number;
  silentSamples: number;
  lastDiagnosticAt?: number | null;
}

export function createMusicLevelState(): MusicLevelState {
  return {
    rmsDb: null,
    peakDb: -Infinity,
    peakHoldSamples: 0,
    audibleSamples: 0,
    silentSamples: 0,
  };
}

/**
 * The extension's automatic gain controller — ported verbatim from
 * page-audio-hook.js computeSafeNormalizerGainDb (v7.1).
 *
 * Music mode tracks RMS loudness with asymmetric attack/release envelopes and
 * holds recent peaks before gradually releasing them, so quiet songs are
 * boosted and loud passages are never pumped. Adaptive mode is the original
 * fast voice/video leveler driven by config.responseMs.
 */
export function computeSafeNormalizerGainDb(
  previousDb: number,
  sourceRmsDb: number,
  sourcePeakDb: number,
  config: NormalizerConfig,
  history?: MusicLevelState | null,
): number {
  const previous = Number.isFinite(previousDb) ? previousDb : 0;

  if (history && history.mode !== config.mode) {
    history.mode = config.mode;
    history.rmsDb = null;
    history.peakDb = -Infinity;
    history.peakHoldSamples = 0;
    history.audibleSamples = 0;
    history.silentSamples = 0;
    history.lastDiagnosticAt = null;
  }
  // Digital silence is valid analyser data. Fail closed only on invalid measurements.
  if (!Number.isFinite(sourceRmsDb) || Number.isNaN(sourcePeakDb) ||
    sourcePeakDb === Infinity || (sourceRmsDb > -55 && !Number.isFinite(sourcePeakDb))) {
    if (history) {
      history.rmsDb = null;
      history.peakDb = -Infinity;
      history.peakHoldSamples = 0;
      history.audibleSamples = 0;
      history.silentSamples = 0;
    }
    return 0;
  }
  if (sourceRmsDb <= -55) {
    // Don't pump up a fade or gap. Preserve attenuation briefly, then clear boost history.
    if (config.mode === "music" && history && history.audibleSamples > 0 &&
      ++history.silentSamples < 30) {
      return previous;
    }
    if (history) {
      history.rmsDb = null;
      history.peakDb = -Infinity;
      history.peakHoldSamples = 0;
      history.audibleSamples = 0;
      history.silentSamples = 0;
    }
    const silentGain = config.mode === "music" ? Math.min(0, previous) : 0;
    return silentGain;
  }

  if (config.mode === "music" && history) {
    history.silentSamples = 0;
    history.audibleSamples = Math.min(1000, (history.audibleSamples || 0) + 1);
    let rmsDb = history.rmsDb;
    if (rmsDb === null || !Number.isFinite(rmsDb)) rmsDb = sourceRmsDb;

    // Follow section changes promptly; gain smoothing below handles audible transitions.
    // Loudness envelope: 350 ms attack for louder sections, 900 ms release for quieter ones.
    const rmsTimeMs = sourceRmsDb > rmsDb ? 350 : 900;
    rmsDb += (sourceRmsDb - rmsDb) *
      (1 - Math.exp(-100 / rmsTimeMs));
    history.rmsDb = rmsDb;

    // Hold transient peaks for four seconds, then release by 1.5 dB/s.
    // This envelope limits positive boost only; it must never add attenuation.
    if (!Number.isFinite(history.peakDb) || sourcePeakDb >= history.peakDb) {
      history.peakDb = sourcePeakDb;
      history.peakHoldSamples = 40;
    } else if (history.peakHoldSamples > 0) {
      history.peakHoldSamples--;
    } else {
      history.peakDb = Math.max(sourcePeakDb, history.peakDb - 0.15);
    }
    const safeBoostDb = Math.max(0, Math.min(
      config.maxBoostDb, config.ceilingDb - 2 - history.peakDb));
    const rmsTargetDb = config.targetDb - rmsDb;
    // Apply peak headroom only when the loudness target asks for positive gain.
    const desiredTargetDb = rmsTargetDb > 0
      ? Math.min(rmsTargetDb, safeBoostDb)
      : rmsTargetDb;
    const desired = Math.max(-32, Math.min(
      desiredTargetDb, history.audibleSamples < 25 ? 0 : Infinity));

    // A fresh peak sheds unsafe positive boost immediately; it never demands attenuation.
    const instantaneousBoostLimit = Math.max(0, config.ceilingDb - 2 - sourcePeakDb);
    if (previous > 0 && instantaneousBoostLimit < previous) {
      const applied = Math.max(-32, Math.min(desired, instantaneousBoostLimit));
      return applied;
    }

    // Recover prior attenuation smoothly, but keep actual positive boost deliberately gradual.
    const timeMs = desired < previous ? 1600 : previous < 0 && desired > previous && history.audibleSamples >= 25 ? 900 : 6000;
    const applied = previous + (desired - previous) * (1 - Math.exp(-100 / timeMs));
    return applied;
  }

  // Adaptive mode retains the original fast voice/video leveling behavior.
  const rmsTarget = config.targetDb - sourceRmsDb;
  const peakHeadroom = config.ceilingDb - 2 - sourcePeakDb;
  const desired = Math.max(-32, Math.min(config.maxBoostDb, rmsTarget, peakHeadroom));
  const applied = desired <= previous
    ? desired
    : previous + (desired - previous) * (1 - Math.exp(-100 / Math.max(100, config.responseMs)));
  return applied;
}

/** page-audio-hook.js configureLimiter — exact DynamicsCompressor settings. */
export function applyLimiterParams(
  limiter: DynamicsCompressorNode,
  config: NormalizerConfig,
  transparentMusic: boolean,
): void {
  // At unity/attenuation, music needs no added peak compression. Keep the
  // limiter node connected to avoid route clicks/latency changes, but move
  // its threshold to 0 dBFS until boosted. Never do this for manual positive
  // boost or adaptive mode.
  limiter.threshold.value = transparentMusic ? 0 : config.ceilingDb;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
}

/** popup.js formatMeterDb. */
export function formatMeterDb(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= -90) return "−∞ dBFS";
  return `${n.toFixed(1)} dBFS`;
}
