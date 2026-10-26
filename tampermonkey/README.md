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
| options page (normalizer settings) | the in-popup **Advanced options** view (Settings button) |
| options page (Blocked/Allowed Sites + Whitelist Mode) | **Site access** section in the Advanced view (`vc-lists` in GM storage) |
| options page (debug defaults + per-site debug overrides) | **Debug overrides** section in the Advanced view |
| options page (Remembered Settings management) | **Remembered settings** section in the Advanced view (rename/remove) |
| `siteNormalizerSettings` + "Normalize by default" | per-site Normalize store decoupled from Remember + a global default switch |
| `storage.onChanged` (cross-tab sync) | `GM_addValueChangeListener` — every open tab re-applies changes live |

## Install

- **One-click** (served from the live site, always current):
  <https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js>
- **Raw from master:**
  <https://raw.githubusercontent.com/Chaython/volumecontrol/master/tampermonkey/volume-control.user.js>
- Every GitHub release also carries it as a release asset (`volume-control.user.js`), and so does every daily prerelease — install a prerelease copy directly over an existing install to test the newest development build.

Requires a userscript manager (Tampermonkey recommended; also works under
Violentmonkey/Greasemonkey via the built-in localStorage fallback).

## Hotkeys

`Alt+Shift+↑/↓` volume · `Alt+Shift+0` reset · `Alt+Shift+M` mono ·
`Alt+Shift+U` mute · `Alt+Shift+P` popup — matching the extension's commands.

## The GUI

Userscripts cannot add toolbar icons, so the GUI is a floating one:

- a round speaker **button** fixed to the bottom-right corner of every page
  (drag it anywhere — the position is remembered per install),
- a live **badge** on the button (`+N` green, `−N`/`MUTE` red — the toolbar
  badge semantics from `background.js`),
- the **full extension popup** (identical markup and `popup.css` port) opening
  above the button: slider, mute, Normalize + live peak meter/gain, Mono,
  Remember, Active, dark mode — plus the extension's full set of verbatim
  restriction verdicts: all five boost-limit notes (DRM / cross-origin /
  native-route / route-failed, plus the fallback), the slider clamped to
  0 dB for *any* limitation reason, and the exact Mono/Normalize
  unavailability reasons,
- an **Advanced options** view behind the popup's Settings button: the
  extension's normalizer configuration (style, target loudness, max auto
  boost, compressor threshold, response speed, experimental true-peak —
  verbatim `options.html` labels/ranges), a **"Normalize by default on
  sites without an override"** switch, a **Remembered settings** section
  (every saved profile with rename/remove — the options page's management
  list), a **Site debug overrides** list (every saved per-site override,
  remove), a **Keyboard shortcuts** section, an **About** footer, a live
  engine status line, a link to the website, and **Reset all data** (wipes
  every site's remembered settings via `GM_listValues`; the first-run
  intro returns after a reset). The true-peak checkbox is honest: it is
  honored only by the extension's isolated fallback route (mainly Firefox)
  and, just like the extension on Chrome, it has no effect on this
  script's page-engine route,
- **remembered profiles are path/query-scoped like the extension's**
  (issue #69 semantics applied to profiles — ranked matching, so a
  `site/watch` profile outranks the bare host and a plain path covers
  descendants; the best match drives the popup, saving updates it or
  creates the page's path key). **Normalize is persisted per site
  independently of Remember** (per-site entry, falling back to the global
  default), SPA navigation re-evaluates profiles and access lists live, and
  setting changes propagate to every open tab (`GM_addValueChangeListener`)
  — the userscript's `storage.onChanged`,
- **Site access** (the options page's whitelist/blacklist): Blacklist mode
  skips listed sites entirely (native volume only); Whitelist mode runs only
  on listed sites. Entries match subdomains and are compared through the
  extension's canonical host (`www.`/trailing-dot stripped, on both the entry
  and the page), the add-field normalizes input (scheme/credentials/port/
  `www.` stripped, path kept — single-label hosts like `localhost` are
  accepted), an **optional path scopes the entry** (`twitch.tv/*/clip/*`
  blocks clip pages only, never the whole site — extension issue #69; a
  plain path covers itself and descendants; a saved `?query` matches exactly
  or via `*` wildcards), the popup's **Active** toggle edits the same list
  for the current site (removing *every* entry that keeps the page inactive,
  path-scoped ones included), and the exclusion message names the exact
  blocklist entry that is blocking (plus a count of further entries). A
  one-time migration turns the pre-7.1.4 per-site "Active off" flag into a
  blocklist entry. A **Site access lists (block/allow)** entry in the
  Tampermonkey menu opens the section directly,
- **Debug overrides** (the options page's debug section): **Show Debug
  Highlight** (green outline around hooked `<video>` elements — same rule as
  the extension), **Force DRM Audio Capture** and **Skip CORS Media Guard**
  (danger toggles with verbatim warnings), the **HTML media route** override
  (Auto / WebAudio / native), and a **per-site override** for the current
  host — all applied live to the engine via the bridge and persisted
  independently (`vc-debug-defaults`, `vc-debug:<host>`),
- **fullscreen survival**: when a page enters fullscreen (the YouTube player,
  any site), the button and popup move into the fullscreen element so they
  stay usable while watching, and return to the page when fullscreen exits.
  A 2-second heartbeat re-attaches the GUI if a site's player ever drops it
  from the document (SPA players rebuild their DOM in fullscreen).

On its **first run after install or update** the popup opens itself once and
  the button pulses, so the GUI is impossible to miss.

## How this file stays fresh

- The **Publish** workflow rebuilds it on every release, attaches it to the
  release, and auto-commits the result back to `master` (this folder **and**
  `website/public/tampermonkey/`), so the committed copy never goes stale.
- The **Daily prerelease** workflow builds and validates it (version extends
  the manifest, placeholders, embedded engine, syntax) and attaches it to
  every prerelease alongside the browser packages; changes under
  `tampermonkey/` count as releasable, so userscript-only fixes cut
  prereleases.
- The **Deploy website** workflow rebuilds it whenever `page-audio-hook.js`,
  `popup.css`, `manifest.json`, or anything under `tampermonkey/` changes —
  the copy served from the website is always built from the current engine.

## Rebuild locally

```sh
node scripts/build-userscript.mjs
```

The build embeds, in order:

1. `page-audio-hook.js` from the repository root (the real engine),
2. the version from `manifest.json` **plus a userscript-edition revision**
   (`USERSCRIPT_REVISION` in the build script — bump it whenever the template
   changes without a manifest bump, so Tampermonkey pushes the update),
3. the `.vc-popup`-scoped port of `popup.css` from
   `website/src/components/demo/popup.css`, with its trailing *preview-only
   chrome* section stripped (that section styles the website's browser mockup
   and would fight the userscript's own floating-host CSS),
4. `userscript-template.js` from this folder.

Output lands at `tampermonkey/volume-control.user.js` and
`website/public/tampermonkey/volume-control.user.js`. If the engine source is
missing (website-only checkout), the committed artifact is kept.

`test-harness.html` lives in `website/public/tampermonkey/` — it shims the GM
APIs and loads the userscript as a plain script for development testing.
