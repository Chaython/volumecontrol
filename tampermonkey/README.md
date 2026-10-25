# Tampermonkey (userscript) edition

`volume-control.user.js` is the complete Volume Control engine packaged as a
single userscript — no browser extension required. It embeds the extension's
real `page-audio-hook.js` **verbatim** and injects it into pages exactly the
way the extension does; only the surrounding machinery is replaced:

| Extension part | Userscript equivalent |
|---|---|
| `cs.js` content script | the controller in this script (same bridge protocol, v3) |
| `chrome.storage` per-site settings | GM storage keyed by hostname |
| browser-action popup | floating popup (same ported `popup.css`, Shadow DOM) |
| toolbar badge + icon | badge on the floating button |
| browser commands | `Alt+Shift+…` page keybindings |
| options page | Tampermonkey menu commands |

## Install

- **One-click** (served from the live site, always current):
  <https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js>
- **Raw from master:**
  <https://raw.githubusercontent.com/Chaython/volumecontrol/master/tampermonkey/volume-control.user.js>
- Every GitHub release also carries it as a release asset (`volume-control.user.js`).

Requires a userscript manager (Tampermonkey recommended; also works under
Violentmonkey/Greasemonkey via the built-in localStorage fallback).

## Hotkeys

`Alt+Shift+↑/↓` volume · `Alt+Shift+0` reset · `Alt+Shift+M` mono ·
`Alt+Shift+U` mute · `Alt+Shift+P` popup — matching the extension's commands.

## How this file stays fresh

- The **Publish** workflow rebuilds it on every release, attaches it to the
  release, and auto-commits the result back to `master` (this folder **and**
  `website/public/tampermonkey/`), so the committed copy never goes stale.
- The **Deploy website** workflow rebuilds it whenever `page-audio-hook.js`,
  `popup.css`, `manifest.json`, or anything under `tampermonkey/` changes —
  the copy served from the website is always built from the current engine.

## Rebuild locally

```sh
node scripts/build-userscript.mjs
```

The build embeds, in order:

1. `page-audio-hook.js` from the repository root (the real engine),
2. the version from `manifest.json`,
3. the `.vc-popup`-scoped port of `popup.css` from
   `website/src/components/demo/popup.css` (the raw extension popup.css
   targets `html, body`, which cannot match inside a shadow root),
4. `userscript-template.js` from this folder.

Output lands at `tampermonkey/volume-control.user.js` and
`website/public/tampermonkey/volume-control.user.js`. If the engine source is
missing (website-only checkout), the committed artifact is kept.

`test-harness.html` lives in `website/public/tampermonkey/` — it shims the GM
APIs and loads the userscript as a plain script for development testing.
