// cs.js - Volume Control (Fixed checkExclusion)
const browserAPI = window.browser || window.chrome;

var tc = {
  settings: {
    logLevel: 0, 
    defaultLogLevel: 4,
  },
  vars: {
    dB: 0,
    mono: false,
    audioCtx: undefined, 
    gainNode: undefined,
    isBlocked: false // New flag to track status
  },
};

const logTypes = ["ERROR", "WARNING", "INFO", "DEBUG"];

function log(message, level = tc.settings.defaultLogLevel) {
  if (tc.settings.logLevel >= level) {
    console.log(`[VolumeControl] ${logTypes[level - 2]}: ${message}`);
  }
}

// --- MESSAGE LISTENER (Global Scope) ---
// We listen immediately so the popup never thinks we are "Excluded" due to timing issues.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // If the site is legitimately blocked, we ignore requests (triggering lastError in popup)
    if (tc.vars.isBlocked) return;

    switch (msg.command) {
        case "checkExclusion":
            // Just confirm we are alive.
            sendResponse({ status: "active" });
            break;
        case "setVolume":
            tc.vars.dB = msg.dB;
            applyState();
            break;
        case "getVolume":
            sendResponse({ response: tc.vars.dB });
            break;
        case "setMono":
            tc.vars.mono = msg.mono;
            applyState();
            break;
        case "getMono":
            sendResponse({ response: tc.vars.mono });
            break;
    }
    // Return true to indicate we might respond asynchronously (good practice)
    return true;
});

// --- CORE VOLUME LOGIC ---

function getGainValue(dB) {
    if (isNaN(dB)) return 1.0;
    return Math.pow(10, dB / 20);
}

function applyState() {
    if (!tc.vars.gainNode || !tc.vars.audioCtx) return;

    const targetGain = getGainValue(tc.vars.dB);
    const now = tc.vars.audioCtx.currentTime;

    tc.vars.gainNode.gain.value = targetGain;

    if (tc.vars.audioCtx.state === 'running') {
        try {
            tc.vars.gainNode.gain.cancelScheduledValues(now);
            tc.vars.gainNode.gain.setValueAtTime(targetGain, now);
        } catch(e) {}
    }

    if (tc.vars.mono) {
        tc.vars.gainNode.channelCountMode = "explicit";
        tc.vars.gainNode.channelCount = 1;
    } else {
        tc.vars.gainNode.channelCountMode = "max";
        tc.vars.gainNode.channelCount = 2;
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

    try {
        const source = tc.vars.audioCtx.createMediaElementSource(element);
        source.connect(tc.vars.gainNode);
        tc.vars.gainNode.connect(tc.vars.audioCtx.destination);
        
        element.dataset.vcHooked = "true";
        applyState(); 
        log(`Hooked ${element.tagName}`, 5);
    } catch (e) {
        // Ignored
    }
}

// --- INITIALIZATION ---

function init() {
    if (document.body.classList.contains("vc-init")) return;
    
    document.querySelectorAll("audio, video").forEach(connectOutput);

    new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(n => {
            if (n.nodeType === 1) {
                if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') connectOutput(n);
                else if (n.querySelectorAll) n.querySelectorAll('audio, video').forEach(connectOutput);
            }
        }));
    }).observe(document.body, { childList: true, subtree: true });

    document.addEventListener('click', () => {
        if (tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') {
            tc.vars.audioCtx.resume().then(applyState);
        }
    }, { passive: true });

    document.body.classList.add("vc-init");
}

function extractRootDomain(url) {
    if(!url) return "";
    let domain = url.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0].split(':')[0];
    return domain.toLowerCase();
}

// --- ENTRY POINT ---

function start() {
    browserAPI.storage.local.get({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} }, (data) => {
        const currentDomain = extractRootDomain(window.location.href);

        // 1. Check Exclusion/Inclusion Lists
        let blocked = false;
        if (data.whitelistMode) {
            if (!data.whitelist.some(d => currentDomain.includes(d))) blocked = true;
        } else {
            if (data.fqdns.some(d => currentDomain.includes(d))) blocked = true;
        }

        if (blocked) {
            tc.vars.isBlocked = true;
            // We do NOT call init(). The listener up top will see isBlocked=true 
            // and ignore messages, causing the popup to correctly show "Excluded".
            return;
        }

        // 2. Restore Saved Volume/Mono
        if (data.siteSettings && data.siteSettings[currentDomain]) {
            const s = data.siteSettings[currentDomain];
            if (s.volume !== undefined) tc.vars.dB = parseInt(s.volume);
            if (s.mono !== undefined) tc.vars.mono = s.mono;
        }

        // 3. Start Extension
        init();
    });
}

if (document.readyState === "loading") {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}