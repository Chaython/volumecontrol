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

## Version 6.2 Patch Notes
- Added browser hotkeys for volume up, volume down, reset, and mono toggle.
- Added native toolbar-badge volume feedback when volume is adjusted from hotkeys or popup controls.
- Hotkey changes update remembered settings when the current site is already remembered.

## Version 6.1 Patch Notes
- Removed the unused JS library.
- Be less aggressive and dispose the audio session on stop to help prevent audio sessions from wasting Bluetooth power or keeping the system awake.

## Version 6 Patch Notes
- Added Manifest V3 page-world audio integration for stricter CSP sites and app-style audio.
- Improved detection for dynamically created audio/video and detached `Audio` elements.
- Reduced Bluetooth idle popping by avoiding generic page-interaction resumes and lazy-loading audio hooks.
- Improved remembered site settings on app-style pages and subdomains.
- Restored boosting for app pages that create WebAudio connections before volume is adjusted.
- Added a direct Howler master-gain route for sites that hide their audio graph internals.
- Added a cross-origin media guard/fallback for app audio clips so boosted CDN audio keeps playing when browsers block routed gain.
- Added automated Firefox and Chrome package builds with separate SVG/PNG manifest icons.
- Removed an unused third-party DOM watcher dependency from the extension package.
- Build zips now use AMO-compatible forward-slash archive paths.
- Updated project license notice to include Chaython Meredith.

Planned features: Added to Chrome Web Store.



<img width="472" height="182" alt="firefox_sqvsowk1NI" src="https://github.com/user-attachments/assets/7790e01c-ccb5-41c1-b24c-0ac4123b35ab" />

<img width="472" height="182" alt="firefox_6Jn4rh739p" src="https://github.com/user-attachments/assets/f366b636-ac39-4e23-b929-c6f29b34b8b9" />



Supports HTML5 video and audio only (no Flash).

***
## Usage statistics
Firefox:
<img width="1088" height="1280" alt="image" src="https://github.com/user-attachments/assets/fc489b2d-ae2c-40c6-8e25-9fe37bda8d16" />
Edge:
<img width="1566" height="1029" alt="image" src="https://github.com/user-attachments/assets/5257e49b-eb1e-49c9-95e9-4664a5dff7ca" />



Other Useful Extensions: 
https://github.com/Chaython/TogglePIP (Allow a site to run PIP consistently with an [Left Alt]+[P] toggle.)
https://github.com/Chaython/NTP (A NTP extension that offers custom shapes, colors, search providers....)

***

## Build packages

Create Firefox and Chrome zip packages:

```powershell
.\scripts\build.ps1
```

The script writes clean packages to `dist/`, using `ico.svg` for Firefox and `chrome.png` for Chrome. The bundled zips exclude repo files and `README.md`.
