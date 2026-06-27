const {
    browserApi: browserAPI,
    MAX_DB,
    normalizeDb,
    getGainValue,
    storageGet,
    domainMatchesSaved,
    getSiteSettingsKey,
    BRIDGE_VERSION,
    BOOST_LIMIT_NOTE
} = globalThis.VolumeControlShared;
const sharedExtractRootDomain = globalThis.VolumeControlShared.extractRootDomain;
const PAGE_BRIDGE_SOURCE = "volume-control-extension";
const PAGE_BRIDGE_TARGET = "volume-control-page-audio";
const PAGE_AUDIO_MANAGED_ATTR = "vcPageAudioManaged";
const PAGE_BRIDGE_RESYNC_MS = 5000;
const PAGE_BRIDGE_HEARTBEAT_MS = 3000;
const BOOST_LIMIT_NOTES = {
    "cross-origin": "Limited by cross-origin media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.",
    "restricted": "Limited by DRM-protected or otherwise restricted media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.",
    "route-failed": "Limited because the page blocked or already owns the audio route. Fallback volume control can still lower volume, but boosting and mono may be unavailable.",
    "fallback": BOOST_LIMIT_NOTE
};
let pageBridgeResyncInterval = null;

const tc = {
  settings: {
    logLevel: 4,
    debugMode: false
  },
  vars: {
    dB: 0,
    mono: false,
    muted: false,
    audioCtx: undefined,
    gainNode: undefined,
    isBlocked: false,
    pendingInit: false,
    // Media elements successfully hooked into our AudioContext (source.connect'd).
    mediaElements: new Set(),
    // All known media elements on the page (hooked, fallback, or page-managed).
    // Populated by registerMediaElement and init. Used by applyState to avoid
    // querySelectorAll on every state change.
    knownMediaElements: new Set()
  }
};

const logTypes = ["ERROR", "WARNING", "INFO", "DEBUG"];
function log(msg, level = 4) {
  if (tc.settings.logLevel >= level) console.log(`[VolumeControl] ${logTypes[level-2]}: ${msg}`);
}

if (browserAPI) {
    browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    return !tc.vars.isBlocked && (tc.vars.muted || tc.vars.mono || getGainValue(tc.vars.dB) > 1);
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
    const src = getMediaSourceUrl(element);
    if (!src || element.crossOrigin) return false;

    try {
        const url = new URL(src, document.baseURI);
        return url.protocol.indexOf("http") === 0 && url.origin !== window.location.origin;
    } catch (e) {
        return false;
    }
}

function isLikelyRestrictedMedia(element) {
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

function isPageAudioManaged(element) {
    try {
        return Boolean(element && element.dataset && element.dataset[PAGE_AUDIO_MANAGED_ATTR] === "true");
    } catch (e) {
        return false;
    }
}

function getBoostLimitReason(element) {
    if (!element || element.dataset.vcHooked === "true") return "";

    if (isLikelyRestrictedMedia(element)) return "restricted";

    const crossOrigin = isLikelyCrossOriginMedia(element);
    if (isPageAudioManaged(element)) return crossOrigin ? "cross-origin" : "";

    const fallbackReason = element.dataset.vcFallbackReason;
    if (fallbackReason) return fallbackReason;

    if (crossOrigin) return "cross-origin";

    return "";
}

// Boost limit cache: avoid running querySelectorAll on every state change.
// Invalidated by a MutationObserver when audio/video elements are added/removed,
// and by a TTL to catch async state changes (e.g., mediaKeys being set).
let boostLimitCache = null;
let boostLimitCacheTime = 0;
const BOOST_LIMIT_CACHE_TTL_MS = 1000;

function invalidateBoostLimitCache() {
    boostLimitCache = null;
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
                result = {
                    boostLimited: true,
                    maxDb: 0,
                    reason,
                    note: BOOST_LIMIT_NOTES[reason] || BOOST_LIMIT_NOTES.fallback
                };
                break;
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`boost limit check failed: ${e.message}`, 3);
    }

    boostLimitCache = result;
    boostLimitCacheTime = now;
    return result;
}

function setupBoostLimitObserver() {
    // Invalidate the boost limit cache when audio/video elements are added or
    // removed from the DOM, so the next call to getBoostLimitInfo recomputes.
    if (typeof MutationObserver === 'undefined') return;
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
    const startObserving = () => {
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
    };
    if (document.documentElement) {
        startObserving();
    } else {
        document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }
}

