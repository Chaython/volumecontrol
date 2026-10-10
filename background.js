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
    tabsGet,
    tabsSendMessage,
    TOP_FRAME_OPTIONS,
    actionSetBadgeText,
    actionSetBadgeBackgroundColor,
    actionSetTitle,
    extractRootDomain,
    normalizeSiteSettingsEntryInput,
    normalizeBlocklistEntryInput,
    domainMatchesSaved,
    isUrlRememberedByEntry,
    isUrlBlockedByEntry,
    isUrlBlockedByEntries,
    purgeLegacyDefaultBlocklist,
    getSiteSettingsKey,
    isRestrictedUrl,
    handleError
} = globalThis.VolumeControlShared;
const HOTKEY_STEP_DB = 1;
const HOTKEY_DELIVERY_RETRY_MS = 120;
const commandChains = new Map();
let siteSettingsMutationChain = Promise.resolve();
let accessListMutationChain = Promise.resolve();
let normalizerSettingsMutationChain = Promise.resolve();

function mutateSiteSettings(mutation = {}) {
    const run = async () => {
        const data = await storageGet({ siteSettings: {} });
        const siteSettings = { ...(data.siteSettings || {}) };
        const type = String(mutation.type || "");
        const rawKey = String(mutation.key == null ? "" : mutation.key).trim();
        const normalizedKey = normalizeSiteSettingsEntryInput(rawKey, { includeQuery: true });
        let key = rawKey && Object.prototype.hasOwnProperty.call(siteSettings, rawKey)
            ? rawKey
            : normalizedKey;

        if (type === "mergeForUrl" || type === "removeForUrl" || type === "ensureForUrl") {
            const url = String(mutation.url || "");
            const defaultKey = normalizeSiteSettingsEntryInput(mutation.defaultKey || url);
            key = getSiteSettingsKey(siteSettings, url) || defaultKey;
        }

        if (!key) return { ok: false, reason: "invalid-key" };

        if (type === "create") {
            key = normalizedKey;
            if (!key) return { ok: false, reason: "invalid-key" };
            if (Object.prototype.hasOwnProperty.call(siteSettings, key)) return { ok: false, reason: "exists", key };
            siteSettings[key] = {
                volume: 0,
                mono: false,
                muted: false,
                ...(mutation.value && typeof mutation.value === "object" ? mutation.value : {})
            };
        } else if (type === "ensureForUrl") {
            const existing = getSiteSettingsKey(siteSettings, String(mutation.url || ""));
            if (existing) return { ok: true, key: existing, created: false };
            siteSettings[key] = {
                volume: 0,
                mono: false,
                muted: false,
                ...(mutation.value && typeof mutation.value === "object" ? mutation.value : {})
            };
            await storageSet({ siteSettings });
            return { ok: true, key, created: true };
        } else if (type === "merge" || type === "mergeForUrl") {
            const current = siteSettings[key] || { volume: 0, mono: false, muted: false };
            const patch = mutation.patch && typeof mutation.patch === "object" ? mutation.patch : {};
            const next = { ...current, ...patch };
            // Per-site debug overrides live in siteDebugSettings and must never
            // be coupled to Remembered Audio again.
            delete next.debug;
            siteSettings[key] = next;
        } else if (type === "remove" || type === "removeForUrl") {
            delete siteSettings[key];
        } else if (type === "rename") {
            const newKey = normalizeSiteSettingsEntryInput(mutation.newKey, { includeQuery: true });
            if (!newKey) return { ok: false, reason: "invalid-key" };
            if (!Object.prototype.hasOwnProperty.call(siteSettings, key)) return { ok: false, reason: "missing", key };
            if (newKey !== key && Object.prototype.hasOwnProperty.call(siteSettings, newKey)) {
                return { ok: false, reason: "exists", key: newKey };
            }
            if (newKey !== key) {
                siteSettings[newKey] = siteSettings[key];
                delete siteSettings[key];
            }
            await storageSet({ siteSettings });
            return { ok: true, key: newKey };
        } else {
            return { ok: false, reason: "invalid-operation" };
        }

        await storageSet({ siteSettings });
        return { ok: true, key };
    };
    siteSettingsMutationChain = siteSettingsMutationChain.then(run, run);
    return siteSettingsMutationChain;
}



