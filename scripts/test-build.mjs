import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { runInNewContext, Script } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const fixtureRoot = mkdtempSync(join(dist, 'build-test-'));

after(() => {
    assert.equal(dirname(realpathSync(fixtureRoot)), realpathSync(dist));
    rmSync(fixtureRoot, { recursive: true, force: true });
});

mkdirSync(join(fixtureRoot, 'scripts'));
copyFileSync(join(root, 'scripts/build.ps1'), join(fixtureRoot, 'scripts/build.ps1'));
copyFileSync(join(root, 'scripts/minify.mjs'), join(fixtureRoot, 'scripts/minify.mjs'));
const assets = readdirSync(root).filter(name => /\.(js|html|css)$/.test(name) || name === 'LICENSE');
for (const name of [...assets, 'manifest.json', 'ico.svg', 'chrome.png']) {
    copyFileSync(join(root, name), join(fixtureRoot, name));
}
copyFileSync(new URL('./fixtures/build-regression.js', import.meta.url), join(fixtureRoot, 'build-regression.js'));

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
function runBuild(...args) {
    return spawnSync(powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(fixtureRoot, 'scripts/build.ps1'), ...args,
    ], { encoding: 'utf8' });
}
const build = runBuild();
assert.ifError(build.error);
assert.equal(build.status, 0, build.stdout + build.stderr);
const baseManifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));