function normalizeDbForCurrentMedia(value) {
    const normalized = normalizeDb(value);
    const limit = getBoostLimitInfo();
    return Math.min(normalized, limit.maxDb);
}

function getAudioControlState() {
    enforceBoostLimit({ sync: true });
    const limit = getBoostLimitInfo();
    return {
        volume: Math.min(normalizeDb(tc.vars.dB), limit.maxDb),
        mono: tc.vars.mono,
        muted: Boolean(tc.vars.muted),
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
    const limitReason = isLikelyRestrictedMedia(element) ? "restricted" : reason;

    try {
        const currentVolume = (typeof element.volume === 'number') ? element.volume : 1;
        if (element.dataset.vcFallback !== 'true') {
            // First time applying fallback; capture original volume.
            element.__vc_originalVolume = gain > 1 ? 1 : currentVolume;
        } else {
            // Already in fallback mode. If the page changed element.volume out
            // from under us (e.g., the page's own volume slider), update
            // __vc_originalVolume to reflect the page's intent. Without this,
            // the captured original can become stale and cause a volume spike
            // when the route is later established and volume is restored.
            const origBase = element.__vc_originalVolume !== undefined
                ? element.__vc_originalVolume
                : (gain > 1 ? 1 : currentVolume);
            const expectedScaled = Math.min(1, Math.max(0, origBase * Math.min(gain, 1)));
            if (Math.abs(currentVolume - expectedScaled) > 0.05) {
                // Page changed volume; treat current as the new "original".
                element.__vc_originalVolume = gain > 1 ? 1 : currentVolume;
            }
        }
        element.dataset.vcFallback = 'true';
    } catch (e) {}
    if (limitReason) element.dataset.vcFallbackReason = limitReason;

    try {
        // Native mute: when the extension is muted, set element.muted = true
        // so the browser can release the OS audio device handle (important for
        // Bluetooth headphones that stay active while a media element plays).
        // We still restore __vc_originalVolume below so unmuting is clean.
        if (tc.vars.muted) {
            element.muted = true;
            if (tc.settings.debugMode) element.style.border = "2px dashed #ffa500";
            return;
        }
        // Unmute native property if we previously muted it.
        if (element.muted) element.muted = false;

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
        // Clear any native mute we applied while in fallback mode.
        if (element.muted) element.muted = false;
    } catch (e) {}

    delete element.__vc_originalVolume;
    delete element.dataset.vcFallback;
    delete element.dataset.vcFallbackReason;
}

// Track the last state sent to the page-audio hook so we can skip redundant
// postMessage calls. This prevents the 5-second resync interval and rapid
// slider movements from triggering unnecessary applyStateToGraphs() /
// applyStateToMediaElements() cycles on the page, which can cause audio dropouts.
let lastSyncedPageAudioState = null;

function syncPageAudioHook() {
    const currentState = {
        enabled: !tc.vars.isBlocked,
        dB: tc.vars.isBlocked ? 0 : normalizeDb(tc.vars.dB),
        mono: !tc.vars.isBlocked && tc.vars.mono,
        muted: !tc.vars.isBlocked && Boolean(tc.vars.muted),
        debugMode: tc.settings.debugMode
    };

    // Skip if nothing changed since the last sync.
    if (lastSyncedPageAudioState &&
        lastSyncedPageAudioState.enabled === currentState.enabled &&
        lastSyncedPageAudioState.dB === currentState.dB &&
        lastSyncedPageAudioState.mono === currentState.mono &&
        lastSyncedPageAudioState.muted === currentState.muted &&
        lastSyncedPageAudioState.debugMode === currentState.debugMode) {
        return;
    }
    lastSyncedPageAudioState = currentState;

    try {
        window.postMessage({
            source: PAGE_BRIDGE_SOURCE,
            target: PAGE_BRIDGE_TARGET,
            command: "setState",
            version: BRIDGE_VERSION,
            ...currentState
        }, "*");
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
            command: "heartbeat",
            version: BRIDGE_VERSION
        }, "*");
    } catch (e) {
        // ignore
    }
}

