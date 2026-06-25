***

<p align="center">
<a href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"><img src="https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png" alt="Get Volume Control for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"><img src="https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png" alt="Get Volume Control for Microsoft Edge"></a>
</p>

***


## Description

Volume Control adds a simple per-site volume control to your browser. It can lower volume, boost HTML5 audio and video above the normal browser limit, and optionally play stereo audio as mono. The extension is useful for quiet videos, uneven site volume, embedded players, and pages that do not provide enough audio control on their own.

Settings can be remembered per site, and you can exclude sites where you do not want the extension to run. Volume Control supports HTML5 video and audio only; it does not support Flash.

## Known Limitations

- Volume Control cannot run on browser system pages such as `chrome://`, `edge://`, `about:`, extension pages, or other protected browser UI.
- DRM-protected or otherwise restricted media may block volume boosting, mono routing, or audio graph access.
- Some cross-origin media can only use fallback volume control when browser security rules prevent WebAudio routing. In that fallback mode, volume can still be lowered, but boosting and mono may be unavailable.
- Sites with unusual, heavily customized, or late-changing WebAudio graphs may not be fully controllable in every playback path.

## Hotkeys

- `Alt+Shift+Up`: Increase volume by 1 dB.
- `Alt+Shift+Down`: Decrease volume by 1 dB.
- `Alt+Shift+0`: Reset volume to 0 dB.
- `Alt+Shift+M`: Toggle mono audio.
- `Unassigned due to 4 hotkey limit, edit in firefox/chrome settings [chrome://extensions/shortcuts]`: Activate the extension.
- `Unassigned due to 4 hotkey limit, edit in firefox/chrome settings [chrome://extensions/shortcuts]`: Toggle mute.

Browser shortcut settings can be used to remap or disable these defaults.
Pin the extension icon to the toolbar to see native badge feedback while adjusting volume.

## Privacy Policy

Volume Control does not collect, transmit, sell, share, or store any personal information outside your browser.

The extension does not use analytics, telemetry, tracking pixels, remote logging, accounts, advertising IDs, or any external server for data collection. Your volume settings, mono setting, excluded sites, remembered sites, whitelist or blacklist mode, and debug preference are stored only in your browser's local extension storage.

The extension reads page audio/video elements locally in your browser only so it can apply the volume and mono settings you choose. This processing happens on your device. No browsing history, page content, audio content, media titles, URLs, or settings are sent to the developer or to any third party.

## Permissions

Volume Control asks for the browser permissions needed to control audio reliably across modern websites:

- `storage`: Saves your volume settings, mono setting, remembered site settings, exclusion list, whitelist/blacklist mode, and debug preference locally in your browser.
- `activeTab`: Lets the popup identify and update the current tab after you interact with the extension, without requesting broader tab access.
- `<all_urls>` host permission: Allows the content scripts to run on websites where audio or video may exist. This is needed because users can play HTML5 media on almost any site, and the extension has to access page-local media elements and WebAudio connections to change their volume.
- `document_start` content script timing: Installs the page audio hooks before sites create `Audio`, `AudioContext`, media elements, or WebAudio destination connections. Loading later can miss audio graphs that are created during early page startup.
- `all_frames` content script access: Lets the extension work with audio/video inside embedded frames, such as video players, social embeds, and media hosted from another domain. Without frame access, only top-level page media would be controllable.
- `file:///*` content script match: Allows the extension to work on local media files when the browser permits extension access to file URLs.

AMO/Chrome Web Store review note: the broad host access, early `document_start` injection, and `all_frames` access are used only to detect and route page-local HTML5 media and WebAudio before playback begins. Volume Control does not collect browsing history, inspect page content for analytics, inject ads, or send page URLs, media metadata, audio content, or settings to any server.

<img width="472" height="182" alt="firefox_sqvsowk1NI" src="https://github.com/user-attachments/assets/7790e01c-ccb5-41c1-b24c-0ac4123b35ab" />

<img width="472" height="182" alt="firefox_6Jn4rh739p" src="https://github.com/user-attachments/assets/f366b636-ac39-4e23-b929-c6f29b34b8b9" />


# Changelog

---

<details>
<summary><strong>Version 6.4 – Patch Notes</strong></summary>

- New	Dedicated mute channel (independent of the volume slider)
- New	Native element.muted for fallback-only media (Bluetooth-friendly)
- New	"MUTE" browser-action badge
- New	Muted-state slider dim + tooltip
- New	Mute checkbox in Remembered Settings
- Fixed	effectiveGain() regression that silenced audio when extension was disabled
- Optimized	Skip redundant enforceBoostLimit in setMute response path

