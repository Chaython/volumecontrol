const {
    browserApi,
    normalizeDb,
    normalizeDomainInput,
    normalizeSiteSettingsEntryInput,
    normalizeBlocklistEntryInput,
    formatDb,
    storageGet,
    storageSet,
    runtimeSendMessage,
    callApi
} = globalThis.VolumeControlShared;

// debounce timer for memory list rendering to avoid double-renders when storage changes
let memoryListRenderTimeout = null;
// debounce for fqdn list updates
let fqdnListRenderTimeout = null;

function mutateSiteSettings(mutation) {
    return runtimeSendMessage({ command: "mutateSiteSettings", mutation });
}

function mutateAccessLists(mutation) {
    return runtimeSendMessage({ command: "mutateAccessLists", mutation });
}

function normalizeDebugRouteMode(value) {
    return value === 'webaudio' || value === 'native' ? value : 'auto';
}

function normalizeSiteDebugOverrides(value = {}) {
    return {
        debugMode: !!value.debugMode,
        forceDrmCapture: !!value.forceDrmCapture,
        forceCorsCapture: !!value.forceCorsCapture,
        debugRouteMode: normalizeDebugRouteMode(value.debugRouteMode)
    };
}

function createMemoryEntry(domain, settings, onRemove, onUpdate, onRename, globalDebugSettings = {}) {
    const entry = document.createElement('div');
    entry.className = 'list-entry';

    const info = document.createElement('input');
    info.type = 'text';
    info.className = 'domain-input';
    info.value = domain;
    info.title = 'Edit site';
    info.setAttribute('aria-label', 'Edit remembered site');

    // Commit rename on blur or Enter
    const commitRename = async () => {
        const newName = normalizeSiteSettingsEntryInput(info.value);
        if (!newName) {
            alert('Site cannot be empty.');
            info.value = domain;
            info.focus();
            return;
        }
        if (newName === domain) {
            info.value = domain;
            return;
        }
        if (typeof onRename === 'function') await onRename(domain, newName);
    };
    info.addEventListener('blur', commitRename);
    info.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') info.blur();
    });

    const controls = document.createElement('div');
    controls.className = 'controls-container';

    const settingGroup = document.createElement('div');
    settingGroup.className = 'setting-group';

    // Volume input
    const volLabel = document.createElement('span');
    volLabel.textContent = 'Vol';
    settingGroup.appendChild(volLabel);

    const volInput = document.createElement('input');
    volInput.type = 'text';
    volInput.className = 'vol-input';
    // value will be shown formatted (e.g. '+3 dB') when not focused
    settingGroup.appendChild(volInput);

    // Initialize formatted value (shows e.g. '+3 dB') and store numeric separately
    const initialVol = (settings && settings.volume !== undefined) ? normalizeDb(settings.volume) : 0;
    volInput.value = formatDb(initialVol);
    volInput.dataset.numericValue = String(initialVol);

    // When focusing, show only the numeric part so user can edit
    volInput.addEventListener('focus', () => {
        volInput.value = String(normalizeDb(volInput.dataset.numericValue));
        volInput.select();
    });

    // Keep numericValue up-to-date while typing
    volInput.addEventListener('input', () => {
        const parsed = Number(volInput.value);
        if (Number.isFinite(parsed)) volInput.dataset.numericValue = String(normalizeDb(parsed));
    });

    // On blur/change, format back to '# dB' and commit
    const commitVol = () => {
        const v = Number(volInput.value);
        const numeric = Number.isFinite(v) ? normalizeDb(v) : normalizeDb(volInput.dataset.numericValue);
        volInput.dataset.numericValue = String(numeric);
        volInput.value = formatDb(numeric);
        onUpdate(domain, { volume: numeric, mono: Boolean(monoCheckbox.checked), muted: Boolean(muteCheckbox.checked) });
    };

    volInput.addEventListener('blur', commitVol);
    volInput.addEventListener('change', commitVol);

    // Mono checkbox
    const monoLabel = document.createElement('label');
    monoLabel.className = 'mono-label';
    const monoCheckbox = document.createElement('input');
    monoCheckbox.type = 'checkbox';
    monoCheckbox.checked = Boolean(settings && settings.mono);
    monoLabel.appendChild(monoCheckbox);
    const monoText = document.createElement('span');
    monoText.textContent = 'Mono';
    monoLabel.appendChild(monoText);

    monoCheckbox.addEventListener('change', () => {
        onUpdate(domain, { volume: normalizeDb(volInput.dataset.numericValue), mono: Boolean(monoCheckbox.checked), muted: Boolean(muteCheckbox.checked) });
    });

    settingGroup.appendChild(monoLabel);

    // Mute checkbox
    const muteLabel = document.createElement('label');
    muteLabel.className = 'mono-label';
    const muteCheckbox = document.createElement('input');
    muteCheckbox.type = 'checkbox';
    muteCheckbox.checked = Boolean(settings && settings.muted);
    muteLabel.appendChild(muteCheckbox);
    const muteText = document.createElement('span');
    muteText.textContent = 'Mute';
    muteLabel.appendChild(muteText);

    muteCheckbox.addEventListener('change', () => {
        onUpdate(domain, { volume: normalizeDb(volInput.dataset.numericValue), mono: Boolean(monoCheckbox.checked), muted: Boolean(muteCheckbox.checked) });
    });

    settingGroup.appendChild(muteLabel);

    controls.appendChild(settingGroup);

    // Optional per-site debug override. When disabled, this remembered site
    // inherits the global debug defaults below. Enabling it snapshots the
    // currently displayed effective values so behavior does not change just
    // because the override was turned on.
    const savedDebug = settings && settings.debug && typeof settings.debug === 'object'
        ? normalizeSiteDebugOverrides(settings.debug)
        : null;
    const inheritedDebug = normalizeSiteDebugOverrides(globalDebugSettings);
    const effectiveDebug = savedDebug || inheritedDebug;

    const debugGroup = document.createElement('div');
    debugGroup.className = 'setting-group site-debug-group';

    const perSiteLabel = document.createElement('label');
    perSiteLabel.className = 'mono-label site-debug-enable';
    perSiteLabel.title = 'Override the global debug options for this remembered site';
    const perSiteCheckbox = document.createElement('input');
    perSiteCheckbox.type = 'checkbox';
    perSiteCheckbox.checked = Boolean(savedDebug);
    perSiteLabel.appendChild(perSiteCheckbox);
    const perSiteText = document.createElement('span');
    perSiteText.textContent = 'Site debug';
    perSiteLabel.appendChild(perSiteText);
    debugGroup.appendChild(perSiteLabel);

    function makeDebugCheckbox(text, checked, title) {
        const label = document.createElement('label');
        label.className = 'mono-label site-debug-option';
        label.title = title;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        label.appendChild(checkbox);
        const span = document.createElement('span');
        span.textContent = text;
        label.appendChild(span);
        debugGroup.appendChild(label);
        return checkbox;
    }

    const debugHighlightCheckbox = makeDebugCheckbox(
        'Highlight',
        effectiveDebug.debugMode,
        'Show debug borders on media elements for this site'
    );
    const drmCheckbox = makeDebugCheckbox(
        'DRM',
        effectiveDebug.forceDrmCapture,
        'Force DRM/EME audio capture for this site (dangerous)'
    );
    const corsCheckbox = makeDebugCheckbox(
        'CORS',
        effectiveDebug.forceCorsCapture,
        'Skip the cross-origin media guard for this site (dangerous)'
    );

    const routeSelect = document.createElement('select');
    routeSelect.className = 'site-debug-route';
    routeSelect.title = 'HTML media route override for this site';
    for (const [value, label] of [
        ['auto', 'Route: Auto'],
        ['webaudio', 'Route: WebAudio'],
        ['native', 'Route: Native']
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        routeSelect.appendChild(option);
    }
    routeSelect.value = effectiveDebug.debugRouteMode;
    debugGroup.appendChild(routeSelect);

    const debugInputs = [debugHighlightCheckbox, drmCheckbox, corsCheckbox, routeSelect];
    const updateDebugEnabledState = () => {
        for (const input of debugInputs) input.disabled = !perSiteCheckbox.checked;
        debugGroup.classList.toggle('is-inherited', !perSiteCheckbox.checked);
    };
    const commitDebug = () => {
        if (!perSiteCheckbox.checked) {
            onUpdate(domain, { debug: null });
            return;
        }
        onUpdate(domain, {
            debug: normalizeSiteDebugOverrides({
                debugMode: debugHighlightCheckbox.checked,
                forceDrmCapture: drmCheckbox.checked,
                forceCorsCapture: corsCheckbox.checked,
                debugRouteMode: routeSelect.value
            })
        });
    };

    perSiteCheckbox.addEventListener('change', () => {
        updateDebugEnabledState();
        commitDebug();
    });
    debugHighlightCheckbox.addEventListener('change', commitDebug);
    drmCheckbox.addEventListener('change', commitDebug);
    corsCheckbox.addEventListener('change', commitDebug);
    routeSelect.addEventListener('change', commitDebug);
    updateDebugEnabledState();

    controls.appendChild(debugGroup);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.title = 'Remove remembered settings';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => onRemove(domain));

    controls.appendChild(removeBtn);

    entry.appendChild(info);
    entry.appendChild(controls);

    return entry;
}

