const browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const MIN_DB = -32;
const MAX_DB = 32;
const BOOST_LIMIT_NOTE = "Boosting and mono may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.";
const cached = {
  slider: null,
  volumeText: null,
  limitNote: null,
  monoCheckbox: null,
  rememberCheckbox: null,
  enableCheckbox: null,
  maxDb: MAX_DB,
  boostLimited: false
};

function normalizeDb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
}

function normalizeControlDb(value) {
  return Math.min(normalizeDb(value), cached.maxDb);
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

function runtimeSendMessage(message) {
  return callApi(browserApi.runtime.sendMessage.bind(browserApi.runtime), [message]);
}

function tabsReload(tabId) {
  return callApi(browserApi.tabs.reload.bind(browserApi.tabs), [tabId]).then(() => undefined);
}

function openOptionsPage() {
  return callApi(browserApi.runtime.openOptionsPage.bind(browserApi.runtime)).then(() => undefined);
}

function extractRootDomain(url) {
    if (!url) return null;
    if (url.startsWith('file:')) return 'Local File';
    if (url.startsWith('chrome') || url.startsWith('edge') || url.startsWith('about') || url.startsWith('extension')) return null;

    let domain = url.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0];
    domain = domain.split(':')[0];
    return domain.toLowerCase();
}

function getSiteSettingsKey(siteSettings, domain) {
    if (!siteSettings || !domain) return null;
    if (siteSettings[domain]) return domain;

    return Object.keys(siteSettings)
        .filter(savedDomain => domainMatchesSaved(domain, savedDomain))
        .sort((a, b) => b.length - a.length)[0] || null;
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

document.addEventListener('DOMContentLoaded', () => {
  const slider = document.getElementById('volume-slider');
  if (slider) {
      slider.focus();
  }

  const settingsBtn = document.getElementById('settings');
  if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
          if (browserApi.runtime.openOptionsPage) {
              openOptionsPage().catch(console.error);
          } else {
              window.open(browserApi.runtime.getURL('options.html'));
          }
      });
  }

  browserApi.runtime.onMessage.addListener((message) => {
    if (message.type === "exclusion") showError({ type: "exclusion" });
  });

  document.addEventListener('keydown', () => {
    if (slider && document.activeElement !== slider) {
      slider.focus();
    }
  }, { once: true });

  listenForEvents();
});

function listenForEvents() {
  tabsQuery({ active: true, currentWindow: true })
      .then(handleTabs)
      .catch(handleError);
}

function handleTabs(tabs) {
    const currentTab = tabs && tabs[0];
    
    if (!currentTab || !currentTab.url) {
        showError({ message: "No active tab." });
        return;
    }

    const protocol = currentTab.url.split(':')[0];
    const restrictedProtocols = ['chrome', 'edge', 'about', 'extension', 'chrome-extension', 'moz-extension', 'view-source'];
    
    if (restrictedProtocols.includes(protocol)) {
        showError({ message: "Volume control is not available on system pages." });
        const switchLabel = document.querySelector('label[for="enable-checkbox"]');
        if(switchLabel) switchLabel.style.display = 'none';
        return;
    }

    updateEnableSwitch(currentTab);

    tabsSendMessage(currentTab.id, { command: "checkExclusion" }).catch(async () => {
        // Content script didn't respond; fall back to storage to decide whether the page is truly excluded.
        try {
            const domain = extractRootDomain(currentTab.url);
            if (!domain) {
                showError({ type: "exclusion" });
                return;
            }
            const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });
            let isExcluded = false;
            if (data.whitelistMode) {
                isExcluded = !getSiteSettingsKey(data.siteSettings || {}, domain);
            } else {
                isExcluded = (data.fqdns || []).some(savedDomain => domainMatchesSaved(domain, savedDomain));
            }
            if (isExcluded) showError({ type: "exclusion" });
        } catch (e) {
            showError({ type: "exclusion" });
        }
    });
    
    initializeControls(currentTab);
}

async function updateEnableSwitch(tab) {
    const checkbox = document.getElementById('enable-checkbox');
    const switchLabel = document.querySelector('label[for="enable-checkbox"]');
    const domain = extractRootDomain(tab.url);
    
    if (!domain) {
        if (switchLabel) switchLabel.style.display = 'none';
        return;
    } else {
        if (switchLabel) switchLabel.style.display = 'flex';
    }

    try {
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });

        // When whitelist mode is active, remembered sites determine which pages are allowed.
        // Hide the enable/active switch to avoid duplicate controls and potential user confusion.
        if (data.whitelistMode) {
            if (switchLabel) switchLabel.style.display = 'none';
            return;
        }

        let isExcluded = (data.fqdns || []).some(savedDomain => domainMatchesSaved(domain, savedDomain));

        if (checkbox) checkbox.checked = !isExcluded;

        checkbox.onchange = (e) => {
            const isActive = e.target.checked;
            toggleSitePermission(domain, !isActive, tab.id);
        };
    } catch (e) {
        handleError(e);
    }
} 

