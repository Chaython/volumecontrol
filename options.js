const {
    browserApi,
    normalizeDb,
    normalizeDomainInput,
    formatDb,
    storageGet,
    storageSet
} = globalThis.VolumeControlShared;

// debounce timer for memory list rendering to avoid double-renders when storage changes
let memoryListRenderTimeout = null;
// debounce for fqdn list updates
let fqdnListRenderTimeout = null;

function createMemoryEntry(domain, settings, onRemove, onUpdate, onRename) {
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
        const newName = normalizeDomainInput(info.value);
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

async function renderMemoryList() {
    if (memoryListRendering) return; // avoid concurrent renders
    memoryListRendering = true;
    try {
        const container = document.getElementById('memoryList');
        if (!container) {
            memoryListRendering = false;
            return;
        }
        container.innerHTML = '';

        const data = await storageGet({ siteSettings: {} });
        const settings = data.siteSettings || {};
        const domains = Object.keys(settings).sort((a, b) => a.localeCompare(b));

        if (domains.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-msg';
            empty.textContent = 'No remembered settings';
            container.appendChild(empty);
        }

        for (const d of domains) {
            const entry = createMemoryEntry(d, settings[d], async (domain) => {
                // remove
                delete settings[domain];
                await storageSet({ siteSettings: settings });
            }, async (domain, newVal) => {
                settings[domain] = { volume: normalizeDb(newVal.volume), mono: !!newVal.mono, muted: !!newVal.muted };
                await storageSet({ siteSettings: settings });
            }, async (oldDomain, newDomain) => {
                const nd = normalizeDomainInput(newDomain);
                if (!nd) {
                    alert('Site cannot be empty.');
                    return;
                }
                if (nd === oldDomain) return;
                if (settings[nd]) {
                    alert('A remembered entry for that site already exists.');
                    return;
                }
                settings[nd] = settings[oldDomain];
                delete settings[oldDomain];
                await storageSet({ siteSettings: settings });
            });

            container.appendChild(entry);
        }
    } catch (e) {
        console.error('Options: renderMemoryList error', e);
    } finally {
        memoryListRendering = false;
    }
}

async function renderFqdnList() {
    if (fqdnListRendering) return; // avoid concurrent renders
    fqdnListRendering = true;
    try {
        const container = document.getElementById('fqdnList');
        if (!container) {
            fqdnListRendering = false;
            return;
        }
        container.innerHTML = '';

        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {}, archivedFqdns: [] });
        const fqdns = data.fqdns || [];
        let list;
        if (data.whitelistMode) {
            // When whitelist mode is active we hide the blocklist; show an informational message about archived sites
            const archivedCount = (data.archivedFqdns || []).length;
            const empty = document.createElement('div');
            empty.className = 'empty-msg';
            empty.textContent = `Blocklist is hidden while whitelist mode is active. Archived ${archivedCount} site${archivedCount === 1 ? '' : 's'}. Manage allowed sites in Remembered Settings.`;
            container.appendChild(empty);
            return;
        } else {
            list = fqdns;
        }

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
                if (data.whitelistMode) {
                    // remove from remembered siteSettings
                    const sd = await storageGet({ siteSettings: {} });
                    const settings = sd.siteSettings || {};
                    if (settings[d]) {
                        delete settings[d];
                        await storageSet({ siteSettings: settings });
                    }
                } else {
                    const idx = fqdns.indexOf(d);
                    if (idx > -1) fqdns.splice(idx, 1);
                    await storageSet({ fqdns });
                }
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
    }
}

