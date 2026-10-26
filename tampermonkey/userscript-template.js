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
// @grant        GM_addValueChangeListener
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

    // cs.js BOOST_LIMIT_NOTES (verbatim) — the popup's boost-limit verdict
    // layer. 'fallback' is shared.js BOOST_LIMIT_NOTE, used for unknown
    // reasons (and by the mono/normalizer unavailability texts).
    var BOOST_LIMIT_NOTES = {
        'cross-origin': 'Limited by cross-origin media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.',
        'restricted': 'Limited by DRM-protected or otherwise restricted media. Browser security only allows fallback volume control here, so you can lower volume but boosting and mono may be unavailable.',
        'route-failed': 'WebAudio routing failed or is unavailable. Native media may allow attenuation, but boosting and mono are unavailable; an already-captured element with a closed audio context may stay silent until reload.',
        'native-route': 'Force native fallback is selected. Native HTML media volume can attenuate or mute, but boosting, mono, and Normalize require WebAudio.',
        'fallback': 'Boosting, mono, and normalization may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.'
    };

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
    var PAGE_URL = location.href;
    // Remembered profiles live under vc-site:<key> where <key> can be a bare
    // domain, a path ("example.com/videos") or — for manually created or
    // renamed profiles — a query ("youtube.com/watch?v=abc"). Legacy
    // host-only vc-site:<host> keys keep working: the ranked matcher treats
    // them as domain-only entries (canonicalized).
    var SITE_PREFIX = 'vc-site:';
    // The per-site Normalize preference is persisted SEPARATELY from
    // Remembered Audio (extension siteNormalizerSettings — README: "does not
    // require Remember"), with its own global default.
    var NORMALIZER_PREFIX = 'vc-normalizer:';
    var NORMALIZER_DEFAULT_KEY = 'vc-normalizer-default';
    var EXCLUDED_KEY = 'vc-excluded:' + HOST;

    // ---- site access lists (options.html "Blocked Sites"/"Allowed Sites") --
    var LISTS_KEY = 'vc-lists';
    function loadLists() {
        var raw = store.get(LISTS_KEY, null);
        var merged = { blocklist: [], whitelist: [], whitelistMode: false };
        if (raw && typeof raw === 'object') {
            if (Array.isArray(raw.blocklist)) merged.blocklist = raw.blocklist.map(String);
            if (Array.isArray(raw.whitelist)) merged.whitelist = raw.whitelist.map(String);
            merged.whitelistMode = !!raw.whitelistMode;
        }
        return merged;
    }
    var lists = loadLists();
    function persistLists() { store.set(LISTS_KEY, lists); }

    // shared.js canonicalizeHostname(): lowercased, trailing dot and a
    // leading "www." stripped. Entries AND the current host are compared
    // through it, so "www.youtube.com" and "youtube.com" are one site —
    // the Active toggle and the Add-site input therefore write the same
    // entry for the same site (extension parity).
    function canonicalHost(host) {
        var h = String(host == null ? '' : host).trim().toLowerCase();
        if (!h) return '';
        return h.replace(/\.$/, '').replace(/^www\./, '');
    }
    var CANON_HOST = canonicalHost(HOST);

    // shared.js splitBlocklistEntry(): "domain[/path][?query]" → parts, the
    // domain canonicalized. Paths are NOT informational (extension issue
    // #69): "twitch.tv/*/clip/*" must scope the entry to clip pages, never
    // the whole site.
    function splitEntry(entry) {
        var v = String(entry == null ? '' : entry).trim().toLowerCase();
        if (!v) return null;
        v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme, if stored raw
        v = v.replace(/^[^/@]+@/, '');                   // credentials
        var query = '';
        var qi = v.indexOf('?');
        if (qi !== -1) { query = v.slice(qi + 1); v = v.slice(0, qi); }
        var si = v.indexOf('/');
        var domainPart = (si === -1 ? v : v.slice(0, si)).replace(/:\d+$/, '');   // port, if stored raw
        var domain = canonicalHost(domainPart);
        var path = si === -1 ? '' : v.slice(si);
        while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
        if (path === '/') path = '';
        if (!domain) return null;
        return { domain: domain, path: path, query: query };
    }
    function wildcardToRegExp(pattern, seg) {
        // shared.js: "*" matches any chars except "/" inside a path segment
        // (and any chars at all in a query).
        var body = pattern.split('*').map(function (part) {
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join(seg);
        return new RegExp('^' + body + '$');
    }
    // shared.js isUrlBlockedByEntry() + saved-entry query semantics: a bare
    // domain matches the host and its subdomains; a path scopes the entry
    // ("*" wildcards per segment; a plain path also covers descendants); a
    // query, when saved, must match exactly or via wildcards.
    function entryMatchesUrl(entry, url) {
        var parts = splitEntry(entry);
        if (!parts) return false;
        var parsed = null;
        try { parsed = new URL(String(url)); } catch (e) { parsed = null; }
        if (!parsed) return false;
        var host = canonicalHost(parsed.hostname);
        if (parts.domain !== host && !host.endsWith('.' + parts.domain)) return false;
        var path = parsed.pathname || '/';
        if (parts.path) {
            try {
                if (parts.path.indexOf('*') !== -1) {
                    if (!wildcardToRegExp(parts.path, '[^/]*').test(path)) return false;
                } else if (path !== parts.path && !path.startsWith(parts.path + '/')) {
                    return false;
                }
            } catch (e) { return false; }
        }
        if (parts.query) {
            var q = parsed.search ? parsed.search.slice(1) : '';
            try {
                if (parts.query.indexOf('*') !== -1) {
                    if (!wildcardToRegExp(parts.query, '.*').test(q)) return false;
                } else if (q !== parts.query) return false;
            } catch (e) { return false; }
        }
        return true;
    }
    function entriesMatchingUrl(list, url) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (entryMatchesUrl(list[i], url)) out.push(list[i]);
        }
        return out;
    }
    function listsBlockUrl(ls, url) {
        if (ls.whitelistMode) {
            // whitelist mode: only LISTED sites run (a path-scoped entry
            // allows exactly those paths, like the extension's allow list)
            return entriesMatchingUrl(ls.whitelist, url).length === 0;
        }
        return entriesMatchingUrl(ls.blocklist, url).length > 0;
    }
    function siteBlockedByLists() { return listsBlockUrl(lists, PAGE_URL); }
    // ---- remembered-profile keys (shared.js ranked settings matching) ----
    // Remembered profiles — and, since 7.1.6, the per-site Normalize
    // preference — are keyed by ENTRY, not just host:
    //   "youtube.com"               whole site (legacy vc-site:<host> keys
    //                               have this shape; the matcher canonicalizes)
    //   "youtube.com/music"         path + descendants
    //   "youtube.com/watch?v=abc"   exact query (manually created/renamed)
    //   "youtube.com/watch?v=*"     query wildcard
    // Loading picks the best-ranked match (shared.js getSiteSettingsKey);
    // saving updates the best-matching entry or creates a path key
    // (background.js mergeForUrl). Ported from shared.js:176-231, 233-318,
    // 428-484.
    function parseSiteLikeInput(value) {
        // shared.js parseSiteLikeInput
        var raw = String(value == null ? '' : value).trim();
        if (!raw) return null;
        if (/^(?:local file|file)$/i.test(raw) || /^file:/i.test(raw)) {
            return { file: true, domain: 'file', path: '', query: '' };
        }
        var candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw;
        var parsed = null;
        try { parsed = new URL(candidate); } catch (e) { parsed = null; }
        if (!parsed || !parsed.hostname) return null;
        var path = parsed.pathname || '';
        while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
        if (path === '/') path = '';
        return {
            file: false,
            domain: canonicalHost(parsed.hostname),
            path: path,
            query: parsed.search ? parsed.search.slice(1) : ''
        };
    }
    function normalizeSiteEntryInput(value, includeQuery) {
        // shared.js normalizeSiteSettingsEntryInput: query preservation is
        // opt-in (manual profile input); the popup's Remember/save path
        // drops it.
        var parsed = parseSiteLikeInput(value);
        if (!parsed) return '';
        if (parsed.file) return 'file';
        return parsed.domain + parsed.path + (includeQuery && parsed.query ? '?' + parsed.query : '');
    }
    function splitSiteEntry(entry) {
        // shared.js splitSiteSettingsEntry
        var normalized = normalizeSiteEntryInput(entry, true);
        if (!normalized) return null;
        if (normalized === 'file') return { file: true, domain: 'file', path: '', query: '' };
        var qi = normalized.indexOf('?');
        var withoutQuery = qi === -1 ? normalized : normalized.slice(0, qi);
        var query = qi === -1 ? '' : normalized.slice(qi + 1);
        var si = withoutQuery.indexOf('/');
        return {
            file: false,
            domain: si === -1 ? withoutQuery : withoutQuery.slice(0, si),
            path: si === -1 ? '' : withoutQuery.slice(si),
            query: query
        };
    }
    function isUrlRememberedByEntry(url, savedEntry) {
        // shared.js isUrlRememberedByEntry: bare domain matches the host and
        // its subdomains; a path scopes the entry ("*" per segment, plain
        // paths cover descendants); a SAVED query must match exactly or via
        // wildcards — default profiles ignore the query entirely.
        var saved = splitSiteEntry(savedEntry);
        if (!saved) return false;
        var rawUrl = String(url == null ? '' : url).trim();
        if (!rawUrl) return false;
        if (saved.file) return /^file:/i.test(rawUrl) || /^(?:local file|file)$/i.test(rawUrl);
        var current = null;
        try {
            if (/^[a-z][a-z0-9+.-]*:[/]{2}/i.test(rawUrl)) {
                var parsed = new URL(rawUrl);
                if (!/^https?:$/.test(parsed.protocol)) return false;
                current = {
                    domain: canonicalHost(parsed.hostname),
                    path: parsed.pathname || '/',
                    query: parsed.search ? parsed.search.slice(1) : ''
                };
            }
        } catch (e) { current = null; }
        if (!current) {
            var normalizedCurrent = normalizeSiteEntryInput(rawUrl, true);
            if (!normalizedCurrent || normalizedCurrent === 'file') return false;
            var split = splitSiteEntry(normalizedCurrent);
            if (!split) return false;
            current = { domain: split.domain, path: split.path || '/', query: split.query || '' };
        }
        if (!(current.domain === saved.domain || current.domain.endsWith('.' + saved.domain))) return false;
        if (saved.path) {
            try {
                if (saved.path.indexOf('*') !== -1) {
                    if (!wildcardToRegExp(saved.path, '[^/]*').test(current.path)) return false;
                } else if (current.path !== saved.path && !current.path.startsWith(saved.path + '/')) {
                    return false;
                }
            } catch (e) { return false; }
        }
        if (!saved.query) return true;
        try {
            if (saved.query.indexOf('*') !== -1) {
                return wildcardToRegExp(saved.query, '.*').test(current.query || '');
            }
            return (current.query || '') === saved.query;
        } catch (e) { return false; }
    }
    function siteMatchRank(url, savedEntry) {
        // shared.js getSiteSettingsMatchRank: query beats path beats bare
        // domain, then literal length, then fewer wildcards, then deeper and
        // longer domain labels.
        var saved = splitSiteEntry(savedEntry);
        if (!saved) return [0, 0, 0, 0, 0, 0, 0];
        var currentDomain = '';
        try {
            currentDomain = canonicalHost(new URL(String(url)).hostname);
        } catch (e) {
            var normalized = normalizeSiteEntryInput(url);
            var si = normalized.indexOf('/');
            currentDomain = si === -1 ? normalized : normalized.slice(0, si);
        }
        var wildcardCount = ((saved.path || '').match(/\*/g) || []).length +
            ((saved.query || '').match(/\*/g) || []).length;
        var literalLength = (saved.path || '').replace(/\*/g, '').length +
            (saved.query || '').replace(/\*/g, '').length;
        return [
            saved.query ? 1 : 0,
            saved.path ? 1 : 0,
            currentDomain === saved.domain ? 1 : 0,
            literalLength,
            -wildcardCount,
            saved.domain.split('.').length,
            saved.domain.length
        ];
    }
    function compareSiteMatches(url, a, b) {
        // shared.js compareSiteSettingsMatches: descending by rank, ties by
        // localeCompare — matches[0] is the most specific profile.
        var ar = siteMatchRank(url, a);
        var br = siteMatchRank(url, b);
        for (var i = 0; i < ar.length; i++) {
            if (ar[i] !== br[i]) return br[i] - ar[i];
        }
        return String(a).localeCompare(String(b));
    }
    function getSiteSettingsKey(entries, url) {
        // shared.js getSiteSettingsKey: exact normalized key (query kept)
        // first, then the best-ranked remembered match.
        if (!entries || !url) return null;
        var normalizedWithQuery = normalizeSiteEntryInput(url, true);
        if (normalizedWithQuery && entries[normalizedWithQuery]) return normalizedWithQuery;
        var normalized = normalizeSiteEntryInput(url);
        if (normalized === 'file' && entries['Local File']) return 'Local File';
        var matches = [];
        for (var key in entries) {
            if (Object.prototype.hasOwnProperty.call(entries, key) && isUrlRememberedByEntry(url, key)) {
                matches.push(key);
            }
        }
        matches.sort(function (a, b) { return compareSiteMatches(url, a, b); });
        return matches.length ? matches[0] : null;
    }
    function gmKeys() {
        try {
            if (typeof GM_listValues === 'function') return GM_listValues().map(String);
        } catch (e) { /* fall through to the localStorage fallback */ }
        var out = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('vc-tm:') === 0) out.push(k.slice(6));
            }
        } catch (e) { /* storage blocked */ }
        return out;
    }
    function readPrefixedMap(prefix) {
        var out = {};
        gmKeys().forEach(function (k) {
            if (k.indexOf(prefix) !== 0) return;
            var v = store.get(k, null);
            if (v && typeof v === 'object') out[k.slice(prefix.length)] = v;
        });
        return out;
    }
    function resolveSiteSettings(url) {
        var map = readPrefixedMap(SITE_PREFIX);
        var key = getSiteSettingsKey(map, url);
        return { key: key || '', entry: key ? map[key] : null };
    }
    function normalizerDefaultOn() {
        return !!store.get(NORMALIZER_DEFAULT_KEY, false);
    }
    function resolveNormalizerEnabled(url) {
        // cs.js:2347-2350 — per-site entry (ranked match) → global default
        var map = readPrefixedMap(NORMALIZER_PREFIX);
        var key = getSiteSettingsKey(map, url);
        if (key) return !!map[key].enabled;
        return normalizerDefaultOn();
    }
    function bestSaveKey(prefix, url) {
        // background.js mergeForUrl / popup.js setForUrl: update the
        // best-matching existing entry, else create under the page's path
        // key (query dropped — normalizeSiteSettingsEntryInput(url)).
        var map = readPrefixedMap(prefix);
        return getSiteSettingsKey(map, url) || normalizeSiteEntryInput(url);
    }

    // one-time migration: the pre-7.1.4 per-site "Active off" flag becomes a
    // blocklist entry (the extension migrated its legacy allow list likewise)
    (function migrateExcludedFlag() {
        if (store.get(EXCLUDED_KEY, false)) {
            if (!lists.blocklist.some(function (e) { return entryMatchesUrl(e, PAGE_URL); })) {
                lists.blocklist.push(CANON_HOST);
            }
            persistLists();
        }
        store.del(EXCLUDED_KEY);
    })();

    // ---- debug defaults + per-site overrides (options.html Debug section) --
    var DEBUG_DEFAULTS_KEY = 'vc-debug-defaults';
    var DEBUG_PREFIX = 'vc-debug:';
    var DEBUG_SITE_KEY = DEBUG_PREFIX + HOST;
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
    var siteDebug = (function () {
        var raw = store.get(DEBUG_SITE_KEY, null);
        return raw ? normalizeDebugConfig(raw) : null;   // null = no override
    })();
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

    // one-time normalize migration: ≤7.1.5 stored the Normalize preference
    // INSIDE the Remembered Audio entry, so it was lost whenever Remember was
    // off. Move it to the independent vc-normalizer: store (same profile
    // key, canonicalized) — the field's removal makes this run only once.
    (function migrateNormalizerPrefs() {
        var map = readPrefixedMap(SITE_PREFIX);
        var normMap = readPrefixedMap(NORMALIZER_PREFIX);
        for (var key in map) {
            if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
            var entry = map[key];
            if (!entry || typeof entry.normalizer !== 'boolean') continue;
            var normKey = normalizeSiteEntryInput(key, true) || key;
            if (!normMap[normKey]) store.set(NORMALIZER_PREFIX + normKey, { enabled: !!entry.normalizer });
            delete entry.normalizer;
            if (entry.remember) store.set(SITE_PREFIX + key, entry);
            else store.del(SITE_PREFIX + key);
        }
    })();

    var resolvedSite = resolveSiteSettings(PAGE_URL);
    var siteSettingsKey = resolvedSite.key;         // '' when nothing matches
    var siteSettings = resolvedSite.entry;           // {remember, volume, mono, muted}
    var excluded = siteBlockedByLists();
    function loadNormalizerConfig() {
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
    }
    var normalizerConfig = loadNormalizerConfig();

    // Live state (what the engine receives). dB is the REQUESTED value —
    // media limits clamp only the applied gain (cs.js requestedDb vs dB),
    // so a preserved +12 dB request survives a temporary DRM fallback.
    var state = {
        enabled: !excluded,
        dB: siteSettings && siteSettings.remember ? normalizeDb(siteSettings.volume) : 0,
        mono: !!(siteSettings && siteSettings.remember && siteSettings.mono),
        muted: !!(siteSettings && siteSettings.remember && siteSettings.muted),
        // cs.js:2347-2356: the Normalize preference resolves independently of
        // Remembered Audio (per-site entry → global default).
        normalizerEnabled: resolveNormalizerEnabled(PAGE_URL)
    };
    var remembered = !!(siteSettings && siteSettings.remember);
    var engineRestriction = '';      // hook aggregate: '' | 'restricted' | 'cross-origin'
    var meter = { peakDb: -Infinity, normalizerGainDb: 0 };
    var meterListeners = [];

    function persistSite() {
        // background.js mergeForUrl / popup.js removeForUrl: Remember off
        // deletes the profile governing this URL; Remember on updates the
        // best-matching entry, or creates one under the page's path key.
        if (!remembered) {
            if (siteSettingsKey) store.del(SITE_PREFIX + siteSettingsKey);
            return;
        }
        var key = siteSettingsKey || bestSaveKey(SITE_PREFIX, PAGE_URL);
        siteSettingsKey = key;
        store.set(SITE_PREFIX + key, {
            remember: true,
            volume: state.dB,        // requested dB (background.js saves requestedVolume)
            mono: state.mono,
            muted: state.muted
        });
    }
    function persistNormalizerPref() {
        // popup.js toggleNormalizer → setForUrl: the per-site preference is
        // saved independently from Remembered Audio (README: "does not
        // require Remember"), updating the best-matching entry or creating
        // one under the page's path key.
        store.set(NORMALIZER_PREFIX + bestSaveKey(NORMALIZER_PREFIX, PAGE_URL), {
            enabled: state.normalizerEnabled
        });
    }

    // ---- boost-limit verdicts (cs.js getBoostLimitInfo + popup.js texts) --
    function isLimitReasonBypassed(reason) {
        // cs.js isBoostLimitReasonBypassed: the dangerous debug overrides
        // lift the matching verdict, so a stale clamp cannot survive them.
        if (reason === 'restricted' && effectiveDebugConfig().forceDrmCapture) return true;
        if (reason === 'cross-origin' && effectiveDebugConfig().forceCorsCapture) return true;
        return false;
    }
    function currentLimitation() {
        // The MAIN-world hook can report only 'restricted'/'cross-origin'
        // (route-failed is invisible from the controller). Force native is a
        // route POLICY, not a capability verdict (cs.js:600-605): it clamps
        // maxDb to 0, but a more informative DRM/CORS verdict outranks it.
        // Unknown reasons fall back to BOOST_LIMIT_NOTES.fallback.
        var reason = isLimitReasonBypassed(engineRestriction) ? '' : engineRestriction;
        if (!reason && effectiveDebugConfig().debugRouteMode === 'native') reason = 'native-route';
        if (!reason) return { reason: '', note: '', boostLimited: false, maxDb: MAX_DB };
        return {
            reason: reason,
            note: BOOST_LIMIT_NOTES[reason] || BOOST_LIMIT_NOTES.fallback,
            boostLimited: true,
            maxDb: 0
        };
    }
    function monoAvailability() {
        // cs.js getMonoAvailability: the native-route policy first, then any
        // boost-limit verdict (reason '' degrades to the fallback note).
        if (effectiveDebugConfig().debugRouteMode === 'native') {
            return { available: false, reason: 'native-route' };
        }
        var limit = currentLimitation();
        if (limit.boostLimited) return { available: false, reason: limit.reason || 'fallback' };
        return { available: true, reason: '' };
    }
    function normalizerAvailability() {
        // cs.js getNormalizerAvailability (identical rules)
        if (effectiveDebugConfig().debugRouteMode === 'native') {
            return { available: false, reason: 'native-route' };
        }
        var limit = currentLimitation();
        if (limit.boostLimited) return { available: false, reason: limit.reason || 'fallback' };
        return { available: true, reason: '' };
    }
    // popup.js applyMonoAvailability — 5-way reason texts (verbatim)
    function monoUnavailableMessage(reason) {
        return reason === 'restricted'
            ? 'Mono unavailable while DRM/restricted media is using fallback audio.'
            : reason === 'cross-origin'
                ? 'Mono unavailable while cross-origin media is using fallback audio.'
                : reason === 'route-failed'
                    ? 'Mono unavailable because the WebAudio route could not be created.'
                    : reason === 'native-route'
                        ? 'Mono unavailable while HTML Media Route Override is Force native volume fallback.'
                        : 'Mono unavailable while WebAudio processing is unavailable.';
    }
    // popup.js applyNormalizerState — 4-way reason texts (verbatim)
    function normalizerUnavailableMessage(reason) {
        return reason === 'restricted'
            ? 'Normalize cannot process DRM-protected audio in this browser.'
            : reason === 'cross-origin'
                ? 'Normalize cannot analyze cross-origin audio without WebAudio access.'
                : reason === 'native-route'
                    ? 'Normalize requires WebAudio; Force native routing is selected.'
                    : 'Normalize needs a supported WebAudio route and cannot process this media.';
    }
    function appliedDb() {
        // The gain actually applied: the requested value clamped by the
        // current media limitation (cs.js normalizeDbForCurrentMedia).
        return Math.min(state.dB, currentLimitation().maxDb);
    }

    // ============================================================= bridge
    var PAGE_BRIDGE_TOKEN = makeToken();

    function currentState() {
        return {
            enabled: state.enabled,
            dB: appliedDb(),        // the hook receives the clamped value (cs.js)
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
            // SPA navigation: the URL feeds the access-list verdict, the
            // ranked settings key and the Normalize preference — re-run all
            // of them like cs.js start() does (path-scoped entries may now
            // match differently). The hook's href payload is untrusted page
            // data; location.href is authoritative (cs.js:2455-2458).
            reevaluateForLocation();
        } else if (data.command === 'pageRestrictionChanged') {
            engineRestriction = data.restriction === 'restricted' ? 'restricted'
                : data.restriction === 'cross-origin' ? 'cross-origin' : '';
            sendState();       // the applied gain may need re-clamping
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
        // background.js setVolume: the REQUESTED value is kept (and
        // remembered) even while media limits clamp the applied gain.
        state.dB = normalizeDb(db);
        persistSite();
        sendState();
        notifyUI();
    }
    function bumpVolume(delta) {
        // background.js volume-up ceiling guard: at a boost-limited ceiling
        // a press must not replace the preserved request with an invisible
        // +1 dB change that only takes effect on later, routable media.
        if (delta > 0) {
            var limit = currentLimitation();
            if (limit.boostLimited && appliedDb() >= limit.maxDb) return;
        }
        setVolume(state.dB + delta);
    }
    function toggleMute() {
        state.muted = !state.muted;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleMono() {
        // popup.js guards the disabled switch (mono is unavailable while a
        // boost-limit verdict or the native-route policy is active)
        if (!monoAvailability().available) return;
        state.mono = !state.mono;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleNormalizer() {
        // The preference stays valid even while unavailable (popup.js keeps
        // it stored/checked); only changes are blocked.
        if (!normalizerAvailability().available) return;
        state.normalizerEnabled = !state.normalizerEnabled;
        persistNormalizerPref();     // independent of Remember (FIX parity)
        sendState();
        notifyUI();
    }
    function toggleRemember() {
        remembered = !remembered;
        persistSite();          // writes the profile, or deletes it (removeForUrl)
        notifyUI();
    }
    function toggleActive() {
        // popup.js/options.js semantics: Active edits the access list that
        // governs this site — the blocklist entry in Blacklist mode, the
        // whitelist entry in Whitelist mode. Like background.js
        // setSiteActive, flipping Active ON removes EVERY entry that keeps
        // this page inactive (path-scoped ones included) and new entries are
        // stored canonicalized ("www." stripped).
        if (lists.whitelistMode) {
            var allowed = entriesMatchingUrl(lists.whitelist, PAGE_URL).length > 0;
            lists.whitelist = allowed
                ? lists.whitelist.filter(function (e) { return !entryMatchesUrl(e, PAGE_URL); })
                : lists.whitelist.concat([CANON_HOST]);
        } else {
            var blocked = entriesMatchingUrl(lists.blocklist, PAGE_URL).length > 0;
            lists.blocklist = blocked
                ? lists.blocklist.filter(function (e) { return !entryMatchesUrl(e, PAGE_URL); })
                : lists.blocklist.concat([CANON_HOST]);
        }
        persistLists();
        excluded = siteBlockedByLists();
        state.enabled = !excluded;
        sendState();
        notifyUI();
    }
    function resetSiteSettings() {
        // remove every profile that governs this page: remembered audio
        // (best match + legacy host key), the Normalize preference and the
        // per-site debug override, then unblock the URL in the lists.
        var siteKey = siteSettingsKey || normalizeSiteEntryInput(PAGE_URL);
        if (siteKey) store.del(SITE_PREFIX + siteKey);
        store.del(SITE_PREFIX + HOST);          // legacy host-only key
        store.del(NORMALIZER_PREFIX + (siteKey || HOST));
        store.del(EXCLUDED_KEY);
        store.del(DEBUG_SITE_KEY);
        lists.blocklist = lists.blocklist.filter(function (e) { return !entryMatchesUrl(e, PAGE_URL); });
        persistLists();
        remembered = false;
        siteSettingsKey = '';
        siteSettings = null;
        siteDebug = null;
        excluded = siteBlockedByLists();
        state.enabled = !excluded; state.dB = 0; state.mono = false;
        state.muted = false;
        state.normalizerEnabled = resolveNormalizerEnabled(PAGE_URL);
        sendState();
        notifyUI();
    }

    // ---- re-resolution (SPA navigation + cross-tab storage changes) -------
    function reevaluateForLocation() {
        // cs.js start() on locationChanged: re-run everything the URL feeds.
        PAGE_URL = location.href;
        var resolved = resolveSiteSettings(PAGE_URL);
        siteSettingsKey = resolved.key;
        siteSettings = resolved.entry;
        // A matching remembered profile replaces the controls; without one,
        // unsaved in-tab values survive the navigation (cs.js:2410-2421).
        remembered = !!(siteSettings && siteSettings.remember);
        if (remembered) {
            if (siteSettings.volume !== undefined) state.dB = normalizeDb(siteSettings.volume);
            if (siteSettings.mono !== undefined) state.mono = !!siteSettings.mono;
            if (siteSettings.muted !== undefined) state.muted = !!siteSettings.muted;
        }
        state.normalizerEnabled = resolveNormalizerEnabled(PAGE_URL);
        excluded = listsBlockUrl(lists, PAGE_URL);
        state.enabled = !excluded;
        sendState();
        notifyUI();      // the popup shows any new exclusion status live
    }

    function reapplySettingsFromStorage() {
        // Mirrors cs.js storage.onChanged → start(): re-resolve lists, the
        // ranked settings key, the Normalize preference, the normalizer
        // config and the debug settings from storage, then apply only what
        // actually changed. Identical resolved state → return (the writer
        // tab's echo events stop here, so no feedback loop).
        var nextLists = loadLists();
        var resolved = resolveSiteSettings(PAGE_URL);
        var entry = resolved.entry;
        var rememberedNow = !!(entry && entry.remember);
        var next = {
            excluded: listsBlockUrl(nextLists, PAGE_URL),
            dB: rememberedNow && entry.volume !== undefined ? normalizeDb(entry.volume) : state.dB,
            mono: rememberedNow && entry.mono !== undefined ? !!entry.mono : state.mono,
            muted: rememberedNow && entry.muted !== undefined ? !!entry.muted : state.muted,
            normalizerEnabled: resolveNormalizerEnabled(PAGE_URL),
            config: loadNormalizerConfig(),
            debugDefaults: normalizeDebugConfig(store.get(DEBUG_DEFAULTS_KEY, null)),
            siteDebug: (function () {
                var raw = store.get(DEBUG_SITE_KEY, null);
                return raw ? normalizeDebugConfig(raw) : null;
            })()
        };
        var unchanged =
            JSON.stringify(lists) === JSON.stringify(nextLists) &&
            excluded === next.excluded &&
            siteSettingsKey === resolved.key &&
            remembered === rememberedNow &&
            state.dB === next.dB && state.mono === next.mono && state.muted === next.muted &&
            state.normalizerEnabled === next.normalizerEnabled &&
            JSON.stringify(normalizerConfig) === JSON.stringify(next.config) &&
            JSON.stringify(debugDefaults) === JSON.stringify(next.debugDefaults) &&
            JSON.stringify(siteDebug) === JSON.stringify(next.siteDebug);
        if (unchanged) return;
        lists = nextLists;
        siteSettingsKey = resolved.key;
        siteSettings = entry;
        remembered = rememberedNow;
        excluded = next.excluded;
        state.enabled = !excluded;
        state.dB = next.dB; state.mono = next.mono; state.muted = next.muted;
        state.normalizerEnabled = next.normalizerEnabled;
        normalizerConfig = next.config;
        debugDefaults = next.debugDefaults;
        siteDebug = next.siteDebug;
        applyDebugHighlight(effectiveDebugConfig().debugMode);
        sendState();
        notifyUI();
    }

    // ---- cross-tab live sync (cs.js storage.onChanged) --------------------
    // GM storage writes from this script's instances in OTHER tabs (or this
    // tab's echo — TM may deliver the event to the writer too) re-resolve
    // and re-apply here. Registration is per key, so re-scan periodically
    // and after every event to pick up vc-site:/vc-normalizer:/vc-debug:
    // keys that did not exist when the watchers were last registered.
    var storageWatchKeys = [];
    function watchedStorageKeys() {
        var keys = [LISTS_KEY, 'vc-normalizer-config', NORMALIZER_DEFAULT_KEY, DEBUG_DEFAULTS_KEY];
        gmKeys().forEach(function (k) {
            if (k.indexOf(SITE_PREFIX) === 0 || k.indexOf(NORMALIZER_PREFIX) === 0 ||
                k.indexOf(DEBUG_PREFIX) === 0) keys.push(k);
        });
        return keys;
    }
    var storageResyncTimer = null;
    function onStorageKeyChanged() {
        if (storageResyncTimer) return;       // coalesce bursts (Reset-all)
        storageResyncTimer = setTimeout(function () {
            storageResyncTimer = null;
            watchStorage();
            reapplySettingsFromStorage();
        }, 60);
    }
    function watchStorage() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        watchedStorageKeys().forEach(function (k) {
            if (storageWatchKeys.indexOf(k) !== -1) return;
            storageWatchKeys.push(k);
            try { GM_addValueChangeListener(k, onStorageKeyChanged); } catch (e) { /* rejected */ }
        });
    }

    // ============================================================= UI (top frame)
    var ui = null;

    function notifyUI() {
        if (!ui) return;
        ui.refresh();
        // keep an open Advanced view in step (cross-tab storage changes,
        // SPA re-evaluation) — cheap while the volume view is showing
        if (ui.syncIfVisible) ui.syncIfVisible();
    }

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
        // normalizer default + management lists + about (v7.1.6)
        var advNormDefault = advRoot.querySelector('#adv-normalizer-default');
        var advMemoryList = advRoot.querySelector('#adv-memory-list');
        var advDebugList = advRoot.querySelector('#adv-debug-list');
        var normPanel = root.querySelector('.normalizer-panel');
        var normSwitchLabel = root.querySelector('.normalizer-switch');
        var monoLabel = root.querySelector('label[for="mono-checkbox"]');

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

        // cs.js getBoostLimitInfo().maxDb: 0 for ANY limitation reason (DRM,
        // CORS, route failure, force-native), +32 otherwise.
        function maxDb() { return currentLimitation().maxDb; }
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
            if (shadow.activeElement !== advNormDefault) advNormDefault.checked = normalizerDefaultOn();
            var installed = hookInstalled();
            advEngine.textContent = installed
                ? 'Engine: active on this page \u2014 hook installed'
                : 'Engine: waiting (strict-CSP pages fall back within ~2 s)';
            syncAccess();
            syncDebug();
            renderMemoryList();
            renderDebugList();
        }
        advNormDefault.addEventListener('change', function () {
            // options.html "Normalize by default on sites without an override"
            // → cs.js:2347-2356 re-resolves the preference for this page
            store.set(NORMALIZER_DEFAULT_KEY, !!advNormDefault.checked);
            state.normalizerEnabled = resolveNormalizerEnabled(PAGE_URL);
            sendState();
            refresh();
        });
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
            // a leading www.; any path/query stays (path-scoped entries,
            // issue #69); a trailing "/" is meaningless and trimmed.
            var v = String(raw == null ? '' : raw).trim().toLowerCase();
            v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
            v = v.replace(/^[^/@]+@/, '');
            v = v.replace(/:\d+(?=\/|$|\?)/, '');
            v = v.replace(/^www\./, '');
            v = v.replace(/^\/+/, '');
            return v.replace(/\/+$/, '');
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
                row.className = 'vc-adv-entry' + (entryMatchesUrl(entry, PAGE_URL) ? ' vc-current' : '');
                var name = document.createElement('span');
                name.textContent = entry;
                var parts = splitEntry(entry);
                name.title = parts && parts.path
                    ? 'Scoped to ' + parts.path + ' on ' + parts.domain + ' (and its subdomains)'
                    : 'Matches ' + (parts ? parts.domain : entry) + ' and its subdomains';
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
            var domain = entry.split('/')[0].replace(/\?.*$/, '');
            // parseSiteLikeInput semantics: single-label hosts (localhost,
            // intranet names) are valid — new URL("http://localhost") is.
            if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
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

        // ---- remembered profiles (options.html "Remembered Settings") ------
        function sortedMapKeys(map) {
            var keys = [];
            for (var k in map) {
                if (Object.prototype.hasOwnProperty.call(map, k)) keys.push(k);
            }
            keys.sort(function (a, b) { return String(a).localeCompare(String(b)); });
            return keys;
        }
        function makeChip(text, title) {
            var chip = document.createElement('span');
            chip.className = 'vc-adv-chip';
            chip.textContent = text;
            if (title) chip.title = title;
            return chip;
        }
        function makeRemoveButton(label, onRemove) {
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'vc-adv-remove';
            rm.textContent = '\u00d7';
            rm.setAttribute('aria-label', label);
            rm.addEventListener('click', onRemove);
            return rm;
        }
        function renderMemoryList() {
            advMemoryList.innerHTML = '';
            var map = readPrefixedMap(SITE_PREFIX);
            var keys = sortedMapKeys(map);
            if (!keys.length) {
                var empty = document.createElement('div');
                empty.className = 'vc-adv-empty';
                empty.textContent = 'No remembered settings';
                advMemoryList.appendChild(empty);
                return;
            }
            keys.forEach(function (key) {
                var entry = map[key];
                var row = document.createElement('div');
                row.className = 'vc-adv-entry' + (key === siteSettingsKey ? ' vc-current' : '');
                // rename = options.js/background.js "rename": the new key is
                // normalized with the query kept (Enter/blur commits)
                var name = document.createElement('input');
                name.type = 'text';
                name.className = 'vc-adv-rename';
                name.value = key;
                name.spellcheck = false;
                name.title = 'Rename remembered settings';
                name.setAttribute('aria-label', 'Rename remembered settings for ' + key);
                name.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
                });
                name.addEventListener('blur', function () {
                    var newKey = normalizeSiteEntryInput(name.value, true);
                    if (!newKey) {
                        alert('Site cannot be empty.');
                        name.value = key;
                        return;
                    }
                    if (newKey === key) { name.value = key; return; }
                    if (store.get(SITE_PREFIX + newKey, null)) {
                        alert('A remembered entry for that site/path already exists.');
                        name.value = key;
                        return;
                    }
                    var value = store.get(SITE_PREFIX + key, null);
                    if (value) {
                        store.set(SITE_PREFIX + newKey, value);
                        store.del(SITE_PREFIX + key);
                    }
                    reapplySettingsFromStorage();   // re-bind the current page
                    renderMemoryList();
                });
                var chips = document.createElement('span');
                chips.className = 'vc-adv-chips';
                var vol = entry && entry.volume !== undefined ? normalizeDb(entry.volume) : 0;
                chips.appendChild(makeChip((vol >= 0 ? '+' : '') + vol + ' dB', 'Remembered volume'));
                if (entry && entry.mono) chips.appendChild(makeChip('Mono', 'Mono down-mix remembered'));
                if (entry && entry.muted) chips.appendChild(makeChip('Muted', 'Mute remembered'));
                row.appendChild(name);
                row.appendChild(chips);
                row.appendChild(makeRemoveButton('Remove remembered settings for ' + key, function () {
                    store.del(SITE_PREFIX + key);
                    reapplySettingsFromStorage();
                    renderMemoryList();
                }));
                advMemoryList.appendChild(row);
            });
        }

        // ---- per-site debug overrides (options.html "Site Debug Overrides") -
        function renderDebugList() {
            advDebugList.innerHTML = '';
            var map = readPrefixedMap(DEBUG_PREFIX);
            var keys = sortedMapKeys(map);
            if (!keys.length) {
                var empty = document.createElement('div');
                empty.className = 'vc-adv-empty';
                empty.textContent = 'No site debug overrides';
                advDebugList.appendChild(empty);
                return;
            }
            keys.forEach(function (key) {
                var cfg = normalizeDebugConfig(map[key]);
                var row = document.createElement('div');
                row.className = 'vc-adv-entry' + (key === HOST ? ' vc-current' : '');
                var name = document.createElement('span');
                name.textContent = key;
                var parts = splitSiteEntry(key);
                if (parts && !parts.file) {
                    name.title = parts.path
                        ? 'Scoped to ' + parts.path + ' on ' + parts.domain
                        : 'Applies to ' + parts.domain + ' and its subdomains';
                }
                var summary = document.createElement('span');
                summary.className = 'vc-adv-summary';
                var flags = [];
                if (cfg.debugMode) flags.push('Highlight');
                if (cfg.forceDrmCapture) flags.push('DRM');
                if (cfg.forceCorsCapture) flags.push('CORS');
                if (cfg.debugRouteMode !== 'auto') {
                    flags.push('Route: ' + (cfg.debugRouteMode === 'webaudio' ? 'WebAudio' : 'Native'));
                }
                summary.textContent = flags.length ? flags.join(', ') : 'All off';
                row.appendChild(name);
                row.appendChild(summary);
                row.appendChild(makeRemoveButton('Remove site debug override for ' + key, function () {
                    store.del(DEBUG_PREFIX + key);
                    reapplySettingsFromStorage();
                    renderDebugList();
                }));
                advDebugList.appendChild(row);
            });
        }

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
            refresh();      // route changes alter the boost-limit verdict
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
            renderDebugList();
            refresh();
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
            renderDebugList();
            refresh();
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
                gmKeys().forEach(function (k) { store.del(k); n++; });
            } catch (e) {}
            // live state back to fresh-install values
            remembered = false;
            siteSettingsKey = '';
            siteSettings = null;
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
        // The fullscreen element can be REPLACED while the host lives inside
        // it (SPA players rebuild their DOM on navigation in fullscreen) —
        // the host would be dropped with the old subtree and the GUI would
        // vanish for the rest of the page's life. Heartbeat re-attach.
        setInterval(function () {
            try {
                if (!document.contains(host)) document.documentElement.appendChild(host);
            } catch (e) { /* page blocked the move — retry next tick */ }
        }, 2000);

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
            // popup.js:548 — the peak warning needs Normalize enabled AND
            // available (any boost-limit verdict hides it)
            peakWarn.classList.toggle('hidden',
                !(state.normalizerEnabled && normalizerAvailability().available && Number.isFinite(peakDb) && peakDb >= -0.3));
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
            if (lists.whitelistMode) {
                exclusionDetail.textContent = location.hostname + ' is not on the allowed-sites list. Toggle Active, or add it under Settings → Site access, to reactivate.';
            } else {
                // popup.js v6.15: name the entry that keeps the site off (and
                // count extras) so the user knows exactly what to remove.
                var blocking = entriesMatchingUrl(lists.blocklist, PAGE_URL);
                var entryNote = blocking.length
                    ? ' (matched your blocklist entry "' + blocking[0] + '"'
                        + (blocking.length > 1 ? ' and ' + (blocking.length - 1) + ' more' : '') + ')'
                    : '';
                exclusionDetail.textContent = location.hostname + entryNote + ' is on the blocked-sites list. Toggle Active, or remove it under Settings → Site access, to reactivate.';
            }

            slider.value = String(shown);
            slider.max = String(m);
            slider.style.setProperty('--vc-range-steps', String(Math.max(1, m - MIN_DB)));
            slider.disabled = !active;

            volumeText.value = (shown >= 0 ? '+' : '') + shown;
            volumeText.disabled = !active;

            muteBtn.classList.toggle('muted', state.muted);
            muteLabel.textContent = state.muted ? 'Unmute' : 'Mute';
            muteBtn.disabled = !active;

            // ---- boost-limit verdicts (popup.js applyAudioControlState) ----
            var limit = currentLimitation();
            // popup.js:583-588 — the note carries the verdict text plus the
            // Normalize addendum while the normalizer is also unavailable
            // (any boost-limit verdict makes it unavailable).
            limitNote.classList.toggle('hidden', !(limit.boostLimited && active));
            if (limit.boostLimited) {
                limitNote.textContent = limit.note +
                    ' Normalize is also unavailable until compatible WebAudio playback resumes.';
            }
            boostWarning.classList.toggle('hidden', !(shown >= 6 && active));

            var monoAvail = monoAvailability();
            var normAvail = normalizerAvailability();
            // popup.js applyNormalizerState: the preference stays checked but
            // changes are blocked; the explanation (4-way reason + the
            // "will resume" suffix while enabled-but-unavailable) is shown.
            normCheckbox.checked = state.normalizerEnabled;
            normCheckbox.disabled = !normAvail.available || !active;
            normCheckbox.setAttribute('aria-disabled', String(!normAvail.available));
            var normMessage = normalizerUnavailableMessage(normAvail.reason);
            var normExplanation = state.normalizerEnabled && !normAvail.available
                ? normMessage + ' Your saved Normalize preference will resume when supported audio plays.'
                : normMessage;
            normNote.classList.toggle('hidden', normAvail.available || !active);
            if (!normAvail.available) normNote.textContent = normExplanation;
            normDetails.hidden = !(state.normalizerEnabled && normAvail.available);
            if (normPanel) normPanel.classList.toggle('is-unavailable', !normAvail.available);
            if (normSwitchLabel) {
                normSwitchLabel.title = normAvail.available
                    ? 'Automatically even out loud and quiet audio'
                    : normExplanation;
            }

            // popup.js applyMonoAvailability: 5-way reason text on the label
            monoCheckbox.checked = state.mono;
            monoCheckbox.disabled = !monoAvail.available || !active;
            monoCheckbox.setAttribute('aria-disabled', String(!monoAvail.available));
            if (monoLabel) {
                monoLabel.classList.toggle('is-disabled', !monoAvail.available);
                monoLabel.title = monoAvail.available
                    ? 'Toggle Mono Audio'
                    : monoUnavailableMessage(monoAvail.reason);
            }
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
            syncIfVisible: function () {
                if (open && view === 'advanced') syncAdvanced();
            },
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
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-normalizer-default"/>' +
        '        <span>Normalize by default on sites without an override</span></label>' +
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
        '        <span>Experimental true-peak limiter (opt-in)</span></label>' +
        '      <div class="vc-adv-hint">Honored only by the extension\u2019s isolated fallback route (mainly Firefox); no effect on the page-engine route this script uses \u2014 identical to the extension\u2019s behavior on Chrome.</div>' +
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
        '      <div class="vc-adv-hint">Blacklist: listed sites are skipped entirely (native volume only). Whitelist: only listed sites run Volume Control. Entries match subdomains; an optional path (with * wildcards, e.g. example.com/videos/*) scopes the entry, and the popup’s Active toggle edits the same list for this site.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Remembered settings</div>' +
        '      <div class="vc-adv-hint">Saved volume, mono and mute per site or URL path. A path such as example.com/videos applies to that path and its descendants; a renamed key may carry a query (youtube.com/watch?v=abc) for an exact query-scoped profile. Rename commits on Enter or blur.</div>' +
        '      <div id="adv-memory-list" class="vc-adv-list"></div>' +
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
        '      <div class="vc-adv-h">Site debug overrides</div>' +
        '      <div class="vc-adv-hint">Every stored per-site override, independent from Remembered Settings. Removing one restores the global defaults for that site.</div>' +
        '      <div id="adv-debug-list" class="vc-adv-list"></div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Engine</div>' +
        '      <div class="vc-adv-row"><span id="adv-engine-status">Engine: \u2026</span></div>' +
        '      <div class="vc-adv-hint">The audio engine is the extension\u2019s real page-audio-hook.js. On strict-CSP sites the inline install is blocked and it falls back automatically \u2014 nothing to configure.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Keyboard shortcuts</div>' +
        '      <div class="vc-shortcut"><span>Increase volume by 1 dB</span><span class="vc-adv-keys">' +
        '<kbd>Alt</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>\u2191</kbd></span></div>' +
        '      <div class="vc-shortcut"><span>Decrease volume by 1 dB</span><span class="vc-adv-keys">' +
        '<kbd>Alt</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>\u2193</kbd></span></div>' +
        '      <div class="vc-shortcut"><span>Reset volume to 0 dB</span><span class="vc-adv-keys">' +
        '<kbd>Alt</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>0</kbd></span></div>' +
        '      <div class="vc-shortcut"><span>Toggle mono audio</span><span class="vc-adv-keys">' +
        '<kbd>Alt</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>M</kbd></span></div>' +
        '      <div class="vc-shortcut"><span>Toggle mute</span><span class="vc-adv-keys">' +
        '<kbd>Alt</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>U</kbd></span></div>' +
        '      <div class="vc-shortcut"><span>Open volume control</span><span class="vc-adv-keys">' +
        '<kbd>Alt</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>P</kbd></span></div>' +
        '      <div class="vc-adv-hint">The userscript\u2019s page-level keybindings. The extension\u2019s global commands work browser-wide; a userscript can only listen on the focused page (and its toggle-mute command has no default key \u2014 U is this script\u2019s choice).</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Data</div>' +
        '      <div class="vc-adv-row vc-adv-data"><span id="adv-data-note">Sites, remembered volumes, positions, access lists, debug overrides.</span>' +
        '        <button id="adv-reset-all" class="vc-adv-danger" type="button">Reset all data</button></div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">About</div>' +
        '      <div class="vc-adv-row vc-adv-about"><span>About Volume Control <strong>v__VERSION__</strong></span>' +
        '        <a class="vc-adv-site" href="https://chaython.github.io/volumecontrol/" target="_blank" rel="noreferrer">chaython.github.io/volumecontrol \u2197</a></div>' +
        '      <div class="vc-adv-hint">Open Source project hosted on GitHub. Developed by Chaython.</div>' +
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
        '.vc-tm-btn.vc-tm-pulse{animation:vc-tm-pulse 1.3s ease 1;}',
        // popup.css touch block (hover:none + pointer:coarse), scoped to the
        // floating popup: the extension targets html/body/#popup-content of
        // the popup page — here the popup root and its content play those
        // roles. Same 44px targets, track/thumb sizes and touch-action.
        '@media (hover:none) and (pointer:coarse){',
        '.vc-popup-anchor .vc-popup{width:100%;min-width:0;max-width:100%;box-sizing:border-box;}',
        '.vc-popup-anchor .vc-popup #popup-content{width:100%;box-sizing:border-box;}',
        '.vc-popup-anchor .vc-popup .top-controls{padding:8px 12px 0;margin-bottom:12px;}',
        '.vc-popup-anchor .vc-popup .bot-controls{padding:0 12px 12px;gap:12px;flex-wrap:wrap;margin-bottom:0;}',
        '.vc-popup-anchor .vc-popup .left,.vc-popup-anchor .vc-popup .right{gap:12px;flex-wrap:wrap;}',
        '.vc-popup-anchor .vc-popup .right{margin-left:auto;}',
        '.vc-popup-anchor .vc-popup .switch-container,.vc-popup-anchor .vc-popup .settings,',
        '.vc-popup-anchor .vc-popup .mute-btn{min-height:44px;}',
        '.vc-popup-anchor .vc-popup .switch-container{gap:0;}',
        '.vc-popup-anchor .vc-popup .switch{width:44px;height:28px;}',
        '.vc-popup-anchor .vc-popup .slider{border-radius:28px;}',
        '.vc-popup-anchor .vc-popup .slider:before{width:20px;height:20px;}',
        '.vc-popup-anchor .vc-popup input:checked + .slider:before{transform:translateX(16px);}',
        '.vc-popup-anchor .vc-popup .settings{padding:8px;}',
        '.vc-popup-anchor .vc-popup .mute-btn{padding:6px 10px;}',
        '.vc-popup-anchor .vc-popup input[type=range]{height:44px;margin:4px 0 8px;touch-action:pan-y;}',
        '.vc-popup-anchor .vc-popup input[type=range]::-moz-range-track{height:12px;}',
        '.vc-popup-anchor .vc-popup input[type=range]::-moz-range-thumb{width:24px;height:32px;border-radius:7px;}',
        '.vc-popup-anchor .vc-popup input[type=range]::-webkit-slider-thumb{width:24px;height:32px;margin-top:-11px;border-radius:7px;}',
        '.vc-popup-anchor .vc-popup #volume-text{font-size:18px;min-height:36px;}',
        '}'
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
        // remembered/debug management rows (options.html list entries)
        '.vc-adv-empty{font:italic 400 11px/1.6 "Segoe UI",Tahoma,sans-serif;color:#80868b;padding:0 2px;}',
        '.vc-adv-rename{flex:1;min-width:0;border:1px solid transparent;border-radius:6px;background:transparent;',
        'color:inherit;font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;padding:2px 6px;}',
        '.vc-adv-rename:hover{border-color:rgba(0,0,0,.2);}',
        '.vc-adv-rename:focus{outline:2px solid #9aa0a6;outline-offset:-1px;border-color:transparent;background:#fff;}',
        '.vc-adv-chips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end;}',
        '.vc-adv-chip{border:1px solid rgba(0,0,0,.15);border-radius:9px;padding:1px 7px;white-space:nowrap;',
        'font:600 10px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;}',
        '.vc-adv-summary{font:400 10px/1.4 "Segoe UI",Tahoma,sans-serif;color:#80868b;white-space:nowrap;}',
        // keyboard shortcuts (options.css .shortcut-entry/.keycap look)
        '.vc-shortcut{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 2px;',
        'font:400 12px/1.5 "Segoe UI",Tahoma,sans-serif;color:#3c4043;}',
        '.vc-adv-keys{display:flex;align-items:center;gap:4px;flex-shrink:0;}',
        '.vc-adv-keys kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;',
        'padding:1px 5px;background:#fff;border:1px solid #aaa;border-bottom-width:2px;border-radius:4px;',
        'font:600 10px/1 "Segoe UI",Tahoma,sans-serif;color:#444;box-shadow:0 1px 0 #ddd;}',
        '.vc-adv-keys i{font:700 10px/1 "Segoe UI",Tahoma,sans-serif;color:#80868b;font-style:normal;user-select:none;}',
        '.vc-adv-about{justify-content:space-between;align-items:center;flex-wrap:wrap;}',
        '.vc-adv-about strong{font-weight:600;}',
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
        '.vc-popup-dark .vc-advanced::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);}',
        '.vc-popup-dark .vc-adv-empty{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-rename{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-rename:focus{background:#292a2d;}',
        '.vc-popup-dark .vc-adv-chip{border-color:rgba(255,255,255,.2);color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-summary{color:#9aa0a6;}',
        '.vc-popup-dark .vc-shortcut{color:#bdc1c6;}',
        '.vc-popup-dark .vc-adv-keys kbd{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.3);',
        'box-shadow:0 1px 0 rgba(0,0,0,.5);}',
        '.vc-popup-dark .vc-adv-keys i{color:#9aa0a6;}'
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
            bumpVolume(1);        // background.js volume-up (+ ceiling guard)
        } else if (key === 'ArrowDown') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            bumpVolume(-1);
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
            GM_registerMenuCommand('Volume +1 dB', function () { bumpVolume(1); });
            GM_registerMenuCommand('Volume −1 dB', function () { bumpVolume(-1); });
            GM_registerMenuCommand('Reset volume (0 dB)', function () { setVolume(0); });
            GM_registerMenuCommand('Toggle mute', toggleMute);
            GM_registerMenuCommand('Toggle mono', toggleMono);
            GM_registerMenuCommand('Toggle Active on this site', toggleActive);
            GM_registerMenuCommand('Site access lists (block/allow)', function () {
                uiOpenToggle(true);
                if (ui && ui.showAccess) ui.showAccess();
            });
            GM_registerMenuCommand('Reset settings for this site', resetSiteSettings);
        } catch (e) { /* menu not available */ }
    }

    // ============================================================= boot
    bootEngine();
    // cross-tab live sync: register the storage watchers now and re-scan
    // periodically — GM_addValueChangeListener registers per key, and
    // vc-site:/vc-normalizer:/vc-debug: keys created in other tabs after
    // this page loaded need a listener too.
    watchStorage();
    setInterval(watchStorage, 5000);

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
