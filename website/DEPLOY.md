# Deploy to https://chaython.github.io/volumecontrol/

This folder is a complete, self-contained Next.js project that builds to a
**fully static** site (no server needed) — perfect for GitHub Pages.

## One-time setup (≈2 minutes)

1. **Copy this folder into the extension repo** as `website/`:

   ```
   git clone https://github.com/Chaython/volumecontrol.git
   cd volumecontrol
   # extract this zip, then:
   cp -r <extracted-folder> website
   ```

2. **Install the workflow** (GitHub Actions builds & deploys automatically):

   ```
   mkdir -p .github/workflows
   cp website/deploy-website.yml .github/workflows/deploy-website.yml
   ```

3. **Commit & push:**

   ```
   git add website .github/workflows/deploy-website.yml
   git commit -m "Add live-preview website (GitHub Pages)"
   git push
   ```

4. **Enable GitHub Pages** (once):
   - Repo → **Settings → Pages**
   - Under *Build and deployment* → **Source** → select **GitHub Actions**

5. **Watch it build**: repo → **Actions** tab → "Deploy website to GitHub
   Pages". When it goes green, the site is live at
   **https://chaython.github.io/volumecontrol/**

Every future push that changes `website/**` redeploys automatically.

## How the static build works

- `bun run build:static` sets `NEXT_PUBLIC_STATIC_MODE=1` +
  `NEXT_PUBLIC_BASE_PATH=/volumecontrol`, which switches `next.config.ts` to
  `output: "export"` and emits everything into `out/`.
- The **entire audio engine is client-side** (the ported `page-audio-hook.js`
  WebAudio graph), so the live preview works identically with no server.
- **Persistence adapts automatically**: with no API routes available, Remember /
  per-site settings and the normalizer config are stored in `localStorage`
  (the same mirror the API version uses). All logic is in
  `src/lib/volume-control/store.ts` behind the `IS_STATIC_EXPORT` flag.
- Repo stats render from a bundled snapshot (`src/data/repo-stats.json`)
  instead of the stats API.
- Public asset paths are prefixed through `src/lib/asset-path.ts` so
  `/samples/…`, `/vc/…` and download links resolve under the
  `/volumecontrol/` sub-path.

## Run it locally

```bash
bun install
bun run dev            # normal dev server at http://localhost:3000
bun run build:static   # static export into out/ (what CI deploys)
npx serve out          # preview the exported build locally
```

## Tampermonkey edition (userscript)

`https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js`

A userscript build that embeds the extension's **real** `page-audio-hook.js`
engine verbatim and drives it with a faithful controller + floating popup
(same bridge protocol, same popup.css, GM storage for per-site settings).

**Canonical home: the `tampermonkey/` folder at the repository root** (sibling
of `website/`), containing `userscript-template.js`, the committed build
artifact `volume-control.user.js`, and its own README. The builder lives at
`scripts/build-userscript.mjs` in the repo's `scripts/` folder.

- **Built automatically (website)**: `deploy-website.yml` runs
  `node scripts/build-userscript.mjs` (repo root) before every deploy. It
  reads `page-audio-hook.js` + `manifest.json` from the repo root, the ported
  `website/src/components/demo/popup.css` and
  `tampermonkey/userscript-template.js`, and regenerates
  `tampermonkey/volume-control.user.js` **and**
  `website/public/tampermonkey/volume-control.user.js`. Pushing a change to
  `page-audio-hook.js`, `popup.css`, `manifest.json`, or anything under
  `tampermonkey/` redeploys the site *and* ships an updated userscript —
  Tampermonkey auto-updates installed copies via `@updateURL`.
- **Built automatically (releases)**: `publish.yml` also runs the builder,
  validates the result (`@version` matches the manifest, engine embedded,
  placeholders substituted), attaches it to every GitHub release as
  `volume-control.user.js`, then its `userscript_sync` job rebuilds from the
  default branch and auto-commits the artifact back so the root folder never
  goes stale.
- Raw fallback URL (always the last synced version):
  `https://raw.githubusercontent.com/Chaython/volumecontrol/master/tampermonkey/volume-control.user.js`
- The homepage's install section links to it (green "Install userscript"
  button — Tampermonkey intercepts the `.user.js` navigation) plus the repo
  folder and release pages.
- `public/tampermonkey/test-harness.html` loads the userscript with GM
  shims + a demo `<audio>` so you can verify the full stack in any browser
  without Tampermonkey installed.

## Statistics dashboard (docs/ → /stats.html)

The repo's usage-statistics dashboard lives in `docs/` and is kept fresh by
the daily `stats.yml` workflow (it commits updated `docs/stats.json` /
`stats.svg` every night). The website re-publishes it automatically:

- `deploy-website.yml` triggers on `docs/**` **and** `popup.css` changes, and
  copies `docs/{stats,preview}.html`, `stats.json`, `stats.svg` plus the root
  `popup.css` into `website/public/` before every build (fixing preview.html's
  `../popup.css` reference on the fly).
- Resulting URLs, same as the old dashboard:
  - `https://chaython.github.io/volumecontrol/stats.html` — statistics
  - `https://chaython.github.io/volumecontrol/preview.html` — popup preview
- The homepage links to the dashboard ("Full statistics" in the stats strip
  and "Statistics" in the footer).
- Nightly stats refreshes redeploy the site automatically — no manual steps.

`website/public/` contains a committed snapshot of the same files so plain
local builds work without `docs/` present; CI always overwrites it with the
latest from `docs/`.

## Updating the live site

Edit anything under `website/` and push — the workflow triggers on
`website/**`, `docs/**` and `popup.css` changes (or run it manually from the
Actions tab: *Deploy website to GitHub Pages* → *Run workflow*).

## Troubleshooting

**A run failed — where's the error?** Actions tab → click the failed run →
click the failing job (*build*) → expand the red step. The actual error is the
last lines of that step's log.

**Why the build is (now) fully offline:** the workflow pins Node 22 + Bun
1.4.4, installs from the committed `bun.lock` (`--frozen-lockfile`), ships
Geist fonts locally via the `geist` npm package (no `next/font/google` network
fetch at build time), and includes `@types/node` so Next never runs a
mid-build `npm install`. Earlier versions fetched fonts and types over the
network during `next build`, which intermittently fails on GitHub runners —
if you change fonts, prefer the `geist` package or `next/font/local` files in
`src/fonts/`.

**Stale site after deploy:** the old *Deploy statistics dashboard* workflow
(`pages.yml`) also published to the same URL. If it is still present in
`.github/workflows/`, remove it (`git rm .github/workflows/pages.yml`) so only
one workflow owns Pages.