function mutateSiteNormalizerSettings(mutation = {}) {
    const run = async () => {
        const data = await storageGet({ siteNormalizerSettings: {} });
        const siteNormalizerSettings = { ...(data.siteNormalizerSettings || {}) };
        const type = String(mutation.type || "");
        const rawKey = String(mutation.key == null ? "" : mutation.key).trim();
        const normalizedKey = normalizeSiteSettingsEntryInput(rawKey, { includeQuery: true });
        let key = rawKey && Object.prototype.hasOwnProperty.call(siteNormalizerSettings, rawKey)
            ? rawKey
            : normalizedKey;

        if (type === "setForUrl" || type === "removeForUrl") {
            const url = String(mutation.url || "");
            const defaultKey = normalizeSiteSettingsEntryInput(mutation.defaultKey || url);
            key = getSiteSettingsKey(siteNormalizerSettings, url) || defaultKey;
        }

        if (!key) return { ok: false, reason: "invalid-key" };

        if (type === "setForUrl" || type === "set") {
            siteNormalizerSettings[key] = { enabled: Boolean(mutation.enabled) };
        } else if (type === "removeForUrl" || type === "remove") {
            delete siteNormalizerSettings[key];
        } else {
            return { ok: false, reason: "invalid-operation" };
        }

        await storageSet({ siteNormalizerSettings });
        return { ok: true, key };
    };
    normalizerSettingsMutationChain = normalizerSettingsMutationChain.then(run, run);
    return normalizerSettingsMutationChain;
}


function mutateSiteDebugSettings(mutation = {}) {
    const normalizeDebugValue = (value = {}) => ({
        debugMode: !!value.debugMode,
        forceDrmCapture: !!value.forceDrmCapture,
        forceCorsCapture: !!value.forceCorsCapture,
        debugRouteMode: value.debugRouteMode === "webaudio" || value.debugRouteMode === "native"
            ? value.debugRouteMode
            : "auto"
    });

    const run = async () => {
        const data = await storageGet({ siteDebugSettings: {} });
        const siteDebugSettings = { ...(data.siteDebugSettings || {}) };
        const type = String(mutation.type || "");
        const rawKey = String(mutation.key == null ? "" : mutation.key).trim();
        const normalizedKey = normalizeSiteSettingsEntryInput(rawKey, { includeQuery: true });
        let key = rawKey && Object.prototype.hasOwnProperty.call(siteDebugSettings, rawKey)
            ? rawKey
            : normalizedKey;

        if (type === "mergeForUrl" || type === "removeForUrl") {
            const url = String(mutation.url || "");
            const defaultKey = normalizeSiteSettingsEntryInput(mutation.defaultKey || url);
            key = getSiteSettingsKey(siteDebugSettings, url) || defaultKey;
        }

        if (!key) return { ok: false, reason: "invalid-key" };

        if (type === "create") {
            key = normalizedKey;
            if (!key) return { ok: false, reason: "invalid-key" };
            if (Object.prototype.hasOwnProperty.call(siteDebugSettings, key)) {
                return { ok: false, reason: "exists", key };
            }
            siteDebugSettings[key] = normalizeDebugValue(mutation.value);
        } else if (type === "merge" || type === "mergeForUrl") {
            const current = siteDebugSettings[key] || {};
            const patch = mutation.patch && typeof mutation.patch === "object" ? mutation.patch : {};
            siteDebugSettings[key] = normalizeDebugValue({ ...current, ...patch });
        } else if (type === "remove" || type === "removeForUrl") {
            delete siteDebugSettings[key];
        } else if (type === "rename") {
            const newKey = normalizeSiteSettingsEntryInput(mutation.newKey, { includeQuery: true });
            if (!newKey) return { ok: false, reason: "invalid-key" };
            if (!Object.prototype.hasOwnProperty.call(siteDebugSettings, key)) {
                return { ok: false, reason: "missing", key };
            }
            if (newKey !== key && Object.prototype.hasOwnProperty.call(siteDebugSettings, newKey)) {
                return { ok: false, reason: "exists", key: newKey };
            }
            if (newKey !== key) {
                siteDebugSettings[newKey] = siteDebugSettings[key];
                delete siteDebugSettings[key];
            }
            await storageSet({ siteDebugSettings });
            return { ok: true, key: newKey };
        } else {
            return { ok: false, reason: "invalid-operation" };
        }

        await storageSet({ siteDebugSettings });
        return { ok: true, key };
    };

    // Share the profile queue with remembered audio so migration/rename/remove
    // operations cannot interleave and lose one side of the split profile.
    siteSettingsMutationChain = siteSettingsMutationChain.then(run, run);
    return siteSettingsMutationChain;
}

