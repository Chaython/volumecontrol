# Changelog

## V7.1 — Opt-in true-peak AudioWorklet limiter (October 2026)

- Exposed the experimental true-peak limiter as an explicit opt-in setting; it remains disabled by default and applies only to the isolated compatibility audio route.
- Route through the AudioWorklet only after the module and processor initialize successfully. If module loading, processor creation, or runtime processing fails, mark the experiment failed and recover through the existing compressor-protected route rather than leaving the route disconnected or sending boosted audio unprotected.
- Keep the MAIN-world/page-managed route on the existing compressor path; the experimental limiter is not advertised as globally active or as certified BS.1770 true-peak protection.
- Preserve the existing lookahead DSP and regression tests for opt-in defaults, AudioWorklet routing, ceiling updates, and failure fallback.

## V7.0 — First stable release with audio normalization (October 2026)

**Release status:** V7.0 is the first non-prerelease published build to include audio-normalization functionality. Normalization was developed and refined in earlier prerelease builds; the V6.16–V6.23 notes below describe that development history, not earlier stable releases with normalization.

- Changed Music-mode RMS tracking from multi-second lag to a 350 ms attack for louder sections and a 900 ms release for quieter sections, while keeping positive automatic boost gradual.
- Made the peak-headroom rule explicitly limit positive boost only; the peak envelope cannot independently request negative gain.
- Added a faster, smooth return from existing attenuation toward unity after the initial 2.5-second warm-up, while preserving protective attenuation across dramatic pauses and retaining immediate reduction of unsafe positive boost after a fresh peak.
- Added per-route, debug-mode diagnostics at approximately 100 ms intervals for input RMS, input sample peak, peak envelope, desired gain, and applied gain in both the MAIN-world and isolated fallback controllers.
- Added regression coverage for peak independence, quiet-section recovery, diagnostic fields, and preserving attenuation during warm-up and silence.

This changelog summarizes the first stable release containing normalization (V7.0), plus the prerelease development history from **V6.16 through V6.23**. Those earlier entries document prerelease work and should not be read as stable published releases containing normalization. Individual commits provide implementation detail.

## V6.16–V6.23 — Changes through October 2026

### Audio engine and normalization
- Added opt-in per-site audio normalization with a global default and independent site overrides.
- Decoupled normalization's source-loudness analysis from the manual volume slider, so manual adjustments no longer distort the normalizer's input measurement.
- Added and refined output peak metering, gain reporting, configurable normalization response, and safety-limiter behavior.
- Hardened gain-routing recovery: clamp previously boosted gain before fallback reconnection, avoid reconnecting unprotected audio when gain clamps fail, and keep failed routes retryable.
- Improved fallback attenuation and cleanup, including live exclusion cleanup and Bluetooth/audio-context lifecycle handling.

### Media controls and compatibility
- Fixed native HTML media volume sliders when isolated fallback attenuation is active.
- Preserve native volume changes made while media is paused and process mute-only `volumechange` events.
- Preserve website-owned mute state separately from extension-controlled mute.
- Preserve startup mute intent and native volume/mute controls for direct WebRTC MediaStream players.
- Continue updating detached isolated media where required and safely restore inactive fallback volume.
- Keep volume, mono, and mute through playlist and SPA transitions when Remember is disabled; a full reload or new tab still starts with defaults.
- Added mouse-wheel volume adjustment and fixed pause/play behavior.
- Improved DRM/cross-origin restriction handling and conservative fallback behavior.

### Settings, UX, and persistence
- Improved per-site and per-path settings isolation and remembered-site behavior.
- Improved blocklist path matching, legacy exclusion migration/cleanup, and popup feedback for blocked pages.
- Refined popup/options controls, normalization preferences, keyboard shortcuts, accessibility, and state synchronization.

### Testing, CI, and releases
- Added broad automated regression coverage for audio graph routing, gain safety, mute transitions, native player sliders, paused media, WebAudio, WebRTC, and fallback recovery.
- Added real decoded MP3/MP4 playback tests and playlist-like source-transition checks; test results distinguish verified playback from inconclusive public-site/headless playback.
- Added Chromium and Firefox smoke tests, including temporary-installed-extension checks and tests against the actual minified package output.
- Added clean Chrome/Firefox packaging, daily prerelease automation, release validation, and Firefox AMO submission workflow safeguards.
- Improved CI summaries and avoided redundant browser CI runs on feature-branch pushes.

### Earlier changes since V6.16
- Added browser volume hotkeys and toolbar-badge feedback, with remembered-setting updates where applicable.
- Improved hotkey interaction and popup/options state handling.
- Expanded browser compatibility and strengthened handling of pages with restrictive CSP, cross-origin media, and protected streams.

