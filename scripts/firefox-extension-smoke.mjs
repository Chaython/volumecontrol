import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const WEB_EXT_VERSION = '10.7.0';
const extensionRoot = process.env.VC_EXTENSION_DIR ? resolve(process.env.VC_EXTENSION_DIR) : null;
if (!extensionRoot || !existsSync(join(extensionRoot, 'manifest.json'))) {
    throw new Error(`Firefox extension smoke requires VC_EXTENSION_DIR containing manifest.json (got ${extensionRoot || 'unset'}).`);
}

function findFirefox() {
    const candidates = [
        process.env.FIREFOX_PATH,
        process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : null,
        process.platform === 'win32' ? 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe' : null,
        '/usr/bin/firefox',
        '/usr/bin/firefox-esr'
    ].filter(Boolean);
    return candidates.find(existsSync) || null;
}

const browser = findFirefox();
if (!browser) throw new Error('Installed-extension smoke could not find Firefox.');

const work = mkdtempSync(join(tmpdir(), 'volume-control-installed-firefox-'));
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
<title>Volume Control Firefox temporary-addon smoke</title>
<body>waiting for extension</body>
<script>
(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deadline = Date.now() + 15000;
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
    document.body.textContent = pass ? "VC_FIREFOX_EXTENSION_SMOKE_PASS" : "VC_FIREFOX_EXTENSION_SMOKE_FAIL";
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
    if (!port) throw new Error('Could not allocate Firefox installed-extension smoke port.');

    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    let stderr = '';
    child = spawn(npx, [
        '--yes',
        `web-ext@${WEB_EXT_VERSION}`,
        'run',
        '--source-dir', extensionRoot,
        '--firefox', browser,
        '--headless',
        '--no-reload',
        '--start-url', `http://127.0.0.1:${port}/`
    ], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.on('data', chunk => {
        stderr += String(chunk);
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.once('error', rejectResult);
    child.once('exit', code => {
        if (code && code !== 0) rejectResult(new Error(`web-ext/Firefox exited early with code ${code}.\n${stderr}`));
    });

    const timeout = setTimeout(() => {
        rejectResult(new Error('Firefox temporary-addon smoke timed out.\n' + stderr));
    }, 60000);

    const result = await resultPromise;
    clearTimeout(timeout);
    if (!result.pass) throw new Error('Firefox temporary-addon smoke failed: ' + result.detail);
    console.log(`Firefox temporary-addon smoke passed via web-ext ${WEB_EXT_VERSION}: packaged MAIN and isolated content scripts both loaded.`);
} finally {
    if (child && child.exitCode === null) {
        if (process.platform === 'win32' && child.pid) {
            try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
        } else {
            try { child.kill('SIGTERM'); } catch (e) {}
        }
        await Promise.race([
            new Promise(resolvePromise => child.once('exit', resolvePromise)),
            new Promise(resolvePromise => setTimeout(resolvePromise, 4000))
        ]);
    }
    if (server) {
        await new Promise(resolvePromise => {
            try { server.close(() => resolvePromise()); } catch (e) { resolvePromise(); }
        });
    }
    rmSync(work, { recursive: true, force: true });
}
