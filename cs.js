const browserAPI = (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));
const PAGE_BRIDGE_SOURCE = "volume-control-extension";
const PAGE_BRIDGE_TARGET = "volume-control-page-audio";
const PAGE_AUDIO_MANAGED_ATTR = "vcPageAudioManaged";
const MIN_DB = -32;
const MAX_DB = 32;
const PAGE_BRIDGE_RESYNC_MS = 5000;
const BOOST_LIMIT_NOTE = "Boosting and mono may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.";
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
    audioCtx: undefined,
    gainNode: undefined,
    isBlocked: false,
    pendingInit: false,
    mediaElements: new Set()
  }
};

const logTypes = ["ERROR", "WARNING", "INFO", "DEBUG"];
function log(msg, level = 4) {
  if (tc.settings.logLevel >= level) console.log(`[VolumeControl] ${logTypes[level-2]}: ${msg}`);
}

function normalizeDb(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
}

function getRuntimeLastError() {
    return browserAPI && browserAPI.runtime ? browserAPI.runtime.lastError : null;
}

function callApi(method, args = []) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };
        const callback = (value) => {
            finish(getRuntimeLastError(), value);
        };

        try {
            const result = method(...args, callback);
            if (result && typeof result.then === 'function') {
                result.then((value) => finish(null, value), (error) => finish(error));
            }
        } catch (callbackError) {
            try {
                const result = method(...args);
                if (result && typeof result.then === 'function') {
                    result.then((value) => finish(null, value), (error) => finish(error));
                } else {
                    finish(null, result);
                }
            } catch (promiseError) {
                finish(promiseError || callbackError);
            }
        }
    });
}

function storageGet(keys) {
    return callApi(browserAPI.storage.local.get.bind(browserAPI.storage.local), [keys]);
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
        }
        return true;
    });
}

function getGainValue(dB) {
    const n = normalizeDb(dB);
    return Math.pow(10, n / 20);
}