let memoryListRendering = false;
let fqdnListRendering = false;
let memoryListRenderPending = false;
let fqdnListRenderPending = false;

async function renderMemoryList() {
    if (memoryListRendering) {
        memoryListRenderPending = true;
        return;
    }
    memoryListRendering = true;
    try {
        const container = document.getElementById('memoryList');
        if (!container) {
            memoryListRendering = false;
            return;
        }
        container.innerHTML = '';

        const data = await storageGet({
            siteSettings: {},
            debugMode: false,
            forceDrmCapture: false,
            forceCorsCapture: false,
            debugRouteMode: 'auto'
        });
        const settings = data.siteSettings || {};
        const globalDebugSettings = normalizeSiteDebugOverrides(data);
        const domains = Object.keys(settings).sort((a, b) => a.localeCompare(b));

        if (domains.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-msg';
            empty.textContent = 'No remembered settings';
            container.appendChild(empty);
        }

        for (const d of domains) {
            const entry = createMemoryEntry(d, settings[d], async (domain) => {
                await mutateSiteSettings({ type: "remove", key: domain });
            }, async (domain, newVal) => {
                const patch = {};
                if (newVal.volume !== undefined) patch.volume = normalizeDb(newVal.volume);
                if (newVal.mono !== undefined) patch.mono = !!newVal.mono;
                if (newVal.muted !== undefined) patch.muted = !!newVal.muted;
                if (Object.prototype.hasOwnProperty.call(newVal, 'debug')) {
                    patch.debug = newVal.debug ? normalizeSiteDebugOverrides(newVal.debug) : null;
                }
                await mutateSiteSettings({ type: "merge", key: domain, patch });
            }, async (oldDomain, newDomain) => {
                const nd = normalizeSiteSettingsEntryInput(newDomain);
                if (!nd) {
                    alert('Site cannot be empty.');
                    return;
                }
                if (nd === oldDomain) return;
                const result = await mutateSiteSettings({ type: "rename", key: oldDomain, newKey: nd });
                if (result && result.reason === "exists") alert('A remembered entry for that site/path already exists.');
            }, globalDebugSettings);

            container.appendChild(entry);
        }
    } catch (e) {
        console.error('Options: renderMemoryList error', e);
    } finally {
        memoryListRendering = false;
        if (memoryListRenderPending) {
            memoryListRenderPending = false;
            queueMicrotask(() => renderMemoryList());
        }
    }
}