async function toggleSitePermission(domain, shouldExclude, tabId) {
    try {
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false });
        const newData = {};

        if (data.whitelistMode) {
            // Edit remembered sites instead of an arbitrary whitelist
            const sd = await storageGet({ siteSettings: {} });
            const settings = sd.siteSettings || {};
            if (shouldExclude) {
                if (settings[domain]) {
                    delete settings[domain];
                    await storageSet({ siteSettings: settings });
                }
            } else {
                if (!settings[domain]) {
                    settings[domain] = { volume: 0, mono: false };
                    await storageSet({ siteSettings: settings });
                    // Try to apply settings immediately to the tab that requested the change
                    if (tabId) {
                        try {
                            tabsSendMessage(tabId, { command: "setVolume", dB: settings[domain].volume }).catch(() => {});
                            tabsSendMessage(tabId, { command: "setMono", mono: Boolean(settings[domain].mono) }).catch(() => {});
                        } catch (e) { /* ignore */ }
                    }
                }
            }
        } else {
            newData.fqdns = data.fqdns || [];
            if (shouldExclude) {
                if (!newData.fqdns.includes(domain)) newData.fqdns.push(domain);
            } else {
                const idx = newData.fqdns.indexOf(domain);
                if (idx > -1) newData.fqdns.splice(idx, 1);
            }
            await storageSet({ fqdns: newData.fqdns });
        }

        await tabsReload(tabId);
        window.close();
    } catch (e) {
        handleError(e);
    }
} 

function handleError(error) {
  const msg = error.message || error;
  if (typeof msg === 'string') {
      if (msg.includes("Receiving end does not exist") ||
          msg.includes("Could not establish connection") ||
          msg.includes("message channel closed")
      ) {
          return;
      }
  }
  console.error(`Volume Control: Error: ${msg}`);
}

function formatValue(dB) {
  const n = normalizeDb(dB);
  return `${n >= 0 ? '+' : ''}${n} dB`;
}

function setDisplayedVolume(dB) {
  const normalizedDb = normalizeControlDb(dB);
  const slider = cached.slider || document.querySelector("#volume-slider");
  const text = cached.volumeText || document.querySelector("#volume-text");

  if (slider) slider.value = String(normalizedDb);
  if (text) text.value = formatValue(normalizedDb);

  return normalizedDb;
}

function applyAudioControlState(state = {}) {
  const maxDb = Number.isFinite(Number(state.maxDb)) ? normalizeDb(state.maxDb) : MAX_DB;

  cached.maxDb = Math.min(MAX_DB, Math.max(MIN_DB, maxDb));
  cached.boostLimited = Boolean(state.boostLimited) || cached.maxDb <= 0;

  const slider = cached.slider || document.querySelector("#volume-slider");
  const note = cached.limitNote || document.querySelector("#volume-limit-note");

  if (slider) {
    slider.max = String(cached.maxDb);
    slider.style.setProperty("--vc-range-steps", String(Math.max(1, cached.maxDb - MIN_DB)));
    if (normalizeDb(slider.value) > cached.maxDb) setDisplayedVolume(cached.maxDb);
  }

  if (note) {
    note.textContent = state.limitation || BOOST_LIMIT_NOTE;
    note.classList.toggle("hidden", !cached.boostLimited);
  }
}

async function refreshAudioControlState(tab) {
    if (!tab || tab.id === undefined) return null;

    const response = await tabsSendMessage(tab.id, { command: "getAudioControlState" }).catch(handleError);
    const state = response && response.response ? response.response : null;

    if (state) {
        applyAudioControlState(state);
        if (state.volume !== undefined) setDisplayedVolume(state.volume);
        if (state.mono !== undefined && cached.monoCheckbox) cached.monoCheckbox.checked = Boolean(state.mono);
    }

    return state;
}

async function saveSiteSettings(tab) {
    try {
        const rememberCheckbox = document.getElementById("remember-checkbox");
        if (!rememberCheckbox || !rememberCheckbox.checked || !tab || !tab.url) return;

        const domain = extractRootDomain(tab.url);
        if (!domain) return;

        const volumeSlider = cached.slider || document.getElementById("volume-slider");
        const monoCheckbox = cached.monoCheckbox || document.getElementById("mono-checkbox");

        const data = await storageGet({ siteSettings: {} });
        data.siteSettings = data.siteSettings || {};
        const settingsKey = getSiteSettingsKey(data.siteSettings, domain) || domain;
        data.siteSettings[settingsKey] = {
            volume: normalizeControlDb(volumeSlider?.value),
            mono: Boolean(monoCheckbox?.checked)
        };
        await storageSet({ siteSettings: data.siteSettings });

        // Notify the content script in this tab immediately so volume/mono are applied without waiting
        if (tab && tab.id) {
            try {
                tabsSendMessage(tab.id, { command: "setVolume", dB: data.siteSettings[settingsKey].volume }).catch(() => {
                    // It's possible the content script hasn't injected into the page yet; ignore harmless errors.
                });
                tabsSendMessage(tab.id, { command: "setMono", mono: Boolean(data.siteSettings[settingsKey].mono) }).catch(() => {});
            } catch (e) {
                // ignore messaging errors
            }
        }
    } catch (e) {
        handleError(e);
    }
} 