function mutateAccessLists(mutation = {}) {
    const run = async () => {
        const data = await storageGet({
            fqdns: [],
            whitelist: [],
            archivedFqdns: [],
            whitelistMode: false
        });
        let fqdns = Array.isArray(data.fqdns) ? [...data.fqdns] : [];
        let whitelist = Array.isArray(data.whitelist) ? [...data.whitelist] : [];
        let archivedFqdns = Array.isArray(data.archivedFqdns) ? [...data.archivedFqdns] : [];
        let whitelistMode = Boolean(data.whitelistMode);
        const type = String(mutation.type || "");
        const url = String(mutation.url || "");

        const save = async () => {
            await storageSet({ fqdns, whitelist, archivedFqdns, whitelistMode });
            return { ok: true, fqdns, whitelist, archivedFqdns, whitelistMode };
        };

        if (type === "setSiteActive") {
            const active = Boolean(mutation.active);
            if (whitelistMode) {
                if (active) {
                    const entry = normalizeSiteSettingsEntryInput(mutation.entry || url, { includeQuery: true });
                    if (!entry) return { ok: false, reason: "invalid-entry" };
                    if (!whitelist.includes(entry)) whitelist.push(entry);
                } else {
                    whitelist = whitelist.filter(entry => !isUrlRememberedByEntry(url, entry));
                }
            } else if (active) {
                fqdns = fqdns.filter(entry => !isUrlBlockedByEntry(url, entry));
            } else {
                const entry = normalizeBlocklistEntryInput(mutation.entry || url);
                if (!entry) return { ok: false, reason: "invalid-entry" };
                if (!fqdns.includes(entry)) fqdns.push(entry);
            }
            return save();
        }

        if (type === "addBlocklist") {
            const entry = normalizeBlocklistEntryInput(mutation.entry);
            if (!entry) return { ok: false, reason: "invalid-entry" };
            if (fqdns.includes(entry)) return { ok: false, reason: "exists", entry };
            fqdns.push(entry);
            return save();
        }

        if (type === "removeBlocklist") {
            const raw = String(mutation.entry || "");
            fqdns = fqdns.filter(entry => entry !== raw);
            return save();
        }

        if (type === "addWhitelist") {
            const entry = normalizeSiteSettingsEntryInput(mutation.entry, { includeQuery: true });
            if (!entry) return { ok: false, reason: "invalid-entry" };
            if (whitelist.includes(entry)) return { ok: false, reason: "exists", entry };
            whitelist.push(entry);
            return save();
        }

        if (type === "removeWhitelist") {
            const raw = String(mutation.entry || "");
            whitelist = whitelist.filter(entry => entry !== raw);
            return save();
        }

        if (type === "setWhitelistMode") {
            const enabled = Boolean(mutation.enabled);
            if (enabled === whitelistMode) return { ok: true, fqdns, whitelist, archivedFqdns, whitelistMode };

            if (enabled) {
                if (fqdns.length) {
                    archivedFqdns = [...fqdns];
                    fqdns = [];
                }
                // Migration from the historical Remembered Settings allow-list
                // is handled exactly once by migrateSeparatedWhitelistOnce().
                // An intentionally empty whitelist must stay empty.
                whitelistMode = true;
            } else {
                if (!fqdns.length && archivedFqdns.length) fqdns = [...archivedFqdns];
                archivedFqdns = [];
                whitelistMode = false;
            }
            return save();
        }

        return { ok: false, reason: "invalid-operation" };
    };

    accessListMutationChain = accessListMutationChain.then(run, run);
    return accessListMutationChain;
}

