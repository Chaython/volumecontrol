***

<p align="center">
<a href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"><img src="https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png" alt="Get Volume Control for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"><img src="https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png" alt="Get Volume Control for Microsoft Edge"></a>
</p>

***
Newest update: Added Storage options, allowing the user to blacklist the extension from running on sites where the extension breaks functionality.

## Version 6 Patch Notes

- Added Manifest V3 page-world audio integration for stricter CSP sites and app-style audio.
- Improved detection for dynamically created audio/video and detached `Audio` elements.
- Reduced Bluetooth idle popping by avoiding generic page-interaction resumes and lazy-loading audio hooks.
- Improved remembered site settings on app-style pages and subdomains.
- Restored boosting for app pages that create WebAudio connections before volume is adjusted.
- Added a direct Howler master-gain route for sites that hide their audio graph internals.
- Added a cross-origin media guard/fallback for app audio clips so boosted CDN audio keeps playing when browsers block routed gain.
- Added automated Firefox and Chrome package builds with separate SVG/PNG manifest icons.
- Build script now checks upstream `arrive.min.js` before every package build.
- Build zips now use AMO-compatible forward-slash archive paths.
- Updated project license notice to include Chaython Meredith.

Planned features: Added to chrome extension store,


⚠ Important: To add functionality to more websites, the permission "all_urls" was necessary, however with the recent update to manifest v3, it's optional. If the extension can't access audio on a certain site do the following: Right click the extension, click "manage extension", click the permission tab, allow "Access your data for all websites". This is a necessary permission to access iframes. The extension is open source and fully adheres to this repository. There's no form of analytics in this extension. So don't be afraid of the permissions.

<img width="472" height="182" alt="firefox_sqvsowk1NI" src="https://github.com/user-attachments/assets/7790e01c-ccb5-41c1-b24c-0ac4123b35ab" />

<img width="472" height="182" alt="firefox_6Jn4rh739p" src="https://github.com/user-attachments/assets/f366b636-ac39-4e23-b929-c6f29b34b8b9" />



Supports HTML5 video and audio only (no Flash).

***
<img width="1088" height="1280" alt="image" src="https://github.com/user-attachments/assets/fc489b2d-ae2c-40c6-8e25-9fe37bda8d16" />


Other Useful Extensions: 
https://github.com/Chaython/TogglePIP (Allow a site to run PIP consistently with an [Left Alt]+[P] toggle.)
https://github.com/Chaython/NTP (A NTP extension that offers custom shapes, colors, search providers....)

***

## Build packages

Create Firefox and Chrome zip packages:

```powershell
.\scripts\build.ps1
```

The script checks `lib/arrive.min.js` against upstream GitHub on every run, then writes clean packages to `dist/`, using `ico.svg` for Firefox and `chrome.png` for Chrome. The bundled zips exclude repo files and `README.md`.
