const {
  browserApi,
  MIN_DB,
  MAX_DB,
  normalizeDb,
  formatDb,
  storageGet,
  storageSet,
  tabsQuery,
  tabsSendMessage,
  runtimeSendMessage,
  tabsReload,
  openOptionsPage,
  domainMatchesSaved,
  getSiteSettingsKey,
  isHarmlessMessageError
} = globalThis.VolumeControlShared;
const sharedExtractRootDomain = globalThis.VolumeControlShared.extractRootDomain;
const BOOST_LIMIT_NOTE = "Boosting and mono may be unavailable on this media because the browser only allows fallback volume control. You can still lower volume.";
const cached = {
  slider: null,
  volumeText: null,
  limitNote: null,
  monoCheckbox: null,
  rememberCheckbox: null,
  enableCheckbox: null,
  muteBtn: null,
  maxDb: MAX_DB,
  boostLimited: false
};

function normalizeControlDb(value) {
  return Math.min(normalizeDb(value), cached.maxDb);
}

function extractRootDomain(url) {
    return sharedExtractRootDomain(url, { nullForInvalid: true });
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
  if (isHarmlessMessageError(error)) return;
  const msg = error.message || error;
  console.error(`Volume Control: Error: ${msg}`);
}

function setDisplayedVolume(dB) {
  const normalizedDb = normalizeControlDb(dB);
  const slider = cached.slider || document.querySelector("#volume-slider");
  const text = cached.volumeText || document.querySelector("#volume-text");

  if (slider) slider.value = String(normalizedDb);
  if (text) text.value = (normalizedDb >= 0 ? "+" : "") + normalizedDb;

  return normalizedDb;
}

function applyMuteButtonState(muted) {
  const btn = cached.muteBtn || document.querySelector("#mute-btn");
  if (!btn) return;
  const isMuted = Boolean(muted);
  btn.classList.toggle("muted", isMuted);
  btn.setAttribute("aria-pressed", String(isMuted));
  const label = btn.querySelector(".mute-label");
  if (label) label.textContent = isMuted ? "Unmute" : "Mute";
  btn.title = isMuted ? "Unmute" : "Mute";

  // Reflect muted state on the slider + popup container so users see why
  // dragging the slider does not change audible volume.
  const popupContent = document.querySelector("#popup-content");
  if (popupContent) popupContent.classList.toggle("is-muted", isMuted);
  const slider = cached.slider || document.querySelector("#volume-slider");
  if (slider) {
    slider.title = isMuted ? "Volume (muted) - click Unmute to hear audio" : "Alt+Shift+Up / Alt+Shift+Down / Alt+Shift+0";
  }
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

  // Keep the mute button in sync with the content script's actual state.
  // This matters when a setVolume response carries a muted flag that was
  // changed elsewhere (e.g. via the hotkey while the popup was open).
  if (state.muted !== undefined) applyMuteButtonState(state.muted);
}

