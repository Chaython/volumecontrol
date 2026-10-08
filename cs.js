const {
    browserApi: browserAPI,
    MAX_DB,
    normalizeDb,
    getGainValue,
    storageGet,
    storageSet,
    runtimeSendMessage,
    domainMatchesSaved,
    isUrlRememberedByEntry,
    isUrlBlockedByEntries,
    purgeLegacyDefaultBlocklist,
    getSiteSettingsKey,
    BRIDGE_VERSION,
    DEFAULT_NORMALIZER_CONFIG,
    normalizeNormalizerConfig,
    BOOST_LIMIT_NOTE
} = globalThis.VolumeControlShared;
const sharedExtractRootDomain = globalThis.VolumeControlShared.extractRootDomain;
const PAGE_BRIDGE_SOURCE = "volume-control-extension";
const PAGE_BRIDGE_TARGET = "volume-control-page-audio";
const PAGE_AUDIO_MANAGED_ATTR = "vcPageAudioManaged";
// Per-document capability token. MAIN-world bridge messages must carry this
// unpredictable token; ordinary page scripts no longer get to spoof setState,
// heartbeat, navigation, or restriction messages just by knowing our strings.
const PAGE_BRIDGE_TOKEN = (() => {
    try {
        const bytes = new Uint32Array(4);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, value => value.toString(16).padStart(8, "0")).join("");
    } catch (e) {
        return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
    }
})();
const PAGE_BRIDGE_RESYNC_MS = 5000;
const PAGE_BRIDGE_HEARTBEAT_MS = 3000;
const BOOST_LIMIT_NOTES = {
    "cross-origin": "Limited by cross-origin media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.",
    "restricted": "Limited by DRM-protected or otherwise restricted media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.",
    "route-failed": "Limited because the page blocked or already owns the audio route. Fallback volume control can still lower volume, but boosting and mono may be unavailable.",
    "fallback": BOOST_LIMIT_NOTE
};
let pageBridgeResyncInterval = null;
let controlProfileReady = false;
let profileControlUrl = "";
let lastResolvedControlUrl = "";
let startGeneration = 0;

const tc = {
  settings: {
    logLevel: 4,
    debugMode: false,
    forceDrmCapture: false,
    forceCorsCapture: false,
    debugRouteMode: "auto",
    normalizerConfig: normalizeNormalizerConfig(DEFAULT_NORMALIZER_CONFIG)
  },
  vars: {
    dB: 0,
    mono: false,
    muted: false,
    normalizerEnabled: false,
    normalizerPeakDb: -Infinity,
    normalizerGainDb: 0,
    isolatedOutputUsesLimiter: null,
    audioCtx: undefined,
    gainNode: undefined,
    inputAnalyserNode: undefined,
    inputAnalyserBuffer: undefined,
    limiterNode: undefined,
    analyserNode: undefined,
    analyserBuffer: undefined,
    normalizerTimer: null,
    isBlocked: false,
    pendingInit: false,
    // Media elements successfully hooked into our AudioContext (source.connect'd).
    mediaElements: new Set(),
    // All known media elements on the page (hooked, fallback, or page-managed).
    // Populated by registerMediaElement and init. Used by applyState to avoid
    // querySelectorAll on every state change.
    knownMediaElements: new Set(),
    audioSuspendPromise: null,
    hasRememberedSettings: false,
    ephemeralActiveElement: null,
    ephemeralSourceKeys: new WeakMap(),
    ephemeralBoundaryPending: new WeakSet()
  }
};

const logTypes = ["ERROR", "WARNING", "INFO", "DEBUG"];
function log(msg, level = 4) {
  if (tc.settings.logLevel < level) return;
  const index = Math.max(0, Math.min(logTypes.length - 1, Number(level) - 2));
  console.log(`[VolumeControl] ${logTypes[index]}: ${msg}`);
}

if (browserAPI) {
    browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return;
        if (msg.command === "frameBoostLimitReport") {
            if (!isTopFrame() || tc.vars.isBlocked) return;
            const frameId = Number(msg.frameId);
            if (!Number.isInteger(frameId) || frameId <= 0) return;
            const reason = reasonSeverity(msg.reason) > 0 ? msg.reason : "";
            const previous = frameLimitReports.get(frameId);
            if (!reason) {
                if (frameLimitReports.delete(frameId)) invalidateBoostLimitCache();
                sendResponse({});
                return;
            }
            frameLimitReports.set(frameId, { reason, ts: Date.now() });
            ensureFrameReportPurge();
            if (!previous || previous.reason !== reason) invalidateBoostLimitCache();
            sendResponse({});
            return;
        }
        if (msg.command === "profileUrlChanged") {
            if (typeof msg.url === "string" && msg.url) profileControlUrl = msg.url;
            start();
            sendResponse({});
            return;
        }
        if (tc.vars.isBlocked) return;
        switch (msg.command) {
            case "checkExclusion":
                sendResponse({ status: "active" });
                break;
            case "setVolume":
                tc.vars.dB = normalizeDbForCurrentMedia(msg.dB);
                applyState();
                sendResponse({ response: getAudioControlState() });
                break;
            case "getVolume":
                sendResponse({ response: getAudioControlState().volume });
                break;
            case "getAudioControlState":
                sendResponse({ response: getAudioControlState() });
                break;
            case "setMono":
                tc.vars.mono = msg.mono;
                applyState();
                sendResponse({});
                break;
            case "setNormalizer":
                if (tc.vars.normalizerEnabled !== Boolean(msg.enabled)) {
                    // A previous song may have accumulated +12 dB auto gain.
                    // Never replay it immediately when normalization resumes.
                    tc.vars.normalizerGainDb = 0;
                    tc.vars.normalizerPeakDb = -Infinity;
                }
                tc.vars.normalizerEnabled = Boolean(msg.enabled);
                lastSyncedPageAudioState = null;
                applyState();
                sendResponse({ response: getAudioControlState() });
                break;
            case "getMeterState":
                sendResponse({
                    response: {
                        normalizerEnabled: Boolean(tc.vars.normalizerEnabled),
                        normalizerAvailable: getNormalizerAvailability().available,
                        normalizerUnavailableReason: getNormalizerAvailability().reason,
                        peakDb: Number.isFinite(tc.vars.normalizerPeakDb) ? tc.vars.normalizerPeakDb : -Infinity,
                        normalizerGainDb: Number.isFinite(tc.vars.normalizerGainDb) ? tc.vars.normalizerGainDb : 0
                    }
                });
                break;
            case "getMono":
                sendResponse({ response: tc.vars.mono });
                break;
            case "setMute":
                tc.vars.muted = Boolean(msg.muted);
                applyState();
                // Build the response without re-running enforceBoostLimit;
                // boost limit is unchanged by a mute toggle, and applyState()
                // already synced the page-audio hook above.
                {
                    const limit = getBoostLimitInfo();
                    sendResponse({
                        response: {
                            volume: Math.min(normalizeDb(tc.vars.dB), limit.maxDb),
                            mono: tc.vars.mono,
                            monoAvailable: getMonoAvailability(limit).available,
                            monoUnavailableReason: getMonoAvailability(limit).reason,
                            muted: Boolean(tc.vars.muted),
                            boostLimited: limit.boostLimited,
                            maxDb: limit.maxDb,
                            limitationReason: limit.reason,
                            limitation: limit.note
                        }
                    });
                }
                break;
            case "getMute":
                sendResponse({ response: tc.vars.muted });
                break;
        }
        return true;
    });
}

function needsAudioRoute() {
    if (tc.vars.isBlocked) return false;
    if (tc.settings.debugRouteMode === "native") return false;
    if (tc.settings.debugRouteMode === "webaudio") return true;
    return tc.vars.muted || tc.vars.mono || tc.vars.normalizerEnabled || getGainValue(tc.vars.dB) > 1;
}

function getMediaSourceUrl(element) {
    const directSrc = element.currentSrc || element.src;
    if (directSrc) return directSrc;

    try {
        const source = element.querySelector && element.querySelector("source[src]");
        return source ? source.src : "";
    } catch (e) {
        return "";
    }
}

function isLikelyCrossOriginMedia(element) {
    if (tc.settings.forceCorsCapture) return false;
    const src = getMediaSourceUrl(element);
    if (!src || element.crossOrigin) return false;

    try {
        const url = new URL(src, document.baseURI);
        const pageOrigin = (typeof globalThis.origin === "string" && globalThis.origin) || window.location.origin;
        if (!pageOrigin || pageOrigin === "null") return false;
        return url.protocol.indexOf("http") === 0 && url.origin !== pageOrigin;
    } catch (e) {
        return false;
    }
}

function pageUsesEme() {
    try {
        return Boolean(document.documentElement && document.documentElement.dataset.vcPageUsesEme === "true");
    } catch (e) {
        return false;
    }
}

// Engine-aware EME policy — must stay in sync with the hook's twin.
// Chromium-family browsers silence MediaElementAudioSourceNode output for
// encrypted content (routing DRM there = permanent silence), so DRM signals
// block routing and clamp the verdict. Gecko (Firefox) explicitly supports
// capturing EME media audio through WebAudio (Mozilla bug 1331763, Firefox
// 55+: "creating a MediaElementSource on a media element should always
// succeed"; only *video* capture is blocked), so on Firefox DRM media is
// fully boostable. Cross-origin taint silences routed audio in every engine
// (spec) and stays enforced on both.
//
// Detection order (fixed in v6.13): a UA containing "Firefox/" proves Gecko
// FIRST — navigator.userAgentData is only consulted afterwards. The old
// order treated any userAgentData shim as proof of Chromium, which would
// misclassify a future Firefox that grows one.
function isGeckoRuntime() {
    try {
        const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
        if (ua.indexOf("Firefox/") !== -1) return true;
        if (typeof navigator !== "undefined" && navigator.userAgentData) return false;
        return false;
    } catch (e) {
        return false;
    }
}
const EME_AUDIO_SILENCED_WHEN_ROUTED = !isGeckoRuntime();

