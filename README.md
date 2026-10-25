***

<p align="center">
<a href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"><img src="https://user-images.githubusercontent.com/585534/107280546-7b9b2a00-6a26-11eb-8f9f-f95932f4bfec.png" alt="Get Volume Control for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"><img src="https://user-images.githubusercontent.com/585534/107280673-a5ece780-6a26-11eb-9cc7-9fa9f9f81180.png" alt="Get Volume Control for Microsoft Edge"></a>
</p>

***



## 🎧 What is Volume Control?

**Volume Control** gives you per-site volume control for HTML5 audio and video in Firefox and Chromium-based browsers. Lower quiet audio, boost media beyond the browser's normal volume range, toggle mono, mute, and optionally normalize loudness.

<table>
<tr><th>✨ Feature</th><th>What it does</th></tr>
<tr><td>🔊 Volume boost</td><td>Adjust media from −32 dB to +32 dB where the browser permits WebAudio routing.</td></tr>
<tr><td>🎚️ Per-site settings</td><td>Remember volume, mute, mono, and normalization choices by site or URL path.</td></tr>
<tr><td>🎵 Normalization</td><td>Optional automatic loudness adjustment, with Music and Adaptive modes.</td></tr>
<tr><td>🚫 Site exclusions</td><td>Exclude domains or path-specific URLs, including wildcard patterns.</td></tr>
</table>

### 🌐 Compatibility

- **Firefox 128+**
- **Chromium 121+** — Chrome, Edge, Brave, Opera, and Vivaldi

> [!NOTE]
> Volume Control supports HTML5 audio/video, not Flash. Browser-protected pages such as `chrome://` and extension pages cannot be controlled.

## 📈 Live usage & repository statistics

[![Volume Control live statistics](docs/stats.svg?v=1792889129700)](docs/stats.html)

The SVG card is refreshed daily by GitHub Actions when the workflow is running. The [interactive HTML dashboard](https://chaython.github.io/volumecontrol/stats.html) shows Firefox average daily users and weekly downloads, GitHub views/clones (14-day window), stars, and referrers where available. GitHub README pages can display the generated SVG but cannot execute an interactive HTML/JavaScript widget inline; its source is in [`docs/stats.html`](docs/stats.html).

- **GitHub traffic:** configure the repository Actions secret `GH_TRAFFIC_TOKEN` with a fine-grained token that has **Administration: read** permission for this repository. Without it, GitHub's private traffic endpoints remain unavailable; public star/fork counts still work.
- **Chrome Web Store:** the supported public API does not expose publisher analytics. Weekly users must be viewed in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole/); the widget deliberately marks this metric unavailable rather than inventing a number.
- **Interactive page hosting:** the repository currently has Pages disabled. Enable **Settings → Pages → Build and deployment → GitHub Actions** once; the guarded deployment workflow will then publish the dashboard and subsequent statistics refreshes automatically. Until then, the HTML source is committed but the hosted dashboard link is not live.


<details>
<summary>🧭 Settings, remembering, and site exclusions</summary>

- **Remember** controls whether settings persist across browser sessions. With it off, each tab keeps its own unsaved volume, mono, and mute state through playlists and single-page-app navigation; a new tab or full reload starts from defaults.
- Whitelist authorization is independent from remembered audio settings.
- Exclusion entries can match a whole domain or a URL path. For example, `www.twitch.tv/*/clip/*` excludes matching clip pages without blocking all of Twitch. In path patterns, `*` matches any characters except `/`.
- The options page supports adding path-scoped exclusions, including `example.com/videos`. The popup's Active toggle removes every exclusion entry that currently blocks the page, and the popup explains when the current page is blocklisted.
- Legacy Twitch exclusions are migrated so old path entries do not accidentally block the entire domain.

</details>


## 🎚️ Normalization, Manual Volume & Peak Meter

**Normalize is opt-in and OFF by default.** Enable it for the current site/path using the **Normalize** switch in the popup. The live **Gain** readout and **output peak meter** expand only when that site's switch is on and WebAudio analysis is available; they fold away when it is off or temporarily unsupported. During Chromium DRM, cross-origin no-CORS, or Force native playback, the switch is **disabled and grayed out**, with an explanation displayed under it even if Normalize is off. A saved enabled preference is not erased: the switch can stay checked-but-disabled and automatically become active again once the page uses routable media. Firefox DRM audio can be normalized when Gecko provides a usable WebAudio route. In **Options → Normalizer**, **Normalize by default on sites without an override** controls the global default, and the target/boost/ceiling/response fields are folded away when the global default is off. A site-specific choice overrides the global default and is saved **separately** in `siteNormalizerSettings`; it does not require **Remember** and does not overwrite remembered volume, mute or mono.

### 🎵 Music vs. Adaptive normalization

**Normalization style** in Options offers two modes, independent of the per-site Normalize switch. Both analyze the source before the manual slider, target **−16 dBFS RMS** by default, respect the configured maximum automatic boost, and use measured sample-peak headroom to constrain unsafe positive boost. They differ in how quickly they react and how they handle a loud passage followed by a quiet one.

| Behavior | **Music (default)** | **Adaptive (legacy)** |
|---|---|---|
| Best suited for | Songs, albums, continuous music | Speech, videos, streams, and uneven mixed content |
| Loudness detector | Smoothed RMS envelope: about **350 ms attack** when a section gets louder and **900 ms release** when it gets quieter | Direct, fast RMS/peak decisions; no separate Music-style RMS envelope |
| Response setting | Uses purpose-built Music timing; the configurable **Response speed** does not control these Music time constants | **Response speed** controls the reaction; default is about **600 ms** |
| Increasing positive auto gain | Gradual, about **6 seconds**, after roughly **2.5 seconds** of warm-up | Faster, governed by the configured response |
| Reducing gain | About **1.6 seconds** for a lower desired target; an unsafe existing positive boost can be shed immediately | Direct target updates with the configured response; no Music-style gradual release |
| Recovering after a loud section | Once warmed up, recovers from prior attenuation toward unity in about **900 ms** when the quieter section calls for it | Follows the current detector target; does not use the Music-specific recovery behavior |
| Peak handling | Holds transient peak history for **4 seconds**, then releases the envelope at about **1.5 dB/s**. Peak headroom caps **positive boost only**; it cannot independently force extra negative gain on otherwise unboosted music | Peak headroom is part of the direct target calculation and can request negative gain |
| Silence / discontinuities | Brief quiet passages retain history; after about **3 seconds** of silence, positive automatic boost is discarded while protective attenuation is retained. Source/track changes, seeks, and Normalize changes reset stale history with protective handling | No equivalent Music-specific warm-up, peak hold, or quiet-section recovery policy |
| Main trade-off | Smoother musical dynamics and less unnecessary attenuation, but it cannot anticipate a sudden loud section | More immediate leveling, but peak changes can affect the requested gain more directly |

