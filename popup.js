// popup.js
const browserApi = (typeof browser !== 'undefined') ? browser : chrome;

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
  // Settings Button
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

  // Handle Messages
  browserApi.runtime.onMessage.addListener((message) => {
    if (message.type === "exclusion") showError({ type: "exclusion" });
  });

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
        // Hide the active switch on system pages
        const switchLabel = document.querySelector('label[for="enable-checkbox"]');
        if(switchLabel) switchLabel.style.display = 'none';
        return;
    }

    // 1. Setup the Active Switch
    updateEnableSwitch(currentTab);

    // 2. Check content script status
    browserApi.tabs.sendMessage(currentTab.id, { command: "checkExclusion" }, (response) => {
        if (browserApi.runtime.lastError) {
            showError({ type: "exclusion" });
        }
    });
    
    initializeControls(currentTab);
}

// --- NEW: Toggle Switch Logic ---
function updateEnableSwitch(tab) {
    const checkbox = document.getElementById('enable-checkbox');
    const switchLabel = document.querySelector('label[for="enable-checkbox"]');
    const domain = extractRootDomain(tab.url);
    
    if (!domain) {
        if(switchLabel) switchLabel.style.display = 'none';
        return;
    } else {
        if(switchLabel) switchLabel.style.display = 'flex';
    }

    browserApi.storage.local.get({ fqdns: [], whitelist: [], whitelistMode: false }, (data) => {
        let isExcluded = false;
        
        if (data.whitelistMode) {
            // Whitelist Mode: Excluded if NOT in list
            isExcluded = !data.whitelist.includes(domain);
        } else {
            // Blocklist Mode: Excluded if IN list
            isExcluded = data.fqdns.includes(domain);
        }

        // Set Checkbox State (Checked = Active/Enabled)
        checkbox.checked = !isExcluded;

        // Attach Change Handler
        checkbox.onchange = (e) => {
            const isActive = e.target.checked;
            // If isActive is true, we are un-excluding. If false, we are excluding.
            toggleSitePermission(domain, data, !isActive, tab.id);
        };
    });
}

function toggleSitePermission(domain, data, shouldExclude, tabId) {
    let newData = {};

    if (data.whitelistMode) {
        // Whitelist Logic
        newData.whitelist = data.whitelist || [];
        if (shouldExclude) {
            // Remove from whitelist
            const idx = newData.whitelist.indexOf(domain);
            if (idx > -1) newData.whitelist.splice(idx, 1);
        } else {
            // Add to whitelist
            if (!newData.whitelist.includes(domain)) newData.whitelist.push(domain);
        }
    } else {
        // Blocklist Logic
        newData.fqdns = data.fqdns || [];
        if (shouldExclude) {
            // Add to blocklist
            if (!newData.fqdns.includes(domain)) newData.fqdns.push(domain);
        } else {
            // Remove from blocklist
            const idx = newData.fqdns.indexOf(domain);
            if (idx > -1) newData.fqdns.splice(idx, 1);
        }
    }

    browserApi.storage.local.set(newData, () => {
        browserApi.tabs.reload(tabId);
        window.close(); 
    });
}

// --- STANDARD LOGIC ---

function err(error) {
  const msg = error.message || error;
  if (typeof msg === 'string' && (
      msg.includes("Receiving end does not exist") || 
      msg.includes("Could not establish connection")
  )) return;
  console.error(`Volume Control: Error: ${msg}`);
}

function formatValue(dB) {
  return `${dB >= 0 ? '+' : ''}${dB} dB`;
}

function saveSiteSettings(tab) {
    const rememberCheckbox = document.getElementById("remember-checkbox");
    if (!rememberCheckbox || !rememberCheckbox.checked || !tab || !tab.url) return;

    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    const volumeSlider = document.getElementById("volume-slider");
    const monoCheckbox = document.getElementById("mono-checkbox");

    browserApi.storage.local.get({ siteSettings: {} }, (data) => {
        data.siteSettings[domain] = {
            volume: parseInt(volumeSlider.value),
            mono: monoCheckbox.checked        
        };
        browserApi.storage.local.set({ siteSettings: data.siteSettings });
    });
}

function setVolume(dB, tab) {
  const slider = document.querySelector("#volume-slider");
  const text = document.querySelector("#volume-text");
  slider.value = dB;
  text.value = formatValue(dB);
  
  if (tab) {
      browserApi.tabs.sendMessage(tab.id, { command: "setVolume", dB }, (response) => {
          if(browserApi.runtime.lastError) err(browserApi.runtime.lastError);
      });
      saveSiteSettings(tab); 
  }
}

function toggleMono(tab) {
  const monoCheckbox = document.querySelector("#mono-checkbox");
  if(tab) {
      browserApi.tabs.sendMessage(tab.id, { command: "setMono", mono: monoCheckbox.checked }, (res) => {
           if(browserApi.runtime.lastError) err(browserApi.runtime.lastError);
      });
      saveSiteSettings(tab); 
  }
}

function toggleRemember(tab) {
    const rememberCheckbox = document.getElementById("remember-checkbox");
    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    if (rememberCheckbox.checked) {
        saveSiteSettings(tab);
    } else {
        browserApi.storage.local.get({ siteSettings: {} }, (data) => {
            if (data.siteSettings[domain]) {
                delete data.siteSettings[domain];
                browserApi.storage.local.set({ siteSettings: data.siteSettings });
            }
        });
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
    // Show Main + Exclusion Banner
    if (popupContent) popupContent.classList.remove("hidden");
    if (exclusionMessage) exclusionMessage.classList.remove("hidden");
    
    // Hide controls but keep Active switch visible
    const top = document.querySelector(".top-controls");
    const left = document.querySelector(".left");
    if(top) top.classList.add("hidden");
    if(left) left.classList.add("hidden"); 
    document.body.classList.add("excluded-site");
  } else {
    // Show Generic Error (System Pages)
    if (errorContent) {
        errorContent.classList.remove("hidden");
        errorContent.querySelector("p").textContent = error.message || "An error occurred";
    }
  }
}

function initializeControls(tab) {
    if (!tab) return;

    const volumeSlider = document.querySelector("#volume-slider");
    const volumeText = document.querySelector("#volume-text");
    const monoCheckbox = document.querySelector("#mono-checkbox");
    const rememberCheckbox = document.querySelector("#remember-checkbox");

    volumeSlider.addEventListener("input", () => {
        document.querySelector("#volume-text").value = formatValue(volumeSlider.value);
        setVolume(volumeSlider.value, tab);
    });
    
    volumeText.addEventListener("change", () => {
         const val = volumeText.value.match(/-?\d+/)?.[0];
         if(val) setVolume(val, tab);
    });

    monoCheckbox.addEventListener("change", () => toggleMono(tab));
    rememberCheckbox.addEventListener("change", () => toggleRemember(tab));

    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    browserApi.storage.local.get({ siteSettings: {} }, (data) => {
        const saved = data.siteSettings[domain];
        if (saved) {
            rememberCheckbox.checked = true;
            if (saved.volume !== undefined) setVolume(saved.volume, null); 
            if (saved.mono !== undefined) monoCheckbox.checked = saved.mono;
        } else {
            browserApi.tabs.sendMessage(tab.id, { command: "getVolume" }, (response) => {
                if (!browserApi.runtime.lastError && response && response.response !== undefined) {
                    setVolume(response.response, null);
                }
            });
            browserApi.tabs.sendMessage(tab.id, { command: "getMono" }, (response) => {
                if (!browserApi.runtime.lastError && response && response.response !== undefined) {
                    monoCheckbox.checked = response.response;
                }
            });
        }
    });
}