# Volume Control — Live Preview Website

Live-preview site for the [VolumeControl extension](https://github.com/Chaython/volumecontrol).
It runs the extension's **real main code** — the `page-audio-hook.js` WebAudio
graph ported 1:1 (input analyser → gain → mono chain → safety limiter → output
analyser), the verbatim `computeSafeNormalizerGainDb` loudness normalizer, and a
pixel-faithful replica of `popup.html` / `popup.css` / `popup.js`.

Visitors can drag & drop their own audio/video files into a mock browser and
control them exactly like the installed extension: ±32 dB boost, live peak
meter, mono down-mix, loudness normalization, per-site Remember, badge
feedback, DRM fallback simulation and keyboard shortcuts.

**→ For GitHub Pages deployment instructions, see [DEPLOY.md](./DEPLOY.md).**

## What's inside

| Path | Purpose |
|---|---|
| `src/lib/volume-control/core.ts` | Ported extension core: dB constants, gain math, normalizer config clamps, `computeSafeNormalizerGainDb`, limiter params |
| `src/lib/volume-control/engine.ts` | Ported `page-audio-hook.js` — the full WebAudio graph, capture logic, AGC sampler, native fallback, DRM restriction |
| `src/lib/volume-control/store.ts` | Zustand store: navigation, volume/toggle wiring, badge, Remember persistence (API or localStorage) |
| `src/components/demo/*` | Browser mockup, popup replica (+ ported `popup.css`), playground, radio site, settings dialog, live signal chain |
| `src/app/page.tsx` | Landing page: hero, stats, instructions, demo, features, install |
| `src/lib/asset-path.ts` | basePath helper for the `/volumecontrol` sub-path on GitHub Pages |
| `src/data/repo-stats.json` | Bundled stats snapshot used in static builds |
| `public/samples/*.mp3` | Demo audio (quiet mix / wide dynamics / talk radio) |
| `scripts/make-demo-audio.py` | Regenerates the demo tracks |

## Static vs. full build

This package is the **static (GitHub Pages) edition**: no API routes, no
database — Remember/normalizer settings persist in `localStorage`. The same
source also runs as a full app with a Prisma backend (see the "site source"
zip on the live preview page for that variant).

## Develop

```bash
bun install
bun run dev          # http://localhost:3000
bun run build:static # static export → out/
```