function enqueueCommand(command, commandTab) {
    const key = commandTab && Number.isInteger(commandTab.id) ? commandTab.id : "active";
    const previous = commandChains.get(key) || Promise.resolve();
    const next = previous.then(
        () => handleCommand(command, commandTab),
        () => handleCommand(command, commandTab)
    ).finally(() => {
        if (commandChains.get(key) === next) commandChains.delete(key);
    });
    commandChains.set(key, next);
    return next;
}

async function getActiveTab(commandTab) {
    // A queued hotkey belongs to the tab it originated from. If that tab
    // closes, discard the command rather than applying it to another tab.
    if (commandTab && Number.isInteger(commandTab.id)) {
        try {
            return (await tabsGet(commandTab.id)) || null;
        } catch (e) {
            return null;
        }
    }

    const tabs = await tabsQuery({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
}

async function getDomainState(tab) {
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) return null;

    const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, whitelistSeparatedV1: false, siteSettings: {} });
    const siteSettings = data.siteSettings || {};
    const settingsKey = getSiteSettingsKey(siteSettings, tab.url);
    // Path-aware blocklist matching (issue #69): legacy path entries like
    // "www.twitch.tv/*/clip/*" scope to their path instead of blocking the
    // whole domain.
    const blocked = data.whitelistMode
        ? !(
            (data.whitelist || []).some(entry => isUrlRememberedByEntry(tab.url, entry)) ||
            (!data.whitelistSeparatedV1 && Boolean(settingsKey))
        )
        : isUrlBlockedByEntries(tab.url, data.fqdns || []);

    return {
        blocked,
        settingsKey,
        siteSettings
    };
}

async function getContentState(tab) {
    // Query ONLY the top frame (frameId 0). Unframed messages are answered by
    // whichever frame responds first; embedded iframes (captcha, payment, ads)
    // run their own content script instance and would report their own
    // unrestricted state instead of the page's real media/boost-limit status.
    const controlResponse = await tabsSendMessage(tab.id, { command: "getAudioControlState" }, TOP_FRAME_OPTIONS).catch(() => null);
    if (controlResponse && controlResponse.response) {
        const state = controlResponse.response;
        return {
            volume: state.volume !== undefined ? normalizeDb(state.volume) : null,
            mono: state.mono !== undefined ? Boolean(state.mono) : null,
            monoAvailable: state.monoAvailable !== false,
            monoUnavailableReason: state.monoUnavailableReason || "",
            muted: state.muted !== undefined ? Boolean(state.muted) : null,
            maxDb: state.maxDb !== undefined ? normalizeDb(state.maxDb) : MAX_DB,
            boostLimited: Boolean(state.boostLimited)
        };
    }

    const volumeResponse = await tabsSendMessage(tab.id, { command: "getVolume" }, TOP_FRAME_OPTIONS).catch(() => null);
    const monoResponse = await tabsSendMessage(tab.id, { command: "getMono" }, TOP_FRAME_OPTIONS).catch(() => null);
    const muteResponse = await tabsSendMessage(tab.id, { command: "getMute" }, TOP_FRAME_OPTIONS).catch(() => null);

    return {
        volume: volumeResponse && volumeResponse.response !== undefined ? normalizeDb(volumeResponse.response) : null,
        mono: monoResponse && monoResponse.response !== undefined ? Boolean(monoResponse.response) : null,
        monoAvailable: true,
        monoUnavailableReason: "",
        muted: muteResponse && muteResponse.response !== undefined ? Boolean(muteResponse.response) : null,
        maxDb: MAX_DB,
        boostLimited: false
    };
}

