#!/usr/bin/env node
/**
 * build-userscript.mjs — assemble the Tampermonkey edition of Volume Control.
 *
 * Canonical home: <repo>/scripts/build-userscript.mjs. It writes the userscript
 * to <repo>/tampermonkey/volume-control.user.js (the root folder that is also
 * served at https://chaython.github.io/volumecontrol/tampermonkey/) and, when
 * a website folder is present, to its public/tampermonkey/ copy so the site
 * serves exactly what is committed here.
 *
 * The userscript embeds the extension's REAL page-audio-hook.js engine
 * verbatim, the extension version from manifest.json, and the popup css port
 * (.vc-popup scoped — the real popup.css targets html/body, which cannot
 * match inside a shadow root) into the template.
 *
 * Layouts supported (auto-detected from this script's location):
 *   full repo     engine/manifest at <repo>/, css port at
 *                 <repo>/website/src/components/demo/popup.css
 *   website-only  the website root IS the project root (dev sandbox):
 *                 engine/manifest at <root>/, css port at
 *                 <root>/src/components/demo/popup.css
 *
 * Sources (first match wins):
 *   engine   $VC_ENGINE_PATH, then <root>/page-audio-hook.js
 *   version  <root>/manifest.json (fallback 7.1.0)
 *   css      <root>/src/components/demo/popup.css
 *            or <root>/website/src/components/demo/popup.css
 *   template <root>/tampermonkey/userscript-template.js
 *
 * Outputs:
 *   <root>/tampermonkey/volume-control.user.js                 (canonical)
 *   <root>/website/public/tampermonkey/volume-control.user.js  (full repo)
 *   <root>/public/tampermonkey/volume-control.user.js          (website-only)
 *
 * Run from anywhere:  node scripts/build-userscript.mjs
 * If the engine source is absent (website-only checkout without the extension
 * sources), existing artifacts are kept so static builds still ship them.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const engineCandidates = [
    ...(process.env.VC_ENGINE_PATH ? [process.env.VC_ENGINE_PATH] : []),
    join(root, "page-audio-hook.js"),
];
const manifestCandidates = [join(root, "manifest.json")];
const cssCandidates = [
    join(root, "src/components/demo/popup.css"),
    join(root, "website/src/components/demo/popup.css"),
];
const templatePath = join(root, "tampermonkey/userscript-template.js");
const outRoot = join(root, "tampermonkey/volume-control.user.js");
const outWebsite = existsSync(join(root, "website"))
    ? join(root, "website/public/tampermonkey/volume-control.user.js")
    : join(root, "public/tampermonkey/volume-control.user.js");

function firstExisting(candidates) {
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

if (!existsSync(templatePath)) {
    console.error(`[userscript] template missing: ${templatePath}`);
    process.exit(1);
}

const cssPath = firstExisting(cssCandidates);
if (!cssPath) {
    console.error(`[userscript] popup css port missing — tried: ${cssCandidates.join(", ")}`);
    process.exit(1);
}

const enginePath = firstExisting(engineCandidates);
const engineSource = enginePath ? readFileSync(enginePath, "utf8") : null;

// Userscript-edition revision: appended to the manifest version so that
// Tampermonkey updates the userscript when ONLY the userscript template
// changes (the extension's own version stays untouched). Bump this whenever
// the template is edited without a matching manifest bump.
const USERSCRIPT_REVISION = 2;

let version = "7.1.0";
let manifestVersion = null;
const manifestPath = firstExisting(manifestCandidates);
if (manifestPath) {
    try {
        manifestVersion = String(JSON.parse(readFileSync(manifestPath, "utf8")).version || "7.1.0");
        version = manifestVersion;
    } catch { /* keep default */ }
}
version = `${version}.${USERSCRIPT_REVISION}`;

if (engineSource === null) {
    // Website-only checkout (no extension sources around): keep the committed
    // artifact so the static site still ships the userscript.
    if (existsSync(outRoot)) {
        const canonical = readFileSync(outRoot, "utf8");
        if (!existsSync(outWebsite)) {
            mkdirSync(dirname(outWebsite), { recursive: true });
            writeFileSync(outWebsite, canonical, "utf8");
            console.log("[userscript] engine source not found — kept committed artifact and refreshed the website copy");
        } else {
            console.log("[userscript] engine source not found — keeping existing generated artifacts");
        }
        process.exit(0);
    }
    console.error(`[userscript] engine source not found — tried: ${engineCandidates.join(", ")}`);
    process.exit(1);
}

if (!engineSource.includes("__volumeControlPageAudioHook") || !engineSource.includes("BRIDGE_VERSION")) {
    console.error("[userscript] engine source failed sanity check (hook key / bridge missing)");
    process.exit(1);
}

const template = readFileSync(templatePath, "utf8");
let css = readFileSync(cssPath, "utf8");

// The demo css ends with a "Preview-only chrome" section (browser-mockup
// positioning for the website demo: .vc-popup-anchor{top:calc(100% + 10px)},
// .vc-popup-frame, mockup animations). Those rules fight the userscript's own
// floating-host CSS inside the shadow root, so everything from that marker
// to EOF is dropped. All extension-popup rules (incl. .vc-popup-dark) live
// above it; if the marker is ever missing, the full file is kept.
const chromeMarker = "/* --- Preview-only chrome";
const chromeAt = css.indexOf(chromeMarker);
if (chromeAt !== -1) css = css.slice(0, chromeAt).trimEnd() + "\n";

const out = template
    .replace("__VERSION__", version)
    .replace('"__ENGINE_SOURCE__"', JSON.stringify(engineSource))
    .replace('"__POPUP_CSS__"', JSON.stringify(css));

if (out.includes("__ENGINE_SOURCE__") || out.includes("__POPUP_CSS__") || out.includes("__VERSION__")) {
    console.error("[userscript] placeholder substitution incomplete");
    process.exit(1);
}

mkdirSync(dirname(outRoot), { recursive: true });
writeFileSync(outRoot, out, "utf8");
mkdirSync(dirname(outWebsite), { recursive: true });
writeFileSync(outWebsite, out, "utf8");
console.log(`[userscript] engine   ${enginePath}`);
console.log(`[userscript] css      ${cssPath} (${css.length} bytes after stripping preview-only chrome)`);
console.log(`[userscript] version  v${version} (manifest ${manifestVersion ?? "n/a"} + userscript revision ${USERSCRIPT_REVISION})`);
console.log(`[userscript] wrote    ${outRoot} (${(out.length / 1024).toFixed(1)} KB)`);
console.log(`[userscript] wrote    ${outWebsite}`);