// Per-element DRM evidence (sticky): the `encrypted` event fired, or the
// site attached MediaKeys. Shared with the hook's world through dataset
// flags + the standard element.mediaKeys property.
function elementDrmEvidence(element) {
    if (!element) return false;
    try {
        if (element.dataset && element.dataset.vcRestrictedMedia === "true") return true;
        if (element.mediaKeys) return true;
        if (element.webkitKeys) return true;
    } catch (e) {
        return false;
    }
    return false;
}

// Gecko keys-attached marker: on Gecko, DRM media becomes routable only
// AFTER setMediaKeys() succeeds (Gecko throws NotSupportedError from
// setMediaKeys when the element is already audio-captured — routing first
// would break the site's player). The hook writes this dataset flag when
// its setMediaKeys patch sees the native call succeed.
function elementEmeKeysAttached(element) {
    if (!element) return false;
    try {
        if (element.mediaKeys) return true;
        if (element.dataset && element.dataset.vcEmeKeysAttached === "true") return true;
    } catch (e) {
        return false;
    }
    return false;
}

// Pending EME suspect: the page was granted EME access (probe) and the
// element plays a blob: (MSE) source without per-element DRM evidence.
// Routing is refused until DECRYPTION PROOF (v6.14): the element's
// currentTime actually advancing. EME content cannot decode without
// MediaKeys attached, and every attachment path is visible (the hook's
// MAIN-world setMediaKeys patches, element.mediaKeys/webkitKeys, the
// 'encrypted' event) — so progress + zero evidence means clear media
// (Plex, issue #70). The hook's createMediaKeys patch bumps a
// documentElement vcEmeResetSeq counter (shared DOM) when keys become
// imminent; the mirror proof recorded here is invalidated on a seq change.
// The verdict itself stays evidence-only (see isProbablyProtectedMedia).
const EME_PENDING_MIN_PROGRESS_S = 0.01;
const emePending = new WeakMap(); // element -> { progress, lastTime, seq }

function isPendingEmeSuspect(element) {
    // Probe-level gate: a page granted EME access may attach keys to this
    // blob: element at any moment; refuse routing until decryption proof
    // or DRM evidence arrives (see the hook's twin — the verdict itself
    // stays evidence-only).
    if (!pageUsesEme()) return false;
    const src = getMediaSourceUrl(element);
    return Boolean(src) && src.indexOf("blob:") === 0;
}

function emeResetSeq() {
    try {
        const v = document.documentElement && document.documentElement.dataset.vcEmeResetSeq;
        return Number(v) || 0;
    } catch (e) {
        return 0;
    }
}

function resetEmePending(element) {
    emePending.delete(element);
}

function emePendingCleared(element) {
    // Decryption-proof gate, mirroring the hook's emePendingCleared.
    // Observes currentTime on every evaluation; a positive delta (while
    // not seeking) with zero DRM evidence proves the element is decoding
    // clear media. The seq check invalidates the recorded proof when the
    // hook reports imminent key attachment (createMediaKeys) or the
    // element's source changed.
    let rec = emePending.get(element);
    const seq = emeResetSeq();
    if (!rec || rec.seq !== seq) {
        rec = { progress: false, lastTime: undefined, seq };
        emePending.set(element, rec);
    }
    if (rec.progress) return true;
    let now = 0;
    let seeking = false;
    try {
        now = Number(element.currentTime);
        if (typeof element.seeking === "boolean") seeking = element.seeking;
    } catch (e) {
        return false;
    }
    if (!Number.isFinite(now)) return false;
    const last = rec.lastTime;
    rec.lastTime = now;
    if (last !== undefined && !seeking && now > last + EME_PENDING_MIN_PROGRESS_S) {
        rec.progress = true;
        return true;
    }
    return false;
}

// VERDICT gate (the popup note + slider clamp): "restricted" requires
// per-element DRM evidence AND an engine that silences routed EME audio.
// Page-level EME *probes* and the pending window are ROUTING gates (see
// shouldRefuseMediaRouting), not verdict restrictions — Plex probes DRM
// support at startup while playing clear direct-play content, which must
// not produce a restriction note (issue #70). On Gecko, DRM is fully
// boostable (bug 1331763), so the verdict never restricts.
function isProbablyProtectedMedia(element) {
    if (!element || tc.settings.forceDrmCapture || !EME_AUDIO_SILENCED_WHEN_ROUTED) return false;
    return elementDrmEvidence(element);
}

// ROUTING gate: decides whether this element must NOT be routed through
// WebAudio right now. Mirrors the hook's isLikelyDrmMedia.
function shouldRefuseMediaRouting(element) {
    if (!element || tc.settings.forceDrmCapture) return false;
    if (EME_AUDIO_SILENCED_WHEN_ROUTED) {
        if (elementDrmEvidence(element)) return true;
        if (!isPendingEmeSuspect(element)) return false;
        return !emePendingCleared(element);
    }
    // Gecko: EME audio flows through WebAudio, but only route once keys are
    // attached — capturing first makes the site's setMediaKeys() throw.
    if (elementEmeKeysAttached(element)) return false;
    if (elementDrmEvidence(element)) return true;
    if (!isPendingEmeSuspect(element)) return false;
    return !emePendingCleared(element);
}

function isPageAudioManaged(element) {
    try {
        return Boolean(element && element.dataset && element.dataset[PAGE_AUDIO_MANAGED_ATTR] === "true");
    } catch (e) {
        return false;
    }
}

// The page-audio hook (MAIN world) tracks every media element it claims —
// including ones this content script can never see with
// document.querySelectorAll: detached players (treblo.com and suno.com
// create <audio> via createElement/new Audio and never append it to the DOM)
// and elements living inside shadow DOM. The hook publishes an aggregate
// restriction verdict on the documentElement so this world's boost-limit
// logic can include them. Values: "restricted" (DRM) or "cross-origin".
function getHookPageRestriction() {
    try {
        const value = document.documentElement && document.documentElement.dataset.vcPageMediaRestriction;
        if (value === "restricted" || value === "cross-origin") return value;
    } catch (e) {}
    return "";
}

// Severity ranking used when merging restriction verdicts from several
// sources (document scan, hook aggregate, iframe reports). DRM restriction
// outranks everything: routing such media is a one-way trip to silence.
function reasonSeverity(reason) {
    if (reason === "restricted") return 3;
    if (reason === "cross-origin" || reason === "route-failed") return 2;
    return reason ? 1 : 0;
}

function makeBoostLimitedResult(reason) {
    return {
        boostLimited: true,
        maxDb: 0,
        reason,
        note: BOOST_LIMIT_NOTES[reason] || BOOST_LIMIT_NOTES.fallback
    };
}

// Final verdict-layer debug bypass. Routing guards already honor these
// settings, but restriction information can also arrive from stale fallback
// flags, the MAIN-world aggregate, or child-frame reports. Filter every
// source through one helper so the popup/slider cannot remain clamped after
// the matching dangerous debug override has been enabled.
function isBoostLimitReasonBypassed(reason) {
    if (!reason) return false;
    if (reason === "restricted" && tc.settings.forceDrmCapture) return true;
    if (reason === "cross-origin" && tc.settings.forceCorsCapture) return true;
    return false;
}

function getBoostLimitReason(element) {
    if (!element) return "";

    // DRM status must never be masked by the hooking state: an element we
    // hooked before its DRM flags appeared is still restricted (and, in
    // enforcing browsers, already silent). Hiding that from the user is worse
    // than admitting boost is unavailable. Check protection FIRST.
    if (isProbablyProtectedMedia(element)) return "restricted";

    if (element.dataset.vcHooked === "true") return "";

    const crossOrigin = isLikelyCrossOriginMedia(element);
    if (isPageAudioManaged(element)) return crossOrigin ? "cross-origin" : "";

    const fallbackReason = element.dataset.vcFallbackReason;
    if (fallbackReason && !isBoostLimitReasonBypassed(fallbackReason)) return fallbackReason;

    if (crossOrigin && !isBoostLimitReasonBypassed("cross-origin")) return "cross-origin";

    return "";
}

// Boost limit cache: avoid running querySelectorAll on every state change.
// Invalidated by a MutationObserver when audio/video elements are added/removed,
// and by a TTL to catch async state changes (e.g., mediaKeys being set).
let boostLimitCache = null;
let boostLimitCacheTime = 0;
let boostLimitObserver = null;
let knownMediaSweepInterval = null;
const BOOST_LIMIT_CACHE_TTL_MS = 1000;
const KNOWN_MEDIA_SWEEP_MS = 30000;

function invalidateBoostLimitCache() {
    boostLimitCache = null;
    scheduleFrameBoostLimitReport();
}

