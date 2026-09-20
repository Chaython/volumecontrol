***

<p align="center">
<a href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"><img src="https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png" alt="Get Volume Control for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"><img src="https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png" alt="Get Volume Control for Microsoft Edge"></a>
</p>

***


## Description

Volume Control adds a simple per-site volume control to your browser. It can lower volume, boost HTML5 audio and video above the normal browser limit, and optionally play stereo audio as mono. The extension is useful for quiet videos, uneven site volume, embedded players, and pages that do not provide enough audio control on their own.

Settings can be remembered per site, and you can exclude sites where you do not want the extension to run. Volume Control supports HTML5 video and audio only; it does not support Flash.

Excluded-site entries match by domain, and entries saved **with a path** (such as the legacy V4-era defaults) are wildcard-matched against the full URL — so `www.twitch.tv/*/clip/*` excludes only the clip pages while the rest of Twitch runs. A one-time v6.13 migration removes the legacy Twitch default entries that older builds left in users' stored storage (path and `www.` normalization had turned them into a block on the whole domain — issue #69), and the popup's Active toggle now removes **every** entry that blocks the current page — not just the exact domain match — with a tooltip explaining what it removed. Since v6.14 the **options page also accepts user-typed paths**, so path-scoped exclusions are a first-class feature (`example.com/videos`, wildcards with `*` = any characters except `/` — see the options-page hint); the legacy purge now also runs at install/update/startup so a hand-added path entry can never be swept by a migration that has not run yet. Since v6.15 the popup **tells you when the current page is blocklisted** — an overlay message (styled like the DRM note) names the matching entry and how to re-enable the site, on every engine — and the options-page blocklist input accepts **Enter** to add an entry, with an inline notice when the typed site/wildcard is already in the list.

**Compatibility:** Firefox 128+ (event-page background) and Chromium 121+ — Chrome, Edge, Brave, Opera, Vivaldi from January 2024 onward (service-worker background). Chromium 120 and older rejects the cross-browser manifest shape at load time, so the manifest declares `minimum_chrome_version: "121"`.

