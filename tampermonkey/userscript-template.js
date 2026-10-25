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

    var siteSettings = store.get(SITE_KEY, null) || null;   // {remember, volume, mono, muted, normalizer}
    var excluded = !!store.get(EXCLUDED_KEY, false);
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
            debugMode: false,
            forceDrmCapture: false,
            forceCorsCapture: false,
            debugRouteMode: 'auto'
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
        excluded = !excluded;
        if (excluded) store.set(EXCLUDED_KEY, true); else store.del(EXCLUDED_KEY);
        state.enabled = !excluded;
        sendState();
        notifyUI();
    }
    function resetSiteSettings() {
        store.del(SITE_KEY);
        store.del(EXCLUDED_KEY);
        remembered = false; excluded = false;
        state.enabled = true; state.dB = 0; state.mono = false;
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
        host.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:18px;width:0;height:0;';
        var shadow = host.attachShadow({ mode: 'open' });

        var style = document.createElement('style');
        style.textContent = POPUP_CSS + FLOATING_CSS;
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
        popupWrap.innerHTML = POPUP_HTML;
        shadow.appendChild(popupWrap);
        var root = popupWrap.querySelector('.vc-popup');
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

        // dark mode follows the browser like the extension popup
        var darkQuery = null;
        try { darkQuery = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) {}
        function applyTheme() {
            root.classList.toggle('vc-popup-dark', !!(darkQuery && darkQuery.matches));
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
            try { window.open('https://chaython.github.io/volumecontrol/', '_blank'); } catch (e) {}
        });

        // ---- open/close -------------------------------------------------------
        var open = false;
        function setOpen(v) {
            open = v;
            root.classList.toggle('vc-tm-open', open);
            if (open) {
                refresh();
                try { slider.focus({ preventScroll: true }); } catch (e) {}
            }
        }
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
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
            var rect = btn.getBoundingClientRect();
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
        btn.addEventListener('click', function () {
            if (btn.dataset.dragged) { e_stop(); }
            function e_stop() { setOpen(open); }   // swallow click after drag
        }, true);

        // restore position
        var pos = store.get('vc-btn-pos', null);
        if (pos && typeof pos.right === 'number' && typeof pos.bottom === 'number') {
            host.style.right = Math.max(4, pos.right) + 'px';
            host.style.bottom = Math.max(4, pos.bottom) + 'px';
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
            exclusionDetail.textContent = location.hostname +
                ' was added to the blocked sites list. Disable is stored by this userscript — toggle Active to reactivate.';

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
        return { refresh: refresh, setOpen: setOpen };
    }

    // popup.html markup (extension classes, popup.css-driven)
    var POPUP_HTML =
        '<div class="vc-popup" role="dialog" aria-label="Volume Control popup">' +
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
        '        <button id="settings" class="settings" type="button" aria-label="Open the Volume Control website">Settings</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

    // floating-host additions (button + positioning of the popup itself)
    var FLOATING_CSS = [
        '.vc-tm-btn{position:fixed;right:0;bottom:0;width:42px;height:42px;border-radius:50%;',
        'border:1px solid rgba(0,0,0,.15);background:#fff;color:#333;box-shadow:0 2px 10px rgba(0,0,0,.25);',
        'cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2147483647;',
        'transition:transform .12s ease,box-shadow .12s ease;}',
        '.vc-tm-btn:hover{transform:scale(1.06);box-shadow:0 4px 14px rgba(0,0,0,.3);}',
        '.vc-tm-btn:active{transform:scale(.97);}',
        '.vc-tm-badge{position:absolute;top:-7px;right:-7px;min-width:20px;height:18px;padding:0 5px;',
        'border-radius:9px;font:bold 11px/18px "Segoe UI",Tahoma,sans-serif;color:#fff;',
        'box-shadow:0 1px 3px rgba(0,0,0,.35);letter-spacing:.2px;}',
        '.vc-tm-badge-green{background:#2e7d32;}',
        '.vc-tm-badge-red{background:#c62828;}',
        '.vc-tm-badge-gray{background:#5f6368;}',
        '.vc-popup-anchor{position:fixed;right:0;bottom:52px;width:420px;max-width:calc(100vw - 16px);',
        'z-index:2147483647;pointer-events:none;opacity:0;transform:translateY(6px) scale(.98);',
        'transition:opacity .14s ease,transform .14s ease;}',
        '.vc-popup-anchor .vc-popup{pointer-events:auto;box-shadow:0 12px 40px rgba(0,0,0,.35);',
        'border-radius:8px;overflow:hidden;}',
        '.vc-popup-anchor .vc-popup.vc-tm-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}',
        '@media (max-width:480px){.vc-popup-anchor{width:calc(100vw - 24px);}}',
        '@media (prefers-color-scheme:dark){.vc-tm-btn{background:#202124;color:#e8eaed;border-color:rgba(255,255,255,.2);}}'
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
            if (ui) { var openState = !document.querySelector('.vc-popup.vc-tm-open'); uiOpenToggle(openState); }
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
            GM_registerMenuCommand('Reset settings for this site', resetSiteSettings);
        } catch (e) { /* menu not available */ }
    }

    // ============================================================= boot
    bootEngine();

    if (IS_TOP_FRAME) {
        var startUI = function () {
            if (ui) return;
            try { ui = buildUI(); } catch (e) { /* page blocks DOM insertion */ }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startUI, { once: true });
        } else {
            startUI();
        }
    }
})();