function getBoostLimitInfo() {
    if (tc.vars.isBlocked) return { boostLimited: false, maxDb: MAX_DB, reason: "", note: "" };

    // Return cached result if still fresh.
    const now = Date.now();
    if (boostLimitCache && now - boostLimitCacheTime < BOOST_LIMIT_CACHE_TTL_MS) {
        return boostLimitCache;
    }

    let result = { boostLimited: false, maxDb: MAX_DB, reason: "", note: "" };

    try {
        // Only check currently-playing elements. A paused or src-less element
        // shouldn't prevent boost on other elements that are actually playing.
        // If nothing is playing, don't restrict — the user might be about to
        // play something, and we don't want to lock the slider based on stale state.
        for (const el of document.querySelectorAll('audio, video')) {
            if (!isMediaPlaying(el) && !el.src && !el.currentSrc) continue;
            const reason = getBoostLimitReason(el);
            if (reason) {
                result = makeBoostLimitedResult(reason);
                break;
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`boost limit check failed: ${e.message}`, 3);
    }

    // Merge the hook's aggregate restriction. It covers media this scan can
    // never see: detached players (never appended to the DOM) and shadow-DOM
    // elements. Without this, sites like treblo.com silently cap boost at
    // native volume (their cross-origin audio cannot be routed through
    // WebAudio) while the popup advertises a full +32 dB range.
    const hookRestriction = getHookPageRestriction();
    const effectiveHookRestriction = isBoostLimitReasonBypassed(hookRestriction)
        ? ""
        : hookRestriction;
    if (reasonSeverity(effectiveHookRestriction) > reasonSeverity(result.reason)) {
        result = makeBoostLimitedResult(effectiveHookRestriction);
    }

    // Merge verdicts reported by embedded iframes. Their media elements live
    // in a different document; only their own content script instance can
    // see them, and they report their verdict here (the top frame) so the
    // popup — which queries only the top frame — aggregates the whole tab.
    const frameLimit = getAggregatedFrameLimit();
    const rawFrameReason = frameLimit ? frameLimit.reason : "";
    const effectiveFrameReason = isBoostLimitReasonBypassed(rawFrameReason)
        ? ""
        : rawFrameReason;
    if (effectiveFrameReason && reasonSeverity(effectiveFrameReason) > reasonSeverity(result.reason)) {
        result = makeBoostLimitedResult(effectiveFrameReason);
    }

    boostLimitCache = result;
    boostLimitCacheTime = now;
    return result;
}

// ----- Cross-frame boost-limit aggregation --------------------------------
// Child frames report through extension messaging instead of page
// window.postMessage. Page scripts therefore cannot forge a DRM/CORS report
// and clamp the whole tab. Reports expire so removed frames relax naturally.
const FRAME_REPORT_TTL_MS = 15000;
const FRAME_REPORT_REFRESH_MS = 5000;
const frameLimitReports = new Map(); // frameId -> { reason, ts }
let frameReportInterval = null;
let frameReportPurgeInterval = null;
let frameReportScheduled = false;

function isTopFrame() {
    try {
        return window.top === window;
    } catch (e) {
        return false;
    }
}

function getAggregatedFrameLimit() {
    if (!isTopFrame() || frameLimitReports.size === 0) return null;
    const now = Date.now();
    let best = null;
    for (const [frameId, entry] of Array.from(frameLimitReports)) {
        if (!Number.isInteger(frameId) || now - entry.ts > FRAME_REPORT_TTL_MS) {
            frameLimitReports.delete(frameId);
            continue;
        }
        if (!best || reasonSeverity(entry.reason) > reasonSeverity(best.reason)) best = entry;
    }
    if (frameLimitReports.size === 0 && frameReportPurgeInterval !== null) {
        clearInterval(frameReportPurgeInterval);
        frameReportPurgeInterval = null;
    }
    return best;
}

function ensureFrameReportPurge() {
    if (!isTopFrame() || frameReportPurgeInterval !== null || frameLimitReports.size === 0) return;
    frameReportPurgeInterval = setInterval(() => getAggregatedFrameLimit(), FRAME_REPORT_REFRESH_MS);
}

function ensureFrameReportRefresh() {
    if (isTopFrame() || frameReportInterval !== null) return;
    frameReportInterval = setInterval(() => reportFrameBoostLimit(true), FRAME_REPORT_REFRESH_MS);
}

let lastPostedFrameReport = { reason: null, at: 0 };
function reportFrameBoostLimit(force = false) {
    if (isTopFrame() || !controlProfileReady || tc.vars.isBlocked) return;

    const limit = getBoostLimitInfo();
    const reason = limit.reason || "";
    const now = Date.now();

    // An unrestricted child has nothing to contribute until it previously
    // reported a restriction. Avoid waking the service worker every five
    // seconds for the common case of harmless iframes.
    if (!reason && lastPostedFrameReport.reason === null && !force) return;
    if (!reason && lastPostedFrameReport.reason === "") return;
    if (!force && reason === lastPostedFrameReport.reason &&
        now - lastPostedFrameReport.at < FRAME_REPORT_REFRESH_MS) return;

    lastPostedFrameReport = { reason, at: now };
    runtimeSendMessage({
        command: "frameBoostLimitReport",
        reason
    }).catch(() => {});

    if (reason) {
        ensureFrameReportRefresh();
    } else if (frameReportInterval !== null) {
        clearInterval(frameReportInterval);
        frameReportInterval = null;
    }
}

function scheduleFrameBoostLimitReport() {
    if (isTopFrame() || !controlProfileReady || tc.vars.isBlocked || frameReportScheduled) return;
    frameReportScheduled = true;
    queueMicrotask(() => {
        frameReportScheduled = false;
        reportFrameBoostLimit();
    });
}

function startFrameReporting() {
    if (isTopFrame()) return;
    // One initial report (including "unrestricted") clears a stale report for
    // the same frameId after iframe navigation. Only real restrictions get a
    // periodic refresh afterwards.
    reportFrameBoostLimit(true);
}

function stopFrameReporting() {
    if (frameReportInterval !== null) {
        clearInterval(frameReportInterval);
        frameReportInterval = null;
    }
    if (frameReportPurgeInterval !== null) {
        clearInterval(frameReportPurgeInterval);
        frameReportPurgeInterval = null;
    }
    lastPostedFrameReport = { reason: null, at: 0 };
    frameReportScheduled = false;
    if (isTopFrame()) frameLimitReports.clear();
}

function sweepKnownMediaElements() {
    for (const element of Array.from(tc.vars.knownMediaElements || [])) {
        if (element && element.isConnected) continue;
        if (element && isMediaPlaying(element) && isAudibleMediaElement(element)) continue;
        if (element && element.dataset && element.dataset.vcFallback === 'true') {
            clearFallbackVolume(element);
        }
        tc.vars.knownMediaElements.delete(element);
        if (tc.vars.mediaElements) tc.vars.mediaElements.delete(element);
        resetEmePending(element);
    }
    suspendAudioContextIfIdle();
}

function setupBoostLimitObserver() {
    // Invalidate the boost limit cache when audio/video elements are added or
    // removed from the DOM, so the next call to getBoostLimitInfo recomputes.
    if (boostLimitObserver || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO' ||
                    (node.querySelectorAll && node.querySelector('audio, video'))) {
                    invalidateBoostLimitCache();
                    return;
                }
            }
            for (const node of mutation.removedNodes) {
                if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO' ||
                    (node.querySelectorAll && node.querySelector('audio, video'))) {
                    invalidateBoostLimitCache();
                    return;
                }
            }
        }
    });
    boostLimitObserver = observer;
    if (!knownMediaSweepInterval) {
        knownMediaSweepInterval = setInterval(sweepKnownMediaElements, KNOWN_MEDIA_SWEEP_MS);
    }
    const startObserving = () => {
        if (boostLimitObserver !== observer) return;
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
    };
    if (document.documentElement) {
        startObserving();
    } else {
        document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }
}

function stopBoostLimitObserver() {
    if (boostLimitObserver) {
        boostLimitObserver.disconnect();
        boostLimitObserver = null;
    }
    if (knownMediaSweepInterval) {
        clearInterval(knownMediaSweepInterval);
        knownMediaSweepInterval = null;
    }
    sweepKnownMediaElements();
}

function normalizeDbForCurrentMedia(value) {
    const normalized = normalizeDb(value);
    const limit = getBoostLimitInfo();
    return Math.min(normalized, limit.maxDb);
}

function getMonoAvailability(limit = getBoostLimitInfo()) {
    if (tc.settings.debugRouteMode === "native") {
        return { available: false, reason: "native-route" };
    }
    if (limit && limit.boostLimited) {
        return { available: false, reason: limit.reason || "fallback" };
    }
    return { available: true, reason: "" };
}

function getNormalizerAvailability(limit = getBoostLimitInfo()) {
    if (tc.settings.debugRouteMode === "native") {
        return { available: false, reason: "native-route" };
    }
    if (limit && limit.boostLimited) {
        return { available: false, reason: limit.reason || "fallback" };
    }
    return { available: true, reason: "" };
}

function getAudioControlState() {
    enforceBoostLimit({ sync: true });
    const limit = getBoostLimitInfo();
    const monoAvailability = getMonoAvailability(limit);
    const normalizerAvailability = getNormalizerAvailability(limit);
    return {
        volume: Math.min(normalizeDb(tc.vars.dB), limit.maxDb),
        mono: tc.vars.mono,
        monoAvailable: monoAvailability.available,
        monoUnavailableReason: monoAvailability.reason,
        muted: Boolean(tc.vars.muted),
        normalizerEnabled: Boolean(tc.vars.normalizerEnabled),
        normalizerAvailable: normalizerAvailability.available,
        normalizerUnavailableReason: normalizerAvailability.reason,
        peakDb: Number.isFinite(tc.vars.normalizerPeakDb) ? tc.vars.normalizerPeakDb : -Infinity,
        normalizerGainDb: Number.isFinite(tc.vars.normalizerGainDb) ? tc.vars.normalizerGainDb : 0,
        boostLimited: limit.boostLimited,
        maxDb: limit.maxDb,
        limitationReason: limit.reason,
        limitation: limit.note
    };
}

function enforceBoostLimit(options = {}) {
    const clamped = normalizeDbForCurrentMedia(tc.vars.dB);
    if (clamped === tc.vars.dB) return false;

    tc.vars.dB = clamped;
    if (options.sync) syncPageAudioHook();
    return true;
}

