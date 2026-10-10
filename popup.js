const {
  browserApi,
  MIN_DB,
  MAX_DB,
  normalizeDb,
  normalizeSiteSettingsEntryInput,
  formatDb,
  callApi,
  storageGet,
  storageSet,
  tabsQuery,
  tabsGet,
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
let volumeDeliveryChain = Promise.resolve();
let normalizerRequestGeneration = 0;

function mutateSiteSettings(mutation) {
  return runtimeSendMessage({ command: "mutateSiteSettings", mutation });
}

function mutateSiteNormalizerSettings(mutation) {
  return runtimeSendMessage({ command: "mutateSiteNormalizerSettings", mutation });
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
  normalizerCheckbox: null,
  normalizerGain: null,
  peakMeter: null,
  peakMeterFill: null,
  peakMeterText: null,
  normalizerNote: null,
  enableCheckbox: null,
  muteBtn: null,
  activeTab: null,
  maxDb: MAX_DB,
  boostLimited: false,
  monoAvailable: true,
  normalizerAvailable: true,
  normalizerPending: false,
  shortcuts: {}
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
  // Focusing on Android summons the soft keyboard and can obscure the
  // extension overlay. Desktop keeps its keyboard-first behavior.
  const isAndroid = /Android/i.test(navigator.userAgent);
  if (slider && !isAndroid) {
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

  if (!isAndroid) {
    document.addEventListener('keydown', () => {
      if (slider && document.activeElement !== slider) {
        slider.focus();
      }
    }, { once: true });
  }

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

  refreshShortcutHints().catch(() => {});
  listenForEvents();
});

async function listenForEvents() {
  try {
    let tabs = await tabsQuery({ active: true, currentWindow: true });
    // On some Android builds the action UI has its own browsing context.
    // Fall back to the most recently focused browser window, not an extension tab.
    if (!tabs?.[0]?.url || /^(moz-extension|about):/.test(tabs[0].url)) {
      const fallback = await tabsQuery({ active: true, lastFocusedWindow: true });
      if (fallback?.[0]?.url && !/^(moz-extension|about):/.test(fallback[0].url)) tabs = fallback;
    }
    handleTabs(tabs);
  } catch (error) {
    handleError(error);
  }
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
            const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, whitelistSeparatedV1: false, siteSettings: {} });
            let isExcluded = false;
            let detail = null;
            if (data.whitelistMode) {
                const explicitAllowed = (data.whitelist || []).some(entry => isUrlRememberedByEntry(currentTab.url, entry));
                const legacyAllowed = !data.whitelistSeparatedV1 && Boolean(getSiteSettingsKey(data.siteSettings || {}, currentTab.url));
                isExcluded = !(explicitAllowed || legacyAllowed);
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
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, whitelistSeparatedV1: false, siteSettings: {} });

        if (data.whitelistMode) {
            const explicitAllowed = (data.whitelist || []).some(entry => isUrlRememberedByEntry(tab.url, entry));
            const legacyAllowed = !data.whitelistSeparatedV1 && Boolean(getSiteSettingsKey(data.siteSettings || {}, tab.url));
            const isAllowed = explicitAllowed || legacyAllowed;
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

function shortcutToAria(shortcut) {
  return String(shortcut || '')
    .replace(/\bUp\b/g, 'ArrowUp')
    .replace(/\bDown\b/g, 'ArrowDown')
    .replace(/\bLeft\b/g, 'ArrowLeft')
    .replace(/\bRight\b/g, 'ArrowRight');
}

function applyShortcutHintsToControls() {
  const shortcuts = cached.shortcuts || {};
  const slider = cached.slider || document.querySelector("#volume-slider");
  const monoCheckbox = cached.monoCheckbox || document.querySelector("#mono-checkbox");
  const muteBtn = cached.muteBtn || document.querySelector("#mute-btn");
  const monoContainer = monoCheckbox ? monoCheckbox.closest(".switch-container") : null;
  const muted = muteBtn && muteBtn.getAttribute("aria-pressed") === "true";

  const volumeCombos = [
    shortcuts["volume-up"],
    shortcuts["volume-down"],
    shortcuts["volume-reset"]
  ].filter(Boolean);

  if (slider) {
    slider.title = muted
      ? "Volume (muted) - click Unmute to hear audio"
      : (volumeCombos.length ? `Volume shortcuts: ${volumeCombos.join(" / ")}` : "Volume control");
    const aria = volumeCombos.map(shortcutToAria).filter(Boolean).join(" ");
    if (aria) slider.setAttribute("aria-keyshortcuts", aria);
    else slider.removeAttribute("aria-keyshortcuts");
  }

  const monoShortcut = shortcuts["toggle-mono"] || "";
  if (monoCheckbox) {
    if (monoShortcut) monoCheckbox.setAttribute("aria-keyshortcuts", shortcutToAria(monoShortcut));
    else monoCheckbox.removeAttribute("aria-keyshortcuts");
  }
  if (monoContainer && !monoCheckbox.disabled) {
    monoContainer.title = monoShortcut ? `Toggle Mono Audio (${monoShortcut})` : "Toggle Mono Audio";
  }

  if (muteBtn) {
    const muteShortcut = shortcuts["toggle-mute"] || "";
    const action = muted ? "Unmute" : "Mute";
    muteBtn.title = muteShortcut ? `${action} (${muteShortcut})` : action;
    if (muteShortcut) muteBtn.setAttribute("aria-keyshortcuts", shortcutToAria(muteShortcut));
    else muteBtn.removeAttribute("aria-keyshortcuts");
  }
}

async function refreshShortcutHints() {
  if (!browserApi || !browserApi.commands || typeof browserApi.commands.getAll !== "function") return;
  try {
    const commands = await callApi(browserApi.commands.getAll.bind(browserApi.commands), []);
    cached.shortcuts = Object.fromEntries(
      (commands || []).filter(cmd => cmd && cmd.name).map(cmd => [cmd.name, cmd.shortcut || ""])
    );
    applyShortcutHintsToControls();
  } catch (e) {
    console.debug("Popup: commands.getAll failed", e);
  }
}

function applyMuteButtonState(muted) {
  const btn = cached.muteBtn || document.querySelector("#mute-btn");
  if (!btn) return;
  const isMuted = Boolean(muted);
  btn.classList.toggle("muted", isMuted);
  btn.setAttribute("aria-pressed", String(isMuted));
  const label = btn.querySelector(".mute-label");
  if (label) label.textContent = isMuted ? "Unmute" : "Mute";
  // Reflect muted state on the slider + popup container so users see why
  // dragging the slider does not change audible volume.
  const popupContent = document.querySelector("#popup-content");
  if (popupContent) popupContent.classList.toggle("is-muted", isMuted);
  applyShortcutHintsToControls();
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
      applyShortcutHintsToControls();
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


function formatMeterDb(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= -90) return "−∞ dBFS";
  return `${n.toFixed(1)} dBFS`;
}

function applyNormalizerState(state = {}) {
  const checkbox = cached.normalizerCheckbox || document.querySelector("#normalizer-checkbox");
  const gainEl = cached.normalizerGain || document.querySelector("#normalizer-gain");
  const meter = cached.peakMeter || document.querySelector(".peak-meter");
  const fill = cached.peakMeterFill || document.querySelector("#peak-meter-fill");
  const text = cached.peakMeterText || document.querySelector("#peak-meter-text");
  const note = cached.normalizerNote || document.querySelector("#normalizer-note");
  const panel = checkbox ? checkbox.closest(".normalizer-panel") : null;

  if (state.normalizerEnabled !== undefined && checkbox && !cached.normalizerPending) {
    checkbox.checked = Boolean(state.normalizerEnabled);
  }
  const details = document.getElementById("normalizer-details");
  if (details) details.hidden = !(checkbox && checkbox.checked);

  if (state.normalizerAvailable !== undefined) {
    cached.normalizerAvailable = state.normalizerAvailable !== false;
  }
  const available = cached.normalizerAvailable;
  if (checkbox) {
    // Keep the switch available even when this media cannot be processed.
    checkbox.disabled = false;
    checkbox.setAttribute("aria-disabled", "false");
  }
  if (panel) panel.classList.toggle("is-unavailable", !available);
  if (note) {
    const reason = state.normalizerUnavailableReason || state.limitationReason || "";
    note.textContent = reason === "restricted"
      ? "Normalization is unavailable for this DRM/restricted media in the current browser."
      : reason === "cross-origin"
        ? "Normalization is unavailable because this media cannot be safely routed through WebAudio."
        : reason === "native-route"
          ? "Normalization is unavailable while HTML Media Route Override is set to Force native."
          : "Normalization needs the WebAudio route and is unavailable on this media.";
    note.classList.toggle("hidden", available);
  }

  // Chrome runtime messages may JSON-serialize -Infinity as null.
  // Null means silence / unknown, not a full-scale 0 dBFS peak.
  const peakDb = typeof state.peakDb === "number" && Number.isFinite(state.peakDb)
    ? state.peakDb : -Infinity;
  const clampedPeak = Number.isFinite(peakDb) ? Math.max(-60, Math.min(0, peakDb)) : -60;
  const percent = ((clampedPeak + 60) / 60) * 100;
  if (fill) fill.style.width = `${percent.toFixed(2)}%`;
  if (text) text.textContent = formatMeterDb(peakDb);
  if (meter) {
    meter.setAttribute("aria-valuenow", String(clampedPeak.toFixed(1)));
    meter.setAttribute("aria-valuetext", formatMeterDb(peakDb));
  }

  const gainDb = Number(state.normalizerGainDb);
  if (gainEl) {
    const shown = Number.isFinite(gainDb) ? gainDb : 0;
    gainEl.textContent = `Gain ${shown >= 0 ? "+" : ""}${shown.toFixed(1)} dB`;
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
  applyNormalizerState(state);

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


async function pollMeterState(tab) {
    if (!tab || tab.id === undefined || !cached.normalizerCheckbox?.checked) return null;
    const response = await tabsSendMessage(tab.id, { command: "getMeterState" }, TOP_FRAME_OPTIONS).catch(() => null);
    const state = response && response.response ? response.response : null;
    if (state) applyNormalizerState(state);
    return state;
}

async function currentTabUrl(tab) {
    // A long-lived popup can outlast a same-tab SPA or playlist navigation.
    // Storage changes must apply to the URL currently open, not the snapshot
    // passed to initializeControls when the popup first appeared.
    if (!tab || !Number.isInteger(tab.id)) return null;
    try {
        const current = await tabsGet(tab.id);
        return current && typeof current.url === "string" ? current.url : null;
    } catch (e) {
        return null;
    }
}

async function saveSiteSettingsNow(tab) {
    try {
        const rememberCheckbox = document.getElementById("remember-checkbox");
        if (!rememberCheckbox || !rememberCheckbox.checked || !tab) return;
        const url = await currentTabUrl(tab);
        if (!url) return;

        const defaultSettingsKey = normalizeSiteSettingsEntryInput(url);
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
            url,
            defaultKey: defaultSettingsKey,
            patch
        });
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
  const requestedDb = setDisplayedVolume(dB);
  if (!tab) return;

  // Serialize deliveries, not just UI responses. Otherwise a slow first
  // tabs.sendMessage can apply *after* a newer slider movement and leave
  // the real media volume older than the value visible in the popup.
  const deliver = async () => {
      // Drop obsolete requests that have not started delivery yet.
      if (requestGeneration !== volumeRequestGeneration) return;
      let normalizedDb = requestedDb;

      // Apply to all frames, but use only the top frame's state for verdicts.
      await tabsSendMessage(tab.id, {
          command: "setVolume",
          dB: normalizedDb
      }).catch(handleError);

      // A more recent request will be delivered after this one; do not
      // persist or display this now-obsolete response.
      if (requestGeneration !== volumeRequestGeneration) return;

      const response = await tabsSendMessage(tab.id, {
          command: "getAudioControlState"
      }, TOP_FRAME_OPTIONS).catch(handleError);
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
  };

  const next = volumeDeliveryChain.then(deliver, deliver);
  // Keep the chain usable even if a downstream API unexpectedly rejects.
  volumeDeliveryChain = next.catch(() => {});
  return next;
}

async function toggleMono(tab) {
  const monoCheckbox = cached.monoCheckbox || document.querySelector("#mono-checkbox");
  if (tab && monoCheckbox && !monoCheckbox.disabled && cached.monoAvailable) {
      await tabsSendMessage(tab.id, { command: "setMono", mono: monoCheckbox.checked }).catch(handleError);
      await saveSiteSettings(tab);
  }
}


async function toggleNormalizer(tab) {
  const checkbox = cached.normalizerCheckbox || document.querySelector("#normalizer-checkbox");
  // Availability describes the *current audio route*, not whether a site
  // preference can be saved. Let users switch normalization off or pre-enable
  // it even when the current player is restricted or still loading.
  if (!tab || !checkbox || checkbox.disabled) return;

  const enabled = Boolean(checkbox.checked);
  const requestGeneration = ++normalizerRequestGeneration;
  cached.normalizerPending = true;
  applyNormalizerState({ normalizerEnabled: enabled });
  try {
    const url = await currentTabUrl(tab);
    const defaultKey = normalizeSiteSettingsEntryInput(url);
    if (!defaultKey) throw new Error("Cannot save a normalization preference for this URL");
    // Save before messaging the tab: a still-loading or restricted page may
    // not have a content-script receiver, but its saved preference is valid.
    const result = await mutateSiteNormalizerSettings({
      type: "setForUrl",
      url,
      defaultKey,
      enabled
    });
    if (!result?.ok) throw new Error(result?.reason || "Could not save normalization setting");
    // Persistence broadcasts storage.onChanged to every frame. The targeted
    // message merely accelerates the active top frame and is best-effort.
    await tabsSendMessage(tab.id, { command: "setNormalizer", enabled }, TOP_FRAME_OPTIONS).catch(() => {});
  } catch (error) {
    if (requestGeneration === normalizerRequestGeneration) {
      cached.normalizerPending = false;
      applyNormalizerState({ normalizerEnabled: !enabled });
      handleError(error);
    }
    return;
  }
  if (requestGeneration === normalizerRequestGeneration) {
    cached.normalizerPending = false;
    await refreshAudioControlState(tab);
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
        const url = await currentTabUrl(tab);
        const defaultSettingsKey = normalizeSiteSettingsEntryInput(url);
        if (!defaultSettingsKey) return;

        if (rememberCheckbox && rememberCheckbox.checked) {
            await saveSiteSettings(tab);
        } else {
            await mutateSiteSettings({ type: "removeForUrl", url });
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
    const normalizerCheckbox = document.querySelector("#normalizer-checkbox");

    cached.slider = volumeSlider;
    cached.volumeText = volumeText;
    cached.limitNote = limitNote;
    cached.monoCheckbox = monoCheckbox;
    cached.rememberCheckbox = rememberCheckbox;
    cached.normalizerCheckbox = normalizerCheckbox;
    cached.normalizerGain = document.querySelector("#normalizer-gain");
    cached.peakMeter = document.querySelector(".peak-meter");
    cached.peakMeterFill = document.querySelector("#peak-meter-fill");
    cached.peakMeterText = document.querySelector("#peak-meter-text");
    cached.normalizerNote = document.querySelector("#normalizer-note");

    const muteBtn = document.querySelector("#mute-btn");
    cached.muteBtn = muteBtn;
    if (muteBtn) {
        muteBtn.addEventListener("click", () => {
            const nextMuted = !muteBtn.classList.contains("muted");
            toggleMute(tab, nextMuted);
        });
    }

    applyAudioControlState({ maxDb: MAX_DB, boostLimited: false, limitation: "" });

    // Pending edits from the other control must never arrive later and undo
    // the user's most recent slider/text adjustment.
    let volumeCommitTimer = null;
    let textCommitTimer = null;
    const cancelPendingVolumeCommit = () => {
        if (volumeCommitTimer !== null) clearTimeout(volumeCommitTimer);
        volumeCommitTimer = null;
    };
    const cancelPendingTextCommit = () => {
        if (textCommitTimer !== null) clearTimeout(textCommitTimer);
        textCommitTimer = null;
    };

    if (volumeSlider) {
      // Debounce the storage write and background feedback so rapid slider
      // dragging doesn't flood the content script with messages and trigger
      // excessive storage.local.set calls. The UI updates immediately; only
      // the downstream side effects are debounced.
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
          cancelPendingTextCommit();
          const normalizedDb = setDisplayedVolume(volumeSlider.value);
          commitVolume(normalizedDb);
      });
      // Commit immediately when the user releases the slider.
      volumeSlider.addEventListener("change", () => {
          cancelPendingTextCommit();
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
      volumeText.addEventListener("input", () => {
            cancelPendingVolumeCommit();
            // Even an invalid/empty edit cancels an earlier valid pending
            // text value; otherwise clearing "-12" still commits -12 later.
            cancelPendingTextCommit();
            const parsed = parseDbText(volumeText.value);
            if (parsed === null) return;
            textCommitTimer = setTimeout(() => {
                textCommitTimer = null;
                setVolume(parsed, tab);
            }, 300);
       });
      // Commit immediately on Enter so the user does not have to wait
      // for the debounce, and reformat the field on blur.
      volumeText.addEventListener("change", () => {
           cancelPendingVolumeCommit();
           if (textCommitTimer) { clearTimeout(textCommitTimer); textCommitTimer = null; }
           const parsed = parseDbText(volumeText.value);
            if (parsed !== null) setVolume(parsed, tab);
      });
      // Suppress the global keydown-to-slider-focus handler while the user
      // is editing the dB field so arrow keys edit the number, not the slider.
      volumeText.addEventListener("keydown", (e) => e.stopPropagation());
    }

    if (monoCheckbox) monoCheckbox.addEventListener("change", () => toggleMono(tab));
    if (normalizerCheckbox) normalizerCheckbox.addEventListener("change", () => toggleNormalizer(tab));
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
    setInterval(() => {
        pollMeterState(tab).catch(() => {});
    }, 125);

    try {
        const audioState = await refreshAudioControlState(tab);
        const data = await storageGet({ siteSettings: {} });
        const settingsKey = getSiteSettingsKey(data.siteSettings || {}, tab.url);
        const saved = settingsKey ? data.siteSettings[settingsKey] : null;
        if (saved) {
            if (rememberCheckbox) rememberCheckbox.checked = true;
            // The content script already applies Remember on page initialization
            // and on storage changes. Replaying storage here overwrites newer
            // in-tab state (and may send a brief loud gain change) just because
            // the popup was opened. Only use storage for DISPLAY if this tab
            // has no reachable content-script state.
            if (!audioState) {
                if (saved.volume !== undefined) setDisplayedVolume(saved.volume);
                if (saved.mono !== undefined && monoCheckbox) monoCheckbox.checked = Boolean(saved.mono);
                if (saved.muted !== undefined) applyMuteButtonState(saved.muted);
            }
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
