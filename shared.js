(function initVolumeControlShared(global) {
    const browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    const MIN_DB = -32;
    const MAX_DB = 32;
    const RESTRICTED_PROTOCOLS = ['chrome', 'edge', 'about', 'extension', 'chrome-extension', 'moz-extension', 'view-source'];

    function normalizeDb(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
    }

    function getGainValue(dB) {
        return Math.pow(10, normalizeDb(dB) / 20);
    }

    function formatDb(value) {
        const n = normalizeDb(value);
        return `${n >= 0 ? '+' : ''}${n} dB`;
    }

    function formatBadgeText(value) {
        const n = normalizeDb(value);
        return n > 0 ? `+${n}` : String(n);
    }

    function getRuntimeLastError() {
        return browserApi && browserApi.runtime ? browserApi.runtime.lastError : null;
    }

    const BRIDGE_VERSION = 3;
    const DEFAULT_NORMALIZER_CONFIG = Object.freeze({
        targetDb: -16,
        maxBoostDb: 12,
        ceilingDb: -1,
        responseMs: 600
    });

    function normalizeNormalizerConfig(value = {}) {
        const numberOr = (candidate, fallback) => {
            // Number('') and Number(null) equal zero. For normalizer inputs,
            // that silently turns a cleared Target field into -6 dBFS (the
            // loudest allowed target) instead of restoring the safe default.
            if (candidate == null || (typeof candidate === "string" && !candidate.trim())) return fallback;
            const n = Number(candidate);
            return Number.isFinite(n) ? n : fallback;
        };
        return {
            targetDb: Math.max(-30, Math.min(-6, numberOr(value.targetDb, DEFAULT_NORMALIZER_CONFIG.targetDb))),
            maxBoostDb: Math.max(0, Math.min(24, numberOr(value.maxBoostDb, DEFAULT_NORMALIZER_CONFIG.maxBoostDb))),
            ceilingDb: Math.max(-6, Math.min(-0.1, numberOr(value.ceilingDb, DEFAULT_NORMALIZER_CONFIG.ceilingDb))),
            responseMs: Math.max(100, Math.min(3000, Math.round(numberOr(value.responseMs, DEFAULT_NORMALIZER_CONFIG.responseMs))))
        };
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
                // Callback-style API: wait for callback to fire.
            } catch (callbackError) {
                // Only retry without callback if the error specifically indicates
                // an argument/callback mismatch. Other errors (e.g., permission
                // denied) are propagated immediately to avoid duplicating side
                // effects from a partially-executed first call.
                const msg = callbackError && callbackError.message ? callbackError.message : String(callbackError);
                if (/argument|callback|Incorrect number of arguments/i.test(msg)) {
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
                } else {
                    finish(callbackError);
                }
            }
        });
    }

    function storageGet(keys) {
        return callApi(browserApi.storage.local.get.bind(browserApi.storage.local), [keys]);
    }

    function storageSet(obj) {
        return callApi(browserApi.storage.local.set.bind(browserApi.storage.local), [obj]).then(() => undefined);
    }

    function tabsQuery(queryInfo) {
        return callApi(browserApi.tabs.query.bind(browserApi.tabs), [queryInfo]);
    }

    function tabsGet(tabId) {
        return callApi(browserApi.tabs.get.bind(browserApi.tabs), [tabId]);
    }

    // options may carry { frameId } to target a specific frame. Without it the
    // message is delivered to EVERY frame in the tab and the promise resolves
    // with whichever frame responds FIRST — a race between the top frame (where
    // the user's media and the boost-limit verdict live) and any embedded
    // iframes (ads, captcha, payment frames) that run their own content script
    // instance. Callers that need a trustworthy response must pass
    // TOP_FRAME_OPTIONS ({ frameId: 0 }) and callers that only need the command
    // APPLIED everywhere (e.g. setVolume for embedded players) should broadcast
    // without a frameId and ignore the racy response.
    const TOP_FRAME_OPTIONS = { frameId: 0 };

    function tabsSendMessage(tabId, message, options) {
        const args = options === undefined ? [tabId, message] : [tabId, message, options];
        return callApi(browserApi.tabs.sendMessage.bind(browserApi.tabs), args);
    }

    function runtimeSendMessage(message) {
        return callApi(browserApi.runtime.sendMessage.bind(browserApi.runtime), [message]);
    }

    function tabsReload(tabId) {
        return callApi(browserApi.tabs.reload.bind(browserApi.tabs), [tabId]).then(() => undefined);
    }

    function openOptionsPage() {
        return callApi(browserApi.runtime.openOptionsPage.bind(browserApi.runtime)).then(() => undefined);
    }

    function actionSetBadgeText(details) {
        return callApi(browserApi.action.setBadgeText.bind(browserApi.action), [details]).then(() => undefined);
    }

    function actionSetBadgeBackgroundColor(details) {
        return callApi(browserApi.action.setBadgeBackgroundColor.bind(browserApi.action), [details]).then(() => undefined);
    }

    function actionSetTitle(details) {
        return callApi(browserApi.action.setTitle.bind(browserApi.action), [details]).then(() => undefined);
    }

    function canonicalizeHostname(hostname) {
        let host = String(hostname == null ? "" : hostname).trim();
        if (!host) return "";
        try {
            // URL.hostname canonicalizes Unicode IDNs to ASCII/punycode and
            // preserves bracketed IPv6 literals instead of truncating on ':'.
            host = new URL(`http://${host}`).hostname;
        } catch (e) {
            host = host.toLowerCase();
        }
        host = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
        return host;
    }

    function parseSiteLikeInput(value) {
        const raw = String(value == null ? "" : value).trim();
        if (!raw) return null;
        if (/^(?:local file|file)$/i.test(raw) || /^file:/i.test(raw)) {
            return { file: true, domain: "file", path: "", query: "" };
        }

        const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
        try {
            const parsed = new URL(candidate);
            if (!parsed.hostname) return null;
            let path = parsed.pathname || "";
            while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
            if (path === "/") path = "";
            return {
                file: false,
                domain: canonicalizeHostname(parsed.hostname),
                path,
                query: parsed.search ? parsed.search.slice(1) : ""
            };
        } catch (e) {
            return null;
        }
    }

    function normalizeDomainInput(value) {
        const parsed = parseSiteLikeInput(value);
        return parsed && !parsed.file ? parsed.domain : "";
    }

    function extractRootDomain(url, options = {}) {
        const invalidValue = options.nullForInvalid ? null : "";
        if (!url) return invalidValue;
        if (url.startsWith('file:')) return options.fileValue !== undefined ? options.fileValue : 'file';

        if (isRestrictedUrl(url)) return invalidValue;
        return normalizeDomainInput(url);
    }

    function domainMatchesSaved(domain, savedDomain) {
        const current = normalizeDomainInput(domain);
        const saved = normalizeDomainInput(savedDomain);
        return Boolean(current && saved && (current === saved || current.endsWith(`.${saved}`)));
    }

    // Remembered settings are path-scoped by default. A caller that represents
    // explicit/manual profile input can opt into query preservation, allowing
    // entries such as "youtube.com/watch?v=dQw4w9WgXcQ" without changing the
    // popup's normal per-site/per-directory Remember behavior.
    function normalizeSiteSettingsEntryInput(value, options = {}) {
        const parsed = parseSiteLikeInput(value);
        if (!parsed) return "";
        if (parsed.file) return "file";
        const query = options.includeQuery && parsed.query ? `?${parsed.query}` : "";
        return parsed.domain + parsed.path + query;
    }

    function splitSiteSettingsEntry(entry) {
        const normalized = normalizeSiteSettingsEntryInput(entry, { includeQuery: true });
        if (!normalized) return null;
        if (normalized === "file") return { file: true, domain: "file", path: "", query: "" };

        const queryIndex = normalized.indexOf("?");
        const withoutQuery = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
        const query = queryIndex === -1 ? "" : normalized.slice(queryIndex + 1);
        const slash = withoutQuery.indexOf("/");
        return {
            file: false,
            domain: slash === -1 ? withoutQuery : withoutQuery.slice(0, slash),
            path: slash === -1 ? "" : withoutQuery.slice(slash),
            query
        };
    }

    function isUrlRememberedByEntry(url, savedEntry) {
        const saved = splitSiteSettingsEntry(savedEntry);
        if (!saved) return false;

        const rawUrl = String(url == null ? "" : url).trim();
        if (!rawUrl) return false;
        if (saved.file) {
            return /^file:/i.test(rawUrl) || /^(?:local file|file)$/i.test(rawUrl);
        }

        let current = null;
        try {
            if (/^[a-z][a-z0-9+.-]*:[/]{2}/i.test(rawUrl)) {
                const parsed = new URL(rawUrl);
                if (!/^https?:$/.test(parsed.protocol)) return false;
                current = {
                    domain: canonicalizeHostname(parsed.hostname),
                    path: parsed.pathname || "/",
                    query: parsed.search ? parsed.search.slice(1) : ""
                };
            }
        } catch (e) {
            current = null;
        }

        if (!current) {
            const normalizedCurrent = normalizeSiteSettingsEntryInput(rawUrl, { includeQuery: true });
            if (!normalizedCurrent || normalizedCurrent === "file") return false;
            const split = splitSiteSettingsEntry(normalizedCurrent);
            if (!split) return false;
            current = {
                domain: split.domain,
                path: split.path || "/",
                query: split.query || ""
            };
        }

        if (!(current.domain === saved.domain || current.domain.endsWith(`.${saved.domain}`))) {
            return false;
        }
        let pathMatches = true;
        if (saved.path) {
            if (saved.path.includes("*")) {
                const pattern = "^" + saved.path.split("*").map(escapeRegExp).join("[^/]*") + "$";
                try {
                    pathMatches = new RegExp(pattern).test(current.path);
                } catch (e) {
                    return false;
                }
            } else {
                // A remembered path applies to that path and descendants.
                pathMatches = current.path === saved.path || current.path.startsWith(saved.path + "/");
            }
        }
        if (!pathMatches) return false;

        // Query matching is opt-in: legacy/default profiles have no saved.query
        // and therefore continue to ignore transient query parameters.
        if (!saved.query) return true;
        if (saved.query.includes("*")) {
            const pattern = "^" + saved.query.split("*").map(escapeRegExp).join(".*") + "$";
            try {
                return new RegExp(pattern).test(current.query || "");
            } catch (e) {
                return false;
            }
        }
        return (current.query || "") === saved.query;
    }

    // ---- Path-aware blocklist matching (issue #69) --------------------------
    //
    // Legacy V4 builds seeded default blocklist entries WITH PATHS into
    // users' storage, e.g. "www.twitch.tv/*/clip/*" (twitch clips once broke
    // the player). normalizeDomainInput strips the path, so that entry
    // normalizes to "twitch.tv" and — since v6.11 also strips the leading
    // "www." — it began matching the MAIN twitch.tv site, deactivating the
    // extension everywhere on twitch. Path-carrying entries are matched
    // against the full URL with wildcards: "twitch.tv/*/clip/*" blocks clip
    // pages only, never the main site. Bare-domain entries keep the old
    // domain/subdomain match. Since v6.14 the options page ALSO accepts
    // user-typed paths (see normalizeBlocklistEntryInput), so this is a
    // first-class feature, not just legacy-entry compatibility.
    const LEGACY_DEFAULT_BLOCKLIST_ENTRIES = [
        "www.twitch.tv/*/clip/*",
        "twitch.tv/*/clip/*",
        "twitch.tv/*/clip",
        "clips.twitch.tv"
    ];

    function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function splitBlocklistEntry(entry) {
        const normalized = normalizeBlocklistEntryInput(entry);
        if (!normalized) return null;
        const slash = normalized.indexOf('/');
        return {
            domain: slash === -1 ? normalized : normalized.slice(0, slash),
            path: slash === -1 ? "" : normalized.slice(slash)
        };
    }

    // Normalize user-typed BLOCKLIST input for storage (v6.14). Unlike
    // normalizeDomainInput, this PRESERVES a path so options-page users can
    // create path-scoped entries:
    //   "twitch.tv/clips"        blocks only /clips on twitch (+ subdomains
    //                            of twitch.tv, consistent with bare entries)
    //   "twitch.tv/*/clip/*"     wildcard: * matches any chars except "/"
    // Pathless input canonicalizes identically to normalizeDomainInput, so
    // domain-style entries behave exactly as before (protocol, port and
    // "www." stripped, lowercased). A trailing "/" is meaningless for
    // matching (the matcher anchors the pattern against the pathname, and
    // sites request "/clips", not "/clips/"), so it is trimmed; a lone "/"
    // degrades to the bare-domain entry.
    function normalizeBlocklistEntryInput(value) {
        const parsed = parseSiteLikeInput(value);
        if (!parsed || parsed.file) return "";
        return parsed.domain + parsed.path;
    }

    function isUrlBlockedByEntry(url, savedEntry) {
        if (!url || savedEntry == null) return false;
        const parts = splitBlocklistEntry(savedEntry);
        if (!parts) return false;

        // Bare-domain entry: keep the historical domain/subdomain semantics.
        if (!parts.path) {
            return domainMatchesSaved(normalizeDomainInput(url), savedEntry);
        }

        // Path-scoped legacy entry: match the full URL, wildcards = "any chars
        // except /" (the intent of "twitch.tv/*/clip/*" was clip pages).
        let parsed = null;
        try { parsed = new URL(String(url)); } catch (e) { parsed = null; }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) return false;
        const host = canonicalizeHostname(parsed.hostname);
        if (!(host === parts.domain || host.endsWith(`.${parts.domain}`))) return false;
        if (!parts.path.includes("*")) {
            return parsed.pathname === parts.path || parsed.pathname.startsWith(parts.path + "/");
        }

        const pattern = "^" + parts.path.split("*").map(escapeRegExp).join("[^/]*") + "$";
        try {
            return new RegExp(pattern).test(parsed.pathname);
        } catch (e) {
            return false;
        }
    }

    function isUrlBlockedByEntries(url, savedEntries) {
        if (!url || !Array.isArray(savedEntries)) return false;
        return savedEntries.some(entry => isUrlBlockedByEntry(url, entry));
    }

    // Returns the subset of `savedEntries` that block `url`. Used by the
    // popup's Active toggle to remove EVERY entry that keeps the site
    // inactive — including legacy raw entries like "www.twitch.tv/*/clip/*"
    // that an exact-string indexOf(domain) could never find (the second half
    // of issue #69: toggling Active reloaded the page but stayed off).
    function entriesBlockingUrl(url, savedEntries) {
        if (!url || !Array.isArray(savedEntries)) return [];
        return savedEntries.filter(entry => isUrlBlockedByEntry(url, entry));
    }

    // One-time migration: remove the V4-era seeded twitch defaults from the
    // stored blocklist. The maintainer confirmed these are obsolete ("I'll
    // remove it in a future version"); they are also the direct cause of
    // issue #69. Users who genuinely want twitch blocked can re-add the bare
    // domain from the options page.
    function purgeLegacyDefaultBlocklist(fqdns) {
        if (!Array.isArray(fqdns)) return { list: fqdns || [], changed: false };
        const legacy = new Set(LEGACY_DEFAULT_BLOCKLIST_ENTRIES);
        const filtered = fqdns.filter(entry => !legacy.has(String(entry == null ? "" : entry).trim().toLowerCase()));
        return { list: filtered, changed: filtered.length !== fqdns.length };
    }

    function getSiteSettingsMatchRank(url, savedEntry) {
        const saved = splitSiteSettingsEntry(savedEntry);
        if (!saved) return [0, 0, 0, 0, 0, 0];

        let currentDomain = "";
        try {
            const parsed = new URL(String(url));
            currentDomain = canonicalizeHostname(parsed.hostname);
        } catch (e) {
            const normalized = normalizeSiteSettingsEntryInput(url);
            const slash = normalized.indexOf("/");
            currentDomain = slash === -1 ? normalized : normalized.slice(0, slash);
        }

        const wildcardCount = ((saved.path || "").match(/\*/g) || []).length +
            ((saved.query || "").match(/\*/g) || []).length;
        const literalLength = (saved.path || "").replace(/\*/g, "").length +
            (saved.query || "").replace(/\*/g, "").length;
        return [
            saved.query ? 1 : 0,
            saved.path ? 1 : 0,
            currentDomain === saved.domain ? 1 : 0,
            literalLength,
            -wildcardCount,
            saved.domain.split(".").length,
            saved.domain.length
        ];
    }

    function compareSiteSettingsMatches(url, a, b) {
        const ar = getSiteSettingsMatchRank(url, a);
        const br = getSiteSettingsMatchRank(url, b);
        for (let i = 0; i < ar.length; i++) {
            if (ar[i] !== br[i]) return br[i] - ar[i];
        }
        return String(a).localeCompare(String(b));
    }

    function getSiteSettingsKey(siteSettings, url) {
        if (!siteSettings || !url) return null;

        const normalizedWithQuery = normalizeSiteSettingsEntryInput(url, { includeQuery: true });
        if (normalizedWithQuery && siteSettings[normalizedWithQuery]) return normalizedWithQuery;

        const normalized = normalizeSiteSettingsEntryInput(url);

        // Backward compatibility for versions that saved local files under
        // "Local File" while the content script looked for "file".
        if (normalized === "file" && siteSettings["Local File"]) return "Local File";

        // Do not return a generic exact-path key before ranking matches. A
        // manually entered query wildcard (e.g. watch?v=*) is intentionally
        // more specific than the default path-only watch profile.
        return Object.keys(siteSettings)
            .filter(savedEntry => isUrlRememberedByEntry(url, savedEntry))
            .sort((a, b) => compareSiteSettingsMatches(url, a, b))[0] || null;
    }

    function isRestrictedUrl(url) {
        if (!url) return false;
        const protocol = url.split(':')[0];
        return RESTRICTED_PROTOCOLS.includes(protocol);
    }

    // Returns true for messaging errors that are safe to ignore (content script
    // not yet injected, tab navigated away, etc.). Used by background.js and
    // popup.js to suppress noise from expected race conditions.
    const HARMLESS_MESSAGE_ERRORS = [
        "Receiving end does not exist",
        "Could not establish connection",
        "message channel closed"
    ];
    function isHarmlessMessageError(error) {
        const msg = error && (error.message || error);
        if (typeof msg !== 'string') return false;
        return HARMLESS_MESSAGE_ERRORS.some(fragment => msg.includes(fragment));
    }

    const BOOST_LIMIT_NOTE = "Boosting, mono, and normalization may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.";

    // Shared error handler: suppresses harmless messaging errors (content
    // script not yet injected, tab navigated away, etc.) and logs the rest.
    // Used by popup.js and background.js to avoid duplicating the same logic.
    function handleError(error, context) {
        if (isHarmlessMessageError(error)) return;
        const msg = error && (error.message || error);
        const prefix = context ? `Volume Control (${context})` : "Volume Control";
        console.error(`${prefix}: ${msg}`);
    }

    global.VolumeControlShared = {
        browserApi,
        MIN_DB,
        MAX_DB,
        RESTRICTED_PROTOCOLS,
        BRIDGE_VERSION,
        DEFAULT_NORMALIZER_CONFIG,
        normalizeNormalizerConfig,
        normalizeDb,
        getGainValue,
        formatDb,
        formatBadgeText,
        callApi,
        storageGet,
        storageSet,
        tabsQuery,
        tabsGet,
        tabsSendMessage,
        TOP_FRAME_OPTIONS,
        runtimeSendMessage,
        tabsReload,
        openOptionsPage,
        actionSetBadgeText,
        actionSetBadgeBackgroundColor,
        actionSetTitle,
        normalizeDomainInput,
        canonicalizeHostname,
        normalizeSiteSettingsEntryInput,
        normalizeBlocklistEntryInput,
        extractRootDomain,
        domainMatchesSaved,
        isUrlRememberedByEntry,
        isUrlBlockedByEntry,
        isUrlBlockedByEntries,
        entriesBlockingUrl,
        purgeLegacyDefaultBlocklist,
        getSiteSettingsKey,
        isRestrictedUrl,
        isHarmlessMessageError,
        BOOST_LIMIT_NOTE,
        handleError
    };
})(globalThis);