async function renderFqdnList() {
    if (fqdnListRendering) {
        fqdnListRenderPending = true;
        return;
    }
    fqdnListRendering = true;
    try {
        const container = document.getElementById('fqdnList');
        if (!container) {
            fqdnListRendering = false;
            return;
        }
        container.innerHTML = '';

        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {}, archivedFqdns: [] });
        const list = data.whitelistMode ? (data.whitelist || []) : (data.fqdns || []);

        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-msg';
            empty.textContent = 'No sites in list';
            container.appendChild(empty);
            return;
        }

        for (const d of list) {
            const entry = document.createElement('div');
            entry.className = 'list-entry';

            const info = document.createElement('div');
            info.className = 'domain-info';
            info.textContent = d;

            const controls = document.createElement('div');
            controls.className = 'controls-container';

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', async () => {
                await mutateAccessLists({
                    type: data.whitelistMode ? "removeWhitelist" : "removeBlocklist",
                    entry: d
                });
            });

            controls.appendChild(removeBtn);
            entry.appendChild(info);
            entry.appendChild(controls);
            container.appendChild(entry);
        }
    } catch (e) {
        console.error('Options: renderFqdnList error', e);
    } finally {
        fqdnListRendering = false;
        if (fqdnListRenderPending) {
            fqdnListRenderPending = false;
            queueMicrotask(() => renderFqdnList());
        }
    }
}

function isFirefoxBrowser() {
    return Boolean(browserApi && browserApi.runtime &&
        typeof browserApi.runtime.getURL === 'function' &&
        browserApi.runtime.getURL('').indexOf('moz-extension://') === 0);
}

