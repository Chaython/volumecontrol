import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const extensionRoot = process.env.VC_EXTENSION_DIR ? resolve(process.env.VC_EXTENSION_DIR) : null;
if (!extensionRoot || !existsSync(join(extensionRoot, 'manifest.json'))) {
    throw new Error(`Chromium extension smoke requires VC_EXTENSION_DIR containing manifest.json (got ${extensionRoot || 'unset'}).`);
}

function findChromium() {
    // Chrome-branded builds ignore --load-extension starting in Chrome 137.
    // Prefer non-Google Chromium-family builds (Edge/Chromium) for this
    // command-line unpacked-extension smoke. Explicit env overrides still win.
    const candidates = [
        process.env.CHROMIUM_PATH,
        process.env.EDGE_PATH,
        process.env.CHROME_PATH,
        process.platform === 'win32' ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' : null,
        process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : null,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe' : null,
        process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome for Testing\\Application\\chrome.exe' : null,
        '/usr/bin/google-chrome'
    ].filter(Boolean);
    return candidates.find(existsSync) || null;
}

const browser = findChromium();
if (!browser) throw new Error('Installed-extension smoke could not find Edge, Chromium, or Chrome for Testing.');
console.log(`Installed-extension smoke browser: ${browser}`);

const work = mkdtempSync(join(tmpdir(), 'volume-control-installed-chrome-'));
const profile = join(work, 'profile');
let server = null;
let child = null;

try {
    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolvePromise, rejectPromise) => {
        resolveResult = resolvePromise;
        rejectResult = rejectPromise;
    });

    const page = `<!doctype html>
<meta charset="utf-8">
<title>Volume Control installed extension smoke</title>
<body>waiting for extension</body>
<script>
(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deadline = Date.now() + 12000;
    let isolated = false;
    let main = false;
    while (Date.now() < deadline) {
        isolated = document.body.classList.contains("vc-init");
        main = Boolean(AudioNode.prototype.__volumeControlPatched) ||
            AudioNode.prototype.connect.name === "patchedConnect";
        if (isolated && main) break;
        await sleep(100);
    }
    const pass = isolated && main;
    document.body.textContent = pass ? "VC_EXTENSION_SMOKE_PASS" : "VC_EXTENSION_SMOKE_FAIL";
    fetch("/result?pass=" + (pass ? "1" : "0") +
        "&detail=" + encodeURIComponent(JSON.stringify({ isolated, main }))).catch(() => {});
})();
</script>`;

    server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/result') {
            const pass = url.searchParams.get('pass') === '1';
            const detail = url.searchParams.get('detail') || '';
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('ok');
            resolveResult({ pass, detail });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(page);
    });
    await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!port) throw new Error('Could not allocate Chromium installed-extension smoke port.');

    let stderr = '';
    child = spawn(browser, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--mute-audio',
        `--user-data-dir=${profile}`,
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        `http://127.0.0.1:${port}/`
    ], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.on('data', chunk => {
        stderr += String(chunk);
        if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.once('error', rejectResult);
    child.once('exit', code => {
        if (code && code !== 0) rejectResult(new Error(`Chromium exited early with code ${code}.\n${stderr}`));
    });

    const timeout = setTimeout(() => {
        rejectResult(new Error('Chromium installed-extension smoke timed out.\n' + stderr));
    }, 30000);

    const result = await resultPromise;
    clearTimeout(timeout);
    if (!result.pass) throw new Error('Chromium installed-extension smoke failed: ' + result.detail);
    console.log('Chromium installed-extension smoke passed: packaged MAIN and isolated content scripts both loaded.');
} finally {
    if (child && child.exitCode === null) {
        try { child.kill(); } catch (e) {}
        await Promise.race([
            new Promise(resolvePromise => child.once('exit', resolvePromise)),
            new Promise(resolvePromise => setTimeout(resolvePromise, 3000))
        ]);
    }
    if (server) {
        await new Promise(resolvePromise => {
            try { server.close(() => resolvePromise()); } catch (e) { resolvePromise(); }
        });
    }
    rmSync(work, { recursive: true, force: true });
}
