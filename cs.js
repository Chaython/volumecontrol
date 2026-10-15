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
    "route-failed": "WebAudio routing failed or is unavailable. Native media may allow attenuation, but boosting and mono are unavailable; an already-captured element with a closed audio context may stay silent until reload.",
    "native-route": "Force native fallback is selected. Native HTML media volume can attenuate or mute, but boosting, mono, and Normalize require WebAudio.",
    "fallback": BOOST_LIMIT_NOTE
};
let pageBridgeResyncInterval = null;
let controlProfileReady = false;
let profileControlUrl = "";

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
    // Preserve the requested gain separately when this source is temporarily
    // limited to native audio (DRM/CORS/route failure).
    requestedDb: 0,
    mono: false,
    muted: false,
    normalizerEnabled: false,
    normalizerPeakDb: -Infinity,
    normalizerGainDb: 0,
    musicLevelState: null,
    isolatedOutputUsesLimiter: null,
    isolatedOutputRouteKind: null,
    truePeakStatus: 'idle',
    truePeakNode: undefined,
    truePeakLoadPromise: null,
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
                tc.vars.requestedDb = normalizeDb(msg.dB);
                tc.vars.dB = normalizeDbForCurrentMedia(tc.vars.requestedDb);
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
                    tc.vars.musicLevelState = null;
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
        // An encrypted event on the previous track must not permanently mark
        // a reused <video> as DRM. Only clear evidence when a *different,
        // nonempty* source is established and no MediaKeys remain attached.
        const keys = element.mediaKeys || element.webkitKeys;
        if (element.dataset && element.dataset.vcRestrictedMedia === "true") {
            const previous = element.dataset.vcRestrictedMediaSource;
            const current = getMediaSourceUrl(element);
            if (previous && current && previous !== current && !keys) {
                delete element.dataset.vcRestrictedMedia;
                delete element.dataset.vcRestrictedMediaSource;
            } else {
                return true;
            }
        }
        if (keys) return true;
    } catch (e) {
        // An unreadable MediaKeys getter must not authorize unsafe capture.
        return true;
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
    if (reason === "cross-origin" || reason === "route-failed" || reason === "native-route") return 2;
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

    if (element.dataset.vcHooked === "true") {
        // A successful MediaElementSource capture is irreversible. If its
        // AudioContext closes or reconnection fails, the element is STILL
        // marked hooked, but no longer has a functional output route.
        // Honor that failure before claiming unrestricted +32 dB support.
        if (element.dataset.vcFallbackReason === "route-failed" ||
            !tc.vars.audioCtx || tc.vars.audioCtx.state === "closed") {
            return "route-failed";
        }
        return "";
    }

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
let boostReconcileScheduled = false;
let boostLimitObserver = null;
let knownMediaSweepInterval = null;
const BOOST_LIMIT_CACHE_TTL_MS = 1000;
const KNOWN_MEDIA_SWEEP_MS = 30000;

function invalidateBoostLimitCache() {
    boostLimitCache = null;
    scheduleFrameBoostLimitReport();
    // Merely invalidating the verdict left applied dB at its previously
    // clamped value until the popup was reopened or another control changed.
    // Reconcile once per event batch when media/DRM/CORS conditions change.
    if (controlProfileReady && !tc.vars.isBlocked && !boostReconcileScheduled) {
        boostReconcileScheduled = true;
        queueMicrotask(() => {
            boostReconcileScheduled = false;
            if (!controlProfileReady || tc.vars.isBlocked) return;
            const next = normalizeDbForCurrentMedia(tc.vars.requestedDb);
            // Availability can change even while manual dB is already 0.
            // Stop/restart the isolated sampling timer and release any stale
            // automatic boost without waiting for a popup or slider event.
            const unavailable = tc.vars.normalizerEnabled &&
                !getNormalizerAvailability().available;
            if (unavailable && tc.vars.normalizerGainDb !== 0) {
                tc.vars.normalizerGainDb = 0;
                tc.vars.musicLevelState = null;
                tc.vars.normalizerPeakDb = -Infinity;
                applyState();
            } else if (next !== tc.vars.dB) {
                applyState();
            } else if (tc.vars.normalizerEnabled && tc.vars.gainNode) {
                ensureIsolatedNormalizerTimer();
            }
        });
    }
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
            if (!isMediaPlaying(el)) continue;
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

    // Force native is a route policy, not a decoded-audio capability. Clamp
    // before playback too, otherwise the popup can advertise +32 dB while
    // native HTMLMediaElement.volume is physically limited to 1. Preserve a
    // more informative DRM/CORS/failed-route restriction if one is present.
    if (tc.settings.debugRouteMode === "native" && !result.boostLimited) {
        result = makeBoostLimitedResult("native-route");
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
    let expired = false;
    for (const [frameId, entry] of Array.from(frameLimitReports)) {
        if (!Number.isInteger(frameId) || now - entry.ts > FRAME_REPORT_TTL_MS) {
            frameLimitReports.delete(frameId);
            expired = true;
            continue;
        }
        if (!best || reasonSeverity(entry.reason) > reasonSeverity(best.reason)) best = entry;
    }
    if (frameLimitReports.size === 0 && frameReportPurgeInterval !== null) {
        clearInterval(frameReportPurgeInterval);
        frameReportPurgeInterval = null;
    }
    // A removed iframe can disappear without sending an unrestricted report.
    // Expiring its stale restriction must also recheck requested volume and
    // Normalize availability; dropping it from the Map alone left applied
    // audio capped until the popup was reopened or another event occurred.
    if (expired) invalidateBoostLimitCache();
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

// Sites sometimes detach a video while it continues producing audio. Even if
// Volume Control made its native fallback temporarily silent, it must remain
// tracked so a later unmute/dB change can restore it without reinsertion.
function shouldRetainDetachedMediaElement(element) {
    if (!element || !isMediaPlaying(element)) return false;
    if (isAudibleMediaElement(element)) return true;
    const dataset = element.dataset;
    return Boolean(dataset && (dataset.vcFallback === 'true' || dataset.vcHooked === 'true'));
}

function sweepKnownMediaElements() {
    for (const element of Array.from(tc.vars.knownMediaElements || [])) {
        if (element && element.isConnected) continue;
        if (shouldRetainDetachedMediaElement(element)) continue;
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
            if (mutation.type === 'attributes') {
                const target = mutation.target;
                // A reused <audio>/<video> can switch from clear to CDN/DRM
                // content without DOM insertion. The MAIN hook also publishes
                // restrictions on the root element's data attribute.
                const media = target && (target.nodeName === 'AUDIO' || target.nodeName === 'VIDEO');
                if (media || (target === document.documentElement &&
                    mutation.attributeName === 'data-vc-page-media-restriction')) {
                    invalidateBoostLimitCache();
                    return;
                }
            }
            for (const node of mutation.addedNodes || []) {
                if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO' ||
                    (node.querySelectorAll && node.querySelector('audio, video'))) {
                    invalidateBoostLimitCache();
                    return;
                }
            }
            for (const node of mutation.removedNodes || []) {
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
        observer.observe(document.documentElement || document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'crossorigin', 'data-vc-page-media-restriction']
        });
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
    // A previously restricted track may become WebAudio-routable again.
    // Apply the restored requested gain to both the page hook and isolated
    // graph before reporting it to the popup.
    if (enforceBoostLimit()) applyState();
    const limit = getBoostLimitInfo();
    const monoAvailability = getMonoAvailability(limit);
    const normalizerAvailability = getNormalizerAvailability(limit);
    return {
        volume: Math.min(normalizeDb(tc.vars.dB), limit.maxDb),
        // Applied gain can be capped by DRM/CORS. Keep the intended dB
        // distinct so Remember and hotkeys do not persist that temporary cap.
        requestedVolume: normalizeDb(tc.vars.requestedDb),
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
    const requested = Number.isFinite(tc.vars.requestedDb)
        ? tc.vars.requestedDb : tc.vars.dB;
    const clamped = normalizeDbForCurrentMedia(requested);
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
            // Compare against OUR previous native write, not an estimate using
            // the CURRENT extension gain. Comparing with the new gain mistook
            // dB changes for site slider changes; the old 0.05 dead zone also
            // swallowed small movements of native player controls.
            const lastApplied = element.__vc_lastAppliedVolume;
            if (Number.isFinite(lastApplied) && Math.abs(currentVolume - lastApplied) > 0.000001) {
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
        // The isolated fallback cannot intercept the page's own muted setter.
        // Writing element.muted here loses the distinction between a site mute
        // and an extension mute: unmuting the extension could then unmute a
        // site-muted ad or player. Apply extension mute as native volume=0,
        // preserve the site-owned .muted flag, and restore its slider level
        // from __vc_originalVolume when the extension is unmuted.
        // This rare DRM/CORS fallback cannot release the OS audio handle by
        // muting natively, but it must never change the page's mute intent.
        const baseVolume = element.__vc_originalVolume !== undefined
            ? element.__vc_originalVolume
            : (gain > 1 ? 1 : element.volume);
        const newVol = Math.min(1, Math.max(0, baseVolume * Math.min(gain, 1)));
        // Save the value actually written so the next volumechange can tell a
        // native player-slider gesture from our own fallback correction.
        element.volume = newVol;
        element.__vc_lastAppliedVolume = newVol;
        if (tc.settings.debugMode) element.style.border = "2px dashed #ffa500";
    } catch (e) {
        log(`Fallback volume set failed: ${e && e.message}`, 2);
    }
}

function clearFallbackVolume(element) {
    if (!element || element.dataset.vcFallback !== 'true') return;

    try {
        if (element.__vc_originalVolume !== undefined) {
            const currentVolume = element.volume;
            const lastApplied = element.__vc_lastAppliedVolume;
            // A paused, muted, or disconnected player can change its native
            // volume without our playback handler running. Do not overwrite
            // that newer player choice with an old fallback snapshot when the
            // user resets to 0 dB or disables the extension.
            if (Number.isFinite(currentVolume) &&
                (!Number.isFinite(lastApplied) ||
                    Math.abs(currentVolume - lastApplied) > 0.000001)) {
                element.__vc_originalVolume = currentVolume;
            }
            if (Math.abs(element.volume - element.__vc_originalVolume) > 0.000001) {
                element.volume = element.__vc_originalVolume;
            }
        }
        // Extension muting uses volume=0, so there is no native mute flag to
        // undo. Never set element.muted=false on teardown: it might now be a
        // site-owned mute that the extension did not observe.
    } catch (e) {}

    delete element.__vc_originalVolume;
    delete element.__vc_lastAppliedVolume;
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

function disableIsolatedTruePeak(reason) {
    const vars = tc.vars;
    vars.truePeakStatus = 'failed';
    const node = vars.truePeakNode;
    vars.truePeakNode = undefined;
    try { if (node) node.disconnect(); } catch (e) {}
    if (tc.settings.debugMode) log(`experimental true-peak fallback: ${reason}`, 3);
    if (vars.isolatedOutputRouteKind === 'worklet') {
        // Recover an existing captured media route through the compressor;
        // never create a second MediaElementAudioSourceNode.
        vars.isolatedOutputRouteKind = null;
        routeIsolatedOutput();
        applyState();
    }
}

function prepareIsolatedTruePeak() {
    const vars = tc.vars;
    const ctx = vars.audioCtx;
    const config = normalizeNormalizerConfig(tc.settings.normalizerConfig);
    if (!config.experimentalTruePeak || vars.isBlocked || !ctx || !vars.limiterNode ||
        !(vars.normalizerEnabled || (!vars.muted && vars.dB > 0))) return;
    if (vars.truePeakStatus === 'ready') {
        try { vars.truePeakNode.port.postMessage({ type: 'set-ceiling', ceilingDb: config.ceilingDb }); }
        catch (e) { disableIsolatedTruePeak(e && e.message); }
        return;
    }
    if (vars.truePeakStatus === 'failed' || vars.truePeakStatus === 'loading') return;
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function' ||
        !browserAPI || !browserAPI.runtime || typeof browserAPI.runtime.getURL !== 'function') {
        vars.truePeakStatus = 'failed';
        return;
    }
    let moduleUrl;
    try { moduleUrl = browserAPI.runtime.getURL('true-peak-worklet.js'); }
    catch (e) { vars.truePeakStatus = 'failed'; return; }
    vars.truePeakStatus = 'loading';
    vars.truePeakLoadPromise = Promise.resolve().then(() => ctx.audioWorklet.addModule(moduleUrl))
        .then(() => {
            if (vars.audioCtx !== ctx || ctx.state === 'closed') return;
            const node = new AudioWorkletNode(ctx, 'volume-control-true-peak', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'explicit',
                processorOptions: { channels: 2, ceilingDb: config.ceilingDb }
            });
            node.onprocessorerror = () => {
                if (vars.truePeakNode === node && vars.audioCtx === ctx)
                    disableIsolatedTruePeak('processorerror');
            };
            node.port.onmessage = event => {
                if (vars.truePeakNode === node && vars.audioCtx === ctx &&
                    event.data && event.data.type === 'limiter-error') {
                    disableIsolatedTruePeak(event.data.message || 'DSP error');
                }
            };
            vars.truePeakNode = node;
            vars.truePeakStatus = 'ready';
            applyState();
        }).catch(e => {
            if (vars.audioCtx === ctx) disableIsolatedTruePeak(e && e.message || 'module unavailable');
        }).finally(() => {
            if (vars.audioCtx === ctx) vars.truePeakLoadPromise = null;
        });
}

function routeIsolatedOutput() {
    const { audioCtx, gainNode, limiterNode, analyserNode, truePeakNode } = tc.vars;
    if (!audioCtx || !gainNode || !limiterNode || !analyserNode) return;
    const useLimiter = !tc.vars.isBlocked &&
        (tc.vars.normalizerEnabled || (!tc.vars.muted && tc.vars.dB > 0));
    // Configuration was normalized on storage load. Keep disabled-by-default
    // behavior even if a test or legacy startup has not populated it yet.
    const configured = tc.settings.normalizerConfig || {};
    const truePeakReady = configured.experimentalTruePeak &&
        tc.vars.truePeakStatus === 'ready' && Boolean(truePeakNode);
    const routeKind = !useLimiter ? 'direct' : truePeakReady ? 'worklet' : 'compressor';
    if (tc.vars.isolatedOutputUsesLimiter === useLimiter &&
        tc.vars.isolatedOutputRouteKind === routeKind) return;

    if (!useLimiter) {
        // Clamp the boosted AudioParam BEFORE any direct connection.
        try {
            const param = gainNode.gain;
            const now = audioCtx.currentTime;
            const safeGain = tc.vars.isBlocked ? 1 :
                (tc.vars.muted ? 0 : Math.max(0, Math.min(1, getGainValue(tc.vars.dB))));
            param.cancelScheduledValues(now);
            param.setValueAtTime(safeGain, now);
        } catch (e) {
            if (tc.settings.debugMode) log(`isolated direct route clamp failed: ${e && e.message}`, 3);
            return;
        }
    }
    // Preserve the captured MediaElementSource -> inputAnalyser -> gain.
    // Only disconnect output edges; never re-create irreversible sources.
    for (const node of [gainNode, limiterNode, truePeakNode, analyserNode]) {
        try { if (node) node.disconnect(); } catch (e) {}
    }
    try {
        if (useLimiter) {
            const processor = routeKind === 'worklet' ? truePeakNode : limiterNode;
            if (routeKind === 'worklet') {
                processor.port.postMessage({ type: 'reset' });
                processor.port.postMessage({ type: 'set-ceiling', ceilingDb: configured.ceilingDb });
            } else {
                configureIsolatedLimiter();
            }
            gainNode.connect(processor);
            processor.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
        } else {
            gainNode.connect(audioCtx.destination);
        }
        tc.vars.isolatedOutputUsesLimiter = useLimiter;
        tc.vars.isolatedOutputRouteKind = routeKind;
    } catch (e) {
        // If the experimental node fails to connect, keep the existing
        // compressor as the *first* fallback. Direct output comes last.
        tc.vars.isolatedOutputUsesLimiter = null;
        tc.vars.isolatedOutputRouteKind = null;
        for (const node of [gainNode, limiterNode, truePeakNode, analyserNode]) {
            try { if (node) node.disconnect(); } catch (_) {}
        }
        if (routeKind === 'worklet' && useLimiter) {
            tc.vars.truePeakStatus = 'failed';
            tc.vars.truePeakNode = undefined;
            try {
                configureIsolatedLimiter();
                gainNode.connect(limiterNode);
                limiterNode.connect(analyserNode);
                analyserNode.connect(audioCtx.destination);
                tc.vars.isolatedOutputUsesLimiter = true;
                tc.vars.isolatedOutputRouteKind = 'compressor';
                if (tc.settings.debugMode) log('True-peak route failed; compressor restored', 3);
                return;
            } catch (compressorError) {
                for (const node of [gainNode, limiterNode, analyserNode]) {
                    try { if (node) node.disconnect(); } catch (_) {}
                }
            }
        }
        tc.vars.normalizerGainDb = 0;
        tc.vars.musicLevelState = null;
        tc.vars.normalizerPeakDb = -Infinity;
        try {
            const param = gainNode.gain;
            const now = audioCtx.currentTime;
            param.cancelScheduledValues(now);
            param.setValueAtTime(Math.max(0, Math.min(1, param.value)), now);
            gainNode.connect(audioCtx.destination);
            tc.vars.isolatedOutputUsesLimiter = false;
            tc.vars.isolatedOutputRouteKind = 'direct';
        } catch (fallbackError) {
            if (tc.settings.debugMode) log(`isolated output fallback failed: ${fallbackError && fallbackError.message}`, 3);
        }
        if (tc.settings.debugMode) log(`isolated output route failed: ${e && e.message}`, 3);
    }
}

function applyState() {
    enforceBoostLimit();
    syncPageAudioHook();
    // A newly playing second captured source must not inherit auto boost
    // even if this state sync precedes the next normalizer sample.
    guardConcurrentIsolatedNormalizer();

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
        prepareIsolatedTruePeak();
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
            if (!el.isConnected && !shouldRetainDetachedMediaElement(el)) {
                // An idle detached fallback must be restored before dropping
                // our last strong reference; otherwise it can resume later at
                // the extension's old attenuation without being tracked.
                if (el.dataset && el.dataset.vcFallback === 'true') clearFallbackVolume(el);
                tc.vars.knownMediaElements.delete(el);
                continue;
            }
            // Still-playing detached elements take the SAME update path as
            // connected elements. Retention without applying new dB/mute was
            // leaving audible detached videos stuck at stale native volume.
            if (isPageAudioManaged(el)) {
                if (el.dataset.vcFallback === 'true') clearFallbackVolume(el);
                continue;
            }

            if (el.dataset.vcHooked === "true") {
                if (routeNeeded && isMediaPlaying(el)) reconnectIsolatedCapturedSource(el);
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
        // Avoid unnecessary compression of already-unboosted music.
        // A fixed compressor route prevents clicks from frequent rewiring.
        const transparentMusic = tc.vars.normalizerEnabled && config.mode === "music" &&
            tc.vars.dB <= 0 && (!Number.isFinite(tc.vars.normalizerGainDb) ||
                tc.vars.normalizerGainDb <= 0);
        limiter.threshold.value = transparentMusic ? 0 : config.ceilingDb;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.12;
    } catch (e) {
        if (tc.settings.debugMode) log(`isolated limiter configure failed: ${e && e.message}`, 3);
    }
}

function computeSafeNormalizerGainDb(previousDb, sourceRmsDb, sourcePeakDb, config) {
    // The detector is upstream of the manual slider, in both audio worlds.
    // Fifth argument: per-route history; without it retain legacy adaptive behavior.
    const history = arguments[4];
    const previous = Number.isFinite(previousDb) ? previousDb : 0;
    if (history && history.mode !== config.mode) {
        history.mode = config.mode;
        history.rmsDb = null;
        history.peakDb = -Infinity;
        history.peakHoldSamples = 0;
        history.audibleSamples = 0;
        history.silentSamples = 0;
    }
    // Digital silence is reported as RMS=-120, peak=-Infinity: valid silence,
    // NOT an analyser failure. Still fail closed on NaN or non-silent bad peaks.
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
        // Don't pump up a music fade or gap between phrases. After 3 seconds
        // of silence, discard boost history without dropping safe attenuation.
        if (config.mode === "music" && history && history.audibleSamples > 0 &&
            ++history.silentSamples < 30) return previous;
        if (history) {
            history.rmsDb = null;
            history.peakDb = -Infinity;
            history.peakHoldSamples = 0;
            history.audibleSamples = 0;
            history.silentSamples = 0;
        }
        // Positive boost could overload the next loud passage; negative
            // attenuation should survive a silent dramatic pause instead
            // of suddenly returning to full-scale after three seconds.
            return config.mode === "music" ? Math.min(0, previous) : 0;
    }

    if (config.mode === "music" && history) {
        history.silentSamples = 0;
        history.audibleSamples = Math.min(1000, (history.audibleSamples || 0) + 1);
        if (!Number.isFinite(history.rmsDb)) history.rmsDb = sourceRmsDb;
        // A slow, asymmetrical envelope follows the overall program, not the
        // 100 ms kick/snare cycle. Do not count pauses/silence as quiet music.
        const rmsTimeMs = sourceRmsDb > history.rmsDb ? 3500 : 11000;
        history.rmsDb += (sourceRmsDb - history.rmsDb) *
            (1 - Math.exp(-100 / rmsTimeMs));
        // Peak envelope: hold for four seconds, then release by 1.5 dB/s.
        // A permanent sample-peak maximum made one transient suppress a full song.
        if (!Number.isFinite(history.peakDb) || sourcePeakDb >= history.peakDb) {
            history.peakDb = sourcePeakDb;
            history.peakHoldSamples = 40;
        } else if (history.peakHoldSamples > 0) {
            history.peakHoldSamples--;
        } else {
            history.peakDb = Math.max(sourcePeakDb, history.peakDb - 0.15);
        }
        // Excess peaks must prevent extra automatic boost, not make otherwise
        // unamplified music quieter merely for having a full-scale sample.
        const safeBoostDb = Math.max(0, Math.min(
            config.maxBoostDb, config.ceilingDb - 2 - history.peakDb));
        const desired = Math.max(-32, Math.min(
            config.targetDb - history.rmsDb, safeBoostDb,
            history.audibleSamples < 25 ? 0 : Infinity));
        // Immediately shed unsafe positive automatic boost after a fresh peak.
        // The existing compressor protects residual input peaks, with its documented limits.
        const instantaneousBoostLimit = Math.max(0, config.ceilingDb - 2 - sourcePeakDb);
        if (previous > 0 && instantaneousBoostLimit < previous) {
            return Math.max(-32, Math.min(desired, instantaneousBoostLimit));
        }
        const timeMs = desired < previous ? 1600 : 6000;
        return previous + (desired - previous) * (1 - Math.exp(-100 / timeMs));
    }

    // Adaptive mode retains the original fast voice/video leveling behavior.
    const rmsTarget = config.targetDb - sourceRmsDb;
    const peakHeadroom = config.ceilingDb - 2 - sourcePeakDb;
    const desired = Math.max(-32, Math.min(config.maxBoostDb, rmsTarget, peakHeadroom));
    if (desired <= previous) return desired;
    const alpha = 1 - Math.exp(-100 / Math.max(100, config.responseMs));
    return previous + (desired - previous) * alpha;
}

// Unlike MAIN-world MediaElement routes, the isolated fallback mixes all
// captured elements BEFORE one input analyser and gain. Its RMS is therefore
// not a per-player measurement. When multiple captured sources play, disable
// automatic positive boost rather than letting a quiet video amplify a loud
// one. Full independent per-source leveling requires separately owned graphs.
function activeIsolatedMediaCount(pendingElement = null) {
    let count = 0;
    for (const element of tc.vars.mediaElements || []) {
        const captured = tc.vars.capturedMediaSources && tc.vars.capturedMediaSources.get(element);
        if (!captured || (!captured.connected && element !== pendingElement) ||
            !isMediaPlaying(element) || !isAudibleMediaElement(element)) continue;
        if (++count >= 2) break;
    }
    return count;
}

function guardConcurrentIsolatedNormalizer(pendingElement = null) {
    if (!tc.vars.normalizerEnabled || activeIsolatedMediaCount(pendingElement) < 2) return false;
    const previous = Number(tc.vars.normalizerGainDb) || 0;
    // Keep existing attenuation; removing it could expose a previously
    // quieted track at full volume. No new gain history from a mixed signal.
    tc.vars.normalizerGainDb = Math.min(0, previous);
    tc.vars.musicLevelState = null;
    if (previous > 0 && tc.vars.gainNode && tc.vars.audioCtx) {
        try {
            // Clamp synchronously at the second play event. Waiting for the
            // 100ms sampler lets boosted audio leak for an audible fragment.
            const manual = tc.vars.isBlocked ? 1 :
                tc.vars.muted ? 0 : getGainValue(tc.vars.dB);
            const safe = tc.vars.isolatedOutputUsesLimiter === true
                ? manual : Math.min(1, manual);
            const param = tc.vars.gainNode.gain;
            const now = tc.vars.audioCtx.currentTime;
            param.cancelScheduledValues(now);
            param.setValueAtTime(Math.max(0, safe), now);
            configureIsolatedLimiter();
        } catch (e) {
            if (tc.settings.debugMode) log(`concurrent media gain clamp failed: ${e && e.message}`, 2);
            // Preserve the attempted zero-auto-gain control state; applyState()
            // retries restoring the clamped output when the graph recovers.
        }
    }
    return true;
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
    let sourceReadValid = false;
    try {
        sourceAnalyser.getFloatTimeDomainData(tc.vars.inputAnalyserBuffer);
        let sourceSum = 0;
        let sourcePeak = 0;
        for (let i = 0; i < tc.vars.inputAnalyserBuffer.length; i++) {
            const sample = tc.vars.inputAnalyserBuffer[i];
            if (!Number.isFinite(sample)) throw new Error("invalid source sample");
            sourceSum += sample * sample;
            sourcePeak = Math.max(sourcePeak, Math.abs(sample));
        }
        const sourceRms = Math.sqrt(sourceSum / Math.max(1, tc.vars.inputAnalyserBuffer.length));
        sourceRmsDb = sourceRms > 0.000001 ? 20 * Math.log10(sourceRms) : -120;
        sourcePeakDb = sourcePeak > 0.000001 ? 20 * Math.log10(sourcePeak) : -Infinity;
        sourceReadValid = true;
    } catch (e) {}

    const config = normalizeNormalizerConfig(tc.settings.normalizerConfig);
    // This fallback measures a mixed source. Never normalize two active
    // captured elements as though they were one song.
    const concurrent = guardConcurrentIsolatedNormalizer();
    let gainDb = Number(tc.vars.normalizerGainDb) || 0;
    const previousGainDb = gainDb;
    if (concurrent) {
        gainDb = Math.min(0, gainDb);
    } else if (tc.vars.normalizerEnabled && !tc.vars.muted && !tc.vars.isBlocked &&
        tc.vars.isolatedOutputUsesLimiter === true) {
        gainDb = computeSafeNormalizerGainDb(gainDb, sourceReadValid ? sourceRmsDb : NaN,
            sourceReadValid ? sourcePeakDb : NaN, config,
            tc.vars.musicLevelState || (tc.vars.musicLevelState = {}));
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
        Boolean(tc.vars.gainNode && tc.vars.audioCtx &&
            tc.vars.audioCtx.state === 'running') &&
        getNormalizerAvailability().available;
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
    const ctx = tc.vars.audioCtx;
    if (!ctx || ctx.state === 'closed') return false;

    if (!tc.vars.gainNode) {
        // Construct the whole processing chain locally. Publishing gainNode
        // before all the other nodes exist can leave a permanently incomplete
        // graph if createAnalyser(), createDynamicsCompressor(), or connect()
        // throws. A later call used to see gainNode != null and skip rebuilding.
        let gain = null;
        let input = null;
        let limiter = null;
        let analyser = null;
        try {
            gain = ctx.createGain();
            gain.channelInterpretation = "speakers";
            input = ctx.createAnalyser();
            // 8192 input samples span ~171ms at 48kHz, overlapping the
            // successive 100ms samples to reduce peak-detection gaps.
            input.fftSize = 8192;
            input.smoothingTimeConstant = 0.35;
            limiter = ctx.createDynamicsCompressor();
            analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.35;
            input.connect(gain);
        } catch (e) {
            // No media element has been captured yet. Release partial graph
            // nodes and permit a future play/state event to retry safely.
            for (const node of [input, gain, limiter, analyser]) {
                if (node) { try { node.disconnect(); } catch (_) {} }
            }
            if (tc.settings.debugMode) log(`isolated graph setup failed: ${e && e.message}`, 2);
            return false;
        }
        tc.vars.gainNode = gain;
        tc.vars.inputAnalyserNode = input;
        tc.vars.limiterNode = limiter;
        tc.vars.analyserNode = analyser;
        tc.vars.isolatedOutputUsesLimiter = null;
        tc.vars.isolatedOutputRouteKind = null;
        // applyState() wires the output only once a complete graph exists.
        ensureIsolatedNormalizerTimer();
    }
    applyState();
    return true;
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
            // A suspended context cannot provide new analyzer samples.
            // Stop its 100ms sampling timer; resumeAudioContext() calls
            // applyState(), which reinstates sampling once running again.
            ensureIsolatedNormalizerTimer();
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
                try {
                    element.dataset.vcRestrictedMedia = "true";
                    const source = getMediaSourceUrl(element);
                    if (source) element.dataset.vcRestrictedMediaSource = source;
                } catch (e) {}
                // Invalidate boost limit cache since this element just became restricted.
                invalidateBoostLimitCache();
            }, { passive: true });
        }
    } catch (e) {}

    if (isPageAudioManaged(element) || element.dataset.vcWatched === "true" || element.dataset.vcHooked === "true") return;

    element.dataset.vcWatched = "true";

    const hookIfPlaying = () => {
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
    }, { passive: true });
    const scheduleSuspend = () => setTimeout(suspendAudioContextIfIdle, 250);
    for (const evt of ['pause', 'ended', 'emptied']) {
        element.addEventListener(evt, scheduleSuspend, { passive: true });
    }

    hookIfPlaying();
}