function applyFallbackVolume(element, reason = "") {
    const gain = tc.vars.muted ? 0 : getGainValue(tc.vars.dB);
    const limitReason = isProbablyProtectedMedia(element) ? "restricted" : reason;

    try {
        const currentVolume = (typeof element.volume === 'number') ? element.volume : 1;
        if (element.dataset.vcFallback !== 'true') {
            // First fallback write must preserve the page's real native base.
            // A requested positive boost cannot be represented with
            // HTMLMediaElement.volume, so pretending the base was 1 caused a
            // 20% player, for example, to jump toward 100% when routing failed.
            element.__vc_originalVolume = currentVolume;
        } else {
            // Already in fallback mode. If the page changed element.volume out
            // from under us (e.g., the page's own volume slider), update
            // __vc_originalVolume to reflect the page's intent.
            const origBase = element.__vc_originalVolume !== undefined
                ? element.__vc_originalVolume
                : currentVolume;
            const expectedScaled = Math.min(1, Math.max(0, origBase * Math.min(gain, 1)));
            if (Math.abs(currentVolume - expectedScaled) > 0.05) {
                element.__vc_originalVolume = currentVolume;
            }
        }
        element.dataset.vcFallback = 'true';
    } catch (e) {}

    const previousFallbackReason = element.dataset.vcFallbackReason || "";
    if (limitReason) element.dataset.vcFallbackReason = limitReason;
    else delete element.dataset.vcFallbackReason;
    if (previousFallbackReason !== (element.dataset.vcFallbackReason || "")) {
        invalidateBoostLimitCache();
    }

    try {
        // Native mute: when the extension is muted, set element.muted = true
        // so the browser can release the OS audio device handle (important for
        // Bluetooth headphones that stay active while a media element plays).
        // We still restore __vc_originalVolume below so unmuting is clean.
        if (tc.vars.muted) {
            // Only claim ownership when we actually change the native mute.
            // A site-muted element must stay muted when Volume Control unmutes.
            if (element.dataset.vcNativeMuted !== 'true' && !element.muted) {
                element.muted = true;
                element.dataset.vcNativeMuted = 'true';
            }
            if (tc.settings.debugMode) element.style.border = "2px dashed #ffa500";
            return;
        }
        // Unmute ONLY a native mute WE applied. Blanket-unmuting any muted
        // element overrode the SITE's own mute (muted autoplay ads, the site's
        // mute button): our fallback loop has no isAudible gate, so with
        // attenuation active a site-muted element was force-unmuted.
        if (element.dataset.vcNativeMuted === 'true') {
            element.muted = false;
            delete element.dataset.vcNativeMuted;
        }

        const baseVolume = element.__vc_originalVolume !== undefined
            ? element.__vc_originalVolume
            : (gain > 1 ? 1 : element.volume);
        const newVol = Math.min(1, Math.max(0, baseVolume * Math.min(gain, 1)));
        element.volume = newVol;
        if (tc.settings.debugMode) element.style.border = "2px dashed #ffa500";
    } catch (e) {
        log(`Fallback volume set failed: ${e && e.message}`, 2);
    }
}

function clearFallbackVolume(element) {
    if (!element || element.dataset.vcFallback !== 'true') return;

    try {
        if (element.__vc_originalVolume !== undefined) {
            element.volume = element.__vc_originalVolume;
        }
        // Clear any native mute WE applied while in fallback mode (only ours —
        // never the site's own muted element; see applyFallbackVolume).
        if (element.dataset.vcNativeMuted === 'true') {
            element.muted = false;
            delete element.dataset.vcNativeMuted;
        }
    } catch (e) {}

    delete element.__vc_originalVolume;
    delete element.dataset.vcFallback;
    delete element.dataset.vcFallbackReason;
    delete element.dataset.vcNativeMuted;
}

// Track the last state sent to the page-audio hook so we can skip redundant
// postMessage calls. This prevents the 5-second resync interval and rapid
// slider movements from triggering unnecessary applyStateToGraphs() /
// applyStateToMediaElements() cycles on the page, which can cause audio dropouts.
let lastSyncedPageAudioState = null;
let pageHookActivated = false;

function syncPageAudioHook() {
    const currentState = {
        enabled: !tc.vars.isBlocked,
        dB: tc.vars.isBlocked ? 0 : normalizeDb(tc.vars.dB),
        mono: !tc.vars.isBlocked && tc.vars.mono,
        muted: !tc.vars.isBlocked && Boolean(tc.vars.muted),
        normalizerEnabled: !tc.vars.isBlocked && Boolean(tc.vars.normalizerEnabled),
        normalizerConfig: tc.settings.normalizerConfig,
        debugMode: tc.settings.debugMode,
        forceDrmCapture: tc.settings.forceDrmCapture,
        forceCorsCapture: tc.settings.forceCorsCapture,
        debugRouteMode: tc.settings.debugRouteMode
    };

    // Skip if nothing changed since the last sync.
    if (lastSyncedPageAudioState &&
        lastSyncedPageAudioState.enabled === currentState.enabled &&
        lastSyncedPageAudioState.dB === currentState.dB &&
        lastSyncedPageAudioState.mono === currentState.mono &&
        lastSyncedPageAudioState.muted === currentState.muted &&
        lastSyncedPageAudioState.normalizerEnabled === currentState.normalizerEnabled &&
        JSON.stringify(lastSyncedPageAudioState.normalizerConfig) === JSON.stringify(currentState.normalizerConfig) &&
        lastSyncedPageAudioState.debugMode === currentState.debugMode &&
        lastSyncedPageAudioState.forceDrmCapture === currentState.forceDrmCapture &&
        lastSyncedPageAudioState.forceCorsCapture === currentState.forceCorsCapture &&
        lastSyncedPageAudioState.debugRouteMode === currentState.debugRouteMode) {
        return;
    }
    // The MAIN-world hook installs only a transparent AudioNode interceptor at
    // document_start. Always send the resolved state, including "disabled", so
    // an excluded page can immediately restore its native prototypes.
    lastSyncedPageAudioState = currentState;

    try {
        window.postMessage({
            source: PAGE_BRIDGE_SOURCE,
            target: PAGE_BRIDGE_TARGET,
            token: PAGE_BRIDGE_TOKEN,
            command: "setState",
            version: BRIDGE_VERSION,
            ...currentState
        }, "*");
        pageHookActivated = true;
    } catch (e) {
        if (tc.settings.debugMode) log(`page audio sync failed: ${e.message}`, 3);
    }
}

function sendPageAudioHeartbeat() {
    // Heartbeat so the page-audio hook knows the content script is still alive.
    // If this stops (extension disabled/updated), the hook will restore native
    // audio behavior.
    try {
        window.postMessage({
            source: PAGE_BRIDGE_SOURCE,
            target: PAGE_BRIDGE_TARGET,
            token: PAGE_BRIDGE_TOKEN,
            command: "heartbeat",
            version: BRIDGE_VERSION
        }, "*");
    } catch (e) {
        // ignore
    }
}

function routeIsolatedOutput() {
    const { audioCtx, gainNode, limiterNode, analyserNode } = tc.vars;
    if (!audioCtx || !gainNode || !limiterNode || !analyserNode) return;
    const useLimiter = !tc.vars.isBlocked &&
        (tc.vars.normalizerEnabled || (!tc.vars.muted && tc.vars.dB > 0));
    if (tc.vars.isolatedOutputUsesLimiter === useLimiter) return;

    if (!useLimiter) {
        // Disabling Normalize or positive boost can remove the compressor.
        // Clamp the active (possibly boosted) AudioParam BEFORE connecting
        // directly to the destination; the later 15ms UI ramp is too late.
        try {
            const param = gainNode.gain;
            const now = audioCtx.currentTime;
            const safeGain = tc.vars.isBlocked ? 1 :
                (tc.vars.muted ? 0 : Math.max(0, Math.min(1, getGainValue(tc.vars.dB))));
            param.cancelScheduledValues(now);
            param.setValueAtTime(safeGain, now);
        } catch (e) {
            if (tc.settings.debugMode) log(`isolated direct route safety clamp failed: ${e && e.message}`, 3);
            // Keep existing limited audio connected rather than allowing an
            // uncontrolled gain burst through an unprotected direct path.
            return;
        }
    }

    // Disconnect only outgoing edges: media element source -> gain remains
    // intact, even while a player is actively playing.
    for (const node of [gainNode, limiterNode, analyserNode]) {
        try { node.disconnect(); } catch (e) {}
    }
    try {
        if (useLimiter) {
            configureIsolatedLimiter();
            gainNode.connect(limiterNode);
            limiterNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
        } else {
            gainNode.connect(audioCtx.destination);
        }
        tc.vars.isolatedOutputUsesLimiter = useLimiter;
    } catch (e) {
        // A partial rebuild must not leave captured media permanently silent.
        // Discard partial edges and attempt a direct, gain-limited fallback.
        tc.vars.isolatedOutputUsesLimiter = null;
        tc.vars.normalizerGainDb = 0;
        tc.vars.normalizerPeakDb = -Infinity;
        for (const node of [gainNode, limiterNode, analyserNode]) {
            try { node.disconnect(); } catch (_) {}
        }
        try {
            // Clamp the existing AudioParam BEFORE reconnecting directly.
            // A 15ms ramp in applyState() is too late: a previously boosted
            // gain could otherwise play briefly without limiter protection.
            const gainParam = gainNode.gain;
            const now = audioCtx.currentTime;
            gainParam.cancelScheduledValues(now);
            gainParam.setValueAtTime(
                Math.max(0, Math.min(1, gainParam.value)), now
            );
            gainNode.connect(audioCtx.destination);
            tc.vars.isolatedOutputUsesLimiter = false;
        } catch (fallbackError) {
            if (tc.settings.debugMode) log(`isolated output fallback failed: ${fallbackError && fallbackError.message}`, 3);
        }
        if (tc.settings.debugMode) log(`isolated output route failed: ${e && e.message}`, 3);
    }
}