async function refreshAudioControlState(tab) {
    if (!tab || tab.id === undefined) return null;

    const response = await tabsSendMessage(tab.id, { command: "getAudioControlState" }).catch(handleError);
    const state = response && response.response ? response.response : null;

    if (state) {
        applyAudioControlState(state);
        if (state.volume !== undefined) setDisplayedVolume(state.volume);
        if (state.mono !== undefined && cached.monoCheckbox) cached.monoCheckbox.checked = Boolean(state.mono);
        if (state.muted !== undefined) applyMuteButtonState(state.muted);
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
        const muteBtn = cached.muteBtn || document.getElementById("mute-btn");

        const data = await storageGet({ siteSettings: {} });
        data.siteSettings = data.siteSettings || {};
        const settingsKey = getSiteSettingsKey(data.siteSettings, domain) || domain;
        data.siteSettings[settingsKey] = {
            volume: normalizeControlDb(volumeSlider?.value),
            mono: Boolean(monoCheckbox?.checked),
            muted: Boolean(muteBtn && muteBtn.classList.contains("muted"))
        };
        await storageSet({ siteSettings: data.siteSettings });

        // Notify the content script in this tab immediately so volume/mono/mute are applied without waiting
        if (tab && tab.id) {
            try {
                tabsSendMessage(tab.id, { command: "setVolume", dB: data.siteSettings[settingsKey].volume }).catch(() => {
                    // It's possible the content script hasn't injected into the page yet; ignore harmless errors.
                });
                tabsSendMessage(tab.id, { command: "setMono", mono: Boolean(data.siteSettings[settingsKey].mono) }).catch(() => {});
                tabsSendMessage(tab.id, { command: "setMute", muted: Boolean(data.siteSettings[settingsKey].muted) }).catch(() => {});
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
          const muted = (response && response.response && response.response.muted !== undefined)
              ? Boolean(response.response.muted)
              : Boolean(cached.muteBtn && cached.muteBtn.classList.contains("muted"));
          runtimeSendMessage({
              command: "showNativeVolumeFeedback",
              tabId: tab.id,
              dB: normalizedDb,
              muted
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

async function toggleMute(tab, muted) {
  if (!tab) return;
  applyMuteButtonState(muted);
  const response = await tabsSendMessage(tab.id, { command: "setMute", muted }).catch(handleError);
  // Update the browser-action badge immediately so the icon reflects mute state.
  const dB = Number(cached.slider && cached.slider.value) || 0;
  runtimeSendMessage({
      command: "showNativeVolumeFeedback",
      tabId: tab.id,
      dB,
      muted
  }).catch(() => {});
  await saveSiteSettings(tab);
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
  const settingsBtn = document.querySelector("#settings");
  
  if (popupContent) popupContent.classList.add("hidden");
  if (errorContent) errorContent.classList.add("hidden");
  if (exclusionMessage) exclusionMessage.classList.add("hidden");

  if (error.type === "exclusion") {
    if (popupContent) popupContent.classList.remove("hidden");
    if (exclusionMessage) {
        exclusionMessage.classList.remove("hidden");
        // Make the exclusion message a live region so screen readers announce it,
        // and make it focusable so we can move focus to it.
        exclusionMessage.setAttribute("role", "alert");
        exclusionMessage.setAttribute("tabindex", "-1");
    }
    
    const top = document.querySelector(".top-controls");
    const left = document.querySelector(".left");
    if(top) top.classList.add("hidden");
    if(left) left.classList.add("hidden"); 
    document.body.classList.add("excluded-site");
    
    // Move focus to the settings button (still visible) so keyboard users have
    // an actionable element. Fall back to the exclusion message if the button
    // is hidden.
    if (settingsBtn && settingsBtn.offsetParent !== null) {
        settingsBtn.focus();
    } else if (exclusionMessage) {
        exclusionMessage.focus();
    }
  } else {
    if (errorContent) {
        errorContent.classList.remove("hidden");
        const errorParagraph = errorContent.querySelector("p");
        if (errorParagraph) {
            errorParagraph.textContent = error.message || "An error occurred";
            // Announce the error to assistive technology.
            errorParagraph.setAttribute("role", "alert");
            errorParagraph.setAttribute("tabindex", "-1");
            errorParagraph.focus();
        }
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

    const muteBtn = document.querySelector("#mute-btn");
    cached.muteBtn = muteBtn;
    if (muteBtn) {
        muteBtn.addEventListener("click", () => {
            const nextMuted = !muteBtn.classList.contains("muted");
            toggleMute(tab, nextMuted);
        });
    }

    applyAudioControlState({ maxDb: MAX_DB, boostLimited: false, limitation: "" });

    if (volumeSlider) {
      // Debounce the storage write and background feedback so rapid slider
      // dragging doesn't flood the content script with messages and trigger
      // excessive storage.local.set calls. The UI updates immediately; only
      // the downstream side effects are debounced.
      let volumeCommitTimer = null;
      let lastCommittedDb = null;
      const commitVolume = (dB) => {
          if (volumeCommitTimer) clearTimeout(volumeCommitTimer);
          lastCommittedDb = dB;
          volumeCommitTimer = setTimeout(() => {
              volumeCommitTimer = null;
              setVolume(lastCommittedDb, tab);
          }, 40);
      };
      volumeSlider.addEventListener("input", () => {
          const normalizedDb = setDisplayedVolume(volumeSlider.value);
          commitVolume(normalizedDb);
      });
      // Commit immediately when the user releases the slider.
      volumeSlider.addEventListener("change", () => {
          if (volumeCommitTimer) {
              clearTimeout(volumeCommitTimer);
              volumeCommitTimer = null;
          }
          setVolume(setDisplayedVolume(volumeSlider.value), tab);
      });
    }
    
    if (volumeText) {
      // Debounced live update as the user types -- no Enter required.
      // The debounce lets the user finish typing multi-digit values
      // (e.g. "-15") before we commit, avoiding partial-number jumps.
      let textCommitTimer = null;
      volumeText.addEventListener("input", () => {
           const val = volumeText.value.match(/-?\d+/)?.[0];
           if (val === undefined) return;          // ignore "-", "+", "", etc.
           if (textCommitTimer) clearTimeout(textCommitTimer);
           const parsed = Number(val);
           textCommitTimer = setTimeout(() => {
               textCommitTimer = null;
               setVolume(normalizeDb(parsed), tab);
           }, 300);
      });
      // Commit immediately on Enter so the user does not have to wait
      // for the debounce, and reformat the field on blur.
      volumeText.addEventListener("change", () => {
           if (textCommitTimer) { clearTimeout(textCommitTimer); textCommitTimer = null; }
           const val = volumeText.value.match(/-?\d+/)?.[0];
           if (val) setVolume(normalizeDb(val), tab);
      });
      // Suppress the global keydown-to-slider-focus handler while the user
      // is editing the dB field so arrow keys edit the number, not the slider.
      volumeText.addEventListener("keydown", (e) => e.stopPropagation());
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
            if (saved.muted !== undefined) applyMuteButtonState(saved.muted);
            if (saved.volume !== undefined) await setVolume(saved.volume, tab, { showFeedback: false });
            tabsSendMessage(tab.id, { command: "setMono", mono: Boolean(saved.mono) }).catch(handleError);
            tabsSendMessage(tab.id, { command: "setMute", muted: Boolean(saved.muted) }).catch(handleError);
        } else if (!audioState) {
            tabsSendMessage(tab.id, { command: "getVolume" }).then((response) => {
                if (response && response.response !== undefined) setVolume(response.response, null);
            }).catch(handleError);
            tabsSendMessage(tab.id, { command: "getMono" }).then((response) => {
                if (response && response.response !== undefined && monoCheckbox) {
                    monoCheckbox.checked = response.response;
                }
            }).catch(handleError);
            tabsSendMessage(tab.id, { command: "getMute" }).then((response) => {
                if (response && response.response !== undefined) applyMuteButtonState(response.response);
            }).catch(handleError);
        }
    } catch (e) {
        handleError(e);
    }
}
