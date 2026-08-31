***

<p align="center">
<a href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"><img src="https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png" alt="Get Volume Control for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"><img src="https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png" alt="Get Volume Control for Microsoft Edge"></a>
</p>

***


## Description

Volume Control adds a simple per-site volume control to your browser. It can lower volume, boost HTML5 audio and video above the normal browser limit, and optionally play stereo audio as mono. The extension is useful for quiet videos, uneven site volume, embedded players, and pages that do not provide enough audio control on their own.

Settings can be remembered per site, and you can exclude sites where you do not want the extension to run. Volume Control supports HTML5 video and audio only; it does not support Flash.

Media that cannot be boosted (DRM-protected or cross-origin streams) is detected automatically: the popup explains the restriction, the slider clamps at 0 dB, and lowering volume still works through the native fallback. See [Restricted Media](#restricted-media-drm--cross-origin) below.

## Restricted Media (DRM & Cross-Origin)

Some media cannot be routed through WebAudio: DRM-protected streams (EME / Widevine / PlayReady / ClearKey) and cross-origin media loaded without CORS. Routing these through WebAudio either fails or detaches the element's native output and plays silence, so Volume Control detects them and refuses to route — while keeping native volume control working.

**What you will see**

- The popup shows a "restricted by DRM" note (or a cross-origin restriction note) and the slider clamps at 0 dB — no boost is offered because none is possible on that media.
- Lowering volume still works: the element's native volume is used (attenuation only, exact dB math, and mute).
- Mono mixing is unavailable on such media.

**How detection works**

- Per-element signals: `encrypted` events, `setMediaKeys` calls (wrapped), and `blob:` (MSE) sources on pages that were actually granted a CDM (via wrapped `requestMediaKeySystemAccess` — probing alone does not trip it).
- The MAIN-world hook computes one aggregate page verdict over **every** element it tracks — attached to the DOM, detached (JS-created players that never touch the DOM), or inside a shadow DOM — and publishes it with immediate change notifications.
- Embedded iframes report their verdict to the top frame (1 s heartbeat, 2.5 s TTL) and the most restrictive live report wins; the verdict relaxes automatically when the media goes quiescent or the frame is removed.
- All verdicts are computed deterministically by the top frame — no cross-frame response races, which is what keeps the restriction note stable while you drag the slider.
- Same-window spoofed messages are ignored (`event.source === window`), so page scripts cannot fake or clear a verdict.

**Verification:** the restriction pipeline was live-tested against real Widevine playback on udio.com and against a real cross-origin CDN audio source replicating detached-player sites (treblo.com pattern), plus a ClearKey EME harness — restricted media is never routed, the verdict is stable, and fallback attenuation is exact.

## Known Limitations

- Volume Control cannot run on browser system pages such as `chrome://`, `edge://`, `about:`, extension pages, or other protected browser UI.
- DRM-protected and cross-origin media can only use the native volume fallback: lowering and mute work; boosting and mono do not. See [Restricted Media](#restricted-media-drm--cross-origin).
- Sites that create their own `createMediaElementSource` pipeline for the same element can end up double-attenuating when Volume Control also routes that element.
- Media that becomes cross-origin-tainted *after* it was already routed cannot be un-tainted; routing continues with the gain that was already applied.
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

AMO/Chrome Web Store review note: the broad host access, early `document_start` injection, and `all_frames` access are used only to detect and route page-local HTML5 media and WebAudio before playback begins. Volume Control does not collect browsing history, inspect page content for analytics, inject ads, or send page URLs, media metadata, audio content, or settings to a server.

<img width="472" height="182" alt="firefox_sqvsowk1NI" src="https://github.com/user-attachments/assets/7790e01c-ccb5-41c1-b24c-0ac4123b35ab" />

<img width="472" height="182" alt="firefox_6Jn4rh739p" src="https://github.com/user-attachments/assets/f368b636-ac39-4e23-b929-c6f29b34b8b9" />


# Changelog

---

<details>
<summary><strong>Version 6.11 – Patch Notes</strong></summary>

- Fixed   [HIGH] Extension disable/update or hook heartbeat loss silenced long-playing tracks: routed media's only audio path was disconnected; playing elements now keep their route wired at unity gain
- Fixed   [HIGH] Page AudioContexts suspended by the Bluetooth idle sweep were never resumed (site SFX/game audio stayed silent); new destination connections now revive them, page-initiated suspensions are respected
- Fixed   [HIGH] Remembered "muted" was not restored on navigation — only volume and mono were re-applied on page load
- Fixed   Restriction note flashing off/on during track changes (500 ms hysteresis on relaxation; tightening still publishes immediately)
- Fixed   Abandoned AudioContexts were pinned forever and counted against the per-tab context quota (now WeakRef-tracked)
- Fixed   Removed iframes stayed pinned in idle tabs (2.5 s TTL purge timer in the top frame)
- Fixed   Players injected via `innerHTML` (jQuery `.html()`, template rendering) were invisible to detection — a MutationObserver now registers them
- Fixed   Fallback-volume write war with sites that write volume back on every `volumechange` (250 ms per-element rate limit, self-healing)
- Fixed   `toggle-mute` could not unmute stateless tabs; remembered-settings writes used stale snapshots; bare "www." domain entries never matched; popup verdict went stale while open (1 s refresh that never touches the slider mid-drag); autoplay-suspended contexts revive on the first user gesture
- Verified     Every function exercised live in a real browser across 6 realistic player patterns (parser video, detached cross-origin CDN audio, innerHTML-injected video, WebAudio-only graphs, cross-origin elements, EME ClearKey DRM) — 19/19 checks pass — plus real Widevine playback on udio.com

</details>

---

<details>
<summary><strong>Version 6.10 – Patch Notes</strong></summary>

- Fixed   Missing "restricted by DRM" note on sites whose players never live in the page's DOM: detached JS-created players, shadow-DOM players, and iframe-resident media were invisible to the verdict scan — the slider offered +32 dB it could not deliver and boost was silently capped
- New   Aggregate page-restriction flag: the MAIN-world hook publishes a "restricted"/"cross-origin" verdict over ALL tracked elements (attached, detached, or shadow-DOM), refreshed on media claim, DRM events, element lifecycle events, state applications, and a 1 s interval; changes invalidate the content script's verdict cache immediately
- New   Cross-frame aggregation: embedded frames report their verdict to the top frame (1 s heartbeat, 2.5 s TTL) and the most restrictive live report wins — without reintroducing response races (see 6.9)
- Improved     Dead frames relax via TTL; same-window postMessages cannot spoof verdicts; restrictions relax automatically when media goes quiescent; same-origin detached elements remain fully boostable (no false positives)

</details>

---

<details>
<summary><strong>Version 6.9 – Patch Notes</strong></summary>

- Fixed   "Restricted by DRM" note flickering in and out while dragging the volume slider: state queries used unframed messaging, so the top frame (restricted, DRM) raced embedded iframes (unrestricted) and the first responder won on every slider commit. State queries now target the top frame only; apply commands still broadcast so embedded players remain controllable
- Fixed   Latent DRM mute: routing DRM media through WebAudio succeeds at the API level but detaches the element's native output in real Chrome and feeds the graph silence. The hook now refuses to route restricted media entirely; native fallback volume keeps working
- New   EME detection: `setMediaKeys` and `requestMediaKeySystemAccess` are wrapped (a page is flagged as using EME only when a CDM is actually granted); on EME pages, `blob:` (MSE) sources are treated as restricted from the first moment — closing the birth window before `encrypted`/keys events land
- Improved     DRM protection is no longer masked by hook ownership; per-element `encrypted` listeners attach before the page-managed early return; the popup clamps the slider at 0 dB with a "restricted" note

</details>

---

<details>
<summary><strong>Version 6.8 – Patch Notes</strong></summary>

- Fixed   Random "earrape" volume: media elements detached from the DOM but still playing (site player rebuilds, ad transitions, quality switches, SPA navigations) were dropped from tracking, freezing their WebAudio route gain at the boost level active at detach — up to +32 dB (~40×) — while the popup kept showing the correct value. Detached-but-audible elements are now kept tracked and updated; only quiescent elements are released
- Fixed   Random silence after returning to 0 dB: idle AudioContext suspension now also counts native (unrouted) connections, so contexts with live audio are never suspended
- Fixed   Site volume writes during the 100 ms echo-ignore window were swallowed — only the extension's own write-backs are ignored now
- Fixed   Content-script cleanup could suspend an AudioContext while audio was still flowing (same keep-if-playing policy applied)
- Improved     Full state re-send every ~30 s to heal hook ↔ content-script state drift (defense-in-depth on top of the heartbeat)

</details>

---

<details>
<summary><strong>Version 6.4 – Patch Notes</strong></summary>

- New   Dedicated mute channel (independent of the volume slider)
- New   Native element.muted for fallback-only media (Bluetooth-friendly)
- New   "MUTE" browser-action badge
- New   Muted-state slider dim + tooltip
- New   Mute checkbox in Remembered Settings
- Fixed effectiveGain() regression that silenced audio when extension was disabled
- Optimized     Skip redundant enforceBoostLimit in setMute response path

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

Planned features: Added to Chrome Web Store. [Looking for donations, to buy chrome store developer license](https://github.com/sponsors/Chaython)

<details>
<summary><h2>📁 File Descriptions</h2></summary>

### Complete File Reference

| File | World / Context | Has `window`? | Has `chrome.*`? | Can Patch Page JS? | Purpose | Why It Must Be Separate |
|---|---|---|---|---|---|---|
| `shared.js` | Loaded into multiple contexts (MAIN + ISOLATED) | ✅ | ✅ (guarded) | ❌ | Pure utility library — dB conversion, media element helpers, domain parsing, bridge constants, frame-targeted messaging helpers, error helpers | The only file that can appear in multiple contexts; guards all `chrome.*` calls so it doesn't crash in MAIN world |
| `page-audio-hook.js` | **MAIN world** content script | ✅ Page's `window` | ❌ | ✅ **Yes** | Patches `AudioNode.prototype.connect`, `HTMLMediaElement.prototype.volume`, `HTMLMediaElement.prototype.play`, `window.Audio`, `document.createElement`, `setMediaKeys`/`requestMediaKeySystemAccess` (EME detection) to insert gain nodes into the page's audio graph and track every media element (attached, detached, or shadow-DOM) | **Must** run in MAIN world — prototype patches only affect code in the same JS realm; extension APIs are stripped from MAIN world for security |
| `cs.js` | **ISOLATED world** content script | ✅ Clean `window` | ✅ | ❌ | Content script bridge — reads/writes `chrome.storage`, handles messages from popup/background (top-frame targeted), syncs state to `page-audio-hook.js` via `window.postMessage`, computes the boost-limit verdict (DRM/cross-origin) including the hook's aggregate flag and iframe reports, manages fallback volume for cross-origin/DRM media | **Must** run in ISOLATED world to access `chrome.storage` and `chrome.runtime` APIs; communicates with MAIN world via `postMessage` |
| `background.js` | **Service worker** (background) | ❌ No DOM | ✅ | ❌ | Handles keyboard shortcuts (`Alt+Shift+Up`/`Down`/`0`/`M`), shows native volume feedback badge, manages per-site remembered settings | **Must** be a service worker — runs globally (not per-tab), has no DOM access, gets killed when idle; can't be merged with page-context scripts |
| `popup.js` | **Popup page** (`popup.html`) | ✅ Own DOM | ✅ | ❌ | Popup UI logic — volume slider, mono toggle, remember-site checkbox, enable/disable switch, restriction note ("restricted by DRM"), debounced storage writes, focus management for accessibility, 1 s state polling while open (never touches the slider mid-drag) | Runs in `popup.html`'s isolated DOM; separate from options page because popup logic and options logic have no overlapping DOM concerns |
| `options.js` | **Options page** (`options.html`) | ✅ Own DOM | ✅ | ❌ | Options UI logic — blocklist/whitelist management, remembered-sites editor, debug mode toggle, live storage sync | Runs in `options.html`'s isolated DOM; separate from popup because it manages different UI with different lifecycle (stays open vs. closes on action) |
| `manifest.json` | Extension manifest | — | — | — | Declares permissions, content scripts (with world specification), background service worker, action popup, options page, keyboard commands, Firefox compatibility | Defines which scripts load in which world; the only place where the MAIN/ISOLATED split is configured |
| `popup.html` | Popup document | ✅ | — | ❌ | Popup markup — volume slider, mono/remember/active toggles, settings button, exclusion message, restriction note, error display | Required entry point for `browser.action.default_popup` |
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
│  • Patches EME (setMediaKeys / rmksa)               │
│  • Publishes aggregate restriction verdict          │
│  • Has NO access to chrome.* APIs                   │
│                                                     │
└──────────────────┬──────────────────────────────────┘
                   │  window.postMessage (bridge)
                   │
┌──────────────────▼──────────────────────────────────┐
│  Content Script (ISOLATED world)                    │
│                                                     │
│  cs.js                                              │
│  • Reads/writes chrome.storage                      │
│  • Handles messages from popup/background           │
│  • Syncs state to page-audio-hook.js                │
│  • Merges restriction verdicts (incl. iframes)      │
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
