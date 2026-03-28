const browserApi = (typeof browser !== 'undefined') ? browser : chrome;
const cached = {
  slider: null,
  volumeText: null,
  monoCheckbox: null,
  rememberCheckbox: null,
  enableCheckbox: null
};

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      browserApi.storage.local.get(keys, (res) => {
        if (browserApi.runtime.lastError) reject(browserApi.runtime.lastError);
        else resolve(res);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      browserApi.storage.local.set(obj, () => {
        if (browserApi.runtime.lastError) reject(browserApi.runtime.lastError);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
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

document.addEventListener('DOMContentLoaded', () => {
  const slider = document.getElementById('volume-slider');
  if (slider) {
      slider.focus();
  }

  const settingsBtn = document.getElementById('settings');
  if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
          if (browserApi.runtime.openOptionsPage) {
              browserApi.runtime.openOptionsPage(() => {
                  if (browserApi.runtime.lastError) console.error(browserApi.runtime.lastError);
              });
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
  browserApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      handleTabs(tabs);
  });
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

    browserApi.tabs.sendMessage(currentTab.id, { command: "checkExclusion" }, (response) => {
        if (browserApi.runtime.lastError) {
            // Content script didn't respond — fall back to storage check to decide whether the page is truly excluded.
            (async () => {
                try {
                    const domain = extractRootDomain(currentTab.url);
                    if (!domain) {
                        showError({ type: "exclusion" });
                        return;
                    }
                    const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });
                    let isExcluded = false;
                    if (data.whitelistMode) {
                        const remembered = Object.keys(data.siteSettings || {});
                        isExcluded = !remembered.includes(domain);
                    } else {
                        isExcluded = data.fqdns.includes(domain);
                    }
                    if (isExcluded) showError({ type: "exclusion" });
                } catch (e) {
                    showError({ type: "exclusion" });
                }
            })();
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

        let isExcluded = data.fqdns.includes(domain);

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
                            browserApi.tabs.sendMessage(tabId, { command: "setVolume", dB: settings[domain].volume }, () => {});
                            browserApi.tabs.sendMessage(tabId, { command: "setMono", mono: Boolean(settings[domain].mono) }, () => {});
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

        browserApi.tabs.reload(tabId);
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
  const n = Number(dB);
  if (Number.isNaN(n)) return '';
  return `${n >= 0 ? '+' : ''}${n} dB`;
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
        data.siteSettings[domain] = {
            volume: parseInt(volumeSlider?.value, 10) || 0,
            mono: Boolean(monoCheckbox?.checked)
        };
        await storageSet({ siteSettings: data.siteSettings });

        // Notify the content script in this tab immediately so volume/mono are applied without waiting
        if (tab && tab.id) {
            try {
                browserApi.tabs.sendMessage(tab.id, { command: "setVolume", dB: data.siteSettings[domain].volume }, () => {
                    if (browserApi.runtime && browserApi.runtime.lastError) {
                        // It's possible the content script hasn't injected into the page yet; ignore harmless errors.
                    }
                });
                browserApi.tabs.sendMessage(tab.id, { command: "setMono", mono: Boolean(data.siteSettings[domain].mono) }, () => {
                    if (browserApi.runtime && browserApi.runtime.lastError) {}
                });
            } catch (e) {
                // ignore messaging errors
            }
        }
    } catch (e) {
        handleError(e);
    }
} 

async function setVolume(dB, tab) {
  const slider = cached.slider || document.querySelector("#volume-slider");
  const text = cached.volumeText || document.querySelector("#volume-text");
  if (slider) slider.value = String(dB);
  if (text) text.value = formatValue(dB);

  if (tab) {
      browserApi.tabs.sendMessage(tab.id, { command: "setVolume", dB: Number(dB) }, (response) => {
          if (browserApi.runtime.lastError) handleError(browserApi.runtime.lastError);
      });
      await saveSiteSettings(tab);
  }
}

async function toggleMono(tab) {
  const monoCheckbox = cached.monoCheckbox || document.querySelector("#mono-checkbox");
  if (tab && monoCheckbox) {
      browserApi.tabs.sendMessage(tab.id, { command: "setMono", mono: monoCheckbox.checked }, (res) => {
           if (browserApi.runtime.lastError) handleError(browserApi.runtime.lastError);
      });
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
            if (data.siteSettings && data.siteSettings[domain]) {
                delete data.siteSettings[domain];
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
    const monoCheckbox = document.querySelector("#mono-checkbox");
    const rememberCheckbox = document.querySelector("#remember-checkbox");

    cached.slider = volumeSlider;
    cached.volumeText = volumeText;
    cached.monoCheckbox = monoCheckbox;
    cached.rememberCheckbox = rememberCheckbox;

    if (volumeSlider) {
      volumeSlider.addEventListener("input", () => {
          if (cached.volumeText) cached.volumeText.value = formatValue(volumeSlider.value);
          setVolume(volumeSlider.value, tab);
      });
    }
    
    if (volumeText) {
      volumeText.addEventListener("change", () => {
           const val = volumeText.value.match(/-?\d+/)?.[0];
           if (val) setVolume(val, tab);
      });
    }

    if (monoCheckbox) monoCheckbox.addEventListener("change", () => toggleMono(tab));
    if (rememberCheckbox) rememberCheckbox.addEventListener("change", () => toggleRemember(tab));

    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    try {
        const data = await storageGet({ siteSettings: {} });
        const saved = (data.siteSettings || {})[domain];
        if (saved) {
            if (rememberCheckbox) rememberCheckbox.checked = true;
            if (saved.volume !== undefined) setVolume(saved.volume, null);
            if (saved.mono !== undefined && monoCheckbox) monoCheckbox.checked = saved.mono;
        } else {
            browserApi.tabs.sendMessage(tab.id, { command: "getVolume" }, (response) => {
                if (!browserApi.runtime.lastError && response && response.response !== undefined) {
                    setVolume(response.response, null);
                }
            });
            browserApi.tabs.sendMessage(tab.id, { command: "getMono" }, (response) => {
                if (!browserApi.runtime.lastError && response && response.response !== undefined) {
                    if (monoCheckbox) monoCheckbox.checked = response.response;
                }
            });
        }
    } catch (e) {
        handleError(e);
    }
}