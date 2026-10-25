// ==UserScript==
// @name         Volume Control — Per-Site Volume Booster
// @namespace    https://github.com/Chaython/volumecontrol
// @version      __VERSION__
// @description  Real per-site volume control from the Volume Control browser extension: ±32 dB boost, music/adaptive normalizer, mono down-mix and a safety limiter — running the extension's actual page-audio-hook engine on any site.
// @author       Chaython
// @license      ISC
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @icon         https://chaython.github.io/volumecontrol/vc/ico.svg
// @homepageURL  https://chaython.github.io/volumecontrol/
// @supportURL   https://github.com/Chaython/volumecontrol/issues
// @downloadURL  https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js
// @updateURL    https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js
// ==/UserScript==

/*
 * Tampermonkey edition of Volume Control (https://github.com/Chaython/volumecontrol)
 *
 * This is NOT a re-implementation. The audio engine below is the extension's
 * real page-audio-hook.js (MAIN-world content script), embedded verbatim and
 * injected into the page exactly the way the extension injects it. This
 * userscript replaces only the surrounding machinery:
 *
 *   extension content script (cs.js)  →  this controller (bridge + settings)
 *   chrome.storage per-site settings   →  GM storage keyed by hostname
 *   browser-action popup               →  floating popup (same popup.css)
 *   toolbar badge                      →  badge on the floating button
 *   browser commands (hotkeys)         →  Alt+Shift+… page keybindings
 *
 * Bridge protocol (window.postMessage, token-guarded, v3) is identical to the
 * extension's: setState / heartbeat / requestState / meterUpdate /
 * pageRestrictionChanged / locationChanged.
 *
 * Canonical home: tampermonkey/ at the repository root. Rebuilt by
 * `node scripts/build-userscript.mjs` (also runs in CI on every engine
 * change and on every release), served from the website at
 * /tampermonkey/volume-control.user.js and attached to GitHub releases.
 */

