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

/** An in-site navigation link (the fake site's own menu — real sites have
 *  paths, and path-scoped profiles/entries match against them). */
export interface DemoNavLink {
  label: string;
  path: string;
}

export interface DemoSite {
  key: string;
  url: string;
  tabTitle: string;
  title: string;
  subtitle: string;
  /** The site's own navigation (paths under the same origin). */
  navLinks: DemoNavLink[];
}

export const DEMO_SITES: DemoSite[] = [
  {
    key: "demo.local",
    url: "https://demo.local/playground",
    tabTitle: "Media Playground",
    title: "Media Playground",
    subtitle: "Drop audio or video files to test Volume Control on your own media.",
    navLinks: [
      { label: "Playground", path: "/playground" },
      { label: "Video booth", path: "/playground/video-booth" },
    ],
  },
  {
    key: "quiet.fm",
    url: "https://quiet.fm/late-night",
    tabTitle: "Quiet FM · Late Night Talk",
    title: "Quiet FM — Late Night Talk",
    subtitle: "A talk stream mixed far too quietly. Perfect for testing volume boost.",
    navLinks: [
      { label: "Late Night Talk", path: "/late-night" },
      { label: "Archive", path: "/late-night/archive" },
    ],
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
}

/** Per-site Normalize preference (chrome.storage siteNormalizerSettings) —
 *  stored independently from Remembered audio settings, exactly like the
 *  extension (README: "does not require Remember"). */
export interface NormalizerPref {
  enabled: boolean;
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
  /** Last-visited URL per site key (tab switches restore it, like a browser). */
  siteUrls: Record<string, string>;
  navigating: boolean;
  navigate: (siteKey: string) => Promise<void>;
  /** Navigate the current fake site to another path (in-site link). */
  navigatePath: (path: string) => Promise<void>;
  applySiteSettings: (siteKey: string, url?: string) => void;

  // --- extension state (mirrors cs.js tc.vars) ------------------------------
  requestedDb: number;
  dB: number;
  muted: boolean;
  mono: boolean;
  normalizerEnabled: boolean;
  normalizerConfig: NormalizerConfig;
  normalizerDefaultEnabled: boolean;
  extensionActive: boolean;
  /** Per-site simulated DRM / cross-origin media flags (the fake sites'
   *  toggles — cs.js updatePageMediaRestriction sources). */
  restricted: Record<string, boolean>;
  crossOrigin: Record<string, boolean>;

  setVolume: (db: number) => void;
  toggleMute: () => void;
  setMute: (muted: boolean) => void;
  toggleMono: () => void;
  toggleNormalizer: () => void;
  setNormalizerConfig: (config: Partial<NormalizerConfig>) => void;
  setNormalizerDefaultEnabled: (enabled: boolean) => void;
  toggleActive: () => void;
  setRestricted: (restricted: boolean) => void;
  setCrossOrigin: (crossOrigin: boolean) => void;

  // --- remembered settings (chrome.storage siteSettings via API) ------------
  remembered: Record<string, boolean>; // entry key -> has saved settings
  rememberedSettings: Record<string, RememberedEntry>; // entry key -> saved values
  /** Per-site/path Normalize preferences (siteNormalizerSettings). */
  normalizerPrefs: Record<string, NormalizerPref>;
  toggleRemember: () => Promise<void>;
  persistIfRemembered: () => Promise<void>;
  hydrateRemembered: () => Promise<void>;
  hydrateNormalizerConfig: () => Promise<void>;

  // --- options page state (access lists, site debug, debug defaults) --------
  blocklist: string[];
  whitelist: string[];
  /** blocklist archived by whitelist mode (background.js archivedFqdns). */
  archivedBlocklist: string[];
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

/* ------------------------------------------------------------------ */
/* Access-list matching — shared.js canonicalizeHostname /               */
/* splitBlocklistEntry / isUrlBlockedByEntry (path-aware, issue #69).     */
/* ------------------------------------------------------------------ */

/** shared.js canonicalizeHostname(): lowercased, trailing dot and leading
 *  "www." stripped — entries and the current host compare through it. */
function canonicalHost(host: string): string {
  const h = String(host ?? "").trim().toLowerCase();
  if (!h) return "";
  return h.replace(/\.$/, "").replace(/^www\./, "");
}

/** "domain[/path][?query]" → parts (domain canonicalized, port stripped). */
function splitEntry(entry: string): { domain: string; path: string; query: string } | null {
  let v = String(entry ?? "").trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^/@]+@/, "");
  let query = "";
  const qi = v.indexOf("?");
  if (qi !== -1) { query = v.slice(qi + 1); v = v.slice(0, qi); }
  const si = v.indexOf("/");
  const domain = canonicalHost((si === -1 ? v : v.slice(0, si)).replace(/:\d+$/, ""));
  let path = si === -1 ? "" : v.slice(si);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";
  if (!domain) return null;
  return { domain, path, query };
}

