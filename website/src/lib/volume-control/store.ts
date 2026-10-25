"use client";

/**
 * Extension state store — plays the role of the extension's background worker
 * + chrome.storage in the live preview. The popup, toolbar badge, playground
 * and settings dialog all read/write this store; every change is pushed into
 * the VolumeEngine (the ported page-audio-hook.js processing chain).
 */

import { create } from "zustand";
import { DEFAULT_NORMALIZER_CONFIG, normalizeDb } from "./core";
import type { NormalizerConfig } from "./types";
import { VolumeEngine } from "./engine";
import { IS_STATIC_EXPORT } from "../asset-path";

export interface DemoSite {
  key: string;
  url: string;
  tabTitle: string;
  title: string;
  subtitle: string;
}

export const DEMO_SITES: DemoSite[] = [
  {
    key: "demo.local",
    url: "https://demo.local/playground",
    tabTitle: "Media Playground",
    title: "Media Playground",
    subtitle: "Drop audio or video files to test Volume Control on your own media.",
  },
  {
    key: "quiet.fm",
    url: "https://quiet.fm/late-night",
    tabTitle: "Quiet FM · Late Night Talk",
    title: "Quiet FM — Late Night Talk",
    subtitle: "A talk stream mixed far too quietly. Perfect for testing volume boost.",
  },
];

export interface MediaItem {
  id: string;
  name: string;
  url: string;
  kind: "audio" | "video";
  isObjectUrl: boolean;
  tag?: string;
}

/** A remembered site's saved audio settings (chrome.storage siteSettings). */
export interface RememberedEntry {
  volume: number;
  mono: boolean;
  muted: boolean;
  normalizerEnabled: boolean;
}

/** Per-site debug overrides (chrome.storage siteDebugSettings). */
export interface SiteDebugOverrides {
  debugMode: boolean;
  forceDrmCapture: boolean;
  forceCorsCapture: boolean;
  debugRouteMode: "auto" | "webaudio" | "native";
}

/** Global debug defaults (chrome.storage debugMode/forceDrmCapture/...). */
export interface DebugDefaults {
  debugMode: boolean;
  forceDrmCapture: boolean;
  forceCorsCapture: boolean;
  debugRouteMode: "auto" | "webaudio" | "native";
}

const DEFAULT_SITE_DEBUG: SiteDebugOverrides = {
  debugMode: false,
  forceDrmCapture: false,
  forceCorsCapture: false,
  debugRouteMode: "auto",
};

function normalizeSiteDebug(value: Partial<SiteDebugOverrides> | null | undefined): SiteDebugOverrides {
  return {
    debugMode: Boolean(value?.debugMode),
    forceDrmCapture: Boolean(value?.forceDrmCapture),
    forceCorsCapture: Boolean(value?.forceCorsCapture),
    debugRouteMode: value?.debugRouteMode === "webaudio" || value?.debugRouteMode === "native"
      ? value.debugRouteMode
      : "auto",
  };
}

interface Badge {
  text: string;
  color: string;
  title: string;
}

interface ExtensionStore {
  // --- navigation -----------------------------------------------------------
  site: DemoSite;
  navigating: boolean;
  navigate: (siteKey: string) => Promise<void>;
  applySiteSettings: (siteKey: string) => void;

  // --- extension state (mirrors cs.js tc.vars) ------------------------------
  requestedDb: number;
  dB: number;
  muted: boolean;
  mono: boolean;
  normalizerEnabled: boolean;
  normalizerConfig: NormalizerConfig;
  normalizerDefaultEnabled: boolean;
  extensionActive: boolean;
  restricted: Record<string, boolean>;

  setVolume: (db: number) => void;
  toggleMute: () => void;
  setMute: (muted: boolean) => void;
  toggleMono: () => void;
  toggleNormalizer: () => void;
  setNormalizerConfig: (config: Partial<NormalizerConfig>) => void;
  setNormalizerDefaultEnabled: (enabled: boolean) => void;
  toggleActive: () => void;
  setRestricted: (restricted: boolean) => void;

