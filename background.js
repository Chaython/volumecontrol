if (typeof importScripts === 'function' && typeof globalThis.VolumeControlShared === 'undefined') {
    importScripts('shared.js');
}

const {
    browserApi,
    MAX_DB,
    normalizeDb,
    formatDb,
    formatBadgeText,
    storageGet,
    storageSet,
    tabsQuery,
    tabsSendMessage,
    actionSetBadgeText,
    actionSetBadgeBackgroundColor,
    actionSetTitle,
    extractRootDomain,
    domainMatchesSaved,
    getSiteSettingsKey,
    isRestrictedUrl,
    handleError
} = globalThis.VolumeControlShared;
const HOTKEY_STEP_DB = 1;

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
            muted: state.muted !== undefined ? Boolean(state.muted) : null,
            maxDb: state.maxDb !== undefined ? normalizeDb(state.maxDb) : MAX_DB,
            boostLimited: Boolean(state.boostLimited)
        };
    }

    const volumeResponse = await tabsSendMessage(tab.id, { command: "getVolume" }).catch(() => null);
    const monoResponse = await tabsSendMessage(tab.id, { command: "getMono" }).catch(() => null);
    const muteResponse = await tabsSendMessage(tab.id, { command: "getMute" }).catch(() => null);

    return {
        volume: volumeResponse && volumeResponse.response !== undefined ? normalizeDb(volumeResponse.response) : null,
        mono: monoResponse && monoResponse.response !== undefined ? Boolean(monoResponse.response) : null,
        muted: muteResponse && muteResponse.response !== undefined ? Boolean(muteResponse.response) : null,
        maxDb: MAX_DB,
        boostLimited: false
    };
}

async function saveRememberedSettings(domainState, updates) {
    if (!domainState || !domainState.settingsKey) return;

    const siteSettings = domainState.siteSettings || {};
    const current = siteSettings[domainState.settingsKey] || { volume: 0, mono: false, muted: false };
    siteSettings[domainState.settingsKey] = {
        volume: updates.volume !== undefined ? normalizeDb(updates.volume) : normalizeDb(current.volume),
        mono: updates.mono !== undefined ? Boolean(updates.mono) : Boolean(current.mono),
        muted: updates.muted !== undefined ? Boolean(updates.muted) : Boolean(current.muted)
    };
    await storageSet({ siteSettings });
}

async function getFallbackState(domainState) {
    if (!domainState || !domainState.settingsKey) return { volume: 0, mono: false };

    const saved = domainState.siteSettings[domainState.settingsKey] || {};
    return {
        volume: saved.volume !== undefined ? normalizeDb(saved.volume) : 0,
        mono: Boolean(saved.mono),
        muted: Boolean(saved.muted)
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

async function setMute(tab, domainState, muted) {
    const enabled = Boolean(muted);
    const response = await tabsSendMessage(tab.id, { command: "setMute", muted: enabled }).catch(handleError);
    const dB = (response && response.response && response.response.volume !== undefined)
        ? normalizeDb(response.response.volume) : 0;
    await showNativeVolumeFeedback(tab.id, dB, enabled);
    await saveRememberedSettings(domainState, { muted: enabled });
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
    const currentMuted = contentState.muted !== null ? contentState.muted : fallbackState.muted;

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
        case "toggle-mute":
            await setMute(tab, domainState, !currentMuted);
            break;
    }
}

async function showNativeVolumeFeedback(tabId, dB, muted) {
    if (!browserApi || !browserApi.action) return;

    const volume = normalizeDb(dB);
    const details = Number.isInteger(tabId) ? { tabId } : {};

    if (muted) {
        // Muted: red "MUTE" badge (Chrome truncates to 4 chars; "MUTE" fits).
        await actionSetBadgeBackgroundColor({ ...details, color: '#c62828' }).catch(handleError);
        await actionSetBadgeText({ ...details, text: 'MUTE' }).catch(handleError);
        await actionSetTitle({ ...details, title: 'Volume Control (muted)' }).catch(handleError);
        return;
    }

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

        showNativeVolumeFeedback(message.tabId, message.dB, message.muted)
            .then(() => sendResponse({}))
            .catch((error) => {
                handleError(error);
                sendResponse({});
            });
        return true;
    });
}
