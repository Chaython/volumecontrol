import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const extensionRoot = process.env.VC_EXTENSION_DIR ? resolve(process.env.VC_EXTENSION_DIR) : root;
const hookPath = join(extensionRoot, 'page-audio-hook.js');
if (!existsSync(hookPath)) throw new Error(`Firefox smoke hook not found: ${hookPath}`);
const hookSource = readFileSync(hookPath, 'utf8');

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
// Headless playback should not silently fail solely because no physical
// input gesture occurred. Real browser decoding remains required.
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'user.js'),
    'user_pref("media.autoplay.default", 0);\n' +
    'user_pref("media.autoplay.blocking_policy", 0);\n' +
    'user_pref("media.block-autoplay-until-in-foreground", false);\n');
let child = null;
let server = null;

try {
    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolvePromise, rejectPromise) => {
        resolveResult = resolvePromise;
        rejectResult = rejectPromise;
    });

    // Use a real compressed MP3, not a synthetic WebAudio oscillator. An
    // invalid download should fail the probe rather than falsely pass without
    // decoded playback. Firefox serves it from localhost for repeatability.
    const recordingUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';
    const recordingResponse = await fetch(recordingUrl, { signal: AbortSignal.timeout(18000) });
    if (!recordingResponse.ok) throw new Error('Firefox MP3 fixture HTTP ' + recordingResponse.status);
    const recordedMp3 = Buffer.from(await recordingResponse.arrayBuffer());
    if (recordedMp3.length < 1000 || recordedMp3.length > 1_000_000)
        throw new Error('Firefox MP3 fixture invalid length ' + recordedMp3.length);
    console.log('Firefox real MP3 fixture downloaded: ' + recordedMp3.length + ' bytes');

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
        if (url.pathname === '/real-recording.mp3') {
            const range = /^bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
            const from = range ? Number(range[1]) : 0;
            const to = range && range[2] ? Math.min(recordedMp3.length - 1, Number(range[2])) :
                recordedMp3.length - 1;
            // Reject unsatisfiable ranges instead of returning the last byte
            // masquerading as a valid 206 response (triggers decoder errors).
            if (from >= recordedMp3.length || to < from) {
                console.log('FIREFOX_MP3_BAD_RANGE=' + (req.headers.range || ''));
                res.writeHead(416, { 'Content-Range': 'bytes */' + recordedMp3.length });
                res.end();
                return;
            }
            console.log('FIREFOX_MP3_REQUEST=' + JSON.stringify({ range: req.headers.range || '',
                from, to, method: req.method }));
            res.writeHead(range ? 206 : 200, {
                'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store',
                'Accept-Ranges': 'bytes', 'Content-Length': to - from + 1,
                ...(range ? { 'Content-Range': 'bytes ' + from + '-' + to + '/' + recordedMp3.length } : {})
            });
            res.end(recordedMp3.subarray(from, to + 1));
            return;
        }
        if (url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
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
window.__vcNativeMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
</script>
<script>${escapedHook}</script>
<script>
(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // A busy Firefox event loop may need more than a fixed 60ms to process
    // postMessage. Wait for actual state, but stay below the 3s mute failsafe.
    const waitFor = async (predicate, timeoutMs = 1800) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (predicate()) return true;
            await sleep(25);
        }
        return predicate();
    };
    const token = "ffffffffffffffffffffffffffffffff";
    const preflightPatched = AudioNode.prototype.connect !== window.__vcNativeConnect;

    const earlyAudio = document.createElement("audio");
    document.body.appendChild(earlyAudio);
    earlyAudio.dispatchEvent(new Event("play"));
    const preflightMuted = window.__vcNativeMuted.get.call(earlyAudio) === true &&
        earlyAudio.muted === false;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token,
        command: "setState",
        version: 3,
        enabled: false,
        dB: 0,
        mono: false,
        muted: false,
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto"
    }, "*");
    const disabledRestored = await waitFor(() =>
        AudioNode.prototype.connect === window.__vcNativeConnect &&
        AudioNode.prototype.disconnect === window.__vcNativeDisconnect &&
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").set === window.__vcNativeVolume.set);
    const preflightRestored = earlyAudio.muted === false;

    window.postMessage({
        source: "volume-control-extension",
        target: "volume-control-page-audio",
        token,
        command: "setState",
        version: 3,
        enabled: true,
        dB: -6,
        mono: false,
        muted: false,
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto"
    }, "*");
    const reenabledPatched = await waitFor(() =>
        AudioNode.prototype.connect !== window.__vcNativeConnect);
    const audio = document.createElement("audio");
    audio.id = "real-recording";
    audio.controls = true;
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = .72;
    audio.src = "/real-recording.mp3";
    document.body.appendChild(audio);
    const approx = (value, target) => Number.isFinite(value) && Math.abs(value - target) < .018;
    const attenuation = 10 ** (-6 / 20);
    // Firefox may leave play() pending indefinitely when its decoder cannot
    // start. A timed, explicit failure is more diagnostic than hanging CI.
    const boundedPlay = element => Promise.race([
        element.play().then(() => true, () => false),
        sleep(5000).then(() => false)
    ]);
    // Decode the actual compressed recording into PCM without opening an
    // output device. Hosted Firefox runners can have NO functional audio sink,
    // producing OnMediaSinkAudioError even when the MP3 decoder works.
    let pcmDecoded = false, pcmFrames = 0, pcmPeak = 0, pcmError = "";
    try {
        const payload = await fetch("/real-recording.mp3").then(r => {
            if (!r.ok) throw Error("PCM fixture HTTP " + r.status);
            return r.arrayBuffer();
        });
        const offline = new OfflineAudioContext(1, 8192, 44100);
        const decodedBuffer = await offline.decodeAudioData(payload);
        pcmFrames = decodedBuffer.length;
        const samples = decodedBuffer.getChannelData(0);
        for (let i = 0; i < samples.length; i += 32) {
            pcmPeak = Math.max(pcmPeak, Math.abs(samples[i]));
        }
        pcmDecoded = pcmFrames > decodedBuffer.sampleRate / 2 && pcmPeak > .001;
    } catch (e) {
        pcmError = String(e?.message || e);
    }

    const loaded = await waitFor(() => audio.readyState >= 2 && !audio.error, 7000);
    let playing = false;
    let outputStatus = "unavailable";
    let outputError = null;
    if (loaded) {
        const played = await boundedPlay(audio);
        playing = played && await waitFor(() => audio.currentTime > .08, 1500);
        await sleep(550);
        outputError = audio.error && { code: audio.error.code, message: audio.error.message };
        if (playing && !outputError && audio.currentTime > .25) {
            outputStatus = "passed";
        } else if (outputError?.message === "OnMediaSinkAudioError") {
            outputStatus = "unavailable-no-audio-sink";
        } else {
            outputStatus = "failed";
        }
    }
    // MP3 decoding is independently verified above. Distinguish a missing
    // runner audio output device from an actual MP3 decode/format error.
    const unexpectedMediaError = outputError && outputError.message !== "OnMediaSinkAudioError";
    audio.pause();
    const scaled = await waitFor(() => approx(audio.volume, .72) &&
        approx(window.__vcNativeVolume.get.call(audio), .72 * attenuation), 2000);
    // Native browser controls bypass the page's patched .volume setter.
    window.__vcNativeVolume.set.call(audio, .5);
    const nativeSlider = await waitFor(() => approx(audio.volume, .5) &&
        approx(window.__vcNativeVolume.get.call(audio), .5 * attenuation), 2000);
    audio.volume = .31;
    const pausedSlider = await waitFor(() => approx(audio.volume, .31) &&
        approx(window.__vcNativeVolume.get.call(audio), .31 * attenuation), 2000);
    // Site-mute choices must survive a Volume Control mute/unmute cycle.
    const sendState = muted => window.postMessage({
        source: "volume-control-extension", target: "volume-control-page-audio",
        token, command: "setState", version: 3, enabled: true, dB: -6,
        mono: false, muted, debugMode: false, forceDrmCapture: false,
        forceCorsCapture: false, debugRouteMode: "auto"
    }, "*");
    sendState(true);
    await sleep(70);
    audio.muted = true;
    sendState(false);
    await sleep(70);
    const preservedSiteMute = audio.muted === true;
    audio.muted = false;
    audio.src = "/real-recording.mp3?track=next";
    audio.load();
    // Source reassignment can be checked even without a usable hardware
    // output sink: require metadata, loaded decoded frames and fresh volume.
    const changedSource = await waitFor(() =>
        audio.currentSrc.includes("track=next") && audio.readyState >= 2 &&
        !audio.error && approx(audio.volume, .31) &&
        approx(window.__vcNativeVolume.get.call(audio), .31 * attenuation), 6000);
    const decoderHealthy = pcmDecoded && !unexpectedMediaError &&
        (outputStatus === "passed" || outputStatus === "unavailable-no-audio-sink");
    const realMedia = {
        pcmDecoded, pcmFrames, pcmPeak, pcmError, loaded,
        playing, outputStatus, outputError, scaled, nativeSlider,
        pausedSlider, preservedSiteMute, changedSource, decoderHealthy,
        readyState: audio.readyState,
        error: audio.error && { code: audio.error.code, message: audio.error.message },
        source: audio.currentSrc, time: audio.currentTime, networkState: audio.networkState
    };
    audio.pause();
    const result = { preflightPatched, preflightMuted, preflightRestored,
        disabledRestored, reenabledPatched, realMedia };
    const pass = preflightPatched && preflightMuted && preflightRestored &&
        disabledRestored && reenabledPatched &&
        Object.entries(realMedia).filter(([key]) =>
            ['pcmDecoded','loaded','scaled','nativeSlider','pausedSlider',
                'preservedSiteMute','changedSource','decoderHealthy'].includes(key))
            .every(([, value]) => value === true);
    location.href = "http://127.0.0.1:${port}/result?pass=" + (pass ? "1" : "0") +
        "&detail=" + encodeURIComponent(JSON.stringify(result));
})();
</script>`;

    // Firefox treats file:// pages differently from regular sites (notably
    // postMessage sender identity). Exercise the bridge on a real HTTP origin,
    // just like the installed-extension smoke and ordinary web pages.
    let stderr = '';
    child = spawn(browser, [
        '-headless',
        '-no-remote',
        '-profile', profile,
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
        if (code && code !== 0) rejectResult(new Error(`Firefox exited early with code ${code}.\n${stderr}`));
    });

    const timeout = setTimeout(() => {
        rejectResult(new Error('Firefox smoke timed out.\n' + stderr));
    }, 75000);

    const result = await resultPromise;
    clearTimeout(timeout);
    if (!result.pass) throw new Error('Firefox smoke failed: ' + result.detail);
    console.log('Firefox smoke passed: preflight, exclusion, and decoded MP3 native slider/mute/source-transition checks: ' + result.detail);
} finally {
    if (child && child.exitCode === null) {
        try { child.kill(); } catch (e) {}
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
    }
    if (server) {
        await new Promise(resolve => {
            try { server.close(() => resolve()); }
            catch (e) { resolve(); }
        });
    }

    // Firefox can hold profile SQLite files briefly after the browser process
    // reports exit on Windows. Retry cleanup; a leftover temp profile must not
    // turn a successful runtime test into a false CI failure.
    let cleaned = false;
    for (let attempt = 0; attempt < 6 && !cleaned; attempt++) {
        try {
            rmSync(work, { recursive: true, force: true });
            cleaned = true;
        } catch (e) {
            if (!e || (e.code !== 'EBUSY' && e.code !== 'EPERM')) throw e;
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    if (!cleaned) console.warn('Firefox smoke passed, but its temporary profile is still locked and will be left for runner cleanup.');
}