function wildcardToRegExp(pattern: string, seg: string): RegExp {
  const body = pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(seg);
  return new RegExp(`^${body}$`);
}

/** shared.js isUrlBlockedByEntry(): a bare domain matches the host and its
 *  subdomains; a path scopes the entry ("*" per segment; a plain path also
 *  covers descendants); a saved query must match exactly or via wildcards.
 *  Exported for consumers (popup) that must name the blocking entry like
 *  popup.js v6.15 does. */
export function entryMatchesUrl(entry: string, url: string): boolean {
  const parts = splitEntry(entry);
  if (!parts) return false;
  let parsed: URL | null = null;
  try { parsed = new URL(String(url)); } catch { parsed = null; }
  if (!parsed) return false;
  const host = canonicalHost(parsed.hostname);
  if (parts.domain !== host && !host.endsWith(`.${parts.domain}`)) return false;
  const path = parsed.pathname || "/";
  if (parts.path) {
    try {
      if (parts.path.includes("*")) {
        if (!wildcardToRegExp(parts.path, "[^/]*").test(path)) return false;
      } else if (path !== parts.path && !path.startsWith(parts.path + "/")) {
        return false;
      }
    } catch { return false; }
  }
  if (parts.query) {
    const q = parsed.search ? parsed.search.slice(1) : "";
    try {
      if (parts.query.includes("*")) {
        if (!wildcardToRegExp(parts.query, ".*").test(q)) return false;
      } else if (q !== parts.query) return false;
    } catch { return false; }
  }
  return true;
}

function entriesMatchingUrl(list: string[], url: string): string[] {
  return list.filter((e) => entryMatchesUrl(e, url));
}

/** The cs.js verdict for a page: in whitelist mode only LISTED sites run;
 *  in blacklist mode listed URLs are skipped. */
function siteExcluded(
  state: { blocklist: string[]; whitelist: string[]; whitelistMode: boolean },
  url: string,
): boolean {
  return state.whitelistMode
    ? entriesMatchingUrl(state.whitelist, url).length === 0
    : entriesMatchingUrl(state.blocklist, url).length > 0;
}

