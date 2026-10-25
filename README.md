# Volume Control

[![Get Volume Control for Firefox](https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png)](https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/)
[![Get Volume Control for Microsoft Edge](https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png)](https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc)

Control audio and video volume independently on websites. **Volume Control** lets you reduce quiet media, boost volume beyond the usual range, toggle mono or mute, and optionally normalize loudness.

## Features

- **Per-site volume:** adjust media from −32 dB to +32 dB where supported.
- **Remembered settings:** save volume, mute, mono, and normalization preferences by site or URL path.
- **Optional normalization:** Music and Adaptive modes automatically adjust loudness.
- **Mono and mute:** use the popup controls or keyboard shortcuts.
- **Site exclusions:** disable the extension on selected domains or URL paths.
- **Live feedback:** see volume changes and, when available, output peak measurements.

## Install

- **Firefox:** [Install from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/).
- **Microsoft Edge:** [Install from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc).
- **Chrome and other Chromium browsers:** download the matching package from [GitHub Releases](https://github.com/Chaython/volumecontrol/releases).

Stable downloads are available from [the latest stable release](https://github.com/Chaython/volumecontrol/releases/latest). The [releases page](https://github.com/Chaython/volumecontrol/releases) also lists rolling prereleases.

## Hotkeys

| Shortcut | Action |
|---|---|
| `Alt+Shift+Up` | Increase volume by 1 dB |
| `Alt+Shift+Down` | Decrease volume by 1 dB |
| `Alt+Shift+0` | Reset volume to 0 dB |
| `Alt+Shift+M` | Toggle mono audio |
| Unassigned by default | Activate the extension |
| Unassigned by default | Toggle mute |

Change shortcuts in your browser's extension shortcut settings. In Firefox, open **Manage Extension Shortcuts**; in Chrome, visit [Extension Shortcuts](chrome://extensions/shortcuts).

## Normalization and limitations

Normalization is **off by default**. Enable it for a site in the popup, or configure the default and mode in **Options → Normalizer**. Music mode favors smoother changes for music; Adaptive mode reacts more quickly to changing content.

Normalization and boosting require a media route the browser allows the extension to control. Some Chromium DRM streams, cross-origin media without suitable CORS access, and **Force native** playback cannot be processed through WebAudio; native volume and mute may still work. Firefox can support WebAudio routing for some DRM audio, but behavior depends on the site and browser.

The peak meter reports sampled audio peaks, not certified true peaks. The compressor is not a guaranteed brick-wall limiter, and high positive gain can still cause distortion. Start with a low volume and increase it gradually.

Volume Control supports **Firefox 128+** and **Chromium 121+** (including Edge, Brave, Opera, and Vivaldi). It works with HTML5 audio and video, not Flash. Browser-internal pages and extension pages cannot be controlled.

<details>
<summary>Technical details</summary>

Run the regression tests and build browser packages from source:

```powershell
npm ci
npm test
.\scripts\build.ps1
```

The build creates browser-specific ZIP packages under `dist/`. Source code and issue tracking are available in this repository.

</details>

<details>
<summary>Changelog</summary>

See the [GitHub Releases](https://github.com/Chaython/volumecontrol/releases) page for version-specific changes.

</details>

## Support development

Support the project through [GitHub Sponsors](https://github.com/sponsors/Chaython), [Patreon](https://patreon.com/Chaython), [Buy Me a Coffee](https://buymeacoffee.com/chaython), or [PayPal](https://paypal.me/ChaythonM).