Music mode is designed to avoid carrying the attenuation from a loud section unnecessarily into the next quiet section. Peak headroom is a **limit on positive boost**, not an independent reason to turn down audio that is already at or below unity gain. A sudden peak can immediately cancel positive automatic boost for safety; this does not mean peak history should keep pushing otherwise unboosted music farther down.

**Multiple media players (isolated fallback):** The MAIN-world route already levels separately for each captured media element. The isolated-world compatibility fallback has a single shared input analyser, so it cannot reliably distinguish two playing sources. To prevent one quiet source from automatically amplifying another loud source, it temporarily suspends **automatic positive gain** while two captured elements play, immediately shedding old positive boost and preserving existing attenuation. Manual volume remains active. Per-source normalization resumes with fresh history when only one source is playing; this is a safety fallback, not full isolated per-player loudness processing.

### 🧪 Comparison tests & diagnostics

The normalizer regression suite exercises both the MAIN-world controller in `page-audio-hook.js` and the isolated fallback in `cs.js`. It checks that peak headroom does not independently deepen negative gain in Music mode, that attenuation can recover when the detector enters a quieter section, and that debug diagnostics include the values needed to inspect controller behavior.

For an audio excerpt comparison, the useful side-by-side measurements are sampled at **100 ms intervals**:

| Measurement | What it tells you |
|---|---|
| Input RMS (dBFS) | Short-window source loudness before the extension's gain |
| Input sample peak (dBFS) | Highest observed PCM sample in the current analysis window |
| Peak envelope (dBFS) | Held/releasing peak history used by Music mode |
| Desired gain (dB) | Controller's current target before the applied-gain ramp |
| Applied gain (dB) | Automatic gain actually being applied after smoothing |

With per-site debug mode enabled, the browser console emits rate-limited (~100 ms) `[Volume Control][Normalizer]` records containing route, mode, stage, input RMS, input sample peak, peak envelope, desired gain, and applied gain. These are level measurements only; the extension does not log or store audio samples. When comparing old and revised behavior, use the **same decoded excerpt and same sampling windows** for both controllers. An offline comparison describes the gain controller's response to those samples; it is not a measurement of browser speakers, site-side processing, or perceived loudness.

<details>
<summary>🛡️ Additional normalization behavior and safety notes</summary>

- Both modes analyze audio before the manual slider, so changing manual volume does not make the controller compensate.
- When manual gain and automatic gain are both nonpositive, Music mode moves its compressor threshold to 0 dBFS to avoid unnecessary compression of unboosted audio. Positive boost restores the configured threshold without disconnecting the route.
- Normalization uses RMS and sample peaks; it is not LUFS/ReplayGain scanning or a guaranteed true-peak brick-wall limiter.
- Music mode favors preserving within-song dynamics over instantly equalizing every passage. It cannot predict a sudden loud section, so use manual positive gain conservatively.

</details>

<details>
<summary>🔬 Offline true-peak research (not active in normal playback)</summary>



`scripts/audio-peak-lab.mjs` implements an **offline 4× windowed-sinc FIR inter-sample peak estimate** for PCM fixtures. It reads each channel separately, rather than using a stereo mono-downmix, and tests signals whose PCM sample peaks are below full-scale while reconstructed peaks exceed it. This test utility is **not** a certified BS.1770 true-peak meter and is **not** connected to the live audio graph; it adds no worklet dependencies, CSP requirements, or playback latency. A production limiter needs verified per-channel real-time oversampling, lookahead, attack/release handling, continuous audio blocks, format/sample-rate coverage, and safe routing transitions. This diagnostic does not make boosted playback clip-free.

A **prototype** `scripts/true-peak-lookahead.mjs` now implements continuous stereo-linked 4× FIR peak detection, a 5 ms lookahead delay, immediate attenuation with held gain and slow release. Regression fixtures at 44.1, 48 and 96 kHz compare reconstructed peaks before and after limiting, verify anti-phase stereo integrity, and require identical results for 128-frame chunks versus one large block. The Chrome and Firefox ZIP packages now include a generated `true-peak-worklet.js` module, built from the single `scripts/true-peak-lookahead.mjs` DSP implementation. The manifest exposes **only** that module as a web-accessible resource (no additional permission). This is for a browser capability probe: an actual page-origin OfflineAudioContext attempts to load it from the extension origin and records a supported/unsupported result and error. A successful page-origin test does not guarantee other sites' CSP permits worklet loading. If blocked, the current audio graph is untouched.

The Chromium functional smoke harness also loads the candidate via a **same-origin OfflineAudioContext AudioWorklet module** and checks real audio output, channel balance and attenuation. This verifies worklet execution in that browser, not cross-origin extension module loading. The DSP still needs harsher audio fixtures, CPU/runtime-budget testing, extension-origin module-loading/CSP verification, channel-layout handling, latency alignment and fail-safe route recovery before live use. **It is not connected to playback and does not limit music in the extension.**

</details>

<details>
<summary>🧪 Experimental true-peak playback (isolated fallback only)</summary>



Options → Normalize → **Experimental true-peak limiter (isolated fallback only)** is **off by default**. On an isolated compatibility WebAudio route, after positive manual boost or Normalize activates the protection path, the extension attempts to load its own packaged `true-peak-worklet.js` module into that AudioContext. Until it loads, the existing compressor continues to protect the output. Once loaded, a 4× FIR lookahead AudioWorklet replaces the compressor on that isolated route only, adding approximately 5 ms of delay and a 0.75 dB internal safety margin below the configured ceiling.

If the module fails to load/connect or the processor reports an error, the captured media source is **not recreated**: output edges reconnect through the existing compressor first. Direct-output recovery is still clamped to at most unity when both protection paths fail. The worklet resets its buffered audio when selected, and its threshold follows the saved compressor-threshold field.

**Scope limitations:** Most supported media and WebAudio streams may be controlled by the MAIN-world hook, which **still uses the original compressor**. DRM/CORS/native-only streams remain outside the normalizer and experimental limiter. The setting is a narrow engineering preview, not a guaranteed true-peak ceiling, and has not yet been subjected to complete multi-browser acoustic/latency testing. Disabling it returns the isolated route to its previous compressor. Do not enable for time-critical audio.