function persistAccessLists(state: {
  blocklist: string[];
  whitelist: string[];
  whitelistMode: boolean;
  archivedBlocklist?: string[];
}) {
  try {
    window.localStorage.setItem("vc-access-lists", JSON.stringify({
      blocklist: state.blocklist,
      whitelist: state.whitelist,
      whitelistMode: state.whitelistMode,
      archivedBlocklist: state.archivedBlocklist ?? [],
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

function persistNormalizerPrefs(prefs: Record<string, NormalizerPref>) {
  try {
    window.localStorage.setItem("vc-normalizer-prefs", JSON.stringify(prefs));
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Ranked settings matching — shared.js parseSiteLikeInput /            */
/* normalizeSiteSettingsEntryInput / splitSiteSettingsEntry /            */
/* isUrlRememberedByEntry / getSiteSettingsMatchRank /                   */
/* compareSiteMatches / getSiteSettingsKey. Remembered profiles, the     */
/* per-site Normalize preference and the per-site debug overrides all    */
/* resolve through it (query > path > domain, wildcards ranked below     */
/* literals, legacy host-only keys = domain entries).                    */
/* ------------------------------------------------------------------ */

function escapeRegExp(text: string): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** shared.js parseSiteLikeInput — accept "host", "host/path", full URLs
 *  and the "file" special case. */
function parseSiteLikeInput(value: string): { file: boolean; domain: string; path: string; query: string } | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^(?:local file|file)$/i.test(raw) || /^file:/i.test(raw)) {
    return { file: true, domain: "file", path: "", query: "" };
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return null;
    let path = parsed.pathname || "";
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (path === "/") path = "";
    return {
      file: false,
      domain: canonicalHost(parsed.hostname),
      path,
      query: parsed.search ? parsed.search.slice(1) : "",
    };
  } catch {
    return null;
  }
}

/** shared.js normalizeSiteSettingsEntryInput — the canonical entry key
 *  ("domain[/path][?query]"). The query is dropped unless explicitly kept
 *  (manual profile input opts in). */
export function normalizeSiteEntryInput(value: string, options: { includeQuery?: boolean } = {}): string {
  const parsed = parseSiteLikeInput(value);
  if (!parsed) return "";
  if (parsed.file) return "file";
  const query = options.includeQuery && parsed.query ? `?${parsed.query}` : "";
  return parsed.domain + parsed.path + query;
}

/** shared.js splitSiteSettingsEntry. */
function splitSiteEntry(entry: string): { file: boolean; domain: string; path: string; query: string } | null {
  const normalized = normalizeSiteEntryInput(entry, { includeQuery: true });
  if (!normalized) return null;
  if (normalized === "file") return { file: true, domain: "file", path: "", query: "" };
  const queryIndex = normalized.indexOf("?");
  const withoutQuery = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : normalized.slice(queryIndex + 1);
  const slash = withoutQuery.indexOf("/");
  return {
    file: false,
    domain: slash === -1 ? withoutQuery : withoutQuery.slice(0, slash),
    path: slash === -1 ? "" : withoutQuery.slice(slash),
    query,
  };
}

/** shared.js isUrlRememberedByEntry — an entry matches the page's URL when
 *  the host equals the entry domain or is a subdomain; a path scopes the
 *  entry ("*" per segment; a plain path also covers descendants); a saved
 *  query must match exactly or via wildcards. Legacy host-only keys carry
 *  no path/query and match the whole domain. */
export function isUrlRememberedByEntry(url: string, savedEntry: string): boolean {
  const saved = splitSiteEntry(savedEntry);
  if (!saved) return false;

  const rawUrl = String(url ?? "").trim();
  if (!rawUrl) return false;
  if (saved.file) {
    return /^file:/i.test(rawUrl) || /^(?:local file|file)$/i.test(rawUrl);
  }

  let current: { domain: string; path: string; query: string } | null = null;
  try {
    if (/^[a-z][a-z0-9+.-]*:[/]{2}/i.test(rawUrl)) {
      const parsed = new URL(rawUrl);
      if (!/^https?:$/.test(parsed.protocol)) return false;
      current = {
        domain: canonicalHost(parsed.hostname),
        path: parsed.pathname || "/",
        query: parsed.search ? parsed.search.slice(1) : "",
      };
    }
  } catch {
    current = null;
  }

  if (!current) {
    const normalizedCurrent = normalizeSiteEntryInput(rawUrl, { includeQuery: true });
    if (!normalizedCurrent || normalizedCurrent === "file") return false;
    const split = splitSiteEntry(normalizedCurrent);
    if (!split) return false;
    current = {
      domain: split.domain,
      path: split.path || "/",
      query: split.query || "",
    };
  }

  if (!(current.domain === saved.domain || current.domain.endsWith(`.${saved.domain}`))) {
    return false;
  }
  let pathMatches = true;
  if (saved.path) {
    if (saved.path.includes("*")) {
      const pattern = "^" + saved.path.split("*").map(escapeRegExp).join("[^/]*") + "$";
      try {
        pathMatches = new RegExp(pattern).test(current.path);
      } catch {
        return false;
      }
    } else {
      // A remembered path applies to that path and descendants.
      pathMatches = current.path === saved.path || current.path.startsWith(saved.path + "/");
    }
  }
  if (!pathMatches) return false;

  // Query matching is opt-in: legacy/default profiles have no saved.query
  // and therefore continue to ignore transient query parameters.
  if (!saved.query) return true;
  if (saved.query.includes("*")) {
    const pattern = "^" + saved.query.split("*").map(escapeRegExp).join(".*") + "$";
    try {
      return new RegExp(pattern).test(current.query || "");
    } catch {
      return false;
    }
  }
  return (current.query || "") === saved.query;
}

/** shared.js getSiteSettingsMatchRank — query > path > exact host, then
 *  literal length, fewer wildcards, deeper domain, longer domain. */
function siteMatchRank(url: string, savedEntry: string): number[] {
  const saved = splitSiteEntry(savedEntry);
  if (!saved) return [0, 0, 0, 0, 0, 0, 0];

  let currentDomain = "";
  try {
    const parsed = new URL(String(url));
    currentDomain = canonicalHost(parsed.hostname);
  } catch {
    const normalized = normalizeSiteEntryInput(url);
    const slash = normalized.indexOf("/");
    currentDomain = slash === -1 ? normalized : normalized.slice(0, slash);
  }

  const wildcardCount = ((saved.path || "").match(/\*/g) || []).length +
    ((saved.query || "").match(/\*/g) || []).length;
  const literalLength = (saved.path || "").replace(/\*/g, "").length +
    (saved.query || "").replace(/\*/g, "").length;
  return [
    saved.query ? 1 : 0,
    saved.path ? 1 : 0,
    currentDomain === saved.domain ? 1 : 0,
    literalLength,
    -wildcardCount,
    saved.domain.split(".").length,
    saved.domain.length,
  ];
}

function compareSiteMatches(url: string, a: string, b: string): number {
  const ar = siteMatchRank(url, a);
  const br = siteMatchRank(url, b);
  for (let i = 0; i < ar.length; i++) {
    if (ar[i] !== br[i]) return br[i] - ar[i];
  }
  return String(a).localeCompare(String(b));
}

/** shared.js getSiteSettingsKey — the best-ranked entry governing a URL:
 *  an exact query key wins outright, then the ranked matches. null when
 *  nothing matches (callers fall back to their defaults). */
export function getSiteSettingsKey<T>(entries: Record<string, T>, url: string): string | null {
  if (!url) return null;
  const keys = Object.keys(entries ?? {});
  if (!keys.length) return null;

  const normalizedWithQuery = normalizeSiteEntryInput(url, { includeQuery: true });
  if (normalizedWithQuery && keys.includes(normalizedWithQuery)) return normalizedWithQuery;

  // Do not return a generic exact-path key before ranking matches. A
  // manually entered query wildcard (e.g. watch?v=*) is intentionally
  // more specific than the default path-only watch profile.
  return keys
    .filter((savedEntry) => isUrlRememberedByEntry(url, savedEntry))
    .sort((a, b) => compareSiteMatches(url, a, b))[0] || null;
}

/* ------------------------------------------------------------------ */
/* Boost-limit verdict layer — cs.js BOOST_LIMIT_NOTES /                */
/* reasonSeverity / isBoostLimitReasonBypassed / getBoostLimitInfo      */
/* (600-605) + shared.js BOOST_LIMIT_NOTE.                              */
/* ------------------------------------------------------------------ */

/** shared.js BOOST_LIMIT_NOTE — the fallback note for unknown reasons. */
export const BOOST_LIMIT_NOTE = "Boosting, mono, and normalization may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.";

/** cs.js BOOST_LIMIT_NOTES (verbatim, v7.1). */
export const BOOST_LIMIT_NOTES: Record<string, string> = {
  "cross-origin": "Limited by cross-origin media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.",
  restricted: "Limited by DRM-protected or otherwise restricted media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.",
  "route-failed": "WebAudio routing failed or is unavailable. Native media may allow attenuation, but boosting and mono are unavailable; an already-captured element with a closed audio context may stay silent until reload.",
  "native-route": "Force native fallback is selected. Native HTML media volume can attenuate or mute, but boosting, mono, and Normalize require WebAudio.",
  fallback: BOOST_LIMIT_NOTE,
};

/** cs.js reasonSeverity — DRM restriction outranks everything. */
function reasonSeverity(reason: string): number {
  if (reason === "restricted") return 3;
  if (reason === "cross-origin" || reason === "route-failed" || reason === "native-route") return 2;
  return reason ? 1 : 0;
}

/** cs.js applyEffectiveDebugSettings: the global debug defaults, replaced
 *  per site by a ranked path/query-scoped override (siteDebugSettings).
 *  Exported for consumers that must mirror the resolved config. */
export function effectiveDebugConfig(state: ExtensionStore, url: string): SiteDebugOverrides {
  const perSiteKey = getSiteSettingsKey(state.siteDebug, url);
  const override = perSiteKey ? state.siteDebug[perSiteKey] : null;
  return override ? { ...state.debugDefaults, ...override } : { ...state.debugDefaults };
}

/** The engine-level restriction verdict for a site, honoring the debug
 *  bypasses (cs.js isBoostLimitReasonBypassed): "Force DRM Audio Capture"
 *  lifts restricted, "Skip CORS Media Guard" lifts cross-origin. A DRM
 *  verdict outranks a cross-origin one. Returns "" | "restricted" |
 *  "cross-origin". */
export function effectiveRestriction(state: ExtensionStore, siteKey: string, url: string): string {
  const debug = effectiveDebugConfig(state, url);
  const drm = Boolean(state.restricted[siteKey]) && !debug.forceDrmCapture ? "restricted" : "";
  const cors = Boolean(state.crossOrigin[siteKey]) && !debug.forceCorsCapture ? "cross-origin" : "";
  return reasonSeverity(drm) >= reasonSeverity(cors) ? drm : cors;
}

/** cs.js getBoostLimitInfo verdict policy: the debug "Force native volume
 *  fallback" route clamps boost at 0 dB unless a more informative
 *  DRM/CORS verdict is already present. Exported for consumers (popup)
 *  that must mirror the engine verdict like cs.js does. */
export function effectiveLimitation(state: ExtensionStore, siteKey: string, url: string): string {
  const reason = effectiveRestriction(state, siteKey, url);
  if (reason) return reason;
  if (effectiveDebugConfig(state, url).debugRouteMode === "native") return "native-route";
  return "";
}

export const useExtensionStore = create<ExtensionStore>((set, get) => {
  /** Re-resolve the current site's effective debug config + restriction and
   *  push both into the engine and the debug highlight (cs.js
   *  applyEffectiveDebugSettings + the storage.onChanged → start() re-run).
   *  Also re-clamps the displayed volume against the new boost limit. */
  const syncDebugToEngine = () => {
    const state = get();
    const debug = effectiveDebugConfig(state, state.site.url);
    // "Show Debug Highlight" (global default, or the per-site override for
    // THIS page) paints a green outline on hooked media — exactly the
    // extension's per-tab tc.settings.debugMode resolution.
    if (typeof document !== "undefined") {
      document.body.classList.toggle("vc-debug-highlight", debug.debugMode);
    }
    const engine = VolumeEngine.getInstance();
    engine.setRestriction(effectiveRestriction(state, state.site.key, state.site.url));
    pushToEngine({ debugRouteMode: debug.debugRouteMode });
    const engineState = engine.getAudioControlState();
    set({ dB: engineState.volume, badge: makeBadge(engineState.volume, state.muted) });
  };

  return {
  site: DEMO_SITES[0],
  siteUrls: Object.fromEntries(DEMO_SITES.map((s) => [s.key, s.url])),
  navigating: false,

  navigate: async (siteKey) => {
    // Switching to a demo tab always leaves the options-page view.
    set({ viewingOptions: false });
    const current = get();
    const base = DEMO_SITES.find((s) => s.key === siteKey);
    if (!base || base.key === current.site.key) return;
    // Real behavior: navigation clears the badge and re-runs the content
    // script, which restores remembered settings for the new site. Each tab
    // keeps its last-visited URL, like a real browser.
    const site = { ...base, url: current.siteUrls[siteKey] ?? base.url };
    set({ navigating: true, popupOpen: false, badge: null });
    await new Promise((resolve) => setTimeout(resolve, 650));
    get().applySiteSettings(site.key, site.url);
    set({ site, navigating: false });
  },

  navigatePath: async (path) => {
    // An in-site link: same navigation semantics as switching tabs (badge
    // cleared, content script re-runs, settings re-resolve for the new URL
    // — path-scoped profiles and access entries included).
    const state = get();
    let origin = "";
    try { origin = new URL(state.site.url).origin; } catch { return; }
    const url = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
    if (url === state.site.url) return;
    const site = { ...state.site, url };
    set({
      navigating: true,
      popupOpen: false,
      badge: null,
      site,
      siteUrls: { ...state.siteUrls, [site.key]: url },
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    get().applySiteSettings(site.key);
    set({ navigating: false });
  },

  /** Restore a site's remembered settings — the content script's start()
   *  behavior after (re)loading a page. Also used for the initial mount.
   *  Profiles resolve through shared.js getSiteSettingsKey ranked matching
   *  (query > path > domain), so path/query-scoped entries created on the
   *  options page apply like on the real extension. */
  applySiteSettings: (siteKey, urlOverride) => {
    const state = get();
    const base = DEMO_SITES.find((s) => s.key === siteKey);
    if (!base) return;
    const siteUrl = urlOverride ?? (siteKey === state.site.key ? state.site.url : base.url);

    // The extension is inactive on pages excluded via the options page
    // (whitelist mode: not listed; blacklist mode: listed) — the popup's
    // "Active" toggle writes those same lists.
    const extensionActive = !siteExcluded(state, siteUrl);
    const debug = effectiveDebugConfig(state, siteUrl);
    VolumeEngine.getInstance().setRestriction(effectiveRestriction(state, siteKey, siteUrl));

    // Remembered audio settings: best-ranked matching entry (shared.js
    // getSiteSettingsKey), else the defaults.
    const entryKey = getSiteSettingsKey(state.rememberedSettings, siteUrl);
    const remembered = entryKey ? state.rememberedSettings[entryKey] : null;

    const nextDb = remembered && Number.isFinite(remembered.volume)
      ? normalizeDb(remembered.volume ?? 0)
      : 0;
    const nextMono = remembered ? Boolean(remembered.mono) : false;
    const nextMuted = remembered ? Boolean(remembered.muted) : false;

    // Normalize preference: per-site ranked entry → global default
    // (cs.js start(): siteNormalizerSettings vs normalizerDefaultEnabled).
    const prefKey = getSiteSettingsKey(state.normalizerPrefs, siteUrl);
    const nextNormalizer = prefKey
      ? Boolean(state.normalizerPrefs[prefKey]?.enabled)
      : state.normalizerDefaultEnabled;

    pushToEngine({
      extensionActive,
      debugRouteMode: debug.debugRouteMode,
      requestedDb: nextDb,
      mono: nextMono,
      muted: nextMuted,
      normalizerEnabled: nextNormalizer,
      normalizerConfig: state.normalizerConfig,
    });

    // Debug highlight + fallback re-clamp for the (possibly new) URL.
    if (typeof document !== "undefined") {
      document.body.classList.toggle("vc-debug-highlight", debug.debugMode);
    }

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
  crossOrigin: { "demo.local": false, "quiet.fm": false },

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
    const state = get();
    const normalizerEnabled = !state.normalizerEnabled;
    pushToEngine({ normalizerEnabled });
    set({ normalizerEnabled });
    // popup.js persists the Normalize preference per site/path via setForUrl,
    // independently of Remember (it survives even with Remember OFF).
    const prefKey = getSiteSettingsKey(state.normalizerPrefs, state.site.url) ??
      normalizeSiteEntryInput(state.site.url);
    if (prefKey) {
      const normalizerPrefs = { ...state.normalizerPrefs, [prefKey]: { enabled: normalizerEnabled } };
      set({ normalizerPrefs });
      persistNormalizerPrefs(normalizerPrefs);
    }
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
    // storage.onChanged → open tabs re-resolve (cs.js start()): sites without
    // their own Normalize preference follow the new default live.
    const state = get();
    const prefKey = getSiteSettingsKey(state.normalizerPrefs, state.site.url);
    const resolved = prefKey
      ? Boolean(state.normalizerPrefs[prefKey]?.enabled)
      : enabled;
    pushToEngine({ normalizerEnabled: resolved });
    set({ normalizerEnabled: resolved });
  },

  toggleActive: () => {
    // Real extension semantics (background.js setSiteActive): "Active"
    // edits the list that governs this page — the blocklist entry in
    // Blacklist mode, the whitelist entry in Whitelist mode — and flipping
    // Active ON removes EVERY entry that keeps the page inactive
    // (path-scoped ones included). New entries are stored canonicalized.
    const state = get();
    const url = state.site.url;
    if (state.whitelistMode) {
      const allowed = entriesMatchingUrl(state.whitelist, url).length > 0;
      const whitelist = allowed
        ? state.whitelist.filter((e) => !entryMatchesUrl(e, url))
        : [...state.whitelist, canonicalHost(state.site.key)];
      const extensionActive = !siteExcluded({ ...state, whitelist }, url);
      persistAccessLists({ ...state, whitelist });
      set({ whitelist, extensionActive, popupOpen: false, navigating: true, badge: null });
      pushToEngine({ extensionActive });
    } else {
      const blocked = entriesMatchingUrl(state.blocklist, url).length > 0;
      const blocklist = blocked
        ? state.blocklist.filter((e) => !entryMatchesUrl(e, url))
        : [...state.blocklist, canonicalHost(state.site.key)];
      const extensionActive = !siteExcluded({ ...state, blocklist }, url);
      persistAccessLists({ ...state, blocklist });
      set({ blocklist, extensionActive, popupOpen: false, navigating: true, badge: null });
      pushToEngine({ extensionActive });
    }
    setTimeout(() => set({ navigating: false }), 650);
    set((s) => ({ reloadCount: s.reloadCount + 1 }));
  },

  setRestricted: (restricted) => {
    // The fake site's DRM toggle: flip the flag, then re-resolve the verdict
    // (the debug "Force DRM Audio Capture" override may lift it again). The
    // engine reacts live — clamps, notes, mono/Normalize availability.
    const state = get();
    set({ restricted: { ...state.restricted, [state.site.key]: restricted } });
    syncDebugToEngine();
  },

  setCrossOrigin: (crossOrigin) => {
    // The fake site's cross-origin toggle: same live round-trip as the DRM
    // toggle, with the "Skip CORS Media Guard" debug override as the bypass.
    const state = get();
    set({ crossOrigin: { ...state.crossOrigin, [state.site.key]: crossOrigin } });
    syncDebugToEngine();
  },

  remembered: {},
  rememberedSettings: {},
  normalizerPrefs: {},

  toggleRemember: async () => {
    // background.js mergeForUrl/removeForUrl: Remember ON updates the
    // best-ranked matching entry (or creates one under the page's path key,
    // query dropped); OFF removes the governing entry.
    const state = get();
    const existingKey = getSiteSettingsKey(state.rememberedSettings, state.site.url);
    if (existingKey) {
      const remembered = { ...state.remembered };
      const rememberedSettings = { ...state.rememberedSettings };
      delete remembered[existingKey];
      delete rememberedSettings[existingKey];
      set({ remembered, rememberedSettings });
      removeRememberedStorage(existingKey);
    } else {
      const key = normalizeSiteEntryInput(state.site.url);
      if (!key) return;
      const payload: RememberedEntry = {
        volume: state.requestedDb,
        mono: state.mono,
        muted: state.muted,
      };
      set({
        remembered: { ...state.remembered, [key]: true },
        rememberedSettings: { ...state.rememberedSettings, [key]: payload },
      });
      writeRememberedEntry(key, payload);
    }
  },

  persistIfRemembered: async () => {
    // background.js mergeForUrl: update the governing (best-ranked) entry.
    const state = get();
    const key = getSiteSettingsKey(state.rememberedSettings, state.site.url);
    if (!key) return;
    const payload: RememberedEntry = {
      volume: state.requestedDb,
      mono: state.mono,
      muted: state.muted,
    };
    set({ rememberedSettings: { ...state.rememberedSettings, [key]: payload } });
    writeRememberedEntry(key, payload);
  },

  hydrateRemembered: async () => {
    // Server-backed lookup (skipped in the static GitHub Pages build) …
    const remembered: Record<string, boolean> = {};
    const rememberedSettings: Record<string, RememberedEntry> = {};
    // Legacy entries stored the Normalize preference inside the remembered
    // audio entry — seed the separated pref store from it (one-time).
    const legacyNormalizerFlags: Record<string, boolean> = {};
    if (!IS_STATIC_EXPORT) {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data: { settings?: { siteKey: string; volume: number; mono: boolean; muted: boolean; normalizerEnabled?: boolean }[] } = await res.json();
          for (const row of data.settings ?? []) {
            remembered[row.siteKey] = true;
            rememberedSettings[row.siteKey] = {
              volume: normalizeDb(row.volume),
              mono: Boolean(row.mono),
              muted: Boolean(row.muted),
            };
            if (row.normalizerEnabled) legacyNormalizerFlags[row.siteKey] = true;
          }
        }
      } catch { /* offline / static — localStorage below is authoritative */ }
    }
    // … and the localStorage mirror, which is the primary store when static
    // (the web equivalent of the extension's chrome.storage on Pages). This
    // also picks up entries created directly on the options page (arbitrary
    // site paths and queries).
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith("vc-remembered-")) continue;
        const siteKey = key.slice("vc-remembered-".length);
        if (!siteKey) continue;
        try {
          const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as { normalizerEnabled?: boolean } | null;
          if (parsed && parsed.normalizerEnabled === true) legacyNormalizerFlags[siteKey] = true;
        } catch { /* ignore */ }
        const entry = readRememberedEntry(siteKey);
        if (entry) {
          remembered[siteKey] = true;
          rememberedSettings[siteKey] = entry;
        }
      }
    } catch { /* ignore */ }
    set({ remembered, rememberedSettings });

    // Seed the per-site Normalize pref store from legacy entries that had
    // it enabled (idempotent: existing prefs win, so later user choices are
    // never overwritten on reload).
    const prefs = { ...get().normalizerPrefs };
    let prefsChanged = false;
    for (const [key, enabled] of Object.entries(legacyNormalizerFlags)) {
      if (enabled && prefs[key] === undefined) {
        prefs[key] = { enabled: true };
        prefsChanged = true;
      }
    }
    if (prefsChanged) {
      persistNormalizerPrefs(prefs);
      set({ normalizerPrefs: prefs });
    }
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
  archivedBlocklist: [],
  whitelistMode: false,
  siteDebug: {},
  debugDefaults: { ...DEFAULT_SITE_DEBUG },

  hydrateOptionsState: () => {
    const state = get();
    let blocklist: string[] = [];
    let whitelist: string[] = [];
    let archivedBlocklist: string[] = [];
    let whitelistMode = false;
    let siteDebug: Record<string, SiteDebugOverrides> = {};
    let debugDefaults = { ...DEFAULT_SITE_DEBUG };
    let normalizerPrefs: Record<string, NormalizerPref> = {};
    try {
      const raw = window.localStorage.getItem("vc-access-lists");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{
          blocklist: string[];
          whitelist: string[];
          whitelistMode: boolean;
          archivedBlocklist: string[];
        }>;
        if (Array.isArray(parsed.blocklist)) blocklist = parsed.blocklist.map(String);
        if (Array.isArray(parsed.whitelist)) whitelist = parsed.whitelist.map(String);
        if (Array.isArray(parsed.archivedBlocklist)) archivedBlocklist = parsed.archivedBlocklist.map(String);
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
    try {
      const raw = window.localStorage.getItem("vc-normalizer-prefs");
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { enabled?: boolean }>;
        for (const [key, value] of Object.entries(parsed ?? {})) {
          normalizerPrefs[key] = { enabled: Boolean(value?.enabled) };
        }
      }
    } catch { /* ignore */ }

    const extensionActive = !siteExcluded({ blocklist, whitelist, whitelistMode }, state.site.url);
    set({ blocklist, whitelist, archivedBlocklist, whitelistMode, siteDebug, debugDefaults, normalizerPrefs, extensionActive });
    // Re-evaluate the current site's effective debug config + restriction
    // with the hydrated overrides (highlight, route mode, bypasses).
    syncDebugToEngine();
  },

  setWhitelistMode: (enabled) => {
    const state = get();
    // background.js setWhitelistMode: enabling whitelist mode ARCHIVES the
    // current blocklist (restored when whitelist mode is turned back off) —
    // exactly what the options-page help text promises.
    let { blocklist, archivedBlocklist } = state;
    if (enabled) {
      if (blocklist.length) {
        archivedBlocklist = [...blocklist];
        blocklist = [];
      }
    } else if (archivedBlocklist.length) {
      blocklist = [...archivedBlocklist];
      archivedBlocklist = [];
    }
    const extensionActive = !siteExcluded({ ...state, blocklist, whitelistMode: enabled }, state.site.url);
    persistAccessLists({ ...state, blocklist, whitelistMode: enabled, archivedBlocklist });
    set({ whitelistMode: enabled, blocklist, archivedBlocklist, extensionActive });
    pushToEngine({ extensionActive });
  },

  addAccessEntry: (entry) => {
    const state = get();
    if (state.whitelistMode) {
      if (state.whitelist.includes(entry)) return { ok: false };
      const whitelist = [...state.whitelist, entry];
      const extensionActive = !siteExcluded({ ...state, whitelist }, state.site.url);
      persistAccessLists({ ...state, whitelist });
      set({ whitelist, extensionActive });
      pushToEngine({ extensionActive });
    } else {
      if (state.blocklist.includes(entry)) return { ok: false };
      const blocklist = [...state.blocklist, entry];
      const extensionActive = !siteExcluded({ ...state, blocklist }, state.site.url);
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
      const extensionActive = !siteExcluded({ ...state, whitelist }, state.site.url);
      persistAccessLists({ ...state, whitelist });
      set({ whitelist, extensionActive });
      pushToEngine({ extensionActive });
    } else {
      const blocklist = state.blocklist.filter((e) => e !== entry);
      const extensionActive = !siteExcluded({ ...state, blocklist }, state.site.url);
      persistAccessLists({ ...state, blocklist });
      set({ blocklist, extensionActive });
      pushToEngine({ extensionActive });
    }
  },

  addRememberedEntry: (siteKey) => {
    const state = get();
    if (state.rememberedSettings[siteKey]) return { ok: false };
    const entry: RememberedEntry = { volume: 0, mono: false, muted: false };
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
    };
    set({ rememberedSettings: { ...state.rememberedSettings, [siteKey]: entry } });
    writeRememberedEntry(siteKey, entry);

    // storage.onChanged → the open tab re-resolves (cs.js start()): an edit
    // to an entry that governs THIS page's URL applies live. The Normalize
    // preference is a separate store and is not touched by audio edits.
    if (isUrlRememberedByEntry(state.site.url, siteKey)) {
      get().applySiteSettings(state.site.key);
      const engine = VolumeEngine.getInstance();
      set({ badge: makeBadge(engine.getAudioControlState().volume, get().muted) });
    }
  },

  addSiteDebugEntry: (siteKey) => {
    const state = get();
    if (state.siteDebug[siteKey]) return { ok: false };
    // options.js addDebugSite: a new override row is seeded from the CURRENT
    // global debug defaults, not from an all-off template.
    const siteDebug = { ...state.siteDebug, [siteKey]: normalizeSiteDebug(state.debugDefaults) };
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    // The new entry may govern the current page's URL (ranked match).
    syncDebugToEngine();
    return { ok: true };
  },

  removeSiteDebugEntry: (siteKey) => {
    const state = get();
    const siteDebug = { ...state.siteDebug };
    delete siteDebug[siteKey];
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    // Re-evaluate: the removed entry may have governed this page's URL.
    syncDebugToEngine();
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
    // Renaming re-scopes the override — re-resolve for the current page.
    syncDebugToEngine();
    return { ok: true };
  },

  updateSiteDebugEntry: (siteKey, patch) => {
    const state = get();
    const current = state.siteDebug[siteKey];
    if (!current) return;
    const siteDebug = { ...state.siteDebug, [siteKey]: normalizeSiteDebug({ ...current, ...patch }) };
    persistSiteDebug(siteDebug);
    set({ siteDebug });
    // All four flags take effect live through the effective config
    // (highlight, DRM/CORS bypasses, route override) when the entry
    // governs the current page's URL.
    syncDebugToEngine();
  },

  setDebugDefaults: (patch) => {
    const state = get();
    const debugDefaults = normalizeSiteDebug({ ...state.debugDefaults, ...patch });
    persistDebugDefaults(debugDefaults);
    set({ debugDefaults });
    // Global defaults take effect live unless a per-site override governs
    // the current page (highlight, DRM/CORS bypasses, route override).
    syncDebugToEngine();
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
  };
});