async function setVolume(dB, tab, options = {}) {
  let normalizedDb = setDisplayedVolume(dB);

  if (tab) {
      const response = await tabsSendMessage(tab.id, {
          command: "setVolume",
          dB: normalizedDb
      }).catch(handleError);

      if (response && response.response) {
          applyAudioControlState(response.response);
          if (response.response.volume !== undefined) {
              normalizedDb = setDisplayedVolume(response.response.volume);
          }
      }

      if (options.showFeedback !== false) {
          runtimeSendMessage({
              command: "showNativeVolumeFeedback",
              tabId: tab.id,
              dB: normalizedDb
          }).catch(() => {});
      }
      await saveSiteSettings(tab);
  }
}

async function toggleMono(tab) {
  const monoCheckbox = cached.monoCheckbox || document.querySelector("#mono-checkbox");
  if (tab && monoCheckbox) {
      tabsSendMessage(tab.id, { command: "setMono", mono: monoCheckbox.checked }).catch(handleError);
      await saveSiteSettings(tab);
  }
}

async function toggleRemember(tab) {
    try {
        const rememberCheckbox = document.getElementById("remember-checkbox");
        const domain = extractRootDomain(tab.url);
        if (!domain) return;

        if (rememberCheckbox && rememberCheckbox.checked) {
            await saveSiteSettings(tab);
        } else {
            const data = await storageGet({ siteSettings: {} });
            const settingsKey = getSiteSettingsKey(data.siteSettings, domain);
            if (data.siteSettings && settingsKey) {
                delete data.siteSettings[settingsKey];
                await storageSet({ siteSettings: data.siteSettings });
            }
        }
    } catch (e) {
        handleError(e);
    }
}

function showError(error) {
  const popupContent = document.querySelector("#popup-content");
  const errorContent = document.querySelector("#error-content");
  const exclusionMessage = document.querySelector(".exclusion-message");
  
  if (popupContent) popupContent.classList.add("hidden");
  if (errorContent) errorContent.classList.add("hidden");
  if (exclusionMessage) exclusionMessage.classList.add("hidden");

  if (error.type === "exclusion") {
    if (popupContent) popupContent.classList.remove("hidden");
    if (exclusionMessage) exclusionMessage.classList.remove("hidden");
    
    const top = document.querySelector(".top-controls");
    const left = document.querySelector(".left");
    if(top) top.classList.add("hidden");
    if(left) left.classList.add("hidden"); 
    document.body.classList.add("excluded-site");
  } else {
    if (errorContent) {
        errorContent.classList.remove("hidden");
        errorContent.querySelector("p").textContent = error.message || "An error occurred";
    }
  }
}

async function initializeControls(tab) {
    if (!tab) return;

    const volumeSlider = document.querySelector("#volume-slider");
    const volumeText = document.querySelector("#volume-text");
    const limitNote = document.querySelector("#volume-limit-note");
    const monoCheckbox = document.querySelector("#mono-checkbox");
    const rememberCheckbox = document.querySelector("#remember-checkbox");

    cached.slider = volumeSlider;
    cached.volumeText = volumeText;
    cached.limitNote = limitNote;
    cached.monoCheckbox = monoCheckbox;
    cached.rememberCheckbox = rememberCheckbox;

    applyAudioControlState({ maxDb: MAX_DB, boostLimited: false, limitation: "" });

    if (volumeSlider) {
      volumeSlider.addEventListener("input", () => {
          const normalizedDb = setDisplayedVolume(volumeSlider.value);
          setVolume(normalizedDb, tab);
      });
    }
    
    if (volumeText) {
      volumeText.addEventListener("change", () => {
           const val = volumeText.value.match(/-?\d+/)?.[0];
           if (val) setVolume(normalizeDb(val), tab);
      });
    }

    if (monoCheckbox) monoCheckbox.addEventListener("change", () => toggleMono(tab));
    if (rememberCheckbox) rememberCheckbox.addEventListener("change", () => toggleRemember(tab));

    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    try {
        const audioState = await refreshAudioControlState(tab);
        const data = await storageGet({ siteSettings: {} });
        const settingsKey = getSiteSettingsKey(data.siteSettings || {}, domain);
        const saved = settingsKey ? data.siteSettings[settingsKey] : null;
        if (saved) {
            if (rememberCheckbox) rememberCheckbox.checked = true;
            if (saved.mono !== undefined && monoCheckbox) monoCheckbox.checked = saved.mono;
            if (saved.volume !== undefined) await setVolume(saved.volume, tab, { showFeedback: false });
            tabsSendMessage(tab.id, { command: "setMono", mono: Boolean(saved.mono) }).catch(handleError);
        } else if (!audioState) {
            tabsSendMessage(tab.id, { command: "getVolume" }).then((response) => {
                if (response && response.response !== undefined) setVolume(response.response, null);
            }).catch(handleError);
            tabsSendMessage(tab.id, { command: "getMono" }).then((response) => {
                if (response && response.response !== undefined && monoCheckbox) {
                    monoCheckbox.checked = response.response;
                }
            }).catch(handleError);
        }
    } catch (e) {
        handleError(e);
    }
}
