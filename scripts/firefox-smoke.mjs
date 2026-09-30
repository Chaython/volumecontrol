import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const hookSource = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');

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
if (!browser) {
    const message = 'Firefox smoke could not find Firefox.';
    if (process.env.REQUIRE_BROWSER_SMOKE === '1') throw new Error(message);
    console.log(message + ' Skipping because REQUIRE_BROWSER_SMOKE is not set.');
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'volume-control-firefox-'));
const profile = join(work, 'profile');
let child = null;
let server = null;

try {
    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolvePromise, rejectPromise) => {
        resolveResult = resolvePromise;
        rejectResult = rejectPromise;
    });

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
        res.writeHead(404);
        res.end('not found');
    });

    await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!port) throw new Error('Could not allocate Firefox smoke callback port.');

    const escapedHook = hookSource.replace(/<\/script/gi, '<\\/script');
    const html = `<!doctype html>
<meta charset="utf-8">
<body>starting</body>
<script>
window.__vcNativeConnect = AudioNode.prototype.connect;
window.__vcNativeDisconnect = AudioNode.prototype.disconnect;
window.__vcNativeVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
</script>
<script>${escapedHook}</script>
<script>
(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const token = "ffffffffffffffffffffffffffffffff";
    const preflightPatched = AudioNode.prototype.connect !== window.__vcNativeConnect;

    const earlyAudio = document.createElement("audio");
    document.body.appendChild(earlyAudio);
    earlyAudio.dispatchEvent(new Event("play"));
    const preflightMuted = earlyAudio.muted === true;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token,
        command: "setState",
        version: 2,
        enabled: false,
        dB: 0,
        mono: false,
        muted: false,
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto"
    }, "*");
    await sleep(60);

    const disabledRestored =
        AudioNode.prototype.connect === window.__vcNativeConnect &&
        AudioNode.prototype.disconnect === window.__vcNativeDisconnect &&
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").set === window.__vcNativeVolume.set;
    const preflightRestored = earlyAudio.muted === false;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token,
        command: "setState",
        version: 2,
        enabled: true,
        dB: -6,
        mono: false,
        muted: false,
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto"
    }, "*");
    await sleep(60);

    const reenabledPatched = AudioNode.prototype.connect !== window.__vcNativeConnect;
    const result = { preflightPatched, preflightMuted, preflightRestored, disabledRestored, reenabledPatched };
    const pass = Object.values(result).every(Boolean);
    location.href = "http://127.0.0.1:${port}/result?pass=" + (pass ? "1" : "0") +
        "&detail=" + encodeURIComponent(JSON.stringify(result));
})();
</script>`;

    const page = join(work, 'smoke.html');
    writeFileSync(page, html, 'utf8');

    let stderr = '';
    child = spawn(browser, [
        '-headless',
        '-no-remote',
        '-profile', profile,
        pathToFileURL(page).href
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
        if (code && code !== 0) rejectResult(new Error(`Firefox exited early with code ${code}.\n${stderr}`));
    });

    const timeout = setTimeout(() => {
        rejectResult(new Error('Firefox smoke timed out.\n' + stderr));
    }, 30000);

    const result = await resultPromise;
    clearTimeout(timeout);
    if (!result.pass) throw new Error('Firefox smoke failed: ' + result.detail);
    console.log('Firefox smoke passed: preflight mute, exclusion teardown, and re-enable.');
} finally {
    if (child && !child.killed) {
        try { child.kill(); } catch (e) {}
    }
    if (server) {
        try { server.close(); } catch (e) {}
    }
    rmSync(work, { recursive: true, force: true });
}
