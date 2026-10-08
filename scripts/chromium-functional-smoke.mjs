import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.env.VC_EXTENSION_DIR && resolve(process.env.VC_EXTENSION_DIR);
if (!root || !existsSync(join(root, 'manifest.json'))) throw Error('Missing packaged extension at VC_EXTENSION_DIR');
if (typeof WebSocket !== 'function') throw Error('Node 22+ built-in WebSocket is required');
const candidates = [process.env.CHROMIUM_PATH, process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const binary = candidates.find(existsSync);
if (!binary) throw Error('No Chromium/Edge binary available');
const temp = mkdtempSync(join(tmpdir(), 'vc-chromium-functions-'));
const profile = join(temp, 'profile');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, ms = 16000) {
    const until = Date.now() + ms;
    let error;
    while (Date.now() < until) {
        try { const v = await fn(); if (v) return v; } catch (e) { error = e; }
        await sleep(100);
    }
    throw Error('Timed out: ' + (error ? error.message : 'no result'));
}
class CDP {
    constructor(ws) {
        this.ws = ws; this.pending = new Map(); this.next = 0;
        ws.addEventListener('message', event => {
            let message;
            try { message = JSON.parse(event.data); } catch (_) { return; }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timeout);
            if (message.error) pending.reject(Error(message.error.message));
            else pending.resolve(message.result || {});
        });
    }
    static async connect(url) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('WebSocket connection timeout')), 12000);
            ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
            ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('WebSocket failed')); }, { once: true });
        });
        return new CDP(ws);
    }
    send(method, params = {}, sessionId) {
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { this.pending.delete(id); reject(Error('CDP ' + method + ' timed out')); }, 12000);
            this.pending.set(id, { resolve, reject, timeout });
            const message = { id, method, params };
            if (sessionId) message.sessionId = sessionId;
            this.ws.send(JSON.stringify(message));
        });
    }
    async attach(targetId) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        await this.send('Runtime.enable', {}, sessionId);
        return sessionId;
    }
    async eval(sessionId, expression) {
        const r = await this.send('Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
        if (r.exceptionDetails) throw Error('Browser JS: ' +
            (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result?.value;
    }
}
let server, browser, cdp, stderr = '';
const results = [];
function check(label, pass, details) {
    results.push({ label, pass: Boolean(pass) });
    if (!pass) throw Error('FAILED: ' + label + (details ? ' ' + JSON.stringify(details) : ''));
    console.log('PASS ' + label);
}
try {
    const html = '<!doctype html><title>VC functional browser smoke</title><body><audio id="a"></audio>' +
        '<video id="v"></video></body><script>window.startTone=async()=>{' +
        'const ctx=new AudioContext();const o=ctx.createOscillator();const g=ctx.createGain();' +
        'g.gain.value=0.05;o.connect(g);g.connect(ctx.destination);await ctx.resume();' +
        'o.start();window.vcTone={ctx,o,g};return ctx.state;};</script>';
    server = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(html);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port + '/';
    browser = spawn(binary, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--no-sandbox', '--mute-audio',
        '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0',
        '--user-data-dir=' + profile, '--disable-extensions-except=' + root,
        '--load-extension=' + root, origin
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', b => { stderr += String(b); stderr = stderr.slice(-9000); });
    const active = await waitFor(() => {
        const path = join(profile, 'DevToolsActivePort');
        if (!existsSync(path)) return null;
        const [port, socket] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
        return /^\d+$/.test(port) && socket ? { port, socket } : null;
    });
    cdp = await CDP.connect('ws://127.0.0.1:' + active.port + active.socket);
    const targets = await waitFor(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const tab = targetInfos.find(t => t.type === 'page' && t.url.startsWith(origin));
        const ext = targetInfos.find(t => t.url.startsWith('chrome-extension://') && t.url.includes('/background.js'));
        return tab && ext ? { tab, ext } : null;
    }, 20000);
    const id = new URL(targets.ext.url).hostname;
    console.log('Extension target: ' + targets.ext.type + ' ' + targets.ext.url);
    const tabSession = await cdp.attach(targets.tab.targetId);
    await waitFor(async () => await cdp.eval(tabSession,
        'document.body.classList.contains("vc-init") && (AudioNode.prototype.__volumeControlPatched || AudioNode.prototype.connect.name === "patchedConnect")'));
    check('Real MAIN and isolated content scripts injected', true);
    const { targetId: settingsTarget } = await cdp.send('Target.createTarget', {
        url: 'chrome-extension://' + id + '/options.html', background: true
    });
    const settingsSession = await cdp.attach(settingsTarget);
    await sleep(750);
    console.log('Options target diagnostics: ' + JSON.stringify(await cdp.eval(settingsSession,
        '({url: location.href, ready: document.readyState, title: document.title, hasOptions: !!document.getElementById("normalizerDefaultEnabled")})')));
    await waitFor(async () => await cdp.eval(settingsSession,
        'document.readyState === "complete" && !!document.querySelector("#normalizerDefaultEnabled")'));
    await cdp.eval(settingsSession,
        'window.vcTest={tabs:()=>new Promise((ok,fail)=>chrome.tabs.query({},v=>chrome.runtime.lastError?fail(Error(chrome.runtime.lastError.message)):ok(v))),' +
        'send:(id,msg)=>new Promise((ok,fail)=>chrome.tabs.sendMessage(id,msg,{frameId:0},v=>chrome.runtime.lastError?fail(Error(chrome.runtime.lastError.message)):ok(v))),' +
        'get:(keys)=>new Promise((ok,fail)=>chrome.storage.local.get(keys,v=>chrome.runtime.lastError?fail(Error(chrome.runtime.lastError.message)):ok(v)))};true');
    const tabId = await waitFor(async () => await cdp.eval(settingsSession,
        '(async()=>{const tabs=await vcTest.tabs();const tab=tabs.find(t=>t.url&&t.url.startsWith(' +
        JSON.stringify(origin) + '));return tab&&tab.id;})()'));
    const send = message => cdp.eval(settingsSession,
        'vcTest.send(' + tabId + ',' + JSON.stringify(message) + ')');
    const state = async () => (await send({ command: 'getAudioControlState' }))?.response;

    check('Volume starts at 0 dB', (await state())?.volume === 0);
    check('Boost +12 dB', (await send({ command: 'setVolume', dB: 12 }))?.response?.volume === 12);
    check('Attenuate -20 dB', (await send({ command: 'setVolume', dB: -20 }))?.response?.volume === -20);
    await send({ command: 'setVolume', dB: 0 });
    await send({ command: 'setMute', muted: true });
    check('Mute enabled', (await state())?.muted === true);
    await send({ command: 'setMute', muted: false });
    check('Mute disabled', (await state())?.muted === false);
    await send({ command: 'setMono', mono: true });
    check('Mono enabled', (await state())?.mono === true);
    await send({ command: 'setMono', mono: false });
    check('Mono disabled', (await state())?.mono === false);
    await send({ command: 'setNormalizer', enabled: true });
    check('Normalize enabled', (await state())?.normalizerEnabled === true);
    check('Real WebAudio oscillator running', await cdp.eval(tabSession, 'window.startTone()') === 'running');
    await sleep(250);
    const meter = (await send({ command: 'getMeterState' }))?.response;
    check('Normalizer meter responds', meter?.normalizerEnabled === true && Object.hasOwn(meter, 'peakDb'), meter);
    await send({ command: 'setNormalizer', enabled: false });
    check('Normalize disabled', (await state())?.normalizerEnabled === false);
    check('Options default is folded', await cdp.eval(settingsSession,
        'document.querySelector("#normalizer-options-details").hidden === true'));
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("normalizerDefaultEnabled");e.checked=true;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => await cdp.eval(settingsSession,
        '(async()=> (await vcTest.get("normalizerDefaultEnabled")).normalizerDefaultEnabled === true && ' +
        '!document.getElementById("normalizer-options-details").hidden)()'));
    check('Options global normalize toggle persists and expands', true);
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("normalizerDefaultEnabled");e.checked=false;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => await cdp.eval(settingsSession,
        '(async()=> (await vcTest.get("normalizerDefaultEnabled")).normalizerDefaultEnabled === false && ' +
        'document.getElementById("normalizer-options-details").hidden)()'));
    check('Options global normalize toggle folds when off', true);
    const commands = await cdp.eval(settingsSession,
        'new Promise((ok,fail)=>chrome.commands.getAll(v=>chrome.runtime.lastError?' +
        'fail(Error(chrome.runtime.lastError.message)):ok(v.map(x=>x.name))))');
    check('Core keyboard shortcut commands registered',
        ['volume-up','volume-down','volume-reset','toggle-mono','toggle-mute'].every(x=>commands.includes(x)),commands);
    const { targetId: popupTarget } = await cdp.send('Target.createTarget', {
        url: 'chrome-extension://' + id + '/popup.html', background: true
    });
    const popupSession = await cdp.attach(popupTarget);
    await waitFor(async () => await cdp.eval(popupSession,
        'document.readyState === "complete" && !!document.querySelector("#volume-slider")'));
    const view = await cdp.eval(popupSession,
        '({width:parseFloat(getComputedStyle(document.body).width),' +
        'folded:document.getElementById("normalizer-details").hidden,' +
        'min:document.getElementById("volume-slider").min,' +
        'max:document.getElementById("volume-slider").max})');
    check('Desktop popup width 420px', Math.abs(view.width-420)<1,view);
    check('Popup normalizer controls folded by default', view.folded === true);
    check('Popup volume range -32 to +32 dB', view.min === '-32' && view.max === '32');

    const selectedTab = await waitFor(async () => await cdp.eval(popupSession,
        '(typeof cached !== "undefined" && cached.activeTab && cached.activeTab.id) || null'));
    check('Popup binds the actual web tab', selectedTab === tabId, { selectedTab, tabId });

    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("volume-slider");e.value="7";' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await state())?.volume === 7);
    check('Popup slider updates active-tab gain', true);
    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("volume-text");e.value="-15";' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await state())?.volume === -15);
    check('Popup typed volume commits to active tab', true);
    await cdp.eval(popupSession,
        'document.getElementById("mute-btn").click();true');
    await waitFor(async () => (await state())?.muted === true);
    check('Popup mute button works', true);
    await cdp.eval(popupSession, 'document.getElementById("mute-btn").click();true');
    await waitFor(async () => (await state())?.muted === false);
    check('Popup unmutes', true);
    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("mono-checkbox");e.checked=true;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await state())?.mono === true);
    check('Popup mono switch works', true);
    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("mono-checkbox");e.checked=false;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await state())?.mono === false);
    check('Popup mono off works', true);

    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("normalizer-checkbox");e.checked=true;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await state())?.normalizerEnabled === true);
    check('Popup Normalize switch enables processing', true);
    const savedNorm = await waitFor(async () => {
        const obj = await cdp.eval(settingsSession, 'vcTest.get("siteNormalizerSettings")');
        const values = Object.values(obj?.siteNormalizerSettings || {});
        return values.some(x => x?.enabled === true) ? obj : null;
    });
    check('Normalize setting persists separately per site', Boolean(savedNorm.siteNormalizerSettings));
    check('Popup meter details expand on enable', await cdp.eval(popupSession,
        '!document.getElementById("normalizer-details").hidden'));
    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("normalizer-checkbox");e.checked=false;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await state())?.normalizerEnabled === false);
    check('Popup Normalize off and folded', await cdp.eval(popupSession,
        'document.getElementById("normalizer-details").hidden'));

    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("remember-checkbox");e.checked=true;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    const remembered = await waitFor(async () => {
        const obj = await cdp.eval(settingsSession,'vcTest.get("siteSettings")');
        return Object.keys(obj?.siteSettings || {}).length ? obj.siteSettings : null;
    });
    check('Popup Remember persists volume/mono/mute independently', Object.keys(remembered).length > 0);
    await cdp.eval(popupSession,
        '(()=>{const e=document.getElementById("remember-checkbox");e.checked=false;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => {
        const obj = await cdp.eval(settingsSession, 'vcTest.get("siteSettings")');
        return !Object.keys(obj?.siteSettings || {}).length;
    });
    check('Popup Remember can be disabled and removes its profile', true);

    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("normalizerTargetDb");e.value="-19";' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession,'vcTest.get("normalizerConfig")');
        return data?.normalizerConfig?.targetDb === -19;
    });
    check('Options loudness target persists', true);
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("normalizerTargetDb");e.value="-16";' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');

    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("newFqdn");e.value="browser-smoke.invalid";' +
        'document.getElementById("addFqdn").click();return true})()');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession,'vcTest.get("fqdns")');
        return Array.isArray(data?.fqdns) && data.fqdns.includes('browser-smoke.invalid');
    });
    check('Options blocklist add persists to storage', true);
    check('Options blocklist renders added entry', await cdp.eval(settingsSession,
        'document.getElementById("fqdnList").textContent.includes("browser-smoke.invalid")'));
    
    // Multiple tabs with Remember disabled must retain independent state.
    const { targetId: secondTarget } = await cdp.send('Target.createTarget', {
        url: origin + '?second=1', background: true
    });
    const secondSession = await cdp.attach(secondTarget);
    await waitFor(async () => await cdp.eval(secondSession,
        'document.body.classList.contains("vc-init") && (AudioNode.prototype.__volumeControlPatched || AudioNode.prototype.connect.name === "patchedConnect")'));
    const secondId = await waitFor(async () => await cdp.eval(settingsSession,
        '(async()=>{const tabs=await vcTest.tabs();const t=tabs.find(x=>x.url&&x.url.includes("?second=1"));return t&&t.id;})()'));
    const secondState = await cdp.eval(settingsSession,
        'vcTest.send(' + secondId + ',{"command":"getAudioControlState"})');
    check('Fresh second tab starts at 0 dB without Remember', secondState?.response?.volume === 0, secondState);
    check('First tab retains independent volume', (await state())?.volume === -15);

    // Exercise access lists (including deletion and whitelist mode) in the
    // real Options page instead of just checking that UI elements exist.
    await cdp.eval(settingsSession, 'document.querySelector("#fqdnList .remove-btn").click();true');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession, 'vcTest.get("fqdns")');
        return !data?.fqdns?.includes('browser-smoke.invalid');
    });
    check('Options blocklist removes entry', true);
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("whitelistMode");e.checked=true;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession, 'vcTest.get("whitelistMode")');
        return data.whitelistMode === true;
    });
    await waitFor(async () => await cdp.eval(settingsSession,
        'document.getElementById("listTitle").textContent === "Allowed Sites"'));
    check('Options whitelist mode enables', true);
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("whitelistMode");e.checked=false;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession, 'vcTest.get("whitelistMode")');
        return data.whitelistMode === false;
    });
    await waitFor(async () => await cdp.eval(settingsSession,
        'document.getElementById("listTitle").textContent === "Blocked Sites"'));
    check('Options whitelist mode disables and restores blocklist UI', true);

    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("newRememberedSite");e.value="browser-smoke.invalid";' +
        'document.getElementById("addRemembered").click();return true})()');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession, 'vcTest.get("siteSettings")');
        return Boolean(data?.siteSettings?.["browser-smoke.invalid"]);
    });
    check('Options remembered profile creates successfully', true);
    await waitFor(async () => await cdp.eval(settingsSession,
        'Boolean(document.querySelector("#memoryList .remove-btn"))'));
    await cdp.eval(settingsSession, 'document.querySelector("#memoryList .remove-btn").click();true');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession, 'vcTest.get("siteSettings")');
        return !data?.siteSettings?.["browser-smoke.invalid"];
    });
    check('Options remembered profile removes successfully', true);

    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("newDebugSite");e.value="browser-smoke.invalid";' +
        'document.getElementById("addDebugSite").click();return true})()');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession,'vcTest.get("siteDebugSettings")');
        return !!data?.siteDebugSettings?.["browser-smoke.invalid"];
    });
    check('Options per-site debug override can be created', true);
    await waitFor(async () => await cdp.eval(settingsSession,
        'Boolean(document.querySelector("#debugList .remove-btn"))'));
    await cdp.eval(settingsSession, 'document.querySelector("#debugList .remove-btn").click();true');
    await waitFor(async () => {
        const data = await cdp.eval(settingsSession,'vcTest.get("siteDebugSettings")');
        return !data?.siteDebugSettings?.["browser-smoke.invalid"];
    });
    check('Options per-site debug override can be removed', true);

    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("debugMode");e.checked=true;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await cdp.eval(settingsSession,'vcTest.get("debugMode")')).debugMode === true);
    check('Global debug mode saves', true);
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("debugMode");e.checked=false;' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("debugRouteMode");e.value="native";' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await cdp.eval(settingsSession,'vcTest.get("debugRouteMode")')).debugRouteMode === 'native');
    check('HTML-media native route override saves', true);
    await cdp.eval(settingsSession,
        '(()=>{const e=document.getElementById("debugRouteMode");e.value="auto";' +
        'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(async () => (await cdp.eval(settingsSession,'vcTest.get("debugRouteMode")')).debugRouteMode === 'auto');
    check('HTML-media auto routing restores', true);
    // Opening a popup must NEVER push an old Remember snapshot back into
    // the tab. Other controls (hotkeys, cross-frame changes) can have updated
    // live state since storage was last written.
    const savedForPopup = await cdp.eval(settingsSession,
        'new Promise((ok,fail)=>chrome.runtime.sendMessage({command:"mutateSiteSettings",' +
        'mutation:{type:"mergeForUrl",url:' + JSON.stringify(origin) +
        ',patch:{volume:5,mono:true,muted:true}}},' +
        'x=>chrome.runtime.lastError?fail(Error(chrome.runtime.lastError.message)):ok(x)))');
    check('Remember snapshot created for popup reopen test', savedForPopup?.ok === true, savedForPopup);
    await waitFor(async () => {
        const st = await state();
        return st?.volume === 5 && st?.mono === true && st?.muted === true;
    });
    await send({ command: 'setVolume', dB: -11 });
    await send({ command: 'setMono', mono: false });
    await send({ command: 'setMute', muted: false });
    await cdp.send('Target.activateTarget', { targetId: targets.tab.targetId });
    const freshState = await state();
    check('Live settings diverge safely from older Remember snapshot',
        freshState?.volume === -11 && freshState?.mono === false && freshState?.muted === false, freshState);
    const { targetId: reopenId } = await cdp.send('Target.createTarget', {
        url: 'chrome-extension://' + id + '/popup.html', background: true
    });
    const reopenSession = await cdp.attach(reopenId);
    await waitFor(async () => await cdp.eval(reopenSession,
        'typeof cached !== "undefined" && cached.activeTab?.id === ' + tabId +
        ' && document.getElementById("remember-checkbox")?.checked'));
    await sleep(450);
    const afterReopen = await state();
    check('Reopening popup preserves newer in-tab volume, mono and mute',
        afterReopen?.volume === -11 && afterReopen?.mono === false &&
        afterReopen?.muted === false, afterReopen);
    const persisted = await cdp.eval(settingsSession,'vcTest.get("siteSettings")');
    check('Reopening popup does not silently overwrite Remembered storage',
        Object.values(persisted.siteSettings || {}).some(x => x.volume === 5 && x.mono === true && x.muted === true),
        persisted);
    await cdp.send('Target.closeTarget', { targetId: reopenId });

    console.log('CHROMIUM FUNCTIONAL PASS (' + results.length + ' checks): ' + JSON.stringify(results));
} catch (e) {
    console.error('CHROMIUM FUNCTIONAL FAILURE: ' + (e?.stack || e));
    if (stderr) console.error('Chromium stderr: ' + stderr.slice(-3000));
    process.exitCode = 1;
} finally {
    try { cdp?.ws.close(); } catch (_) {}
    if (browser && browser.exitCode === null) {
        try { browser.kill(); } catch (_) {}
        await Promise.race([new Promise(ok => browser.once('exit',ok)), sleep(2000)]);
    }
    if (server) await new Promise(ok => { try { server.close(ok); } catch (_) { ok(); } });
    rmSync(temp, { recursive: true, force: true });
}