  // --- remembered settings (chrome.storage siteSettings via API) ------------
  remembered: Record<string, boolean>; // siteKey -> has saved settings
  rememberedSettings: Record<string, RememberedEntry>; // siteKey -> saved values
  toggleRemember: () => Promise<void>;
  persistIfRemembered: () => Promise<void>;
  hydrateRemembered: () => Promise<void>;
  hydrateNormalizerConfig: () => Promise<void>;

  // --- options page state (access lists, site debug, debug defaults) --------
  blocklist: string[];
  whitelist: string[];
  whitelistMode: boolean;
  siteDebug: Record<string, SiteDebugOverrides>;
  debugDefaults: DebugDefaults;
  hydrateOptionsState: () => void;
  setWhitelistMode: (enabled: boolean) => void;
  addAccessEntry: (entry: string) => { ok: boolean };
  removeAccessEntry: (entry: string) => void;
  addRememberedEntry: (siteKey: string) => { ok: boolean };
  removeRememberedEntry: (siteKey: string) => void;
  renameRememberedEntry: (oldKey: string, newKey: string) => { ok: boolean; reason?: "exists" };
  updateRememberedEntry: (siteKey: string, patch: Partial<RememberedEntry>) => void;
  addSiteDebugEntry: (siteKey: string) => { ok: boolean };
  removeSiteDebugEntry: (siteKey: string) => void;
  renameSiteDebugEntry: (oldKey: string, newKey: string) => { ok: boolean; reason?: "exists" };
  updateSiteDebugEntry: (siteKey: string, patch: Partial<SiteDebugOverrides>) => void;
  setDebugDefaults: (patch: Partial<DebugDefaults>) => void;

  // --- options tab (the extension opens options.html in a full tab) ---------
  optionsTabOpen: boolean;
  viewingOptions: boolean;
  openOptionsTab: () => void;
  closeOptionsTab: () => void;
  showOptionsTab: () => void;

  // --- media playground (per-site playlists of dropped/demo files) --------
  playlists: Record<string, MediaItem[]>;
  addMediaItems: (items: MediaItem[]) => void;
  removeMediaItem: (id: string) => void;

  // --- popup / badge --------------------------------------------------------
  popupOpen: boolean;
  openPopup: () => void;
  closePopup: () => void;
  badge: Badge | null;
  reloadCount: number;
}

const BADGE_COLORS = {
  positive: "#2e7d32",
  negative: "#c62828",
  neutral: "#5f6368",
  mute: "#c62828",
} as const;

function makeBadge(dB: number, muted: boolean): Badge {
  if (muted) {
    return { text: "MUTE", color: BADGE_COLORS.mute, title: "Volume Control (muted)" };
  }
  const n = normalizeDb(dB);
  return {
    text: n > 0 ? `+${n}` : String(n),
    color: n > 0 ? BADGE_COLORS.positive : n < 0 ? BADGE_COLORS.negative : BADGE_COLORS.neutral,
    title: `Volume Control (${n >= 0 ? "+" : ""}${n} dB)`,
  };
}

function pushToEngine(partial: Parameters<VolumeEngine["setState"]>[0]) {
  VolumeEngine.getInstance().setState(partial);
}

/** Does a blocklist entry (optionally path-scoped) match a site key?
 *  Bare domains match the site and its subdomains (shared.js semantics). */
function blocklistMatches(entry: string, siteKey: string): boolean {
  const domain = entry.split("/")[0].trim().toLowerCase();
  if (!domain) return false;
  return domain === siteKey || siteKey.endsWith(`.${domain}`);
}

function siteIsBlocked(blocklist: string[], siteKey: string): boolean {
  return blocklist.some((entry) => blocklistMatches(entry, siteKey));
}