function applyState() {
    enforceBoostLimit();
    syncPageAudioHook();

    const audioCtx = tc.vars.audioCtx;
    const gainNode = tc.vars.gainNode;
    const isEnabled = !tc.vars.isBlocked;
    const autoGain = tc.vars.normalizerEnabled
        ? Math.pow(10, (Number(tc.vars.normalizerGainDb) || 0) / 20)
        : 1;
    if (gainNode && audioCtx) {
        ensureIsolatedNormalizerTimer();
        // The limiter may remain routed during manual boost while Normalize
        // is off. Changes from Options must still update its parameters.
        if (tc.vars.isolatedOutputUsesLimiter) configureIsolatedLimiter();
        routeIsolatedOutput();
        // If the limiter failed and audio was restored directly, do not
        // expose automatic gain or positive manual boost without protection.
        const wantsLimiter = isEnabled &&
            (tc.vars.normalizerEnabled || (!tc.vars.muted && tc.vars.dB > 0));
        const unprotected = wantsLimiter && tc.vars.isolatedOutputUsesLimiter !== true;
        const manualGain = unprotected ? Math.min(1, getGainValue(tc.vars.dB)) : getGainValue(tc.vars.dB);
        const targetGain = isEnabled ? (tc.vars.muted ? 0 : manualGain * (unprotected ? 1 : autoGain)) : 1;
        const now = audioCtx.currentTime;

        if (audioCtx.state === 'running') {
            try {
                // Smooth ramp to avoid audible clicks/spikes when the user drags
                // the slider rapidly. 15ms is short enough to feel responsive but
                // long enough to prevent zipper noise.
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(gainNode.gain.value, now);
                gainNode.gain.linearRampToValueAtTime(targetGain, now + 0.015);
            } catch (e) {
                if (tc.settings.debugMode) log(`applyState schedule failed: ${e.message}`, 2);
            }
        } else {
            gainNode.gain.value = targetGain;
        }

        if (isEnabled && tc.vars.mono) {
            gainNode.channelCountMode = "explicit";
            gainNode.channelCount = 1;
        } else {
            gainNode.channelCountMode = "max";
            gainNode.channelCount = 2;
        }
    }

    // Also update media elements that are using direct volume scaling.
    // Iterate knownMediaElements instead of querySelectorAll to avoid O(n) DOM
    // scans on every state change. Clean up disconnected elements as we go.
    try {
        const routeNeeded = needsAudioRoute();
        const gain = isEnabled ? (tc.vars.muted ? 0 : getGainValue(tc.vars.dB)) : 1;
        for (const el of Array.from(tc.vars.knownMediaElements || [])) {
            // Clean up elements that have been removed from the DOM -- but
            // keep tracking detached elements that are still playing. Sites
            // detach their <video> during player rebuilds while playback
            // continues; dropping those would freeze any fallback volume we
            // applied and stop later state changes from reaching them.
            if (!el.isConnected) {
                if (!(isMediaPlaying(el) && isAudibleMediaElement(el))) {
                    tc.vars.knownMediaElements.delete(el);
                }
                continue;
            }
            if (isPageAudioManaged(el)) {
                if (el.dataset.vcFallback === 'true') clearFallbackVolume(el);
                continue;
            }

            if (el.dataset.vcHooked === "true") {
                if (routeNeeded && isMediaPlaying(el) && tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
                    resumeAudioContext();
                }
                continue;
            }

            if (isEnabled && tc.vars.muted && !routeNeeded) {
                // Muted but no WebAudio route (e.g. fallback-only media):
                // apply native element.muted so the OS can release audio.
                applyFallbackVolume(el);
            } else if (isEnabled && !routeNeeded && gain < 1) {
                applyFallbackVolume(el);
            } else if (el.dataset.vcFallback === 'true') {
                if (gain === 1 && !tc.vars.mono && !tc.vars.muted) clearFallbackVolume(el);
                else applyFallbackVolume(el);
            }

            if (routeNeeded && isMediaPlaying(el) && isAudibleMediaElement(el)) {
                connectOutput(el);
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`applyState fallback loop failed: ${e.message}`, 3);
    }

    // Always schedule a suspend check, even when boost or mono is active.
    // Previously this was gated on !needsAudioRoute(), which meant the context
    // was never suspended while boost/mono was on — causing Bluetooth devices
    // to stay active after playback paused.
    setTimeout(suspendAudioContextIfIdle, 250);
}

function configureIsolatedLimiter() {
    const limiter = tc.vars.limiterNode;
    if (!limiter) return;
    const config = normalizeNormalizerConfig(tc.settings.normalizerConfig);
    try {
        limiter.threshold.value = config.ceilingDb;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.12;
    } catch (e) {
        if (tc.settings.debugMode) log(`isolated limiter configure failed: ${e && e.message}`, 3);
    }
}

function computeSafeNormalizerGainDb(previousDb, sourceRmsDb, sourcePeakDb, config) {
        // Never amplify the noise floor or reuse stale gain if the analyser
        // reports silence/errors. This is intentionally independent of the
        // volume slider so users retain control of the final output level.
        if (!Number.isFinite(sourceRmsDb) || sourceRmsDb <= -55 ||
            !Number.isFinite(sourcePeakDb)) return 0;

        const previous = Number.isFinite(previousDb) ? previousDb : 0;
        // Leave a 2 dB sample-peak margin below the requested compressor
        // threshold. This reduces sudden overshoot; it is NOT a hard or
        // inter-sample true-peak guarantee (WebAudio compressors aren't).
        const rmsTarget = config.targetDb - sourceRmsDb;
        const peakHeadroom = config.ceilingDb - 2 - sourcePeakDb;
        const desired = Math.max(-32, Math.min(config.maxBoostDb, rmsTarget, peakHeadroom));

        // Loudness jumps must shed existing boost immediately. Raising gain
        // is deliberately much slower to avoid pumping from brief quiet gaps.
        if (desired <= previous) return desired;
        const alpha = 1 - Math.exp(-100 / Math.max(100, config.responseMs));
        return previous + (desired - previous) * alpha;
    }

function sampleIsolatedNormalizer() {
    if (!tc.vars.normalizerEnabled) return;
    const ctx = tc.vars.audioCtx;
    const analyser = tc.vars.analyserNode;
    const sourceAnalyser = tc.vars.inputAnalyserNode;
    const gainNode = tc.vars.gainNode;
    if (!ctx || !analyser || !sourceAnalyser || !gainNode || ctx.state !== "running") return;

    if (!tc.vars.analyserBuffer || tc.vars.analyserBuffer.length !== analyser.fftSize) {
        tc.vars.analyserBuffer = new Float32Array(analyser.fftSize);
    }

    try {
        analyser.getFloatTimeDomainData(tc.vars.analyserBuffer);
    } catch (e) {
        return;
    }

    let peak = 0;
    for (let i = 0; i < tc.vars.analyserBuffer.length; i++) {
        const sample = tc.vars.analyserBuffer[i];
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
    }
    tc.vars.normalizerPeakDb = peak > 0.000001 ? 20 * Math.log10(peak) : -Infinity;

    // Read loudness before manual volume, automatic gain, and output limiting.
    // The final output analyser remains dedicated to peak-meter feedback.
    if (!tc.vars.inputAnalyserBuffer || tc.vars.inputAnalyserBuffer.length !== sourceAnalyser.fftSize) {
        tc.vars.inputAnalyserBuffer = new Float32Array(sourceAnalyser.fftSize);
    }
    let sourceRmsDb = -120;
    let sourcePeakDb = -Infinity;
    try {
        sourceAnalyser.getFloatTimeDomainData(tc.vars.inputAnalyserBuffer);
        let sourceSum = 0;
        let sourcePeak = 0;
        for (let i = 0; i < tc.vars.inputAnalyserBuffer.length; i++) {
            const sample = tc.vars.inputAnalyserBuffer[i];
            sourceSum += sample * sample;
            sourcePeak = Math.max(sourcePeak, Math.abs(sample));
        }
        const sourceRms = Math.sqrt(sourceSum / Math.max(1, tc.vars.inputAnalyserBuffer.length));
        sourceRmsDb = sourceRms > 0.000001 ? 20 * Math.log10(sourceRms) : -120;
        sourcePeakDb = sourcePeak > 0.000001 ? 20 * Math.log10(sourcePeak) : -Infinity;
    } catch (e) {}

    const config = normalizeNormalizerConfig(tc.settings.normalizerConfig);
    let gainDb = Number(tc.vars.normalizerGainDb) || 0;
    const previousGainDb = gainDb;
    if (tc.vars.normalizerEnabled && !tc.vars.muted && !tc.vars.isBlocked &&
        tc.vars.isolatedOutputUsesLimiter === true) {
        gainDb = computeSafeNormalizerGainDb(gainDb, sourceRmsDb, sourcePeakDb, config);
    } else {
        gainDb = 0;
    }
    if (Math.abs(gainDb) < 0.01) gainDb = 0;
    tc.vars.normalizerGainDb = gainDb;

    configureIsolatedLimiter();
    try {
        const now = ctx.currentTime;
        const manualGain = tc.vars.isBlocked || tc.vars.muted ? (tc.vars.isBlocked ? 1 : 0) : getGainValue(tc.vars.dB);
        // A 100 ms meter update cannot reinstate boost on an unprotected
        // direct fallback. Retry limiter routing on the next state change.
        const protectedOutput = tc.vars.isolatedOutputUsesLimiter === true;
        const target = protectedOutput
            ? manualGain * (tc.vars.normalizerEnabled ? Math.pow(10, gainDb / 20) : 1)
            : Math.min(1, manualGain);
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setTargetAtTime(target, now, gainDb < previousGainDb ? 0.008 : 0.035);
    } catch (e) {}
}

function ensureIsolatedNormalizerTimer() {
    // Even an empty 100ms interval keeps waking background tabs. Only sample
    // when an actual isolated route needs automatic gain control.
    const shouldRun = !tc.vars.isBlocked && tc.vars.normalizerEnabled &&
        Boolean(tc.vars.gainNode && tc.vars.audioCtx);
    if (!shouldRun) {
        if (tc.vars.normalizerTimer !== null) clearInterval(tc.vars.normalizerTimer);
        tc.vars.normalizerTimer = null;
        return;
    }
    if (tc.vars.normalizerTimer === null) {
        tc.vars.normalizerTimer = setInterval(sampleIsolatedNormalizer, 100);
    }
}

function createGainNode() {
    if (!tc.vars.audioCtx) return;

    if (!tc.vars.gainNode) {
        tc.vars.gainNode = tc.vars.audioCtx.createGain();
        tc.vars.gainNode.channelInterpretation = "speakers";
        tc.vars.inputAnalyserNode = tc.vars.audioCtx.createAnalyser();
        // Cover most of each 100ms controller interval, rather than a
        // single ~21ms frame that can miss loud attacks.
        tc.vars.inputAnalyserNode.fftSize = 4096;
        tc.vars.inputAnalyserNode.smoothingTimeConstant = 0.35;
        tc.vars.inputAnalyserNode.connect(tc.vars.gainNode);
        tc.vars.limiterNode = tc.vars.audioCtx.createDynamicsCompressor();
        tc.vars.analyserNode = tc.vars.audioCtx.createAnalyser();
        tc.vars.analyserNode.fftSize = 1024;
        tc.vars.analyserNode.smoothingTimeConstant = 0.35;
        tc.vars.isolatedOutputUsesLimiter = null;
        // applyState() wires the correct output path; do not pre-connect a
        // compressor when normalization and positive boost are both off.
        ensureIsolatedNormalizerTimer();
    }
    applyState();
}

function isMediaPlaying(element) {
    return Boolean(element && !element.paused && !element.ended);
}

function isAudibleMediaElement(element) {
    try {
        return Boolean(element && !element.muted && element.volume > 0);
    } catch (e) {
        return true;
    }
}

let pageBridgeHeartbeatInterval = null;

function ensurePageBridgeResync() {
    if (pageBridgeResyncInterval !== null) return;
    // The resync interval exists to heal any drift between our cached
    // "last synced" state and the page hook's actual state (e.g. the hook
    // reset itself after a heartbeat timeout). The skip-cache in
    // syncPageAudioHook would defeat that purpose if we always skipped, so
    // every 6th tick (~30s) we force a full state send.
    let resyncCount = 0;
    pageBridgeResyncInterval = setInterval(() => {
        resyncCount++;
        if (resyncCount % 6 === 0) lastSyncedPageAudioState = null;
        syncPageAudioHook();
    }, PAGE_BRIDGE_RESYNC_MS);
}

function ensurePageBridgeHeartbeat() {
    if (pageBridgeHeartbeatInterval !== null) return;
    // Send an initial heartbeat immediately so the page hook doesn't think
    // we've gone away during the gap between script load and first sync.
    sendPageAudioHeartbeat();
    pageBridgeHeartbeatInterval = setInterval(sendPageAudioHeartbeat, PAGE_BRIDGE_HEARTBEAT_MS);
}

function stopPageBridgeTimers() {
    if (pageBridgeResyncInterval !== null) {
        clearInterval(pageBridgeResyncInterval);
        pageBridgeResyncInterval = null;
    }
    if (pageBridgeHeartbeatInterval !== null) {
        clearInterval(pageBridgeHeartbeatInterval);
        pageBridgeHeartbeatInterval = null;
    }
}

function resumeAudioContext() {
    const context = tc.vars.audioCtx;
    if (!context || typeof context.resume !== "function") return Promise.resolve();
    const resumeNow = async () => {
        try {
            if (context.state === "suspended") await context.resume();
            applyState();
        } catch (e) {
            if (tc.settings.debugMode) log(`audio context resume failed: ${e && e.message}`, 2);
        }
    };
    const pending = tc.vars.audioSuspendPromise;
    return pending ? pending.catch(() => {}).then(resumeNow) : resumeNow();
}

function suspendAudioContextIfIdle() {
    if (!tc.vars.audioCtx || tc.vars.audioCtx.state === 'closed') return;
    if (tc.vars.audioCtx.state !== 'running') return;

    let isPlaying = false;
    let hasHooked = false;
    for (const el of tc.vars.mediaElements || []) {
        // Clean up elements that have been removed from the DOM -- but keep
        // detached elements that are still playing. Deleting a playing
        // element here makes the isPlaying check below miss it, so the
        // context gets suspended while its audio is still flowing
        // (permanently silencing that element until the page is reloaded).
        if (!el.isConnected) {
            if (!(isMediaPlaying(el) && isAudibleMediaElement(el))) {
                tc.vars.mediaElements.delete(el);
                continue;
            }
        }
        if (el.dataset.vcHooked === "true") hasHooked = true;
        if (isMediaPlaying(el) && isAudibleMediaElement(el)) {
            isPlaying = true;
            break;
        }
    }

    if (isPlaying) return;

    // Suspend the context to release the OS audio device handle. Per the
    // WebAudio spec, a suspended context releases the audio device in all
    // major browsers (Chrome, Firefox, Safari), so suspend() is sufficient
    // for Bluetooth idle without the irrecoverable state that close() creates.
    //
    // We deliberately do NOT close() even when no hooked media remains.
    // close() would destroy any MediaElementSource routes still held, and
    // those routes can only be created ONCE per element per context. If the
    // page later re-adds a previously-hooked element (vcHooked still "true")
    // and plays it, connectOutput's early return would skip source creation,
    // and the element's audio would be piped to the dead source -> silence.
    // suspend() preserves the routes so they can be rewired on resume.
    //
    // We also do NOT null tc.vars.audioCtx/gainNode: keeping the references
    // alive lets already-hooked elements resume on the same context, and
    // lets new elements reuse the suspended context instead of creating a
    // wasteful new one.
    if (tc.vars.audioSuspendPromise) return;
    const context = tc.vars.audioCtx;
    let promise;
    promise = Promise.resolve()
        .then(() => context.suspend())
        .then(() => {
            if (tc.settings.debugMode) {
                log(hasHooked
                    ? "audio context suspended (media paused) — device handle released"
                    : "audio context suspended (no hooked media) — device handle released", 4);
            }
        })
        .catch((e) => {
            if (tc.settings.debugMode) log(`audio context suspend failed: ${e && e.message}`, 2);
        })
        .finally(() => {
            if (tc.vars.audioSuspendPromise === promise) tc.vars.audioSuspendPromise = null;
        });
    tc.vars.audioSuspendPromise = promise;
}

function mediaSourceKey(element) {
    try {
        if (!element) return "";
        if (element.srcObject) return "stream:" + String(element.srcObject.id || "");
        return String(element.currentSrc || element.src || "");
    } catch (e) {
        return "";
    }
}

function resetEphemeralControlsForMediaBoundary(element) {
    if (tc.vars.hasRememberedSettings || tc.vars.isBlocked || !element) return;
    const previousElement = tc.vars.ephemeralActiveElement;
    const previousSource = tc.vars.ephemeralSourceKeys.get(element) || "";
    const currentSource = mediaSourceKey(element);
    const pendingBoundary = tc.vars.ephemeralBoundaryPending.has(element);
    const changedElement = Boolean(previousElement && previousElement !== element);
    const changedSource = Boolean(previousSource && currentSource && previousSource !== currentSource);

    if (previousElement && (changedElement || changedSource || pendingBoundary)) {
        tc.vars.dB = 0;
        tc.vars.mono = false;
        tc.vars.muted = false;
        lastSyncedPageAudioState = null;
        applyState();
        syncPageAudioHook();
    }

    tc.vars.ephemeralActiveElement = element;
    tc.vars.ephemeralSourceKeys.set(element, currentSource);
    tc.vars.ephemeralBoundaryPending.delete(element);
}

function registerMediaElement(element) {
    if (!element) return;
    // Track all media elements (even page-managed ones) so applyState can
    // iterate knownMediaElements instead of calling querySelectorAll.
    if (tc.vars.knownMediaElements) tc.vars.knownMediaElements.add(element);

    // Attach the encrypted listener BEFORE the page-managed early return
    // below. The page-audio hook claims elements at creation time, so without
    // this, hook-claimed DRM elements would rely solely on element.mediaKeys
    // — which can land seconds after playback starts, leaving a window where
    // the boost-limit verdict says "unrestricted" while the media is DRM.
    // The sticky dataset flag written here is shared with the hook's world.
    try {
        if (element.dataset && element.dataset.vcEncryptedWatched !== "true") {
            element.dataset.vcEncryptedWatched = "true";
            element.addEventListener('encrypted', () => {
                try { element.dataset.vcRestrictedMedia = "true"; } catch (e) {}
                // Invalidate boost limit cache since this element just became restricted.
                invalidateBoostLimitCache();
            }, { passive: true });
        }
    } catch (e) {}

    if (isPageAudioManaged(element) || element.dataset.vcWatched === "true" || element.dataset.vcHooked === "true") return;

    element.dataset.vcWatched = "true";

    const hookIfPlaying = () => {
        if (isMediaPlaying(element)) resetEphemeralControlsForMediaBoundary(element);
        if (isPageAudioManaged(element)) {
            if (element.dataset.vcFallback === 'true') clearFallbackVolume(element);
            return;
        }

        if (tc.vars.isBlocked || !isMediaPlaying(element) || !isAudibleMediaElement(element)) {
            setTimeout(suspendAudioContextIfIdle, 250);
            return;
        }

        if (needsAudioRoute()) {
            connectOutput(element);
        } else if (getGainValue(tc.vars.dB) < 1 || element.dataset.vcFallback === 'true') {
            applyFallbackVolume(element);
        } else {
            clearFallbackVolume(element);
        }
    };

    element.addEventListener('play', hookIfPlaying, { passive: true });
    element.addEventListener('playing', hookIfPlaying, { passive: true });
    element.addEventListener('volumechange', hookIfPlaying, { passive: true });
    // v6.14: re-run the routing decision at timeupdate cadence — the EME
    // pending gate clears on playback progress (decryption proof), so a
    // probed-but-clear page (Plex) routes within a couple hundred
    // milliseconds of playback instead of a multi-second grace window.
    // Cheap guards keep this a no-op for hooked/managed/restricted/
    // non-suspect elements.
    element.addEventListener('timeupdate', () => {
        if (element.dataset.vcHooked === 'true' || isPageAudioManaged(element)) return;
        if (!isPendingEmeSuspect(element)) return;
        if (elementDrmEvidence(element)) return;
        hookIfPlaying();
    }, { passive: true });
    // v6.14: a new source must re-earn its EME decryption proof.
    element.addEventListener('emptied', () => {
        resetEmePending(element);
        tc.vars.ephemeralBoundaryPending.add(element);
    }, { passive: true });
    element.addEventListener('loadstart', () => {
        if (tc.vars.ephemeralActiveElement === element) tc.vars.ephemeralBoundaryPending.add(element);
    }, { passive: true });
    const scheduleSuspend = () => setTimeout(suspendAudioContextIfIdle, 250);
    for (const evt of ['pause', 'ended', 'emptied']) {
        element.addEventListener(evt, scheduleSuspend, { passive: true });
    }

    hookIfPlaying();
}

function connectOutput(element) {
    if (isPageAudioManaged(element)) {
        if (element.dataset.vcFallback === "true") clearFallbackVolume(element);
        return;
    }

    if (element.dataset.vcHooked === "true") {
        if (!tc.vars.audioCtx || tc.vars.audioCtx.state === 'closed') {
            // A MediaElementAudioSource cannot be recreated on another context.
            // Do not pretend the stale route is healthy or bind a new GainNode
            // to the dead context. Surface the limitation until navigation
            // replaces the element.
            element.dataset.vcFallbackReason = "route-failed";
            if (tc.vars.mediaElements) tc.vars.mediaElements.delete(element);
            invalidateBoostLimitCache();
            log("Previously hooked media lost its AudioContext; route is unavailable until the element is replaced", 2);
            return;
        }
        if (tc.vars.mediaElements) tc.vars.mediaElements.add(element);
        if (isMediaPlaying(element) && tc.vars.audioCtx.state === 'suspended') {
            resumeAudioContext();
        }
        return;
    }
    if (!needsAudioRoute()) {
        const gain = getGainValue(tc.vars.dB);
        if (gain < 1 || tc.vars.muted) {
            applyFallbackVolume(element);
        } else if (tc.settings.debugRouteMode === "native" && (gain > 1 || tc.vars.mono)) {
            applyFallbackVolume(element, "route-failed");
        } else {
            clearFallbackVolume(element);
        }
        registerMediaElement(element);
        return;
    }
    const forceEagerRoute = tc.settings.debugRouteMode === "webaudio";
    if ((!isMediaPlaying(element) && !forceEagerRoute) || !isAudibleMediaElement(element)) {
        registerMediaElement(element);
        return;
    }

    if (isLikelyCrossOriginMedia(element)) {
        applyFallbackVolume(element, "cross-origin");
        log(`Skipped WebAudio hook for cross-origin media: ${getMediaSourceUrl(element)}`, 3);
        return;
    }

    // Never route DRM-protected media through our AudioContext on engines
    // that silence protected audio (Chromium): browsers feed the WebAudio
    // graph silence for protected content while the element's native output
    // stays detached — the element would go permanently mute. On Gecko, DRM
    // audio is routable but only once keys are attached. The pending-EME
    // grace window is handled here too (shouldRefuseMediaRouting mirrors
    // the hook's isLikelyDrmMedia). Use fallback (native) volume control.
    if (shouldRefuseMediaRouting(element)) {
        applyFallbackVolume(element, isProbablyProtectedMedia(element) ? "restricted" : "");
        log(`Skipped WebAudio hook for DRM-restricted media: ${getMediaSourceUrl(element)}`, 3);
        return;
    }

    if (!tc.vars.audioCtx || tc.vars.audioCtx.state === 'closed') {
        // A GainNode belongs to exactly one AudioContext. Clear the stale node
        // before constructing a replacement context or connect() will throw a
        // cross-context InvalidAccessError.
        tc.vars.gainNode = undefined;
        tc.vars.inputAnalyserNode = undefined;
        tc.vars.inputAnalyserBuffer = undefined;
        tc.vars.limiterNode = undefined;
        tc.vars.analyserNode = undefined;
        tc.vars.analyserBuffer = undefined;
        if (tc.vars.normalizerTimer !== null) {
            clearInterval(tc.vars.normalizerTimer);
            tc.vars.normalizerTimer = null;
        }
        // If the context was closed (e.g. the page itself called .close()
        // on it, or a previous extension version closed it), create a fresh
        // one. Note: any elements previously hooked on the old context have
        // vcHooked="true" but their source is dead -- connectOutput's early
        // return at the vcHooked check above means they cannot be re-hooked
        // here (createMediaElementSource throws on second call). Those
        // elements will fall back to native volume via applyFallbackVolume.
        tc.vars.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        tc.vars.audioCtx.onstatechange = () => {
            // Guard against null: the context may be suspended/closed and
            // tc.vars.audioCtx may be reassigned before this handler fires.
            if (!tc.vars.audioCtx) return;
            if (tc.vars.audioCtx.state === 'running') applyState();
        };
    }

    if (!tc.vars.gainNode) createGainNode();

    // Ensure the tracking set exists
    if (!tc.vars.mediaElements) tc.vars.mediaElements = new Set();

    // Re-check immediately before createMediaElementSource to close the race
    // window where page-audio-hook.js might have claimed the element between
    // the top of connectOutput and here.
    if (isPageAudioManaged(element)) {
        applyFallbackVolume(element, "route-failed");
        log("Skipped WebAudio hook (race): page-audio-hook took ownership", 3);
        return;
    }

    try {
        log(`Attempting hook: ${element.tagName} id=${element.id || ''} src=${element.currentSrc || element.src || ''}`, 4);
        let source = null;

        if (typeof element.wrappedJSObject !== 'undefined') {
            try {
                source = tc.vars.audioCtx.createMediaElementSource(element.wrappedJSObject);
            } catch (e) {
                log(`Unwrap failed: ${e && e.message}`, 3);
            }
        }

        if (!source) {
            try {
                source = tc.vars.audioCtx.createMediaElementSource(element);
            } catch (e) {
                // createMediaElementSource can fail if the element is already
                // connected elsewhere (e.g., page-audio-hook or the page itself
                // already created a source for it) or due to browser restrictions.
                const msg = e && e.message ? e.message : String(e);
                if (/already|InvalidState|has a source|already connected/i.test(msg)) {
                    // Mark as page-managed so we don't keep retrying.
                    try { element.dataset[PAGE_AUDIO_MANAGED_ATTR] = "true"; } catch (_) {}
                    applyFallbackVolume(element, "route-failed");
                    log(`createMediaElementSource already in use: ${msg}`, 3);
                    return;
                }
                log(`createMediaElementSource failed: ${msg}`, 2);
                source = null;
            }
        }

        if (source) {
            source.connect(tc.vars.inputAnalyserNode);

            element.dataset.vcHooked = "true";
            tc.vars.mediaElements.add(element);

            // Wake up the AudioContext when media starts playing
            element.addEventListener('play', () => {
                if (tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
                    resumeAudioContext();
                }
            });

            // Suspend the AudioContext when media stops to release the Bluetooth lock
            const checkSuspend = () => setTimeout(suspendAudioContextIfIdle, 250);
            for (const evt of ['volumechange', 'pause', 'ended', 'emptied']) {
                element.addEventListener(evt, checkSuspend, { passive: true });
            }

            // Remove any fallback adjustments we may have made earlier
            clearFallbackVolume(element);

            applyState();
            checkSuspend();

            // Debug-only visuals. The non-debug branch used to clear
            // element.style.border unconditionally, wiping inline borders the
            // SITE had styled its player with. Only ever remove a border WE
            // painted (tracked via dataset), never the site's own styling.
            if (tc.settings.debugMode) {
                element.style.border = "2px solid #00ff00";
                element.dataset.vcDebugBorder = 'true';
            } else if (element.dataset.vcDebugBorder === 'true') {
                element.style.border = "";
                delete element.dataset.vcDebugBorder;
            }
            log("Hook Success!", 4);
        } else {
            // Fallback: if we can't create an audio node, adjust element.volume directly so user notices changes
            applyFallbackVolume(element, "route-failed");
            log("Hook fallback applied (element.volume scaled)", 3);
        }

    } catch (e) {
        log(`connectOutput outer failure: ${e && e.message}`, 2);
        applyFallbackVolume(element, "route-failed");
        if (tc.settings.debugMode) element.style.border = "5px solid red";
    }
}

function init() {
    if (!document.body) return false;
    if (document.body.classList.contains("vc-init")) return true;

    for (const el of document.querySelectorAll("audio, video")) registerMediaElement(el);

    document.body.classList.add("vc-init");
    return true;
} 

function initWhenReady() {
    if (document.body) {
        init();
        try {
            for (const el of document.querySelectorAll('audio, video')) {
                registerMediaElement(el);
            }
        } catch (e) {
            if (tc.settings.debugMode) log(`re-hook existing elements failed: ${e.message}`, 3);
        }
        return;
    }

    if (tc.vars.pendingInit) return;
    tc.vars.pendingInit = true;
    document.addEventListener('DOMContentLoaded', () => {
        tc.vars.pendingInit = false;
        initWhenReady();
    }, { once: true });
}

function extractRootDomain(url) {
    return sharedExtractRootDomain(url);
}

async function resolveControlUrl() {
    if (isTopFrame()) return window.location.href;
    if (profileControlUrl) return profileControlUrl;

    try {
        const response = await runtimeSendMessage({ command: "getTopTabUrl" });
        if (response && typeof response.url === "string" && response.url) {
            return response.url;
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`top-tab URL lookup failed: ${e && e.message}`, 3);
    }

    // Fall back to the frame URL only if the background is temporarily
    // unavailable. A later storage change/navigation will retry start().
    return window.location.href;
}

function normalizeDebugRouteMode(value) {
    return value === "webaudio" || value === "native" ? value : "auto";
}

function applyEffectiveDebugSettings(data, controlUrl) {
    const previous = {
        debugMode: tc.settings.debugMode,
        forceDrmCapture: tc.settings.forceDrmCapture,
        forceCorsCapture: tc.settings.forceCorsCapture,
        debugRouteMode: tc.settings.debugRouteMode
    };

    // Global options remain the defaults for every site.
    tc.settings.debugMode = !!data.debugMode;
    tc.settings.forceDrmCapture = !!data.forceDrmCapture;
    tc.settings.forceCorsCapture = !!data.forceCorsCapture;
    tc.settings.debugRouteMode = normalizeDebugRouteMode(data.debugRouteMode);

    // Per-site debug overrides are independent from Remembered Audio. During
    // the one-time migration, keep the legacy embedded object as a transient
    // fallback so an existing DRM/CORS override never blinks off.
    const siteSettingsKey = getSiteSettingsKey(data.siteSettings || {}, controlUrl);
    const siteDebugKey = getSiteSettingsKey(data.siteDebugSettings || {}, controlUrl);
    const separatedDebug = siteDebugKey ? data.siteDebugSettings[siteDebugKey] : null;
    const legacySettings = siteSettingsKey ? data.siteSettings[siteSettingsKey] : null;
    const legacyDebug = !data.siteDebugSettingsSeparatedV1 &&
        legacySettings && legacySettings.debug && typeof legacySettings.debug === "object"
        ? legacySettings.debug
        : null;
    const siteDebug = separatedDebug && typeof separatedDebug === "object"
        ? separatedDebug
        : legacyDebug;

    if (siteDebug) {
        if (siteDebug.debugMode !== undefined) tc.settings.debugMode = !!siteDebug.debugMode;
        if (siteDebug.forceDrmCapture !== undefined) tc.settings.forceDrmCapture = !!siteDebug.forceDrmCapture;
        if (siteDebug.forceCorsCapture !== undefined) tc.settings.forceCorsCapture = !!siteDebug.forceCorsCapture;
        if (siteDebug.debugRouteMode !== undefined) {
            tc.settings.debugRouteMode = normalizeDebugRouteMode(siteDebug.debugRouteMode);
        }
    }

    const changed =
        previous.debugMode !== tc.settings.debugMode ||
        previous.forceDrmCapture !== tc.settings.forceDrmCapture ||
        previous.forceCorsCapture !== tc.settings.forceCorsCapture ||
        previous.debugRouteMode !== tc.settings.debugRouteMode;

    if (changed) {
        invalidateBoostLimitCache();
        lastSyncedPageAudioState = null;
    }

    return siteSettingsKey;
}

async function start() {
    if (!browserAPI) return;

    const generation = ++startGeneration;
    controlProfileReady = false;
    try {
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, whitelistSeparatedV1: false, siteSettings: {}, siteNormalizerSettings: {}, normalizerDefaultEnabled: false, siteDebugSettings: {}, siteDebugSettingsSeparatedV1: false, debugMode: false, forceDrmCapture: false, forceCorsCapture: false, debugRouteMode: "auto", normalizerConfig: DEFAULT_NORMALIZER_CONFIG, legacyTwitchDefaultsPurged: false });
        if (generation !== startGeneration) return;

        // One-time migration (issue #69): V4-era builds seeded default
        // blocklist entries with paths ("www.twitch.tv/*/clip/*",
        // "clips.twitch.tv") into storage and never cleaned them up. After
        // v6.11's www-stripping normalization they matched the whole
        // twitch.tv site, silently deactivating the extension there.
        if (!data.legacyTwitchDefaultsPurged) {
            // Apply the migration view locally so this page is never blocked by
            // obsolete defaults. The background owns the actual serialized
            // storage mutation, avoiding a content-script vs Options race.
            const purged = purgeLegacyDefaultBlocklist(data.fqdns || []);
            data.fqdns = purged.list;
        }

        if (generation !== startGeneration) return;
        const controlUrl = await resolveControlUrl();
        if (generation !== startGeneration) return;
        if (!isTopFrame() && controlUrl) profileControlUrl = controlUrl;
        const currentDomain = extractRootDomain(controlUrl);
        const siteSettingsKey = applyEffectiveDebugSettings(data, controlUrl);
        tc.vars.hasRememberedSettings = Boolean(siteSettingsKey);
        tc.settings.normalizerConfig = normalizeNormalizerConfig(data.normalizerConfig);
        const normalizerSettingsKey = getSiteSettingsKey(data.siteNormalizerSettings || {}, controlUrl);
        const resolvedNormalizerEnabled = normalizerSettingsKey
            ? Boolean(data.siteNormalizerSettings[normalizerSettingsKey]?.enabled)
            : Boolean(data.normalizerDefaultEnabled);
        if (tc.vars.normalizerEnabled !== resolvedNormalizerEnabled) {
            tc.vars.normalizerGainDb = 0;
            tc.vars.normalizerPeakDb = -Infinity;
        }
        tc.vars.normalizerEnabled = resolvedNormalizerEnabled;

        // Debug: show state used to decide blocking
        if (tc.settings.debugMode) {
            log(`start(): controlUrl=${controlUrl} domain=${currentDomain} whitelistMode=${data.whitelistMode} fqdns=[${(data.fqdns||[]).slice(0,5).join(',')}] siteSettingsCount=${Object.keys(data.siteSettings||{}).length}`, 4);
        }

        let blocked = false;
        if (data.whitelistMode) {
            // Whitelist authorization is independent from Remembered Settings.
            // This lets users allow a site while keeping each tab/navigation at
            // its own ephemeral 0 dB state (issue #72).
            const explicitAllowed = (data.whitelist || []).some(entry => isUrlRememberedByEntry(controlUrl, entry));
            const legacyAllowed = !data.whitelistSeparatedV1 && Boolean(siteSettingsKey);
            const allowed = explicitAllowed || legacyAllowed;
            if (tc.settings.debugMode) log(`start(): whitelist samples=[${(data.whitelist || []).slice(0,5).join(',')}]`, 4);
            if (!allowed) blocked = true;
        } else {
            // Path-aware matching (issue #69): legacy path entries like
            // "www.twitch.tv/*/clip/*" scope to their path and no longer
            // block the whole domain.
            if (isUrlBlockedByEntries(controlUrl, data.fqdns || [])) blocked = true;
        }

        // Debug: log final decision
        if (tc.settings.debugMode) log(`start(): blocked=${blocked}`, 4);

        // Entering or leaving the blocklist must not bring back old
        // automatic boost. A fast block/unblock could happen before the
        // 100ms normalizer sampler clears its previous +dB gain.
        if (tc.vars.isBlocked !== blocked) {
            tc.vars.normalizerGainDb = 0;
            tc.vars.normalizerPeakDb = -Infinity;
            lastSyncedPageAudioState = null;
        }
        tc.vars.isBlocked = blocked;
        controlProfileReady = true;
        if (blocked) {
            // Restore isolated-world fallback volume/mute immediately too. A
            // block/whitelist change from the Options page does not reload the
            // tab, so returning before applyState() left DRM/CORS fallback
            // attenuation or a native mute stuck on the live player.
            lastSyncedPageAudioState = null;
            applyState();
            stopPageBridgeTimers();
            stopFrameReporting();
            stopBoostLimitObserver();
            return;
        }

        setupBoostLimitObserver();
        startFrameReporting();

        if (siteSettingsKey) {
            const s = data.siteSettings[siteSettingsKey];
            if (s.volume !== undefined) tc.vars.dB = normalizeDb(s.volume);
            if (s.mono !== undefined) tc.vars.mono = s.mono;
            if (s.muted !== undefined) tc.vars.muted = Boolean(s.muted);
        } else if (lastResolvedControlUrl && controlUrl && controlUrl !== lastResolvedControlUrl) {
            // "Remember" off means the control state is ephemeral. Reset when
            // an SPA moves to a new video/page instead of carrying the previous
            // video's dB/mute/mono state forward. Separate tabs already have
            // separate content-script state; this also gives issue #72 the
            // expected new-video default on URL-changing players such as YouTube.
            tc.vars.dB = 0;
            tc.vars.mono = false;
            tc.vars.muted = false;
        }
        lastResolvedControlUrl = controlUrl;

        applyState();
        ensurePageBridgeResync();
        ensurePageBridgeHeartbeat();
        initWhenReady();
    } catch (e) {
        if (tc.settings.debugMode) log(`start() storage read failed: ${e && e.message}`, 2);
        if (generation !== startGeneration) return;
        // A storage/runtime failure must fail open to native audio. Otherwise
        // the MAIN-world preflight has no authenticated state to consume and
        // can keep playback muted until its emergency timeout.
        tc.vars.isBlocked = true;
        controlProfileReady = true;
        lastSyncedPageAudioState = null;
        applyState();
        stopPageBridgeTimers();
        stopFrameReporting();
        stopBoostLimitObserver();
    }
}