function reconnectIsolatedCapturedSource(element) {
    const captured = tc.vars.capturedMediaSources && tc.vars.capturedMediaSources.get(element);
    if (!captured) return false;
    // Even a previously successful source goes silent if its AudioContext
    // was closed by the page. A second MediaElementSource is impossible.
    // Report failure rather than treating its old "connected" bit as sound.
    if (!tc.vars.audioCtx || tc.vars.audioCtx.state === 'closed') {
        element.dataset.vcFallbackReason = 'route-failed';
        invalidateBoostLimitCache();
        return false;
    }
    if (captured.connected) return true;

    // createMediaElementSource() irreversibly captures the element. If its
    // first .connect() fails, NEVER attempt another createMediaElementSource:
    // retain this exact node and retry a connection whenever playback/state
    // changes. Prefer the normal upstream analyser route.
    try {
        captured.source.connect(tc.vars.inputAnalyserNode);
        captured.connected = true;
        captured.bypassInputAnalyser = false;
    } catch (initialError) {
        // A direct input-analyser connection may fail on some media engines.
        // Route through our existing gain/limiter instead of pretending
        // element.volume can restore its now-detached native audio path.
        try {
            const param = tc.vars.gainNode.gain;
            const now = tc.vars.audioCtx.currentTime;
            const safeGain = tc.vars.isBlocked ? 1 :
                (tc.vars.muted ? 0 : Math.max(0, Math.min(1, getGainValue(tc.vars.dB))));
            param.cancelScheduledValues(now);
            param.setValueAtTime(safeGain, now);
            captured.source.connect(tc.vars.gainNode);
            captured.connected = true;
            captured.bypassInputAnalyser = true;
            if (tc.settings.debugMode) {
                log(`isolated source recovered through gain-node bypass: ${initialError && initialError.message}`, 3);
            }
        } catch (recoveryError) {
            if (tc.settings.debugMode) {
                log(`isolated captured source pending reconnect: ${recoveryError && recoveryError.message}`, 2);
            }
            element.dataset.vcFallbackReason = 'route-failed';
            invalidateBoostLimitCache();
            return false;
        }
    }
    // A native fallback installed before capture must not keep attenuating
    // the page-managed WebAudio source after connection recovery.
    clearFallbackVolume(element);
    delete element.dataset.vcFallbackReason;
    invalidateBoostLimitCache();
    return true;
}

