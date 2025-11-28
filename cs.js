// 1. Safe API Detection (checks both namespace and undefined)
const browserAPI = (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));

var tc = {
  settings: { 
      logLevel: 4,
      debugMode: false // Will be updated from storage
  },
  vars: {
    dB: 0,
    mono: false,
    audioCtx: undefined, 
    gainNode: undefined,
    isBlocked: false 
  },
};

const logTypes = ["ERROR", "WARNING", "INFO", "DEBUG"];
function log(msg, level = 4) {
  if (tc.settings.logLevel >= level) console.log(`[VolumeControl] ${logTypes[level-2]}: ${msg}`);
}

// --- MESSAGE LISTENER ---
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
                sendResponse({}); // Confirm receipt to close async channel
                break;
            
            case "getVolume": 
                sendResponse({ response: tc.vars.dB }); 
                break;
            
            case "setMono": 
                tc.vars.mono = msg.mono; 
                applyState(); 
                sendResponse({}); // Confirm receipt to close async channel
                break;
            
            case "getMono": 
                sendResponse({ response: tc.vars.mono }); 
                break;
        }
        return true; // Indicates async response
    });
}

// --- AUDIO LOGIC ---

function getGainValue(dB) {
    if (isNaN(dB)) return 1.0;
    return Math.pow(10, dB / 20);
}

function applyState() {
    if (!tc.vars.gainNode || !tc.vars.audioCtx) return;

    const targetGain = getGainValue(tc.vars.dB);
    const now = tc.vars.audioCtx.currentTime;

    // 1. Force value immediately (safest for responsiveness)
    tc.vars.gainNode.gain.value = targetGain;

    // 2. Schedule value if engine is running (overrides automation)
    if (tc.vars.audioCtx.state === 'running') {
        try {
            tc.vars.gainNode.gain.cancelScheduledValues(now);
            tc.vars.gainNode.gain.setValueAtTime(targetGain, now);
        } catch(e) {}
    }

    // 3. Apply Mono
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
    // Prevent double hooking
    if (element.dataset.vcHooked === "true") return;

    // Init Audio Context if missing
    if (!tc.vars.audioCtx) {
        tc.vars.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // Listener: Re-apply settings when audio engine wakes up (Autoplay fix)
        tc.vars.audioCtx.onstatechange = () => {
            if (tc.vars.audioCtx.state === 'running') applyState();
        };
    }
    
    if (!tc.vars.gainNode) createGainNode();

    try {
        log(`Attempting hook: ${element.tagName}`, 4);

        let source;
        
        // --- FIREFOX FIX: Unwrap Xray Wrapper ---
        // Firefox wraps DOM elements in a security layer that AudioContext rejects.
        // We access the underlying object using .wrappedJSObject.
        if (typeof element.wrappedJSObject !== 'undefined') {
            try {
                source = tc.vars.audioCtx.createMediaElementSource(element.wrappedJSObject);
            } catch(e) { log("Unwrap failed, trying direct...", 3); }
        }

        // Standard Chrome/Edge Fallback
        if (!source) {
            source = tc.vars.audioCtx.createMediaElementSource(element);
        }

        // Connect Graph
        source.connect(tc.vars.gainNode);
        tc.vars.gainNode.connect(tc.vars.audioCtx.destination);
        
        // Mark as Success
        element.dataset.vcHooked = "true";
        applyState();
        
        // Visual Debug: Green Border (Only if enabled)
        if (tc.settings.debugMode) {
            element.style.border = "2px solid #00ff00"; 
        } else {
            element.style.border = ""; 
        }
        log("Hook Success!", 4);

    } catch (e) {
        // Visual Debug: Red Border (Only if enabled)
        if (tc.settings.debugMode) {
            element.style.border = "5px solid red"; 
        }
        
        // Note: It is normal for this to fail on some iframes or cross-origin media
        // log(`Hook FAILED: ${e.message}`, 1);
    }
}

// --- INITIALIZATION ---

function init() {
    if (document.body.classList.contains("vc-init")) return;
    
    // 1. Hook existing elements
    document.querySelectorAll("audio, video").forEach(connectOutput);

    // 2. Watch for new elements (SPA/YouTube support)
    new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(n => {
            if (n.nodeType === 1) {
                if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') connectOutput(n);
                else if (n.querySelectorAll) n.querySelectorAll('audio, video').forEach(connectOutput);
            }
        }));
    }).observe(document.body, { childList: true, subtree: true });

    // 3. Failsafe: Resume AudioContext on user interaction
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
    // Safety: If API is missing (restricted frame), exit to prevent crash
    if (!browserAPI) return;

    browserAPI.storage.local.get({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {}, debugMode: false }, (data) => {
        // Prevent random permission errors
        if (browserAPI.runtime.lastError) return;

        // Apply Debug Preference
        if (data.debugMode !== undefined) {
            tc.settings.debugMode = data.debugMode;
        }

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

// Run immediately (document_start)
if (document.readyState === "loading") {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}