function applyState() {
    enforceBoostLimit();
    syncPageAudioHook();

    const audioCtx = tc.vars.audioCtx;
    const gainNode = tc.vars.gainNode;
    const isEnabled = !tc.vars.isBlocked;
    const targetGain = isEnabled ? (tc.vars.muted ? 0 : getGainValue(tc.vars.dB)) : 1.0;

    if (gainNode && audioCtx) {
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
        const gain = tc.vars.muted ? 0 : getGainValue(tc.vars.dB);
        for (const el of Array.from(tc.vars.knownMediaElements || [])) {
            // Clean up elements that have been removed from the DOM.
            if (!el.isConnected) {
                tc.vars.knownMediaElements.delete(el);
                continue;
            }
            if (isPageAudioManaged(el)) {
                if (el.dataset.vcFallback === 'true') clearFallbackVolume(el);
                continue;
            }

            if (el.dataset.vcHooked === "true") {
                if (routeNeeded && isMediaPlaying(el) && tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
                    tc.vars.audioCtx.resume().then(applyState);
                }
                continue;
            }

            if (tc.vars.muted && !routeNeeded) {
                // Muted but no WebAudio route (e.g. fallback-only media):
                // apply native element.muted so the OS can release audio.
                applyFallbackVolume(el);
            } else if (!routeNeeded && !tc.vars.isBlocked && gain < 1) {
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

    // Always schedule a suspend/close check, even when boost or mono is active.
    // Previously this was gated on !needsAudioRoute(), which meant the context
    // was never suspended while boost/mono was on — causing Bluetooth devices
    // to stay active after playback paused.
    setTimeout(suspendAudioContextIfIdle, 250);
}

function createGainNode() {
    if (!tc.vars.audioCtx) return;

    if (!tc.vars.gainNode) {
        tc.vars.gainNode = tc.vars.audioCtx.createGain();
        tc.vars.gainNode.channelInterpretation = "speakers";
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
    pageBridgeResyncInterval = setInterval(syncPageAudioHook, PAGE_BRIDGE_RESYNC_MS);
}

function ensurePageBridgeHeartbeat() {
    if (pageBridgeHeartbeatInterval !== null) return;
    // Send an initial heartbeat immediately so the page hook doesn't think
    // we've gone away during the gap between script load and first sync.
    sendPageAudioHeartbeat();
    pageBridgeHeartbeatInterval = setInterval(sendPageAudioHeartbeat, PAGE_BRIDGE_HEARTBEAT_MS);
}

function suspendAudioContextIfIdle() {
    if (!tc.vars.audioCtx || tc.vars.audioCtx.state === 'closed') return;
    if (tc.vars.audioCtx.state !== 'running') return;

    let isPlaying = false;
    let hasHooked = false;
    for (const el of tc.vars.mediaElements || []) {
        // Clean up elements that have been removed from the DOM.
        if (!el.isConnected) {
            tc.vars.mediaElements.delete(el);
            continue;
        }
        if (el.dataset.vcHooked === "true") hasHooked = true;
        if (isMediaPlaying(el) && isAudibleMediaElement(el)) {
            isPlaying = true;
            break;
        }
    }

    if (isPlaying) return;

    if (!hasHooked) {
        // No media is hooked into this context; close it to fully release the
        // OS audio device handle (critical for Bluetooth devices that stay
        // active while a running AudioContext holds the output stream open).
        const ctx = tc.vars.audioCtx;
        tc.vars.audioCtx = null;
        tc.vars.gainNode = null;
        ctx.close().catch(() => {});
        if (tc.settings.debugMode) log("audio context closed (no hooked media) — device handle released", 3);
    } else {
        tc.vars.audioCtx.suspend();
        if (tc.settings.debugMode) log("audio context suspended (media paused)", 4);
    }
}

function registerMediaElement(element) {
    if (!element) return;
    // Track all media elements (even page-managed ones) so applyState can
    // iterate knownMediaElements instead of calling querySelectorAll.
    if (tc.vars.knownMediaElements) tc.vars.knownMediaElements.add(element);
    if (isPageAudioManaged(element) || element.dataset.vcWatched === "true" || element.dataset.vcHooked === "true") return;

    element.dataset.vcWatched = "true";
    element.addEventListener('encrypted', () => {
        element.dataset.vcRestrictedMedia = "true";
        // Invalidate boost limit cache since this element just became restricted.
        invalidateBoostLimitCache();
    }, { passive: true });

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
        if (tc.vars.mediaElements) tc.vars.mediaElements.add(element);
        if (isMediaPlaying(element) && tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
            tc.vars.audioCtx.resume().then(applyState);
        }
        return;
    }
    if (!needsAudioRoute()) {
        if (getGainValue(tc.vars.dB) < 1) applyFallbackVolume(element);
        else clearFallbackVolume(element);
        registerMediaElement(element);
        return;
    }
    if (!isMediaPlaying(element) || !isAudibleMediaElement(element)) {
        registerMediaElement(element);
        return;
    }

    if (isLikelyCrossOriginMedia(element)) {
        applyFallbackVolume(element, "cross-origin");
        log(`Skipped WebAudio hook for cross-origin media: ${getMediaSourceUrl(element)}`, 3);
        return;
    }

    if (!tc.vars.audioCtx) {
        tc.vars.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        tc.vars.audioCtx.onstatechange = () => {
            // Guard against null: suspendAudioContextIfIdle may close the context
            // and null out tc.vars.audioCtx before this handler fires.
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
            source.connect(tc.vars.gainNode);
            tc.vars.gainNode.connect(tc.vars.audioCtx.destination);

            element.dataset.vcHooked = "true";
            tc.vars.mediaElements.add(element);

            // Wake up the AudioContext when media starts playing
            element.addEventListener('play', () => {
                if (tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
                    tc.vars.audioCtx.resume().then(applyState);
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

            if (tc.settings.debugMode) element.style.border = "2px solid #00ff00";
            else element.style.border = "";
            log("Hook Success!", 4);
        } else {
            // Fallback: if we can't create an audio node, adjust element.volume directly so user notices changes
            applyFallbackVolume(element, "route-failed");
            log("Hook fallback applied (element.volume scaled)", 3);
        }

    } catch (e) {
        log(`connectOutput outer failure: ${e && e.message}`, 1);
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
    return sharedExtractRootDomain(url, { fileValue: "file" });
} 

async function start() {
    if (!browserAPI) return;

    try {
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {}, debugMode: false });

        if (data.debugMode !== undefined) tc.settings.debugMode = data.debugMode;

        const currentDomain = extractRootDomain(window.location.href);

        // Debug: show state used to decide blocking
        if (tc.settings.debugMode) {
            log(`start(): domain=${currentDomain} whitelistMode=${data.whitelistMode} fqdns=[${(data.fqdns||[]).slice(0,5).join(',')}] siteSettingsCount=${Object.keys(data.siteSettings||{}).length}`, 4);
        }

        let blocked = false;
        if (data.whitelistMode) {
            // Whitelist is derived from remembered sites (siteSettings)
            const remembered = Object.keys(data.siteSettings || {});
            if (tc.settings.debugMode) log(`start(): remembered samples=[${remembered.slice(0,5).join(',')}]`, 4);
            if (!getSiteSettingsKey(data.siteSettings || {}, currentDomain)) blocked = true;
        } else {
            if ((data.fqdns || []).some(d => domainMatchesSaved(currentDomain, d))) blocked = true;
        }

        // Debug: log final decision
        if (tc.settings.debugMode) log(`start(): blocked=${blocked}`, 4);

        // Ensure the content script's blocked flag reflects the current state (clear it when unblocked)
        tc.vars.isBlocked = blocked;
        if (blocked) {
            applyState();
            ensurePageBridgeResync();
            ensurePageBridgeHeartbeat();
            return;
        }

        const siteSettingsKey = getSiteSettingsKey(data.siteSettings, currentDomain);
        if (siteSettingsKey) {
            const s = data.siteSettings[siteSettingsKey];
            if (s.volume !== undefined) tc.vars.dB = normalizeDb(s.volume);
            if (s.mono !== undefined) tc.vars.mono = s.mono;
        }

        applyState();
        ensurePageBridgeResync();
        ensurePageBridgeHeartbeat();
        initWhenReady();
    } catch (e) {
        if (tc.settings.debugMode) log(`start() storage read failed: ${e && e.message}`, 2);
    }
}

setupBoostLimitObserver();
start();

// Listen for requests from the page-audio hook (e.g., when it reactivates
// after a heartbeat timeout and needs the current state).
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_BRIDGE_TARGET || data.target !== PAGE_BRIDGE_SOURCE) return;
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

        // Re-evaluate blocking and apply site settings in a single pass.
        // Previously this called start() AND a separate siteSettings handler,
        // causing double storage reads, double applyState() calls, and potential
        // race conditions if the two reads completed in different orders.
        if (changes.whitelistMode || changes.fqdns || changes.siteSettings) {
            start();
        }

        // Update debug mode live
        if (changes.debugMode) {
            tc.settings.debugMode = !!changes.debugMode.newValue;
            syncPageAudioHook();
        }
    });
}
