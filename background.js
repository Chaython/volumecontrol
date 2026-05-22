const browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const MIN_DB = -32;
const MAX_DB = 32;
const HOTKEY_STEP_DB = 1;

function normalizeDb(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
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

function actionSetBadgeText(details) {
    return callApi(browserApi.action.setBadgeText.bind(browserApi.action), [details]).then(() => undefined);
}

function actionSetBadgeBackgroundColor(details) {
    return callApi(browserApi.action.setBadgeBackgroundColor.bind(browserApi.action), [details]).then(() => undefined);
}

function actionSetTitle(details) {
    return callApi(browserApi.action.setTitle.bind(browserApi.action), [details]).then(() => undefined);
}

function extractRootDomain(url) {
    if (!url) return "";
    if (url.startsWith('file:')) return 'Local File';
    if (url.startsWith('chrome') || url.startsWith('edge') || url.startsWith('about') || url.startsWith('extension')) return "";

    let domain = url.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0];
    domain = domain.split(':')[0];
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

function isRestrictedUrl(url) {
    if (!url) return false;
    const protocol = url.split(':')[0];
    return ['chrome', 'edge', 'about', 'extension', 'chrome-extension', 'moz-extension', 'view-source'].includes(protocol);
}

async function getActiveTab(commandTab) {
    if (commandTab && commandTab.id !== undefined) return commandTab;

    const tabs = await tabsQuery({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
}

async function getDomainState(tab) {
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) return null;

    const domain = extractRootDomain(tab.url);
    if (!domain) return null;

    const data = await storageGet({ fqdns: [], whitelistMode: false, siteSettings: {} });
    const siteSettings = data.siteSettings || {};
    const settingsKey = getSiteSettingsKey(siteSettings, domain);
    const blocked = data.whitelistMode
        ? !settingsKey
        : (data.fqdns || []).some(savedDomain => domainMatchesSaved(domain, savedDomain));

    return {
        blocked,
        settingsKey,
        siteSettings
    };
}

async function getContentState(tab) {
    const controlResponse = await tabsSendMessage(tab.id, { command: "getAudioControlState" }).catch(() => null);
    if (controlResponse && controlResponse.response) {
        const state = controlResponse.response;
        return {
            volume: state.volume !== undefined ? normalizeDb(state.volume) : null,
            mono: state.mono !== undefined ? Boolean(state.mono) : null,
            maxDb: state.maxDb !== undefined ? normalizeDb(state.maxDb) : MAX_DB,
            boostLimited: Boolean(state.boostLimited)
        };
    }

    const volumeResponse = await tabsSendMessage(tab.id, { command: "getVolume" }).catch(() => null);
    const monoResponse = await tabsSendMessage(tab.id, { command: "getMono" }).catch(() => null);

    return {
        volume: volumeResponse && volumeResponse.response !== undefined ? normalizeDb(volumeResponse.response) : null,
        mono: monoResponse && monoResponse.response !== undefined ? Boolean(monoResponse.response) : null,
        maxDb: MAX_DB,
        boostLimited: false
    };
}

async function saveRememberedSettings(domainState, updates) {
    if (!domainState || !domainState.settingsKey) return;

    const siteSettings = domainState.siteSettings || {};
    const current = siteSettings[domainState.settingsKey] || { volume: 0, mono: false };
    siteSettings[domainState.settingsKey] = {
        volume: updates.volume !== undefined ? normalizeDb(updates.volume) : normalizeDb(current.volume),
        mono: updates.mono !== undefined ? Boolean(updates.mono) : Boolean(current.mono)
    };
    await storageSet({ siteSettings });
}

async function getFallbackState(domainState) {
    if (!domainState || !domainState.settingsKey) return { volume: 0, mono: false };

    const saved = domainState.siteSettings[domainState.settingsKey] || {};
    return {
        volume: saved.volume !== undefined ? normalizeDb(saved.volume) : 0,
        mono: Boolean(saved.mono)
    };
}

async function setVolume(tab, domainState, dB) {
    const requestedVolume = normalizeDb(dB);
    const response = await tabsSendMessage(tab.id, { command: "setVolume", dB: requestedVolume }).catch(handleError);
    const appliedVolume = response && response.response && response.response.volume !== undefined
        ? normalizeDb(response.response.volume)
        : requestedVolume;

    await showNativeVolumeFeedback(tab.id, appliedVolume);
    await saveRememberedSettings(domainState, { volume: appliedVolume });
}

async function setMono(tab, domainState, mono) {
    const enabled = Boolean(mono);
    await tabsSendMessage(tab.id, { command: "setMono", mono: enabled }).catch(handleError);
    await saveRememberedSettings(domainState, { mono: enabled });
}

async function handleCommand(command, commandTab) {
    const tab = await getActiveTab(commandTab);
    if (!tab || tab.id === undefined) return;

    const domainState = await getDomainState(tab);
    if (domainState && domainState.blocked) return;

    const contentState = await getContentState(tab);
    const fallbackState = await getFallbackState(domainState);
    const currentVolume = contentState.volume !== null ? contentState.volume : fallbackState.volume;
    const currentMono = contentState.mono !== null ? contentState.mono : fallbackState.mono;

    switch (command) {
        case "volume-up":
            await setVolume(tab, domainState, currentVolume + HOTKEY_STEP_DB);
            break;
        case "volume-down":
            await setVolume(tab, domainState, currentVolume - HOTKEY_STEP_DB);
            break;
        case "volume-reset":
            await setVolume(tab, domainState, 0);
            break;
        case "toggle-mono":
            await setMono(tab, domainState, !currentMono);
            break;
    }
}

function handleError(error) {
    const msg = error && (error.message || error);
    if (typeof msg === 'string') {
        if (msg.includes("Receiving end does not exist") ||
            msg.includes("Could not establish connection") ||
            msg.includes("message channel closed")
        ) {
            return;
        }
    }
    console.error(`Volume Control: Hotkey error: ${msg}`);
}

async function showNativeVolumeFeedback(tabId, dB) {
    if (!browserApi || !browserApi.action) return;

    const volume = normalizeDb(dB);
    const details = Number.isInteger(tabId) ? { tabId } : {};
    const color = volume > 0 ? '#2e7d32' : (volume < 0 ? '#c62828' : '#5f6368');

    await actionSetBadgeBackgroundColor({ ...details, color }).catch(handleError);
    await actionSetBadgeText({ ...details, text: formatBadgeText(volume) }).catch(handleError);
    await actionSetTitle({ ...details, title: `Volume Control (${formatDb(volume)})` }).catch(handleError);
}

if (browserApi && browserApi.commands && browserApi.commands.onCommand) {
    browserApi.commands.onCommand.addListener((command, tab) => {
        handleCommand(command, tab).catch(handleError);
    });
}

if (browserApi && browserApi.runtime && browserApi.runtime.onMessage) {
    browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.command !== "showNativeVolumeFeedback") return false;

        showNativeVolumeFeedback(message.tabId, message.dB)
            .then(() => sendResponse({}))
            .catch((error) => {
                handleError(error);
                sendResponse({});
            });
        return true;
    });
}
