# Volume Control — Live Preview Website (Source Files)

Every file created or modified to build the live-preview website for the
[VolumeControl extension](https://github.com/Chaython/volumecontrol). The site
embeds the extension's **real main code** — ported verbatim — so the preview
behaves exactly like the installed extension.

> **Want to deploy to GitHub Pages?** Use the companion package
> `volume-control-website-gh-pages.zip` (button on the live site) — it is a
> complete, trimmed project with a CI workflow. See its `DEPLOY.md`.

## What was built

- **Real audio engine** — the extension's `page-audio-hook.js` Web Audio graph,
  ported 1:1: `source → inputAnalyser(fft 8192) → gain → [mono splitter chain] →
  limiter → outputAnalyser → destination`, incl. 15 ms gain ramps,
  `setTargetAtTime` timing (0.008 down / 0.035 up), 100 ms sampler and the
  verbatim `computeSafeNormalizerGainDb` loudness normalizer (music + adaptive modes).
- **Pixel-faithful popup** — the extension's `popup.html` / `popup.css` /
  `popup.js` replica: −32…+32 dB slider with wheel accumulators, debounced dB
  input, mute, Normalize panel with live gain + peak meter (−∞ formatting,
  98.3333% ceiling mark), Mono / Remember / Active toggles, boost warning at
  ≥ +6 dB, badge semantics (green/red/gray, MUTE), excluded-site state.
- **Mock browser** — two demo sites (Media Playground + quiet.fm radio), URL bar,
  extension icon with live badge, drag-and-drop overlay.
- **Drag & drop sampling** — drop any audio/video file into the preview; it is
  loaded into a real `<audio>`/`<video>` element and controlled by the engine.
- **Per-site Remember** — persisted via Prisma (SQLite) + localStorage in the
  full app; **localStorage-only in the static GitHub Pages build**
  (`IS_STATIC_EXPORT` in `store.ts` switches automatically).
- **Settings dialog** — functional replica of the options page.
- **DRM simulation** — the extension's real fallback path (attenuation-only).

## Dual build modes

`next.config.ts` supports two modes:

| Mode | Command | Output |
|---|---|---|
| Full app (default) | `bun run dev` / `next build` | API routes + Prisma persistence |
| Static export | `bun run build:static` | `out/` — fully static, basePath `/volumecontrol`, localStorage persistence |

`build:static` sets `NEXT_PUBLIC_STATIC_MODE=1` + `NEXT_PUBLIC_BASE_PATH`,
which makes the client skip all API calls and use the localStorage mirror.
`src/lib/asset-path.ts` prefixes public asset paths for the sub-path deploy.

## File map

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Landing page: hero, stats, instructions, browser mockup, signal chain, features, install, footer |
| `src/app/layout.tsx` | Metadata + Toaster |
| `src/app/globals.css` | Tailwind theme tokens |
| `src/lib/volume-control/types.ts` | Shared types (extension message/state shapes) |
| `src/lib/volume-control/core.ts` | **Ported extension core**: MIN/MAX_DB, `getGainValue`, normalizer config clamps, `computeSafeNormalizerGainDb`, limiter params |
| `src/lib/volume-control/engine.ts` | **Ported `page-audio-hook.js`**: full Web Audio graph, capture logic, AGC sampler, native fallback, DRM restriction |
| `src/lib/volume-control/store.ts` | Zustand store: navigation, volume/toggle wiring, badge, Remember persistence (API + localStorage / static fallback) |
| `src/lib/asset-path.ts` | basePath helper + `IS_STATIC_EXPORT` flag for GitHub Pages |
| `src/data/repo-stats.json` | Bundled stats snapshot (used when no API is available) |
| `src/components/demo/*` | Browser mockup, popup replica, playground, radio site, settings dialog, signal chain |
| `src/components/ui/*`, `src/hooks/*`, `src/lib/utils.ts` | The shadcn/ui subset + hooks the site uses |
| `src/app/api/*/route.ts` | GET/PUT/DELETE settings, normalizer config, stats (full-app mode only) |
| `prisma/schema.prisma` | `SiteSetting` + `GlobalConfig` models |
| `next.config.ts` | Dual-mode config (standalone vs static export) |
| `package.json` | Scripts incl. `build:static` |
| `scripts/make-demo-audio.py` | Generates the three demo tracks |
| `public/vc/ico.svg`, `public/samples/*.mp3`, `public/.nojekyll` | Assets |

## Use the full app

Drop these into a fresh Next.js 16 (App Router) + Tailwind 4 + shadcn/ui +
Prisma project, then:

```bash
bun run db:push   # create the SQLite tables
bun run dev       # http://localhost:3000
```

Everything renders on `/`. Open the popup from the puzzle-piece icon inside
the mock browser, drag an audio file onto the page, and control it like the
real extension.
