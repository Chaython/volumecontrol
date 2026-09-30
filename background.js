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
const commandChains = new Map();
let siteSettingsMutationChain = Promise.resolve();
let accessListMutationChain = Promise.resolve();

function mutateSiteSettings(mutation = {}) {
    const run = async () => {
        const data = await storageGet({ siteSettings: {} });
        const siteSettings = { ...(data.siteSettings || {}) };
        const type = String(mutation.type || "");
        const rawKey = String(mutation.key == null ? "" : mutation.key).trim();
        const normalizedKey = normalizeSiteSettingsEntryInput(rawKey);
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
            if (Object.prototype.hasOwnProperty.call(patch, "debug") && patch.debug == null) delete next.debug;
            siteSettings[key] = next;
        } else if (type === "remove" || type === "removeForUrl") {
            delete siteSettings[key];
        } else if (type === "rename") {
            const newKey = normalizeSiteSettingsEntryInput(mutation.newKey);
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

function mutateAccessLists(mutation = {}) {
    const run = async () => {
        const data = await storageGet({
            fqdns: [],
            whitelist: [],
            archivedFqdns: [],
            whitelistMode: false,
            siteSettings: {}
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
                    const entry = normalizeSiteSettingsEntryInput(mutation.entry || url);
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
            const entry = normalizeSiteSettingsEntryInput(mutation.entry);
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
                // One-time compatibility bridge: users upgrading from the old
                // model had "allowed" sites encoded only as remembered profiles.
                // Seed the explicit whitelist once when entering whitelist mode.
                if (!whitelist.length) {
                    whitelist = Object.keys(data.siteSettings || {})
                        .map(entry => normalizeSiteSettingsEntryInput(entry))
                        .filter(Boolean);
                    whitelist = [...new Set(whitelist)];
                }
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
    // Always re-query instead of trusting the tab object passed by onCommand.
    // Firefox (and some Chrome versions) may pass an incomplete tab (missing
    // .url) without the full tabs permission. Re-querying with our existing
    // host_permissions guarantees a complete tab object including url.
    // The performance cost is negligible (one async tabs.query per hotkey press).
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
}

async function getDomainState(tab) {
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) return null;

    const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });
    const siteSettings = data.siteSettings || {};
    const settingsKey = getSiteSettingsKey(siteSettings, tab.url);
    // Path-aware blocklist matching (issue #69): legacy path entries like
    // "www.twitch.tv/*/clip/*" scope to their path instead of blocking the
    // whole domain.
    const blocked = data.whitelistMode
        ? !(data.whitelist || []).some(entry => isUrlRememberedByEntry(tab.url, entry))
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

async function setVolume(tab, domainState, dB) {
    const requestedVolume = normalizeDb(dB);
    // Broadcast to every frame so embedded players in iframes are also
    // controlled. The broadcast response is a cross-frame race and is ignored.
    await tabsSendMessage(tab.id, { command: "setVolume", dB: requestedVolume }).catch(handleError);
    // The authoritative applied volume (verdict-clamped by the top frame)
    // comes from a frame-targeted query.
    const response = await tabsSendMessage(tab.id, { command: "getAudioControlState" }, TOP_FRAME_OPTIONS).catch(handleError);
    const appliedVolume = response && response.response && response.response.volume !== undefined
        ? normalizeDb(response.response.volume)
        : requestedVolume;

    const muted = response && response.response && response.response.muted !== undefined
        ? Boolean(response.response.muted)
        : false;
    await showNativeVolumeFeedback(tab.id, appliedVolume, muted);
    await saveRememberedSettings(domainState, { volume: appliedVolume });
}

async function setMono(tab, domainState, mono) {
    const enabled = Boolean(mono);
    await tabsSendMessage(tab.id, { command: "setMono", mono: enabled }).catch(handleError);
    await saveRememberedSettings(domainState, { mono: enabled });
}

async function setMute(tab, domainState, muted) {
    const enabled = Boolean(muted);
    // Broadcast the mute toggle to every frame; the racy response is ignored.
    await tabsSendMessage(tab.id, { command: "setMute", muted: enabled }).catch(handleError);
    // Authoritative volume for the badge feedback comes from the top frame.
    const response = await tabsSendMessage(tab.id, { command: "getAudioControlState" }, TOP_FRAME_OPTIONS).catch(handleError);
    const dB = (response && response.response && response.response.volume !== undefined)
        ? normalizeDb(response.response.volume) : 0;
    await showNativeVolumeFeedback(tab.id, dB, enabled);
    await saveRememberedSettings(domainState, { muted: enabled });
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
async function purgeLegacyDefaultsOnce() {
    try {
        const data = await storageGet({ fqdns: [], legacyTwitchDefaultsPurged: false });
        if (data.legacyTwitchDefaultsPurged) return;
        const purged = purgeLegacyDefaultBlocklist(data.fqdns || []);
        await storageSet(Object.assign(
            purged.changed ? { fqdns: purged.list } : {},
            { legacyTwitchDefaultsPurged: true }
        ));
    } catch (e) {
        handleError(e);
    }
}
if (browserApi && browserApi.runtime && browserApi.runtime.onInstalled) {
    browserApi.runtime.onInstalled.addListener(() => { purgeLegacyDefaultsOnce(); });
}
if (browserApi && browserApi.runtime && browserApi.runtime.onStartup) {
    browserApi.runtime.onStartup.addListener(() => { purgeLegacyDefaultsOnce(); });
}
purgeLegacyDefaultsOnce(); // MV3 worker wake (e.g. after an update) before any user interaction

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
