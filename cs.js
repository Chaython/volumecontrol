const browserAPI = (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));
const PAGE_BRIDGE_SOURCE = "volume-control-extension";
const PAGE_BRIDGE_TARGET = "volume-control-page-audio";

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

if (browserAPI) {
    browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (tc.vars.isBlocked) return;
        switch (msg.command) {
            case "checkExclusion":
                sendResponse({ status: "active" });
                break;
            case "setVolume":
                tc.vars.dB = msg.dB;
                applyState();
                sendResponse({});
                break;
            case "getVolume":
                sendResponse({ response: tc.vars.dB });
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
    const n = Number(dB);
    if (Number.isNaN(n)) return 1.0;
    return Math.pow(10, n / 20);
}

function syncPageAudioHook() {
    try {
        window.postMessage({
            source: PAGE_BRIDGE_SOURCE,
            target: PAGE_BRIDGE_TARGET,
            command: "setState",
            enabled: !tc.vars.isBlocked,
            dB: tc.vars.isBlocked ? 0 : tc.vars.dB,
            mono: !tc.vars.isBlocked && tc.vars.mono,
            debugMode: tc.settings.debugMode
        }, "*");
    } catch (e) {
        if (tc.settings.debugMode) log(`page audio sync failed: ${e.message}`, 3);
    }
}

function applyState() {
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

    // Also update any fallback elements where we couldn't hook into WebAudio
    try {
        for (const el of document.querySelectorAll('audio, video')) {
            if (el.dataset.vcFallback === 'true') {
                try {
                    const gain = targetGain;
                    const newVol = Math.min(1, Math.max(0, gain));
                    el.volume = newVol;
                } catch (e) {
                    if (tc.settings.debugMode) log(`applyState fallback update failed: ${e.message}`, 3);
                }
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`applyState fallback loop failed: ${e.message}`, 3);
    }
}

function createGainNode() {
    if (!tc.vars.audioCtx) return;

    if (!tc.vars.gainNode) {
        tc.vars.gainNode = tc.vars.audioCtx.createGain();
        tc.vars.gainNode.channelInterpretation = "speakers";
    }
    applyState();
}

function connectOutput(element) {
    if (element.dataset.vcHooked === "true") return;

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
            const checkSuspend = () => {
                let isPlaying = false;
                for (const el of tc.vars.mediaElements) {
                    // Clean up elements that have been removed from the DOM (prevents memory leaks)
                    if (!el.isConnected) {
                        tc.vars.mediaElements.delete(el);
                        continue;
                    }
                    if (!el.paused && !el.ended) {
                        isPlaying = true;
                        break;
                    }
                }
                
                if (!isPlaying && tc.vars.audioCtx && tc.vars.audioCtx.state === 'running') {
                    tc.vars.audioCtx.suspend();
                }
            };

            // Attach listeners for any event that stops playback
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
            }

            applyState();
            checkSuspend();

            if (tc.settings.debugMode) element.style.border = "2px solid #00ff00";
            else element.style.border = "";
            log("Hook Success!", 4);
        } else {
            // Fallback: if we can't create an audio node, adjust element.volume directly so user notices changes
            if (element.dataset.vcFallback !== 'true') {
                try {
                    element.__vc_originalVolume = element.volume;
                } catch (e) {}
                element.dataset.vcFallback = 'true';
            }
            // Apply current state to fallback element
            try {
                const gain = getGainValue(tc.vars.dB);
                // map gain to 0..1 for element.volume (best-effort)
                const newVol = Math.min(1, Math.max(0, gain));
                element.volume = newVol;
                if (tc.settings.debugMode) element.style.border = "2px dashed #ffa500";
            } catch (e) {
                log(`Fallback volume set failed: ${e && e.message}`, 2);
            }
            log("Hook fallback applied (element.volume scaled)", 3);
        }

    } catch (e) {
        log(`connectOutput outer failure: ${e && e.message}`, 1);
        if (tc.settings.debugMode) element.style.border = "5px solid red";
    }
}

function init() {
    if (!document.body) return false;
    if (document.body.classList.contains("vc-init")) return true;

    for (const el of document.querySelectorAll("audio, video")) connectOutput(el);

    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) {
                    if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') connectOutput(n);
                    else if (n.querySelectorAll) for (const el of n.querySelectorAll('audio, video')) connectOutput(el);

                    // Also check for media elements inside shadow roots (YouTube may use shadow DOM-ish patterns)
                    try {
                        if (n.shadowRoot && n.shadowRoot.querySelectorAll) {
                            for (const el of n.shadowRoot.querySelectorAll('audio, video')) connectOutput(el);
                        }
                    } catch (e) {}
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    document.body.classList.add("vc-init");
    return true;
} 

function initWhenReady() {
    if (document.body) {
        init();
        try {
            for (const el of document.querySelectorAll('audio, video')) {
                connectOutput(el);
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

function getSiteSettingsKey(siteSettings, domain) {
    if (!siteSettings || !domain) return null;
    if (siteSettings[domain]) return domain;

    return Object.keys(siteSettings)
        .filter(savedDomain => domain === savedDomain || domain.endsWith(`.${savedDomain}`))
        .sort((a, b) => b.length - a.length)[0] || null;
}

function start() {
    if (!browserAPI) return;

    browserAPI.storage.local.get({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {}, debugMode: false }, (data) => {
        if (browserAPI.runtime.lastError) return;

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
            if (data.fqdns.some(d => currentDomain.includes(d))) blocked = true;
        }

        // Debug: log final decision
        if (tc.settings.debugMode) log(`start(): blocked=${blocked}`, 4);

        // Ensure the content script's blocked flag reflects the current state (clear it when unblocked)
        tc.vars.isBlocked = blocked;
        if (blocked) {
            applyState();
            return;
        }

        const siteSettingsKey = getSiteSettingsKey(data.siteSettings, currentDomain);
        if (siteSettingsKey) {
            const s = data.siteSettings[siteSettingsKey];
            if (s.volume !== undefined) tc.vars.dB = parseInt(s.volume, 10) || 0;
            if (s.mono !== undefined) tc.vars.mono = s.mono;
        }

        applyState();
        initWhenReady();
    });
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
            browserAPI.storage.local.get({ siteSettings: {} }, (data) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) return;
                const siteSettingsKey = getSiteSettingsKey(data.siteSettings, currentDomain);
                if (siteSettingsKey) {
                    const s = data.siteSettings[siteSettingsKey];
                    if (s.volume !== undefined) tc.vars.dB = parseInt(s.volume, 10) || 0;
                    if (s.mono !== undefined) tc.vars.mono = s.mono;
                    if (tc.settings.debugMode) log(`siteSettings updated for ${currentDomain} via ${siteSettingsKey}: dB=${tc.vars.dB}, mono=${tc.vars.mono}`, 4);
                    applyState();
                    // Ensure audio nodes exist for any existing media elements
                    try {
                        init();
                        for (const el of document.querySelectorAll('audio, video')) connectOutput(el);
                    } catch (e) {
                        if (tc.settings.debugMode) log(`re-hook after siteSettings failed: ${e.message}`, 3);
                    }
                } else {
                    if (tc.settings.debugMode) log('siteSettings change did not affect this domain', 4);
                }
            });
        }

        // Update debug mode live
        if (changes.debugMode) {
            tc.settings.debugMode = !!changes.debugMode.newValue;
            syncPageAudioHook();
        }
    });
} 
