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
  toggleRemember: () => Promise<void>;
  persistIfRemembered: () => Promise<void>;
  hydrateRemembered: () => Promise<void>;
  hydrateNormalizerConfig: () => Promise<void>;

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

export const useExtensionStore = create<ExtensionStore>((set, get) => ({
  site: DEMO_SITES[0],
  navigating: false,

  navigate: async (siteKey) => {
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
    let remembered: {
      volume?: number;
      mono?: boolean;
      muted?: boolean;
      normalizerEnabled?: boolean;
    } | null = null;
    try {
      const raw = window.localStorage.getItem(`vc-remembered-${site.key}`);
      if (raw) remembered = JSON.parse(raw);
    } catch { /* ignore */ }

    VolumeEngine.getInstance().setRestricted(Boolean(state.restricted[site.key]));

    const nextDb = remembered && Number.isFinite(remembered.volume)
      ? normalizeDb(remembered.volume ?? 0)
      : 0;
    const nextMono = remembered ? Boolean(remembered.mono) : false;
    const nextMuted = remembered ? Boolean(remembered.muted) : false;
    const nextNormalizer = remembered
      ? Boolean(remembered.normalizerEnabled)
      : state.normalizerDefaultEnabled;

    pushToEngine({
      extensionActive: state.extensionActive,
      requestedDb: nextDb,
      mono: nextMono,
      muted: nextMuted,
      normalizerEnabled: nextNormalizer,
      normalizerConfig: state.normalizerConfig,
    });

    set({
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
    const extensionActive = !get().extensionActive;
    // Real behavior: the tab reloads and the popup closes.
    set({ extensionActive, popupOpen: false, navigating: true, badge: null });
    pushToEngine({ extensionActive });
    setTimeout(() => set({ navigating: false }), 650);
    set((s) => ({ reloadCount: s.reloadCount + 1 }));
  },

  setRestricted: (restricted) => {
    const site = get().site;
    const next = { ...get().restricted, [site.key]: restricted };
    VolumeEngine.getInstance().setRestricted(restricted);
    // Re-clamp displayed volume against the new limit.
    const engineState = VolumeEngine.getInstance().getAudioControlState();
    set({
      restricted: next,
      dB: engineState.volume,
      badge: makeBadge(engineState.volume, get().muted),
    });
  },

  remembered: {},

  toggleRemember: async () => {
    const state = get();
    const siteKey = state.site.key;
    const has = Boolean(state.remembered[siteKey]);
    if (has) {
      set({ remembered: { ...state.remembered, [siteKey]: false } });
      try { window.localStorage.removeItem(`vc-remembered-${siteKey}`); } catch { /* ignore */ }
      if (!IS_STATIC_EXPORT) {
        await fetch(`/api/settings?site=${encodeURIComponent(siteKey)}`, { method: "DELETE" })
          .catch(() => undefined);
      }
    } else {
      const payload = {
        siteKey,
        volume: state.requestedDb,
        mono: state.mono,
        muted: state.muted,
        normalizerEnabled: state.normalizerEnabled,
      };
      set({ remembered: { ...state.remembered, [siteKey]: true } });
      try {
        window.localStorage.setItem(`vc-remembered-${siteKey}`, JSON.stringify(payload));
      } catch { /* ignore */ }
      if (!IS_STATIC_EXPORT) {
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => undefined);
      }
    }
  },

  persistIfRemembered: async () => {
    const state = get();
    const siteKey = state.site.key;
    if (!state.remembered[siteKey]) return;
    const payload = {
      siteKey,
      volume: state.requestedDb,
      mono: state.mono,
      muted: state.muted,
      normalizerEnabled: state.normalizerEnabled,
    };
    try {
      window.localStorage.setItem(`vc-remembered-${siteKey}`, JSON.stringify(payload));
    } catch { /* ignore */ }
    if (!IS_STATIC_EXPORT) {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => undefined);
    }
  },

  hydrateRemembered: async () => {
    // Server-backed lookup (skipped in the static GitHub Pages build) …
    const remembered: Record<string, boolean> = {};
    if (!IS_STATIC_EXPORT) {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data: { settings?: { siteKey: string }[] } = await res.json();
          for (const row of data.settings ?? []) remembered[row.siteKey] = true;
        }
      } catch { /* offline / static — localStorage below is authoritative */ }
    }
    // … and the localStorage mirror, which is the primary store when static
    // (the web equivalent of the extension's chrome.storage on Pages).
    for (const site of DEMO_SITES) {
      const has = Boolean(window.localStorage.getItem(`vc-remembered-${site.key}`));
      if (has) remembered[site.key] = true;
    }
    set({ remembered });
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
