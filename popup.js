const {
  browserApi,
  MIN_DB,
  MAX_DB,
  normalizeDb,
  normalizeSiteSettingsEntryInput,
  formatDb,
  storageGet,
  storageSet,
  tabsQuery,
  tabsSendMessage,
  TOP_FRAME_OPTIONS,
  runtimeSendMessage,
  tabsReload,
  openOptionsPage,
  domainMatchesSaved,
  isUrlRememberedByEntry,
  isUrlBlockedByEntry,
  isUrlBlockedByEntries,
  entriesBlockingUrl,
  getSiteSettingsKey,
  handleError,
  BOOST_LIMIT_NOTE
} = globalThis.VolumeControlShared;
const sharedExtractRootDomain = globalThis.VolumeControlShared.extractRootDomain;
const WHEEL_STEP_DB = 1;  // volume change per wheel notch (matches hotkey step)
let siteSettingsSaveChain = Promise.resolve();
let volumeRequestGeneration = 0;

function mutateSiteSettings(mutation) {
  return runtimeSendMessage({ command: "mutateSiteSettings", mutation });
}

function mutateAccessLists(mutation) {
  return runtimeSendMessage({ command: "mutateAccessLists", mutation });
}

function parseDbText(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!/^[+-]?\d+$/.test(raw)) return null;
  return normalizeDb(Number(raw));
}

const cached = {
  slider: null,
  volumeText: null,
  limitNote: null,
  monoCheckbox: null,
  rememberCheckbox: null,
  enableCheckbox: null,
  muteBtn: null,
  activeTab: null,
  maxDb: MAX_DB,
  boostLimited: false,
  monoAvailable: true
};

function normalizeControlDb(value) {
  return Math.min(normalizeDb(value), cached.maxDb);
}

function extractRootDomain(url) {
    return sharedExtractRootDomain(url, { nullForInvalid: true });
}

// v6.15: build the exclusion overlay's detail line from the SAME storage the
// content script enforces. Returns null when the URL is not excluded, so
// callers can use it as the verdict itself.
function exclusionOverlayDetail(data, tabUrl) {
    if (data.whitelistMode) {
        return "Whitelist mode is active, so only sites in Allowed Sites are controlled. Turn the Active switch on to allow this page, add it in Settings, or turn whitelist mode off.";
    }
    const blocking = entriesBlockingUrl(tabUrl, data.fqdns || []);
    if (!blocking.length) return null;
    const first = blocking[0];
    const extra = blocking.length > 1
        ? ` (and ${blocking.length - 1} more entr${blocking.length === 2 ? "y" : "ies"})`
        : "";
    return `This page matched your blocklist entry "${first}"${extra}. Turn the Active switch on to remove the blocking entries and reload the page, or edit the list in Settings.`;
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

  // Mouse wheel: change volume by WHEEL_STEP_DB per notch while the popup is open.
  // Bound to document so it works anywhere in the popup. Skip when the user is
  // editing the dB text field so wheel-scrolling inside the field doesn't fight
  // with text selection.
  document.addEventListener('wheel', (e) => {
    const tab = cached.activeTab;
    if (!tab) return;
    if (document.activeElement && document.activeElement.id === 'volume-text') return;

    // High-resolution trackpads fire many small wheel events; only treat
    // notches (|deltaY| >= 15) as volume changes to avoid runaway adjustments.
    if (Math.abs(e.deltaY) < 15) return;

    const sliderEl = cached.slider;
    const currentDb = sliderEl ? Number(sliderEl.value) : 0;
    const direction = e.deltaY > 0 ? -1 : 1;
    const nextDb = normalizeDb(currentDb + direction * WHEEL_STEP_DB);
    if (nextDb === currentDb) return;

    e.preventDefault();
    setVolume(nextDb, tab);
  }, { passive: false });

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

    // Frame-targeted exclusion check: only the top frame's content script is
    // authoritative for whether the extension is active on this page. An
    // unframed message would race every iframe's instance.
    // v6.15: this message path is now the SECONDARY check. A blocked content
    // script cannot answer (its listener returns early), and Firefox resolves
    // an unanswered tabs.sendMessage with undefined instead of rejecting —
    // so this rejection-only fallback never fired there and the popup looked
    // fully functional while doing nothing. The primary verdict is computed
    // directly from storage in updateEnableSwitch (same source of truth the
    // content script uses) on every engine; this path only covers a storage
    // read failure in the popup.
    tabsSendMessage(currentTab.id, { command: "checkExclusion" }, TOP_FRAME_OPTIONS).catch(async () => {
        // Content script didn't respond; fall back to storage to decide whether the page is truly excluded.
        try {
            const domain = extractRootDomain(currentTab.url);
            if (!domain) {
                showError({ type: "exclusion" });
                return;
            }
            const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });
            let isExcluded = false;
            let detail = null;
            if (data.whitelistMode) {
                isExcluded = !(data.whitelist || []).some(entry => isUrlRememberedByEntry(currentTab.url, entry));
                if (isExcluded) detail = exclusionOverlayDetail(data, currentTab.url);
            } else {
                detail = exclusionOverlayDetail(data, currentTab.url);
                isExcluded = detail !== null;
            }
            if (isExcluded) showError({ type: "exclusion", detail });
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

        if (data.whitelistMode) {
            const isAllowed = (data.whitelist || []).some(entry => isUrlRememberedByEntry(tab.url, entry));
            if (checkbox) checkbox.checked = isAllowed;
            if (switchLabel) {
                switchLabel.style.display = '';
                switchLabel.title = isAllowed
                    ? "This site is explicitly allowed in whitelist mode."
                    : "This site is not in your whitelist. Turning Active on adds it and reloads the page.";
            }
            if (!isAllowed) showError({ type: "exclusion", detail: exclusionOverlayDetail(data, tab.url) });
            checkbox.onchange = (e) => {
                toggleSitePermission(domain, !e.target.checked, tab.id, tab.url);
            };
            return;
        }

        // Path-aware (issue #69): legacy path entries must not disable the
        // Active switch for the whole domain, and the exclusion state shown
        // here must match what the content script actually enforces.
        let isExcluded = isUrlBlockedByEntries(tab.url, data.fqdns || []);

        if (checkbox) checkbox.checked = !isExcluded;
        if (switchLabel) {
            // Issue #69 UX: explain WHY the site is inactive and what the
            // toggle will do about it (it removes every blocking entry).
            switchLabel.title = isExcluded
                ? "This site is in your blocklist. Turning Active on removes the blocking entries and reloads the page."
                : "";
        }

        // v6.15: blocklisted site/wildcard — tell the user in the overlay
        // message (like the DRM note does for restricted media), naming the
        // entry that matched. Computed from storage directly so it works on
        // every engine (the checkExclusion message cannot be answered by a
        // blocked content script).
        if (isExcluded) {
            showError({ type: "exclusion", detail: exclusionOverlayDetail(data, tab.url) });
        }

        checkbox.onchange = (e) => {
            const isActive = e.target.checked;
            toggleSitePermission(domain, !isActive, tab.id, tab.url);
        };
    } catch (e) {
        handleError(e);
    }
} 

