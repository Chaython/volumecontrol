/**
 * Volume Control — core types shared by the engine, store and UI.
 * Mirrors the extension's state shapes (shared.js / page-audio-hook.js / cs.js).
 */

export interface NormalizerConfig {
  mode: "music" | "adaptive";
  targetDb: number;
  maxBoostDb: number;
  ceilingDb: number;
  responseMs: number;
}

export interface ExtensionState {
  /** Site permission ("Active" toggle in the popup). */
  extensionActive: boolean;
  /** Extension installed/enabled — always true in the live preview. */
  enabled: boolean;
  /** Applied volume in dB (clamped by boost limit). */
  dB: number;
  /** User-requested volume in dB (kept distinct from the clamp, like cs.js). */
  requestedDb: number;
  mono: boolean;
  muted: boolean;
  normalizerEnabled: boolean;
  normalizerConfig: NormalizerConfig;
}

export interface MeterState {
  peakDb: number;
  normalizerGainDb: number;
}

/** Response shape of the extension's `getAudioControlState` message. */
export interface AudioControlState {
  volume: number;
  requestedVolume: number;
  mono: boolean;
  monoAvailable: boolean;
  monoUnavailableReason: string;
  muted: boolean;
  normalizerEnabled: boolean;
  normalizerAvailable: boolean;
  normalizerUnavailableReason: string;
  peakDb: number;
  normalizerGainDb: number;
  boostLimited: boolean;
  maxDb: number;
  limitationReason: string;
}

export type RoutingMode =
  | "bypass"
  | "stereo-direct"
  | "stereo-limited"
  | "mono-direct"
  | "mono-limited";

/** Live internals exposed for the signal-chain visualization. */
export interface ChainSnapshot {
  captured: boolean;
  routingMode: RoutingMode;
  limiterActive: boolean;
  limiterThresholdDb: number;
  gainValue: number;
  routes: number;
  contextState: AudioContextState | "none";
  restricted: boolean;
  fallbackVolume: number | null;
}

export interface RememberedSiteSettings {
  siteKey: string;
  volume: number;
  mono: boolean;
  muted: boolean;
  normalizerEnabled: boolean;
}