</details>

---

<details>
<summary><strong>Version 6.3 – Patch Notes</strong></summary>

📶 **Bluetooth fixes (7)** — context suspension/closing, unrouting at unity gain  
🔊 **Volume spike fixes (6)** — smoother ramps, skip redundant reconnects, improved transition ordering  
🛑 **Critical regressions fixed (2)** — replay break, `onstatechange` crash  
🚀 **New features (2)** — heartbeat + graceful degradation, bridge version negotiation  
⚡ **Performance (6)** — debouncing, caching, `WeakRef`, skip‑redundant‑sync  
🔍 **Robustness (5)** — boost limit, race‑condition fixes, improved `callApi` error handling  
♿ **Accessibility (2)** — focus management, ARIA live‑region updates  
🧹 **Code cleanup (12)** — extracted helpers, removed duplicates, dead‑code removal  

</details>

---

<details>
<summary><strong>Version 6.2 – Patch Notes</strong></summary>

- Added browser hotkeys for volume up/down, reset, and mono toggle  
- Added native toolbar‑badge volume feedback for hotkeys and popup adjustments  
- Hotkey changes now update remembered settings when the current site is already remembered  

</details>

---

<details>
<summary><strong>Version 6.1 – Patch Notes</strong></summary>

- Removed an unused JS library  
- Reduced Bluetooth idle power usage by disposing audio sessions more cleanly on stop  

</details>

---

<details>
<summary><strong>Version 6.0 – Patch Notes</strong></summary>

- Added Manifest V3 page‑world audio integration for stricter CSP sites and app‑style audio  
- Improved detection for dynamic audio/video elements and detached `Audio` nodes  
- Reduced Bluetooth idle popping by avoiding generic page‑interaction resumes and lazy‑loading audio hooks  
- Improved remembered‑site settings on app‑style pages and subdomains  
- Restored boosting for app pages that create WebAudio connections before volume is adjusted  
- Added direct Howler master‑gain routing for sites that hide their audio graph internals  
- Added cross‑origin media guard/fallback so boosted CDN audio keeps playing when browsers block routed gain  
- Added automated Firefox + Chrome package builds with separate SVG/PNG manifest icons  
- Removed an unused third‑party DOM watcher dependency  
- Build zips now use AMO‑compatible forward‑slash archive paths  
- Updated project license notice to include Chaython Meredith  

</details>

---

Planned features: Added to Chrome Web Store.

<details>
<summary><h2>📁 File Descriptions</h2></summary>

### Complete File Reference

| File | World / Context | Has `window`? | Has `chrome.*`? | Can Patch Page JS? | Purpose | Why It Must Be Separate |
|---|---|---|---|---|---|---|
| `shared.js` | Loaded into multiple contexts (MAIN + ISOLATED) | ✅ | ✅ (guarded) | ❌ | Pure utility library — dB conversion, media element helpers, domain parsing, bridge constants, error helpers | The only file that can appear in multiple contexts; guards all `chrome.*` calls so it doesn't crash in MAIN world |
| `page-audio-hook.js` | **MAIN world** content script | ✅ Page's `window` | ❌ | ✅ **Yes** | Patches `AudioNode.prototype.connect`, `HTMLMediaElement.prototype.volume`, `HTMLMediaElement.prototype.play`, `window.Audio`, `document.createElement` to insert gain nodes into the page's audio graph | **Must** run in MAIN world — prototype patches only affect code in the same JS realm; extension APIs are stripped from MAIN world for security |
| `cs.js` | **ISOLATED world** content script | ✅ Clean `window` | ✅ | ❌ | Content script bridge — reads/writes `chrome.storage`, handles messages from popup/background, syncs state to `page-audio-hook.js` via `window.postMessage`, manages fallback volume for cross-origin/DRM media | **Must** run in ISOLATED world to access `chrome.storage` and `chrome.runtime` APIs; communicates with MAIN world via `postMessage` |
| `background.js` | **Service worker** (background) | ❌ No DOM | ✅ | ❌ | Handles keyboard shortcuts (`Alt+Shift+Up`/`Down`/`0`/`M`), shows native volume feedback badge, manages per-site remembered settings | **Must** be a service worker — runs globally (not per-tab), has no DOM access, gets killed when idle; can't be merged with page-context scripts |
| `popup.js` | **Popup page** (`popup.html`) | ✅ Own DOM | ✅ | ❌ | Popup UI logic — volume slider, mono toggle, remember-site checkbox, enable/disable switch, debounced storage writes, focus management for accessibility | Runs in `popup.html`'s isolated DOM; separate from options page because popup logic and options logic have no overlapping DOM concerns |
| `options.js` | **Options page** (`options.html`) | ✅ Own DOM | ✅ | ❌ | Options UI logic — blocklist/whitelist management, remembered-sites editor, debug mode toggle, live storage sync | Runs in `options.html`'s isolated DOM; separate from popup because it manages different UI with different lifecycle (stays open vs. closes on action) |
| `manifest.json` | Extension manifest | — | — | — | Declares permissions, content scripts (with world specification), background service worker, action popup, options page, keyboard commands, Firefox compatibility | Defines which scripts load in which world; the only place where the MAIN/ISOLATED split is configured |
| `popup.html` | Popup document | ✅ | — | ❌ | Popup markup — volume slider, mono/remember/active toggles, settings button, exclusion message, error display | Required entry point for `browser.action.default_popup` |
| `popup.css` | Popup styles | — | — | — | Popup styling — slider, switches, layout, dark mode support | Keeps presentation separate from popup logic |
| `options.html` | Options document | ✅ | — | ❌ | Options markup — whitelist mode toggle, blocklist editor, remembered-sites editor, debug mode toggle | Required entry point for `options_ui.open_in_tab` |
| `ico.svg` | Extension icon | — | — | — | Toolbar icon (96×96 SVG) | Referenced by `manifest.json` `icons` and `action.default_icon` |

