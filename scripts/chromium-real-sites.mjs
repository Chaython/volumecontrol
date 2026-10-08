import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const extensionRoot = resolve(process.env.VC_EXTENSION_DIR || '');
if (!existsSync(join(extensionRoot, 'manifest.json'))) throw Error('VC_EXTENSION_DIR must contain the Chrome extension');
if (typeof WebSocket !== 'function') throw Error('Node 22+ is required');
const binaries = [process.env.EDGE_PATH, process.env.CHROMIUM_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const binary = binaries.find(existsSync);
if (!binary) throw Error('No Edge/Chromium executable');
const sites = [
    { name: 'W3Schools HTML5 video', url: 'https://www.w3schools.com/html/html5_video.asp' },
    { name: 'W3Schools HTML5 audio', url: 'https://www.w3schools.com/html/html5_audio.asp' },
    { name: 'YouTube Big Buck Bunny', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 16000) {
    const deadline = Date.now() + timeout;
    let error;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (e) { error = e; }
        await sleep(200);
    }
    throw Error('Timed out' + (error ? ': ' + error.message : ''));
}
class CDP {
    constructor(socket) {
        this.socket = socket; this.counter = 0; this.pending = new Map();
        socket.addEventListener('message', event => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id); clearTimeout(p.timer);
            if (msg.error) p.reject(Error(msg.error.message));
            else p.resolve(msg.result || {});
        });
    }
    static async open(url) {
        const ws = new WebSocket(url);
        await new Promise((ok, fail) => {
            const timeout = setTimeout(() => fail(Error('CDP socket timeout')), 10000);
            ws.addEventListener('open', () => { clearTimeout(timeout); ok(); }, { once: true });
            ws.addEventListener('error', () => { clearTimeout(timeout); fail(Error('CDP socket error')); }, { once: true });
        });
        return new CDP(ws);
    }
    send(method, params = {}, sessionId) {
        const id = ++this.counter;
        return new Promise((ok, fail) => {
            const timer = setTimeout(() => { this.pending.delete(id); fail(Error('CDP ' + method + ' timed out')); }, 12000);
            this.pending.set(id, { resolve: ok, reject: fail, timer });
            this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
    async attach(targetId) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        await this.send('Runtime.enable', {}, sessionId);
        return sessionId;
    }
    async evaluate(session, expression) {
        const r = await this.send('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true, userGesture: true }, session);
        if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result?.value;
    }
}
const temp = mkdtempSync(join(tmpdir(), 'vc-real-media-'));
const profile = join(temp, 'profile');
let processRef, cdp, mediaServer, baselineBrowser, baselineCDP, stderr = '';
const mediaRequests = [];
const results = [];
const injectionExpression = 'document.body?.classList.contains("vc-init") && ' +
    '(Boolean(AudioNode.prototype.__volumeControlPatched) || AudioNode.prototype.connect.name === "patchedConnect")';
const mediaSnapshot = '(()=>{const a=[...document.querySelectorAll("video,audio")];' +
    'const m=a.find(x=>x.readyState>=2)||a[0];return {' +
    'url:location.href,title:document.title,ready:document.readyState,mediaCount:a.length,' +
    'playing:m?!m.paused&&!m.ended:false,t:m?m.currentTime:null,' +
    'readyState:m?m.readyState:null,errorCode:m?.error?.code||null,'+
    'visibility:document.visibilityState,' +
    'source:m?.currentSrc?.slice(0,100)||"",injected:(' + injectionExpression + ')}})()';
try {
    console.log('Real media browser: ' + binary);
    processRef = spawn(binary, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox',
        '--remote-debugging-port=0', '--user-data-dir=' + profile,
        '--disable-extensions-except=' + extensionRoot,
        '--load-extension=' + extensionRoot, 'about:blank'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    processRef.stderr.on('data', x => { stderr = (stderr + String(x)).slice(-3000); });
    const connection = await waitFor(() => {
        const f = join(profile, 'DevToolsActivePort');
        if (!existsSync(f)) return null;
        const [port, path] = readFileSync(f, 'utf8').trim().split(/\r?\n/);
        return /^\d+$/.test(port) && path ? { port, path } : null;
    });
    cdp = await CDP.open('ws://127.0.0.1:' + connection.port + connection.path);
    const worker = await waitFor(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find(t => t.type === 'service_worker' &&
            t.url.startsWith('chrome-extension://') && t.url.includes('/background.js'));
    });
    const extensionId = new URL(worker.url).hostname;
    const { targetId: optionsId } = await cdp.send('Target.createTarget',
        { url: 'chrome-extension://' + extensionId + '/options.html', background: true });
    const optionsSession = await cdp.attach(optionsId);
    await waitFor(async () => await cdp.evaluate(optionsSession,
        'document.readyState==="complete"&&!!document.getElementById("normalizerDefaultEnabled")'));
    await cdp.evaluate(optionsSession,
        'window.probe={' +
        'tabs:()=>new Promise((ok,fail)=>chrome.tabs.query({},v=>chrome.runtime.lastError?fail(Error(chrome.runtime.lastError.message)):ok(v))),' +
        'send:(id,cmd)=>new Promise((ok,fail)=>chrome.tabs.sendMessage(id,cmd,{frameId:0},v=>chrome.runtime.lastError?fail(Error(chrome.runtime.lastError.message)):ok(v)))};true');
    for (const site of sites) {
        const entry = { site: site.name, url: site.url, status: 'inconclusive' };
        results.push(entry);
        let targetId;
        try {
            ({ targetId } = await cdp.send('Target.createTarget', { url: site.url, background: false }));
            await cdp.send('Target.activateTarget', { targetId });
            const session = await cdp.attach(targetId);
            const page = await waitFor(async () => {
                const data = await cdp.evaluate(session, mediaSnapshot);
                return data && data.ready === 'complete' && data.url.startsWith('https://') ? data : null;
            }, 26000);
            entry.page = page;
            if (!page.injected) {
                entry.reason = 'Page did not accept extension injection';
                continue;
            }
            const tabId = await waitFor(async () => {
                const tabs = await cdp.evaluate(optionsSession, 'probe.tabs()');
                return tabs?.find(t => t.url?.startsWith(site.url))?.id || null;
            });
            const send = cmd => cdp.evaluate(optionsSession,
                'probe.send(' + tabId + ',' + JSON.stringify(cmd) + ')');
            const state = async () => (await send({ command: 'getAudioControlState' }))?.response;
            const initial = await state();
            if (!Number.isFinite(initial?.volume)) throw Error('Audio control state unavailable');
            await send({ command: 'setVolume', dB: -12 });
            entry.attenuation = (await state())?.volume === -12;
            await send({ command: 'setVolume', dB: 0 });
            if (!entry.attenuation) {
                entry.status = 'failed'; entry.reason = 'Negative volume control ignored'; continue;
            }
            entry.playAttempt = await cdp.evaluate(session,
                '(()=>{const a=[...document.querySelectorAll("video,audio")];' +
                'const m=a.find(x=>x.readyState>=2)||a[0];if(!m)return {found:false};' +
                'try{m.muted=false;const p=m.play();p?.catch?.(()=>{});' +
                'return {found:true,readyState:m.readyState,src:m.currentSrc?.slice(0,100)}}' +
                'catch(e){return {found:true,error:String(e)}}})()');
            if (entry.playAttempt.found) {
                try {
                    const before = await waitFor(async () => {
                        const x = await cdp.evaluate(session, mediaSnapshot);
                        return x?.playing && x.readyState >= 2 ? x : null;
                    }, 13000);
                    await sleep(1700);
                    const after = await cdp.evaluate(session, mediaSnapshot);
                    entry.playback = { from: before.t, to: after.t, playing: Boolean(after?.playing && after.t > before.t + 0.3),
                        readyState: after?.readyState };
                } catch (e) { entry.playback = { playing: false, reason: e.message }; }
            }
            await send({ command: 'setMono', mono: true });
            entry.mono = (await state())?.mono === true;
            await send({ command: 'setMono', mono: false });
            await send({ command: 'setMute', muted: true });
            entry.mute = (await state())?.muted === true;
            await send({ command: 'setMute', muted: false });
            await send({ command: 'setNormalizer', enabled: true });
            entry.normalizerOn = (await state())?.normalizerEnabled === true;
            // Allow the 100ms sampler to produce an actual output peak.
            await sleep(450);
            const m = (await send({ command: 'getMeterState' }))?.response;
            entry.meter = { enabled: m?.normalizerEnabled, available: m?.normalizerAvailable,
                peakDb: m?.peakDb, gainDb: m?.gainDb };
            await send({ command: 'setNormalizer', enabled: false });
            entry.normalizerOff = (await state())?.normalizerEnabled === false;
            if (!entry.mono || !entry.mute || !entry.normalizerOn || !entry.normalizerOff) {
                entry.status = 'failed'; entry.reason = 'Real-site tab control failed';
            } else if (entry.playback?.playing) {
                entry.status = 'passed';
            } else {
                entry.reason = 'Playback did not advance (network/consent/codec/bot restriction possible)';
            }
        } catch (e) {
            entry.reason = String(e?.message || e);
        } finally {
            console.log('SITE ' + entry.site + ' ' + JSON.stringify(entry));
            if (targetId) try { await cdp.send('Target.closeTarget', { targetId }); } catch (_) {}
        }
    }

    // These are REAL compressed audio/video samples downloaded from public
    // educational sites, not generated tones. Serving them from localhost
    // separates playback bugs from external website automation restrictions.
    const samples = [
        { path: '/audio.mp3', type: 'audio/mpeg', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3' },
        { path: '/video.mp4', type: 'video/mp4', url: 'https://www.w3schools.com/html/mov_bbb.mp4' }
    ];
    for (const s of samples) {
        try {
            const response = await fetch(s.url, { signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw Error('HTTP ' + response.status);
            s.bytes = Buffer.from(await response.arrayBuffer());
            if (s.bytes.length < 1000 || s.bytes.length > 25_000_000) throw Error('Unexpected media length ' + s.bytes.length);
            console.log('DOWNLOADED_REAL_MEDIA ' + s.path + ' ' + s.bytes.length + ' bytes');
        } catch (error) {
            console.warn('REAL_MEDIA_DOWNLOAD_FAILED ' + s.url + ' ' + error.message);
        }
    }
    mediaServer = createServer((req, res) => {
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        if (path.endsWith('.mp3') || path.endsWith('.mp4')) {
            mediaRequests.push({ path, method: req.method, range: req.headers.range || '' });
        }
        const sample = samples.find(s => s.path === path);
        if (!sample || !sample.bytes) {
            if (path !== '/test.html') {
                res.writeHead(404); res.end('Media unavailable'); return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end('<!doctype html><meta charset="utf-8"><title>Real recorded media fixture</title>' +
                '<video id="video" controls preload="auto" src="/video.mp4"></video>' +
                '<audio id="audio" controls preload="auto" src="/audio.mp3"></audio>');
            return;
        }
        const range = /^bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const start = range ? Math.min(sample.bytes.length - 1, Number(range[1])) : 0;
        const end = range && range[2] ? Math.min(sample.bytes.length - 1, Number(range[2])) : sample.bytes.length - 1;
        res.writeHead(range ? 206 : 200, {
            'Content-Type': sample.type,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + sample.bytes.length } : {})
        });
        res.end(sample.bytes.subarray(start, end + 1));
    });
    await new Promise((ok, fail) => {
        mediaServer.once('error', fail);
        mediaServer.listen(0, '127.0.0.1', ok);
    });
    const localPage = 'http://127.0.0.1:' + mediaServer.address().port + '/test.html';
    const downloaded = samples.filter(s => s.bytes);
    if (downloaded.length) {
        const { targetId: fixtureId } = await cdp.send('Target.createTarget', { url: localPage, background: false });
        await cdp.send('Target.activateTarget', { targetId: fixtureId });
        const fixtureSession = await cdp.attach(fixtureId);
        try {
            await waitFor(async () => await cdp.evaluate(fixtureSession,
                'document.body?.classList.contains("vc-init")'), 12000);
            const tabId = await waitFor(async () => {
                const tabs = await cdp.evaluate(optionsSession, 'probe.tabs()');
                return tabs?.find(t => t.url === localPage)?.id || null;
            });
            const send = cmd => cdp.evaluate(optionsSession,
                'probe.send(' + tabId + ',' + JSON.stringify(cmd) + ')');
            for (const s of downloaded) {
                const kind = s.path === '/video.mp4' ? 'video' : 'audio';
                const started = await cdp.evaluate(fixtureSession,
                    '(()=>{const m=document.getElementById(' + JSON.stringify(kind) + ');' +
                    'm.muted=false;m.preload="auto";const p=m.play();p?.catch?.(()=>{});' +
                    'return {readyState:m.readyState,src:m.currentSrc,visibility:document.visibilityState}})()');
                try {
                    const before = await waitFor(async () => {
                        const x = await cdp.evaluate(fixtureSession,
                            '(()=>{const m=document.getElementById(' + JSON.stringify(kind) + ');' +
                            'return {t:m.currentTime,ready:m.readyState,paused:m.paused,error:m.error?.code}})()');
                        return x.ready >= 2 && !x.paused ? x : null;
                    }, 12000);
                    await sleep(850);
                    const after = await cdp.evaluate(fixtureSession,
                        '(()=>{const m=document.getElementById(' + JSON.stringify(kind) + ');' +
                        'return {t:m.currentTime,ready:m.readyState,paused:m.paused,error:m.error?.code}})()');
                    const progressed = after.t > before.t + 0.2;
                    await send({ command: 'setVolume', dB: -12 });
                    const down = (await send({ command: 'getAudioControlState' }))?.response?.volume === -12;
                    await send({ command: 'setNormalizer', enabled: true });
                    await sleep(300);
                    const meter = (await send({ command: 'getMeterState' }))?.response;
                    await send({ command: 'setNormalizer', enabled: false });
                    await send({ command: 'setVolume', dB: 0 });
                    const entry = { site: 'Downloaded real ' + kind, source: s.url,
                        status: progressed && down ? 'passed' : 'failed', playback: { before, after, progressed },
                        attenuation: down, meter };
                    results.push(entry);
                    console.log('RECORDED_MEDIA_RESULT=' + JSON.stringify(entry));
                } catch (error) {
                    const entry = { site: 'Downloaded real ' + kind, source: s.url,
                        status: 'failed', reason: error.message, started };
                    results.push(entry);
                    console.log('RECORDED_MEDIA_RESULT=' + JSON.stringify(entry));
                }
                await cdp.evaluate(fixtureSession,
                    '(()=>{const m=document.getElementById(' + JSON.stringify(kind) + ');m.pause();return true})()');
            }
            // Real decoded MP4 playlist-style transition: the same media
            // element moves between two distinct source URLs. This exposes
            // source-rewiring and tab-volume reset bugs even when YouTube
            // refuses to provide a playable stream to headless browsers.
            if (downloaded.some(x => x.path === '/video.mp4')) {
                const entry = { site: 'Real MP4 same-element playlist transition',
                    status: 'inconclusive' };
                results.push(entry);
                try {
                    await send({ command: 'setVolume', dB: -13 });
                    await send({ command: 'setNormalizer', enabled: true });
                    const step = async index => {
                        await cdp.evaluate(fixtureSession,
                            '(()=>{const m=document.getElementById("video");' +
                            'm.src="/video.mp4?track=' + index + '";m.load();m.play()?.catch?.(()=>{});' +
                            'return true})()');
                        const first = await waitFor(async () => {
                            const x = await cdp.evaluate(fixtureSession,
                                '(()=>{const m=document.getElementById("video");' +
                                'return {t:m.currentTime,ready:m.readyState,paused:m.paused,' +
                                'source:m.currentSrc,error:m.error?.code}})()');
                            return x.ready >= 2 && !x.paused ? x : null;
                        }, 12000);
                        await sleep(650);
                        const second = await cdp.evaluate(fixtureSession,
                            'document.getElementById("video").currentTime');
                        return { from: first.t, to: second,
                            progressed: second > first.t + 0.2, source: first.source };
                    };
                    entry.first = await step('one');
                    entry.second = await step('two');
                    const after = (await send({ command: 'getAudioControlState' }))?.response;
                    entry.volumeKept = after?.volume === -13;
                    entry.normalizerKept = after?.normalizerEnabled === true;
                    entry.meter = (await send({ command: 'getMeterState' }))?.response;
                    entry.status = entry.first.progressed && entry.second.progressed &&
                        entry.volumeKept && entry.normalizerKept ? 'passed' : 'failed';
                } catch (e) {
                    entry.status = 'failed'; entry.reason = e.message;
                } finally {
                    try {
                        await send({ command: 'setNormalizer', enabled: false });
                        await send({ command: 'setVolume', dB: 0 });
                        await cdp.evaluate(fixtureSession,
                            'document.getElementById("video").pause();true');
                    } catch (_) {}
                    console.log('RECORDED_PLAYLIST_RESULT=' + JSON.stringify(entry));
                }
            }
        } finally {
            await cdp.send('Target.closeTarget', { targetId: fixtureId });
        }
    }


    // Control experiment: identical recorded media, same headless Edge binary
    // and HTTP server, but a FRESH browser profile with extensions disabled.
    // Without this comparison, a Windows Server codec/headless limitation can
    // easily be mistaken for a Volume Control regression.
    if (downloaded.length) {
        const baselineProfile = join(temp, 'baseline-profile');
        baselineBrowser = spawn(binary, [
            '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
            '--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
            '--remote-debugging-port=0', '--disable-extensions',
            '--user-data-dir=' + baselineProfile, localPage
        ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        const port = await waitFor(() => {
            const f = join(baselineProfile, 'DevToolsActivePort');
            if (!existsSync(f)) return null;
            const [port, path] = readFileSync(f, 'utf8').trim().split(/\r?\n/);
            return /^\d+$/.test(port) && path ? { port, path } : null;
        });
        baselineCDP = await CDP.open('ws://127.0.0.1:' + port.port + port.path);
        const btab = await waitFor(async () => {
            const x = await baselineCDP.send('Target.getTargets');
            return x.targetInfos.find(t => t.type === 'page' && t.url === localPage);
        });
        const bsession = await baselineCDP.attach(btab.targetId);
        for (const sample of downloaded) {
            const kind = sample.path.endsWith('.mp3') ? 'audio' : 'video';
            try {
                await waitFor(async () => await baselineCDP.evaluate(bsession,
                    'document.readyState === "complete" && !!document.getElementById(' + JSON.stringify(kind) + ')'));
                const before = await baselineCDP.evaluate(bsession,
                    '(()=>{const m=document.getElementById(' + JSON.stringify(kind) + ');m.load();' +
                    'm.play()?.catch?.(()=>{});return {t:m.currentTime,ready:m.readyState,network:m.networkState,error:m.error?.code}})()');
                await sleep(2500);
                const after = await baselineCDP.evaluate(bsession,
                    '(()=>{const m=document.getElementById(' + JSON.stringify(kind) + ');' +
                    'return {t:m.currentTime,ready:m.readyState,network:m.networkState,' +
                    'paused:m.paused,error:m.error?.code,src:m.currentSrc,visibility:document.visibilityState}})()');
                const progressed = after.t > before.t + 0.2;
                console.log('WITHOUT_EXTENSION_BASELINE=' + JSON.stringify({ kind, before, after, progressed }));
                results.push({ site: 'Without extension ' + kind, status: progressed ? 'passed' : 'inconclusive',
                    baseline: true, playback: { before, after, progressed } });
                await baselineCDP.evaluate(bsession,
                    '(()=>{document.getElementById(' + JSON.stringify(kind) + ').pause();return true})()');
            } catch (e) {
                console.log('WITHOUT_EXTENSION_BASELINE_ERROR=' + JSON.stringify({ kind, error: e.message }));
            }
        }
    }

    // Cross-check YouTube itself without any extension. Otherwise a login,
    // region or anti-automation gate could be misdiagnosed as an audio bug.
    if (baselineCDP) {
        const youtubeUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
        let target;
        try {
            ({ targetId: target } = await baselineCDP.send('Target.createTarget',
                { url: youtubeUrl, background: false }));
            await baselineCDP.send('Target.activateTarget', { targetId: target });
            const session = await baselineCDP.attach(target);
            const before = await waitFor(async () => {
                const data = await baselineCDP.evaluate(session, mediaSnapshot);
                return data?.ready === 'complete' && data.url.startsWith('https://') ? data : null;
            }, 24000);
            await baselineCDP.evaluate(session,
                '(()=>{const m=document.querySelector("video");if(!m)return false;' +
                'm.play()?.catch?.(()=>{});return true})()');
            await sleep(6500);
            const after = await baselineCDP.evaluate(session, mediaSnapshot);
            const progressed = Number.isFinite(before.t) && Number.isFinite(after?.t) &&
                after.t > before.t + 0.25;
            console.log('WITHOUT_EXTENSION_YOUTUBE=' + JSON.stringify({ before, after, progressed }));
            results.push({ site: 'YouTube without extension', baseline: true,
                status: progressed ? 'passed' : 'inconclusive',
                playback: { before, after, progressed } });
        } catch (e) {
            console.log('WITHOUT_EXTENSION_YOUTUBE_ERROR=' + e.message);
        } finally {
            if (target) try { await baselineCDP.send('Target.closeTarget', { targetId: target }); } catch (_) {}
        }
    }


    // Genuine YouTube playlist test, alongside the single-video control.
    // This playlist contains public Blender videos, including Big Buck Bunny.
    // Verify actual playlist UI/navigation independently of video decoding:
    // YouTube's headless anti-automation behavior may prevent playable data.
    const playlistUrl = 'https://www.youtube.com/watch?v=YE7VzlLtp-4&list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz&index=14';
    async function probeYouTubePlaylist(browserCdp, label, extensionEnabled) {
        const result = { site: 'YouTube Blender open-movie playlist', label,
            url: playlistUrl, withExtension: extensionEnabled, status: 'inconclusive' };
        results.push(result);
        let targetId;
        try {
            ({ targetId } = await browserCdp.send('Target.createTarget', {
                url: playlistUrl, background: false
            }));
            await browserCdp.send('Target.activateTarget', { targetId });
            const session = await browserCdp.attach(targetId);
            await waitFor(async () => await browserCdp.evaluate(session,
                'document.readyState === "complete" && location.host.endsWith("youtube.com")'), 24000);
            await sleep(5000);
            const read = '(()=>({' +
                'url:location.href,title:document.title,visibility:document.visibilityState,' +
                'playlistId:new URL(location.href).searchParams.get("list"),' +
                'playlistPanel:!!document.querySelector("ytd-playlist-panel-renderer"),' +
                'playlistEntries:document.querySelectorAll("ytd-playlist-panel-video-renderer").length,' +
                'selectedVideo:document.querySelector("ytd-playlist-panel-video-renderer[selected]")?.getAttribute("video-id")||null,' +
                'nextButton:!!document.querySelector(".ytp-next-button"),' +
                'videoReady:document.querySelector("video")?.readyState||0,' +
                'videoTime:document.querySelector("video")?.currentTime||0})())';
            result.before = await browserCdp.evaluate(session, read);
            let tabId, send;
            if (extensionEnabled) {
                tabId = await waitFor(async () => {
                    const tabs = await cdp.evaluate(optionsSession, 'probe.tabs()');
                    return tabs?.find(t => t.url?.startsWith('https://www.youtube.com/watch?v=YE7VzlLtp-4&list='))?.id || null;
                }, 11000);
                send = command => cdp.evaluate(optionsSession,
                    'probe.send(' + tabId + ',' + JSON.stringify(command) + ')');
                const initial = (await send({ command: 'getAudioControlState' }))?.response;
                result.extensionInjected = await browserCdp.evaluate(session, injectionExpression);
                result.previousVolume = initial?.volume;
                await send({ command: 'setVolume', dB: -13 });
                result.sliderSet = (await send({ command: 'getAudioControlState' }))?.response?.volume === -13;
                await send({ command: 'setNormalizer', enabled: true });
                result.normalizerSet = (await send({ command: 'getAudioControlState' }))?.response?.normalizerEnabled === true;
            }
            // Prefer the native Next command. It exercises YouTube's player
            // playlist transition rather than opening an unrelated video URL.
            result.nextAction = await browserCdp.evaluate(session,
                '(()=>{const button=document.querySelector(".ytp-next-button");' +
                'if(button&&!button.disabled){button.click();return "player-next-button";}' +
                'const item=document.querySelector("ytd-playlist-panel-video-renderer:not([selected]) a#thumbnail");' +
                'if(item){item.click();return "playlist-item";}return "not-available"})()');
            try {
                await waitFor(async () => {
                    const data = await browserCdp.evaluate(session, read);
                    return data?.url !== result.before.url ? data : null;
                }, 10000);
            } catch (_) {}
            result.after = await browserCdp.evaluate(session, read);
            result.navigationChanged = result.after.url !== result.before.url;
            await sleep(1500);
            if (extensionEnabled) {
                try {
                    const after = (await send({ command: 'getAudioControlState' }))?.response;
                    result.volumeAfterNext = after?.volume;
                    result.volumeKept = after?.volume === -13;
                    result.normalizerAfterNext = after?.normalizerEnabled;
                    result.meter = (await send({ command: 'getMeterState' }))?.response;
                    await send({ command: 'setNormalizer', enabled: false });
                    await send({ command: 'setVolume', dB: 0 });
                } catch (e) {
                    result.settingsAfterNextError = e.message;
                }
            }
            result.status = result.navigationChanged ? 'playlist-navigation-only' : 'inconclusive';
            result.playbackVerified = result.before.videoReady >= 2 &&
                result.after.videoReady >= 2 && result.after.videoTime > result.before.videoTime + 0.2;
            if (result.playbackVerified) {
                result.status = 'passed';
                if (extensionEnabled && result.navigationChanged && result.volumeKept === false) {
                    result.status = 'failed';
                    result.reason = 'Volume reset during a verified YouTube playlist transition';
                }
            }
            console.log('YOUTUBE_PLAYLIST_RESULT=' + JSON.stringify(result));
        } catch (error) {
            result.reason = String(error?.message || error);
            console.log('YOUTUBE_PLAYLIST_RESULT=' + JSON.stringify(result));
        } finally {
            if (targetId) try { await browserCdp.send('Target.closeTarget', { targetId }); } catch (_) {}
        }
    }
    await probeYouTubePlaylist(cdp, 'extension', true);
    if (baselineCDP) await probeYouTubePlaylist(baselineCDP, 'no-extension', false);

    console.log('REAL_MEDIA_HTTP_REQUESTS=' + JSON.stringify(mediaRequests));

    const played = results.filter(r => r.playback?.playing || r.playback?.progressed).length;
    console.log('REAL_SITE_REPORT=' + JSON.stringify({ played, results }));
    if (results.some(r => r.status === 'failed')) process.exitCode = 1;
    if (!played) console.warn('INCONCLUSIVE: no real stream advanced; do not report a playback pass');
} catch (e) {
    console.error('REAL_SITE_RUNNER_FAILURE=' + (e?.stack || e));
    if (stderr) console.error('BROWSER_STDERR=' + stderr);
    process.exitCode = 1;
} finally {
    if (baselineCDP) try { baselineCDP.socket.close(); } catch (_) {}
    if (baselineBrowser && baselineBrowser.exitCode === null) {
        try { baselineBrowser.kill(); } catch (_) {}
        await Promise.race([new Promise(ok => baselineBrowser.once('exit', ok)), sleep(3000)]);
    }
    if (cdp) try { cdp.socket.close(); } catch (_) {}
    if (processRef && processRef.exitCode === null) {
        try { processRef.kill(); } catch (_) {}
        await Promise.race([new Promise(ok => processRef.once('exit', ok)), sleep(3000)]);
    }
    if (mediaServer) await new Promise(ok => { try { mediaServer.close(ok); } catch (_) { ok(); } });
    rmSync(temp, { recursive: true, force: true });
}