Media that cannot be boosted (DRM-protected or cross-origin streams) is detected automatically: the popup explains the restriction, the slider clamps at 0 dB, and lowering volume still works through the native fallback. See [Restricted Media](#restricted-media-drm--cross-origin) below. On Firefox, DRM audio **can** be boosted — see the engine note below.

## Restricted Media (DRM & Cross-Origin)

Some media cannot be routed through WebAudio, and whether that applies depends on **both** the media and the browser engine:

- **DRM-protected streams (EME / Widevine / PlayReady / ClearKey)** on **Chrome, Edge, and other Chromium browsers**: `createMediaElementSource()` succeeds but the browser feeds the WebAudio graph **silence** for protected content while the element's native output stays detached — a one-way trip to permanent mute. Volume Control detects these and refuses to route; lowering volume still works through the native fallback.
- **DRM-protected streams on Firefox**: Gecko explicitly allows capturing EME media **audio** through WebAudio (Mozilla bug 1331763, shipped in Firefox 55 — only *video* capture via `captureStream()` is blocked). Since v6.12, Volume Control detects the engine and **routes DRM media normally on Firefox — boosting, mono, and mute all work** on sites like Netflix or Spotify web. Competitor extensions have shipped this behavior for years (it is safe: Firefox's CDM hands decrypted PCM to the standard audio pipeline, which WebAudio taps). Since v6.13 the routing is **ordered after the site's own handshake**: Gecko's `setMediaKeys()` throws `NotSupportedError` on an element that is already audio-captured, so EME elements are routed only once `setMediaKeys()` has **succeeded** (a keys-attached marker — the patched `setMediaKeys` applies the pending state on success). Routing first would break the site's player (issue #68).
- **Cross-origin media without CORS** (e.g. detached CDN players with no `crossOrigin` attribute): the WebAudio spec makes routed no-CORS media output silence **in every engine**, so the guard stays enforced everywhere — "cross-origin" note, 0 dB clamp, native fallback for attenuation/mute only.
- **What about browsers with Widevine disabled (Brave ships it off by default)?** Widevine's availability is irrelevant to Volume Control's audio path — the extension never touches the CDM. Two cases:
  - **Non-DRM media** (most of the web — YouTube, podcast/radio players, detached CDN previews): boosts **identically** to Chrome. Verified live in a Widevine-disabled Chromium run: same routing, same +20 dB route gain, same measured output (3.54 RMS — the exact value Chrome and Firefox produce for the same source).
  - **DRM media**: with Widevine disabled the site cannot decrypt its streams, so nothing plays at all — there is no audio to boost (or the site serves its clear fallback, which then boosts like any other media). A rejected `requestMediaKeySystemAccess` also does **not** trip the "restricted" verdict (the EME page flag is only set when a CDM is actually granted), so no false restriction note appears on sites that merely probe for DRM support.
  - Note that Brave **with Widevine off is not equivalent to Firefox**: Firefox boosts DRM audio because Gecko's WebAudio deliberately allows EME audio capture; Brave is a Chromium engine, so the protected-audio guard stays fully active (and with Widevine *on*, routed DRM audio would be silenced by the browser — refusal remains correct there).
- **PlayReady (Windows Firefox / Edge)**: PlayReady is just another EME key system to Volume Control's detection layer — the EME wraps are **key-system-agnostic**, so PlayReady content behaves exactly like Widevine on every engine: **boostable on Firefox** (Firefox supports PlayReady on Windows and hands the decrypted audio to the same pipeline), guarded on Edge/Chromium. If Firefox's console shows `com.microsoft.playready.recommendation.3000: Internal testing is highly recommended prior to enabling PlayReady playback on Windows…`, that is **Firefox's own informational warning addressed to the site's developers** — not an error, and not produced by Volume Control (it appears with the extension disabled, too). The `setServerCertificate()`/`generateRequest()` advice concerns the *page's* license handshake, which the extension never touches: it only *observes* `setMediaKeys`/`requestMediaKeySystemAccess` and never decrypts anything. A browser without the PlayReady CDM (e.g. Linux Firefox) simply rejects the key system request — and rejected requests never trip the "restricted" verdict. Verified live on real Firefox with a PlayReady-shaped grant: the page is flagged EME-using and the element carries the sticky restricted flag, yet it still routes and boosts **audibly (3.54 RMS at +20 dB — identical to the same run's clear media)** with no "restricted" verdict published.

**What you will see when media is restricted** (Chromium + DRM, or any engine + cross-origin)

- The popup shows a "restricted by DRM" note (or a cross-origin restriction note) and the slider clamps at 0 dB — no boost is offered because none is possible on that media in that browser.
- Lowering volume still works: the element's native volume is used (attenuation only, exact dB math, and mute).
- Mono mixing is unavailable on such media.

**How detection works**

- Per-element signals (v6.13 — the "restricted" verdict requires **per-element DRM evidence**): an `encrypted` event fired, a `setMediaKeys` call (wrapped), or `element.mediaKeys` set. A page that merely PROBES DRM capability never trips the verdict — app.plex.tv probes all three key systems at startup (verified in its production bundle) while playing clear direct-play content, and since v6.9 that probing alone had wrongly clamped boost to 0 dB on every engine (issue #70).
- **Pending EME gate — decryption proof** (v6.14): on EME-probed pages, `blob:` (MSE) sources without per-element evidence are not routed until the element's `currentTime` actually **advances** — proof that the content is decodable, i.e. clear (EME content cannot decode a single frame without MediaKeys attached, and every attachment path is visible: patched `setMediaKeys`/`webkitSetMediaKeys`, `element.mediaKeys`, the `encrypted` event). Progress is observed at `timeupdate` cadence (~4 Hz in Chromium, 15–250 ms per spec) plus a 1 s sweep backup, so clear content routes within **~a quarter second of playback** (Plex — v6.13 waited a blind 3-second window; a mid-session boost while already playing also routes at the next timeupdate). DRM-stalled media (playback blocked on a license, `currentTime` frozen) never proves anything and is never routed — the udio.com birth-window safety is preserved by physics rather than by a timer. When the page actually constructs MediaKeys, earned proof is reset (keys are imminent — the `createMediaKeys` patch), and a source change (`emptied`) re-earns proof for the new source. On Gecko, Netflix routes immediately once keys attach.
- **Residual (documented) limitation**: an element that plays CLEAR content and later switches to encrypted media **on the same element** mid-session can already be routed when the evidence lands — on Chromium there is no way back from `createMediaElementSource()`, so the verdict flips to "restricted" and the (silenced) route cannot be unwound. This exposure existed in every prior version after its grace window expired; v6.14 just makes clear content route sooner. Real sites switch protection by reloading the source (which re-earns proof) or the player, so this is a theoretical edge.
- The MAIN-world hook computes one aggregate page verdict over **every** element it tracks — attached to the DOM, detached (JS-created players that never touch the DOM), or inside a shadow DOM — and publishes it with immediate change notifications.
- Embedded iframes report their verdict to the top frame (1 s heartbeat, 2.5 s TTL) and the most restrictive live report wins; the verdict relaxes automatically when the media goes quiescent or the frame is removed.
- All verdicts are computed deterministically by the top frame — no cross-frame response races, which is what keeps the restriction note stable while you drag the slider.
- Same-window spoofed messages are ignored (`event.source === window`), so page scripts cannot fake or clear a verdict.
- Engine detection (v6.13): the UA string is checked **FIRST** — a UA containing `Firefox/` identifies Gecko (DRM media is routable, and routed only after `setMediaKeys()` succeeds) — with `navigator.userAgentData` identifying Chromium-family browsers (protected-audio guard stays) checked second. The order matters: a future Firefox that grows a `userAgentData` shim must still classify as Gecko (issue #68). Unknown or privacy-stripped UAs keep the conservative guard.

**Verification:** the restriction pipeline was live-tested against real Widevine playback on udio.com and against a real cross-origin CDN audio source replicating detached-player sites (treblo.com pattern), plus a ClearKey EME harness — restricted media is never routed, the verdict is stable, and fallback attenuation is exact. The engine split was confirmed empirically: on Chromium, routing an element with MediaKeys produces graph silence even for clear audio (measured 0.00 RMS through the route vs 3.53 RMS for the same route on a non-DRM element). The Firefox side was additionally verified **live on a real Firefox 155.0.1** (headless, driven via WebDriver with a locally installed real Widevine 4.10.3112.0 CDM): a genuine `com.widevine.alpha` key system access grant, MediaKeys attached to an MSE-backed element, and the element routed by the hook with **audible output measured through the WebAudio destination (2.13 RMS at +20 dB, gain exactly 10.0) — vs 0.00 RMS for the identical keys-attached setup on Chromium**. Same-origin boost, WebAudio graph insertion (exact gain math), and cross-origin refusal were all re-verified in the same Firefox run, and a Widevine-disabled Chromium run (Brave-style) confirmed clear-media boost is unaffected while a granted CDM still engages the guard. **PlayReady parity** was verified twice: deterministically (harness scenario v13 — the exact key system string `com.microsoft.playready.recommendation.3000` flags the page and element identically to Widevine on both engines: Firefox routes + boosts + unrestricted verdict; Chromium/Edge restricted + never routed; a rejected probe never flags the page), and **live on real Firefox** (`mode=firefox-playready`: the genuine native probe rejects with `NotSupportedError` *without* setting the page-EME flag; a PlayReady-shaped grant resolving through the hook's wrapper flags the page, the element gets the sticky restricted flag, and it is still routed with route gain exactly 10.0 and **audible output — 3.54 RMS, identical to the same run's clear-media control**). Since v6.12.1 the **packaged extension itself has also been install-verified on real Firefox 155** (temporary add-on via WebDriver — the v6.12 manifest was rejected at install time before the dual-key background fix): both content-script worlds run, engine detection returns Gecko, and a driven +20 dB boost routed a real element with route gain exactly 10.0. Harness: `analysis/harness/firefox-live.mjs` + `analysis/harness/firefox-playready-live.mjs` + `analysis/harness/firefox-addon-load.mjs` (+ `vc-test.html?engine-test=1`), results in `analysis/harness/firefox-live-result.json`, `analysis/harness/firefox-playready-result.json`, `analysis/harness/firefox-addon-fixed.stderr.log`, and `brave-sim-result.json`.

## Known Limitations

- **Release builds must be produced with the fixed pipeline** — see the new **Release Builds** section below. Releases built with the pre-6.16 `build.ps1` from v6.13–v6.15 sources ship a `shared.js` SyntaxError and are completely inert.

- Volume Control cannot run on browser system pages such as `chrome://`, `edge://`, `about:`, extension pages, or other protected browser UI.
- DRM-protected media on **Chromium browsers** (Chrome/Edge/Brave/Opera/Vivaldi) can only use the native volume fallback: lowering and mute work; boosting and mono do not (the browser silences WebAudio for protected audio). If Widevine is disabled on such a browser (Brave's default), DRM sites simply won't play anything — non-DRM audio is unaffected and boosts identically. On **Firefox**, DRM media is fully boostable since v6.12. See [Restricted Media](#restricted-media-drm--cross-origin).
- Cross-origin media without CORS can only use the native volume fallback in every engine: lowering and mute work; boosting and mono do not.
- Sites that create their own `createMediaElementSource` pipeline for the same element can end up double-attenuating when Volume Control also routes that element.
- Media that becomes cross-origin-tainted *after* it was already routed cannot be un-tainted; routing continues with the gain that was already applied.
- Sites with unusual, heavily customized, or late-changing WebAudio graphs may not be fully controllable in every playback path.

## Release Builds (read this before packaging)

`scripts/build.ps1` creates Chrome and Firefox folders and ZIPs in `dist/`. It
minifies the packaged JavaScript with [Terser](https://terser.org/), generates each
browser's manifest, and compresses the ZIP entries. Source files stay unchanged;
HTML, CSS, icons, and the license are copied byte-for-byte.

The old regex-based comment stripper could mistake parts of JavaScript regex
literals for comments, producing a **SyntaxError** that prevented the extension
from starting. It could also change template-literal whitespace and corrupt UTF-8
text on Windows PowerShell. Terser parses JavaScript correctly and reads/writes
UTF-8 explicitly. The build removes comments and unnecessary whitespace, with
compression rewrites and name mangling disabled to preserve cross-script names.

Install Node.js 18 or newer and PowerShell. From the repository root, install the
pinned build dependencies once (and again when `package-lock.json` changes), then
build and run the regression checks:

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
npm test
```

Use `npm.cmd` if Windows PowerShell blocks `npm.ps1`. The build checks that Node,
`scripts/minify.mjs`, and Terser are available before replacing an existing release,
and stops if JavaScript cannot be minified.

`scripts/fixtures/` holds sample JavaScript with regression cases; these files are
test inputs and are not included in the extension. `scripts/test-build.mjs` builds
both browser variants in a temporary directory and checks minification, original
source preservation, JavaScript syntax, regexes, templates, Unicode, shared URL
helpers, and build errors. Run it through `npm test` or directly with
`node --test scripts/test-build.mjs`.

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

## Changes since 6.11 (through 6.16)

These updates improve Firefox media compatibility, restore volume after track changes, add path-based site exclusions, and fix release-build minification. See the [full source comparison](https://github.com/Chaython/volumecontrol/compare/V6.11...1b91cc94f1a27469334ef3b88a7f9e51780f59b3).

---

<details open>
<summary><strong>Versions 6.15–6.16 – Patch Notes</strong></summary>

The popup/options changes previously labeled 6.15 and the 6.16 build changes are included together in the 6.16 commit.

- **Fixed broken release builds:** replaced regex-based comment stripping that could corrupt JavaScript and prevent the extension from starting. Terser now removes comments and unnecessary whitespace while preserving names, regex literals, template contents, and UTF-8 text.
- **Clearer exclusion messages:** the popup identifies the blocklist entry disabling the current page and explains how to re-enable it. Whitelist exclusions explain that only remembered sites are controlled. Exclusion status is read directly from saved settings, so it also works when the content script cannot reply.
- **Easier list editing:** press Enter to add a site or path in Settings. Duplicate blocklist entries and remembered sites show an inline notice and keep the typed text for editing.
- **Safer build failures:** check for Node, the minifier helper, and Terser before replacing existing output. Invalid JavaScript stops packaging instead of producing a broken ZIP. Original source files stay unchanged.
- **Added build regression checks:** `npm test` builds both browser variants and checks minification, script parsing, regex/template/Unicode behavior, URL and blocklist helpers, source preservation, and failure handling. Test fixtures and build tools are excluded from release packages.
- **Add dangerous DRM capture override:** Settings now includes a debug-only option that bypasses DRM/EME routing safeguards and attempts WebAudio capture anyway. The UI warns that this may mute audio, stop protected media from loading, or break playback; cross-origin safety checks remain enforced.
- **Add routing diagnostics:** Settings now also has a debug-only CORS bypass and an HTML-media route override (Automatic / Force WebAudio / Force native fallback). These are intentionally dangerous compatibility tools; CORS-bypassed WebAudio can output silence, and forced native fallback cannot boost or mono-process HTML media.
- **Fix playlist transition volume spikes:** the page's own media volume is tracked separately from Volume Control's dB gain. Native attenuation is applied immediately when a site rewrites `video.volume`, while existing WebAudio routes remain associated with reused media elements across playlist transitions.
- **Fix debug override limiter consistency (v6.19):** DRM and CORS debug overrides now apply at the final boost-limit verdict layer too, so stale fallback flags, MAIN-world aggregate restrictions, and iframe reports cannot keep the popup/slider clamped after the matching override is enabled. Force WebAudio remains a routing choice; DRM/CORS bypasses remain independent explicit safety overrides.
- **Fix debug override limiter consistency (v6.19):** DRM and CORS debug overrides now apply at the final boost-limit verdict layer too, so stale fallback flags, MAIN-world aggregate restrictions, and iframe reports cannot keep the popup/slider clamped after the matching override is enabled. Force WebAudio remains a routing choice; DRM/CORS bypasses remain independent explicit safety overrides.
- **Build setup:** Node.js 18+ and `npm ci` are now required. `build.ps1` runs minification and packaging; `npm test` runs the regression checks separately.

</details>

---

<details>
<summary><strong>Version 6.14 – Patch Notes</strong></summary>

- **Faster boosting on clear media:** replaced the fixed three-second routing delay on pages that probe DRM support with playback-progress checks. Clear media, such as Plex direct-play content, can be boosted once playback advances without DRM evidence.
- **Path-based exclusions in Settings:** add entries such as `example.com/videos` or `example.com/videos/*`. A `*` matches characters within a path segment; entries without a path still block the domain and its subdomains.
- **Earlier legacy cleanup:** remove obsolete Twitch defaults during extension install/update, browser startup, and background initialization, in addition to the content-script migration.
- **Recheck changing media:** reset playback-progress checks when a source changes or the page creates media keys, so a previous source's progress does not clear the new source for routing.

</details>

---

<details>
<summary><strong>Version 6.13 – Patch Notes</strong></summary>

- **More reliable volume across track changes:** retry delayed native-volume corrections and periodically check for volume drift when sites reset their players, addressing playlist transitions and replayed clips.
- **Fix Firefox DRM startup ordering:** wait for media keys to attach before routing protected audio, addressing player failures caused by capturing audio too early. Firefox identification also takes priority over Chromium-style capability hints.
- **Reduce false DRM restrictions:** checking whether the browser supports DRM no longer automatically clamps clear media to 0 dB or displays a restriction warning. The restriction verdict now requires evidence from the media element.
- **Fix legacy Twitch exclusions:** match stored path entries against their paths instead of blocking the entire domain, and remove obsolete default Twitch entries in a one-time migration.
- **Make the Active switch recover excluded pages:** enabling the extension removes every blocklist entry matching the current URL before reloading, including legacy and wildcard entries.

</details>

---

<details>
<summary><strong>Version 6.12.2 – Patch Notes</strong></summary>

- **Declare Chromium 121 as the minimum version:** make the compatibility requirement for the shared source manifest explicit. Firefox's minimum remains 128.

</details>

---

<details>
<summary><strong>Version 6.12.1 – Patch Notes</strong></summary>

- **Fix Firefox loading from the source folder:** declare Firefox background scripts alongside Chromium's service worker, with `shared.js` loaded before `background.js`.
- **Respect site-controlled mute:** fallback volume handling only clears a native mute applied by the extension, rather than unmuting media the site had muted.
- **Limit repeated volume writes while paused:** apply the same rate limit used during playback when a site's volume manager keeps changing the native volume.
- **Preserve player borders:** normal audio-hook setup no longer clears a site's inline border when extension debugging is off.

</details>

---

<details>
<summary><strong>Version 6.12 – Patch Notes</strong></summary>

- **Enable Firefox DRM audio controls:** allow boosting and mono processing for protected audio on Firefox instead of applying Chromium's DRM restriction to every browser.
- **Keep browser-specific safeguards:** Chromium and unidentified engines continue to use native volume fallback for protected media. Cross-origin media without the required CORS access remains restricted on all engines.

</details>

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
| `shared.js` | Loaded into multiple contexts (content script, popup, options, background) | ✅ | ✅ (guarded) | ❌ | Pure utility library — dB conversion, media element helpers, domain parsing, bridge constants, frame-targeted messaging helpers, error helpers | The only file that appears in multiple contexts; guards all `chrome.*` calls so it doesn't crash in contexts without extension APIs |
| `page-audio-hook.js` | **MAIN world** content script | ✅ Page's `window` | ❌ | ✅ **Yes** | Patches `AudioNode.prototype.connect`, `HTMLMediaElement.prototype.volume`, `HTMLMediaElement.prototype.play`, `window.Audio`, `document.createElement`, `setMediaKeys`/`requestMediaKeySystemAccess` (EME detection) to insert gain nodes into the page's audio graph and track every media element (attached, detached, or shadow-DOM) | **Must** run in MAIN world — prototype patches only affect code in the same JS realm; extension APIs are stripped from MAIN world for security |
| `cs.js` | **ISOLATED world** content script | ✅ Clean `window` | ✅ | ❌ | Content script bridge — reads/writes `chrome.storage`, handles messages from popup/background (top-frame targeted), syncs state to `page-audio-hook.js` via `window.postMessage`, computes the boost-limit verdict (DRM/cross-origin) including the hook's aggregate flag and iframe reports, manages fallback volume for cross-origin/DRM media | **Must** run in ISOLATED world to access `chrome.storage` and `chrome.runtime` APIs; communicates with MAIN world via `postMessage` |
| `background.js` | **Background** (Chrome: service worker / Firefox: event page) | ❌ No DOM | ✅ | ❌ | Handles keyboard shortcuts (`Alt+Shift+Up`/`Down`/`0`/`M`), shows native volume feedback badge, manages per-site remembered settings | Runs globally (not per-tab), has no DOM access, gets killed when idle; can't be merged with page-context scripts. Loads `shared.js` via `importScripts` in the service-worker world and via the manifest's `scripts` array on Firefox (dual-key background) |
| `popup.js` | **Popup page** (`popup.html`) | ✅ Own DOM | ✅ | ❌ | Popup UI logic — volume slider, mono toggle, remember-site checkbox, enable/disable switch, restriction note ("restricted by DRM"), debounced storage writes, focus management for accessibility, 1 s state polling while open (never touches the slider mid-drag) | Runs in `popup.html`'s isolated DOM; separate from options page because popup logic and options logic have no overlapping DOM concerns |
| `options.js` | **Options page** (`options.html`) | ✅ Own DOM | ✅ | ❌ | Options UI logic — blocklist/whitelist management, remembered-sites editor, debug mode toggle, live storage sync | Runs in `options.html`'s isolated DOM; separate from popup because it manages different UI with different lifecycle (stays open vs. closes on action) |
| `manifest.json` | Extension manifest | — | — | — | Declares permissions, content scripts (with world specification), the dual-key background (service worker for Chrome 121+ + scripts for Firefox event pages) plus the `minimum_chrome_version: "121"` floor, action popup, options page, keyboard commands, Firefox compatibility | Defines which scripts load in which world; the only place where the MAIN/ISOLATED split and the cross-browser background shape are configured |
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
// manifest.json — the MAIN-world entry loads the hook alone; shared.js is
// only in the ISOLATED entry (but is also loaded by popup/options/background
// via <script>/importScripts-style includes in their own contexts)
{
  "js": ["page-audio-hook.js"],          // MAIN world
  "world": "MAIN"
},
{
  "js": ["shared.js", "cs.js"]                // ISOLATED world (default)
}
```

It guards all `chrome.*` calls with optional chaining (`if (!browserApi?.storage) return ...`) so it doesn't crash when loaded in MAIN world where `browser`/`chrome` are undefined.

### Minimum File Count

**5 execution contexts → 5 files** (background, page-audio-hook, cs, popup, options)
**1 shared library → shared.js** (loaded by 4 of the 5 contexts)

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