function listZipEntries(zipPath) {
    const escaped = zipPath.replace(/'/g, "''");
    const command = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$archive = [System.IO.Compression.ZipFile]::OpenRead('${escaped}')`,
        'try { $archive.Entries | ForEach-Object { $_.FullName } } finally { $archive.Dispose() }'
    ].join('; ');
    const result = spawnSync(powershell, ['-NoProfile', '-Command', command], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).sort();
}

for (const browser of ['chrome', 'firefox']) {
    const packageDir = join(fixtureRoot, 'dist', browser);
    const packageManifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'));

    test(`${browser}: manifest contains only browser-valid background metadata`, () => {
        if (browser === 'chrome') {
            assert.equal(packageManifest.minimum_chrome_version, baseManifest.minimum_chrome_version);
            assert.equal(packageManifest.background.service_worker, 'background.js');
            assert.equal('scripts' in packageManifest.background, false);
            assert.equal('browser_specific_settings' in packageManifest, false);
            assert.deepEqual(packageManifest.icons, { '128': 'chrome.png' });
        } else {
            assert.equal('minimum_chrome_version' in packageManifest, false);
            assert.equal('service_worker' in packageManifest.background, false);
            assert.deepEqual(packageManifest.background.scripts, ['shared.js', 'background.js']);
            assert.ok(packageManifest.browser_specific_settings?.gecko);
            assert.deepEqual(packageManifest.icons, { '96': 'ico.svg' });
        }
    });

    test(`${browser}: ZIP contains exactly the packaged extension files`, () => {
        const icon = browser === 'chrome' ? 'chrome.png' : 'ico.svg';
        const zipPath = join(
            fixtureRoot,
            'dist',
            `volume-control-${browser}-v${baseManifest.version}.zip`
        );
        const expected = [...assets, 'build-regression.js', 'manifest.json', icon].sort();
        assert.deepEqual(listZipEntries(zipPath), expected);
    });

    test(`${browser}: packaging preserves JavaScript behavior`, () => {
        const context = {};
        runInNewContext(readFileSync(join(packageDir, 'build-regression.js'), 'utf8'), context);
        assert.equal(context.buildRegression.domain, 'example.com/path');
        assert.equal(context.buildRegression.regexClass, true);
        assert.equal(context.buildRegression.tokenType, 'number');
        assert.equal(context.buildRegression.template, 'outer inner https://example.com');
        assert.equal(context.buildRegression.multiline, 'first\n\nlast');
        assert.equal(context.buildRegression.unicode, '× − → café 🎵');
    });

    test(`${browser}: JavaScript is minified without changing source files`, () => {
        for (const name of [...assets.filter(name => name.endsWith('.js')), 'build-regression.js']) {
            const source = readFileSync(join(fixtureRoot, name));
            const packaged = readFileSync(join(packageDir, name));
            assert.ok(packaged.length < source.length, `${name} should be smaller after minification`);
            const original = name === 'build-regression.js'
                ? readFileSync(new URL('./fixtures/build-regression.js', import.meta.url))
                : readFileSync(join(root, name));
            assert.ok(source.equals(original), `Build modified source: ${name}`);
        }
    });

    test(`${browser}: HTML and CSS are minified without changing source files`, () => {
        for (const name of assets.filter(name => name.endsWith('.html') || name.endsWith('.css'))) {
            const source = readFileSync(join(fixtureRoot, name));
            const packaged = readFileSync(join(packageDir, name));
            assert.ok(packaged.length < source.length, `${name} should be smaller after minification`);
            assert.ok(source.equals(readFileSync(join(root, name))), `Build modified source: ${name}`);
        }

        const popupHtml = readFileSync(join(packageDir, 'popup.html'), 'utf8');
        const optionsHtml = readFileSync(join(packageDir, 'options.html'), 'utf8');
        assert.match(popupHtml, /id="volume-slider"/);
        assert.match(popupHtml, /id="normalizer-checkbox"/);
        assert.match(popupHtml, /id="peak-meter-fill"/);
        assert.match(popupHtml, /src="shared\.js"/);
        assert.match(optionsHtml, /id="debugRouteMode"/);
        assert.match(optionsHtml, /id="normalizerTargetDb"/);
        assert.match(optionsHtml, /id="normalizerCeilingDb"/);
        assert.match(optionsHtml, /src="options\.js"/);

        const popupCss = readFileSync(join(packageDir, 'popup.css'), 'utf8');
        const optionsCss = readFileSync(join(packageDir, 'options.css'), 'utf8');
        assert.match(popupCss, /--vc-range-steps/);
        assert.match(optionsCss, /\.site-debug-group/);
        // Firefox Android's responsive layouts survive packaged minification.
        assert.match(popupCss, /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)/);
        assert.doesNotMatch(popupCss, /@media\s*\(max-width:\s*480px\)\s*,/);
        assert.match(popupCss, /touch-action:\s*pan-y/);
        assert.match(optionsCss, /max-width:\s*600px/);
        assert.match(optionsCss, /min-width:\s*0/);
    });

    test(`${browser}: non-code assets preserve source bytes and encoding`, () => {
        for (const name of assets.filter(name => !/\.(js|html|css)$/.test(name))) {
            assert.ok(readFileSync(join(packageDir, name)).equals(readFileSync(join(root, name))), name);
        }
    });

    test(`${browser}: extension scripts parse and shared URL helpers work`, () => {
        for (const name of assets.filter(name => name.endsWith('.js'))) {
            new Script(readFileSync(join(packageDir, name), 'utf8'), { filename: name });
        }
        const context = { URL };
        runInNewContext(readFileSync(join(packageDir, 'shared.js'), 'utf8'), context);
        const shared = context.VolumeControlShared;
        assert.equal(shared.normalizeDomainInput('https://www.example.com/path'), 'example.com');
        assert.equal(shared.normalizeDomainInput('http://[::1]:8080/path'), '[::1]');
        assert.equal(shared.normalizeDomainInput('https://bücher.example/path'), 'xn--bcher-kva.example');
        assert.equal(shared.normalizeBlocklistEntryInput('http://[::1]:8080/media'), '[::1]/media');
        assert.equal(shared.normalizeBlocklistEntryInput('https://www.example.com/videos/*'), 'example.com/videos/*');
        assert.equal(shared.normalizeBlocklistEntryInput('https://EXAMPLE.com/Case/Path/?x=1#top'), 'example.com/Case/Path');
        assert.equal(shared.isUrlBlockedByEntry('https://example.com/videos/one', 'example.com/videos/*'), true);
        assert.equal(shared.isUrlBlockedByEntry('https://example.com/videos/one', 'example.com/videos'), true);
        assert.equal(shared.isUrlBlockedByEntry('https://example.com/Videos/one', 'example.com/videos'), false);
        assert.equal(shared.isUrlBlockedByEntry('https://example.com/', 'example.com/videos/*'), false);

        assert.equal(
            shared.normalizeSiteSettingsEntryInput('https://www.Example.com/Videos/?view=grid#top'),
            'example.com/Videos'
        );
        assert.equal(
            shared.normalizeSiteSettingsEntryInput('https://www.Example.com/Videos/?view=grid#top', { includeQuery: true }),
            'example.com/Videos?view=grid'
        );
        assert.equal(shared.extractRootDomain('file:///C:/Music/song.mp3'), 'file');

        const remembered = {
            'example.com': { volume: -2 },
            'sub.example.com': { volume: -1 },
            'example.com/videos': { volume: 3 },
            'example.com/videos/special': { volume: 6 },
            'example.com/*/season/*': { volume: 9 },
        };
        assert.equal(
            shared.getSiteSettingsKey(remembered, 'https://example.com/videos/special/episode-1'),
            'example.com/videos/special'
        );
        assert.equal(
            shared.getSiteSettingsKey(remembered, 'https://sub.example.com/videos/other'),
            'example.com/videos'
        );
        assert.equal(
            shared.getSiteSettingsKey(remembered, 'https://sub.example.com/unmatched'),
            'sub.example.com'
        );
        assert.equal(
            shared.getSiteSettingsKey(remembered, 'https://example.com/show/season/1'),
            'example.com/*/season/*'
        );
        assert.equal(
            shared.getSiteSettingsKey(remembered, 'https://example.com/unmatched'),
            'example.com'
        );
        assert.equal(
            shared.getSiteSettingsKey({ 'Local File': { volume: 1 } }, 'file:///C:/Music/song.mp3'),
            'Local File'
        );
        const queryScoped = {
            'example.com/watch': { volume: 1 },
            'example.com/watch?v=abc': { volume: 2 },
            'example.com/watch?v=*': { volume: 3 }
        };
        assert.equal(
            shared.getSiteSettingsKey(queryScoped, 'https://example.com/watch?v=abc'),
            'example.com/watch?v=abc'
        );
        assert.equal(
            shared.getSiteSettingsKey(queryScoped, 'https://example.com/watch?v=xyz'),
            'example.com/watch?v=*'
        );
    });
}

test('background serializes hotkeys and remembered-setting mutations', () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    assert.match(source, /const commandChains = new Map\(\)/);
    assert.match(source, /let siteSettingsMutationChain = Promise\.resolve\(\)/);
    assert.match(source, /type === "mergeForUrl"/);
    assert.match(source, /type === "ensureForUrl"/);
    assert.match(source, /if \(!domainState \|\| domainState\.blocked\) return/);
    assert.match(source, /enqueueCommand\(command, tab\)/);
    assert.match(source, /message\.command === "getTopTabUrl"/);
});

test('content scripts resolve iframe profiles from the top tab URL and refresh on SPA navigation', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /async function resolveControlUrl\(\)/);
    assert.match(source, /runtimeSendMessage\(\{ command: "getTopTabUrl" \}\)/);
    assert.match(source, /msg\.command === "profileUrlChanged"/);
    assert.match(source, /let startGeneration = 0/);
    assert.match(source, /generation !== startGeneration/);
    assert.match(source, /command: "topUrlChanged"/);
    assert.match(source, /const PAGE_BRIDGE_TOKEN/);
    assert.match(source, /data\.token !== PAGE_BRIDGE_TOKEN/);
    assert.match(source, /let pageHookActivated = false/);
    assert.match(source, /pageHookActivated = true/);
    assert.doesNotMatch(source, /if \(!currentState\.enabled && !pageHookActivated\) return/);
    assert.match(source, /stopBoostLimitObserver\(\)/);
    assert.match(source, /command: "frameBoostLimitReport"/);
    assert.match(source, /if \(!reason && lastPostedFrameReport\.reason === null && !force\) return/);
    assert.match(source, /reportFrameBoostLimit\(true\)/);
    assert.match(source, /getSiteSettingsKey\(data\.siteSettings \|\| \{\}, controlUrl\)/);
    assert.match(source, /isUrlBlockedByEntries\(controlUrl, data\.fqdns \|\| \[\]\)/);
});


test('normalizer input detection is upstream of the manual slider in all audio paths', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(page, /connectNative\(inputAnalyser, gain\)/);
    assert.match(page, /connectNative\(source, inputAnalyser\)/);
    assert.match(page, /connectNative\(source, graph\.inputAnalyser/);
    assert.match(page, /connectNative\(this, graph\.inputAnalyser/);
    assert.match(page, /connectNative\(masterGain, graph\.inputAnalyser\)/);
    assert.match(page, /sourceAnalyser\.getFloatTimeDomainData\(processor\.inputBuffer\)/);
    assert.doesNotMatch(page, /gainDb \+ \(config\.targetDb - rmsDb\)/);
    assert.match(content, /tc\.vars\.inputAnalyserNode\.connect\(tc\.vars\.gainNode\)/);
    assert.match(content, /source\.connect\(tc\.vars\.inputAnalyserNode\)/);
    assert.match(content, /sourceAnalyser\.getFloatTimeDomainData\(tc\.vars\.inputAnalyserBuffer\)/);
    assert.doesNotMatch(content, /gainDb \+ \(config\.targetDb - rmsDb\)/);
});

test('moving volume slider cannot cause the MAIN-world normalizer to compensate', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function computeSafeNormalizerGainDb(previousDb, sourceRmsDb, sourcePeakDb, config) {');
    const end = source.indexOf('    function updateNormalizerAndMeter() {', start);
    assert.ok(start >= 0 && end > start);
    let outputAmplitude = 0.1;
    let manualGain = 1;
    const input = { fftSize: 1024, getFloatTimeDomainData: (data) => data.fill(0.1) };
    const output = { fftSize: 1024, getFloatTimeDomainData: (data) => data.fill(outputAmplitude) };
    const controls = { lastGain: null, cancelScheduledValues() {}, setTargetAtTime(gain) { this.lastGain = gain; } };
    const processor = {
        inputAnalyser: input, analyser: output,
        context: { state: 'running', currentTime: 1 },
        gain: { gain: controls }, normalizerGainDb: 0
    };
    const state = { normalizerEnabled: true, extensionActive: true, enabled: true, muted: false };
    const config = { targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 100 };
    const sample = runInNewContext('(function () {\n' + source.slice(start, end) + '\nreturn sampleProcessor;\n})()', {
        state, normalizeNormalizerConfig: () => config, configureLimiter: () => {},
        effectiveGain: () => manualGain, dbToGain: dB => 10 ** (dB / 20)
    });
    for (let n = 0; n < 40; n++) sample(processor);
    const settledGain = processor.normalizerGainDb;
    const settledOutput = controls.lastGain;

    // Move the volume slider -20 dB. The post-fader output drops 20 dB,
    // but the normalizer's SOURCE detector sees exactly the same source.
    manualGain = 0.1;
    outputAmplitude = 0.01;
    for (let n = 0; n < 40; n++) sample(processor);
    assert.ok(Math.abs(processor.normalizerGainDb - settledGain) < 0.02,
        'AGC gain must not move in response to manual slider changes');
    assert.ok(Math.abs(controls.lastGain / settledOutput - 0.1) < 0.005,
        'manual slider attenuation must remain a -20 dB adjustment');
});

test('moving volume slider cannot cause the isolated-world normalizer to compensate', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('function computeSafeNormalizerGainDb(previousDb, sourceRmsDb, sourcePeakDb, config) {');
    const end = source.indexOf('function ensureIsolatedNormalizerTimer() {', start);
    assert.ok(start >= 0 && end > start);
    let outputAmplitude = 0.1;
    const output = { fftSize: 1024, getFloatTimeDomainData: (data) => data.fill(outputAmplitude) };
    const input = { fftSize: 1024, getFloatTimeDomainData: (data) => data.fill(0.1) };
    const controls = { lastGain: null, cancelScheduledValues() {}, setTargetAtTime(gain) { this.lastGain = gain; } };
    const tc = {
        vars: {
            normalizerEnabled: true, normalizerGainDb: 0, muted: false, isBlocked: false, dB: 0,
            audioCtx: { state: 'running', currentTime: 1 }, analyserNode: output,
            inputAnalyserNode: input, gainNode: { gain: controls }
        },
        settings: { normalizerConfig: {} }
    };
    const sample = runInNewContext('(function () {\n' + source.slice(start, end) + '\nreturn sampleIsolatedNormalizer;\n})()', {
        tc, normalizeNormalizerConfig: () => ({ targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 100 }),
        configureIsolatedLimiter: () => {}, getGainValue: db => 10 ** (db / 20)
    });
    for (let n = 0; n < 40; n++) sample();
    const settledGain = tc.vars.normalizerGainDb;
    const settledOutput = controls.lastGain;
    tc.vars.dB = -20;
    outputAmplitude = 0.01;
    for (let n = 0; n < 40; n++) sample();
    assert.ok(Math.abs(tc.vars.normalizerGainDb - settledGain) < 0.02);
    assert.ok(Math.abs(controls.lastGain / settledOutput - 0.1) < 0.005);
});


test('automatic normalization gains are bounded by source peaks and silence gate in both worlds', () => {
    for (const file of ['page-audio-hook.js', 'cs.js']) {
        const src = readFileSync(join(root, file), 'utf8');
        const start = src.indexOf('function computeSafeNormalizerGainDb(previousDb, sourceRmsDb, sourcePeakDb, config) {');
        const end = src.indexOf(file === 'cs.js' ? 'function sampleIsolatedNormalizer() {' : 'function sampleProcessor(processor) {', start);
        assert.ok(start >= 0 && end > start, file + ': missing gain guard');
        const update = runInNewContext('(' + src.slice(start, end).trim() + ')');
        const cfg = { targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 600 };

        assert.equal(update(12, -65, -50, cfg), 0, 'no boost of quiet background/noise');
        assert.equal(update(10, -55, -40, cfg), 0, 'gate boundary resets stale boost');
        assert.equal(update(10, NaN, -30, cfg), 0, 'bad RMS fails to unity');
        assert.equal(update(10, -30, NaN, cfg), 0, 'missing peak fails to unity');
        assert.equal(update(12, -25, -0.1, cfg), -2.9, 'sudden full-scale peak sheds previous boost immediately');
        assert.ok(update(0, -32, -23, cfg) > 0, 'quiet valid content can gain boost');
        assert.ok(update(0, -32, -23, cfg) < 12, 'gain increases gradually');

        let gain = 0;
        for (let n = 0; n < 50; n++) gain = update(gain, -24, -4, cfg);
        assert.ok(gain <= 1.001, 'source peak headroom must cap RMS-requested boost');
        assert.ok(gain >= 0.95);

        const highCfg = { ...cfg, maxBoostDb: 24 };
        let highGain = 0;
        for (let n = 0; n < 100; n++) highGain = update(highGain, -50, -45, highCfg);
        assert.ok(highGain <= 24, 'even user-selected high boost remains bounded');
        assert.match(src, /inputAnalyser(?:Node)?\.fftSize = 8192/);
        assert.match(src, /0\.008 : 0\.035/);
    }
});


test('MAIN-world graph failures restore clamped direct output, then retry limiting', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function clampUnprotectedOutput(processor) {');
    const end = source.indexOf('    function ensureGraph(context) {', start);
    assert.ok(start >= 0 && end > start);
    let failLimiter = true;
    const names = ['gain', 'splitter', 'leftGain', 'rightGain', 'merger', 'limiter', 'analyser'];
    const graph = {};
    for (const name of names) graph[name] = { name, edges: [] };
    const destination = { name: 'destination' };
    const gainParam = {
        value: 10, history: [], cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; this.history.push(['set', value]); },
        linearRampToValueAtTime(value) { this.value = value; this.history.push(['ramp', value]); }
    };
    graph.gain.gain = gainParam;
    graph.context = { state: 'running', currentTime: 2, destination };
    graph.currentMode = null;
    graph.normalizerGainDb = 12;
    graph.limiterFallbackActive = false;
    let safeOnDirectConnection = false;
    const connectNative = (from, to) => {
        if (from === graph.limiter && to === graph.analyser && failLimiter) {
            throw new Error('limiter output rejected');
        }
        if (from === graph.gain && to === destination) {
            safeOnDirectConnection = gainParam.value <= 1;
        }
        from.edges.push(to);
    };
    const state = { extensionActive: true, enabled: true, muted: false, mono: false,
        dB: 20, normalizerEnabled: true };
    const fns = runInNewContext('(() => {\n' + source.slice(start, end) + '\nreturn { wireGraph };})()', {
        state, effectiveGain: () => 10, dbToGain: db => 10 ** (db / 20),
        safeDisconnect: node => { node.edges = []; }, connectNative,
        configureLimiter: () => {}, log: () => {}
    });
    fns.wireGraph(graph);
    assert.equal(safeOnDirectConnection, true, 'direct fallback must clamp before it becomes audible');
    assert.equal(graph.limiterFallbackActive, true);
    assert.equal(graph.currentMode, null, 'a transient graph error stays retryable');
    assert.equal(graph.normalizerGainDb, 0, 'discard stale boost on route failure');
    assert.equal(graph.gain.edges[0], destination);
    assert.equal(gainParam.value, 1);

    failLimiter = false;
    fns.wireGraph(graph);
    assert.equal(graph.limiterFallbackActive, false);
    assert.equal(graph.gain.edges.length, 1);
    assert.equal(graph.gain.edges[0], graph.limiter);
    assert.equal(graph.limiter.edges[0], graph.analyser);
    assert.equal(graph.analyser.edges[0], destination);
    assert.ok(gainParam.value > 1, 'positive gain resumes only after protection is restored');

    // A failed AudioParam clamp must NOT expose the boosted direct route.
    graph.currentMode = null;
    gainParam.value = 9;
    gainParam.cancelScheduledValues = () => { throw new Error('AudioParam closed'); };
    failLimiter = true;
    fns.wireGraph(graph);
    assert.equal(graph.limiterFallbackActive, true);
    assert.equal(graph.gain.edges.length, 0, 'failed safety clamp must stay disconnected');
});

test('MAIN-world media element route failures cannot bypass limiter with boosted gain', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function setMediaGainValue(route) {');
    const end = source.indexOf('    function ensureMediaRoute(element) {', start);
    assert.ok(start >= 0 && end > start);
    const route = {};
    for (const name of ['gain', 'splitter', 'leftGain', 'rightGain', 'merger', 'limiter', 'analyser']) {
        route[name] = { name, edges: [] };
    }
    const destination = {};
    route.context = { state: 'running', currentTime: 2, destination };
    route.currentMode = null;
    route.limiterFallbackActive = false;
    route.outputConnected = false;
    route.normalizerGainDb = 8;
    const gain = { value: 12, cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; },
        linearRampToValueAtTime(v) { this.value = v; }
    };
    route.gain.gain = gain;
    let fail = true;
    let lastSafeDirect = null;
    const connectNative = (from, to) => {
        if (from === route.limiter && to === route.analyser && fail) throw new Error('failure');
        if (from === route.gain && to === destination) lastSafeDirect = gain.value <= 1;
        from.edges.push(to);
    };
    const wire = runInNewContext('(() => {\n' + source.slice(start, end) + '\nreturn wireMediaRoute;})()', {
        state: { extensionActive: true, enabled: true, mono: false, normalizerEnabled: true, muted: false, dB: 20 },
        effectiveGain: () => 10, dbToGain: d => 10 ** (d / 20), connectNative,
        configureLimiter: () => {}, log: () => {}, safetyLimiterRequired: () => true,
        currentRoutingMode: () => 'stereo-limited',
        disconnectMediaRouteOutput: r => {
            for (const name of ['gain', 'splitter', 'leftGain', 'rightGain', 'merger', 'limiter', 'analyser']) r[name].edges = [];
            r.outputConnected = false;
        },
        clampUnprotectedOutput: r => {
            r.limiterFallbackActive = true; r.normalizerGainDb = 0; r.meterPeakDb = -Infinity;
            r.gain.gain.setValueAtTime(1);
            return true;
        }
    });
    wire(route);
    assert.equal(lastSafeDirect, true);
    assert.equal(route.limiterFallbackActive, true);
    assert.equal(route.currentMode, null);
    assert.equal(route.gain.edges[0], destination);
    assert.equal(gain.value, 1);
    fail = false;
    wire(route);
    assert.equal(route.limiterFallbackActive, false);
    assert.equal(route.currentMode, 'stereo-limited');
    assert.equal(route.gain.edges.length, 1);
    assert.equal(route.gain.edges[0], route.limiter);
    assert.equal(route.limiter.edges[0], route.analyser);
    assert.equal(route.analyser.edges[0], destination);
    assert.ok(gain.value > 1);
    assert.match(source, /!processor\.limiterFallbackActive/);
    assert.match(source, /processor\.limiterFallbackActive\s*\?\s*Math\.min\(1, effectiveGain\(\)\)/);
});

test('normalizer bridge, limiter, persistence, and meter stay wired', () => {
    const sharedSource = readFileSync(join(root, 'shared.js'), 'utf8');
    const contentSource = readFileSync(join(root, 'cs.js'), 'utf8');
    const hookSource = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const popupSource = readFileSync(join(root, 'popup.js'), 'utf8');
    const backgroundSource = readFileSync(join(root, 'background.js'), 'utf8');

    assert.match(sharedSource, /const BRIDGE_VERSION = 3/);
    assert.match(sharedSource, /DEFAULT_NORMALIZER_CONFIG/);
    assert.match(contentSource, /case "setNormalizer"/);
    assert.match(contentSource, /command === "meterUpdate"/);
    assert.match(contentSource, /createDynamicsCompressor\(\)/);
    assert.match(hookSource, /const BRIDGE_VERSION = 3/);
    assert.match(hookSource, /function updateNormalizerAndMeter\(\)/);
    assert.match(hookSource, /createDynamicsCompressor\(\)/);
    assert.match(hookSource, /createAnalyser\(\)/);
    assert.match(popupSource, /command: "getMeterState"/);
    assert.match(popupSource, /mutateSiteNormalizerSettings/);
    assert.match(backgroundSource, /siteNormalizerSettings/);
});

test('page hook captures MediaStream/srcObject call audio and watches SPA history', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /function patchMediaSrcObject\(\)/);
    assert.match(source, /createMediaStreamSource\(stream\)/);
    assert.match(source, /streamBacked/);
    assert.match(source, /immediateFallback: true/);
    assert.match(source, /function patchSpaNavigation\(\)/);
    assert.match(source, /"pushState", "replaceState"/);
    assert.match(source, /postToContentScript\("locationChanged"/);
    assert.match(source, /extensionActive: false/);
    assert.match(source, /function ensurePageHooksInstalled\(\)/);
    assert.match(source, /data\.token !== bridgeToken/);
    assert.match(source, /recorded destination rollback failed/);
    assert.match(source, /unroute rollback failed/);
    assert.match(source, /n < 0 \|\| n > 1/);
});

test('build refuses to delete or use the repository root as output', () => {
    const manifestPath = join(fixtureRoot, 'manifest.json');
    const before = readFileSync(manifestPath);
    const result = runBuild('-OutputDir', '.');
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /repository root as build output/i);
    assert.ok(existsSync(manifestPath));
    assert.ok(readFileSync(manifestPath).equals(before));
});

test('build rejects sibling paths that only share the repository name prefix', () => {
    const siblingName = basename(fixtureRoot) + '-sibling-output';
    const siblingPath = join(dirname(fixtureRoot), siblingName);
    rmSync(siblingPath, { recursive: true, force: true });
    const result = runBuild('-OutputDir', join('..', siblingName));
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /outside repo/i);
    assert.equal(existsSync(siblingPath), false);
});

test('invalid JavaScript fails the build before producing a ZIP', () => {
    const invalidFile = join(fixtureRoot, 'broken.js');
    writeFileSync(invalidFile, 'const broken = ;', 'utf8');
    try {
        const result = runBuild('-OutputDir', 'invalid-output');
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /Could not minify broken\.js/);
        assert.equal(readdirSync(join(fixtureRoot, 'invalid-output')).some(name => name.endsWith('.zip')), false);
    } finally {
        rmSync(invalidFile);
    }
});

test('a missing build helper fails before replacing the existing release', () => {
    const existingFile = join(fixtureRoot, 'dist/chrome/shared.js');
    const existingBytes = readFileSync(existingFile);
    rmSync(join(fixtureRoot, 'scripts/minify.mjs'));
    const result = runBuild();
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Required build helper is missing/);
    assert.ok(existsSync(existingFile));
    assert.ok(readFileSync(existingFile).equals(existingBytes));
});


test('popup only accepts a signed integer dB value and uses atomic URL settings mutations', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    assert.match(source, /function parseDbText\(value\)/);
    assert.match(source, /type: "mergeForUrl"/);
    assert.match(source, /type: "removeForUrl"/);
    assert.match(source, /type: "setSiteActive"/);
});

test('remembered-setting saves do not rebroadcast every audio control', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = source.indexOf('async function saveSiteSettingsNow');
    const end = source.indexOf('\nfunction saveSiteSettings', start);
    const saveBody = source.slice(start, end);
    assert.doesNotMatch(saveBody, /tabsSendMessage/);
    assert.match(source, /await tabsSendMessage\(tab\.id, \{ command: "setMono"/);
});

test('options queues a rerender requested during an active render', () => {
    const source = readFileSync(join(root, 'options.js'), 'utf8');
    assert.match(source, /memoryListRenderPending = true/);
    assert.match(source, /fqdnListRenderPending = true/);
    assert.match(source, /queueMicrotask\(\(\) => renderMemoryList\(\)\)/);
    assert.match(source, /command: "mutateSiteSettings"/);
});

test('daily prerelease compares against stable releases and ignores test-only script changes', () => {
    const source = readFileSync(join(root, '.github/workflows/daily-prerelease.yml'), 'utf8');
    assert.match(source, /git tag --list "V\*"/);
    assert.match(source, /'LICENSE'/);
    assert.match(source, /'scripts\/build\.ps1'/);
    assert.match(source, /'scripts\/minify\.mjs'/);
    assert.doesNotMatch(source, /\$_ -like 'scripts\/\*'/);
});


test('CI crosses the ZIP boundary and runs real installed-extension smoke coverage', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const hookSmoke = readFileSync(join(root, 'scripts/browser-smoke.mjs'), 'utf8');
    const chromiumInstall = readFileSync(join(root, 'scripts/chromium-extension-smoke.mjs'), 'utf8');
    const firefoxInstall = readFileSync(join(root, 'scripts/firefox-extension-smoke.mjs'), 'utf8');
    assert.match(workflow, /Expand-Archive/);
    assert.match(workflow, /VC_EXTENSION_DIR: dist\/smoke\/chrome/);
    assert.match(workflow, /VC_EXTENSION_DIR: dist\/smoke\/firefox/);
    assert.match(workflow, /node scripts\/chromium-extension-smoke\.mjs/);
    assert.match(workflow, /node scripts\/firefox-extension-smoke\.mjs/);
    assert.ok(workflow.indexOf('Build Firefox and Chrome packages') < workflow.indexOf('Extract release ZIPs'));
    assert.doesNotMatch(workflow, /upload-build|@actions\/artifact/);
    assert.match(hookSmoke, /VC_BROWSER_SMOKE_PASS/);
    assert.match(chromiumInstall, /--load-extension/);
    assert.match(chromiumInstall, /vc-init/);
    assert.match(firefoxInstall, /web-ext@\$\{WEB_EXT_VERSION\}/);
    assert.match(firefoxInstall, /--source-dir/);
});


test('MAIN hook preflights early WebAudio but restores page APIs on exclusion', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /patchAudioNodeRouting\(\);\s*\n\s*try \{/);
    assert.match(source, /function restorePatchedPageApis\(\)/);
    assert.match(source, /if \(!state\.enabled\) restorePatchedPageApis\(\)/);
    assert.match(source, /bridgeToken = null/);
    assert.match(source, /data\.command !== "setState" && data\.command !== "heartbeat"/);
});

test('fallback routing preserves native site volume and invalidates new restriction reasons', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /element\.__vc_originalVolume = currentVolume/);
    assert.doesNotMatch(source, /gain > 1 \? 1 : currentVolume/);
    assert.match(source, /previousFallbackReason/);
    assert.match(source, /invalidateBoostLimitCache\(\)/);
});

test('live exclusion restores isolated fallback state before teardown', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /if \(blocked\) \{[\s\S]*lastSyncedPageAudioState = null;[\s\S]*applyState\(\);[\s\S]*stopPageBridgeTimers\(\)/);
    assert.match(source, /const gain = isEnabled \? \(tc\.vars\.muted \? 0 : getGainValue\(tc\.vars\.dB\)\) : 1/);
    assert.match(source, /isEnabled && tc\.vars\.muted/);
});

test('content-script initialization failure releases preflight to native audio', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /start\(\) storage read failed/);
    assert.match(source, /tc\.vars\.isBlocked = true;[\s\S]*lastSyncedPageAudioState = null;[\s\S]*applyState\(\)/);
});

test('isolated media tracking periodically prunes detached idle elements', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /const KNOWN_MEDIA_SWEEP_MS = 30000/);
    assert.match(source, /function sweepKnownMediaElements\(\)/);
    assert.match(source, /knownMediaSweepInterval = setInterval\(sweepKnownMediaElements/);
    assert.match(source, /clearInterval\(knownMediaSweepInterval\)/);
});

test('detached MediaStream media releases external stream listeners', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /function cleanupTrackedMediaElement\(element\)/);
    assert.match(source, /entry\.streamCleanup\(\)/);
    assert.match(source, /cleanupTrackedMediaElement\(element\)/);
});

test('isolated fallback never reuses a GainNode from a closed AudioContext', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /tc\.vars\.gainNode = undefined/);
    assert.match(source, /Previously hooked media lost its AudioContext/);
    assert.match(source, /applyState\(\);\s*\n\s*stopPageBridgeTimers\(\)/);
});


test('whitelist authorization is independent from remembered site settings', () => {
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const options = readFileSync(join(root, 'options.js'), 'utf8');
    assert.match(background, /let accessListMutationChain = Promise\.resolve\(\)/);
    assert.match(background, /type === "setWhitelistMode"/);
    assert.match(background, /type === "setSiteActive"/);
    assert.match(content, /\(data\.whitelist \|\| \[\]\)\.some/);
    assert.doesNotMatch(content, /Whitelist is derived from remembered sites/);
    assert.match(options, /type: "addWhitelist"/);
});

test('unsaved tab controls survive SPA and playlist URL changes without storage persistence', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('        if (siteSettingsKey) {');
    const end = source.indexOf('        ensurePageBridgeResync();', start);
    assert.ok(start >= 0 && end > start);
    const profileLogic = source.slice(start, end);
    assert.match(profileLogic, /data\.siteSettings\[siteSettingsKey\]/);
    assert.doesNotMatch(profileLogic, /tc\.vars\.dB = 0/);
    assert.doesNotMatch(source, /lastResolvedControlUrl/);
    assert.match(source, /With Remember off, preserve unsaved volume/);
});

test('opening Remembered popup never replays potentially stale storage into a live tab', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = source.indexOf('        const audioState = await refreshAudioControlState(tab);');
    const end = source.indexOf('    } catch (e) {', start);
    assert.ok(start >= 0 && end > start);
    const initialization = source.slice(start, end);
    assert.match(initialization, /if \(saved\) \{/);
    assert.match(initialization, /if \(!audioState\) \{/);
    assert.doesNotMatch(initialization, /await setVolume\(saved\.volume/);
    assert.doesNotMatch(initialization, /command: "setMono"/);
    assert.doesNotMatch(initialization, /command: "setMute"/);
});

test('popup ignores stale async volume responses', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    assert.match(source, /let volumeRequestGeneration = 0/);
    assert.match(source, /requestGeneration !== volumeRequestGeneration/);
    assert.match(source, /command: "mutateAccessLists"/);
});


test('whitelist changes propagate without remembered settings', () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(popup, /isUrlRememberedByEntry/);
    assert.match(popup, /Allowed Sites/);
    assert.match(content, /changes\.whitelist \|\|/);
});


test('all-frame manifest keeps the earliest supported fallback injection flags', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.content_scripts.length >= 2, true);
    for (const script of manifest.content_scripts) {
        assert.equal(script.run_at, 'document_start');
        assert.equal(script.all_frames, true);
        assert.equal(script.match_about_blank, true);
        assert.equal(script.match_origin_as_fallback, true);
    }
    assert.equal(manifest.content_scripts[0].world, 'MAIN');
});


test('existing whitelist-mode users migrate remembered allow entries once', () => {
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(background, /async function migrateSeparatedWhitelistOnce\(\)/);
    assert.match(background, /whitelistSeparatedV1: true/);
    assert.match(background, /Object\.keys\(data\.siteSettings \|\| \{\}\)/);
    assert.match(content, /legacyAllowed = !data\.whitelistSeparatedV1/);
});


test('all blocklist/whitelist migrations share the serialized access-list queue', () => {
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(background, /accessListMutationChain = accessListMutationChain\.then\(run, run\)/);
    assert.match(background, /async function purgeLegacyDefaultsOnce\(\)/);
    assert.match(background, /async function migrateSeparatedWhitelistOnce\(\)/);
    assert.doesNotMatch(content, /await storageSet\(Object\.assign\([\s\S]*legacyTwitchDefaultsPurged/);
});


test('exclusion teardown removes reversible per-element listeners without muting captured routes', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /listenerCleanup: null/);
    assert.match(source, /function detachMediaElementListeners\(element\)/);
    assert.match(source, /entry\.listenerCleanup = \(\) =>/);
    assert.match(source, /if \(!mediaRoutes\.has\(element\)\)/);
});


test('whitelist migration is seamless in popup and hotkeys before the one-time write completes', () => {
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    assert.match(background, /!data\.whitelistSeparatedV1 && Boolean\(settingsKey\)/);
    assert.match(popup, /legacyAllowed = !data\.whitelistSeparatedV1/);
});


test('AudioNode disconnect overloads keep route tracking in sync', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /typeof destination === "number"/);
    assert.match(source, /takeDestinationConnections\(this, entry => entry\.outputIndex === outputIndex\)/);
    assert.match(source, /if \(arguments\.length >= 3 && entry\.inputIndex !== inputIndex\) return false/);
});

test('AudioContext suspend and resume operations are serialized', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(page, /const pendingContextSuspends = new WeakMap\(\)/);
    assert.match(page, /pendingContextSuspends\.get\(context\)/);
    assert.match(content, /audioSuspendPromise/);
    assert.match(content, /function resumeAudioContext\(\)/);
});

test('page wrapper ownership survives exclusion and re-enable', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /if \(ownsConnect && ownsDisconnect\) deletePatchMarker/);
    assert.match(source, /if \(ownsPushState && ownsReplaceState\) deletePatchMarker/);
    assert.match(source, /window\.Audio !== nativeAudioConstructor/);
});

test('same-player source changes keep unsaved volume without skipping DRM proof reset', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.doesNotMatch(source, /resetEphemeralControlsForMediaBoundary/);
    assert.doesNotMatch(source, /ephemeralBoundaryPending/);
    assert.match(source, /element\.addEventListener\('emptied', \(\) => \{\s*resetEmePending\(element\)/);
});

test('startup preflight bounds native-media burst before authorization resolves', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /preflightMutedElements/);
    assert.match(source, /document\.addEventListener\("play", preflightPlaybackCapture, true\)/);
    assert.match(source, /const PREFLIGHT_FAILSAFE_MS = 3000/);
    assert.match(source, /preflightDesiredMuted/);
    assert.match(source, /function patchedPreflightMutedSetter/);
    assert.match(source, /restorePreflightMutedPatch\(\)/);
    assert.match(source, /setTimeout\(releasePreflightMediaMute, PREFLIGHT_FAILSAFE_MS\)/);
    assert.doesNotMatch(source, /setTimeout\(releasePreflightMediaMute, 250\)/);
});


test('manifest keeps the four Chromium-safe default shortcuts', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.commands['volume-up'].suggested_key.default, 'Alt+Shift+Up');
    assert.equal(manifest.commands['volume-down'].suggested_key.default, 'Alt+Shift+Down');
    assert.equal(manifest.commands['volume-reset'].suggested_key.default, 'Alt+Shift+0');
    assert.equal(manifest.commands['toggle-mono'].suggested_key.default, 'Alt+Shift+M');
    assert.equal(manifest.commands['_execute_action'].suggested_key, undefined);
    assert.equal(manifest.commands['toggle-mute'].suggested_key, undefined);
});

test('shortcut UI explains unassigned defaults and exposes Firefox reset only', () => {
    const source = readFileSync(join(root, 'options.js'), 'utf8');
    const html = readFileSync(join(root, 'options.html'), 'utf8');
    assert.match(source, /function getSuggestedShortcut\(commandName\)/);
    assert.match(source, /Not set — suggested:/);
    assert.match(source, /function restoreShortcutDefaults\(\)/);
    assert.match(source, /browserApi\.commands\.reset/);
    assert.match(source, /commands\.openShortcutSettings/);
    assert.match(source, /window\.addEventListener\('focus'/);
    assert.match(source, /document\.visibilityState === 'visible'/);
    assert.match(source, /isFirefoxBrowser\(\)/);
    assert.match(html, /id="restoreShortcutDefaults" hidden/);
});

test('popup shortcut hints follow browser assignments instead of hardcoded defaults', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const html = readFileSync(join(root, 'popup.html'), 'utf8');
    assert.match(source, /commands\.getAll/);
    assert.match(source, /applyShortcutHintsToControls/);
    assert.match(source, /shortcutToAria/);
    assert.doesNotMatch(source, /Alt\+Shift\+Up \/ Alt\+Shift\+Down/);
    assert.doesNotMatch(html, /aria-keyshortcuts="Alt\+Shift/);
});

test('per-site debug overrides are independent from remembered audio', () => {
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const options = readFileSync(join(root, 'options.js'), 'utf8');
    const html = readFileSync(join(root, 'options.html'), 'utf8');
    assert.match(background, /function mutateSiteDebugSettings/);
    assert.match(background, /migrateSeparatedSiteDebugSettingsOnce/);
    assert.match(background, /siteDebugSettingsSeparatedV1: true/);
    assert.match(background, /delete next\.debug/);
    assert.match(content, /data\.siteDebugSettings \|\| \{\}/);
    assert.match(content, /legacyDebug = !data\.siteDebugSettingsSeparatedV1/);
    assert.match(options, /command: "mutateSiteDebugSettings"/);
    assert.match(options, /async function renderDebugList/);
    assert.match(html, /id="debugList"/);
});

test('queued hotkeys remain bound to their originating tab', () => {
    const shared = readFileSync(join(root, 'shared.js'), 'utf8');
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    assert.match(shared, /function tabsGet\(tabId\)/);
    assert.match(background, /await tabsGet\(commandTab\.id\)/);
    assert.match(background, /const key = commandTab && Number\.isInteger\(commandTab\.id\)/);
});

test('hotkeys confirm top-frame delivery before feedback or persistence', () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    assert.match(source, /HOTKEY_DELIVERY_RETRY_MS = 120/);
    assert.match(source, /async function sendHotkeyCommandAndConfirm/);
    assert.match(source, /if \(!state\) return false/);
    assert.match(source, /await delay\(HOTKEY_DELIVERY_RETRY_MS\)/);
});

test('manual query profiles preserve query keys while popup defaults remain path based', () => {
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    const options = readFileSync(join(root, 'options.js'), 'utf8');
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    assert.match(background, /includeQuery: true/);
    assert.match(options, /normalizeSiteSettingsEntryInput\(newRememberedInput\.value, \{ includeQuery: true \}\)/);
    assert.match(options, /normalizeSiteSettingsEntryInput\(newDebugSiteInput\.value, \{ includeQuery: true \}\)/);
    assert.match(popup, /const defaultSettingsKey = normalizeSiteSettingsEntryInput\(tab\.url\)/);
});

test('empty explicit whitelist stays empty after mode toggles', () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    assert.doesNotMatch(source, /if \(!whitelist\.length\) \{[\s\S]*Object\.keys\(data\.siteSettings/);
    assert.match(source, /intentionally empty whitelist must stay empty/);
});

test('Options synchronizes whitelist checkbox and heading across windows', () => {
    const source = readFileSync(join(root, 'options.js'), 'utf8');
    assert.match(source, /changes\.whitelistMode && whitelistModeCheckbox/);
    assert.match(source, /whitelistModeCheckbox\.checked = enabled/);
    assert.match(source, /updateAccessListLabels\(enabled\)/);
});

test('access-list changes clear stale toolbar feedback', () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    assert.match(source, /async function clearAllTabFeedback\(\)/);
    assert.match(source, /changes\.fqdns \|\| changes\.whitelist \|\| changes\.whitelistMode/);
    assert.match(source, /actionSetBadgeText\(\{ tabId, text: "" \}\)/);
});


test('fallback mute never claims a site-owned native mute', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /element\.dataset\.vcNativeMuted !== 'true' && !element\.muted/);
    assert.match(source, /if \(element\.dataset\.vcNativeMuted === 'true'\) \{/);
});

test('Firefox audio smoke waits for state transitions instead of fixed 60ms timing', () => {
    const source = readFileSync(join(root, 'scripts/firefox-smoke.mjs'), 'utf8');
    assert.match(source, /const waitFor = async/);
    assert.match(source, /disabledRestored = await waitFor/);
    assert.match(source, /reenabledPatched = await waitFor/);
    assert.doesNotMatch(source, /await sleep\(60\)/);
});

test('Firefox audio hook smoke uses an HTTP origin for bridge messages', () => {
    const source = readFileSync(join(root, 'scripts/firefox-smoke.mjs'), 'utf8');
    assert.match(source, /res\.end\(html\)/);
    assert.match(source, /`http:\/\/127\.0\.0\.1:\$\{port\}\/`/);
    assert.doesNotMatch(source, /pathToFileURL/);
});


test('isolated audio restores a gain-limited direct path after limiter route failures', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('function routeIsolatedOutput() {');
    const end = source.indexOf('function applyState() {', start);
    assert.ok(start >= 0 && end > start);
    let failLimiter = true;
    const makeNode = (id) => ({
        id, edges: [],
        connect(dest) {
            if (id === 'limiter' && failLimiter) throw new Error('connection refused');
            this.edges.push(dest);
        },
        disconnect() { this.edges = []; }
    });
    const gainNode = makeNode('gain');
    gainNode.gain = {
        value: 10,
        cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; }
    };
    const limiterNode = makeNode('limiter');
    const analyserNode = makeNode('analyser');
    const destination = {};
    const tc = {
        vars: { audioCtx: { destination, currentTime: 3 }, gainNode, limiterNode, analyserNode,
            isBlocked: false, normalizerEnabled: true, muted: false, dB: 20,
            normalizerGainDb: 9, normalizerPeakDb: -5,
            isolatedOutputUsesLimiter: null },
        settings: { debugMode: false }
    };
    const wire = runInNewContext('(' + source.slice(start, end).trim() + ')', {
        tc, configureIsolatedLimiter: () => {}, log: () => {}
    });
    wire();
    assert.equal(tc.vars.isolatedOutputUsesLimiter, false);
    assert.equal(tc.vars.normalizerGainDb, 0, 'discard accumulated AGC on limiter failure');
    assert.equal(tc.vars.normalizerPeakDb, -Infinity);
    assert.equal(gainNode.gain.value, 1, 'gain must be clamped before unprotected output reconnects');
    assert.equal(gainNode.edges.length, 1);
    assert.equal(gainNode.edges[0], destination);
    assert.equal(limiterNode.edges.length, 0, 'partial edges must be removed');

    // If a later settings change retries after a transient failure, the
    // limiter can be connected without stacking paths to the destination.
    failLimiter = false;
    wire();
    assert.equal(tc.vars.isolatedOutputUsesLimiter, true);
    assert.equal(gainNode.edges.length, 1);
    assert.equal(gainNode.edges[0], limiterNode);
    assert.equal(limiterNode.edges[0], analyserNode);
    assert.equal(analyserNode.edges[0], destination);

    // Also check the two writer paths: state updates and 100ms AGC sampling
    // must not reapply a positive gain after unprotected fallback.
    assert.match(source, /const unprotected = wantsLimiter && tc\.vars\.isolatedOutputUsesLimiter !== true/);
    assert.match(source, /manualGain \* \(unprotected \? 1 : autoGain\)/);
    assert.match(source, /const protectedOutput = tc\.vars\.isolatedOutputUsesLimiter === true/);
    assert.match(source, /tc\.vars\.normalizerEnabled && !tc\.vars\.muted && !tc\.vars\.isBlocked &&\s*tc\.vars\.isolatedOutputUsesLimiter === true/);
    assert.match(source, /: Math\.min\(1, manualGain\)/);
});


test('limiter-to-direct transitions clamp boosted MAIN-world page output before reconnect', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function clampUnprotectedOutput(processor) {');
    const end = source.indexOf('    function ensureGraph(context) {', start);
    assert.ok(start >= 0 && end > start);
    const output = { label: 'destination' };
    const nodes = Object.fromEntries(['gain','splitter','leftGain','rightGain','merger','limiter','analyser'].map(name => [name, {
        label: name, edges: []
    }]));
    const gain = { value: 8, cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; },
        linearRampToValueAtTime(value) { this.value = value; } };
    nodes.gain.gain = gain;
    const graph = { ...nodes, context: { state: 'running', currentTime: 2, destination: output },
        currentMode: 'stereo-limited', limiterFallbackActive: false, normalizerGainDb: 12 };
    const oldLimited = [nodes.limiter];
    nodes.gain.edges = oldLimited.slice();
    nodes.limiter.edges = [nodes.analyser];
    nodes.analyser.edges = [output];
    let safeAtConnection = null;
    const state = { extensionActive: true, enabled: true, normalizerEnabled: false,
        mono: false, muted: false, dB: -10 };
    const wireGraph = runInNewContext('(() => {\n' + source.slice(start,end) + '\nreturn wireGraph;})()', {
        state, log: () => {}, configureLimiter: () => {},
        effectiveGain: () => 10 ** (-10 / 20),
        dbToGain: v => 10 ** (v/20),
        connectNative: (a,b) => {
            if (a === nodes.gain && b === output) safeAtConnection = gain.value <= 1;
            a.edges.push(b);
        },
        safeDisconnect: n => { n.edges = []; }
    });
    wireGraph(graph);
    assert.equal(safeAtConnection, true, 'direct connection must never receive old boosted gain');
    assert.equal(graph.currentMode, 'stereo-direct');
    assert.equal(graph.gain.edges[0], output);
    assert.ok(gain.value < 1);
    // A failed clamp must preserve the existing compressor instead of
    // disconnecting it and opening an unsafe direct connection.
    graph.currentMode = 'stereo-limited';
    nodes.gain.edges = oldLimited.slice();
    gain.value = 9;
    gain.cancelScheduledValues = () => { throw Error('closed AudioParam'); };
    wireGraph(graph);
    assert.equal(graph.currentMode, 'stereo-limited');
    assert.equal(nodes.gain.edges[0], nodes.limiter);
});

test('MAIN-world media route clamps before bypassing limiter on Normalize off', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function setMediaGainValue(route) {');
    const end = source.indexOf('    function ensureMediaRoute(element) {', start);
    assert.ok(start >= 0 && end > start);
    const destination = {};
    const nodes = Object.fromEntries(['gain','splitter','leftGain','rightGain','merger','limiter','analyser'].map(n=>[n,{ edges: [] }]));
    const param = { value: 7, cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; } };
    nodes.gain.gain = param;
    const route = { ...nodes, context: { state: 'running', currentTime: 1, destination },
        currentMode: 'stereo-limited', outputConnected: true, limiterFallbackActive: false, normalizerGainDb: 10 };
    let safeAtConnection = null;
    const wire = runInNewContext('(() => {\n' + source.slice(start,end) + '\nreturn wireMediaRoute;})()', {
        state: { extensionActive: true, enabled: true, normalizerEnabled: false, muted: false, mono: false, dB: -10 },
        log: () => {}, configureLimiter: () => {}, safetyLimiterRequired: () => false,
        currentRoutingMode: () => 'stereo-direct',
        dbToGain: v => 10 ** (v/20), effectiveGain: () => 10 ** (-10/20),
        connectNative: (a,b) => {
            if (a === nodes.gain && b === destination) safeAtConnection = param.value <= 1;
            a.edges.push(b);
        },
        clampUnprotectedOutput: () => true,
        clampDirectOutputGain: processor => {
            const p=processor.gain.gain; p.cancelScheduledValues(1);
            p.setValueAtTime(10 ** (-10/20), 1); return true;
        },
        disconnectMediaRouteOutput: processor => {
            for (const n of Object.values(nodes)) n.edges = [];
            processor.outputConnected = false;
        }
    });
    wire(route);
    assert.equal(safeAtConnection, true);
    assert.equal(route.currentMode, 'stereo-direct');
    assert.equal(route.outputConnected, true);
    assert.equal(route.gain.edges[0], destination);
    assert.match(source, /if \(!safetyLimiterRequired\(\) && !clampDirectOutputGain\(route\)\) return;/);
});

test('isolated Normalize off clamps output before bypassing its compressor', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('function routeIsolatedOutput() {');
    const end = source.indexOf('function applyState() {', start);
    assert.ok(start >= 0 && end > start);
    const destination = {};
    const gainNode = { edges: [], connect(to) {
        if (to === destination) this.safeAtConnect = this.gain.value <= 1;
        this.edges.push(to);
    }, disconnect() { this.edges = []; } };
    const limiterNode = { edges: [], connect(to) { this.edges.push(to); },
        disconnect() { this.edges = []; } };
    const analyserNode = { edges: [], connect(to) { this.edges.push(to); },
        disconnect() { this.edges = []; } };
    gainNode.gain = { value: 8, cancelScheduledValues() {},
        setValueAtTime(v) { this.value = v; } };
    const tc = { vars: { audioCtx: { destination, currentTime: 2 }, gainNode, limiterNode,
        analyserNode, isolatedOutputUsesLimiter: true, isBlocked: false,
        normalizerEnabled: false, muted: false, dB: -10 },
        settings: { debugMode: false } };
    const wire = runInNewContext('(' + source.slice(start,end).trim() + ')', {
        tc, getGainValue: db => 10**(db/20), configureIsolatedLimiter: () => {}, log: () => {}
    });
    wire();
    assert.equal(gainNode.safeAtConnect, true);
    assert.equal(tc.vars.isolatedOutputUsesLimiter, false);
    assert.equal(gainNode.edges[0], destination);
    assert.ok(gainNode.gain.value < 1);

    tc.vars.isolatedOutputUsesLimiter = true;
    gainNode.gain.value = 8;
    gainNode.gain.cancelScheduledValues = () => { throw Error('AudioParam closed'); };
    gainNode.edges = [limiterNode];
    wire();
    assert.equal(tc.vars.isolatedOutputUsesLimiter, true);
    assert.equal(gainNode.edges[0], limiterNode);
});


test('site-block toggles discard stale automatic gain before audio can be re-enabled', () => {
    const src = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = src.indexOf('        if (tc.vars.isBlocked !== blocked) {');
    const end = src.indexOf('        controlProfileReady = true;', start);
    assert.ok(start >= 0 && end > start, 'block transition reset must exist');
    const apply = runInNewContext('(function(tc, blocked) {\n' +
        'let lastSyncedPageAudioState = "cached";\n' +
        src.slice(start, end) +
        '\nreturn lastSyncedPageAudioState;\n})');
    const tc = { vars: { isBlocked: false, normalizerGainDb: 12, normalizerPeakDb: -3 } };
    assert.equal(apply(tc, true), null);
    assert.equal(tc.vars.isBlocked, true);
    assert.equal(tc.vars.normalizerGainDb, 0);
    assert.equal(tc.vars.normalizerPeakDb, -Infinity);

    tc.vars.normalizerGainDb = 15;
    tc.vars.normalizerPeakDb = -2;
    assert.equal(apply(tc, false), null);
    assert.equal(tc.vars.isBlocked, false);
    assert.equal(tc.vars.normalizerGainDb, 0, 're-enable must not replay stale +15 dB');
    assert.equal(tc.vars.normalizerPeakDb, -Infinity);

    tc.vars.normalizerGainDb = 3;
    assert.equal(apply(tc, false), 'cached', 'unchanged blocking must not reset active normalizer');
    assert.equal(tc.vars.normalizerGainDb, 3);
});

test('MAIN-world meter messages treat null and missing peaks as silence', () => {
    const src = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = src.indexOf('    if (data.command === "meterUpdate") {');
    const end = src.indexOf('    if (data.command !== "requestState") return;', start);
    assert.ok(start >= 0 && end > start, 'meter bridge listener must exist');
    const handle = runInNewContext('(function(tc, data) {\n' + src.slice(start, end) + '\n})');
    const tc = { vars: { normalizerEnabled: true, isBlocked: false,
        normalizerPeakDb: -5, normalizerGainDb: 4 } };
    for (const peakDb of [null, undefined, '0', NaN, -Infinity]) {
        handle(tc, { command: 'meterUpdate', peakDb, normalizerGainDb: null });
        assert.equal(tc.vars.normalizerPeakDb, -Infinity, 'invalid/nonfinite peak must not appear as 0 dBFS');
        assert.equal(tc.vars.normalizerGainDb, 0);
    }
    handle(tc, { command: 'meterUpdate', peakDb: -18.7, normalizerGainDb: 2.3 });
    assert.equal(tc.vars.normalizerPeakDb, -18.7);
    assert.equal(tc.vars.normalizerGainDb, 2.3);
    handle(tc, { command: 'meterUpdate', peakDb: 0, normalizerGainDb: -4 });
    assert.equal(tc.vars.normalizerPeakDb, 0, 'valid full-scale reading remains valid');
    assert.equal(tc.vars.normalizerGainDb, -4);

    tc.vars.normalizerEnabled = false;
    handle(tc, { command: 'meterUpdate', peakDb: -1, normalizerGainDb: 15 });
    assert.equal(tc.vars.normalizerGainDb, -4, 'disabled normalizer must ignore in-flight meter tick');
    tc.vars.normalizerEnabled = true;
    tc.vars.isBlocked = true;
    handle(tc, { command: 'meterUpdate', peakDb: -1, normalizerGainDb: 15 });
    assert.equal(tc.vars.normalizerGainDb, -4, 'blocked site must ignore in-flight meter tick');
});

test('normalizer popup preserves restrictions and pending checkbox state', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = source.indexOf('function applyNormalizerState(state = {}) {');
    const end = source.indexOf('function applyAudioControlState(state = {}) {', start);
    assert.ok(start >= 0 && end > start);
    const toggles = [];
    const classList = { toggle(name, enabled) { toggles.push({ name, enabled }); } };
    const panel = { classList };
    const checkbox = { checked: true, disabled: false,
        closest: () => panel, setAttribute: () => {} };
    const details = { hidden: false };
    const note = { textContent: '', classList };
    const cached = {
        normalizerCheckbox: checkbox, normalizerNote: note,
        normalizerAvailable: false, normalizerPending: true
    };
    const apply = runInNewContext('(' + source.slice(start, end).trim() + ')', {
        cached,
        document: { querySelector: () => null, getElementById: () => details },
        formatMeterDb: () => '−∞ dBFS'
    });
    apply({ normalizerEnabled: false }); // stale state arrives while saving
    assert.equal(checkbox.checked, true);
    assert.equal(details.hidden, false);
    assert.equal(cached.normalizerAvailable, false);
    assert.ok(toggles.some(x => x.name === 'is-unavailable' && x.enabled));

    cached.normalizerPending = false;
    apply({ normalizerEnabled: false });
    assert.equal(checkbox.checked, false);
    assert.equal(details.hidden, true);
    // Only an explicit availability verdict can clear the restriction.
    apply({ normalizerAvailable: true });
    assert.equal(cached.normalizerAvailable, true);
});

test('normalizer preference saves even without an active audio route or tab receiver', async () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = source.indexOf('async function toggleNormalizer(tab) {');
    const end = source.indexOf('async function toggleMute(tab, muted) {', start);
    assert.ok(start >= 0 && end > start, 'popup normalizer toggle must be present');
    const method = source.slice(start, end).trim();

    const checkbox = { checked: true, disabled: false };
    const saved = [];
    const errors = [];
    let refreshed = 0;
    const sandbox = {
        cached: { normalizerCheckbox: checkbox, normalizerAvailable: false },
        normalizerRequestGeneration: 0,
        document: { querySelector: () => checkbox },
        applyNormalizerState: ({ normalizerEnabled }) => { checkbox.checked = Boolean(normalizerEnabled); },
        normalizeSiteSettingsEntryInput: () => 'example.com/video',
        mutateSiteNormalizerSettings: async (mutation) => { saved.push(mutation); return { ok: true }; },
        tabsSendMessage: async () => { throw new Error('No receiving content script'); },
        TOP_FRAME_OPTIONS: { frameId: 0 },
        handleError: (error) => { errors.push(error); },
        refreshAudioControlState: async () => { refreshed++; }
    };
    const toggle = runInNewContext('(' + method + ')', sandbox);
    await toggle({ id: 1, url: 'https://example.com/video' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].enabled, true);
    assert.equal(checkbox.checked, true);
    assert.equal(errors.length, 0);
    assert.equal(refreshed, 1);

    sandbox.mutateSiteNormalizerSettings = async () => ({ ok: false, reason: 'storage-error' });
    checkbox.checked = false;
    await toggle({ id: 1, url: 'https://example.com/video' });
    assert.equal(checkbox.checked, true, 'failed storage write must restore previous visual switch state');
    assert.equal(errors.length, 1);
    assert.equal(refreshed, 1);
});

test('graph reconnect failure remains retryable after the first failed connect', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function wireGraph(graph) {');
    const end = source.indexOf('    function ensureGraph(context) {', start);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    assert.match(body, /graph\.currentMode = wantMode;\s*graph\.limiterFallbackActive = false;\s*\} catch/);
    assert.match(body, /catch \(e\) \{\s*graph\.currentMode = null;/);
    assert.match(body, /clampUnprotectedOutput\(graph\)/);
    assert.doesNotMatch(body, /if \(graph\.currentMode === wantMode\) return;\s*graph\.currentMode = wantMode/);
});

test('normalizer Options does not save a field twice on blur', () => {
    const source = readFileSync(join(root, 'options.js'), 'utf8');
    assert.match(source, /input\.addEventListener\('change', saveNormalizerConfig\)/);
    assert.doesNotMatch(source, /input\.addEventListener\('blur', saveNormalizerConfig\)/);
});

test('invalid stored normalizer configuration cannot disable audio controls', () => {
    const shared = readFileSync(join(root, 'shared.js'), 'utf8');
    const context = { globalThis: {} };
    runInNewContext(shared, context);
    const normalize = context.globalThis.VolumeControlShared.normalizeNormalizerConfig;
    assert.equal(normalize(null).targetDb, -16);
    assert.equal(normalize(false).ceilingDb, -1);
    assert.equal(normalize('invalid').responseMs, 600);

    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = page.indexOf('    function normalizeNormalizerConfig(value = {}) {');
    const end = page.indexOf('    function configureLimiter(processor) {', start);
    assert.ok(start >= 0 && end > start);
    const normalizePage = runInNewContext(page.slice(start, end) + '\nnormalizeNormalizerConfig', {});
    assert.equal(normalizePage(null).targetDb, -16);
    assert.equal(normalizePage({ targetDb: '', ceilingDb: null }).ceilingDb, -1);
    assert.equal(normalizePage({ targetDb: '' }).targetDb, -16);
});

test('cleared or absent normalizer config numbers restore defaults, not louder targets', () => {
    const shared = readFileSync(join(root, 'shared.js'), 'utf8');
    const context = { globalThis: {} };
    runInNewContext(shared, context);
    const { normalizeNormalizerConfig, DEFAULT_NORMALIZER_CONFIG } = context.globalThis.VolumeControlShared;
    assert.equal(normalizeNormalizerConfig({ targetDb: '', ceilingDb: '', responseMs: '', maxBoostDb: '' }).targetDb, DEFAULT_NORMALIZER_CONFIG.targetDb);
    assert.equal(normalizeNormalizerConfig({ targetDb: null, ceilingDb: null }).ceilingDb, DEFAULT_NORMALIZER_CONFIG.ceilingDb);
    assert.equal(normalizeNormalizerConfig({ targetDb: '   ' }).targetDb, DEFAULT_NORMALIZER_CONFIG.targetDb);
    assert.equal(normalizeNormalizerConfig({ targetDb: '-20' }).targetDb, -20);
});

test('limiter ceiling updates without reconnecting an unchanged audio route', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const isolated = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(page, /function wireGraph\(graph\) \{[\s\S]*?configureLimiter\(graph\);/);
    assert.match(page, /graph\.currentMode === wantMode[\s\S]*?setGainValue\(graph\)/);
    assert.match(page, /function wireMediaRoute\(route\) \{[\s\S]*?configureLimiter\(route\);[\s\S]*?route\.currentMode === wantMode && route\.outputConnected/);
    assert.match(isolated, /if \(tc\.vars\.isolatedOutputUsesLimiter\) configureIsolatedLimiter\(\);\s*routeIsolatedOutput\(\);/);
});

test('normalization off bypasses compressor but positive boosts retain limiting', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = page.indexOf('    function safetyLimiterRequired() {');
    const end = page.indexOf('    // Connect a mono down-mix chain:', start);
    assert.ok(start >= 0 && end > start);
    const state = { extensionActive: true, enabled: true, normalizerEnabled: false, muted: false, dB: 0, mono: false };
    const routing = runInNewContext(page.slice(start, end) +
        '\n({ safetyLimiterRequired, currentRoutingMode })', { state });
    assert.equal(routing.safetyLimiterRequired(), false);
    assert.equal(routing.currentRoutingMode(), 'stereo-direct');

    state.dB = 6;
    assert.equal(routing.safetyLimiterRequired(), true);
    assert.equal(routing.currentRoutingMode(), 'stereo-limited');
    state.dB = 0;
    state.normalizerEnabled = true;
    assert.equal(routing.currentRoutingMode(), 'stereo-limited');
    state.normalizerEnabled = false;
    state.mono = true;
    assert.equal(routing.currentRoutingMode(), 'mono-direct');
    state.enabled = false;
    assert.equal(routing.safetyLimiterRequired(), false);
    assert.equal(routing.currentRoutingMode(), 'bypass');
    assert.match(page, /const output = useLimiter \? graph\.limiter : graph\.context\.destination/);
    assert.match(page, /const output = useLimiter \? route\.limiter : route\.context\.destination/);

    const isolated = readFileSync(join(root, 'cs.js'), 'utf8');
    const fStart = isolated.indexOf('function routeIsolatedOutput() {');
    const fEnd = isolated.indexOf('function applyState() {', fStart);
    assert.ok(fStart >= 0 && fEnd > fStart);
    const node = () => ({
        edges: [],
        connect(destination) { this.edges.push(destination); },
        disconnect() { this.edges = []; }
    });
    const gainNode = node(), limiterNode = node(), analyserNode = node(), destination = {};
    gainNode.gain = {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; }
    };
    const tc = {
        vars: { audioCtx: { destination, currentTime: 1 }, gainNode, limiterNode, analyserNode,
            normalizerEnabled: false, muted: false, dB: 0, isBlocked: false, isolatedOutputUsesLimiter: null },
        settings: { debugMode: false }
    };
    const wire = runInNewContext('(' + isolated.slice(fStart, fEnd).trim() + ')', {
        tc, configureIsolatedLimiter: () => {}, getGainValue: dB => 10 ** (dB / 20), log: () => {}
    });
    wire();
    assert.equal(gainNode.edges[0], destination);
    assert.equal(limiterNode.edges.length, 0);

    tc.vars.normalizerEnabled = true;
    wire();
    assert.equal(gainNode.edges[0], limiterNode);
    assert.equal(limiterNode.edges[0], analyserNode);
    assert.equal(analyserNode.edges[0], destination);

    tc.vars.normalizerEnabled = false;
    tc.vars.dB = 3;
    wire();
    assert.equal(gainNode.edges[0], limiterNode);

    tc.vars.dB = 0;
    wire();
    assert.equal(gainNode.edges[0], destination);
    assert.equal(limiterNode.edges.length, 0);
});


test('Howler cleanup never double-restores native audio and rolls back reconnect failures', () => {
    const src = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = src.indexOf('    function unrouteHowlerGlobal() {');
    const end = src.indexOf('    function routeKnownAudioLibraries() {', start);
    assert.ok(start >= 0 && end > start);

    const exercise = ({ nativeRestored = false, failNative = false, failDisconnect = false } = {}) => {
        const masterGain = {};
        const destination = {};
        const graph = { inputAnalyser: {} };
        const context = { destination };
        const route = { graph, context };
        const routes = new Map([[masterGain, route]]);
        const entry = { routed: !nativeRestored };
        const entries = new Set([entry]);
        const calls = [];
        const test = runInNewContext('(' + src.slice(start, end).trim() + ')', {
            window: { Howler: { ctx: context, masterGain } },
            pageAudioNeedsRoute: () => false,
            howlerRoutes: routes,
            findDestinationConnection: () => entry,
            destinationConnections: entries,
            disconnectNative: (_node, target) => {
                calls.push(['disconnect', target]);
                if (failDisconnect) throw new Error('disconnect rejected');
            },
            connectNative: (_node, target) => {
                calls.push(['connect', target]);
                if (failNative && target === destination) throw new Error('native reconnect rejected');
            },
            log: () => {}
        });
        test();
        return { routes, entries, calls, entry, masterGain, graph, destination };
    };

    const already = exercise({ nativeRestored: true });
    assert.equal(already.routes.size, 0);
    assert.equal(already.entries.size, 0);
    assert.equal(already.calls.length, 0, 'a previously restored path must not be connected twice');

    const success = exercise();
    assert.equal(success.routes.size, 0);
    assert.equal(success.entries.size, 0);
    assert.equal(success.calls.filter(x => x[0] === 'connect' && x[1] === success.destination).length, 1);
    assert.deepEqual(success.calls.map(x => x[0]), ['disconnect', 'connect']);

    const failedNative = exercise({ failNative: true });
    assert.equal(failedNative.routes.size, 1, 'keep routing state for a later retry');
    assert.equal(failedNative.entries.size, 1);
    assert.equal(failedNative.entry.routed, true);
    assert.equal(failedNative.calls[2][1], failedNative.graph.inputAnalyser,
        'failed native reconnect must restore the graph path');

    const failedDisconnect = exercise({ failDisconnect: true });
    assert.equal(failedDisconnect.routes.size, 1);
    assert.equal(failedDisconnect.calls.length, 1,
        'do not connect a new destination after the original graph disconnect failed');
});

test('normalizer source peak detector windows overlap 100ms updates in both worlds', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const isolated = readFileSync(join(root, 'cs.js'), 'utf8');
    const docs = readFileSync(join(root, 'README.md'), 'utf8');
    const inputFft = 8192;
    const frameDurationMs = inputFft / 48000 * 1000;
    assert.ok(frameDurationMs > 100,
        'sample-peak buffer must span longer than successive 100ms AGC updates');
    assert.equal((page.match(/inputAnalyser\.fftSize = 8192/g) || []).length, 2);
    assert.match(isolated, /tc\.vars\.inputAnalyserNode\.fftSize = 8192/);
    assert.match(docs, /8,192 samples/);
});

test('reused media source resets stale automatic gain before next track and fails closed', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = page.indexOf('    function resetMediaBoundaryGain(route) {');
    const end = page.indexOf('    function wireMediaRoute(route) {', start);
    assert.ok(start >= 0 && end > start);
    let manual = 1;
    let disconnected = false;
    const reset = runInNewContext('(' + page.slice(start, end).trim() + ')', {
        effectiveGain: () => manual,
        disconnectMediaRouteOutput: route => { disconnected = true; route.outputConnected = false; },
        log: () => {}
    });
    const param = {
        value: 12,
        cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; }
    };
    const route = {
        gain: { gain: param },
        context: { currentTime: 3 },
        currentMode: 'stereo-limited',
        outputConnected: true,
        limiterFallbackActive: false,
        normalizerGainDb: 12
    };
    assert.equal(reset(route), true);
    assert.equal(param.value, 1, 'old +12 dB automatic boost cannot leak into next track');
    manual = 3;
    param.value = 9;
    route.currentMode = 'stereo-direct';
    assert.equal(reset(route), true);
    assert.equal(param.value, 1, 'unlimited positive gain cannot play on a direct route');
    param.value = 15;
    param.cancelScheduledValues = () => { throw Error('AudioParam error'); };
    assert.equal(reset(route), false);
    assert.equal(disconnected, true, 'failed gain clamp disconnects output');
    assert.equal(route.outputConnected, false);
    assert.match(page, /route\.sourceGainResetPending = true/);
    assert.match(page, /if \(route\.sourceGainResetPending\) \{\s*if \(!resetMediaBoundaryGain\(route\)\) return;\s*route\.sourceGainResetPending = false/);
});

test('normalizer resets accumulated automatic gain on toggles and media changes', () => {
    const isolated = readFileSync(join(root, 'cs.js'), 'utf8');
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(isolated, /case "setNormalizer":[\s\S]*?tc\.vars\.normalizerGainDb = 0/);
    assert.match(isolated, /resolvedNormalizerEnabled[\s\S]*?tc\.vars\.normalizerGainDb = 0/);
    assert.match(page, /wasNormalizing !== nowNormalizing/);
    assert.match(page, /route\.normalizerGainDb = 0/);
    assert.match(page, /const sourceBoundary = \(\) => \{[\s\S]*?route\.normalizerGainDb = 0/);
});

test('normalizer defaults off and per-site preferences override the default', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const options = readFileSync(join(root, 'options.js'), 'utf8');
    assert.match(content, /normalizerDefaultEnabled: false/);
    assert.match(content, /normalizerSettingsKey\s*\?/);
    assert.match(content, /:\s*Boolean\(data\.normalizerDefaultEnabled\)/);
    assert.match(content, /changes\.normalizerDefaultEnabled/);
    assert.match(options, /storageSet\(\{ normalizerDefaultEnabled: enabled \}\)/);
});

test('desktop 420px action popup does not inherit Android-only fluid width', () => {
    const popupCss = readFileSync(join(root, 'popup.css'), 'utf8');
    assert.match(popupCss, /^html, body \{\s*width:\s*420px;/m);
    const android = popupCss.match(/@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(android, 'Android touch rules must be behind a touch-specific media query');
    assert.match(android[1], /html, body\s*\{\s*width:\s*100%/);
    assert.doesNotMatch(popupCss, /@media\s*\(max-width:\s*480px\)/);
});

test('normalizer off state folds popup meter and Options settings', () => {
    const popupHtml = readFileSync(join(root, 'popup.html'), 'utf8');
    const optionsHtml = readFileSync(join(root, 'options.html'), 'utf8');
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const options = readFileSync(join(root, 'options.js'), 'utf8');
    assert.match(popupHtml, /id="normalizer-details"[^>]*hidden/);
    assert.match(optionsHtml, /id="normalizer-options-details" hidden/);
    assert.match(optionsHtml, /id="normalizerDefaultEnabled"/);
    assert.match(popup, /details\.hidden = !\(checkbox && checkbox\.checked\)/);
    assert.match(options, /normalizerOptionsDetails\.hidden = !active/);
    assert.match(popup, /!cached\.normalizerCheckbox\?\.checked/);
});

test('disabled normalization does not keep 100ms timers alive in every tab', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const isolated = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(page, /function syncNormalizerMeterTimer\(\)/);
    assert.match(page, /if \(normalizerMeterTimerId !== null\) clearInterval\(normalizerMeterTimerId\)/);
    assert.match(page, /normalizerMeterTimerId = setInterval\(updateNormalizerAndMeter, 100\)/);
    assert.doesNotMatch(page, /maintenanceTimerIds = \[\s*setInterval\(updateNormalizerAndMeter, 100\)/);
    assert.match(isolated, /const shouldRun = !tc\.vars\.isBlocked && tc\.vars\.normalizerEnabled/);
    assert.match(isolated, /if \(tc\.vars\.normalizerTimer !== null\) clearInterval\(tc\.vars\.normalizerTimer\)/);
    assert.match(isolated, /if \(gainNode && audioCtx\) \{\s*ensureIsolatedNormalizerTimer\(\);/);
});

test('normalizer sampling returns early when switched off', () => {
    const hook = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(hook, /function updateNormalizerAndMeter\(\) \{\s*if \(!state\.normalizerEnabled\) return;/);
    assert.match(content, /function sampleIsolatedNormalizer\(\) \{\s*if \(!tc\.vars\.normalizerEnabled\) return;/);
});

test('Firefox installed-extension smoke uses Firefox headless environment, not unsupported web-ext flag', () => {
    const source = readFileSync(join(root, 'scripts/firefox-extension-smoke.mjs'), 'utf8');
    assert.doesNotMatch(source, /^\s*'--headless',/m);
    assert.match(source, /MOZ_HEADLESS: '1'/);
});

test('CI requires both Chromium and Firefox runtime smoke tests', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const chromium = readFileSync(join(root, 'scripts/browser-smoke.mjs'), 'utf8');
    const firefox = readFileSync(join(root, 'scripts/firefox-smoke.mjs'), 'utf8');
    assert.match(workflow, /REQUIRE_BROWSER_SMOKE: "1"/);
    assert.match(workflow, /node scripts\/firefox-smoke\.mjs/);
    assert.match(workflow, /dist\/smoke\/chrome/);
    assert.match(workflow, /dist\/smoke\/firefox/);
    assert.match(chromium, /process\.env\.VC_EXTENSION_DIR/);
    assert.match(firefox, /process\.env\.VC_EXTENSION_DIR/);
    assert.match(chromium, /throw new Error\(message\)/);
    assert.match(firefox, /Firefox smoke passed/);
});

test('AMO manual publishing is stable-tag bound and duplicate-safe', () => {
    const source = readFileSync(join(root, '.github/workflows/publish-firefox.yml'), 'utf8');
    assert.match(source, /release_tag:/);
    assert.match(source, /publish:/);
    assert.match(source, /MANUAL_PUBLISH/);
    assert.match(source, /refs\/tags\/\$\(\$env:RELEASE_TAG\)/);
    assert.match(source, /does not match manifest version/);
    assert.match(source, /filter=all_without_unlisted/);
    assert.match(source, /Expand-Archive/);
    assert.match(source, /VC_EXTENSION_DIR: dist\/smoke\/firefox/);
    assert.match(source, /node scripts\/firefox-extension-smoke\.mjs/);
    assert.match(source, /Validation-only manual run/);
    assert.doesNotMatch(source, /git fetch --force --no-tags --depth=1 origin "\$env:GITHUB_SHA"/);
});

test('browser smoke covers startup mute restoration and page wrapper ownership', () => {
    const source = readFileSync(join(root, 'scripts/browser-smoke.mjs'), 'utf8');
    assert.match(source, /preflightMuted/);
    assert.match(source, /preflightRestored/);
    assert.match(source, /siteWrapperPreservedOnDisable/);
    assert.match(source, /siteWrapperPreservedOnReenable/);
});