function getSuggestedShortcut(commandName) {
    if (!browserApi || !browserApi.runtime || typeof browserApi.runtime.getManifest !== 'function') return '';
    try {
        const manifest = browserApi.runtime.getManifest();
        const suggested = manifest && manifest.commands && manifest.commands[commandName] &&
            manifest.commands[commandName].suggested_key;
        return suggested && (suggested.default || suggested.mac || suggested.windows || suggested.linux || suggested.chromeos)
            ? (suggested.default || suggested.mac || suggested.windows || suggested.linux || suggested.chromeos)
            : '';
    } catch (e) {
        return '';
    }
}

// Render the list of keyboard shortcuts using commands.getAll().
// Each row shows the action description and the current key combo as keycaps.
async function renderShortcuts() {
    const container = document.getElementById('shortcutsList');
    if (!container) return;
    if (!browserApi || !browserApi.commands || typeof browserApi.commands.getAll !== 'function') {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.textContent = 'Keyboard shortcuts are not available in this browser.';
        container.appendChild(empty);
        return;
    }

    let commands = [];
    try {
        commands = await callApi(browserApi.commands.getAll.bind(browserApi.commands), []);
    } catch (e) {
        console.error('Options: commands.getAll failed', e);
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.textContent = 'Could not load shortcuts.';
        container.appendChild(empty);
        return;
    }

    container.innerHTML = '';
    if (!commands || commands.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.textContent = 'No shortcuts configured.';
        container.appendChild(empty);
        return;
    }

    for (const cmd of commands) {
        const entry = document.createElement('div');
        entry.className = 'shortcut-entry';

        const name = document.createElement('div');
        name.className = 'shortcut-name';
        name.textContent = cmd.description || cmd.name || 'Shortcut';

        const keys = document.createElement('div');
        keys.className = 'shortcut-keys';
        if (cmd.shortcut) {
            // chrome.commands returns shortcuts like "Alt+Shift+Up".
            // Split on "+" and render each part as a keycap with separators.
            const parts = cmd.shortcut.split('+');
            parts.forEach((part, i) => {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'keycap-separator';
                    sep.textContent = '+';
                    keys.appendChild(sep);
                }
                const kbd = document.createElement('span');
                kbd.className = 'keycap';
                kbd.textContent = part.trim();
                keys.appendChild(kbd);
            });
        } else {
            const unset = document.createElement('span');
            unset.className = 'shortcut-unset';
            const suggested = getSuggestedShortcut(cmd.name);
            unset.textContent = suggested ? `Not set — suggested: ${suggested}` : 'Not set';
            keys.appendChild(unset);
        }

        entry.appendChild(name);
        entry.appendChild(keys);
        container.appendChild(entry);
    }
}

// Open the browser's keyboard shortcut customization page.
// Chrome/Edge: chrome://extensions/shortcuts
// Firefox: about:addons/shortcuts (Firefox 89+)
function openShortcutsPage() {
    if (!browserApi || !browserApi.tabs || typeof browserApi.tabs.create !== 'function') {
        alert('Could not open the shortcut settings page automatically. Please open your browser\'s extension shortcut settings manually.');
        return;
    }
    const url = isFirefoxBrowser() ? 'about:addons/shortcuts' : 'chrome://extensions/shortcuts';
    callApi(browserApi.tabs.create.bind(browserApi.tabs), [{ url }])
        .catch(err => {
            console.error('Options: failed to open shortcuts page', err);
            alert('Could not open the shortcut settings page automatically. Please open your browser\'s extension shortcut settings manually.');
        });
}

async function restoreShortcutDefaults() {
    if (!isFirefoxBrowser() || !browserApi.commands || typeof browserApi.commands.reset !== 'function') return;
    const button = document.getElementById('restoreShortcutDefaults');
    if (button) {
        button.disabled = true;
        button.textContent = 'Restoring...';
    }
    try {
        const commands = await callApi(browserApi.commands.getAll.bind(browserApi.commands), []);
        for (const cmd of commands || []) {
            if (cmd && cmd.name) {
                await callApi(browserApi.commands.reset.bind(browserApi.commands), [cmd.name]);
            }
        }
        await renderShortcuts();
    } catch (e) {
        console.error('Options: commands.reset failed', e);
        alert('Could not restore the default shortcuts.');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = 'Restore Default Shortcuts';
        }
    }
}