async function saveRememberedSettings(domainState, updates) {
    if (!domainState || !domainState.settingsKey) return;
    const patch = {};
    if (updates.volume !== undefined) patch.volume = normalizeDb(updates.volume);
    if (updates.mono !== undefined) patch.mono = Boolean(updates.mono);
    if (updates.muted !== undefined) patch.muted = Boolean(updates.muted);
    await mutateSiteSettings({ type: "merge", key: domainState.settingsKey, patch });
}

async function getFallbackState(domainState) {
    if (!domainState || !domainState.settingsKey) return { volume: 0, mono: false, muted: false };

    const saved = domainState.siteSettings[domainState.settingsKey] || {};
    return {
        volume: saved.volume !== undefined ? normalizeDb(saved.volume) : 0,
        mono: Boolean(saved.mono),
        muted: Boolean(saved.muted)
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendHotkeyCommandAndConfirm(tab, message) {
    if (!tab || !Number.isInteger(tab.id)) return null;

    for (let attempt = 0; attempt < 2; attempt++) {
        let delivered = false;
        try {
            // Broadcast the absolute requested state so embedded players receive
            // it too. Repeating an absolute command on retry is idempotent.
            await tabsSendMessage(tab.id, message);
            delivered = true;
        } catch (e) {
            if (attempt > 0) handleError(e);
        }

        if (delivered) {
            const response = await tabsSendMessage(
                tab.id,
                { command: "getAudioControlState" },
                TOP_FRAME_OPTIONS
            ).catch(() => null);
            if (response && response.response) return response.response;
        }

        if (attempt === 0) await delay(HOTKEY_DELIVERY_RETRY_MS);
    }

    return null;
}

async function setVolume(tab, domainState, dB) {
    const requestedVolume = normalizeDb(dB);
    const state = await sendHotkeyCommandAndConfirm(tab, {
        command: "setVolume",
        dB: requestedVolume
    });
    if (!state) return false;

    const appliedVolume = state.volume !== undefined
        ? normalizeDb(state.volume)
        : requestedVolume;
    const muted = state.muted !== undefined ? Boolean(state.muted) : false;
    await showNativeVolumeFeedback(tab.id, appliedVolume, muted);
    await saveRememberedSettings(domainState, { volume: appliedVolume });
    return true;
}

async function setMono(tab, domainState, mono) {
    const enabled = Boolean(mono);
    const state = await sendHotkeyCommandAndConfirm(tab, {
        command: "setMono",
        mono: enabled
    });
    if (!state) return false;
    await saveRememberedSettings(domainState, {
        mono: state.mono !== undefined ? Boolean(state.mono) : enabled
    });
    return true;
}

async function setMute(tab, domainState, muted) {
    const enabled = Boolean(muted);
    const state = await sendHotkeyCommandAndConfirm(tab, {
        command: "setMute",
        muted: enabled
    });
    if (!state) return false;

    const appliedMuted = state.muted !== undefined ? Boolean(state.muted) : enabled;
    const dB = state.volume !== undefined ? normalizeDb(state.volume) : 0;
    await showNativeVolumeFeedback(tab.id, dB, appliedMuted);
    await saveRememberedSettings(domainState, { muted: appliedMuted });
    return true;
}

async function handleCommand(command, commandTab) {
    const tab = await getActiveTab(commandTab);
    if (!tab || tab.id === undefined) return;

    const domainState = await getDomainState(tab);
    if (!domainState || domainState.blocked) return;

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
            if (contentState.monoAvailable !== false) {
                await setMono(tab, domainState, !currentMono);
            }
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
        enqueueCommand(command, tab).catch(handleError);
    });
}