(function () {
    'use strict';

    // ============================================================= constants
    // (mirror shared.js / manifest.json)
    var MIN_DB = -32;
    var MAX_DB = 32;
    var BRIDGE_VERSION = 3;
    var BRIDGE_SOURCE = 'volume-control-extension';
    var BRIDGE_TARGET = 'volume-control-page-audio';
    var HEARTBEAT_MS = 3000;          // cs.js PAGE_BRIDGE_HEARTBEAT_MS
    var HOOK_KEY = '__volumeControlPageAudioHook';

    var IS_TOP_FRAME = (function () {
        try { return window.self === window.top; } catch (e) { return false; }
    })();

    // The real page-audio-hook.js, embedded verbatim by the build script.
    var ENGINE_SOURCE = "__ENGINE_SOURCE__";
    // The extension's popup.css — the .vc-popup-scoped port (the real popup.css
    // targets html/body, which cannot match inside the shadow root below).
    var POPUP_CSS = "__POPUP_CSS__";

    // ============================================================= storage
    // GM storage (global, shared across sites) with a localStorage fallback so
    // the script also runs under Violentmonkey/Greasemonkey or bare <script>.
    var store = {
        get: function (key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    var v = GM_getValue(key);
                    return v === undefined ? fallback : v;
                }
                var raw = localStorage.getItem('vc-tm:' + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (e) { return fallback; }
        },
        set: function (key, value) {
            try {
                if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
                localStorage.setItem('vc-tm:' + key, JSON.stringify(value));
            } catch (e) { /* storage full / blocked — ignore */ }
        },
        del: function (key) {
            try {
                if (typeof GM_deleteValue === 'function') { GM_deleteValue(key); return; }
                localStorage.removeItem('vc-tm:' + key);
            } catch (e) { /* ignore */ }
        }
    };

    // ============================================================= helpers
    function normalizeDb(value) {
        var n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
    }
    function formatMeterDb(value) {
        var n = Number(value);
        if (!Number.isFinite(n) || n <= -90) return '\u2212\u221E dBFS';
        return n.toFixed(1) + ' dBFS';
    }
    function makeToken() {
        var s = '';
        try {
            if (unsafeWindow.crypto && unsafeWindow.crypto.getRandomValues) {
                var a = new Uint8Array(16);
                unsafeWindow.crypto.getRandomValues(a);
                for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
                return s;
            }
        } catch (e) { /* fall through */ }
        for (var j = 0; j < 32; j++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    // ============================================================= settings
    // Same per-site shape the extension persists (volume/mono/mute/normalize),
    // plus the site's "Active" (exclusion) flag and the global normalizer
    // configuration (options-page defaults).
    var DEFAULT_NORMALIZER_CONFIG = { mode: 'music', targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 600, experimentalTruePeak: false };

    function hostname() { return location.hostname || location.host || 'localhost'; }
    var HOST = hostname();
    var SITE_KEY = 'vc-site:' + HOST;
    var EXCLUDED_KEY = 'vc-excluded:' + HOST;

    // ---- site access lists (options.html "Blocked Sites"/"Allowed Sites") --
    var LISTS_KEY = 'vc-lists';
    var lists = (function () {
        var raw = store.get(LISTS_KEY, null);
        var merged = { blocklist: [], whitelist: [], whitelistMode: false };
        if (raw && typeof raw === 'object') {
            if (Array.isArray(raw.blocklist)) merged.blocklist = raw.blocklist.map(String);
            if (Array.isArray(raw.whitelist)) merged.whitelist = raw.whitelist.map(String);
            merged.whitelistMode = !!raw.whitelistMode;
        }
        return merged;
    })();
    function persistLists() { store.set(LISTS_KEY, lists); }
    function listEntryMatches(entry, host) {
        // options.js blocklistMatches(): the domain part decides (any path in
        // an entry is informational); matches the host and its subdomains.
        var domain = String(entry || '').split('/')[0].trim().toLowerCase();
        if (!domain) return false;
        return domain === host || host.endsWith('.' + domain);
    }
    function siteBlockedByLists() {
        if (lists.whitelistMode) {
            for (var i = 0; i < lists.whitelist.length; i++) {
                if (listEntryMatches(lists.whitelist[i], HOST)) return false;
            }
            return true;          // whitelist mode: unlisted sites are off
        }
        for (var j = 0; j < lists.blocklist.length; j++) {
            if (listEntryMatches(lists.blocklist[j], HOST)) return true;
        }
        return false;
    }
    // one-time migration: the pre-7.1.4 per-site "Active off" flag becomes a
    // blocklist entry (the extension migrated its legacy allow list likewise)
    (function migrateExcludedFlag() {
        if (store.get(EXCLUDED_KEY, false)) {
            if (!lists.blocklist.some(function (e) { return listEntryMatches(e, HOST); })) {
                lists.blocklist.push(HOST);
            }
            persistLists();
        }
        store.del(EXCLUDED_KEY);
    })();

    // ---- debug defaults + per-site overrides (options.html Debug section) --
    var DEBUG_DEFAULTS_KEY = 'vc-debug-defaults';
    var DEBUG_SITE_KEY = 'vc-debug:' + HOST;
    function normalizeDebugConfig(raw) {
        var out = { debugMode: false, forceDrmCapture: false, forceCorsCapture: false, debugRouteMode: 'auto' };
        if (raw && typeof raw === 'object') {
            out.debugMode = !!raw.debugMode;
            out.forceDrmCapture = !!raw.forceDrmCapture;
            out.forceCorsCapture = !!raw.forceCorsCapture;
            out.debugRouteMode = raw.debugRouteMode === 'webaudio' || raw.debugRouteMode === 'native'
                ? raw.debugRouteMode : 'auto';
        }
        return out;
    }
    var debugDefaults = normalizeDebugConfig(store.get(DEBUG_DEFAULTS_KEY, null));
    var siteDebug = normalizeDebugConfig(store.get(DEBUG_SITE_KEY, null) || null);
    function effectiveDebugConfig() {
        // options.html semantics: per-site overrides persist independently;
        // DRM/CORS force when either the global default or the site override
        // is on; the route prefers the site override, then the global default.
        return {
            debugMode: debugDefaults.debugMode || !!(siteDebug && siteDebug.debugMode),
            forceDrmCapture: debugDefaults.forceDrmCapture || !!(siteDebug && siteDebug.forceDrmCapture),
            forceCorsCapture: debugDefaults.forceCorsCapture || !!(siteDebug && siteDebug.forceCorsCapture),
            debugRouteMode: (siteDebug && siteDebug.debugRouteMode !== 'auto') ? siteDebug.debugRouteMode
                : debugDefaults.debugRouteMode
        };
    }
    function applyDebugHighlight(on) {
        // "Show Debug Highlight" — the options-page debug border around hooked
        // <video> elements (same rule as the demo site's globals.css), applied
        // at page level because the media lives outside the shadow root.
        try {
            document.documentElement.classList.toggle('vc-debug-highlight', !!on);
            if (on && !document.getElementById('vc-debug-highlight-style')) {
                var st = document.createElement('style');
                st.id = 'vc-debug-highlight-style';
                st.textContent = 'html.vc-debug-highlight video{outline:2px solid #2e7d32;outline-offset:2px;}';
                (document.head || document.documentElement).appendChild(st);
            }
        } catch (e) { /* page blocks styling */ }
    }
    applyDebugHighlight(effectiveDebugConfig().debugMode);

    var siteSettings = store.get(SITE_KEY, null) || null;   // {remember, volume, mono, muted, normalizer}
    var excluded = siteBlockedByLists();
    var normalizerConfig = (function () {
        var cfg = store.get('vc-normalizer-config', null);
        if (!cfg || typeof cfg !== 'object') return DEFAULT_NORMALIZER_CONFIG;
        var merged = {};
        for (var k in DEFAULT_NORMALIZER_CONFIG) merged[k] = DEFAULT_NORMALIZER_CONFIG[k];
        for (var k2 in cfg) if (k2 in merged) merged[k2] = cfg[k2];
        if (merged.mode !== 'music' && merged.mode !== 'adaptive') merged.mode = 'music';
        merged.targetDb = Math.max(-30, Math.min(-6, Number(merged.targetDb) || -16));
        merged.maxBoostDb = Math.max(0, Math.min(24, Number(merged.maxBoostDb) || 12));
        merged.ceilingDb = Math.max(-6, Math.min(-0.1, Number(merged.ceilingDb) || -1));
        merged.responseMs = Math.max(100, Math.min(3000, Number(merged.responseMs) || 600));
        return merged;
    })();

    // Live state (what the engine receives).
    var state = {
        enabled: !excluded,
        dB: siteSettings && siteSettings.remember ? normalizeDb(siteSettings.volume) : 0,
        mono: !!(siteSettings && siteSettings.remember && siteSettings.mono),
        muted: !!(siteSettings && siteSettings.remember && siteSettings.muted),
        normalizerEnabled: !!(siteSettings && siteSettings.remember && siteSettings.normalizer)
    };
    var remembered = !!(siteSettings && siteSettings.remember);
    var restriction = '';            // '' | 'restricted' | 'cross-origin'
    var meter = { peakDb: -Infinity, normalizerGainDb: 0 };
    var meterListeners = [];

    function persistSite() {
        if (!remembered) { store.del(SITE_KEY); return; }
        store.set(SITE_KEY, {
            remember: true,
            volume: state.dB,
            mono: state.mono,
            muted: state.muted,
            normalizer: state.normalizerEnabled
        });
    }

    // ============================================================= bridge
    var PAGE_BRIDGE_TOKEN = makeToken();

    function currentState() {
        return {
            enabled: state.enabled,
            dB: state.dB,
            mono: state.mono,
            muted: state.muted,
            normalizerEnabled: state.normalizerEnabled,
            normalizerConfig: normalizerConfig,
            debugMode: effectiveDebugConfig().debugMode,
            forceDrmCapture: effectiveDebugConfig().forceDrmCapture,
            forceCorsCapture: effectiveDebugConfig().forceCorsCapture,
            debugRouteMode: effectiveDebugConfig().debugRouteMode
        };
    }

    function sendState() {
        try {
            var s = currentState();
            var msg = {
                source: BRIDGE_SOURCE,
                target: BRIDGE_TARGET,
                token: PAGE_BRIDGE_TOKEN,
                command: 'setState',
                version: BRIDGE_VERSION
            };
            for (var k in s) msg[k] = s[k];
            window.postMessage(msg, '*');
        } catch (e) { /* page tearing down */ }
    }

    function sendHeartbeat() {
        try {
            window.postMessage({
                source: BRIDGE_SOURCE,
                target: BRIDGE_TARGET,
                token: PAGE_BRIDGE_TOKEN,
                command: 'heartbeat',
                version: BRIDGE_VERSION
            }, '*');
        } catch (e) { /* ignore */ }
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        var data = event.data;
        if (!data || data.source !== BRIDGE_TARGET || data.target !== BRIDGE_SOURCE) return;
        if (data.token !== PAGE_BRIDGE_TOKEN) return;

        if (data.command === 'requestState') {
            sendState();
        } else if (data.command === 'locationChanged') {
            // SPA navigation inside the same site — nothing changes for us
            // (settings are per-hostname), but re-sync in case the hook reset.
            sendState();
        } else if (data.command === 'pageRestrictionChanged') {
            restriction = data.restriction === 'restricted' ? 'restricted'
                : data.restriction === 'cross-origin' ? 'cross-origin' : '';
            notifyUI();
        } else if (data.command === 'meterUpdate') {
            var peak = Number(data.peakDb);
            var gain = Number(data.normalizerGainDb);
            meter.peakDb = Number.isFinite(peak) ? peak : -Infinity;
            meter.normalizerGainDb = Number.isFinite(gain) ? gain : 0;
            for (var i = 0; i < meterListeners.length; i++) {
                try { meterListeners[i](meter); } catch (e) { /* listener died */ }
            }
        }
    });

    // ============================================================= engine
    function hookInstalled() {
        try {
            var w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            return !!(w[HOOK_KEY] && w[HOOK_KEY].installed);
        } catch (e) { return false; }
    }

    function injectEngineInline() {
        // Exactly what the extension does: a MAIN-world <script> at
        // document_start. Blocked by strict page CSP on some sites.
        try {
            var s = document.createElement('script');
            s.textContent = ENGINE_SOURCE;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
            return true;
        } catch (e) { return false; }
    }

    function injectEngineSandbox() {
        // CSP-proof fallback: run the engine in this sandbox but hand it the
        // *page* window, so its prototype patches and history patches apply to
        // the real page (identical observable behavior).
        try {
            var w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            var fn = new Function('window', 'self', 'globalThis', ENGINE_SOURCE);
            fn(w, w, w);
            return true;
        } catch (e) { return false; }
    }

    function bootEngine() {
        if (hookInstalled()) { sendState(); startHeartbeat(); return; }
        injectEngineInline();
        var tries = 0;
        var poll = setInterval(function () {
            tries++;
            if (hookInstalled()) {
                clearInterval(poll);
                sendState();
                startHeartbeat();
            } else if (tries >= 20) {          // ~2s: CSP blocked the inline tag
                clearInterval(poll);
                injectEngineSandbox();
                if (hookInstalled()) { sendState(); startHeartbeat(); }
            }
        }, 100);
        // The engine may also already be mid-install from a previous frame
        // event; always start the heartbeat — it is harmless and the engine
        // reconnects on the first beat after its own 10s timeout.
        setTimeout(startHeartbeat, 2500);
    }

    var heartbeatTimer = null;
    function startHeartbeat() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    }

    // ============================================================= actions
    function setVolume(db) {
        state.dB = Math.max(MIN_DB, Math.min(restriction === 'restricted' ? 0 : MAX_DB, normalizeDb(db)));
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleMute() {
        state.muted = !state.muted;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleMono() {
        if (restriction === 'restricted') return;
        state.mono = !state.mono;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleNormalizer() {
        if (restriction === 'restricted') return;
        state.normalizerEnabled = !state.normalizerEnabled;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleRemember() {
        remembered = !remembered;
        if (remembered) persistSite(); else store.del(SITE_KEY);
        notifyUI();
    }
    function toggleActive() {
        // popup.js/options.js semantics: Active edits the access list that
        // governs this site — the blocklist entry in Blacklist mode, the
        // whitelist entry in Whitelist mode.
        if (lists.whitelistMode) {
            var allowed = lists.whitelist.some(function (e) { return listEntryMatches(e, HOST); });
            lists.whitelist = allowed
                ? lists.whitelist.filter(function (e) { return !listEntryMatches(e, HOST); })
                : lists.whitelist.concat([HOST]);
        } else {
            var blocked = lists.blocklist.some(function (e) { return listEntryMatches(e, HOST); });
            lists.blocklist = blocked
                ? lists.blocklist.filter(function (e) { return !listEntryMatches(e, HOST); })
                : lists.blocklist.concat([HOST]);
        }
        persistLists();
        excluded = siteBlockedByLists();
        state.enabled = !excluded;
        sendState();
        notifyUI();
    }
    function resetSiteSettings() {
        store.del(SITE_KEY);
        store.del(EXCLUDED_KEY);
        lists.blocklist = lists.blocklist.filter(function (e) { return !listEntryMatches(e, HOST); });
        persistLists();
        remembered = false;
        excluded = siteBlockedByLists();
        state.enabled = !excluded; state.dB = 0; state.mono = false;
        state.muted = false; state.normalizerEnabled = false;
        sendState();
        notifyUI();
    }

    // ============================================================= UI (top frame)
    var ui = null;

    function notifyUI() { if (ui) ui.refresh(); }

    function buildUI() {
        var host = document.createElement('div');
        host.id = 'volume-control-tm-host';
        // A real 42x42 box (not a 0x0 point): it is the positioning context
        // for the absolute button (inset 0) and the popup anchor (52px above
        // its bottom edge). Dragging rewrites right/bottom on this host.
        host.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:18px;width:42px;height:42px;';
        var shadow = host.attachShadow({ mode: 'open' });

        var style = document.createElement('style');
        style.textContent = POPUP_CSS + FLOATING_CSS + ADVANCED_CSS;
        shadow.appendChild(style);

        // ---- floating button (the "toolbar icon") ---------------------------
        var btn = document.createElement('button');
        btn.className = 'vc-tm-btn';
        btn.type = 'button';
        btn.title = 'Volume Control (Alt+Shift+P)';
        btn.setAttribute('aria-label', 'Volume Control');
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
            '<path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>' +
            '<path d="M14 8a5 5 0 0 1 0 8M16.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
            '</svg><span class="vc-tm-badge" aria-hidden="true"></span>';
        shadow.appendChild(btn);

        var badge = btn.querySelector('.vc-tm-badge');

        // ---- popup (popup.html structure, popup.css classes) ----------------
        var popupWrap = document.createElement('div');
        popupWrap.className = 'vc-popup-anchor';
        popupWrap.innerHTML = POPUP_HTML + ADVANCED_HTML;
        shadow.appendChild(popupWrap);
        var root = popupWrap.querySelector('.vc-popup.vc-main');
        var advRoot = popupWrap.querySelector('.vc-advanced');
        var content = root.querySelector('#popup-content');

        var slider = root.querySelector('#volume-slider');
        var volumeText = root.querySelector('#volume-text');
        var muteBtn = root.querySelector('#mute-btn');
        var muteLabel = root.querySelector('.mute-label');
        var limitNote = root.querySelector('#volume-limit-note');
        var boostWarning = root.querySelector('#volume-boost-warning');
        var normCheckbox = root.querySelector('#normalizer-checkbox');
        var normNote = root.querySelector('#normalizer-note');
        var normDetails = root.querySelector('#normalizer-details');
        var normGain = root.querySelector('#normalizer-gain');
        var meterFill = root.querySelector('#peak-meter-fill');
        var meterText = root.querySelector('#peak-meter-text');
        var meterEl = root.querySelector('.peak-meter');
        var peakWarn = root.querySelector('#peak-safety-warning');
        var monoCheckbox = root.querySelector('#mono-checkbox');
        var rememberCheckbox = root.querySelector('#remember-checkbox');
        var activeCheckbox = root.querySelector('#enable-checkbox');
        var settingsBtn = root.querySelector('#settings');
        var exclusionMsg = root.querySelector('.exclusion-message');
        var exclusionDetail = root.querySelector('.exclusion-detail');

        // ---- advanced view elements ------------------------------------------
        var advBack = advRoot.querySelector('.vc-adv-back');
        var advMode = advRoot.querySelector('#adv-mode');
        var advTarget = advRoot.querySelector('#adv-target');
        var advBoost = advRoot.querySelector('#adv-boost');
        var advCeiling = advRoot.querySelector('#adv-ceiling');
        var advResponse = advRoot.querySelector('#adv-response');
        var advTruePeak = advRoot.querySelector('#adv-truepeak');
        var advEngine = advRoot.querySelector('#adv-engine-status');
        var advDataNote = advRoot.querySelector('#adv-data-note');
        var advResetAll = advRoot.querySelector('#adv-reset-all');
        // site access + debug override elements (v7.1.4)
        var advListMode = advRoot.querySelector('#adv-list-mode');
        var advAccessStatus = advRoot.querySelector('#adv-access-status');
        var advSiteInput = advRoot.querySelector('#adv-site-input');
        var advSiteAdd = advRoot.querySelector('#adv-site-add');
        var advSiteStatus = advRoot.querySelector('#adv-site-status');
        var advSiteList = advRoot.querySelector('#adv-site-list');
        var advDbgHighlight = advRoot.querySelector('#adv-debug-highlight');
        var advForceDrm = advRoot.querySelector('#adv-force-drm');
        var advForceCors = advRoot.querySelector('#adv-force-cors');
        var advRoute = advRoot.querySelector('#adv-route');
        var advSiteDebug = advRoot.querySelector('#adv-site-debug');
        var advSiteDebugLabel = advRoot.querySelector('#adv-site-debug-label');
        var advSdControls = advRoot.querySelector('#adv-site-debug-controls');
        var advSdHighlight = advRoot.querySelector('#adv-sd-highlight');
        var advSdDrm = advRoot.querySelector('#adv-sd-drm');
        var advSdCors = advRoot.querySelector('#adv-sd-cors');
        var advSdRoute = advRoot.querySelector('#adv-sd-route');

        // dark mode follows the browser like the extension popup
        var darkQuery = null;
        try { darkQuery = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) {}
        function applyTheme() {
            var dark = !!(darkQuery && darkQuery.matches);
            root.classList.toggle('vc-popup-dark', dark);
            advRoot.classList.toggle('vc-popup-dark', dark);
        }
        applyTheme();
        if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);

        // ---- popup.js behaviors ---------------------------------------------
        var textDebounce = null;
        var wheelRemainder = 0;
        var lastMeterPaint = 0;

        function maxDb() { return restriction === 'restricted' ? 0 : MAX_DB; }
        function displayDb() { return Math.min(state.dB, maxDb()); }

        function commitText(raw) {
            var t = String(raw == null ? '' : raw).trim();
            if (!/^[+-]?\d+$/.test(t)) return;
            setVolume(Number(t));
            volumeText.value = (displayDb() >= 0 ? '+' : '') + displayDb();
        }

        slider.addEventListener('input', function () {
            setVolume(Number(slider.value));
        });
        volumeText.addEventListener('input', function () {
            if (textDebounce) clearTimeout(textDebounce);
            var raw = volumeText.value;
            textDebounce = setTimeout(function () { commitText(raw); }, 300);
        });
        volumeText.addEventListener('blur', function () {
            if (textDebounce) { clearTimeout(textDebounce); textDebounce = null; }
            commitText(volumeText.value);
            volumeText.value = (displayDb() >= 0 ? '+' : '') + displayDb();
        });
        volumeText.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') {
                if (textDebounce) { clearTimeout(textDebounce); textDebounce = null; }
                commitText(volumeText.value);
                volumeText.value = (displayDb() >= 0 ? '+' : '') + displayDb();
            }
        });
        root.addEventListener('wheel', function (e) {
            var active = shadow.activeElement;
            if (active && active.id === 'volume-text') return;
            var delta = Number(e.deltaY) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1);
            if (!Number.isFinite(delta) || delta === 0) return;
            var adjustment = delta;
            if (Math.abs(delta) >= 15) {
                wheelRemainder = 0;
            } else {
                if (wheelRemainder && Math.sign(delta) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
                wheelRemainder += delta;
                if (Math.abs(wheelRemainder) < 15) return;
                adjustment = wheelRemainder;
                wheelRemainder -= Math.sign(wheelRemainder) * 15;
            }
            var currentDb = Number(slider.value);
            var direction = adjustment > 0 ? -1 : 1;   // wheel down = quieter (popup.js)
            var nextDb = Math.min(normalizeDb(currentDb + direction), maxDb());
            if (nextDb === currentDb) return;
            e.preventDefault();
            setVolume(nextDb);
        }, { passive: false });

        muteBtn.addEventListener('click', toggleMute);
        normCheckbox.addEventListener('change', toggleNormalizer);
        monoCheckbox.addEventListener('change', toggleMono);
        rememberCheckbox.addEventListener('change', toggleRemember);
        activeCheckbox.addEventListener('change', toggleActive);
        settingsBtn.addEventListener('click', function () {
            // Open the in-popup Advanced view (the extension's options-page
            // settings that apply to the userscript engine). The website link
            // lives inside the view.
            if (!open) setOpen(true);
            setView('advanced');
            syncAdvanced();
            try { advBack.focus({ preventScroll: true }); } catch (e) {}
        });

        // ---- advanced view --------------------------------------------------
        var view = 'main';
        function setView(v) {
            view = v;
            popupWrap.setAttribute('data-view', v);
            if (v === 'advanced') fitAdvancedPanel();
        }
        setView('main');

        // The advanced panel is capped at calc(100vh - 120px), but a button
        // dragged high on the page leaves less room than that — cap the panel
        // to the space actually available above the anchor so its top (and the
        // sticky Back header) never spills past the top of the viewport.
        function fitAdvancedPanel() {
            try {
                var hostRect = host.getBoundingClientRect();
                var spaceAbove = Math.max(220, hostRect.bottom - 60);
                var cap = Math.min(spaceAbove, window.innerHeight - 120);
                advRoot.style.maxHeight = Math.round(cap) + 'px';
            } catch (e) { /* keep the CSS cap */ }
        }
        fitAdvancedPanel();
        window.addEventListener('resize', fitAdvancedPanel);

        function safeVal(input, v) {
            // do not clobber an input the user is editing right now
            if (shadow.activeElement === input) return;
            input.value = v;
        }
        function syncAdvanced() {
            safeVal(advMode, normalizerConfig.mode);
            safeVal(advTarget, normalizerConfig.targetDb);
            safeVal(advBoost, normalizerConfig.maxBoostDb);
            safeVal(advCeiling, normalizerConfig.ceilingDb);
            safeVal(advResponse, normalizerConfig.responseMs);
            if (shadow.activeElement !== advTruePeak) advTruePeak.checked = !!normalizerConfig.experimentalTruePeak;
            var installed = hookInstalled();
            advEngine.textContent = installed
                ? 'Engine: active on this page \u2014 hook installed'
                : 'Engine: waiting (strict-CSP pages fall back within ~2 s)';
            syncAccess();
            syncDebug();
        }
        function commitAdvanced() {
            var cfg = {
                mode: advMode.value === 'adaptive' ? 'adaptive' : 'music',
                targetDb: Math.max(-30, Math.min(-6, Math.round(Number(advTarget.value) || -16))),
                maxBoostDb: Math.max(0, Math.min(24, Math.round(Number(advBoost.value) || 12))),
                ceilingDb: Math.max(-6, Math.min(-0.1, Number(advCeiling.value) || -1)),
                responseMs: Math.max(100, Math.min(3000, Math.round(Number(advResponse.value) || 600))),
                experimentalTruePeak: !!advTruePeak.checked
            };
            normalizerConfig = cfg;
            store.set('vc-normalizer-config', cfg);
            sendState();          // engine applies the new config live
            syncAdvanced();
        }
        [advMode, advTarget, advBoost, advCeiling, advResponse, advTruePeak].forEach(function (el) {
            el.addEventListener('change', commitAdvanced);
        });

        // ---- site access lists (options.html Blocked/Allowed Sites) ---------
        function normalizeAccessInput(raw) {
            // shared.js input normalizer: strip scheme, credentials, port and
            // a leading www.; any path/query stays (informational).
            var v = String(raw == null ? '' : raw).trim().toLowerCase();
            v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
            v = v.replace(/^[^/@]+@/, '');
            v = v.replace(/:\d+(?=\/|$)/, '');
            v = v.replace(/^www\./, '');
            return v.replace(/^\/+/, '');
        }
        var accessStatusTimer = null;
        function showAccessStatus(text) {
            advSiteStatus.textContent = text;
            advSiteStatus.classList.remove('vc-empty');
            if (accessStatusTimer) clearTimeout(accessStatusTimer);
            accessStatusTimer = setTimeout(function () {
                advSiteStatus.textContent = '';
                advSiteStatus.classList.add('vc-empty');
            }, 4000);
        }
        function renderAccessList() {
            var entries = lists.whitelistMode ? lists.whitelist : lists.blocklist;
            advSiteList.innerHTML = '';
            entries.forEach(function (entry) {
                var row = document.createElement('div');
                row.className = 'vc-adv-entry' + (listEntryMatches(entry, HOST) ? ' vc-current' : '');
                var name = document.createElement('span');
                name.textContent = entry;
                name.title = 'Matches ' + String(entry).split('/')[0] + ' and its subdomains';
                var rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'vc-adv-remove';
                rm.textContent = '\u00d7';
                rm.setAttribute('aria-label', 'Remove ' + entry);
                rm.addEventListener('click', function () { removeAccessEntry(entry); });
                row.appendChild(name);
                row.appendChild(rm);
                advSiteList.appendChild(row);
            });
        }
        function syncAccess() {
            if (shadow.activeElement !== advListMode) {
                advListMode.value = lists.whitelistMode ? 'whitelist' : 'blacklist';
            }
            advAccessStatus.textContent = location.hostname + (excluded
                ? ' \u2014 blocked by the ' + (lists.whitelistMode ? 'whitelist (not listed)' : 'blocklist')
                : ' \u2014 active on this site');
            renderAccessList();
        }
        function applyAccessChange() {
            excluded = siteBlockedByLists();
            state.enabled = !excluded;
            sendState();
            syncAccess();
            refresh();
        }
        function addAccessEntry() {
            var entry = normalizeAccessInput(advSiteInput.value);
            var domain = entry.split('/')[0];
            if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
                showAccessStatus('Enter a domain like example.com');
                return;
            }
            var target = lists.whitelistMode ? lists.whitelist : lists.blocklist;
            if (target.indexOf(entry) !== -1) {
                showAccessStatus(entry + ' is already in the list.');
                return;
            }
            target.push(entry);
            persistLists();
            advSiteInput.value = '';
            applyAccessChange();
            showAccessStatus(entry + ' added to ' + (lists.whitelistMode ? 'allowed' : 'blocked') + ' sites.');
        }
        function removeAccessEntry(entry) {
            if (lists.whitelistMode) {
                lists.whitelist = lists.whitelist.filter(function (e) { return e !== entry; });
            } else {
                lists.blocklist = lists.blocklist.filter(function (e) { return e !== entry; });
            }
            persistLists();
            applyAccessChange();
        }
        advSiteAdd.addEventListener('click', addAccessEntry);
        advSiteInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); addAccessEntry(); }
        });
        advListMode.addEventListener('change', function () {
            lists.whitelistMode = advListMode.value === 'whitelist';
            persistLists();
            applyAccessChange();
        });

        // ---- debug overrides (options.html Debug section) --------------------
        function syncDebug() {
            if (shadow.activeElement !== advDbgHighlight) advDbgHighlight.checked = !!debugDefaults.debugMode;
            if (shadow.activeElement !== advForceDrm) advForceDrm.checked = !!debugDefaults.forceDrmCapture;
            if (shadow.activeElement !== advForceCors) advForceCors.checked = !!debugDefaults.forceCorsCapture;
            if (shadow.activeElement !== advRoute) advRoute.value = debugDefaults.debugRouteMode;
            advSiteDebugLabel.textContent = 'Override for this site \u2014 ' + location.hostname;
            advSiteDebug.checked = !!siteDebug;
            advSdControls.hidden = !siteDebug;
            advSdHighlight.checked = !!(siteDebug && siteDebug.debugMode);
            advSdDrm.checked = !!(siteDebug && siteDebug.forceDrmCapture);
            advSdCors.checked = !!(siteDebug && siteDebug.forceCorsCapture);
            advSdRoute.value = siteDebug ? siteDebug.debugRouteMode : 'auto';
        }
        function commitDebugDefaults() {
            debugDefaults = {
                debugMode: !!advDbgHighlight.checked,
                forceDrmCapture: !!advForceDrm.checked,
                forceCorsCapture: !!advForceCors.checked,
                debugRouteMode: (advRoute.value === 'webaudio' || advRoute.value === 'native') ? advRoute.value : 'auto'
            };
            store.set(DEBUG_DEFAULTS_KEY, debugDefaults);
            sendState();                                   // engine applies live
            applyDebugHighlight(effectiveDebugConfig().debugMode);
            syncDebug();
        }
        function commitSiteDebug() {
            siteDebug = {
                debugMode: !!advSdHighlight.checked,
                forceDrmCapture: !!advSdDrm.checked,
                forceCorsCapture: !!advSdCors.checked,
                debugRouteMode: (advSdRoute.value === 'webaudio' || advSdRoute.value === 'native') ? advSdRoute.value : 'auto'
            };
            store.set(DEBUG_SITE_KEY, siteDebug);
            sendState();
            applyDebugHighlight(effectiveDebugConfig().debugMode);
            syncDebug();
        }
        [advDbgHighlight, advForceDrm, advForceCors, advRoute].forEach(function (el) {
            el.addEventListener('change', commitDebugDefaults);
        });
        [advSdHighlight, advSdDrm, advSdCors, advSdRoute].forEach(function (el) {
            el.addEventListener('change', commitSiteDebug);
        });
        advSiteDebug.addEventListener('change', function () {
            if (advSiteDebug.checked) {
                siteDebug = normalizeDebugConfig(null);
                store.set(DEBUG_SITE_KEY, siteDebug);
            } else {
                siteDebug = null;
                store.del(DEBUG_SITE_KEY);
            }
            sendState();
            applyDebugHighlight(effectiveDebugConfig().debugMode);
            syncDebug();
        });
        advBack.addEventListener('click', function () {
            setView('main');
            try { slider.focus({ preventScroll: true }); } catch (e) {}
        });
        // engine status is async (CSP fallback) — refresh it while visible
        setInterval(function () {
            if (!open || view !== 'advanced') return;
            var installed = hookInstalled();
            advEngine.textContent = installed
                ? 'Engine: active on this page \u2014 hook installed'
                : 'Engine: waiting (strict-CSP pages fall back within ~2 s)';
        }, 1000);
        // Reset all data (two-click confirm; GM_listValues when available)
        var resetArmed = false, resetTimer = null;
        advResetAll.addEventListener('click', function () {
            if (!resetArmed) {
                resetArmed = true;
                advResetAll.textContent = 'Sure? Click again';
                clearTimeout(resetTimer);
                resetTimer = setTimeout(function () {
                    resetArmed = false; advResetAll.textContent = 'Reset all data';
                }, 3500);
                return;
            }
            var n = 0;
            try {
                if (typeof GM_listValues === 'function') {
                    GM_listValues().forEach(function (k) { store.del(k); n++; });
                } else {
                    ['vc-first-run', 'vc-btn-pos', 'vc-normalizer-config', SITE_KEY, EXCLUDED_KEY,
                     LISTS_KEY, DEBUG_DEFAULTS_KEY, DEBUG_SITE_KEY]
                        .forEach(function (k) { store.del(k); n++; });
                }
            } catch (e) {}
            // live state back to fresh-install values
            remembered = false;
            lists = { blocklist: [], whitelist: [], whitelistMode: false };
            debugDefaults = normalizeDebugConfig(null);
            siteDebug = null;
            applyDebugHighlight(false);
            excluded = siteBlockedByLists();
            state.enabled = true; state.dB = 0; state.mono = false;
            state.muted = false; state.normalizerEnabled = false;
            normalizerConfig = DEFAULT_NORMALIZER_CONFIG;
            sendState();
            refresh();
            syncAdvanced();
            advDataNote.textContent = n + ' entries cleared. Reload pages to see the first-run intro again.';
            resetArmed = false;
            advResetAll.textContent = 'Reset \u2713';
            setTimeout(function () { advResetAll.textContent = 'Reset all data'; }, 2500);
        });

        // ---- open/close -------------------------------------------------------
        // The class goes on the ANCHOR (popupWrap): FLOATING_CSS raises the
        // anchor from opacity:0 — toggling a class on the child popup can
        // never make it visible (the parent would stay at opacity:0).
        var open = false;
        function setOpen(v) {
            open = v;
            popupWrap.classList.toggle('vc-tm-open', open);
            if (open) {
                refresh();
                try { slider.focus({ preventScroll: true }); } catch (e) {}
            } else {
                setView('main');   // next open starts at the volume view
            }
        }
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (btn.dataset.dragged) return;   // this click just ended a drag
            setOpen(!open);
        });
        document.addEventListener('click', function (e) {
            if (!open) return;
            if (e.composedPath().indexOf(host) === -1) setOpen(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && open) setOpen(false);
        });

        // ---- drag (button) ----------------------------------------------------
        var drag = null;
        btn.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            drag = { x: e.clientX, y: e.clientY, moved: false };
        });
        window.addEventListener('pointermove', function (e) {
            if (!drag) return;
            var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
            drag.moved = true;
            // Measure the HOST, not the button: while dragging, the pointer
            // stays over the button, so its :hover scale(1.06) transform is
            // active — deriving position from btn.getBoundingClientRect()
            // accumulates the scale error on every pointermove and the button
            // drifts away from the pointer. The host is never transformed.
            var rect = host.getBoundingClientRect();
            var right = window.innerWidth - rect.right - dx;
            var bottom = window.innerHeight - rect.bottom - dy;
            right = Math.max(4, Math.min(window.innerWidth - rect.width - 4, right));
            bottom = Math.max(4, Math.min(window.innerHeight - rect.height - 4, bottom));
            host.style.right = right + 'px';
            host.style.bottom = bottom + 'px';
            drag.x = e.clientX; drag.y = e.clientY;
            store.set('vc-btn-pos', { right: right, bottom: bottom });
        });
        window.addEventListener('pointerup', function () {
            if (drag && drag.moved) btn.dataset.dragged = '1';
            drag = null;
            setTimeout(function () { delete btn.dataset.dragged; }, 50);
        });


        // restore position
        var pos = store.get('vc-btn-pos', null);
        if (pos && typeof pos.right === 'number' && typeof pos.bottom === 'number') {
            host.style.right = Math.max(4, pos.right) + 'px';
            host.style.bottom = Math.max(4, pos.bottom) + 'px';
        }

        // ---- fullscreen adoption ---------------------------------------------
        // When the page enters fullscreen (YouTube player etc.) everything
        // outside the fullscreen element is hidden — including this host. Move
        // the host INTO the fullscreen element so the button and popup stay
        // usable while watching, and back to <html> when fullscreen exits.
        // Media elements cannot render children, so those are skipped.
        function adoptFullscreen() {
            try {
                var fs = document.fullscreenElement || document.webkitFullscreenElement;
                if (fs && fs.appendChild) {
                    var tag = (fs.tagName || '').toLowerCase();
                    var canHoldChildren = tag !== 'video' && tag !== 'audio' && tag !== 'canvas'
                        && tag !== 'img' && tag !== 'picture' && tag !== 'iframe' && tag !== 'object';
                    if (canHoldChildren && fs !== host.parentNode) fs.appendChild(host);
                } else if (!fs && host.parentNode !== document.documentElement) {
                    document.documentElement.appendChild(host);
                }
            } catch (e) { /* page blocked the move — stay put */ }
        }
        document.addEventListener('fullscreenchange', adoptFullscreen);
        document.addEventListener('webkitfullscreenchange', adoptFullscreen);
        adoptFullscreen();   // in case the UI was built while already fullscreen

        // ---- one-time attention pulse (first run after install/update) -----
        function pulseButton() {
            btn.classList.remove('vc-tm-pulse');
            void btn.offsetWidth;            // restart the animation
            btn.classList.add('vc-tm-pulse');
            setTimeout(function () { btn.classList.remove('vc-tm-pulse'); }, 1700);
        }

        // ---- meter (125 ms paint throttle, like popup.js) ---------------------
        meterListeners.push(function (m) {
            var now = Date.now();
            if (now - lastMeterPaint < 125 || !open) return;
            lastMeterPaint = now;
            var peakDb = Number.isFinite(m.peakDb) ? m.peakDb : -Infinity;
            var clamped = Number.isFinite(peakDb) ? Math.max(-60, Math.min(0, peakDb)) : -60;
            meterFill.style.width = (((clamped + 60) / 60) * 100).toFixed(2) + '%';
            meterText.textContent = formatMeterDb(peakDb);
            meterEl.setAttribute('aria-valuenow', clamped.toFixed(1));
            var shown = Number.isFinite(m.normalizerGainDb) ? m.normalizerGainDb : 0;
            normGain.textContent = 'Gain ' + (shown >= 0 ? '+' : '') + shown.toFixed(1) + ' dB';
            peakWarn.classList.toggle('hidden',
                !(state.normalizerEnabled && restriction !== 'restricted' && Number.isFinite(peakDb) && peakDb >= -0.3));
        });

        // ---- refresh (badge + controls) ---------------------------------------
        function refresh() {
            var active = state.enabled;
            var m = maxDb();
            var shown = displayDb();

            // badge (background.js semantics)
            if (state.muted) {
                badge.textContent = 'MUTE'; badge.className = 'vc-tm-badge vc-tm-badge-red';
            } else if (shown > 0) {
                badge.textContent = '+' + shown; badge.className = 'vc-tm-badge vc-tm-badge-green';
            } else if (shown < 0) {
                badge.textContent = String(shown); badge.className = 'vc-tm-badge vc-tm-badge-red';
            } else {
                badge.textContent = '0'; badge.className = 'vc-tm-badge vc-tm-badge-gray';
            }
            badge.style.display = (state.muted || shown !== 0) ? '' : 'none';

            content.classList.toggle('excluded-site', !active);
            content.classList.toggle('is-muted', state.muted);
            exclusionMsg.classList.toggle('hidden', active);
            exclusionDetail.textContent = location.hostname + (lists.whitelistMode
                ? ' is not on the allowed-sites list. Toggle Active, or add it under Settings → Site access, to reactivate.'
                : ' is on the blocked-sites list. Toggle Active, or remove it under Settings → Site access, to reactivate.');

            slider.value = String(shown);
            slider.max = String(m);
            slider.style.setProperty('--vc-range-steps', String(Math.max(1, m - MIN_DB)));
            slider.disabled = !active;

            volumeText.value = (shown >= 0 ? '+' : '') + shown;
            volumeText.disabled = !active;

            muteBtn.classList.toggle('muted', state.muted);
            muteLabel.textContent = state.muted ? 'Unmute' : 'Mute';
            muteBtn.disabled = !active;

            var restricted = restriction === 'restricted';
            limitNote.classList.toggle('hidden', !(restricted && active));
            boostWarning.classList.toggle('hidden', !(shown >= 6 && active));

            normCheckbox.checked = state.normalizerEnabled;
            normCheckbox.disabled = restricted || !active;
            normNote.classList.toggle('hidden', !restricted);
            if (restricted) normNote.textContent = 'Normalize cannot process DRM-protected audio in this browser.';
            normDetails.hidden = !(state.normalizerEnabled && !restricted);

            monoCheckbox.checked = state.mono;
            monoCheckbox.disabled = restricted || !active;
            rememberCheckbox.checked = remembered;
            activeCheckbox.checked = active;
        }
        refresh();

        document.documentElement.appendChild(host);
        return {
            refresh: refresh,
            setOpen: setOpen,
            setView: setView,
            pulse: pulseButton,
            isOpen: function () { return open; },
            showAccess: function () {
                setView('advanced');
                syncAdvanced();
                try { advListMode.focus({ preventScroll: true }); } catch (e) {}
            }
        };
    }

    // popup.html markup (extension classes, popup.css-driven)
    var POPUP_HTML =
        '<div class="vc-popup vc-main" role="dialog" aria-label="Volume Control popup">' +
        '  <div id="popup-content" class="">' +
        '    <div class="exclusion-message hidden">' +
        '      <div class="exclusion-title">Volume Control is disabled for this site.</div>' +
        '      <div class="exclusion-detail"></div>' +
        '    </div>' +
        '    <div class="top-controls">' +
        '      <input type="range" id="volume-slider" min="-32" max="32" step="1" aria-label="Volume control"' +
        '        aria-describedby="volume-limit-note volume-boost-warning" title="Volume control (Alt+Shift+Up/Down to adjust)"/>' +
        '      <p id="volume-limit-note" class="volume-limit-note hidden" role="status">' +
        '        Boosting, mono, and Normalize may be unavailable on DRM/CORS-restricted media because the browser only allows fallback volume control. You can still lower volume and mute.' +
        '      </p>' +
        '      <p id="volume-boost-warning" class="volume-limit-note hidden" role="note">' +
        '        Large positive volume boosts can distort loud audio; the compressor is not a guaranteed true-peak limiter.' +
        '      </p>' +
        '      <div class="volume-row">' +
        '        <button id="mute-btn" class="mute-btn" type="button" title="Mute/Unmute" aria-label="Mute or unmute audio">' +
        '          <svg class="mute-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
        '            <path class="speaker-shape" d="M3 9v6h4l5 5V4L7 9H3z"/>' +
        '            <path class="wave-shape" d="M14 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '            <path class="wave-shape" d="M16.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '            <line class="mute-x" x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
        '          </svg>' +
        '          <span class="mute-label">Mute</span>' +
        '        </button>' +
        '        <span class="volume-display">' +
        '          <input type="text" id="volume-text" inputmode="numeric" aria-label="Volume in decibels"/>' +
        '          <span class="volume-unit" aria-hidden="true">dB</span>' +
        '        </span>' +
        '      </div>' +
        '      <div class="normalizer-panel">' +
        '        <div class="normalizer-header">' +
        '          <label class="switch-container normalizer-switch" for="normalizer-checkbox"' +
        '            title="Automatically even out loud and quiet audio">' +
        '            <div class="switch"><input type="checkbox" id="normalizer-checkbox"/><span class="slider"></span></div>' +
        '            <span class="label-text">Normalize</span>' +
        '          </label>' +
        '        </div>' +
        '        <p id="normalizer-note" class="normalizer-note hidden" role="status"></p>' +
        '        <div id="normalizer-details" class="normalizer-details" hidden>' +
        '          <div class="normalizer-detail-header">' +
        '            <span id="normalizer-gain" class="normalizer-gain" aria-live="polite">Gain +0.0 dB</span>' +
        '          </div>' +
        '          <div class="peak-meter-row">' +
        '            <div class="peak-meter" role="meter" aria-label="Output peak level" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60">' +
        '              <div id="peak-meter-fill" class="peak-meter-fill" style="width:0%"></div>' +
        '              <div class="peak-meter-ceiling" title="\u22121 dBFS reference mark, not a hard ceiling"></div>' +
        '            </div>' +
        '            <span id="peak-meter-text" class="peak-meter-text">\u2212\u221E dBFS</span>' +
        '          </div>' +
        '          <p id="peak-safety-warning" class="normalizer-note hidden" role="note">' +
        '            Output sample peaks are near digital full scale. Inter-sample peaks may be higher; lower manual boost if you hear distortion.' +
        '          </p>' +
        '        </div>' +
        '      </div>' +
        '    </div>' +
        '    <div class="bot-controls">' +
        '      <div class="left">' +
        '        <label class="switch-container" for="mono-checkbox" title="Toggle Mono Audio">' +
        '          <div class="switch"><input type="checkbox" id="mono-checkbox"/><span class="slider"></span></div>' +
        '          <span class="label-text">Mono</span>' +
        '        </label>' +
        '        <label class="switch-container" for="remember-checkbox" title="Remember volume for this site">' +
        '          <div class="switch"><input type="checkbox" id="remember-checkbox"/><span class="slider"></span></div>' +
        '          <span class="label-text">Remember</span>' +
        '        </label>' +
        '      </div>' +
        '      <div class="right">' +
        '        <label class="switch-container" for="enable-checkbox" title="Enable/Disable on this site">' +
        '          <div class="switch"><input type="checkbox" id="enable-checkbox"/><span class="slider"></span></div>' +
        '          <span class="label-text">Active</span>' +
        '        </label>' +
        '        <button id="settings" class="settings" type="button" aria-label="Open advanced options">Settings</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

    // advanced-options view (the extension options.html settings that apply
    // to the userscript engine — verbatim labels, ranges and units)
    var ADVANCED_HTML =
        '<div class="vc-popup vc-advanced" role="dialog" aria-label="Advanced options">' +
        '  <div class="vc-adv-head">' +
        '    <button class="vc-adv-back" type="button" aria-label="Back to volume controls">\u2039 Back</button>' +
        '    <span class="vc-adv-title">Advanced options</span>' +
        '    <a class="vc-adv-site" href="https://chaython.github.io/volumecontrol/" target="_blank" rel="noreferrer">Website \u2197</a>' +
        '  </div>' +
        '  <div class="vc-adv-body">' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Normalizer</div>' +
        '      <label class="vc-adv-row"><span>Normalization style</span>' +
        '        <select id="adv-mode">' +
        '          <option value="music">Music \u2014 preserve song dynamics (recommended)</option>' +
        '          <option value="adaptive">Adaptive \u2014 faster speech/video leveling</option>' +
        '        </select></label>' +
        '      <div class="vc-adv-grid">' +
        '        <label class="vc-adv-field"><span>Target loudness</span>' +
        '          <input type="number" id="adv-target" min="-30" max="-6" step="1" inputmode="decimal"/><em>dBFS RMS</em></label>' +
        '        <label class="vc-adv-field"><span>Maximum auto boost</span>' +
        '          <input type="number" id="adv-boost" min="0" max="24" step="1" inputmode="decimal"/><em>dB</em></label>' +
        '        <label class="vc-adv-field"><span>Compressor threshold</span>' +
        '          <input type="number" id="adv-ceiling" min="-6" max="-0.1" step="0.1" inputmode="decimal"/><em>dBFS</em></label>' +
        '        <label class="vc-adv-field"><span>Response speed (Adaptive)</span>' +
        '          <input type="number" id="adv-response" min="100" max="3000" step="50" inputmode="numeric"/><em>ms</em></label>' +
        '      </div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-truepeak"/>' +
        '        <span>Experimental true-peak limiter (opt-in; isolated fallback route)</span></label>' +
        '      <div class="vc-adv-hint">Defaults: Music style, \u221216 dBFS RMS target, +12 dB max auto boost, \u22121 dBFS compressor threshold. Response speed applies to Adaptive style. Changes apply live to every site using Normalize.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Site access</div>' +
        '      <div class="vc-adv-row"><span>List mode</span>' +
        '        <select id="adv-list-mode" aria-label="List mode">' +
        '          <option value="blacklist">Blacklist — block listed sites</option>' +
        '          <option value="whitelist">Whitelist — allow only listed sites</option>' +
        '        </select></div>' +
        '      <div class="vc-adv-row"><span id="adv-access-status"></span></div>' +
        '      <div class="vc-adv-addrow">' +
        '        <input type="text" id="adv-site-input" placeholder="example.com" aria-label="Site domain to add" spellcheck="false"/>' +
        '        <button id="adv-site-add" class="vc-adv-add" type="button">Add site</button>' +
        '      </div>' +
        '      <div id="adv-site-status" class="vc-adv-status vc-empty" role="status"></div>' +
        '      <div id="adv-site-list" class="vc-adv-list"></div>' +
        '      <div class="vc-adv-hint">Blacklist: listed sites are skipped entirely (native volume only). Whitelist: only listed sites run Volume Control. Entries match subdomains, and the popup’s Active toggle edits the same list for this site.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Debug overrides</div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-debug-highlight"/>' +
        '        <span>Show Debug Highlight — green border around hooked video elements</span></label>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-force-drm"/>' +
        '        <span>Force DRM Audio Capture (Debug Only)</span></label>' +
        '      <div class="vc-adv-hint vc-adv-warn">Warning: disables DRM/EME safety checks and forces protected media through WebAudio. This can mute audio or break playback. Reload the tab after changing.</div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-force-cors"/>' +
        '        <span>Skip CORS Media Guard (Debug Only)</span></label>' +
        '      <div class="vc-adv-hint vc-adv-warn">Warning: attempts WebAudio capture for cross-origin media; browsers may output silence for tainted media.</div>' +
        '      <div class="vc-adv-row"><span>HTML media route</span>' +
        '        <select id="adv-route" aria-label="HTML media route override">' +
        '          <option value="auto">Automatic (recommended)</option>' +
        '          <option value="webaudio">Force WebAudio / GainNode</option>' +
        '          <option value="native">Force native volume fallback</option>' +
        '        </select></div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-site-debug"/>' +
        '        <span id="adv-site-debug-label">Override for this site</span></label>' +
        '      <div id="adv-site-debug-controls" class="vc-adv-sitebox" hidden>' +
        '        <label class="vc-adv-check"><input type="checkbox" id="adv-sd-highlight"/><span>Highlight</span></label>' +
        '        <label class="vc-adv-check"><input type="checkbox" id="adv-sd-drm"/><span>DRM</span></label>' +
        '        <label class="vc-adv-check"><input type="checkbox" id="adv-sd-cors"/><span>CORS</span></label>' +
        '        <select id="adv-sd-route" aria-label="Route override for this site">' +
        '          <option value="auto">Route: Auto</option>' +
        '          <option value="webaudio">Route: WebAudio</option>' +
        '          <option value="native">Route: Native</option>' +
        '        </select>' +
        '      </div>' +
        '      <div class="vc-adv-hint">Applies live to the engine on every open tab. Per-site overrides persist independently; DRM/CORS force when either the default or the site override is on.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Engine</div>' +
        '      <div class="vc-adv-row"><span id="adv-engine-status">Engine: \u2026</span></div>' +
        '      <div class="vc-adv-hint">The audio engine is the extension\u2019s real page-audio-hook.js. On strict-CSP sites the inline install is blocked and it falls back automatically \u2014 nothing to configure.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Data</div>' +
        '      <div class="vc-adv-row vc-adv-data"><span id="adv-data-note">Sites, remembered volumes, positions, access lists, debug overrides.</span>' +
        '        <button id="adv-reset-all" class="vc-adv-danger" type="button">Reset all data</button></div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

    // floating-host additions (button + positioning of the popup itself).
    // The host (0x0, fixed, 18px from the corner, max z-index) is the single
    // positioning context: the button and the popup anchor are absolute
    // inside it, so the 18px margin, the saved drag position (host style) and
    // the popup offset all move together. The open state lives on the ANCHOR
    // (.vc-popup-anchor.vc-tm-open): a parent with opacity:0 hides the whole
    // subtree, so the class must raise the anchor itself, and closed-state
    // pointer-events:none inherits down (an invisible popup must not swallow
    // page clicks).
    var FLOATING_CSS = [
        '.vc-tm-btn{position:absolute;right:0;bottom:0;width:42px;height:42px;border-radius:50%;',
        'border:1px solid rgba(0,0,0,.15);background:#fff;color:#333;box-shadow:0 2px 10px rgba(0,0,0,.25);',
        'cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;',
        'transition:transform .12s ease,box-shadow .12s ease;}',
        '.vc-tm-btn:hover{transform:scale(1.06);box-shadow:0 4px 14px rgba(0,0,0,.3);}',
        '.vc-tm-btn:active{transform:scale(.97);}',
        '.vc-tm-badge{position:absolute;top:-7px;right:-7px;min-width:20px;height:18px;padding:0 5px;',
        'border-radius:9px;font:bold 11px/18px "Segoe UI",Tahoma,sans-serif;color:#fff;',
        'box-shadow:0 1px 3px rgba(0,0,0,.35);letter-spacing:.2px;}',
        '.vc-tm-badge-green{background:#2e7d32;}',
        '.vc-tm-badge-red{background:#c62828;}',
        '.vc-tm-badge-gray{background:#5f6368;}',
        '.vc-popup-anchor{position:absolute;right:0;bottom:52px;width:420px;max-width:calc(100vw - 24px);',
        'pointer-events:none;opacity:0;transform:translateY(6px) scale(.98);',
        'transition:opacity .14s ease,transform .14s ease;}',
        '.vc-popup-anchor.vc-tm-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}',
        '.vc-popup-anchor .vc-popup{box-shadow:0 12px 40px rgba(0,0,0,.35);',
        'border-radius:8px;overflow:hidden;}',
        '@media (max-width:480px){.vc-popup-anchor{width:calc(100vw - 24px);}}',
        '@media (prefers-color-scheme:dark){.vc-tm-btn{background:#202124;color:#e8eaed;border-color:rgba(255,255,255,.2);}}',
        '@keyframes vc-tm-pulse{0%{transform:scale(1);}45%{transform:scale(1.16);',
        'box-shadow:0 6px 26px rgba(0,0,0,.4);}100%{transform:scale(1);}}',
        '.vc-tm-btn.vc-tm-pulse{animation:vc-tm-pulse 1.3s ease 1;}'
    ].join('');

    // advanced-view styles (scoped to the shadow root; light + dark like popup.css)
    var ADVANCED_CSS = [
        '.vc-popup-anchor[data-view="advanced"] .vc-main{display:none;}',
        '.vc-popup-anchor[data-view="main"] .vc-advanced{display:none;}',
        // .vc-popup-anchor .vc-popup sets overflow:hidden (corner clipping) at
        // higher specificity — override it so this panel actually scrolls.
        '.vc-popup-anchor .vc-popup.vc-advanced{max-height:calc(100vh - 120px);overflow-y:auto;}',
        '.vc-advanced::-webkit-scrollbar{width:8px;}',
        '.vc-advanced::-webkit-scrollbar-thumb{background:rgba(0,0,0,.25);border-radius:4px;}',
        '.vc-adv-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.12);',
        'position:sticky;top:0;background:#fff;z-index:2;}',
        '.vc-adv-back{border:1px solid rgba(0,0,0,.2);background:#fff;color:#333;border-radius:6px;',
        'padding:4px 10px;font:600 12px/1.4 "Segoe UI",Tahoma,sans-serif;cursor:pointer;}',
        '.vc-adv-back:hover{background:#f1f3f4;}',
        '.vc-adv-title{flex:1;font:700 13px/1.4 "Segoe UI",Tahoma,sans-serif;color:#202124;}',
        '.vc-adv-site{font:600 12px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;text-decoration:none;}',
        '.vc-adv-site:hover{color:#202124;}',
        '.vc-adv-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px;}',
        '.vc-adv-section{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:10px;}',
        '.vc-adv-h{font:700 11px/1.4 "Segoe UI",Tahoma,sans-serif;color:#202124;text-transform:uppercase;',
        'letter-spacing:.5px;margin-bottom:8px;}',
        '.vc-adv-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:400 12px/1.5 "Segoe UI",Tahoma,sans-serif;color:#3c4043;}',
        '.vc-adv-row select{margin-left:auto;border:1px solid rgba(0,0,0,.25);border-radius:6px;background:#fff;',
        'color:#202124;padding:4px 6px;font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;max-width:230px;}',
        '.vc-adv-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;}',
        '.vc-adv-field{display:flex;flex-direction:column;gap:2px;font:600 11px/1.3 "Segoe UI",Tahoma,sans-serif;color:#5f6368;}',
        '.vc-adv-field input{border:1px solid rgba(0,0,0,.25);border-radius:6px;padding:5px 6px;width:100%;',
        'box-sizing:border-box;background:#fff;color:#202124;font:500 13px/1 "Segoe UI",Tahoma,sans-serif;}',
        '.vc-adv-field input:focus{outline:2px solid #9aa0a6;outline-offset:-1px;}',
        '.vc-adv-field em{font:400 10px/1.2 "Segoe UI",Tahoma,sans-serif;color:#80868b;font-style:normal;}',
        '.vc-adv-check{display:flex;gap:6px;align-items:flex-start;font:400 11px/1.4 "Segoe UI",Tahoma,sans-serif;',
        'color:#3c4043;margin-top:6px;cursor:pointer;}',
        '.vc-adv-check input{margin-top:2px;}',
        '.vc-adv-hint{font:400 11px/1.5 "Segoe UI",Tahoma,sans-serif;color:#80868b;margin-top:8px;}',
        '.vc-adv-data{justify-content:space-between;align-items:center;}',
        '.vc-adv-data span{font:400 11px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;max-width:230px;}',
        '.vc-adv-danger{border:1px solid #c62828;color:#c62828;background:#fff;border-radius:6px;padding:5px 10px;',
        'font:600 12px/1.4 "Segoe UI",Tahoma,sans-serif;cursor:pointer;white-space:nowrap;}',
        '.vc-adv-danger:hover{background:#fce8e6;}',
        '.vc-adv-addrow{display:flex;gap:6px;margin-top:8px;}',
        '.vc-adv-addrow input{flex:1;min-width:0;border:1px solid rgba(0,0,0,.25);border-radius:6px;padding:5px 8px;',
        'background:#fff;color:#202124;font:500 12px/1.2 "Segoe UI",Tahoma,sans-serif;}',
        '.vc-adv-addrow input:focus{outline:2px solid #9aa0a6;outline-offset:-1px;}',
        '.vc-adv-add{border:1px solid rgba(0,0,0,.25);background:#fff;color:#3c4043;border-radius:6px;',
        'padding:5px 10px;font:600 12px/1.2 "Segoe UI",Tahoma,sans-serif;cursor:pointer;white-space:nowrap;}',
        '.vc-adv-add:hover{background:#f1f3f4;}',
        '.vc-adv-status{font:400 11px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;margin-top:6px;}',
        '.vc-adv-status.vc-empty{display:none;}',
        '.vc-adv-list{display:flex;flex-direction:column;gap:4px;margin-top:6px;}',
        '.vc-adv-entry{display:flex;align-items:center;justify-content:space-between;gap:8px;',
        'border:1px solid rgba(0,0,0,.12);border-radius:6px;padding:4px 6px 4px 10px;background:#fff;',
        'font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;color:#3c4043;}',
        '.vc-adv-entry.vc-current{border-color:#2e7d32;color:#2e7d32;}',
        '.vc-adv-remove{border:none;background:transparent;color:#c62828;font:700 14px/1 "Segoe UI",Tahoma,sans-serif;',
        'cursor:pointer;padding:2px 7px;border-radius:4px;}',
        '.vc-adv-remove:hover{background:#fce8e6;}',
        '.vc-adv-warn{color:#c62828;}',
        '.vc-adv-sitebox{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;',
        'border-top:1px dashed rgba(0,0,0,.15);padding-top:8px;}',
        '.vc-adv-sitebox select{border:1px solid rgba(0,0,0,.25);border-radius:6px;background:#fff;color:#202124;',
        'padding:4px 6px;font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;margin-left:auto;}',
        '.vc-popup-dark .vc-adv-head{border-color:rgba(255,255,255,.15);background:#202124;}',
        '.vc-popup-dark .vc-adv-back{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-back:hover{background:#3c4043;}',
        '.vc-popup-dark .vc-adv-title{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-site{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-site:hover{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-section{border-color:rgba(255,255,255,.15);}',
        '.vc-popup-dark .vc-adv-h{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-row{color:#bdc1c6;}',
        '.vc-popup-dark .vc-adv-row select{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-field{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-field input{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-check{color:#bdc1c6;}',
        '.vc-popup-dark .vc-adv-hint{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-data span{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-danger{background:transparent;}',
        '.vc-popup-dark .vc-adv-danger:hover{background:rgba(198,40,40,.2);}',
        '.vc-popup-dark .vc-adv-addrow input{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-add{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-add:hover{background:#3c4043;}',
        '.vc-popup-dark .vc-adv-status{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-entry{background:#292a2d;color:#bdc1c6;border-color:rgba(255,255,255,.15);}',
        '.vc-popup-dark .vc-adv-entry.vc-current{border-color:#81c995;color:#81c995;}',
        '.vc-popup-dark .vc-adv-remove:hover{background:rgba(198,40,40,.2);}',
        '.vc-popup-dark .vc-adv-sitebox{border-color:rgba(255,255,255,.15);}',
        '.vc-popup-dark .vc-adv-sitebox select{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-advanced::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);}'
    ].join('');

    // ============================================================= hotkeys
    function hotkeyTargetOk(target) {
        if (!target) return true;
        var t = target;
        var tag = (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
        if (t.isContentEditable) return false;
        return true;
    }

    document.addEventListener('keydown', function (e) {
        if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
        var key = e.key;
        if (key === 'ArrowUp') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            setVolume(state.dB + 1);
        } else if (key === 'ArrowDown') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            setVolume(state.dB - 1);
        } else if (key === '0') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            setVolume(0);
        } else if (key === 'm' || key === 'M') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            toggleMono();
        } else if (key === 'u' || key === 'U') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            toggleMute();
        } else if (key === 'p' || key === 'P') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            // toggle via the controller's own open state — the previous DOM
            // query could not see into the shadow root, so P could only open
            if (ui && ui.isOpen) uiOpenToggle(!ui.isOpen());
        }
    }, true);

    function uiOpenToggle(open) {
        if (ui && ui.setOpen) ui.setOpen(open);
    }

    // ============================================================= menu
    if (IS_TOP_FRAME && typeof GM_registerMenuCommand === 'function') {
        try {
            GM_registerMenuCommand('Open Volume Control', function () { uiOpenToggle(true); });
            GM_registerMenuCommand('Volume +1 dB', function () { setVolume(state.dB + 1); });
            GM_registerMenuCommand('Volume −1 dB', function () { setVolume(state.dB - 1); });
            GM_registerMenuCommand('Reset volume (0 dB)', function () { setVolume(0); });
            GM_registerMenuCommand('Toggle mute', toggleMute);
            GM_registerMenuCommand('Toggle mono', toggleMono);
            GM_registerMenuCommand('Disable on this site', toggleActive);
            GM_registerMenuCommand('Site access lists (block/allow)', function () {
                uiOpenToggle(true);
                if (ui && ui.showAccess) ui.showAccess();
            });
            GM_registerMenuCommand('Reset settings for this site', resetSiteSettings);
        } catch (e) { /* menu not available */ }
    }

    // ============================================================= boot
    bootEngine();

    if (IS_TOP_FRAME) {
        var startUI = function () {
            if (ui) return;
            try { ui = buildUI(); } catch (e) { /* page blocks DOM insertion */ }
            // First run after install or update: open the popup once and
            // pulse the button, so the GUI is impossible to miss.
            if (ui && store.get('vc-first-run', true)) {
                store.set('vc-first-run', false);
                setTimeout(function () {
                    try { ui.pulse(); ui.setOpen(true); } catch (e) {}
                }, 650);
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startUI, { once: true });
        } else {
            startUI();
        }
    }
})();