function needsAudioRoute() {
    return !tc.vars.isBlocked && (tc.vars.mono || getGainValue(tc.vars.dB) > 1);
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

function getBoostLimitInfo() {
    if (tc.vars.isBlocked) return { boostLimited: false, maxDb: MAX_DB, reason: "", note: "" };

    try {
        for (const el of document.querySelectorAll('audio, video')) {
            const reason = getBoostLimitReason(el);
            if (reason) {
                return {
                    boostLimited: true,
                    maxDb: 0,
                    reason,
                    note: BOOST_LIMIT_NOTES[reason] || BOOST_LIMIT_NOTES.fallback
                };
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`boost limit check failed: ${e.message}`, 3);
    }

    return { boostLimited: false, maxDb: MAX_DB, reason: "", note: "" };
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
    const gain = getGainValue(tc.vars.dB);
    const limitReason = isLikelyRestrictedMedia(element) ? "restricted" : reason;

    if (element.dataset.vcFallback !== 'true') {
        try {
            element.__vc_originalVolume = gain > 1 ? 1 : element.volume;
        } catch (e) {}
        element.dataset.vcFallback = 'true';
    }
    if (limitReason) element.dataset.vcFallbackReason = limitReason;

    try {
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
    } catch (e) {}

    delete element.__vc_originalVolume;
    delete element.dataset.vcFallback;
    delete element.dataset.vcFallbackReason;
}

function syncPageAudioHook() {
    try {
        window.postMessage({
            source: PAGE_BRIDGE_SOURCE,
            target: PAGE_BRIDGE_TARGET,
            command: "setState",
            enabled: !tc.vars.isBlocked,
            dB: tc.vars.isBlocked ? 0 : normalizeDb(tc.vars.dB),
            mono: !tc.vars.isBlocked && tc.vars.mono,
            debugMode: tc.settings.debugMode
        }, "*");
    } catch (e) {
        if (tc.settings.debugMode) log(`page audio sync failed: ${e.message}`, 3);
    }
}

function applyState() {
    enforceBoostLimit();
    syncPageAudioHook();

    const audioCtx = tc.vars.audioCtx;
    const gainNode = tc.vars.gainNode;
    const isEnabled = !tc.vars.isBlocked;
    const targetGain = isEnabled ? getGainValue(tc.vars.dB) : 1.0;

    if (gainNode && audioCtx) {
        const now = audioCtx.currentTime;
        gainNode.gain.value = targetGain;

        if (audioCtx.state === 'running') {
            try {
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(targetGain, now);
            } catch (e) {
                if (tc.settings.debugMode) log(`applyState schedule failed: ${e.message}`, 2);
            }
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
    try {
        const routeNeeded = needsAudioRoute();
        const gain = getGainValue(tc.vars.dB);
        for (const el of document.querySelectorAll('audio, video')) {
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

            if (!routeNeeded && !tc.vars.isBlocked && gain < 1) {
                applyFallbackVolume(el);
            } else if (el.dataset.vcFallback === 'true') {
                if (gain === 1 && !tc.vars.mono) clearFallbackVolume(el);
                else applyFallbackVolume(el);
            }

            if (routeNeeded && isMediaPlaying(el) && isAudibleMediaElement(el)) {
                connectOutput(el);
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`applyState fallback loop failed: ${e.message}`, 3);
    }

    if (!needsAudioRoute()) setTimeout(suspendAudioContextIfIdle, 250);
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

function ensurePageBridgeResync() {
    if (pageBridgeResyncInterval !== null) return;
    pageBridgeResyncInterval = setInterval(syncPageAudioHook, PAGE_BRIDGE_RESYNC_MS);
}

function suspendAudioContextIfIdle() {
    if (!tc.vars.audioCtx || tc.vars.audioCtx.state !== 'running') return;

    let isPlaying = false;
    for (const el of tc.vars.mediaElements || []) {
        // Clean up elements that have been removed from the DOM.
        if (!el.isConnected) {
            tc.vars.mediaElements.delete(el);
            continue;
        }
        if (isMediaPlaying(el) && isAudibleMediaElement(el)) {
            isPlaying = true;
            break;
        }
    }

    if (!isPlaying) {
        tc.vars.audioCtx.suspend();
    }
}

function registerMediaElement(element) {
    if (!element || isPageAudioManaged(element) || element.dataset.vcWatched === "true" || element.dataset.vcHooked === "true") return;

    element.dataset.vcWatched = "true";
    element.addEventListener('encrypted', () => {
        element.dataset.vcRestrictedMedia = "true";
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
    element.addEventListener('pause', () => setTimeout(suspendAudioContextIfIdle, 250), { passive: true });
    element.addEventListener('ended', () => setTimeout(suspendAudioContextIfIdle, 250), { passive: true });
    element.addEventListener('emptied', () => setTimeout(suspendAudioContextIfIdle, 250), { passive: true });

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
            if (tc.vars.audioCtx.state === 'running') applyState();
        };
    }

    if (!tc.vars.gainNode) createGainNode();

    // Ensure the tracking set exists
    if (!tc.vars.mediaElements) tc.vars.mediaElements = new Set();

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
                // createMediaElementSource can fail if the element is already connected elsewhere or due to browser restrictions
                log(`createMediaElementSource failed: ${e && e.message}`, 2);
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

            // Attach listeners for any event that stops playback
            element.addEventListener('volumechange', checkSuspend);
            element.addEventListener('pause', checkSuspend);
            element.addEventListener('ended', checkSuspend);
            element.addEventListener('emptied', checkSuspend);

            // Remove any fallback adjustments we may have made earlier
            if (element.dataset.vcFallback === 'true') {
                try {
                    if (element.__vc_originalVolume !== undefined) element.volume = element.__vc_originalVolume;
                } catch (e) {}
                delete element.__vc_originalVolume;
                delete element.dataset.vcFallback;
                delete element.dataset.vcFallbackReason;
            }

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
    if (!url) return "";
    let domain = url.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0].split(':')[0];
    return domain.toLowerCase();
} 

function normalizeSavedDomain(value) {
    if (!value) return "";
    let domain = String(value).trim().toLowerCase();
    domain = domain.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0].split(':')[0];
    return domain;
}

function domainMatchesSaved(domain, savedDomain) {
    const saved = normalizeSavedDomain(savedDomain);
    return Boolean(domain && saved && (domain === saved || domain.endsWith(`.${saved}`)));
}

function getSiteSettingsKey(siteSettings, domain) {
    if (!siteSettings || !domain) return null;
    if (siteSettings[domain]) return domain;

    return Object.keys(siteSettings)
        .filter(savedDomain => domainMatchesSaved(domain, savedDomain))
        .sort((a, b) => b.length - a.length)[0] || null;
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
        initWhenReady();
    } catch (e) {
        if (tc.settings.debugMode) log(`start() storage read failed: ${e && e.message}`, 2);
    }
}

start();

// Keep content script state in sync when settings change in the extension UI
if (browserAPI && browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (tc.settings.debugMode) log(`onChanged: keys=[${Object.keys(changes).join(',')}]`, 4);

        // If whitelist/blacklist mode, lists, or remembered sites changed, re-evaluate whether this page should be blocked
        if (changes.whitelistMode || changes.fqdns || changes.whitelist || changes.siteSettings) {
            start();
        }

        // If per-site settings changed, apply them if they affect this domain
        if (changes.siteSettings) {
            const currentDomain = extractRootDomain(window.location.href);
            storageGet({ siteSettings: {} }).then((data) => {
                const siteSettingsKey = getSiteSettingsKey(data.siteSettings, currentDomain);
                if (siteSettingsKey) {
                    const s = data.siteSettings[siteSettingsKey];
                    if (s.volume !== undefined) tc.vars.dB = normalizeDb(s.volume);
                    if (s.mono !== undefined) tc.vars.mono = s.mono;
                    if (tc.settings.debugMode) log(`siteSettings updated for ${currentDomain} via ${siteSettingsKey}: dB=${tc.vars.dB}, mono=${tc.vars.mono}`, 4);
                    applyState();
                    // Ensure audio nodes exist for any existing media elements
                    try {
                        init();
                        for (const el of document.querySelectorAll('audio, video')) registerMediaElement(el);
                    } catch (e) {
                        if (tc.settings.debugMode) log(`re-hook after siteSettings failed: ${e.message}`, 3);
                    }
                } else {
                    if (tc.settings.debugMode) log('siteSettings change did not affect this domain', 4);
                }
            }).catch((e) => {
                if (tc.settings.debugMode) log(`siteSettings storage read failed: ${e && e.message}`, 2);
            });
        }

        // Update debug mode live
        if (changes.debugMode) {
            tc.settings.debugMode = !!changes.debugMode.newValue;
            syncPageAudioHook();
        }
    });
} 