async function toggleSitePermission(domain, shouldExclude, tabId, tabUrl) {
    try {
        const url = tabUrl || domain;
        const result = await mutateAccessLists({
            type: "setSiteActive",
            url,
            entry: domain || url,
            active: !shouldExclude
        });
        if (!result || !result.ok) throw new Error(result && result.reason ? result.reason : "Could not update site access");

        await tabsReload(tabId);
        window.close();
    } catch (e) {
        handleError(e);
    }
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

function applyMonoAvailability(state = {}) {
  const monoCheckbox = cached.monoCheckbox || document.querySelector("#mono-checkbox");
  if (!monoCheckbox) return;

  const available = state.monoAvailable !== false;
  const reason = state.monoUnavailableReason || state.limitationReason || "";
  cached.monoAvailable = available;
  monoCheckbox.disabled = !available;
  monoCheckbox.setAttribute("aria-disabled", String(!available));

  const container = monoCheckbox.closest(".switch-container");
  if (container) {
    container.classList.toggle("is-disabled", !available);
    if (available) {
      container.title = "Toggle Mono Audio (Alt+Shift+M)";
    } else {
      const message = reason === "restricted"
        ? "Mono unavailable while DRM/restricted media is using fallback audio."
        : reason === "cross-origin"
          ? "Mono unavailable while cross-origin media is using fallback audio."
          : reason === "route-failed"
            ? "Mono unavailable because the WebAudio route could not be created."
            : reason === "native-route"
              ? "Mono unavailable while HTML Media Route Override is Force native volume fallback."
              : "Mono unavailable while WebAudio processing is unavailable.";
      container.title = message;
    }
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

  applyMonoAvailability(state);

  // Keep the mute button in sync with the content script's actual state.
  // This matters when a setVolume response carries a muted flag that was
  // changed elsewhere (e.g. via the hotkey while the popup was open).
  if (state.muted !== undefined) applyMuteButtonState(state.muted);
}

async function refreshAudioControlState(tab) {
    if (!tab || tab.id === undefined) return null;

    // Ask ONLY the top frame (frameId 0). The top frame owns the page's media
    // elements and therefore the boost-limit/DRM verdict. An unframed query is
    // answered by whichever frame responds first — on pages that embed iframes
    // (captcha, payment, ads), those frames' content scripts answer with their
    // own unrestricted state, making the DRM/boost-limit note flicker in and
    // out while the volume slider is dragged.
    const response = await tabsSendMessage(tab.id, { command: "getAudioControlState" }, TOP_FRAME_OPTIONS).catch(handleError);
    const state = response && response.response ? response.response : null;

    if (state) {
        applyAudioControlState(state);
        if (state.volume !== undefined) setDisplayedVolume(state.volume);
        if (state.mono !== undefined && cached.monoCheckbox) cached.monoCheckbox.checked = Boolean(state.mono);
        if (state.muted !== undefined) applyMuteButtonState(state.muted);
    }

    return state;
}

async function pollAudioControlState(tab) {
    if (!tab || tab.id === undefined) return null;
    const response = await tabsSendMessage(tab.id, { command: "getAudioControlState" }, TOP_FRAME_OPTIONS).catch(() => null);
    const state = response && response.response ? response.response : null;
    if (!state) return null;
    // Refresh ONLY the verdict-driven UI (note, slider range, mono/mute state).
    // Deliberately NOT the slider value: while the user is dragging, the last
    // committed value lags the thumb by up to the 40ms debounce, and a poll
    // response landing mid-drag would snap the thumb back (stale-flash).
    applyAudioControlState(state);
    if (state.mono !== undefined && cached.monoCheckbox) cached.monoCheckbox.checked = Boolean(state.mono);
    if (state.muted !== undefined) applyMuteButtonState(state.muted);
    return state;
}

async function saveSiteSettingsNow(tab) {
    try {
        const rememberCheckbox = document.getElementById("remember-checkbox");
        if (!rememberCheckbox || !rememberCheckbox.checked || !tab || !tab.url) return;

        const defaultSettingsKey = normalizeSiteSettingsEntryInput(tab.url);
        if (!defaultSettingsKey) return;

        const volumeSlider = cached.slider || document.getElementById("volume-slider");
        const monoCheckbox = cached.monoCheckbox || document.getElementById("mono-checkbox");
        const muteBtn = cached.muteBtn || document.getElementById("mute-btn");

        const patch = {
            volume: normalizeControlDb(volumeSlider?.value),
            mono: Boolean(monoCheckbox?.checked),
            muted: Boolean(muteBtn && muteBtn.classList.contains("muted"))
        };
        await mutateSiteSettings({
            type: "mergeForUrl",
            url: tab.url,
            defaultKey: defaultSettingsKey,
            patch
        });

        if (tab && tab.id) {
            try {
                tabsSendMessage(tab.id, { command: "setVolume", dB: patch.volume }).catch(() => {});
                tabsSendMessage(tab.id, { command: "setMono", mono: patch.mono }).catch(() => {});
                tabsSendMessage(tab.id, { command: "setMute", muted: patch.muted }).catch(() => {});
            } catch (e) {
                // ignore messaging errors
            }
        }
    } catch (e) {
        handleError(e);
    }
}

function saveSiteSettings(tab) {
    const run = () => saveSiteSettingsNow(tab);
    siteSettingsSaveChain = siteSettingsSaveChain.then(run, run);
    return siteSettingsSaveChain;
}

async function setVolume(dB, tab, options = {}) {
  const requestGeneration = ++volumeRequestGeneration;
  let normalizedDb = setDisplayedVolume(dB);

  if (tab) {
      // Broadcast the new volume to EVERY frame in the tab so media living in
      // embedded iframes (embedded players, ads with audio) is controlled too.
      // The broadcast response is a race (first frame to respond wins) and is
      // deliberately ignored.
      await tabsSendMessage(tab.id, {
          command: "setVolume",
          dB: normalizedDb
      }).catch(handleError);

      // Authoritative state: query the TOP FRAME only. Its response carries
      // the verdict-clamped volume and the real boost-limit/DRM status, so the
      // UI cannot flip between frames' answers as the slider moves.
      const response = await tabsSendMessage(tab.id, {
          command: "getAudioControlState"
      }, TOP_FRAME_OPTIONS).catch(handleError);

      // A newer slider/text request has already been issued. The newer message
      // is authoritative; do not let this older response snap the UI backward,
      // overwrite its remembered value, or repaint the badge.
      if (requestGeneration !== volumeRequestGeneration) return;

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
  if (tab && monoCheckbox && !monoCheckbox.disabled && cached.monoAvailable) {
      tabsSendMessage(tab.id, { command: "setMono", mono: monoCheckbox.checked }).catch(handleError);
      await saveSiteSettings(tab);
  }
}

async function toggleMute(tab, muted) {
  if (!tab) return;
  applyMuteButtonState(muted);
  // Broadcast the mute toggle to every frame (embedded players must mute too);
  // the racy first response is ignored.
  await tabsSendMessage(tab.id, { command: "setMute", muted }).catch(handleError);
  // Authoritative state (and the volume for the badge feedback) comes from the
  // top frame only — see refreshAudioControlState.
  const state = await refreshAudioControlState(tab);
  const dB = state && state.volume !== undefined
      ? Number(state.volume)
      : (Number(cached.slider && cached.slider.value) || 0);
  // Update the browser-action badge immediately so the icon reflects mute state.
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
        const defaultSettingsKey = normalizeSiteSettingsEntryInput(tab.url);
        if (!defaultSettingsKey) return;

        if (rememberCheckbox && rememberCheckbox.checked) {
            await saveSiteSettings(tab);
        } else {
            await mutateSiteSettings({ type: "removeForUrl", url: tab.url });
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
        // v6.15: informative overlay (mirroring the DRM note's role/status
        // pattern) — say WHY the site is disabled: the matched blocklist
        // entry (site or path/wildcard), or whitelist mode. Falls back to a
        // generic line when the verdict came without storage data.
        const detail = exclusionMessage.querySelector(".exclusion-detail");
        if (detail) {
            detail.textContent = error.detail || "This site is excluded by your blocklist, or it is not in Allowed Sites while whitelist mode is active.";
        }
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
    cached.activeTab = tab;

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
            const parsed = parseDbText(volumeText.value);
            if (parsed === null) return;
            if (textCommitTimer) clearTimeout(textCommitTimer);
            textCommitTimer = setTimeout(() => {
                textCommitTimer = null;
                setVolume(parsed, tab);
            }, 300);
       });
      // Commit immediately on Enter so the user does not have to wait
      // for the debounce, and reformat the field on blur.
      volumeText.addEventListener("change", () => {
           if (textCommitTimer) { clearTimeout(textCommitTimer); textCommitTimer = null; }
           const parsed = parseDbText(volumeText.value);
            if (parsed !== null) setVolume(parsed, tab);
      });
      // Suppress the global keydown-to-slider-focus handler while the user
      // is editing the dB field so arrow keys edit the number, not the slider.
      volumeText.addEventListener("keydown", (e) => e.stopPropagation());
    }

    if (monoCheckbox) monoCheckbox.addEventListener("change", () => toggleMono(tab));
    if (rememberCheckbox) rememberCheckbox.addEventListener("change", () => toggleRemember(tab));

    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    // Keep the boost-limit verdict live while the popup is open: media can
    // become DRM-restricted/cross-origin at any moment (license handshake
    // completing after playback started, cross-origin src appearing), and a
    // stale unrestricted UI would advertise a +32 dB range that cannot be
    // boosted. The popup document is destroyed on close, tearing the timer
    // down with it.
    setInterval(() => {
        pollAudioControlState(tab).catch(() => {});
    }, 1000);

    try {
        const audioState = await refreshAudioControlState(tab);
        const data = await storageGet({ siteSettings: {} });
        const settingsKey = getSiteSettingsKey(data.siteSettings || {}, tab.url);
        const saved = settingsKey ? data.siteSettings[settingsKey] : null;
        if (saved) {
            if (rememberCheckbox) rememberCheckbox.checked = true;
            if (saved.mono !== undefined && monoCheckbox) monoCheckbox.checked = saved.mono;
            if (saved.muted !== undefined) applyMuteButtonState(saved.muted);
            if (saved.volume !== undefined) await setVolume(saved.volume, tab, { showFeedback: false });
            tabsSendMessage(tab.id, { command: "setMono", mono: Boolean(saved.mono) }).catch(handleError);
            tabsSendMessage(tab.id, { command: "setMute", muted: Boolean(saved.muted) }).catch(handleError);
        } else if (!audioState) {
            tabsSendMessage(tab.id, { command: "getVolume" }, TOP_FRAME_OPTIONS).then((response) => {
                if (response && response.response !== undefined) setVolume(response.response, null);
            }).catch(handleError);
            tabsSendMessage(tab.id, { command: "getMono" }, TOP_FRAME_OPTIONS).then((response) => {
                if (response && response.response !== undefined && monoCheckbox) {
                    monoCheckbox.checked = response.response;
                }
            }).catch(handleError);
            tabsSendMessage(tab.id, { command: "getMute" }, TOP_FRAME_OPTIONS).then((response) => {
                if (response && response.response !== undefined) applyMuteButtonState(response.response);
            }).catch(handleError);
        }
    } catch (e) {
        handleError(e);
    }
}