// One-time legacy-default blocklist purge (issue #69; see shared.js
// purgeLegacyDefaultBlocklist). cs.js also runs it on first navigation, but
// since v6.14 users can CREATE path-scoped entries from the options page —
// a user who manually re-adds "twitch.tv/*/clip/*" must never have it
// swept by a migration that has not run yet. Running the purge here at
// install/update/startup (BEFORE the user can add anything through the UI)
// closes that window: by the time cs.js start() or the options page sees the
// storage, the flag is already set and hand-added entries are safe.
async function migrateSeparatedWhitelistOnce() {
    const run = async () => {
        const data = await storageGet({
            whitelistSeparatedV1: false,
            whitelistMode: false,
            whitelist: [],
            siteSettings: {}
        });
        if (data.whitelistSeparatedV1) return;

        const updates = { whitelistSeparatedV1: true };
        if (data.whitelistMode && (!Array.isArray(data.whitelist) || data.whitelist.length === 0)) {
            updates.whitelist = [...new Set(
                Object.keys(data.siteSettings || {})
                    .map(entry => normalizeSiteSettingsEntryInput(entry, { includeQuery: true }))
                    .filter(Boolean)
            )];
        }
        await storageSet(updates);
    };
    accessListMutationChain = accessListMutationChain.then(run, run);
    return accessListMutationChain.catch(handleError);
}

async function migrateSeparatedSiteDebugSettingsOnce() {
    const run = async () => {
        const data = await storageGet({
            siteDebugSettingsSeparatedV1: false,
            siteSettings: {},
            siteDebugSettings: {}
        });
        if (data.siteDebugSettingsSeparatedV1) return;

        const siteSettings = { ...(data.siteSettings || {}) };
        const siteDebugSettings = { ...(data.siteDebugSettings || {}) };
        let audioChanged = false;

        for (const [key, value] of Object.entries(siteSettings)) {
            if (!value || typeof value !== "object" || !value.debug || typeof value.debug !== "object") continue;
            if (!Object.prototype.hasOwnProperty.call(siteDebugSettings, key)) {
                const debug = value.debug;
                siteDebugSettings[key] = {
                    debugMode: !!debug.debugMode,
                    forceDrmCapture: !!debug.forceDrmCapture,
                    forceCorsCapture: !!debug.forceCorsCapture,
                    debugRouteMode: debug.debugRouteMode === "webaudio" || debug.debugRouteMode === "native"
                        ? debug.debugRouteMode
                        : "auto"
                };
            }
            const next = { ...value };
            delete next.debug;
            siteSettings[key] = next;
            audioChanged = true;
        }

        await storageSet({
            siteDebugSettingsSeparatedV1: true,
            siteDebugSettings,
            ...(audioChanged ? { siteSettings } : {})
        });
    };

    siteSettingsMutationChain = siteSettingsMutationChain.then(run, run);
    return siteSettingsMutationChain.catch(handleError);
}

async function purgeLegacyDefaultsOnce() {
    const run = async () => {
        const data = await storageGet({ fqdns: [], legacyTwitchDefaultsPurged: false });
        if (data.legacyTwitchDefaultsPurged) return;
        const purged = purgeLegacyDefaultBlocklist(data.fqdns || []);
        await storageSet(Object.assign(
            purged.changed ? { fqdns: purged.list } : {},
            { legacyTwitchDefaultsPurged: true }
        ));
    };
    accessListMutationChain = accessListMutationChain.then(run, run);
    return accessListMutationChain.catch(handleError);
}
if (browserApi && browserApi.runtime && browserApi.runtime.onInstalled) {
    browserApi.runtime.onInstalled.addListener(() => {
        purgeLegacyDefaultsOnce();
        migrateSeparatedSiteDebugSettingsOnce();
    });
}
if (browserApi && browserApi.runtime && browserApi.runtime.onStartup) {
    browserApi.runtime.onStartup.addListener(() => {
        purgeLegacyDefaultsOnce();
        migrateSeparatedSiteDebugSettingsOnce();
    });
}
purgeLegacyDefaultsOnce(); // MV3 worker wake (e.g. after an update) before any user interaction
migrateSeparatedWhitelistOnce();
migrateSeparatedSiteDebugSettingsOnce();