async function initOptions() {
    // Wire up whitelist mode and debug mode
    const whitelistModeCheckbox = document.getElementById('whitelistMode');
    const debugModeCheckbox = document.getElementById('debugMode');
    const forceDrmCaptureCheckbox = document.getElementById('forceDrmCapture');
    const forceCorsCaptureCheckbox = document.getElementById('forceCorsCapture');
    const debugRouteModeSelect = document.getElementById('debugRouteMode');
    const addBtn = document.getElementById('addFqdn');
    const newFqdnInput = document.getElementById('newFqdn');
    const listTitle = document.getElementById('listTitle');
    const fqdnAddGroup = newFqdnInput ? newFqdnInput.parentElement : null;
    const fqdnListContainer = document.getElementById('fqdnList');
    const updateAccessListLabels = (enabled) => {
        if (listTitle) listTitle.textContent = enabled ? 'Allowed Sites' : 'Blocked Sites';
        if (fqdnAddGroup) fqdnAddGroup.style.display = 'flex';
        if (fqdnListContainer) fqdnListContainer.style.display = 'block';
    };

    if (whitelistModeCheckbox) {
        const data = await storageGet({ whitelistMode: false, archivedFqdns: [] });
        whitelistModeCheckbox.checked = !!data.whitelistMode;
        updateAccessListLabels(Boolean(data.whitelistMode));

        whitelistModeCheckbox.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            const result = await mutateAccessLists({ type: "setWhitelistMode", enabled });
            if (!result || !result.ok) {
                e.target.checked = !enabled;
                return;
            }
            updateAccessListLabels(enabled);
            await renderFqdnList();
        });
    }

    if (debugModeCheckbox) {
        const data = await storageGet({ debugMode: false });
        debugModeCheckbox.checked = !!data.debugMode;
        debugModeCheckbox.addEventListener('change', async (e) => {
            await storageSet({ debugMode: e.target.checked });
        });
    }

    if (forceDrmCaptureCheckbox) {
        const data = await storageGet({ forceDrmCapture: false });
        forceDrmCaptureCheckbox.checked = !!data.forceDrmCapture;
        forceDrmCaptureCheckbox.addEventListener('change', async (e) => {
            await storageSet({ forceDrmCapture: e.target.checked });
        });
    }

    if (forceCorsCaptureCheckbox) {
        const data = await storageGet({ forceCorsCapture: false });
        forceCorsCaptureCheckbox.checked = !!data.forceCorsCapture;
        forceCorsCaptureCheckbox.addEventListener('change', async (e) => {
            await storageSet({ forceCorsCapture: e.target.checked });
        });
    }

    if (debugRouteModeSelect) {
        const data = await storageGet({ debugRouteMode: 'auto' });
        const mode = data.debugRouteMode === 'webaudio' || data.debugRouteMode === 'native'
            ? data.debugRouteMode
            : 'auto';
        debugRouteModeSelect.value = mode;
        debugRouteModeSelect.addEventListener('change', async (e) => {
            const value = e.target.value;
            await storageSet({ debugRouteMode: value === 'webaudio' || value === 'native' ? value : 'auto' });
        });
    }

    if (addBtn && newFqdnInput) {
        // v6.15: inline status line under the input (the DRM-note pattern:
        // small, informative, auto-dismissing) — tells the user when the typed
        // site/wildcard is ALREADY in the blocklist instead of silently
        // clearing the input and appearing to do nothing.
        const statusEl = document.getElementById('addFqdnStatus');
        let statusTimer = null;
        const showStatus = (text) => {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.hidden = false;
            if (statusTimer) clearTimeout(statusTimer);
            statusTimer = setTimeout(() => {
                statusEl.hidden = true;
                statusTimer = null;
            }, 4000);
        };

        const addFqdn = async () => {
            const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false });
            // Blocklist and whitelist modes both support URL paths.
            // Blocklist paths use exclusion semantics; whitelist paths use
            // explicit allow-list matching independent from remembered audio.
            const v = data.whitelistMode
                ? normalizeSiteSettingsEntryInput(newFqdnInput.value)
                : normalizeBlocklistEntryInput(newFqdnInput.value);
            if (!v) return;
            if (data.whitelistMode) {
                const result = await mutateAccessLists({ type: "addWhitelist", entry: v });
                if (!result || !result.ok) {
                    showStatus(`"${v}" is already in your whitelist.`);
                    return;
                }
            } else {
                const result = await mutateAccessLists({ type: "addBlocklist", entry: v });
                if (!result || !result.ok) {
                    showStatus(`"${v}" is already in your blocklist.`);
                    return;
                }
            }
            // Refresh list immediately so the UI reflects the addition without waiting for storage.onChanged
            await renderFqdnList();
            newFqdnInput.value = '';
        };

        addBtn.addEventListener('click', addFqdn);
        // v6.15: pressing Enter in the input adds the entry (same behavior as
        // the remembered-sites input) instead of forcing a click on "Add Site".
        newFqdnInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addFqdn();
            }
        });
    }

    // Add remembered site controls
    const addRememberedBtn = document.getElementById('addRemembered');
    const newRememberedInput = document.getElementById('newRememberedSite');
    if (addRememberedBtn && newRememberedInput) {
        addRememberedBtn.addEventListener('click', async () => {
            const v = normalizeSiteSettingsEntryInput(newRememberedInput.value);
            if (!v) return;
            const result = await mutateSiteSettings({
                type: "create",
                key: v,
                value: { volume: 0, mono: false, muted: false }
            });
            if (!result || !result.ok) {
                alert('A remembered entry for that site/path already exists.');
                return;
            }
            newRememberedInput.value = '';
        });
        newRememberedInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addRememberedBtn.click();
        });
    }

    // Keyboard shortcuts: wire up browser settings and Firefox's reset API.
    const openShortcutsBtn = document.getElementById('openShortcutsPage');
    if (openShortcutsBtn) {
        openShortcutsBtn.addEventListener('click', openShortcutsPage);
    }
    const restoreShortcutDefaultsBtn = document.getElementById('restoreShortcutDefaults');
    if (restoreShortcutDefaultsBtn &&
        isFirefoxBrowser() &&
        browserApi.commands &&
        typeof browserApi.commands.reset === 'function') {
        restoreShortcutDefaultsBtn.hidden = false;
        restoreShortcutDefaultsBtn.addEventListener('click', restoreShortcutDefaults);
    }
    await renderShortcuts();

    // Refresh the shortcuts list when the user customizes them in another tab
    // (chrome.commands.onChanged fires for the extension globally).
    if (browserApi && browserApi.commands && browserApi.commands.onChanged) {
        browserApi.commands.onChanged.addListener(() => {
            renderShortcuts();
        });
    }

    await renderFqdnList();
    await renderMemoryList();

    // When storage changes elsewhere, update UI (debounced for siteSettings)
    browserApi.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.siteSettings) {
            if (memoryListRenderTimeout) clearTimeout(memoryListRenderTimeout);
            memoryListRenderTimeout = setTimeout(() => {
                renderMemoryList();
                memoryListRenderTimeout = null;
            }, 50);
            // Remembered settings are independent from the explicit access list.
            if (fqdnListRenderTimeout) clearTimeout(fqdnListRenderTimeout);
            fqdnListRenderTimeout = setTimeout(() => {
                renderFqdnList();
                fqdnListRenderTimeout = null;
            }, 50);
        }
        if (changes.whitelistMode && whitelistModeCheckbox) {
            const enabled = Boolean(changes.whitelistMode.newValue);
            whitelistModeCheckbox.checked = enabled;
            updateAccessListLabels(enabled);
        }
        if (changes.fqdns || changes.whitelist || changes.whitelistMode || changes.archivedFqdns) {
            if (fqdnListRenderTimeout) clearTimeout(fqdnListRenderTimeout);
            fqdnListRenderTimeout = setTimeout(() => {
                renderFqdnList();
                fqdnListRenderTimeout = null;
            }, 50);
        }
        if (changes.debugMode && debugModeCheckbox) {
            debugModeCheckbox.checked = !!changes.debugMode.newValue;
        }
        if (changes.forceDrmCapture && forceDrmCaptureCheckbox) {
            forceDrmCaptureCheckbox.checked = !!changes.forceDrmCapture.newValue;
        }
        if (changes.forceCorsCapture && forceCorsCaptureCheckbox) {
            forceCorsCaptureCheckbox.checked = !!changes.forceCorsCapture.newValue;
        }
        if (changes.debugRouteMode && debugRouteModeSelect) {
            debugRouteModeSelect.value = normalizeDebugRouteMode(changes.debugRouteMode.newValue);
        }

        // Remembered rows that do not have a per-site override display the
        // current global values in a disabled state, so keep them live too.
        if (changes.debugMode || changes.forceDrmCapture || changes.forceCorsCapture || changes.debugRouteMode) {
            if (memoryListRenderTimeout) clearTimeout(memoryListRenderTimeout);
            memoryListRenderTimeout = setTimeout(() => {
                renderMemoryList();
                memoryListRenderTimeout = null;
            }, 50);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOptions);
} else {
    initOptions();
}
