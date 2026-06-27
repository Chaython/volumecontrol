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

    function tabsSendMessage(tabId, message) {
        return callApi(browserApi.tabs.sendMessage.bind(browserApi.tabs), [tabId, message]);
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
        runtimeSendMessage,
        tabsReload,
        openOptionsPage,
        actionSetBadgeText,
        actionSetBadgeBackgroundColor,
        actionSetTitle,
        normalizeDomainInput,
        extractRootDomain,
        domainMatchesSaved,
        getSiteSettingsKey,
        isRestrictedUrl,
        isHarmlessMessageError,
        BOOST_LIMIT_NOTE,
        handleError
    };
})(globalThis);
