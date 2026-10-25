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

## Updating the live site

Edit anything under `website/` and push — the workflow only triggers on
`website/**` changes (or run it manually from the Actions tab:
*Deploy website to GitHub Pages* → *Run workflow*).