function persistAccessLists(state: { blocklist: string[]; whitelist: string[]; whitelistMode: boolean }) {
  try {
    window.localStorage.setItem("vc-access-lists", JSON.stringify({
      blocklist: state.blocklist,
      whitelist: state.whitelist,
      whitelistMode: state.whitelistMode,
    }));
  } catch { /* ignore */ }
}

function persistSiteDebug(siteDebug: Record<string, SiteDebugOverrides>) {
  try {
    window.localStorage.setItem("vc-site-debug", JSON.stringify(siteDebug));
  } catch { /* ignore */ }
}

function persistDebugDefaults(debugDefaults: DebugDefaults) {
  try {
    window.localStorage.setItem("vc-debug-defaults", JSON.stringify(debugDefaults));
  } catch { /* ignore */ }
}

function readRememberedEntry(siteKey: string): RememberedEntry | null {
  try {
    const raw = window.localStorage.getItem(`vc-remembered-${siteKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedEntry> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      volume: Number.isFinite(parsed.volume) ? normalizeDb(parsed.volume as number) : 0,
      mono: Boolean(parsed.mono),
      muted: Boolean(parsed.muted),
      normalizerEnabled: Boolean(parsed.normalizerEnabled),
    };
  } catch {
    return null;
  }
}

function writeRememberedEntry(siteKey: string, entry: RememberedEntry) {
  try {
    window.localStorage.setItem(`vc-remembered-${siteKey}`, JSON.stringify(entry));
  } catch { /* ignore */ }
  if (!IS_STATIC_EXPORT) {
    void fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteKey, ...entry }),
    }).catch(() => undefined);
  }
}

function removeRememberedStorage(siteKey: string) {
  try { window.localStorage.removeItem(`vc-remembered-${siteKey}`); } catch { /* ignore */ }
  if (!IS_STATIC_EXPORT) {
    void fetch(`/api/settings?site=${encodeURIComponent(siteKey)}`, { method: "DELETE" })
      .catch(() => undefined);
  }
}

/** The engine-level restriction for a site, honoring the debug overrides
 *  ("Force DRM Audio Capture" skips the DRM safety fallback). Exported for
 *  consumers (popup) that must mirror the engine verdict like cs.js does. */
export function effectiveRestricted(state: ExtensionStore, siteKey: string): boolean {
  const raw = Boolean(state.restricted[siteKey]);
  if (!raw) return false;
  if (state.debugDefaults.forceDrmCapture) return false;
  if (state.siteDebug[siteKey]?.forceDrmCapture) return false;
  return true;
}

export const useExtensionStore = create<ExtensionStore>((set, get) => ({
  site: DEMO_SITES[0],
  navigating: false,

  navigate: async (siteKey) => {
    // Switching to a demo tab always leaves the options-page view.
    set({ viewingOptions: false });
    const site = DEMO_SITES.find((s) => s.key === siteKey);
    if (!site || site.key === get().site.key) return;
    // Real behavior: navigation clears the badge and re-runs the content
    // script, which restores remembered settings for the new site.
    set({ navigating: true, popupOpen: false, badge: null });
    await new Promise((resolve) => setTimeout(resolve, 650));
    get().applySiteSettings(site.key);
    set({ site, navigating: false });
  },

  /** Restore a site's remembered settings — the content script's start()
   *  behavior after (re)loading a page. Also used for the initial mount. */
  applySiteSettings: (siteKey) => {
    const state = get();
    const site = DEMO_SITES.find((s) => s.key === siteKey);
    if (!site) return;
    const remembered = readRememberedEntry(siteKey);

    // The extension is inactive on sites blocked via the options page
    // (the popup's "Active" toggle writes that same list).
    const extensionActive = !siteIsBlocked(state.blocklist, siteKey);
    VolumeEngine.getInstance().setRestricted(effectiveRestricted(state, siteKey));

    const nextDb = remembered && Number.isFinite(remembered.volume)
      ? normalizeDb(remembered.volume ?? 0)
      : 0;
    const nextMono = remembered ? Boolean(remembered.mono) : false;
    const nextMuted = remembered ? Boolean(remembered.muted) : false;
    const nextNormalizer = remembered
      ? Boolean(remembered.normalizerEnabled)
      : state.normalizerDefaultEnabled;

    pushToEngine({
      extensionActive,
      requestedDb: nextDb,
      mono: nextMono,
      muted: nextMuted,
      normalizerEnabled: nextNormalizer,
      normalizerConfig: state.normalizerConfig,
    });

    set({
      extensionActive,
      requestedDb: nextDb,
      dB: Math.min(nextDb, VolumeEngine.getInstance().getAudioControlState().maxDb),
      mono: nextMono,
      muted: nextMuted,
      normalizerEnabled: nextNormalizer,
    });
  },

  requestedDb: 0,
  dB: 0,
  muted: false,
  mono: false,
  normalizerEnabled: false,
  normalizerConfig: { ...DEFAULT_NORMALIZER_CONFIG },
  normalizerDefaultEnabled: false,
  extensionActive: true,
  restricted: { "demo.local": false, "quiet.fm": false },

  setVolume: (db) => {
    const requested = normalizeDb(db);
    const engine = VolumeEngine.getInstance();
    pushToEngine({ requestedDb: requested });
    const applied = engine.getAudioControlState().volume;
    set({ requestedDb: requested, dB: applied, badge: makeBadge(applied, get().muted) });
    void get().persistIfRemembered();
  },

  toggleMute: () => get().setMute(!get().muted),

  setMute: (muted) => {
    pushToEngine({ muted });
    set({ muted, badge: makeBadge(get().dB, muted) });
    void get().persistIfRemembered();
  },

  toggleMono: () => {
    const mono = !get().mono;
    pushToEngine({ mono });
    set({ mono });
    void get().persistIfRemembered();
  },

  toggleNormalizer: () => {
    const normalizerEnabled = !get().normalizerEnabled;
    pushToEngine({ normalizerEnabled });
    set({ normalizerEnabled });
    void get().persistIfRemembered();
  },

  setNormalizerConfig: (config) => {
    const normalizerConfig = { ...get().normalizerConfig, ...config };
    pushToEngine({ normalizerConfig });
    set({ normalizerConfig });
    // Persist globally (the options page stores normalizerConfig globally).
    try {
      window.localStorage.setItem("vc-normalizer-config", JSON.stringify(normalizerConfig));
    } catch { /* ignore */ }
    if (!IS_STATIC_EXPORT) {
      void fetch("/api/normalizer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: normalizerConfig }),
      }).catch(() => undefined);
    }
  },

  setNormalizerDefaultEnabled: (enabled) => {
    set({ normalizerDefaultEnabled: enabled });
    try {
      window.localStorage.setItem("vc-normalizer-default", JSON.stringify(enabled));
    } catch { /* ignore */ }
    if (!IS_STATIC_EXPORT) {
      void fetch("/api/normalizer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultEnabled: enabled }),
      }).catch(() => undefined);
    }
  },

  toggleActive: () => {
    // Real extension semantics: "Active" off adds the current site to the
    // blocked-sites list (managed on the options page) and reloads the tab.
    const state = get();
    const blocked = siteIsBlocked(state.blocklist, state.site.key);
    const blocklist = blocked
      ? state.blocklist.filter((entry) => !blocklistMatches(entry, state.site.key))
      : [...state.blocklist, state.site.key];
    const extensionActive = !siteIsBlocked(blocklist, state.site.key);
    persistAccessLists({ ...state, blocklist });
    set({ blocklist, extensionActive, popupOpen: false, navigating: true, badge: null });
    pushToEngine({ extensionActive });
    setTimeout(() => set({ navigating: false }), 650);
    set((s) => ({ reloadCount: s.reloadCount + 1 }));
  },

  setRestricted: (restricted) => {
    const state = get();
    const site = get().site;
    const next = { ...get().restricted, [site.key]: restricted };
    // The debug "Force DRM Audio Capture" override skips the safety fallback.
    VolumeEngine.getInstance().setRestricted(effectiveRestricted({ ...state, restricted: next }, site.key));
    // Re-clamp displayed volume against the new limit.
    const engineState = VolumeEngine.getInstance().getAudioControlState();
    set({
      restricted: next,
      dB: engineState.volume,
      badge: makeBadge(engineState.volume, get().muted),
    });
  },

  remembered: {},
  rememberedSettings: {},

  toggleRemember: async () => {
    const state = get();
    const siteKey = state.site.key;
    const has = Boolean(state.remembered[siteKey]);
    if (has) {
      set({
        remembered: { ...state.remembered, [siteKey]: false },
        rememberedSettings: Object.fromEntries(Object.entries(state.rememberedSettings).filter(([k]) => k !== siteKey)),
      });
      removeRememberedStorage(siteKey);
    } else {
      const payload: RememberedEntry = {
        volume: state.requestedDb,
        mono: state.mono,
        muted: state.muted,
        normalizerEnabled: state.normalizerEnabled,
      };
      set({
        remembered: { ...state.remembered, [siteKey]: true },
        rememberedSettings: { ...state.rememberedSettings, [siteKey]: payload },
      });
      writeRememberedEntry(siteKey, payload);
    }
  },

  persistIfRemembered: async () => {
    const state = get();
    const siteKey = state.site.key;
    if (!state.remembered[siteKey]) return;
    const payload: RememberedEntry = {
      volume: state.requestedDb,
      mono: state.mono,
      muted: state.muted,
      normalizerEnabled: state.normalizerEnabled,
    };
    set({ rememberedSettings: { ...state.rememberedSettings, [siteKey]: payload } });
    writeRememberedEntry(siteKey, payload);
  },

  hydrateRemembered: async () => {
    // Server-backed lookup (skipped in the static GitHub Pages build) …
    const remembered: Record<string, boolean> = {};
    const rememberedSettings: Record<string, RememberedEntry> = {};
    if (!IS_STATIC_EXPORT) {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data: { settings?: { siteKey: string; volume: number; mono: boolean; muted: boolean; normalizerEnabled: boolean }[] } = await res.json();
          for (const row of data.settings ?? []) {
            remembered[row.siteKey] = true;
            rememberedSettings[row.siteKey] = {
              volume: normalizeDb(row.volume),
              mono: Boolean(row.mono),
              muted: Boolean(row.muted),
              normalizerEnabled: Boolean(row.normalizerEnabled),
            };
          }
        }
      } catch { /* offline / static — localStorage below is authoritative */ }
    }
    // … and the localStorage mirror, which is the primary store when static
    // (the web equivalent of the extension's chrome.storage on Pages).
    for (const site of DEMO_SITES) {
      const entry = readRememberedEntry(site.key);
      if (entry) {
        remembered[site.key] = true;
        rememberedSettings[site.key] = entry;
      }
    }
    // Entries created directly on the options page (arbitrary site paths).
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith("vc-remembered-")) continue;
        const siteKey = key.slice("vc-remembered-".length);
        if (!siteKey || remembered[siteKey]) continue;
        const entry = readRememberedEntry(siteKey);
        if (entry) {
          remembered[siteKey] = true;
          rememberedSettings[siteKey] = entry;
        }
      }
    } catch { /* ignore */ }
    set({ remembered, rememberedSettings });
  },

  hydrateNormalizerConfig: async () => {
    let config: NormalizerConfig | null = null;
    let defaultEnabled: boolean | null = null;
    if (!IS_STATIC_EXPORT) {
      try {
        const res = await fetch("/api/normalizer");
        if (res.ok) {
          const data: {
            config?: Partial<NormalizerConfig> | null;
            defaultEnabled?: boolean;
          } = await res.json();
          if (data.config && Object.keys(data.config).length > 0) {
            config = { ...DEFAULT_NORMALIZER_CONFIG, ...data.config };
          }
          defaultEnabled = Boolean(data.defaultEnabled);
        }
      } catch { /* ignore */ }
    }
    // Static build / API unavailable: fall back to the localStorage mirror.
    if (!config || defaultEnabled === null) {
      try {
        const rawCfg = window.localStorage.getItem("vc-normalizer-config");
        if (rawCfg && !config) {
          const parsed = JSON.parse(rawCfg) as Partial<NormalizerConfig>;
          if (parsed && Object.keys(parsed).length > 0) {
            config = { ...DEFAULT_NORMALIZER_CONFIG, ...parsed };
          }
        }
        const rawDef = window.localStorage.getItem("vc-normalizer-default");
        if (rawDef !== null && defaultEnabled === null) {
          defaultEnabled = Boolean(JSON.parse(rawDef));
        }
      } catch { /* ignore */ }
    }
    const finalConfig = config ?? { ...DEFAULT_NORMALIZER_CONFIG };
    const finalDefault = defaultEnabled ?? false;
    try {
      window.localStorage.setItem("vc-normalizer-config", JSON.stringify(finalConfig));
      window.localStorage.setItem("vc-normalizer-default", JSON.stringify(finalDefault));
    } catch { /* ignore */ }
    pushToEngine({ normalizerConfig: finalConfig, normalizerEnabled: finalDefault });
    set({ normalizerConfig: finalConfig, normalizerDefaultEnabled: finalDefault, normalizerEnabled: finalDefault });
  },

  // --- options page state ----------------------------------------------------

  blocklist: [],
  whitelist: [],
  whitelistMode: false,
  siteDebug: {},
  debugDefaults: { ...DEFAULT_SITE_DEBUG },

  hydrateOptionsState: () => {
    const state = get();
    let blocklist: string[] = [];
    let whitelist: string[] = [];
    let whitelistMode = false;
    let siteDebug: Record<string, SiteDebugOverrides> = {};
    let debugDefaults = { ...DEFAULT_SITE_DEBUG };
    try {
      const raw = window.localStorage.getItem("vc-access-lists");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{ blocklist: string[]; whitelist: string[]; whitelistMode: boolean }>;
        if (Array.isArray(parsed.blocklist)) blocklist = parsed.blocklist.map(String);
        if (Array.isArray(parsed.whitelist)) whitelist = parsed.whitelist.map(String);
        whitelistMode = Boolean(parsed.whitelistMode);
      }
    } catch { /* ignore */ }
    try {
      const raw = window.localStorage.getItem("vc-site-debug");
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Partial<SiteDebugOverrides>>;
        for (const [key, value] of Object.entries(parsed ?? {})) {
          siteDebug[key] = normalizeSiteDebug(value);
        }
      }
    } catch { /* ignore */ }
    try {
      const raw = window.localStorage.getItem("vc-debug-defaults");
      if (raw) debugDefaults = normalizeSiteDebug(JSON.parse(raw));
    } catch { /* ignore */ }

    // Show Debug Highlight draws a green border around hooked video elements.
    if (typeof document !== "undefined") {
      document.body.classList.toggle("vc-debug-highlight", debugDefaults.debugMode);
    }

    const extensionActive = !siteIsBlocked(blocklist, state.site.key);
    set({ blocklist, whitelist, whitelistMode, siteDebug, debugDefaults, extensionActive });
    // Re-evaluate the current site's restriction with the hydrated overrides.
    VolumeEngine.getInstance().setRestricted(effectiveRestricted(
      { ...get(), blocklist, siteDebug, debugDefaults },
      state.site.key,
    ));
  },

  setWhitelistMode: (enabled) => {
    const state = get();
    persistAccessLists({ ...state, whitelistMode: enabled });
    set({ whitelistMode: enabled });
  },

  addAccessEntry: (entry) => {
    const state = get();
    if (state.whitelistMode) {
      if (state.whitelist.includes(entry)) return { ok: false };
      const whitelist = [...state.whitelist, entry];
      persistAccessLists({ ...state, whitelist });
      set({ whitelist });
    } else {
      if (state.blocklist.includes(entry)) return { ok: false };
      const blocklist = [...state.blocklist, entry];
      const extensionActive = !siteIsBlocked(blocklist, state.site.key);
      persistAccessLists({ ...state, blocklist });
      set({ blocklist, extensionActive });
      pushToEngine({ extensionActive });
    }
    return { ok: true };
  },

  removeAccessEntry: (entry) => {
    const state = get();
    if (state.whitelistMode) {
      const whitelist = state.whitelist.filter((e) => e !== entry);
      persistAccessLists({ ...state, whitelist });
      set({ whitelist });
    } else {
      const blocklist = state.blocklist.filter((e) => e !== entry);
      const extensionActive = !siteIsBlocked(blocklist, state.site.key);
      persistAccessLists({ ...state, blocklist });
      set({ blocklist, extensionActive });
      pushToEngine({ extensionActive });
    }
  },

  addRememberedEntry: (siteKey) => {
    const state = get();
    if (state.rememberedSettings[siteKey]) return { ok: false };
    const entry: RememberedEntry = { volume: 0, mono: false, muted: false, normalizerEnabled: false };
    set({
      remembered: { ...state.remembered, [siteKey]: true },
      rememberedSettings: { ...state.rememberedSettings, [siteKey]: entry },
    });
    writeRememberedEntry(siteKey, entry);
    return { ok: true };
  },

  removeRememberedEntry: (siteKey) => {
    const state = get();
    const remembered = { ...state.remembered };
    const rememberedSettings = { ...state.rememberedSettings };
    delete remembered[siteKey];
    delete rememberedSettings[siteKey];
    set({ remembered, rememberedSettings });
    removeRememberedStorage(siteKey);
  },

  renameRememberedEntry: (oldKey, newKey) => {
    const state = get();
    if (state.rememberedSettings[newKey]) return { ok: false, reason: "exists" as const };
    const entry = state.rememberedSettings[oldKey];
    if (!entry) return { ok: false };
    const remembered = { ...state.remembered };
    const rememberedSettings = { ...state.rememberedSettings };
    delete remembered[oldKey];
    delete rememberedSettings[oldKey];
    remembered[newKey] = true;
    rememberedSettings[newKey] = entry;
    set({ remembered, rememberedSettings });
    removeRememberedStorage(oldKey);
    writeRememberedEntry(newKey, entry);
    return { ok: true };
  },

  updateRememberedEntry: (siteKey, patch) => {
    const state = get();
    const current = state.rememberedSettings[siteKey];
    if (!current) return;
    const entry: RememberedEntry = {
      volume: patch.volume !== undefined ? normalizeDb(patch.volume) : current.volume,
      mono: patch.mono !== undefined ? Boolean(patch.mono) : current.mono,
      muted: patch.muted !== undefined ? Boolean(patch.muted) : current.muted,
      normalizerEnabled: patch.normalizerEnabled !== undefined
        ? Boolean(patch.normalizerEnabled)
        : current.normalizerEnabled,
    };
    set({ rememberedSettings: { ...state.rememberedSettings, [siteKey]: entry } });
    writeRememberedEntry(siteKey, entry);

    // storage.onChanged → the open tab picks the change up live (cs.js).
    if (siteKey === state.site.key) {
      const engine = VolumeEngine.getInstance();
      pushToEngine({
        requestedDb: entry.volume,
        mono: entry.mono,
        muted: entry.muted,
        normalizerEnabled: entry.normalizerEnabled,
      });
      set({
        requestedDb: entry.volume,
        dB: engine.getAudioControlState().volume,
        mono: entry.mono,
        muted: entry.muted,
        normalizerEnabled: entry.normalizerEnabled,
        badge: makeBadge(engine.getAudioControlState().volume, entry.muted),
      });
    }
  },

  addSiteDebugEntry: (siteKey) => {
    const state = get();
    if (state.siteDebug[siteKey]) return { ok: false };
    const siteDebug = { ...state.siteDebug, [siteKey]: { ...DEFAULT_SITE_DEBUG } };
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    return { ok: true };
  },

  removeSiteDebugEntry: (siteKey) => {
    const state = get();
    const siteDebug = { ...state.siteDebug };
    delete siteDebug[siteKey];
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    // Re-evaluate the current site's restriction without the override.
    if (siteKey === state.site.key) {
      VolumeEngine.getInstance().setRestricted(effectiveRestricted({ ...get(), siteDebug }, siteKey));
      const engineState = VolumeEngine.getInstance().getAudioControlState();
      set({ dB: engineState.volume, badge: makeBadge(engineState.volume, get().muted) });
    }
  },

  renameSiteDebugEntry: (oldKey, newKey) => {
    const state = get();
    if (state.siteDebug[newKey]) return { ok: false, reason: "exists" as const };
    const entry = state.siteDebug[oldKey];
    if (!entry) return { ok: false };
    const siteDebug = { ...state.siteDebug };
    delete siteDebug[oldKey];
    siteDebug[newKey] = entry;
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    return { ok: true };
  },

  updateSiteDebugEntry: (siteKey, patch) => {
    const state = get();
    const current = state.siteDebug[siteKey];
    if (!current) return;
    const siteDebug = { ...state.siteDebug, [siteKey]: normalizeSiteDebug({ ...current, ...patch }) };
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    if (siteKey === state.site.key) {
      VolumeEngine.getInstance().setRestricted(effectiveRestricted({ ...get(), siteDebug }, siteKey));
      const engineState = VolumeEngine.getInstance().getAudioControlState();
      set({ dB: engineState.volume, badge: makeBadge(engineState.volume, get().muted) });
    }
  },

  setDebugDefaults: (patch) => {
    const state = get();
    const debugDefaults = normalizeSiteDebug({ ...state.debugDefaults, ...patch });
    persistDebugDefaults(debugDefaults);
    // Show Debug Highlight draws a green border around hooked video elements.
    if (typeof document !== "undefined") {
      document.body.classList.toggle("vc-debug-highlight", debugDefaults.debugMode);
    }
    set({ debugDefaults });
    // DRM-related overrides change the effective restriction live.
    VolumeEngine.getInstance().setRestricted(effectiveRestricted({ ...get(), debugDefaults }, state.site.key));
    const engineState = VolumeEngine.getInstance().getAudioControlState();
    set({ dB: engineState.volume, badge: makeBadge(engineState.volume, get().muted) });
  },

  optionsTabOpen: false,
  viewingOptions: false,

  openOptionsTab: () => {
    // popup.js → runtime.openOptionsPage(): a full new tab (manifest
    // options_ui.open_in_tab) and the popup closes.
    set({ optionsTabOpen: true, viewingOptions: true, popupOpen: false });
  },

  closeOptionsTab: () => set({ optionsTabOpen: false, viewingOptions: false }),

  showOptionsTab: () => set({ viewingOptions: true, popupOpen: false }),

  popupOpen: false,
  openPopup: () => set({ popupOpen: true }),
  closePopup: () => set({ popupOpen: false }),
  badge: null,
  reloadCount: 0,

  playlists: { "demo.local": [], "quiet.fm": [] },

  addMediaItems: (items) => {
    const siteKey = get().site.key;
    const current = get().playlists[siteKey] ?? [];
    set({ playlists: { ...get().playlists, [siteKey]: [...current, ...items] } });
  },

  removeMediaItem: (id) => {
    const siteKey = get().site.key;
    const current = get().playlists[siteKey] ?? [];
    const item = current.find((m) => m.id === id);
    if (item?.isObjectUrl) {
      try { URL.revokeObjectURL(item.url); } catch { /* ignore */ }
    }
    set({ playlists: { ...get().playlists, [siteKey]: current.filter((m) => m.id !== id) } });
  },
}));
