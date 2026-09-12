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

    const BRIDGE_VERSION = 1;

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

    function normalizeDomainInput(value) {
        if (!value) return "";
        let domain = String(value).trim().toLowerCase();
        domain = domain.replace(/^(https?|ftp):\/\/(www\.)?/, '');
        domain = domain.split('/')[0].split(':')[0];
        // Strip a bare leading "www." too: a user-typed "www.foo.com" in the
        // options page previously saved as "www.foo.com", which could never
        // match a real page (every URL normalizes to "foo.com") — a silently
        // dead entry. Both spellings now canonicalize to the same key.
        domain = domain.replace(/^www\./, '');
        return domain;
    }

    function extractRootDomain(url, options = {}) {
        const invalidValue = options.nullForInvalid ? null : "";
        if (!url) return invalidValue;
        if (url.startsWith('file:')) return options.fileValue !== undefined ? options.fileValue : 'Local File';

        if (isRestrictedUrl(url)) return invalidValue;
        return normalizeDomainInput(url);
    }

    function domainMatchesSaved(domain, savedDomain) {
        const saved = normalizeDomainInput(savedDomain);
        return Boolean(domain && saved && (domain === saved || domain.endsWith(`.${saved}`)));
    }

    // ---- Path-aware blocklist matching (issue #69) --------------------------
    //
    // Legacy V4 builds seeded default blocklist entries WITH PATHS into
    // users' storage, e.g. "www.twitch.tv/*/clip/*" (twitch clips once broke
    // the player). normalizeDomainInput strips the path, so that entry
    // normalizes to "twitch.tv" and — since v6.11 also strips the leading
    // "www." — it began matching the MAIN twitch.tv site, deactivating the
    // extension everywhere on twitch. Stored entries with a path can only
    // come from that seeder (the options UI normalizes user input to a bare
    // domain), so path-carrying entries are now matched against the full URL
    // with wildcards: "twitch.tv/*/clip/*" blocks clip pages only, never the
    // main site. Bare-domain entries keep the old domain/subdomain match.
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
        let raw = String(entry == null ? "" : entry).trim().toLowerCase();
        if (!raw) return null;
        raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // tolerate stored URLs
        const slash = raw.indexOf('/');
        const domainPart = slash === -1 ? raw : raw.slice(0, slash);
        const pathPart = slash === -1 ? "" : raw.slice(slash);
        if (!domainPart) return null;
        return { domain: domainPart.replace(/^www\./, ''), path: pathPart };
    }

    function isUrlBlockedByEntry(url, savedEntry) {
        if (!url || savedEntry == null) return false;
        const parts = splitBlocklistEntry(savedEntry);
        if (!parts) return false;

        // Bare-domain entry (the only kind the options UI can produce): keep
        // the historical domain/subdomain semantics.
        if (!parts.path) {
            return domainMatchesSaved(normalizeDomainInput(url), savedEntry);
        }

        // Path-scoped legacy entry: match the full URL, wildcards = "any chars
        // except /" (the intent of "twitch.tv/*/clip/*" was clip pages).
        let parsed = null;
        try { parsed = new URL(String(url)); } catch (e) { parsed = null; }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) return false;
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (!(host === parts.domain || host.endsWith(`.${parts.domain}`))) return false;
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

    function getSiteSettingsKey(siteSettings, domain) {
        if (!siteSettings || !domain) return null;
        if (siteSettings[domain]) return domain;

        return Object.keys(siteSettings)
            .filter(savedDomain => domainMatchesSaved(domain, savedDomain))
            .sort((a, b) => b.length - a.length)[0] || null;
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

    const BOOST_LIMIT_NOTE = "Boosting and mono may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.";

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
        normalizeDb,
        getGainValue,
        formatDb,
        formatBadgeText,
        callApi,
        storageGet,
        storageSet,
        tabsQuery,
        tabsSendMessage,
        TOP_FRAME_OPTIONS,
        runtimeSendMessage,
        tabsReload,
        openOptionsPage,
        actionSetBadgeText,
        actionSetBadgeBackgroundColor,
        actionSetTitle,
        normalizeDomainInput,
        extractRootDomain,
        domainMatchesSaved,
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
