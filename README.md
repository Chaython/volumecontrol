***

<p align="center">
<a href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"><img src="https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png" alt="Get Volume Control for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"><img src="https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png" alt="Get Volume Control for Microsoft Edge"></a>
</p>

***


## Description

Volume Control adds a simple per-site volume control to your browser. It can lower volume, boost HTML5 audio and video above the normal browser limit, and optionally play stereo audio as mono. The extension is useful for quiet videos, uneven site volume, embedded players, and pages that do not provide enough audio control on their own.

Settings can be remembered per site, and you can exclude sites where you do not want the extension to run. Volume Control supports HTML5 video and audio only; it does not support Flash.

Excluded-site entries match by domain, and entries saved **with a path** (such as the legacy V4-era defaults) are wildcard-matched against the full URL — so `www.twitch.tv/*/clip/*` excludes only the clip pages while the rest of Twitch runs. A one-time v6.13 migration removes the legacy Twitch default entries that older builds left in users' stored storage (path and `www.` normalization had turned them into a block on the whole domain — issue #69), and the popup's Active toggle now removes **every** entry that blocks the current page — not just the exact domain match — with a tooltip explaining what it removed.

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
- **Pending grace window** (v6.13): on EME-probed pages, `blob:` (MSE) sources without per-element evidence are not routed for a 3-second window (`EME_PENDING_GRACE_MS = 3000`) — the birth-window safety preserved from v6.9, which is what keeps real DRM such as udio.com un-routed before `encrypted`/keys land. The clock **restarts whenever the page actually creates MediaKeys** (the `createMediaKeys` patch — keys are imminent). Once the window expires with no evidence, clear content routes normally (Plex boosts after ~3 s; on Gecko, Netflix routes immediately once keys attach).
- The MAIN-world hook computes one aggregate page verdict over **every** element it tracks — attached to the DOM, detached (JS-created players that never touch the DOM), or inside a shadow DOM — and publishes it with immediate change notifications.
- Embedded iframes report their verdict to the top frame (1 s heartbeat, 2.5 s TTL) and the most restrictive live report wins; the verdict relaxes automatically when the media goes quiescent or the frame is removed.
- All verdicts are computed deterministically by the top frame — no cross-frame response races, which is what keeps the restriction note stable while you drag the slider.
- Same-window spoofed messages are ignored (`event.source === window`), so page scripts cannot fake or clear a verdict.
- Engine detection (v6.13): the UA string is checked **FIRST** — a UA containing `Firefox/` identifies Gecko (DRM media is routable, and routed only after `setMediaKeys()` succeeds) — with `navigator.userAgentData` identifying Chromium-family browsers (protected-audio guard stays) checked second. The order matters: a future Firefox that grows a `userAgentData` shim must still classify as Gecko (issue #68). Unknown or privacy-stripped UAs keep the conservative guard.

**Verification:** the restriction pipeline was live-tested against real Widevine playback on udio.com and against a real cross-origin CDN audio source replicating detached-player sites (treblo.com pattern), plus a ClearKey EME harness — restricted media is never routed, the verdict is stable, and fallback attenuation is exact. The engine split was confirmed empirically: on Chromium, routing an element with MediaKeys produces graph silence even for clear audio (measured 0.00 RMS through the route vs 3.53 RMS for the same route on a non-DRM element). The Firefox side was additionally verified **live on a real Firefox 155.0.1** (headless, driven via WebDriver with a locally installed real Widevine 4.10.3112.0 CDM): a genuine `com.widevine.alpha` key system access grant, MediaKeys attached to an MSE-backed element, and the element routed by the hook with **audible output measured through the WebAudio destination (2.13 RMS at +20 dB, gain exactly 10.0) — vs 0.00 RMS for the identical keys-attached setup on Chromium**. Same-origin boost, WebAudio graph insertion (exact gain math), and cross-origin refusal were all re-verified in the same Firefox run, and a Widevine-disabled Chromium run (Brave-style) confirmed clear-media boost is unaffected while a granted CDM still engages the guard. **PlayReady parity** was verified twice: deterministically (harness scenario v13 — the exact key system string `com.microsoft.playready.recommendation.3000` flags the page and element identically to Widevine on both engines: Firefox routes + boosts + unrestricted verdict; Chromium/Edge restricted + never routed; a rejected probe never flags the page), and **live on real Firefox** (`mode=firefox-playready`: the genuine native probe rejects with `NotSupportedError` *without* setting the page-EME flag; a PlayReady-shaped grant resolving through the hook's wrapper flags the page, the element gets the sticky restricted flag, and it is still routed with route gain exactly 10.0 and **audible output — 3.54 RMS, identical to the same run's clear-media control**). Since v6.12.1 the **packaged extension itself has also been install-verified on real Firefox 155** (temporary add-on via WebDriver — the v6.12 manifest was rejected at install time before the dual-key background fix): both content-script worlds run, engine detection returns Gecko, and a driven +20 dB boost routed a real element with route gain exactly 10.0. Harness: `analysis/harness/firefox-live.mjs` + `analysis/harness/firefox-playready-live.mjs` + `analysis/harness/firefox-addon-load.mjs` (+ `vc-test.html?engine-test=1`), results in `analysis/harness/firefox-live-result.json`, `analysis/harness/firefox-playready-result.json`, `analysis/harness/firefox-addon-fixed.stderr.log`, and `brave-sim-result.json`.

## Known Limitations

- Volume Control cannot run on browser system pages such as `chrome://`, `edge://`, `about:`, extension pages, or other protected browser UI.
- DRM-protected media on **Chromium browsers** (Chrome/Edge/Brave/Opera/Vivaldi) can only use the native volume fallback: lowering and mute work; boosting and mono do not (the browser silences WebAudio for protected audio). If Widevine is disabled on such a browser (Brave's default), DRM sites simply won't play anything — non-DRM audio is unaffected and boosts identically. On **Firefox**, DRM media is fully boostable since v6.12. See [Restricted Media](#restricted-media-drm--cross-origin).
- Cross-origin media without CORS can only use the native volume fallback in every engine: lowering and mute work; boosting and mono do not.
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
<summary><strong>Version 6.13 – Patch Notes</strong></summary>

- Fixed   [HIGH] **Playlist track change reset the volume to the site's default for 1–10 s — or forever** (issue #71: "Volume resets to default every time new video in playlist loads, takes 1-10s to return" — YouTube playlist randomizer; Facebook reels replay): for attenuation-only state the hook applies the native fallback volume (`element.volume = base × min(gain, 1)`), and sites reset `element.volume` to their own default on track change/replay; a corrective write skipped by the 250 ms write-war guard was previously **dropped**, and with no further media event (event starvation) the site's loud default stuck — 1–10 s on YouTube (until the player's next event) or indefinitely on Facebook reels (until the user manually moved the slider). A skipped correction is now **scheduled** (deferred corrective write ~250 ms later), and a 1 s audit re-applies the fallback whenever a playing, unrouted, audible element's raw native volume has drifted from the expected scaled value. The write-war bound is preserved: at most one corrective write per 250 ms
- Fixed   [HIGH] **Stopped working on desktop Firefox + Twitch** (issue #69): two stacked bugs. (1) V4-era builds seeded default blocklist entries WITH PATHS into users' stored storage (`"www.twitch.tv/*/clip/*"`, `"clips.twitch.tv"`) and never cleaned them; the matcher's normalization strips paths (and since 6.11 also `"www."`), so the legacy entry began matching the whole twitch.tv domain — deactivating the extension everywhere on Twitch. (2) The popup's Active toggle removed entries by exact indexOf(normalized domain), so the raw legacy entry could never be removed — toggling Active reloaded the page but stayed off. Fixed with path-aware blocklist matching (entries with a path are wildcard-matched against the full URL — clip pages stay blocked, the main site doesn't), a one-time migration that removes the legacy Twitch defaults from storage, and a popup Active toggle that removes EVERY entry blocking the current URL (with a tooltip explaining what it did); background, content script, and popup all use the same path-aware matcher
- Fixed   [HIGH] **Netflix broken on Firefox** (issue #68): Gecko genuinely routes DRM audio through WebAudio (Mozilla bug 1331763, Firefox 55+ — only captureStream *video* is blocked), so DRM is boostable on Firefox — but v6.12.1 also allowed routing BEFORE the site attached MediaKeys, and Gecko's `setMediaKeys()` throws `NotSupportedError` on an already-audio-captured element, breaking the site's player (the reason the 6.12 "regression" commit existed). EME elements are now routed only AFTER `setMediaKeys()` succeeds (keys-attached marker; the patched `setMediaKeys` applies state on success), and engine detection checks the Firefox UA string FIRST (`navigator.userAgentData` second), so a future Firefox that grows a `userAgentData` shim is not misclassified
- Fixed   [MED] **Boost wrongly clamped to 0 dB on app.plex.tv since 6.9** (issue #70: "Cannot boost volume after 6.11 on app.plex.tv" — the clamp itself dates to the v6.9 heuristic): the v6.9 "page granted EME access + `blob:` source" heuristic produced a permanent false "restricted" verdict on pages that merely PROBE DRM capability — app.plex.tv probes all three key systems at startup (verified in its production bundle) while playing clear direct-play content, so boost was clamped to 0 dB on ALL engines since v6.9. The "restricted" verdict now requires per-element DRM evidence (`encrypted` fired / `setMediaKeys` called / `element.mediaKeys` set) — probing alone never shows the note. ROUTING is still refused during a 3-second "pending" grace window on EME-probed pages for `blob:` sources without evidence (birth-window safety preserved from v6.9 — the clock restarts when the page actually creates MediaKeys), after which clear content routes normally: Plex boosts after ~3 s, and on Gecko Netflix routes immediately once keys attach
- Kept     Cross-origin (no-CORS) media stays guarded on every engine (spec-mandated silence), and the udio.com birth-window safety is preserved — real DRM evidence within the 3 s window still means never routed + "restricted" verdict once the evidence lands
- Verified     Three new automated A/B harness scenarios against the previous sources plus the full regression suite: `scenario-firefox-drm.js` (Gecko birth-window flow: v6.12.1 throws `NotSupportedError` from the site's `setMediaKeys` — site broken; v6.13 does not throw and routes with correct gain after keys attach. Plex probe pattern: v6.12.1 showed the false "restricted" verdict — `boostLimited=true`, never routed; v6.13 shows no note and routes after the grace window. udio.com birth-window safety passes on both), `scenario-trackchange.js` (v6.12.1 stays at the site's 1.0 for 2 s+ of total event starvation; v6.13 corrects within ~250 ms deferred / ~1 s audit backstop, write-war bound preserved at ≤1 corrective write per 250 ms), `scenario-blocklist.js` (with the V4 legacy entries in storage the old sources block the whole twitch.tv domain and the Active toggle cannot recover; v6.13: path-aware matching, one-time migration, popup toggle removing every blocking entry) — and the full 16-scenario regression suite green, fuzz clean (seed 424242, 1,500 iterations)

</details>

---

<details>
<summary><strong>Version 6.12.2 – Patch Notes</strong></summary>

- Fixed   [HIGH] **"Load unpacked" failed on Chromium 120 and older with `'background.scripts' requires manifest version of 2 or lower.`** — the error appears exactly when the dual-key background introduced in 6.12.1 is loaded into a Chromium that predates 121 (or a validator applying pre-121 rules). The key combination itself is correct and stays: it is the **only** single-manifest form that works on both engines. What changed: the manifest now declares **`minimum_chrome_version: "121"`**, so store installs on older Chromium fail with a clear version message instead of a cryptic manifest error, and the floor is documented instead of implicit
- Verified     **Empirical background-key compatibility matrix — every cell live-tested** (`analysis/harness/manifest-chrome-load.mjs` + `manifest-unpacked-cdp.mjs`, real Chrome for Testing 120 / 121 / 152): Chrome 120 rejects *any* MV3 manifest containing `background.scripts` (fatal, extension never registers); **Chrome 121+ accepts the dual-key and runs the service worker from `service_worker`, ignoring `scripts`** (verified on 121 and 152 via both the startup `--load-extension` path and the `Extensions.loadUnpacked` CDP path — the exact code behind the chrome://extensions "Load unpacked" button; background worker starts and registers in both); **`scripts`-only is silently broken on all Chromium** — the extension installs but gets *no background at all* (no hotkeys, no badge; zero service-worker registrations on 152), so it must never be used as a "cross-browser" form; Firefox 128+ runs the event page from `scripts` and ignores `service_worker` (live-verified in 6.12.1); Firefox rejects `service_worker`-only at install time. Conclusion: dual-key + the Chrome 121 floor is the only correct cross-browser answer
- Verified     **Firefox 155 regression on the packaged 6.12.2 zip** (temporary add-on via WebDriver): installs cleanly with `minimum_chrome_version` present (Firefox ignores the key — no warnings in the install log), both content-script worlds run, engine detection returns Gecko, and a driven +20 dB boost routed a real element with route gain exactly 10.0 (mono gains 0.5/0.5), bridge restriction events flowing

</details>

---

<details>
<summary><strong>Version 6.12.1 – Patch Notes</strong></summary>

- Fixed   [HIGH] **The extension could not be installed on Firefox at all**: the manifest declared only `background.service_worker`, which Firefox rejects at install time ("background.service_worker is currently disabled. Add background.scripts."). v6.12's Firefox DRM-boost feature was therefore unreachable as a packaged add-on (all prior Firefox verification had injected the hook as a page script, which bypasses the manifest). The background now uses the standard dual-key form — `service_worker` for Chrome + `scripts` for Firefox's event page — verified live by installing the packaged zip as a temporary add-on in real Firefox 155
- Fixed   [MED] The content script's fallback path force-unmuted elements the **site** had muted (muted autoplay ads, site mute buttons) whenever volume attenuation was active; only a native mute the extension itself applied is ever toggled now (tracked via `data-vc-native-muted`)
- Fixed   [LOW] Fallback native-volume writes while an element is paused were not rate-limited, so a site volume manager answering every `volumechange` could re-ignite the v6.11 write war during pause; the paused branch now uses the same 250 ms floor
- Fixed   [LOW] The fallback hook path cleared `element.style.border` unconditionally in non-debug mode, wiping inline borders the site styled its player with; only borders the extension painted (debug mode) are ever removed
- Verified     **The packaged extension installs and works on real Firefox 155** (temporary add-on via WebDriver): both content-script worlds run (MAIN hook marker + `vc-init`), engine detection returns Gecko, and a driven +20 dB boost routed a real element through WebAudio with route gain exactly 10.0. A probe add-on replicating the exact background pattern proved the event-page path (`importScripts` absent, `shared.js` loaded via the `scripts` array, shared globals visible). Chrome keeps using the service worker (the dual-key background is the documented cross-browser recipe; Chrome **121+** ignores the `scripts` key — Chrome 120 and older rejects the manifest, see 6.12.2 for the live-tested version matrix and the 121 floor). Full regression: scenarios A/B/D/E/F2/F3/treblo/udio/v11/v12/v13 + fuzz (single-world 2,000 iterations + 8 dual-world seeds) all clean

</details>

---

<details>
<summary><strong>Version 6.12 – Patch Notes</strong></summary>

- New   **DRM audio boosting on Firefox**: Mozilla explicitly allows capturing EME media audio through WebAudio (bug 1331763, Firefox 55+ — only video capture is blocked), so Volume Control now detects the engine and routes DRM media normally on Firefox. Boost, mono, and mute work on Netflix, Spotify web, and other Widevine/PlayReady sites in Firefox — matching what simpler competitor boosters have shipped for years
- Fixed   The DRM guard was over-conservative on Firefox: DRM media was refused routing and the slider clamped at 0 dB even though Firefox plays routed EME audio normally (the "why does the other booster work on Netflix" report)
- Kept     Chromium-family browsers (Chrome, Edge, Brave, Opera, Vivaldi) keep the full guard: routing an element with MediaKeys feeds the graph silence there (verified live: 0.00 RMS through a +20 dB route on a keys-attached element vs 3.53 RMS on the same route without keys) — refusal + native fallback remains the correct behavior
- Kept     Cross-origin (no-CORS) media stays guarded on every engine — the WebAudio spec silences routed tainted media in all browsers, Firefox included
- Improved     Engine detection is conservative: `navigator.userAgentData` proves Chromium; a `Firefox/` UA proves Gecko; unknown or privacy-stripped UAs keep the restricted verdict (never relax on doubt)
- Verified     **Live on a real Firefox 155.0.1** (headless WebDriver run with a locally installed real Widevine 4.10.3112.0 CDM): engine detection returns Gecko; an MSE-backed element with genuine Widevine MediaKeys attached is routed and **audible** through WebAudio (2.13 RMS at +20 dB, route gain exactly 10.0) while the identical keys-attached setup on Chromium measures 0.00 RMS; same-origin boost (3.54 RMS) and WebAudio insertion (exact gain math) match Chromium, and cross-origin media stayed refused in the same run. A Widevine-disabled Chromium run (Brave-style) confirmed clear-media boost is identical (3.54 RMS) with no false restriction verdict, while a granted CDM (ClearKey attached before playback) still refuses routing. **PlayReady parity** additionally verified (deterministic scenario v13 + a live Firefox run with a PlayReady-shaped `com.microsoft.playready.recommendation.3000` grant: routed, audible at 3.54 RMS, unrestricted verdict; rejected probes never flag the page — Firefox's own `com.microsoft.playready.recommendation.3000` console warning is informational browser output aimed at site developers, not an extension error)

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