async function initOptions() {
    // Wire up whitelist mode and debug mode
    const whitelistModeCheckbox = document.getElementById('whitelistMode');
    const debugModeCheckbox = document.getElementById('debugMode');
    const addBtn = document.getElementById('addFqdn');
    const newFqdnInput = document.getElementById('newFqdn');

    if (whitelistModeCheckbox) {
        const data = await storageGet({ whitelistMode: false, archivedFqdns: [] });
        whitelistModeCheckbox.checked = !!data.whitelistMode;
        const listTitle = document.getElementById('listTitle');
        const fqdnAddGroup = newFqdnInput ? newFqdnInput.parentElement : null;
        const fqdnListContainer = document.getElementById('fqdnList');

        // Helper to show/hide the blocklist UI
        function setBlocklistVisible(show) {
            if (listTitle) listTitle.style.display = show ? 'block' : 'none';
            if (fqdnAddGroup) fqdnAddGroup.style.display = show ? 'flex' : 'none';
            if (fqdnListContainer) fqdnListContainer.style.display = show ? 'block' : 'none';
        }

        // Initialize visibility
        setBlocklistVisible(!data.whitelistMode);

        whitelistModeCheckbox.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            if (enabled) {
                // Archive current blacklist instead of deleting it
                const d = await storageGet({ fqdns: [], archivedFqdns: [] });
                if (d.fqdns && d.fqdns.length) {
                    await storageSet({ archivedFqdns: d.fqdns, fqdns: [] });
                } else {
                    // ensure archivedFqdns exists
                    await storageSet({ archivedFqdns: d.archivedFqdns || [] });
                }
                await storageSet({ whitelistMode: true });
                setBlocklistVisible(false);
            } else {
                // Restore archived blacklist if current list is empty
                const d = await storageGet({ fqdns: [], archivedFqdns: [] });
                if ((!d.fqdns || d.fqdns.length === 0) && d.archivedFqdns && d.archivedFqdns.length) {
                    await storageSet({ fqdns: d.archivedFqdns, archivedFqdns: [], whitelistMode: false });
                } else {
                    await storageSet({ whitelistMode: false });
                }
                setBlocklistVisible(true);
            }
            // Immediately update displayed list so UI reflects mode change without waiting for storage.onChanged
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

    if (addBtn && newFqdnInput) {
        addBtn.addEventListener('click', async () => {
            const v = normalizeDomainInput(newFqdnInput.value);
            if (!v) return;
            const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false });
            if (data.whitelistMode) {
                // Add as a remembered site so whitelist contains only remembered sites
                const sd = await storageGet({ siteSettings: {} });
                const settings = sd.siteSettings || {};
                if (!settings[v]) {
                    settings[v] = { volume: 0, mono: false };
                    await storageSet({ siteSettings: settings });
                }
            } else {
                data.fqdns = data.fqdns || [];
                if (!data.fqdns.includes(v)) data.fqdns.push(v);
                await storageSet({ fqdns: data.fqdns });
            }
            // Refresh list immediately so the UI reflects the addition without waiting for storage.onChanged
            await renderFqdnList();
            newFqdnInput.value = '';
        });
    }

    // Add remembered site controls
    const addRememberedBtn = document.getElementById('addRemembered');
    const newRememberedInput = document.getElementById('newRememberedSite');
    if (addRememberedBtn && newRememberedInput) {
        addRememberedBtn.addEventListener('click', async () => {
            const v = normalizeDomainInput(newRememberedInput.value);
            if (!v) return;
            const data = await storageGet({ siteSettings: {} });
            const settings = data.siteSettings || {};
            if (settings[v]) {
                alert('A remembered entry for that site already exists.');
                return;
            }
            settings[v] = { volume: 0, mono: false };
            await storageSet({ siteSettings: settings });
            newRememberedInput.value = '';
        });
        newRememberedInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addRememberedBtn.click();
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
            // Also refresh fqdn list because whitelist mode displays remembered sites
            if (fqdnListRenderTimeout) clearTimeout(fqdnListRenderTimeout);
            fqdnListRenderTimeout = setTimeout(() => {
                renderFqdnList();
                fqdnListRenderTimeout = null;
            }, 50);
        }
        if (changes.fqdns || changes.whitelist || changes.whitelistMode) {
            if (fqdnListRenderTimeout) clearTimeout(fqdnListRenderTimeout);
            fqdnListRenderTimeout = setTimeout(() => {
                renderFqdnList();
                fqdnListRenderTimeout = null;
            }, 50);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOptions);
} else {
    initOptions();
}