When Normalize's live meter is active, the popup warns when the *measured post-compressor sample peak* is within 0.3 dB of full-scale. The popup also shows a separate caution whenever the manual slider is set to +6 dB or above, even when Normalize is off (this is a boost warning, not a detected clipping event). This is a warning, not a true-peak reading or automatic gain clamp. The thin −1 dBFS marker is a fixed visual **reference**, not the configured compressor threshold or a guaranteed ceiling. In Options, “Compressor threshold” replaces the misleading “Limiter ceiling” label without changing saved settings.

</details>

<details>
<summary>🔀 Audio signal flow and gain stages</summary>



For supported WebAudio routes the MAIN-world page/MediaElement graph and ISOLATED-world fallback follow this signal chain:

```text
Audio source
   |-- input analyser (source RMS and sample peaks, 8192 samples)
   v
Extension gain (manual slider × automatic gain, independent controls)
   v
Optional mono mixing
   v
Safety compressor when Normalize is on or manual boost is positive
   v
Output analyser (post-compressor sampled peak) → speakers
```

- **Input analysis / automatic gain:** measures RMS *before* the extension's gain. The controller targets **−16 dBFS RMS** by default and does not adjust against the slider-adjusted output. Reducing the slider by −20 dB therefore retains approximately −20 dB of *relative* attenuation at the same source loudness, except when compression/limiting makes the output response nonlinear.
- **Safety guards:** source RMS at or below **−55 dBFS** is treated as near-silence; automatic gain is reset to unity so background noise does not attract a large boost. Invalid or missing detector readings also fail to unity. When above the gate, automatic gain is bounded by the **Maximum auto boost** (+12 dB default, configurable up to +24 dB), and by measured source sample-peak headroom (approximately **2 dB below the configured compressor threshold**, *before* the manual slider's gain). Music mode follows loud sections with a 350 ms RMS attack, quieter sections with a 900 ms release, sheds unsafe positive boost immediately on a fresh peak, and builds positive gain over about six seconds after warm-up. Adaptive mode uses the configured response time (600 ms default). Input analyser windows contain 8,192 samples (roughly 171 ms at 48 kHz) and are checked about every 100 ms, reducing gaps in transient detection.
- **Manual volume:** the −32…+32 dB slider applies a separate multiplier *after the source analysis*. Normalization does not increase gain just because you lower the slider. **Positive manual boost is not part of the source-only peak headroom budget** and can trigger substantial compressor reduction; +20 dB does not necessarily mean +20 dB more perceived loudness.
- **Compressor and peaks:** the WebAudio `DynamicsCompressorNode` processes audio when Normalize is on or manual boost is positive. With Normalize off and no positive boost, the output bypasses it where possible. The default **Limiter ceiling** field sets a **−1 dBFS compressor threshold**, **not** a guaranteed hard ceiling: this is **not** a look-ahead brick-wall true-peak limiter. Sudden attacks, inter-sample peaks, compressor latency, and large manual boosts can still clip or sound distorted.
- **Output meter and lifecycle:** the live meter displays sampled post-processor **sample peaks** in dBFS, **not** true peaks, LUFS or integrated perceived loudness. The Gain number describes *automatic* gain, not the manual slider value. Normalize enable/disable and reused-media source boundaries clear prior automatic gain; the 100 ms sampling timers stop when Normalize is off. The isolated-world 100 ms sampler also pauses during known DRM/CORS or forced-native fallback **and while its AudioContext is suspended for paused media**. It resumes when compatible playback restarts; an expired iframe restriction can also release the pause automatically.

</details>

<details>
<summary>⚠️ Unsupported media and practical limits</summary>



DRM-restricted streams on Chromium, cross-origin media without suitable CORS permission, and **Force native** mode cannot use WebAudio normalization; native attenuation/mute still works. A site can have its own audio processing, and some pages combine multiple players in one graph. The input analyser cannot predict sound that has not arrived yet, so sudden loud transients can still be heard before the compressor fully reacts. **Start at a low volume**, especially if you select the +24 dB maximum auto boost; reduce manual boost or disable Normalize if you hear level jumps, pumping, or distortion.

</details>

## 🛡️ Restricted Media (DRM & Cross-Origin)

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
- The extension **remembers your requested gain separately from the applied gain**. For example, +12 dB requested on a clear song is temporarily applied as 0 dB maximum when the next song is DRM/CORS-limited, and can be restored automatically if the route becomes safe again. Remember and hotkeys save the requested setting, not the temporary clamp. Volume Up at the restricted ceiling does not silently overwrite that pending boost; Volume Down can still attenuate.
- Lowering volume still works: the element's native volume is used (attenuation only, exact dB math, and mute).
- Mono mixing is unavailable on such media.
- **Force native fallback** (the debug routing override) also caps the displayed/applied volume at **0 dB**, even before playback starts, because native HTML media controls cannot boost. Your higher requested volume remains saved separately, and the normal range returns when WebAudio routing is available again; Mono and Normalize remain disabled while forced native is selected.

<details>
<summary>🧩 How DRM and cross-origin detection works</summary>

**How detection works**

- Per-element signals (v6.13 — the "restricted" verdict requires **per-element DRM evidence**): an `encrypted` event fired, a `setMediaKeys` call (wrapped), or `element.mediaKeys` set. A page that merely PROBES DRM capability never trips the verdict — app.plex.tv probes all three key systems at startup (verified in its production bundle) while playing clear direct-play content, and since v6.9 that probing alone had wrongly clamped boost to 0 dB on every engine (issue #70).
- **Pending EME gate — decryption proof** (v6.14): on EME-probed pages, `blob:` (MSE) sources without per-element evidence are not routed until the element's `currentTime` actually **advances** — proof that the content is decodable, i.e. clear (EME content cannot decode a single frame without MediaKeys attached, and every attachment path is visible: patched `setMediaKeys`/`webkitSetMediaKeys`, `element.mediaKeys`, the `encrypted` event). Progress is observed at `timeupdate` cadence (~4 Hz in Chromium, 15–250 ms per spec) plus a 1 s sweep backup, so clear content routes within **~a quarter second of playback** (Plex — v6.13 waited a blind 3-second window; a mid-session boost while already playing also routes at the next timeupdate). DRM-stalled media (playback blocked on a license, `currentTime` frozen) never proves anything and is never routed — the udio.com birth-window safety is preserved by physics rather than by a timer. When the page actually constructs MediaKeys, earned proof is reset (keys are imminent — the `createMediaKeys` patch), and a source change (`emptied`) re-earns proof for the new source. On Gecko, Netflix routes immediately once keys attach.
- **Residual (documented) limitation**: an element that plays CLEAR content and later switches to encrypted media **on the same element** mid-session can already be routed when the evidence lands — on Chromium there is no way back from `createMediaElementSource()`, so the verdict flips to "restricted" and the (silenced) route cannot be unwound. This exposure existed in every prior version after its grace window expired; v6.14 just makes clear content route sooner. Real sites switch protection by reloading the source (which re-earns proof) or the player, so this is a theoretical edge.
- The MAIN-world hook computes one aggregate page verdict over **every** element it tracks — attached to the DOM, detached (JS-created players that never touch the DOM), or inside a shadow DOM — and publishes it with immediate change notifications.
- Embedded iframes report meaningful restriction state to the top frame through extension messaging. Restricted frames refresh every 5 s with a 15 s expiry; unrestricted frames do not generate periodic traffic, and a one-shot empty report on iframe navigation clears stale restrictions immediately.
- All verdicts are computed deterministically by the top frame — no cross-frame response races, which is what keeps the restriction note stable while you drag the slider.
- Cross-frame restriction reports use extension messaging rather than page `postMessage`, so page scripts cannot forge another frame's DRM/CORS report. The MAIN↔ISOLATED page bridge also carries a per-document capability token to reject accidental or stale bridge traffic; because MAIN-world code shares the page's JavaScript realm, this token is a compatibility guard rather than a security boundary against hostile page code.
- Engine detection (v6.13): the UA string is checked **FIRST** — a UA containing `Firefox/` identifies Gecko (DRM media is routable, and routed only after `setMediaKeys()` succeeds) — with `navigator.userAgentData` identifying Chromium-family browsers (protected-audio guard stays) checked second. The order matters: a future Firefox that grows a `userAgentData` shim must still classify as Gecko (issue #68). Unknown or privacy-stripped UAs keep the conservative guard.

</details>

<details>
<summary>🧪 Browser verification details and test artifacts</summary>

**Verification:** the restriction pipeline was live-tested against real Widevine playback on udio.com and against a real cross-origin CDN audio source replicating detached-player sites (treblo.com pattern), plus a ClearKey EME harness — restricted media is never routed, the verdict is stable, and fallback attenuation is exact. The engine split was confirmed empirically: on Chromium, routing an element with MediaKeys produces graph silence even for clear audio (measured 0.00 RMS through the route vs 3.53 RMS for the same route on a non-DRM element). The Firefox side was additionally verified **live on a real Firefox 155.0.1** (headless, driven via WebDriver with a locally installed real Widevine 4.10.3112.0 CDM): a genuine `com.widevine.alpha` key system access grant, MediaKeys attached to an MSE-backed element, and the element routed by the hook with **audible output measured through the WebAudio destination (2.13 RMS at +20 dB, gain exactly 10.0) — vs 0.00 RMS for the identical keys-attached setup on Chromium**. Same-origin boost, WebAudio graph insertion (exact gain math), and cross-origin refusal were all re-verified in the same Firefox run, and a Widevine-disabled Chromium run (Brave-style) confirmed clear-media boost is unaffected while a granted CDM still engages the guard. **PlayReady parity** was verified twice: deterministically (harness scenario v13 — the exact key system string `com.microsoft.playready.recommendation.3000` flags the page and element identically to Widevine on both engines: Firefox routes + boosts + unrestricted verdict; Chromium/Edge restricted + never routed; a rejected probe never flags the page), and **live on real Firefox** (`mode=firefox-playready`: the genuine native probe rejects with `NotSupportedError` *without* setting the page-EME flag; a PlayReady-shaped grant resolving through the hook's wrapper flags the page, the element gets the sticky restricted flag, and it is still routed with route gain exactly 10.0 and **audible output — 3.54 RMS, identical to the same run's clear-media control**). Since v6.12.1 the **packaged extension itself has also been install-verified on real Firefox 155** (temporary add-on via WebDriver — the v6.12 manifest was rejected at install time before the dual-key background fix): both content-script worlds run, engine detection returns Gecko, and a driven +20 dB boost routed a real element with route gain exactly 10.0. Harness: `analysis/harness/firefox-live.mjs` + `analysis/harness/firefox-playready-live.mjs` + `analysis/harness/firefox-addon-load.mjs` (+ `vc-test.html?engine-test=1`), results in `analysis/harness/firefox-live-result.json`, `analysis/harness/firefox-playready-result.json`, `analysis/harness/firefox-addon-fixed.stderr.log`, and `brave-sim-result.json`.

</details>

## ⚠️ Known Limitations

- Volume Control cannot run on browser system pages such as `chrome://`, `edge://`, `about:`, extension pages, or other protected browser UI.
- DRM-protected media on **Chromium browsers** (Chrome/Edge/Brave/Opera/Vivaldi) can only use the native volume fallback: lowering and mute work; boosting and mono do not (the browser silences WebAudio for protected audio). If Widevine is disabled on such a browser (Brave's default), DRM sites simply won't play anything — non-DRM audio is unaffected and boosts identically. On **Firefox**, DRM media is fully boostable since v6.12. See [Restricted Media](#restricted-media-drm--cross-origin).
- Cross-origin media without CORS can only use the native volume fallback in every engine: lowering and mute work; boosting and mono do not.
- Sites that create their own `createMediaElementSource` pipeline for the same element can end up double-attenuating when Volume Control also routes that element.
- Media that becomes cross-origin-tainted *after* it was already routed cannot be un-tainted; routing continues with the gain that was already applied.
- Sites with unusual, heavily customized, or late-changing WebAudio graphs may not be fully controllable in every playback path.
- Normalization is based on source RMS and sample peaks, **not LUFS or inter-sample true peak**. The compressor is not a brick-wall hard limiter. Fast transients and large manual boosts may still clip; see [Normalization, Manual Volume, and Peak Meter](#normalization-manual-volume-and-peak-meter-623).

## 📦 Release Builds (read before packaging)

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

## ⌨️ Hotkeys

- `Alt+Shift+Up`: Increase volume by 1 dB.
- `Alt+Shift+Down`: Decrease volume by 1 dB.
- `Alt+Shift+0`: Reset volume to 0 dB.
- `Alt+Shift+M`: Toggle mono audio.
- `Unassigned due to 4 hotkey limit, edit in firefox/chrome settings [chrome://extensions/shortcuts]`: Activate the extension.
- `Unassigned due to 4 hotkey limit, edit in firefox/chrome settings [chrome://extensions/shortcuts]`: Toggle mute.

Browser shortcut settings can be used to remap or disable these defaults.
Pin the extension icon to the toolbar to see native badge feedback while adjusting volume.

## 🔒 Privacy Policy

Volume Control does not collect, transmit, sell, share, or store any personal information outside your browser.

The extension does not use analytics, telemetry, tracking pixels, remote logging, accounts, advertising IDs, or any external server for data collection. Your volume settings, mono setting, excluded sites, remembered sites, whitelist or blacklist mode, and debug preference are stored only in your browser's local extension storage.

The extension reads page audio/video elements locally in your browser only so it can apply the volume and mono settings you choose. This processing happens on your device. No browsing history, page content, audio content, media titles, URLs, or settings are sent to the developer or to any third party.

## 🧩 Permissions

Volume Control asks for the browser permissions needed to control audio reliably across modern websites:

- `storage`: Saves your volume settings, mono setting, remembered site settings, exclusion list, whitelist/blacklist mode, and debug preference locally in your browser.
- `activeTab`: Lets the popup identify and update the current tab after you interact with the extension, without requesting broader tab access.
- `<all_urls>` host permission: Allows the content scripts to run on websites where audio or video may exist. This is needed because users can play HTML5 media on almost any site, and the extension has to access page-local media elements and WebAudio connections to change their volume.
- `document_start` content script timing: Installs a transparent MAIN-world `AudioNode.connect` destination interceptor immediately, before asynchronous storage/profile resolution, so early WebAudio graphs are recorded without changing their gain. Once the site's allow/block state resolves, enabled pages install the remaining media hooks and excluded pages restore the native prototypes. Loading later can still miss browser-created frames that the engine itself does not expose at `document_start`.
- `all_frames` content script access: Lets the extension work with audio/video inside embedded frames, such as video players, social embeds, and media hosted from another domain. Without frame access, only top-level page media would be controllable.
- `file:///*` content script match: Allows the extension to work on local media files when the browser permits extension access to file URLs.

AMO/Chrome Web Store review note: the broad host access, early `document_start` injection, and `all_frames` access are used only to detect and route page-local HTML5 media and WebAudio before playback begins. Volume Control does not collect browsing history, inspect page content for analytics, inject ads, or send page URLs, media metadata, audio content, or settings to a server.

<img width="472" height="182" alt="firefox_sqvsowk1NI" src="https://github.com/user-attachments/assets/7790e01c-ccb5-41c1-b24c-0ac4123b35ab" />

<img width="472" height="182" alt="firefox_6Jn4rh739p" src="https://github.com/user-attachments/assets/f368b636-ac39-4e23-b929-c6f29b34b8b9" />


# 📝 Changelog

## 🚀 Changes since V6.16 (through V6.23)

**Post-6.23 updates on `master`:** opt-in Normalize per site/path and a separately controlled global default; collapsible popup meter/Options controls; pre-fader source analysis independent of the slider; noise-floor gate, peak-aware automatic boost headroom and faster gain reduction; sampled output peak meter; and CPU-saving compressor/timer bypasses while disabled. See [signal flow](#signal-flow) and [limitations](#unsupported-media-and-practical-limits).

These updates improve Firefox media compatibility, restore volume after track changes, add path-based site exclusions and per-site debug profiles, and harden release-build minification. See the [full source comparison](https://github.com/Chaython/volumecontrol/compare/V6.11...master).

---

<details open>
<summary>✨ Version 6.23 — Patch Notes</summary>

- **Capture WebRTC/MediaStream call audio:** media assigned through `HTMLMediaElement.srcObject` is now claimed immediately, including streams whose audio tracks are added later. This covers call paths used by sites such as Snapchat Web that do not use a normal URL-backed media source.
- **MediaStream WebAudio fallback:** when a browser rejects `createMediaElementSource()` for a stream-backed call element, Volume Control can fall back to `createMediaStreamSource()` and silence the element's native duplicate while the extension graph is active. The fallback intentionally avoids the "element already owns a MediaElementSource" case so page-owned WebAudio graphs are not doubled.
- **Immediate call/native fallback attenuation:** assigning a WebRTC `srcObject`, starting playback, browser volume resets, and source boundaries reapply attenuation immediately rather than waiting behind the normal anti-write-war throttle.
- **Fix playlist transition spikes:** browser/source-transition corrections can bypass the 250 ms fallback write throttle, closing the short full-volume window reported during auto-next/replay while preserving throttling for ordinary audits.
- **Live SPA path profiles:** `pushState`, `replaceState`, `popstate`, hash changes, and browser tab URL updates now trigger remembered/debug/whitelist/blocklist re-resolution in every frame. Path profiles no longer require a full reload on YouTube/Netflix/Plex-style navigation.
- **Prevent stale async profile state:** content-script profile refreshes use a generation token so an older storage/top-URL lookup cannot finish late and overwrite newer navigation/settings state.
- **Correct blocklist path semantics:** host names remain case-insensitive, URL paths preserve case, query strings/fragments are discarded, and a non-wildcard directory entry such as `example.com/videos` applies to that path and descendants.
- **Deterministic remembered-profile precedence:** matching profiles now rank path scope, exact host, literal path specificity, wildcard count, and domain specificity instead of relying only on key-string length.
- **Reduce remembered-setting lost updates:** options-page edits are serialized and re-read the latest storage before mutation; popup remembered writes are serialized as well.
- **Release version:** bump the extension from 6.22 to 6.23.

</details>

---

<details>
<summary>🛠️ Version 6.22 — Patch Notes</summary>

- **True URL/path remembered profiles:** remembered settings and whitelist entries may now use paths such as `example.com/videos`; a path applies to itself and descendants, and `*` can match within a path segment. Existing domain-only settings remain backward compatible.
- **Embedded-player profile consistency:** content scripts in cross-origin iframes now resolve remembered volume, mono, mute, whitelist state, and debug overrides against the top-level tab URL via the background service. CDN/player frames no longer silently use a different profile from the page the user remembered.
- **Preserve per-site debug settings from hotkeys:** keyboard volume/mono/mute updates merge into the current remembered record instead of replacing it, so the nested per-site debug profile survives hotkey use.
- **Fix local-file memory:** all contexts now use the canonical `file` key, while still recognizing the legacy `Local File` key.
- **Harden release output deletion:** `build.ps1` explicitly rejects the repository root and sibling paths that merely share the repository-name prefix, preventing an unsafe `-OutputDir .` from recursively deleting the checkout.
- **Add CI:** Windows GitHub Actions now runs `npm ci`, the regression suite, a full Firefox/Chrome package build, and uploads the generated ZIPs on pushes, pull requests, and manual runs.
- **Expand regression coverage:** tests now cover URL/path profile precedence, wildcard matching, local-file compatibility, iframe top-URL inheritance, hotkey profile preservation, and dangerous build-output paths.
- **Release version:** bump the extension from 6.21 to 6.22.

</details>

---

<details>
<summary>🛠️ Version 6.21 — Patch Notes</summary>

- **Remember debug options per site:** remembered-site profiles can now store Debug Highlight, Force DRM Audio Capture, Skip CORS Media Guard, and HTML Media Route Override. With **Site debug** disabled, a remembered site continues to inherit the global debug defaults.
- **Preserve per-site debug profiles:** popup volume/mono/mute saves keep the optional debug object instead of replacing the remembered record.
- **Minify CSS release assets:** packaged `.css` files are optimized with pinned `clean-css 5.3.3` level-1 optimization, with URL rebasing disabled.
- **Minify HTML release assets:** packaged `.html` files are minified with pinned `html-minifier-terser 7.2.0` using conservative whitespace handling. Inline JavaScript/CSS minification stays disabled because standalone assets are handled by their dedicated minifiers.
- **Expand build regression tests:** both browser packages must show smaller JS/CSS/HTML output while the source tree remains byte-for-byte unchanged; tests also verify important popup/options IDs, script references, CSS custom properties, and per-site debug styles survive minification.
- **Release version:** bump the extension from 6.20 to 6.21.

</details>

---

<details>
<summary>📚 Versions 6.15–6.20 — Patch Notes</summary>

The 6.15–6.20 line covers exclusion UX, build hardening, debug routing controls, limiter consistency fixes, and mono-availability handling.

- **Fixed broken release builds:** replaced regex-based comment stripping that could corrupt JavaScript and prevent the extension from starting. Terser now removes comments and unnecessary whitespace while preserving names, regex literals, template contents, and UTF-8 text.
- **Clearer exclusion messages:** the popup identifies the blocklist entry disabling the current page and explains how to re-enable it. Whitelist exclusions point to the explicit Allowed Sites list, which is independent from Remembered Settings. Exclusion status is read directly from saved settings, so it also works when the content script cannot reply.
- **Easier list editing:** press Enter to add a site or path in Settings. Duplicate blocklist entries and remembered sites show an inline notice and keep the typed text for editing.
- **Safer build failures:** check for Node, the minifier helper, and Terser before replacing existing output. Invalid JavaScript stops packaging instead of producing a broken ZIP. Original source files stay unchanged.
- **Added build regression checks:** `npm test` builds both browser variants and checks minification, script parsing, regex/template/Unicode behavior, URL and blocklist helpers, source preservation, and failure handling. Test fixtures and build tools are excluded from release packages.
- **Add dangerous DRM capture override:** Settings now includes a debug-only option that bypasses DRM/EME routing safeguards and attempts WebAudio capture anyway. The UI warns that this may mute audio, stop protected media from loading, or break playback; cross-origin safety checks remain enforced.
- **Add routing diagnostics:** Settings now also has a debug-only CORS bypass and an HTML-media route override (Automatic / Force WebAudio / Force native fallback). These are intentionally dangerous compatibility tools; CORS-bypassed WebAudio can output silence, and forced native fallback cannot boost or mono-process HTML media.
- **Fix playlist transition volume spikes:** the page's own media volume is tracked separately from Volume Control's dB gain. Native attenuation is applied immediately when a site rewrites `video.volume`, while existing WebAudio routes remain associated with reused media elements across playlist transitions.
- **Fix debug override limiter consistency (v6.19):** DRM and CORS debug overrides now apply at the final boost-limit verdict layer too, so stale fallback flags, MAIN-world aggregate restrictions, and iframe reports cannot keep the popup/slider clamped after the matching override is enabled. Force WebAudio remains a routing choice; DRM/CORS bypasses remain independent explicit safety overrides.
- **Disable unavailable mono controls (v6.20):** the popup now disables and visually de-emphasizes Mono whenever the active route cannot provide WebAudio channel processing, including restricted/cross-origin fallback and forced-native debug routing.
- **Build setup:** Node.js 18+ and `npm ci` are now required. `build.ps1` runs minification and packaging; `npm test` runs the regression checks separately.

</details>

---

<details>
<summary>🛠️ Version 6.14 — Patch Notes</summary>

- **Faster boosting on clear media:** replaced the fixed three-second routing delay on pages that probe DRM support with playback-progress checks. Clear media, such as Plex direct-play content, can be boosted once playback advances without DRM evidence.
- **Path-based exclusions in Settings:** add entries such as `example.com/videos` or `example.com/videos/*`. A `*` matches characters within a path segment; entries without a path still block the domain and its subdomains.
- **Earlier legacy cleanup:** remove obsolete Twitch defaults during extension install/update, browser startup, and background initialization, in addition to the content-script migration.
- **Recheck changing media:** reset playback-progress checks when a source changes or the page creates media keys, so a previous source's progress does not clear the new source for routing.

</details>

---

<details>
<summary>🛠️ Version 6.13 — Patch Notes</summary>

- **More reliable volume across track changes:** retry delayed native-volume corrections and periodically check for volume drift when sites reset their players, addressing playlist transitions and replayed clips.
- **Fix Firefox DRM startup ordering:** wait for media keys to attach before routing protected audio, addressing player failures caused by capturing audio too early. Firefox identification also takes priority over Chromium-style capability hints.
- **Reduce false DRM restrictions:** checking whether the browser supports DRM no longer automatically clamps clear media to 0 dB or displays a restriction warning. The restriction verdict now requires evidence from the media element.
- **Fix legacy Twitch exclusions:** match stored path entries against their paths instead of blocking the entire domain, and remove obsolete default Twitch entries in a one-time migration.
- **Make the Active switch recover excluded pages:** enabling the extension removes every blocklist entry matching the current URL before reloading, including legacy and wildcard entries.

</details>

---

<details>
<summary>🛠️ Version 6.12.2 — Patch Notes</summary>

- **Declare Chromium 121 as the minimum version:** make the compatibility requirement for the shared source manifest explicit. Firefox's minimum remains 128.

</details>

---

<details>
<summary>🛠️ Version 6.12.1 — Patch Notes</summary>

- **Fix Firefox loading from the source folder:** declare Firefox background scripts alongside Chromium's service worker, with `shared.js` loaded before `background.js`.
- **Respect site-controlled mute:** fallback volume handling only clears a native mute applied by the extension, rather than unmuting media the site had muted.
- **Limit repeated volume writes while paused:** apply the same rate limit used during playback when a site's volume manager keeps changing the native volume.
- **Preserve player borders:** normal audio-hook setup no longer clears a site's inline border when extension debugging is off.

</details>

---

<details>
<summary>🛠️ Version 6.12 — Patch Notes</summary>

- **Enable Firefox DRM audio controls:** allow boosting and mono processing for protected audio on Firefox instead of applying Chromium's DRM restriction to every browser.
- **Keep browser-specific safeguards:** Chromium and unidentified engines continue to use native volume fallback for protected media. Cross-origin media without the required CORS access remains restricted on all engines.

</details>

---

<details>
<summary>🛠️ Version 6.11 — Patch Notes</summary>

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
<summary>🛠️ Version 6.10 — Patch Notes</summary>

- Fixed   Missing "restricted by DRM" note on sites whose players never live in the page's DOM: detached JS-created players, shadow-DOM players, and iframe-resident media were invisible to the verdict scan — the slider offered +32 dB it could not deliver and boost was silently capped
- New   Aggregate page-restriction flag: the MAIN-world hook publishes a "restricted"/"cross-origin" verdict over ALL tracked elements (attached, detached, or shadow-DOM), refreshed on media claim, DRM events, element lifecycle events, state applications, and a 1 s interval; changes invalidate the content script's verdict cache immediately
- New   Cross-frame aggregation: embedded frames report their verdict to the top frame (1 s heartbeat, 2.5 s TTL) and the most restrictive live report wins — without reintroducing response races (see 6.9)
- Improved     Dead frames relax via TTL; same-window postMessages cannot spoof verdicts; restrictions relax automatically when media goes quiescent; same-origin detached elements remain fully boostable (no false positives)

</details>

---

<details>
<summary>🛠️ Version 6.9 — Patch Notes</summary>

- Fixed   "Restricted by DRM" note flickering in and out while dragging the volume slider: state queries used unframed messaging, so the top frame (restricted, DRM) raced embedded iframes (unrestricted) and the first responder won on every slider commit. State queries now target the top frame only; apply commands still broadcast so embedded players remain controllable
- Fixed   Latent DRM mute: routing DRM media through WebAudio succeeds at the API level but detaches the element's native output in real Chrome and feeds the graph silence. The hook now refuses to route restricted media entirely; native fallback volume keeps working
- New   EME detection: `setMediaKeys` and `requestMediaKeySystemAccess` are wrapped (a page is flagged as using EME only when a CDM is actually granted); on EME pages, `blob:` (MSE) sources are treated as restricted from the first moment — closing the birth window before `encrypted`/keys events land
- Improved     DRM protection is no longer masked by hook ownership; per-element `encrypted` listeners attach before the page-managed early return; the popup clamps the slider at 0 dB with a "restricted" note

</details>

---

<details>
<summary>🛠️ Version 6.8 — Patch Notes</summary>

- Fixed   Random "earrape" volume: media elements detached from the DOM but still playing (site player rebuilds, ad transitions, quality switches, SPA navigations) were dropped from tracking, freezing their WebAudio route gain at the boost level active at detach — up to +32 dB (~40×) — while the popup kept showing the correct value. Detached-but-audible elements are now kept tracked and updated; only quiescent elements are released
- Fixed   Random silence after returning to 0 dB: idle AudioContext suspension now also counts native (unrouted) connections, so contexts with live audio are never suspended
- Fixed   Site volume writes during the 100 ms echo-ignore window were swallowed — only the extension's own write-backs are ignored now
- Fixed   Content-script cleanup could suspend an AudioContext while audio was still flowing (same keep-if-playing policy applied)
- Improved     Full state re-send every ~30 s to heal hook ↔ content-script state drift (defense-in-depth on top of the heartbeat)

</details>

---

<details>
<summary>🛠️ Version 6.4 — Patch Notes</summary>

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
<summary>🛠️ Version 6.3 — Patch Notes</summary>

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
<summary>🛠️ Version 6.2 — Patch Notes</summary>

- Added browser hotkeys for volume up/down, reset, and mono toggle  
- Added native toolbar‑badge volume feedback for hotkeys and popup adjustments  
- Hotkey changes now update remembered settings when the current site is already remembered  

</details>

---

<details>
<summary>🛠️ Version 6.1 — Patch Notes</summary>

- Removed an unused JS library  
- Reduced Bluetooth idle power usage by disposing audio sessions more cleanly on stop  

</details>

---

<details>
<summary>🛠️ Version 6.0 — Patch Notes</summary>

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

<details>
<summary>📁 Complete file reference</summary>



| File | World / Context | Has `window`? | Has `chrome.*`? | Can Patch Page JS? | Purpose | Why It Must Be Separate |
|---|---|---|---|---|---|---|
| `shared.js` | Loaded into multiple contexts (content script, popup, options, background) | ✅ | ✅ (guarded) | ❌ | Pure utility library — dB conversion, media element helpers, domain parsing, bridge constants, frame-targeted messaging helpers, error helpers | The only file that appears in multiple contexts; guards all `chrome.*` calls so it doesn't crash in contexts without extension APIs |
| `page-audio-hook.js` | **MAIN world** content script | ✅ Page's `window` | ❌ | ✅ **Yes** | Patches `AudioNode.prototype.connect`, `HTMLMediaElement.prototype.volume`, `HTMLMediaElement.prototype.play`, `window.Audio`, `document.createElement`, `setMediaKeys`/`requestMediaKeySystemAccess` (EME detection) to insert gain nodes into the page's audio graph and track every media element (attached, detached, or shadow-DOM) | **Must** run in MAIN world — prototype patches only affect code in the same JS realm; extension APIs are stripped from MAIN world for security |
| `cs.js` | **ISOLATED world** content script | ✅ Clean `window` | ✅ | ❌ | Content script bridge — reads/writes `chrome.storage`, handles messages from popup/background (top-frame targeted), syncs state to `page-audio-hook.js` via `window.postMessage`, computes the boost-limit verdict (DRM/cross-origin) including the hook's aggregate flag and iframe reports, manages fallback volume for cross-origin/DRM media | **Must** run in ISOLATED world to access `chrome.storage` and `chrome.runtime` APIs; communicates with MAIN world via `postMessage` |
| `background.js` | **Background** (Chrome: service worker / Firefox: event page) | ❌ No DOM | ✅ | ❌ | Handles keyboard shortcuts (`Alt+Shift+Up`/`Down`/`0`/`M`), shows native volume feedback badge, serializes remembered-setting writes and blocklist/whitelist mutations | Runs globally (not per-tab), has no DOM access, gets killed when idle; can't be merged with page-context scripts. Loads `shared.js` via `importScripts` in the service-worker world and via the manifest's `scripts` array on Firefox (dual-key background) |
| `popup.js` | **Popup page** (`popup.html`) | ✅ Own DOM | ✅ | ❌ | Popup UI logic — volume slider, Normalize toggle and folded output meter, mono toggle, remember-site checkbox, enable/disable switch, restriction note ("restricted by DRM"), debounced storage writes, focus management for accessibility, 1 s state polling while open (never touches the slider mid-drag) | Runs in `popup.html`'s isolated DOM; separate from options page because popup logic and options logic have no overlapping DOM concerns |
| `options.js` | **Options page** (`options.html`) | ✅ Own DOM | ✅ | ❌ | Options UI logic — global normalization default and advanced settings, blocklist/whitelist management, remembered-sites editor, debug mode toggle, live storage sync | Runs in `options.html`'s isolated DOM; separate from popup because it manages different UI with different lifecycle (stays open vs. closes on action) |
| `manifest.json` | Extension manifest | — | — | — | Declares permissions, content scripts (with world specification), the dual-key background (service worker for Chrome 121+ + scripts for Firefox event pages) plus the `minimum_chrome_version: "121"` floor, action popup, options page, keyboard commands, Firefox compatibility | Defines which scripts load in which world; the only place where the MAIN/ISOLATED split and the cross-browser background shape are configured |
| `popup.html` | Popup document | ✅ | — | ❌ | Popup markup — volume slider, mono/remember/active toggles, settings button, exclusion message, restriction note, error display | Required entry point for `browser.action.default_popup` |
| `popup.css` | Popup styles | — | — | — | Popup styling — slider, switches, layout, dark mode support | Keeps presentation separate from popup logic |
| `options.html` | Options document | ✅ | — | ❌ | Options markup — whitelist mode toggle, blocklist editor, remembered-sites editor, debug mode toggle | Required entry point for `options_ui.open_in_tab` |
| `ico.svg` | Extension icon | — | — | — | Toolbar icon (96×96 SVG) | Referenced by `manifest.json` `icons` and `action.default_icon` |

</details>

<details>
<summary>🌐 MAIN vs. ISOLATED worlds — why the split matters</summary>



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

</details>

<details>
<summary>🧩 Why `shared.js` is shared across contexts</summary>



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

</details>

<details>
<summary>📐 Execution contexts and file boundaries</summary>



**5 execution contexts → 5 files** (background, page-audio-hook, cs, popup, options)
**1 shared library → shared.js** (loaded by 4 of the 5 contexts)

This is the minimum possible file count given the WebExtension API's security constraints.



</details>

## 🧰 Build and release packages

Install the pinned build tools and run the regression suite before packaging:

```powershell
npm ci
npm test
```

Create Firefox and Chrome zip packages:

```powershell
.\scripts\build.ps1
```

The script writes clean packages to `dist/`, using `ico.svg` for Firefox and `chrome.png` for Chrome. Release copies are minified with **Terser 5.51.2** for JavaScript, **clean-css 5.3.3** for CSS, and **html-minifier-terser 7.2.0** for HTML. The source files are never rewritten by the build, and the bundled zips exclude repo files and `README.md`. `.github/workflows/ci.yml` runs regression tests, builds first, and then runs the real Chromium and Firefox audio-hook smoke tests against the actual minified files in `dist/chrome` and `dist/firefox`. Downloadable packages are published by the daily prerelease workflow when releasable code changes are detected.

### Stable Firefox / AMO publishing

Publishing a **non-prerelease GitHub Release** runs `.github/workflows/publish-firefox.yml`. The workflow checks out the exact stable tag, reruns regression tests, rebuilds the extension, extracts the generated Firefox ZIP, runs both hook-level and temporary-installed-addon smoke tests against that extracted release artifact, creates a readable source archive for Mozilla review, validates the upload with AMO's v5 API, and submits the listed version with the **ISC** license.

Configure these repository Actions secrets before publishing a stable release:

- `AMO_JWT_ISSUER` — the AMO API key/issuer.
- `AMO_JWT_SECRET` — the matching AMO API secret.

If the secrets are absent, the workflow still verifies the release build but skips the AMO submission instead of failing the release. Manual **workflow_dispatch** runs require an exact stable tag such as `V6.23` and default to **validation only**; `publish=true` must be selected explicitly to submit to AMO. Before uploading, the workflow checks authenticated AMO version history so a version already public, pending review, or otherwise already present is not submitted again.

***

Other Useful Extensions: 
https://github.com/Chaython/TogglePIP (Allow a site to run PIP consistently with an [Left Alt]+[P] toggle.)
https://github.com/Chaython/NTP (A NTP extension that offers custom shapes, colors, search providers....)

***

<details>
<summary>🔧 Audio-context ownership and DRM source transitions</summary>

A reused media element's DRM marker is discarded only when a different, nonempty media source is observed **and no EME MediaKeys remain attached**. Attached keys, unreadable DRM state, and source-less transitions retain the conservative capture guard. Page-created AudioContexts are never suspended merely because tracked output connections disappear; only the extension's own idle media AudioContext is suspended to release the audio device.

</details>

<details>
<summary>✅ CI coverage and release checks</summary>

The streaming-site workflow requires four decoded-media checks to pass before reporting success: downloaded MP3, downloaded MP4, simultaneous MP3+MP4 (including a finite normalization peak), and a reused-element MP4 playlist transition. Public websites, including YouTube, remain separately reported as **inconclusive** when headless playback is blocked; a successful navigation is not evidence that audible output was verified. Each run publishes a GitHub Actions step summary. The daily prerelease job installs and exercises both packaged extensions before publishing, and streaming checks also run on packaging, manifest, and popup/options UI changes.

</details>

<!-- chaython-funding:start -->
## Support development

Support this project through [GitHub Sponsors](https://github.com/sponsors/Chaython), [Patreon](https://patreon.com/Chaython), [Buy Me a Coffee](https://buymeacoffee.com/chaython), or [PayPal](https://paypal.me/ChaythonM).

Crypto donations:

- **Ethereum (ETH):** `0x201B6E0B0282BBAE1592C24f9CbD39009A70F7d7`
- **Bitcoin (BTC):** `32o7JmXgFcs4R1SbcLLVKQCRw9KHkhneJi`
- **Solana (SOL):** `BDicyUL9zizDeYBLw8oBwotv6jtHotLLQD7Bcqg2atLk`
- **USDC (Base network):** `0xBeD35dcAd9F1A32459B3C0DF004371EBE939E760`

**Send USDC only on Base.**
<!-- chaython-funding:end -->
