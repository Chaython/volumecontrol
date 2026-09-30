import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const hookSource = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');

function findChromium() {
    const candidates = [
        process.env.CHROME_PATH,
        process.env.CHROMIUM_PATH,
        process.env.EDGE_PATH,
        process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : null,
        process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : null,
        process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : null,
        process.platform === 'win32' ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' : null,
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter(Boolean);
    return candidates.find(existsSync) || null;
}

const browser = findChromium();
if (!browser) {
    const message = 'Browser smoke could not find a Chromium-family executable.';
    if (process.env.REQUIRE_BROWSER_SMOKE === '1') throw new Error(message);
    console.log(message + ' Skipping because REQUIRE_BROWSER_SMOKE is not set.');
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'volume-control-browser-'));
try {
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
    const tokenA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const tokenB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const preflightPatched = AudioNode.prototype.connect !== window.__vcNativeConnect;

    const earlyAudio = document.createElement("audio");
    document.body.appendChild(earlyAudio);
    earlyAudio.dispatchEvent(new Event("play"));
    const preflightMuted = earlyAudio.muted === true;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token: tokenA,
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
    await sleep(50);

    const disabledRestored =
        AudioNode.prototype.connect === window.__vcNativeConnect &&
        AudioNode.prototype.disconnect === window.__vcNativeDisconnect &&
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").set === window.__vcNativeVolume.set;
    const preflightRestored = earlyAudio.muted === false;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token: tokenA,
        command: "setState",
        version: 2,
        enabled: true,
        dB: 6,
        mono: true,
        muted: false,
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto"
    }, "*");
    await sleep(50);

    const reenabledPatched =
        AudioNode.prototype.connect !== window.__vcNativeConnect &&
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").set !== window.__vcNativeVolume.set;

    // A wrong token must not displace an active bridge session.
    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token: tokenB,
        command: "setState",
        version: 2,
        enabled: false,
        dB: 0
    }, "*");
    await sleep(30);
    const wrongTokenRejected = AudioNode.prototype.connect !== window.__vcNativeConnect;

    // If a site wraps our connect() while active, exclusion teardown must not
    // replace that site wrapper with the browser native method, and re-enable
    // must not double-wrap/overwrite it.
    const extensionConnect = AudioNode.prototype.connect;
    function siteConnectWrapper() {
        return extensionConnect.apply(this, arguments);
    }
    AudioNode.prototype.connect = siteConnectWrapper;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token: tokenA,
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
    await sleep(40);
    const siteWrapperPreservedOnDisable = AudioNode.prototype.connect === siteConnectWrapper;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token: tokenA,
        command: "setState",
        version: 2,
        enabled: true,
        dB: 3,
        mono: false,
        muted: false,
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto"
    }, "*");
    await sleep(40);
    const siteWrapperPreservedOnReenable = AudioNode.prototype.connect === siteConnectWrapper;

    const result = {
        preflightPatched,
        preflightMuted,
        preflightRestored,
        disabledRestored,
        reenabledPatched,
        wrongTokenRejected,
        siteWrapperPreservedOnDisable,
        siteWrapperPreservedOnReenable
    };
    const pass = Object.values(result).every(Boolean);
    document.body.textContent = (pass ? "VC_BROWSER_SMOKE_PASS " : "VC_BROWSER_SMOKE_FAIL ") + JSON.stringify(result);
})();
</script>`;
    const page = join(work, 'smoke.html');
    writeFileSync(page, html, 'utf8');

    const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--mute-audio',
        '--virtual-time-budget=1500',
        '--dump-dom',
        new URL('file:///' + page.replace(/\\/g, '/')).href
    ];
    const run = spawnSync(browser, args, {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true
    });
    if (run.error) throw run.error;
    const output = (run.stdout || '') + '\n' + (run.stderr || '');
    if (run.status !== 0 || !output.includes('VC_BROWSER_SMOKE_PASS')) {
        throw new Error('Browser smoke failed.\n' + output.slice(-8000));
    }
    console.log('Browser smoke passed: preflight mute, exclusion teardown, re-enable, token rejection, and page-wrapper ownership.');
} finally {
    rmSync(work, { recursive: true, force: true });
}