start();

// Listen for requests from the page-audio hook (e.g., when it reactivates
// after a heartbeat timeout and needs the current state).
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_BRIDGE_TARGET || data.target !== PAGE_BRIDGE_SOURCE) return;
    if (data.token !== PAGE_BRIDGE_TOKEN) return;

    if (data.command === "locationChanged") {
        if (isTopFrame()) {
            // Never trust a URL supplied by MAIN-world page code. The current
            // document URL is authoritative and cannot be forged by postMessage.
            profileControlUrl = window.location.href;
            start();
            runtimeSendMessage({ command: "topUrlChanged", url: profileControlUrl }).catch(() => {});
        }
        return;
    }

    // The hook's aggregate page restriction (covers detached/shadow-DOM media
    // the document scan cannot see) just appeared or cleared. Drop our cached
    // verdict so the next state query reflects it immediately.
    if (data.command === "pageRestrictionChanged") {
        invalidateBoostLimitCache();
        if (!isTopFrame()) reportFrameBoostLimit(true);
        return;
    }

    if (data.command === "meterUpdate") {
        // Ignore an in-flight page meter tick if Normalize was just disabled
        // or the site became blocked. Otherwise it could restore the old
        // automatic gain after our blocklist/Normalize reset.
        if (!tc.vars.normalizerEnabled || tc.vars.isBlocked) return;
        // Chrome's JSON-based extension messaging may turn non-finite
        // numbers into null. A null peak means silence/unknown, never 0
        // dBFS (full-scale), and missing gain must not become NaN.
        tc.vars.normalizerPeakDb =
            typeof data.peakDb === "number" && Number.isFinite(data.peakDb)
                ? data.peakDb : -Infinity;
        tc.vars.normalizerGainDb =
            typeof data.normalizerGainDb === "number" && Number.isFinite(data.normalizerGainDb)
                ? data.normalizerGainDb : 0;
        return;
    }

    if (data.command !== "requestState") return;

    // Reset the sync skip-cache so the next syncPageAudioHook actually sends
    // the state, even if it hasn't changed from our perspective.
    lastSyncedPageAudioState = null;
    syncPageAudioHook();
});

// Keep content script state in sync when settings change in the extension UI
if (browserAPI && browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (tc.settings.debugMode) log(`onChanged: keys=[${Object.keys(changes).join(',')}]`, 4);

        // Re-evaluate blocking, remembered audio state, and effective debug
        // settings in one pass. This is important for per-site debug: a global
        // change must not overwrite a remembered site's explicit override.
        if (
            changes.whitelistMode ||
            changes.whitelistSeparatedV1 ||
            changes.whitelist ||
            changes.fqdns ||
            changes.siteSettings ||
            changes.siteNormalizerSettings ||
            changes.normalizerDefaultEnabled ||
            changes.normalizerConfig ||
            changes.siteDebugSettings ||
            changes.siteDebugSettingsSeparatedV1 ||
            changes.debugMode ||
            changes.forceDrmCapture ||
            changes.forceCorsCapture ||
            changes.debugRouteMode
        ) {
            start();
        }
    });
}