function scheduleIsolatedCapturedSourceRetry(element) {
    const captured = tc.vars.capturedMediaSources && tc.vars.capturedMediaSources.get(element);
    if (!captured || captured.connected || captured.retryTimer || captured.retryCount >= 6) return;
    captured.retryTimer = setTimeout(() => {
        captured.retryTimer = null;
        if (!tc.vars.audioCtx || tc.vars.audioCtx.state === 'closed' || captured.connected) return;
        captured.retryCount = (captured.retryCount || 0) + 1;
        if (reconnectIsolatedCapturedSource(element)) {
            // A player may already be playing; no new 'play' event is
            // guaranteed after our first failed AudioNode.connect().
            // A successful retry can finish after playback was paused.
            // Leave the audio device suspended until the next real play,
            // instead of reviving Bluetooth/OS audio handles for idle media.
            if (isMediaPlaying(element) && tc.vars.audioCtx.state === 'suspended') {
                resumeAudioContext();
            }
            applyState();
        } else {
            scheduleIsolatedCapturedSourceRetry(element);
        }
    }, 250);
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
        // Clamp before a previously captured route reconnects; otherwise its
        // first block can play at another source's old positive gain.
        guardConcurrentIsolatedNormalizer(element);
        // Retry the original node, never create a second MediaElementSource.
        if (!reconnectIsolatedCapturedSource(element)) scheduleIsolatedCapturedSourceRetry(element);
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
        tc.vars.truePeakNode = undefined;
        tc.vars.truePeakStatus = 'idle';
        tc.vars.truePeakLoadPromise = null;
        tc.vars.isolatedOutputRouteKind = null;
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
        const context = new (window.AudioContext || window.webkitAudioContext)();
        tc.vars.audioCtx = context;
        context.onstatechange = () => {
            // A closed/replaced context can deliver its final event after the
            // replacement is already live; it must not alter its timer/graph.
            if (tc.vars.audioCtx !== context) return;
            // Browsers can suspend AudioContexts independently of our own
            // idle suspend helper (power saving, device interruption). Stop
            // the 100ms normalizer sampler on every non-running transition.
            ensureIsolatedNormalizerTimer();
            if (context.state === 'running') applyState();
        };
    }

    if (!tc.vars.gainNode && !createGainNode()) {
        // Do not call createMediaElementSource() with an incomplete graph:
        // native output would be detached with no usable path to speakers.
        applyFallbackVolume(element, "route-failed");
        return;
    }

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
            if (!tc.vars.capturedMediaSources) tc.vars.capturedMediaSources = new WeakMap();
            tc.vars.capturedMediaSources.set(element, {
                source,
                connected: false,
                bypassInputAnalyser: false
            });
            // Claim the element before the first fallible connection so
            // repeated attempts cannot create another MediaElementSource.
            element.dataset.vcHooked = "true";
            tc.vars.mediaElements.add(element);
            // This captured node is not connected yet. Count it provisionally
            // so a second playing source cannot leak the first source's boost
            // on its very first decoded audio block.
            guardConcurrentIsolatedNormalizer(element);
            const sourceConnected = reconnectIsolatedCapturedSource(element);
            if (!sourceConnected) scheduleIsolatedCapturedSourceRetry(element);

            // Wake up the AudioContext when media starts playing
            element.addEventListener('play', () => {
                guardConcurrentIsolatedNormalizer(element);
                if (!reconnectIsolatedCapturedSource(element)) return;
                if (tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
                    resumeAudioContext();
                }
            });

            // Isolated world has one gain for all captured media. A song
            // boundary must clear stale boost before the next track plays,
            // but never disrupt another concurrently playing captured source.
            const resetIsolatedSongGain = (event) => {
                if (!tc.vars.normalizerEnabled) return;
                for (const other of tc.vars.mediaElements) {
                    if (other !== element && isMediaPlaying(other) && isAudibleMediaElement(other)) return;
                }
                // A seek within the same song should retain existing
                // attenuation but must NEVER carry positive automatic gain
                // into a suddenly loud section.
                const previousDb = Number(tc.vars.normalizerGainDb) || 0;
                const retainedDb = event && event.type === 'seeking'
                    ? Math.min(0, previousDb) : 0;
                tc.vars.normalizerGainDb = retainedDb;
                tc.vars.musicLevelState = null;
                tc.vars.normalizerPeakDb = -Infinity;
                if (!tc.vars.gainNode || !tc.vars.audioCtx) return;
                try {
                    const manual = tc.vars.isBlocked ? 1 : tc.vars.muted ? 0 : getGainValue(tc.vars.dB);
                    const combined = manual * Math.pow(10, retainedDb / 20);
                    const safeGain = tc.vars.isolatedOutputUsesLimiter === true
                        ? combined : Math.min(1, combined);
                    const now = tc.vars.audioCtx.currentTime;
                    tc.vars.gainNode.gain.cancelScheduledValues(now);
                    tc.vars.gainNode.gain.setValueAtTime(safeGain, now);
                } catch (e) {
                    if (tc.settings.debugMode) log(`song-boundary gain reset failed: ${e && e.message}`, 3);
                }
            };
            // Seeking can jump from quiet intro to loud chorus without a
            // source/ended event. Reset captured gain before it resumes.
            element.addEventListener('seeking', resetIsolatedSongGain, { passive: true });
            element.addEventListener('ended', resetIsolatedSongGain, { passive: true });
            element.addEventListener('emptied', resetIsolatedSongGain, { passive: true });
            // Suspend the AudioContext when media stops to release the Bluetooth lock
            const checkSuspend = () => setTimeout(suspendAudioContextIfIdle, 250);
            for (const evt of ['volumechange', 'pause', 'ended', 'emptied']) {
                element.addEventListener(evt, checkSuspend, { passive: true });
            }

            // Only release native fallback modifications after the
            // captured source actually has a working WebAudio connection.
            if (sourceConnected) clearFallbackVolume(element);

            guardConcurrentIsolatedNormalizer();
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
            if (sourceConnected) log("Hook Success!", 4);
            else log("Captured isolated source retained for retry; initial audio connection failed", 2);
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
        const previousNormalizerMode = tc.settings.normalizerConfig && tc.settings.normalizerConfig.mode;
        tc.settings.normalizerConfig = normalizeNormalizerConfig(data.normalizerConfig);
        // Applying new loudness rules must not reuse automatic boost earned
        // under the old mode, even until the next 100 ms meter tick.
        if (previousNormalizerMode !== tc.settings.normalizerConfig.mode) {
            tc.vars.normalizerGainDb = 0;
            tc.vars.musicLevelState = null;
            tc.vars.normalizerPeakDb = -Infinity;
        }
        const normalizerSettingsKey = getSiteSettingsKey(data.siteNormalizerSettings || {}, controlUrl);
        const resolvedNormalizerEnabled = normalizerSettingsKey
            ? Boolean(data.siteNormalizerSettings[normalizerSettingsKey]?.enabled)
            : Boolean(data.normalizerDefaultEnabled);
        if (tc.vars.normalizerEnabled !== resolvedNormalizerEnabled) {
            tc.vars.normalizerGainDb = 0;
            tc.vars.musicLevelState = null;
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
            // This lets allowed tabs retain independent temporary controls
            // through playlist/SPA transitions without saving them to storage.
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
            tc.vars.musicLevelState = null;
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
            if (s.volume !== undefined) {
                tc.vars.requestedDb = normalizeDb(s.volume);
                tc.vars.dB = tc.vars.requestedDb;
            }
            if (s.mono !== undefined) tc.vars.mono = s.mono;
            if (s.muted !== undefined) tc.vars.muted = Boolean(s.muted);
        }
        // With Remember off, preserve unsaved volume/mono/mute inside this
        // document/tab across SPA navigation and playlist changes. New tabs
        // and actual reloads still start from default 0 dB controls.

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