if (browserApi && browserApi.runtime && browserApi.runtime.onMessage) {
    browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return false;

        if (message.command === "mutateSiteSettings") {
            mutateSiteSettings(message.mutation)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    handleError(error);
                    sendResponse({ ok: false, reason: "storage-error" });
                });
            return true;
        }

        if (message.command === "mutateSiteNormalizerSettings") {
            mutateSiteNormalizerSettings(message.mutation)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    handleError(error);
                    sendResponse({ ok: false, reason: "storage-error" });
                });
            return true;
        }

        if (message.command === "mutateSiteDebugSettings") {
            mutateSiteDebugSettings(message.mutation)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    handleError(error);
                    sendResponse({ ok: false, reason: "storage-error" });
                });
            return true;
        }

        if (message.command === "mutateAccessLists") {
            mutateAccessLists(message.mutation)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    handleError(error);
                    sendResponse({ ok: false, reason: "storage-error" });
                });
            return true;
        }

        // Content scripts in cross-origin iframes cannot read window.top.location.
        // sender.tab.url is the authoritative top-level tab URL, so every frame
        // resolves whitelist/memory/debug state against the same user-visible page.
        if (message.command === "getTopTabUrl") {
            sendResponse({ url: sender && sender.tab && sender.tab.url ? sender.tab.url : "" });
            return false;
        }

        if (message.command === "frameBoostLimitReport") {
            const tabId = sender && sender.tab && sender.tab.id;
            const frameId = sender && Number.isInteger(sender.frameId) ? sender.frameId : 0;
            if (Number.isInteger(tabId) && frameId > 0) {
                tabsSendMessage(tabId, {
                    command: "frameBoostLimitReport",
                    frameId,
                    reason: typeof message.reason === "string" ? message.reason : ""
                }, TOP_FRAME_OPTIONS).catch(() => {});
            }
            sendResponse({});
            return false;
        }

        if (message.command === "topUrlChanged") {
            const tabId = sender && sender.tab && sender.tab.id;
            const url = typeof message.url === "string" && message.url
                ? message.url
                : (sender && sender.tab && sender.tab.url ? sender.tab.url : "");
            if (Number.isInteger(tabId)) {
                actionSetBadgeText({ tabId, text: "" }).catch(handleError);
                actionSetTitle({ tabId, title: "Volume Control" }).catch(handleError);
                tabsSendMessage(tabId, { command: "profileUrlChanged", url }).catch(() => {});
            }
            sendResponse({});
            return false;
        }

        if (message.command !== "showNativeVolumeFeedback") return false;

        showNativeVolumeFeedback(message.tabId, message.dB, message.muted)
            .then(() => sendResponse({}))
            .catch((error) => {
                handleError(error);
                sendResponse({});
            });
        return true;
    });
}


async function clearAllTabFeedback() {
    try {
        const tabs = await tabsQuery({});
        await Promise.all((tabs || [])
            .filter(tab => Number.isInteger(tab.id))
            .map(tab => Promise.all([
                actionSetBadgeText({ tabId: tab.id, text: "" }).catch(handleError),
                actionSetTitle({ tabId: tab.id, title: "Volume Control" }).catch(handleError)
            ])));
    } catch (e) {
        handleError(e);
    }
}

if (browserApi && browserApi.storage && browserApi.storage.onChanged) {
    browserApi.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.fqdns || changes.whitelist || changes.whitelistMode || changes.whitelistSeparatedV1) {
            clearAllTabFeedback();
        }
    });
}

if (browserApi && browserApi.tabs && browserApi.tabs.onUpdated) {
    browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!changeInfo || !changeInfo.url) return;
        actionSetBadgeText({ tabId, text: "" }).catch(handleError);
        actionSetTitle({ tabId, title: "Volume Control" }).catch(handleError);
        tabsSendMessage(tabId, {
            command: "profileUrlChanged",
            url: changeInfo.url
        }).catch(() => {});
    });
}