### The MAIN / ISOLATED World Wall

```
┌─────────────────────────────────────────────────────┐
│  Page's JavaScript (MAIN world)                     │
│                                                     │
│  page-audio-hook.js                                 │
│  • Patches AudioNode.prototype.connect              │
│  • Patches HTMLMediaElement.prototype.volume        │
│  • Patches HTMLMediaElement.prototype.play          │
│  • Has NO access to chrome.* APIs                   │
│                                                     │
└──────────────────┬──────────────────────────────────┘
                   │
                   │  window.postMessage (bridge)
                   │
┌──────────────────▼──────────────────────────────────┐
│  Content Script (ISOLATED world)                    │
│                                                     │
│  cs.js                                              │
│  • Reads/writes chrome.storage                      │
│  • Handles messages from popup/background           │
│  • Syncs state to page-audio-hook.js                │
│  • CANNOT patch page prototypes                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**This split is non-negotiable.** Chrome's MV3 security model strips `chrome.*` from MAIN world scripts, and ISOLATED world scripts can't modify page prototypes. The two scripts communicate via `window.postMessage` — the only bridge between worlds.

### Why `shared.js` Is Special

`shared.js` is **not a context** — it's a library loaded *into* multiple contexts:

```json
// manifest.json — shared.js appears in BOTH content script entries
{
  "js": ["shared.js", "page-audio-hook.js"],  // MAIN world
  "world": "MAIN"
},
{
  "js": ["shared.js", "cs.js"]                // ISOLATED world (default)
}
```

It guards all `chrome.*` calls with optional chaining (`if (!browserApi?.storage) return ...`) so it doesn't crash when loaded in MAIN world where `browser`/`chrome` are undefined.

### Minimum File Count

**5 execution contexts → 5 files** (background, page-audio-hook, cs, popup, options)
**1 shared library → shared.js** (loaded into 3 of the 5 contexts)

This is the minimum possible file count given the WebExtension API's security constraints.

</details>

***

## Build packages

Create Firefox and Chrome zip packages:

```powershell
.\scripts\build.ps1
```

The script writes clean packages to `dist/`, using `ico.svg` for Firefox and `chrome.png` for Chrome. The bundled zips exclude repo files and `README.md`.

***

<details>
<summary><h2>Usage statistics</h2></summary>
Firefox:
<img width="1088" height="1280" alt="image" src="https://github.com/user-attachments/assets/fc489b2d-ae2c-40c6-8e25-9fe37bda8d16" />
Edge:
<img width="1566" height="1029" alt="image" src="https://github.com/user-attachments/assets/5257e49b-eb1e-49c9-95e9-4664a5dff7ca" />
</details>

***

Other Useful Extensions: 
https://github.com/Chaython/TogglePIP (Allow a site to run PIP consistently with an [Left Alt]+[P] toggle.)
https://github.com/Chaython/NTP (A NTP extension that offers custom shapes, colors, search providers....)

***
