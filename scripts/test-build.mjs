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
    assert.match(page, /connectNative\(route\.source, inputAnalyser\)/);
    assert.match(page, /connectNative\(source, graph\.inputAnalyser/);
    assert.match(page, /connectNative\(this, graph\.inputAnalyser/);
    assert.match(page, /connectNative\(masterGain, graph\.inputAnalyser\)/);
    assert.match(page, /sourceAnalyser\.getFloatTimeDomainData\(processor\.inputBuffer\)/);
    assert.doesNotMatch(page, /gainDb \+ \(config\.targetDb - rmsDb\)/);
    assert.match(content, /input\.connect\(gain\)/);
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
        assert.match(src, /(?:inputAnalyser|input)\.fftSize = 8192/);
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
        syncNormalizerMeterTimer: () => {},
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
    assert.match(background, /const originTab = commandTab && Number\.isInteger\(commandTab\.id\)/);
    assert.match(background, /const key = originTab\.id;/);
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
    assert.match(popup, /const defaultSettingsKey = normalizeSiteSettingsEntryInput\(url\)/);
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
        syncNormalizerMeterTimer: () => {},
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

test('normalizer popup preserves saved preference while disabling unsupported DRM/CORS controls', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = source.indexOf('function applyNormalizerState(state = {}) {');
    const end = source.indexOf('function applyAudioControlState(state = {}) {', start);
    assert.ok(start >= 0 && end > start);
    const toggles = [];
    const attributes = {};
    const label = { title: '' };
    const classList = { toggle(name, enabled) { toggles.push({ name, enabled }); } };
    const panel = { classList, querySelector: () => label };
    const checkbox = { checked: true, disabled: false,
        closest: () => panel, setAttribute: (name, val) => { attributes[name] = val; } };
    const details = { hidden: false };
    const note = { textContent: '', classList };
    const cached = {
        normalizerCheckbox: checkbox, normalizerNote: note,
        normalizerAvailable: true, normalizerUnavailableReason: '', normalizerPending: true
    };
    const apply = runInNewContext('(' + source.slice(start, end).trim() + ')', {
        cached,
        document: { querySelector: () => null, getElementById: () => details },
        formatMeterDb: () => '−∞ dBFS'
    });

    apply({ normalizerEnabled: false, normalizerAvailable: false, normalizerUnavailableReason: 'restricted' });
    assert.equal(checkbox.checked, true, 'an in-flight preference must not be overwritten by old replies');
    assert.equal(checkbox.disabled, true, 'unavailable Normalize must be disabled');
    assert.equal(attributes['aria-disabled'], 'true');
    assert.equal(attributes['aria-describedby'], 'normalizer-note');
    assert.equal(details.hidden, true, 'inaccessible gain/meter must fold even when enabled');
    assert.match(note.textContent, /DRM/);
    assert.match(note.textContent, /saved Normalize preference will resume/);
    assert.ok(toggles.some(x => x.name === 'hidden' && x.enabled === false));
    assert.ok(toggles.some(x => x.name === 'is-unavailable' && x.enabled === true));

    cached.normalizerPending = false;
    apply({ normalizerEnabled: false, normalizerAvailable: false, normalizerUnavailableReason: 'cross-origin' });
    assert.equal(checkbox.checked, false, 'actual disabled preference is retained separately');
    assert.equal(checkbox.disabled, true);
    assert.equal(details.hidden, true);
    assert.match(note.textContent, /cross-origin/);
    assert.doesNotMatch(note.textContent, /saved Normalize preference will resume/);
    assert.ok(toggles.some(x => x.name === 'hidden' && x.enabled === false),
        'restriction note must stay visible with Normalize OFF');

    apply({ normalizerAvailable: false, normalizerUnavailableReason: 'native-route' });
    assert.match(note.textContent, /Force native/);

    // Meter-only frames do not send the restriction reason. Keep the last
    // known reason so polling cannot replace it with a generic warning.
    apply({ peakDb: -20 });
    assert.match(note.textContent, /Force native/);

    apply({ normalizerEnabled: true, normalizerAvailable: true, normalizerUnavailableReason: '' });
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.disabled, false, 'compatible audio restores the control');
    assert.equal(attributes['aria-disabled'], 'false');
    assert.equal(details.hidden, false, 'saved enabled preference resumes with the meter');
    assert.ok(toggles.some(x => x.name === 'hidden' && x.enabled === true));
});

test('Normalize warning stays outside the folded meter and DRM fallback note mentions it', () => {
    const html = readFileSync(join(root, 'popup.html'), 'utf8');
    const css = readFileSync(join(root, 'popup.css'), 'utf8');
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const note = html.indexOf('id="normalizer-note"');
    const details = html.indexOf('id="normalizer-details"');
    assert.ok(note >= 0 && details > note,
        'Normalize availability warning must be outside the meter/details hidden section');
    assert.match(css, /\.normalizer-panel\.is-unavailable \.normalizer-switch\s*\{[^}]*opacity:\s*0\.[0-9]+/);
    assert.match(popup, /checkbox\.disabled = !available/);
    assert.match(popup, /Normalize is also unavailable until compatible WebAudio playback resumes/);
    assert.match(popup, /!cached\.normalizerAvailable\) return null;/);
});

test('normalizer route availability distinguishes DRM/CORS and forced native', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function getNormalizerAvailability(limit = getBoostLimitInfo()) {');
    const end = content.indexOf('function getAudioControlState() {', begin);
    assert.ok(begin >= 0 && end > begin);
    const ctx = { tc: { settings: { debugRouteMode: 'auto' } } };
    const fn = runInNewContext('(' + content.slice(begin, end).trim() + ')', ctx);
    assert.equal(fn({ boostLimited: true, reason: 'restricted' }).available, false);
    assert.equal(fn({ boostLimited: true, reason: 'restricted' }).reason, 'restricted');
    assert.equal(fn({ boostLimited: true, reason: 'cross-origin' }).available, false);
    ctx.tc.settings.debugRouteMode = 'native';
    assert.equal(fn({ boostLimited: false }).reason, 'native-route');
    ctx.tc.settings.debugRouteMode = 'auto';
    assert.equal(fn({ boostLimited: false, reason: '' }).available, true);
});

test('confirmed unavailable Normalize ignores toggle requests without altering saved preference', async () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const begin = source.indexOf('async function toggleNormalizer(tab) {');
    const end = source.indexOf('async function toggleMute(tab, muted) {', begin);
    assert.ok(begin > 0 && end > begin);
    const checkbox = { checked: true, disabled: true };
    const writes = [];
    const fn = runInNewContext('(' + source.slice(begin, end).trim() + ')', {
        cached: { normalizerCheckbox: checkbox, normalizerAvailable: false },
        document: { querySelector: () => checkbox },
        mutateSiteNormalizerSettings: mutation => { writes.push(mutation); }
    });
    await fn({ id: 1, url: 'https://example.com/watch' });
    assert.equal(checkbox.checked, true, 'saved Normalize-on preference remains checked while unavailable');
    assert.equal(writes.length, 0, 'disabled Normalize must never save a new preference');
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
        normalizerDeliveryChain: Promise.resolve(),
        document: { querySelector: () => checkbox },
        applyNormalizerState: ({ normalizerEnabled }) => { checkbox.checked = Boolean(normalizerEnabled); },
        currentTabUrl: async tab => tab.url,
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
    assert.match(isolated, /input\.fftSize = 8192/);
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
    assert.match(popup, /details\.hidden = !enabled \|\| !available/);
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
    assert.match(hook, /function updateNormalizerAndMeter\(\) \{\s*if \(!state\.normalizerEnabled \|\| !hasAnalyzableAudioRoute\(\)\) \{/);
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


test('media route source capture is recoverable and rescue path never boosts without limiter', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = source.indexOf('    function ensureMediaRoute(element) {');
    const end = source.indexOf('    // Rate-limited fallback write shared', begin);
    assert.ok(begin > 0 && end > begin);
    const setup = source.slice(begin, end);
    assert.ok(setup.indexOf('connectNative(inputAnalyser, gain)') < setup.indexOf('createMediaRouteSource(context, element)'));
    assert.match(setup, /mediaRoutes\.set\(element, route\);\s*connectNative\(route\.source, inputAnalyser\)/);
    assert.match(setup, /route\.fallbackDirectOnly = true/);
    assert.match(source, /if \(route\.fallbackDirectOnly\) \{/);
    assert.match(source, /\(route\.limiterFallbackActive \|\| route\.fallbackDirectOnly\)/);
    assert.match(source, /clampUnprotectedOutput\(route\)/);
});

test('remembered profile rename preserves exact URL query and closed hotkeys never retarget tabs', () => {
    const options = readFileSync(join(root, 'options.js'), 'utf8');
    const background = readFileSync(join(root, 'background.js'), 'utf8');
    assert.match(options, /normalizeSiteSettingsEntryInput\(newDomain, \{ includeQuery: true \}\)/);
    const start = background.indexOf('async function getActiveTab(commandTab) {');
    const end = background.indexOf('async function getDomainState(tab)', start);
    assert.ok(start >= 0 && end > start);
    const fn = background.slice(start, end);
    assert.match(fn, /return null;/);
    assert.doesNotMatch(fn, /return commandTab/);
});

test('real-site probes trigger on engine changes and pull requests', () => {
    const workflow = readFileSync(join(root, '.github/workflows/real-sites.yml'), 'utf8');
    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /- 'page-audio-hook.js'/);
    assert.match(workflow, /- 'cs.js'/);
});

test('page bridge rejects incompatible and malformed control states', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(page, /data\.version !== BRIDGE_VERSION - 1/);
    assert.match(page, /Number\.isFinite\(data\.dB\)/);
});


test('popup serializes in-flight volume commands and applies the latest request last', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function setVolume(dB, tab, options = {}) {');
    const end = popup.indexOf('async function toggleMono(tab)', start);
    assert.ok(start >= 0 && end > start);
    assert.match(popup, /let volumeDeliveryChain = Promise\.resolve\(\)/);
    const sends = [];
    let currentVolume = 0;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const context = {
        volumeRequestGeneration: 0,
        volumeDeliveryChain: Promise.resolve(),
        setDisplayedVolume: v => v,
        normalizeDb: Number,
        tabsSendMessage: async (id, message) => {
            if (message.command === 'setVolume') {
                if (message.dB === -10) await delay(30);
                currentVolume = message.dB;
                sends.push(message.dB);
            }
            return { response: { volume: currentVolume, muted: false } };
        },
        TOP_FRAME_OPTIONS: { frameId: 0 },
        handleError: () => {},
        applyAudioControlState: () => {},
        cached: { muteBtn: null },
        runtimeSendMessage: async () => ({}),
        saveSiteSettings: async () => {}
    };
    const setVolume = runInNewContext('(' + popup.slice(start, end).trim() + ')', context);
    const first = setVolume(-10, { id: 1 }, { showFeedback: false });
    await delay(5);
    const last = setVolume(-20, { id: 1 }, { showFeedback: false });
    await Promise.all([first, last]);
    assert.equal(currentVolume, -20, 'late earlier message must not override latest slider input');
    assert.deepEqual(sends, [-10, -20]);
});


test('Remember writes use the currently navigated tab URL instead of popup open snapshot', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function currentTabUrl(tab) {');
    const end = popup.indexOf('function saveSiteSettings(tab)', start);
    assert.ok(start >= 0 && end > start);
    const changes = [];
    const ctx = {
        tabsGet: async id => ({ id, url: 'https://example.com/watch?track=next' }),
        document: { getElementById: id => id === 'remember-checkbox' ? { checked: true } : null },
        cached: {
            slider: { value: '-13' },
            monoCheckbox: { checked: false },
            muteBtn: { classList: { contains: () => false } }
        },
        normalizeSiteSettingsEntryInput: url => new URL(url).hostname + new URL(url).pathname,
        normalizeControlDb: value => Number(value),
        mutateSiteSettings: async mutation => { changes.push(mutation); },
        handleError: error => { throw error; }
    };
    runInNewContext(popup.slice(start, end) + '\nthis.saveCurrent = saveSiteSettingsNow;', ctx);
    await ctx.saveCurrent({ id: 4, url: 'https://example.com/watch?track=previous' });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].url, 'https://example.com/watch?track=next');
    assert.equal(changes[0].patch.volume, -13);
    assert.match(popup, /type: "setForUrl",\s*url,/);
    assert.match(popup, /type: "removeForUrl", url \}/);
});

test('cross-input debounce and invalid text edits cancel obsolete volume commits', () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const sliderInput = popup.indexOf('volumeSlider.addEventListener("input"');
    const textInput = popup.indexOf('volumeText.addEventListener("input"');
    assert.ok(sliderInput >= 0 && textInput >= 0);
    assert.match(popup.slice(sliderInput, sliderInput + 175), /cancelPendingTextCommit\(\)/);
    const section = popup.slice(textInput, textInput + 650);
    assert.match(section, /cancelPendingVolumeCommit\(\)/);
    assert.ok(section.indexOf('cancelPendingTextCommit()') < section.indexOf('if (parsed === null) return'),
        'clearing the input must cancel its old pending valid dB write');
});


test('failed first MediaElementSource connection keeps its source and restores a safe rescue route', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const ensureStart = page.indexOf('    function ensureMediaRoute(element) {');
    const ensureEnd = page.indexOf('    // Rate-limited fallback write shared', ensureStart);
    const wireStart = page.indexOf('    function wireMediaRoute(route) {');
    const wireEnd = page.indexOf('    function scheduleMediaRouteRecovery(element, route) {', wireStart);
    assert.ok(ensureStart > 0 && ensureEnd > ensureStart && wireStart > 0 && wireEnd > wireStart);

    const nodes = [];
    let inputAnalyser = null;
    const sourceNode = { tag: 'source' };
    const destination = { tag: 'destination' };
    const context = {
        destination,
        currentTime: 0,
        state: 'running',
        createGain: () => ({ gain: { value: 1 } }),
        createAnalyser: () => {
            const node = {};
            if (!inputAnalyser) inputAnalyser = node;
            return node;
        },
        createChannelSplitter: () => ({}),
        createChannelMerger: () => ({}),
        createDynamicsCompressor: () => ({})
    };
    const mediaRoutes = new Map();
    let captures = 0;
    let throwOnce = true;
    const connections = [];
    const connectNative = (from, to) => {
        if (from === sourceNode && to === inputAnalyser && throwOnce) {
            throwOnce = false;
            throw new Error('injected first connect failure');
        }
        connections.push([from, to]);
    };
    let fallbackInvoked = false;
    const ensure = runInNewContext('(' + page.slice(ensureStart, ensureEnd).trim() + ')', {
        mediaNeedsAudioRoute: () => true,
        isAudibleMediaElement: () => true,
        isLikelyDrmMedia: () => false,
        isLikelyCrossOriginMedia: () => false,
        mediaRoutes,
        getMediaContext: () => context,
        markNode: node => { nodes.push(node); return node; },
        createMediaRouteSource: () => {
            captures++;
            return { source: sourceNode, kind: 'mediaElement', muteNative: false };
        },
        connectNative,
        effectiveGain: () => 5,
        safeDisconnect: () => {},
        wireMediaRoute: () => { fallbackInvoked = true; },
        scheduleMediaRouteRecovery: () => {},
        log: () => {},
        getMediaSourceUrl: () => ''
    });
    const element = { tagName: 'AUDIO', currentSrc: 'sound.mp3' };
    const route = ensure(element);
    assert.ok(route);
    assert.equal(captures, 1);
    assert.equal(route.fallbackDirectOnly, true);
    assert.equal(fallbackInvoked, true);
    assert.equal(mediaRoutes.get(element), route);
    assert.equal(ensure(element), route);
    assert.equal(captures, 1, 'captured media element must never be captured twice');

    const wire = runInNewContext('(' + page.slice(wireStart, wireEnd).trim() + ')', {
        connectNative,
        clampUnprotectedOutput: r => {
            r.limiterFallbackActive = true;
            r.gain.gain.value = 1;
            return true;
        },
        resetMediaBoundaryGain: () => true,
        log: () => {}
    });
    // Earlier independent failures may have used up the retry budget.
    // Any eventual connection, including rescue-direct, must reset it.
    route.recoveryAttempts = 6;
    wire(route);
    assert.equal(route.outputConnected, true);
    assert.equal(route.sourceConnected, true);
    assert.equal(route.recoveryAttempts, 0, 'successful rescue replenishes the retry budget');
    assert.equal(route.gain.gain.value, 1, 'rescue output must not expose boost');
    assert.ok(connections.some(([from, to]) => from === sourceNode && to === route.gain));
    assert.ok(connections.some(([from, to]) => from === route.gain && to === destination));
});


test('rapid mute toggles keep final state and suppress older async UI replies', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function toggleMute(tab, muted) {');
    const end = popup.indexOf('async function toggleRemember(tab) {', start);
    assert.ok(start >= 0 && end > start);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const states = [];
    const deliveries = [];
    const saved = [];
    let activeMute = false;
    const context = {
        muteRequestGeneration: 0,
        muteDeliveryChain: Promise.resolve(),
        applyMuteButtonState: muted => states.push(Boolean(muted)),
        tabsSendMessage: async (_tabId, message) => {
            if (message.command === 'setMute') {
                if (message.muted) await delay(30);
                activeMute = message.muted;
                deliveries.push(activeMute);
            }
            return { response: { muted: activeMute, volume: -12 } };
        },
        TOP_FRAME_OPTIONS: { frameId: 0 },
        handleError: e => { throw e; },
        applyAudioControlState: () => {},
        cached: { slider: { value: -12 } },
        runtimeSendMessage: () => Promise.resolve(),
        saveSiteSettings: async () => { saved.push(activeMute); }
    };
    const fn = runInNewContext('(' + popup.slice(start, end).trim() + ')', context);
    const first = fn({ id: 3 }, true);
    await delay(3);
    const second = fn({ id: 3 }, false);
    await Promise.all([first, second]);
    assert.equal(activeMute, false);
    assert.equal(states.at(-1), false);
    assert.deepEqual(deliveries, [true, false]);
    assert.deepEqual(saved, [false]);
});

test('rapid mono toggles deliver in order and do not save stale state', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function toggleMono(tab) {');
    const end = popup.indexOf('async function toggleNormalizer(tab) {', start);
    assert.ok(start >= 0 && end > start);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const checkbox = { checked: true, disabled: false };
    const delivered = [];
    let currentMono = false;
    const saved = [];
    const context = {
        monoRequestGeneration: 0,
        monoDeliveryChain: Promise.resolve(),
        cached: { monoCheckbox: checkbox, monoAvailable: true },
        document: { querySelector: () => checkbox },
        tabsSendMessage: async (_tabId, message) => {
            if (message.mono) await delay(30);
            currentMono = message.mono;
            delivered.push(currentMono);
        },
        handleError: e => { throw e; },
        saveSiteSettings: async () => { saved.push(currentMono); }
    };
    const fn = runInNewContext('(' + popup.slice(start, end).trim() + ')', context);
    const first = fn({ id: 3 });
    await delay(3);
    checkbox.checked = false;
    const second = fn({ id: 3 });
    await Promise.all([first, second]);
    assert.equal(currentMono, false);
    assert.deepEqual(delivered, [true, false]);
    assert.deepEqual(saved, [false]);
});


test('rapid Normalize toggles serialize storage and cannot leave stale enabled state', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function toggleNormalizer(tab) {');
    const end = popup.indexOf('async function toggleMute(tab, muted) {', start);
    assert.ok(start >= 0 && end > start);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const checkbox = { checked: true, disabled: false };
    const delivered = [];
    const saved = [];
    let effective = false;
    const sandbox = {
        cached: { normalizerCheckbox: checkbox, normalizerPending: false },
        normalizerRequestGeneration: 0,
        normalizerDeliveryChain: Promise.resolve(),
        document: { querySelector: () => checkbox },
        applyNormalizerState: ({ normalizerEnabled }) => { checkbox.checked = Boolean(normalizerEnabled); },
        currentTabUrl: async tab => tab.url,
        normalizeSiteSettingsEntryInput: () => 'example.com/video',
        mutateSiteNormalizerSettings: async mutation => {
            if (mutation.enabled) await delay(30);
            effective = mutation.enabled;
            saved.push(effective);
            return { ok: true };
        },
        tabsSendMessage: async (_id, msg) => { delivered.push(msg.enabled); },
        TOP_FRAME_OPTIONS: { frameId: 0 },
        refreshAudioControlState: async () => {},
        handleError: e => { throw e; }
    };
    const fn = runInNewContext('(' + popup.slice(start, end).trim() + ')', sandbox);
    const first = fn({ id: 1, url: 'https://example.com/video' });
    await delay(3);
    checkbox.checked = false;
    const second = fn({ id: 1, url: 'https://example.com/video' });
    await Promise.all([first, second]);
    assert.equal(effective, false, 'latest preference must persist');
    assert.deepEqual(saved, [true, false]);
    assert.deepEqual(delivered, [false], 'obsolete ON message must not follow OFF');
    assert.equal(checkbox.checked, false);
    assert.equal(sandbox.cached.normalizerPending, false);
});


test('Remember-off waits for an in-flight profile write so it cannot be recreated', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function toggleRemember(tab) {');
    const end = popup.indexOf('function showError(error) {', start);
    assert.ok(start >= 0 && end > start);
    let resolveOldSave;
    const oldSave = new Promise(resolve => { resolveOldSave = resolve; });
    const checkbox = { checked: false };
    const removed = [];
    const context = {
        rememberRequestGeneration: 0,
        rememberDeliveryChain: Promise.resolve(),
        siteSettingsSaveChain: oldSave,
        cached: { rememberUrl: 'https://example.com/watch?track=two' },
        document: { getElementById: () => checkbox },
        currentTabUrl: async () => 'https://example.com/watch?track=two',
        normalizeSiteSettingsEntryInput: () => 'example.com/watch',
        saveSiteSettings: async () => {},
        mutateSiteSettings: async mutation => { removed.push(mutation); },
        handleError: e => { throw e; }
    };
    const toggle = runInNewContext('(' + popup.slice(start, end).trim() + ')', context);
    const removing = toggle({ id: 4 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(removed.length, 0, 'remove must wait for earlier pending save');
    resolveOldSave();
    await removing;
    assert.equal(removed.length, 1);
    assert.equal(removed[0].type, 'removeForUrl');
    assert.equal(removed[0].url, 'https://example.com/watch?track=two');
});

test('rapid Remember on-off preserves the most recent choice despite slow saving', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function toggleRemember(tab) {');
    const end = popup.indexOf('function showError(error) {', start);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const checkbox = { checked: true };
    const mutations = [];
    const context = {
        rememberRequestGeneration: 0,
        rememberDeliveryChain: Promise.resolve(),
        siteSettingsSaveChain: Promise.resolve(),
        cached: { rememberUrl: 'https://example.com/watch' },
        document: { getElementById: () => checkbox },
        currentTabUrl: async () => 'https://example.com/watch',
        normalizeSiteSettingsEntryInput: () => 'example.com/watch',
        saveSiteSettings: async () => { await delay(30); mutations.push('enable'); },
        mutateSiteSettings: async mutation => { mutations.push(mutation.type); },
        handleError: e => { throw e; }
    };
    const toggle = runInNewContext('(' + popup.slice(start, end).trim() + ')', context);
    const on = toggle({ id: 4 });
    await delay(5);
    checkbox.checked = false;
    const off = toggle({ id: 4 });
    await Promise.all([on, off]);
    assert.deepEqual(mutations, ['enable', 'removeForUrl']);
});


test('cross-origin media rejection does not allocate an unnecessary AudioContext', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = page.indexOf('    function ensureMediaRoute(element) {');
    const end = page.indexOf('    // Rate-limited fallback write shared', begin);
    assert.ok(begin > 0 && end > begin);
    let allocations = 0;
    const ensure = runInNewContext('(' + page.slice(begin, end).trim() + ')', {
        mediaNeedsAudioRoute: () => true,
        isAudibleMediaElement: () => true,
        isLikelyDrmMedia: () => false,
        isLikelyCrossOriginMedia: () => true,
        mediaRoutes: new Map(),
        getMediaContext: () => { allocations++; return {}; },
        log: () => {}
    });
    assert.equal(ensure({ tagName: 'AUDIO', src: 'https://other.example/audio.mp3' }), null);
    assert.equal(allocations, 0, 'unsupported media must not start a WebAudio context');
});


test('isolated captured media source recovers from analyser connect failure without unsafe gain', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function reconnectIsolatedCapturedSource(element) {');
    const end = content.indexOf('function scheduleIsolatedCapturedSourceRetry(element) {', begin);
    assert.ok(begin >= 0 && end > begin);
    const calls = [];
    const element = { dataset: { vcFallback: 'true' } };
    const analyser = { kind: 'analyser' };
    const gainParam = {
        value: 11,
        cancelScheduledValues(now) { calls.push(['cancel', now]); },
        setValueAtTime(value, now) { this.value = value; calls.push(['clamp', value, now]); }
    };
    const gain = { gain: gainParam };
    const source = {
        connect(to) {
            if (to === analyser) throw new Error('Injected input analyser failure');
            calls.push(['connect', to, gainParam.value]);
        }
    };
    const captured = { source, connected: false, bypassInputAnalyser: false };
    const sandbox = {
        tc: { vars: {
            capturedMediaSources: new WeakMap([[element, captured]]),
            audioCtx: { currentTime: 5, state: 'running' },
            inputAnalyserNode: analyser,
            gainNode: gain, dB: 24, muted: false, isBlocked: false
        }, settings: { debugMode: false } },
        getGainValue: db => 10 ** (db / 20),
        invalidateBoostLimitCache: () => {},
        clearFallbackVolume: () => { calls.push(['clearFallback']); },
        log: () => {}
    };
    const reconnect = runInNewContext('(' + content.slice(begin, end).trim() + ')', sandbox);
    assert.equal(reconnect(element), true);
    assert.equal(captured.connected, true);
    assert.equal(captured.bypassInputAnalyser, true);
    assert.equal(gainParam.value, 1);
    assert.equal(calls.filter(c => c[0] === 'connect').length, 1);
    assert.equal(calls.find(c => c[0] === 'connect')[2], 1, 'never expose +24 dB on bypass before gain clamp');
    assert.equal(reconnect(element), true);
    assert.equal(calls.filter(c => c[0] === 'connect').length, 1, 'successful source must not reconnect twice');
});

test('isolated captured source retries original node after both initial connect routes fail', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function reconnectIsolatedCapturedSource(element) {');
    const end = content.indexOf('function scheduleIsolatedCapturedSourceRetry(element) {', begin);
    const element = { dataset: {} };
    let attempts = 0;
    let failures = 2;
    const source = { connect: () => { attempts++; if (failures-- > 0) throw Error('temporary node failure'); } };
    const captured = { source, connected: false };
    const sandbox = {
        tc: { vars: {
            capturedMediaSources: new WeakMap([[element, captured]]),
            audioCtx: { currentTime: 5, state: 'running' },
            inputAnalyserNode: {},
            gainNode: { gain: { cancelScheduledValues: () => {}, setValueAtTime: () => {} } },
            dB: -12, muted: false, isBlocked: false
        }, settings: { debugMode: false } },
        getGainValue: db => 10 ** (db / 20),
        invalidateBoostLimitCache: () => {},
        clearFallbackVolume: () => {},
        log: () => {}
    };
    const reconnect = runInNewContext('(' + content.slice(begin, end).trim() + ')', sandbox);
    assert.equal(reconnect(element), false);
    assert.equal(captured.connected, false);
    assert.equal(element.dataset.vcFallbackReason, 'route-failed');
    assert.equal(reconnect(element), true);
    assert.equal(attempts, 3);
    assert.equal(captured.connected, true);
    assert.equal(element.dataset.vcFallbackReason, undefined);
    assert.match(content, /capturedMediaSources\.set\(element,\s*\{/);
    assert.match(content, /element\.dataset\.vcHooked = "true";\s*tc\.vars\.mediaElements\.add\(element\);\s*const sourceConnected = reconnectIsolatedCapturedSource\(element\)/);
});


test('isolated captured source retries a bounded number of times without a new play event', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function scheduleIsolatedCapturedSourceRetry(element) {');
    const end = content.indexOf('function connectOutput(element) {', begin);
    assert.ok(begin > 0 && end > begin);
    const element = { dataset: {}, paused: false, ended: false };
    const captured = { connected: false, retryCount: 0, retryTimer: null };
    const tasks = [];
    let success = false;
    let applied = 0;
    let resumed = 0;
    const ctx = {
        tc: { vars: {
            capturedMediaSources: new WeakMap([[element, captured]]),
            audioCtx: { state: 'suspended' }
        } },
        setTimeout: cb => { tasks.push(cb); return tasks.length; },
        reconnectIsolatedCapturedSource: () => {
            if (!success) return false;
            captured.connected = true;
            return true;
        },
        resumeAudioContext: () => { resumed++; },
        applyState: () => { applied++; },
        isMediaPlaying: element => !element.paused && !element.ended
    };
    const schedule = runInNewContext('(' + content.slice(begin, end).trim() + ')', ctx);
    schedule(element);
    schedule(element);
    assert.equal(tasks.length, 1, 'a repeated event must not duplicate a scheduled retry');
    tasks.shift()();
    assert.equal(captured.retryCount, 1);
    assert.equal(tasks.length, 1);
    success = true;
    tasks.shift()();
    assert.equal(captured.connected, true);
    assert.equal(applied, 1);
    assert.equal(resumed, 1);
    assert.equal(tasks.length, 0);
    schedule(element);
    assert.equal(tasks.length, 0, 'recovered elements need no more retries');
    assert.match(content, /if \(!sourceConnected\) scheduleIsolatedCapturedSourceRetry\(element\)/);
});


test('popup startup fallback cannot overwrite live edits or create an extra volume request', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    assert.match(source, /let volumeEditGeneration = 0/);
    assert.match(source, /volumeGenerationAtRequest === volumeRequestGeneration &&\s*volumeEditGenerationAtRequest === volumeEditGeneration/);
    const init = source.slice(source.indexOf('async function initializeControls(tab) {'));
    assert.match(init, /const initialEditGeneration = volumeEditGeneration/);
    assert.match(init, /volumeSlider\.addEventListener\("input", \(\) => \{\s*volumeEditGeneration\+\+/);
    assert.match(init, /volumeText\.addEventListener\("input", \(\) => \{\s*volumeEditGeneration\+\+/);
    const fallbackBegin = init.indexOf('tabsSendMessage(tab.id, { command: "getVolume" }');
    const fallbackEnd = init.indexOf('tabsSendMessage(tab.id, { command: "getMono" }', fallbackBegin);
    assert.ok(fallbackBegin >= 0 && fallbackEnd > fallbackBegin);
    const fallback = init.slice(fallbackBegin, fallbackEnd);
    assert.match(fallback, /editGeneration === volumeEditGeneration/);
    assert.match(fallback, /volumeGeneration === volumeRequestGeneration/);
    assert.match(fallback, /setDisplayedVolume\(response.response\)/);
    assert.doesNotMatch(fallback, /setVolume\(response.response, null\)/);
});

test('popup startup ignores stale Remember mono and mute snapshots', () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const init = source.slice(source.indexOf('async function initializeControls(tab) {'));
    assert.match(init, /initialRememberGeneration === rememberRequestGeneration/);
    assert.match(init, /initialMonoGeneration === monoRequestGeneration && !cached\.monoPending/);
    assert.match(init, /initialMuteGeneration === muteRequestGeneration && !cached\.mutePending/);
    assert.match(init, /monoGeneration === monoRequestGeneration && !cached\.monoPending/);
    assert.match(init, /muteGeneration === muteRequestGeneration && !cached\.mutePending/);
});


test('closed AudioContext invalidates even previously connected isolated captured sources', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = content.indexOf('function reconnectIsolatedCapturedSource(element) {');
    const end = content.indexOf('function scheduleIsolatedCapturedSourceRetry(element) {', start);
    assert.ok(start >= 0 && end > start);
    const element = { dataset: {} };
    const captured = { connected: true, source: {} };
    let invalidations = 0;
    const reconnect = runInNewContext('(' + content.slice(start, end).trim() + ')', {
        tc: { vars: {
            capturedMediaSources: new WeakMap([[element, captured]]),
            audioCtx: { state: 'closed' }
        } },
        invalidateBoostLimitCache: () => { invalidations++; }
    });
    assert.equal(reconnect(element), false);
    assert.equal(element.dataset.vcFallbackReason, 'route-failed');
    assert.equal(invalidations, 1);
});


test('queued hotkeys without an event tab keep their original tab through a tab switch', async () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    const begin = source.indexOf('async function enqueueCommand(command, commandTab) {');
    const end = source.indexOf('async function getActiveTab(commandTab) {', begin);
    assert.ok(begin >= 0 && end > begin);
    const seen = [];
    let active = { id: 1 };
    const ctx = {
        commandChains: new Map(),
        getActiveTab: async () => ({ ...active }),
        handleCommand: async (command, tab) => {
            seen.push([command, tab.id]);
            if (command === 'first') await new Promise(resolve => setTimeout(resolve, 15));
        }
    };
    const enqueue = runInNewContext('(' + source.slice(begin, end).trim() + ')', ctx);
    const first = enqueue('first');
    const second = enqueue('second');
    // Resolve both command-event tab snapshots before the simulated switch.
    // The first command still remains in flight while the second is queued.
    await Promise.resolve();
    await Promise.resolve();
    active = { id: 2 };
    const third = enqueue('third');
    await Promise.all([first, second, third]);
    assert.deepEqual(seen.filter(x => x[0] !== 'third').map(x => x[1]), [1, 1]);
    assert.equal(seen.find(x => x[0] === 'third')[1], 2);
});


test('isolated gain chain construction is transactional and retries after an allocator failure', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = source.indexOf('function createGainNode() {');
    const end = source.indexOf('function isMediaPlaying(element) {', begin);
    assert.ok(begin >= 0 && end > begin);
    const nodes = [];
    let failCompressor = true;
    const create = kind => {
        const node = {
            kind,
            disconnectCount: 0,
            disconnect() { this.disconnectCount++; },
            connect() {}
        };
        nodes.push(node);
        return node;
    };
    let applyCalls = 0;
    let meterCalls = 0;
    const sandbox = {
        tc: {
            vars: {
                audioCtx: {
                    state: 'running',
                    createGain: () => create('gain'),
                    createAnalyser: () => create('analyser'),
                    createDynamicsCompressor: () => {
                        if (failCompressor) throw Error('injected compressor allocation failure');
                        return create('limiter');
                    }
                }
            },
            settings: { debugMode: false }
        },
        applyState: () => { applyCalls++; },
        ensureIsolatedNormalizerTimer: () => { meterCalls++; },
        log: () => {}
    };
    const createGainNode = runInNewContext('(' + source.slice(begin, end).trim() + ')', sandbox);
    assert.equal(createGainNode(), false);
    assert.equal(sandbox.tc.vars.gainNode, undefined,
        'failed intermediate allocation must not publish an incomplete gain graph');
    assert.equal(applyCalls, 0);
    assert.equal(nodes[0].disconnectCount, 1);
    assert.equal(nodes[1].disconnectCount, 1);

    failCompressor = false;
    assert.equal(createGainNode(), true);
    assert.ok(sandbox.tc.vars.gainNode);
    assert.ok(sandbox.tc.vars.inputAnalyserNode);
    assert.ok(sandbox.tc.vars.limiterNode);
    assert.ok(sandbox.tc.vars.analyserNode);
    assert.equal(applyCalls, 1);
    assert.equal(meterCalls, 1);
    assert.equal(createGainNode(), true);
    assert.equal(applyCalls, 2);
    assert.equal(meterCalls, 1, 'successful creation is not repeated');

    assert.match(source, /if \(!tc\.vars\.gainNode && !createGainNode\(\)\) \{\s*[\s\S]*?applyFallbackVolume\(element, "route-failed"\);\s*return;/);
});


test('page-world captured source retries connection failures without a new media event', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = source.indexOf('    function scheduleMediaRouteRecovery(element, route) {');
    const end = source.indexOf('    function ensureMediaRoute(element) {', begin);
    assert.ok(begin >= 0 && end > begin);

    const element = { tagName: 'AUDIO' };
    const route = { context: { state: 'running' }, outputConnected: false };
    const routes = new Map([[element, route]]);
    const tasks = [];
    let reconnectCalls = 0;
    let resumed = 0;
    const schedule = runInNewContext('(' + source.slice(begin, end).trim() + ')', {
        mediaRoutes: routes,
        setTimeout: (callback, ms) => {
            assert.equal(ms, 250);
            tasks.push(callback);
            return tasks.length;
        },
        wireMediaRoute: current => {
            reconnectCalls++;
            if (reconnectCalls === 2) current.outputConnected = true;
        },
        resumeContext: () => { resumed++; },
        isMediaPlaying: () => true
    });
    schedule(element, route);
    schedule(element, route);
    assert.equal(tasks.length, 1, 'one retry timer per captured source');
    tasks.shift()();
    assert.equal(reconnectCalls, 1);
    assert.equal(tasks.length, 1, 'retry after the first transient failure');
    tasks.shift()();
    assert.equal(reconnectCalls, 2);
    assert.equal(route.outputConnected, true);
    assert.equal(resumed, 1);
    assert.equal(tasks.length, 0);
    assert.equal(route.recoveryAttempts, 0);
});

test('page-world media route retries stop when the capture is released or retry limit is reached', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = source.indexOf('    function scheduleMediaRouteRecovery(element, route) {');
    const end = source.indexOf('    function ensureMediaRoute(element) {', begin);
    const element = {};
    const route = { context: { state: 'running' }, outputConnected: false };
    const routes = new Map([[element, route]]);
    const pending = [];
    let attempts = 0;
    const schedule = runInNewContext('(' + source.slice(begin, end).trim() + ')', {
        mediaRoutes: routes,
        setTimeout: fn => { pending.push(fn); return pending.length; },
        wireMediaRoute: () => { attempts++; },
        resumeContext: () => {},
        isMediaPlaying: () => false
    });
    schedule(element, route);
    for (let i = 0; i < 6; i++) {
        assert.equal(pending.length, 1);
        pending.shift()();
    }
    assert.equal(attempts, 6);
    assert.equal(pending.length, 0, 'bounded recovery must not run forever');

    route.recoveryAttempts = 0;
    schedule(element, route);
    assert.equal(pending.length, 1);
    routes.delete(element);
    pending.shift()();
    assert.equal(attempts, 6, 'released sources must not reconnect');
    assert.match(source, /cancelMediaRouteRecovery\(route\);\s*disconnectMediaRouteOutput\(route\)/);
});


test('page-world route recovery does not wake AudioContext for paused media', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = source.indexOf('    function scheduleMediaRouteRecovery(element, route) {');
    const end = source.indexOf('    function ensureMediaRoute(element) {', begin);
    const element = { paused: true };
    const route = { context: { state: 'suspended' }, outputConnected: false };
    const timers = [];
    let resumes = 0;
    const schedule = runInNewContext('(' + source.slice(begin, end).trim() + ')', {
        mediaRoutes: new Map([[element, route]]),
        setTimeout: fn => { timers.push(fn); return timers.length; },
        wireMediaRoute: current => { current.outputConnected = true; },
        resumeContext: () => { resumes++; },
        isMediaPlaying: () => false
    });
    schedule(element, route);
    timers.shift()();
    assert.equal(route.outputConnected, true);
    assert.equal(resumes, 0, 'paused media must not reactivate its audio device');
});


test('isolated captured-source retry does not resume the audio device when playback paused', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function scheduleIsolatedCapturedSourceRetry(element) {');
    const end = content.indexOf('function connectOutput(element) {', begin);
    assert.ok(begin > 0 && end > begin);
    const element = { paused: true, ended: false };
    const captured = { connected: false, retryCount: 0, retryTimer: null };
    let task;
    let resumes = 0;
    let updates = 0;
    const schedule = runInNewContext('(' + content.slice(begin, end).trim() + ')', {
        tc: { vars: { capturedMediaSources: new WeakMap([[element, captured]]),
            audioCtx: { state: 'suspended' } } },
        setTimeout: callback => { task = callback; return 1; },
        reconnectIsolatedCapturedSource: () => { captured.connected = true; return true; },
        isMediaPlaying: current => !current.paused && !current.ended,
        resumeAudioContext: () => { resumes++; },
        applyState: () => { updates++; }
    });
    schedule(element);
    task();
    assert.equal(captured.connected, true);
    assert.equal(resumes, 0, 'a paused element must not wake Bluetooth or OS output');
    assert.equal(updates, 1);
});


test('hotkey retries and remembered writes do not cross SPA/tab navigation', async () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    const start = source.indexOf('async function isOriginalTabPage(tab) {');
    const end = source.indexOf('async function setVolume(tab, domainState, dB) {', start);
    assert.ok(start >= 0 && end > start);

    const originalUrl = 'https://example.com/watch?id=one';
    const nextUrl = 'https://example.com/watch?id=two';
    let liveUrl = originalUrl;
    const delivered = [];
    const saved = [];
    const sandbox = {
        tabsGet: async () => ({ id: 42, url: liveUrl }),
        tabsSendMessage: async (_id, message) => {
            delivered.push(message.command);
            if (message.command === 'getAudioControlState') {
                liveUrl = nextUrl; // playlist advanced while hotkey was waiting
                return { response: { volume: 8, muted: false } };
            }
            return {};
        },
        TOP_FRAME_OPTIONS: { frameId: 0 },
        HOTKEY_DELIVERY_RETRY_MS: 5,
        normalizeDb: v => Number(v),
        mutateSiteSettings: async mutation => { saved.push(mutation); },
        handleError: error => { throw error; }
    };
    runInNewContext(source.slice(start, end) +
        '\nthis.helpers = {isOriginalTabPage, sendHotkeyCommandAndConfirm, saveRememberedSettings};', sandbox);
    const tab = { id: 42, url: originalUrl };
    const response = await sandbox.helpers.sendHotkeyCommandAndConfirm(tab,
        { command: 'setVolume', dB: 8 });
    assert.equal(response, null, 'navigation must invalidate the confirmation');
    assert.deepEqual(delivered, ['setVolume', 'getAudioControlState'],
        'new page must not receive another stale hotkey attempt');

    const domainState = { settingsKey: 'example.com/watch', siteSettings: {} };
    await sandbox.helpers.saveRememberedSettings(tab, domainState, { volume: 8 });
    assert.equal(saved.length, 0, 'old page profile cannot be saved after navigation');

    liveUrl = originalUrl;
    await sandbox.helpers.saveRememberedSettings(tab, domainState, { volume: 8 });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].key, domainState.settingsKey);
    assert.equal(saved[0].patch.volume, 8);
});


test('rejected srcObject replacement preserves the existing MediaStream audio route', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const match = source.match(/set: (function patchedSrcObjectSetter\(value\) \{[\s\S]*?\r?\n                \})\r?\n            \}\);/);
    assert.ok(match, 'MAIN-world patched srcObject setter must be present');
    const oldStream = { id: 'old' };
    const nextStream = { id: 'next' };
    const element = { stream: oldStream };
    let routesReset = 0;
    let listenersUpdated = 0;
    let elementsRegistered = 0;
    const nativeSrcObjectDescriptor = {
        set(value) {
            if (value === 'not a MediaStream') throw new TypeError('Invalid srcObject');
            this.stream = value;
        }
    };
    const setter = runInNewContext('(' + match[1] + ')', {
        nativeSrcObjectDescriptor,
        readMediaSrcObject: current => current.stream,
        resetDirectMediaStreamRoute: () => { routesReset++; },
        bindMediaStreamLifecycle: () => { listenersUpdated++; },
        registerMediaElement: () => { elementsRegistered++; },
        isMediaStreamLike: value => typeof value === 'object' && value !== null,
        log: () => {}
    });
    assert.throws(() => setter.call(element, 'not a MediaStream'), /Invalid srcObject/);
    assert.equal(element.stream, oldStream);
    assert.equal(routesReset, 0, 'failed setter must preserve the already audible route');
    assert.equal(listenersUpdated, 0);

    setter.call(element, oldStream);
    assert.equal(routesReset, 0, 'reassigning the same stream must not interrupt playback');

    setter.call(element, nextStream);
    assert.equal(element.stream, nextStream);
    assert.equal(routesReset, 1, 'successful source switch invalidates old capture once');
    assert.equal(listenersUpdated, 2);
    assert.equal(elementsRegistered, 2);
});


test('high resolution trackpad wheel deltas accumulate without multiplying normal wheel steps', () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const begin = popup.indexOf('  let wheelRemainder = 0;');
    const end = popup.indexOf('  refreshShortcutHints()', begin);
    assert.ok(begin > 0 && end > begin);
    const calls = [];
    const eventHandlers = {};
    const cached = { activeTab: { id: 1 }, slider: { value: '0' } };
    const document = {
        activeElement: { id: '' },
        addEventListener: (name, fn) => { eventHandlers[name] = fn; }
    };
    runInNewContext(popup.slice(begin, end), {
        document, cached,
        WHEEL_STEP_DB: 1,
        normalizeDb: value => Math.max(-32, Math.min(32, value)),
        setVolume: (value, tab) => {
            calls.push({ value, id: tab.id });
            cached.slider.value = String(value);
        }
    });
    const wheel = (deltaY, deltaMode = 0) => {
        let prevented = false;
        eventHandlers.wheel({
            deltaY, deltaMode,
            preventDefault: () => { prevented = true; }
        });
        return prevented;
    };
    assert.equal(wheel(5), false);
    assert.equal(wheel(5), false);
    assert.equal(wheel(5), true, 'three 5px trackpad deltas should make one step');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].value, -1);
    assert.equal(wheel(120), true);
    assert.equal(calls.length, 2, 'one ordinary wheel event still makes only one step');
    assert.equal(calls[1].value, -2);
    assert.equal(wheel(1, 1), true, 'line-mode wheel deltas must count as notches');
    assert.equal(calls[2].value, -3);
    document.activeElement.id = 'volume-text';
    assert.equal(wheel(-120), false);
    assert.equal(calls.length, 3);
});


test('remembered-site volume editor preserves cleared values and commits change/blur once', () => {
    const source = readFileSync(join(root, 'options.js'), 'utf8');
    const begin = source.indexOf("    volInput.addEventListener('input', () => {");
    const end = source.indexOf("    volInput.addEventListener('blur', commitVol);", begin);
    assert.ok(begin > 0 && end > begin);
    const listeners = {};
    const updates = [];
    const volumeField = {
        value: '12',
        dataset: { numericValue: '12' },
        addEventListener: (name, cb) => { listeners[name] = cb; }
    };
    const sandbox = {
        volInput: volumeField,
        initialVol: 12,
        normalizeDb: n => Math.max(-32, Math.min(32, Number(n))),
        formatDb: n => (n >= 0 ? '+' : '') + n + ' dB',
        monoCheckbox: { checked: false },
        muteCheckbox: { checked: false },
        onUpdate: (key, patch) => { updates.push({ key, patch }); },
        domain: 'example.com/watch'
    };
    const commit = runInNewContext(
        '(function() {\n' + source.slice(begin, end) + '\nreturn commitVol; })()', sandbox
    );
    volumeField.value = '';
    listeners.input();
    assert.equal(volumeField.dataset.numericValue, '12',
        'clearing the text field must not convert empty input to 0 dB');
    commit();
    assert.equal(volumeField.value, '+12 dB');
    assert.equal(updates.length, 0);

    // A half-written number must not become the fallback after it is erased.
    volumeField.value = '19';
    listeners.input();
    volumeField.value = '';
    listeners.input();
    commit();
    assert.equal(volumeField.value, '+12 dB');
    assert.equal(updates.length, 0);

    volumeField.value = '5';
    listeners.input();
    commit();
    commit();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].patch.volume, 5);
    volumeField.value = '-';
    listeners.input();
    commit();
    assert.equal(updates.length, 1, 'an incomplete negative number must preserve the last valid volume');
    assert.equal(volumeField.value, '+5 dB');
});


test('closed direct MediaStream routes rebuild on a fresh AudioContext without recapturing element', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = page.indexOf('    function ensureMediaRoute(element) {');
    const end = page.indexOf('    // Rate-limited fallback write shared', start);
    assert.ok(start >= 0 && end > start);
    const setup = page.slice(start, end);
    const element = { tagName: 'AUDIO', src: '' };
    const oldRoute = { sourceKind: 'mediaStream', context: { state: 'closed' }, outputConnected: false };
    const mediaRoutes = new Map([[element, oldRoute]]);
    let resetCount = 0;
    let newSources = 0;
    let contexts = 0;
    const context = {
        state: 'running', currentTime: 0,
        createGain: () => ({ gain: { value: 1 } }),
        createAnalyser: () => ({}),
        createChannelSplitter: () => ({}),
        createChannelMerger: () => ({}),
        createDynamicsCompressor: () => ({})
    };
    const sandbox = {
        mediaRoutes,
        mediaNeedsAudioRoute: () => true,
        isAudibleMediaElement: () => true,
        isLikelyDrmMedia: () => false,
        isLikelyCrossOriginMedia: () => false,
        resetDirectMediaStreamRoute: media => {
            assert.equal(media, element);
            resetCount++;
            mediaRoutes.delete(media);
        },
        getMediaContext: () => { contexts++; return context; },
        markNode: n => n,
        createMediaRouteSource: () => {
            newSources++;
            return { source: {}, kind: 'mediaStream', muteNative: true, stream: {} };
        },
        connectNative: () => {},
        effectiveGain: () => 2,
        getMediaSourceUrl: () => '',
        log: () => {}
    };
    const ensure = runInNewContext('(' + setup.trim() + ')', sandbox);
    const fresh = ensure(element);
    assert.notEqual(fresh, oldRoute);
    assert.equal(mediaRoutes.get(element), fresh);
    assert.equal(fresh.sourceKind, 'mediaStream');
    assert.equal(resetCount, 1);
    assert.equal(contexts, 1);
    assert.equal(newSources, 1);

    mediaRoutes.set(element, { sourceKind: 'mediaElement', context: { state: 'closed' } });
    assert.equal(ensure(element), mediaRoutes.get(element),
        'an irreversible MediaElementSource must remain owned, even if its context died');
    assert.equal(resetCount, 1);
    assert.equal(newSources, 1);
    const applyBegin = page.indexOf('    function applyMediaElementState(element, options = {}) {');
    const applyEnd = page.indexOf('    function detachMediaElementListeners(element) {', applyBegin);
    const apply = page.slice(applyBegin, applyEnd);
    assert.match(apply, /previousRoute.sourceKind === "mediaStream"[\s\S]*?resetDirectMediaStreamRoute\(element\);[\s\S]*?const existingRoute = mediaRoutes.get\(element\)/);
});


test('detached paused captured media wakes without a strong tracking-set reference', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const start = source.indexOf('    function cleanupTrackedMediaElement(element) {');
    const end = source.indexOf('    // Returns true if an element that was removed', start);
    assert.ok(start >= 0 && end > start);
    const callbacks = {};
    let registered = 0;
    let disconnected = 0;
    const element = {
        isConnected: false, paused: true,
        addEventListener: (name, fn) => { callbacks[name] = fn; },
        removeEventListener: (name, fn) => {
            if (callbacks[name] === fn) delete callbacks[name];
        }
    };
    const entry = { listenersInstalled: true, fallbackCorrectionTimer: null };
    const route = { outputConnected: true };
    const tracking = new Set([element]);
    const context = {
        mediaState: new WeakMap([[element, entry]]),
        mediaRoutes: new WeakMap([[element, route]]),
        mediaElements: tracking,
        detachMediaElementListeners: () => { entry.listenersInstalled = false; },
        cancelMediaRouteRecovery: () => {},
        disconnectMediaRouteOutput: r => { disconnected++; r.outputConnected = false; },
        registerMediaElement: () => { registered++; },
        clearTimeout: () => {}
    };
    const cleanup = runInNewContext('(' + source.slice(start, end).trim() + ')', context);
    cleanup(element);
    assert.equal(tracking.has(element), false, 'idle detached elements must not stay strongly tracked');
    assert.equal(typeof callbacks.play, 'function', 'captured elements retain a one-shot play wake');
    assert.equal(disconnected, 1);
    cleanup(element);
    assert.equal(typeof callbacks.play, 'function');
    callbacks.play();
    assert.equal(registered, 1);
    assert.equal(entry.detachedPlayWake, null);
    assert.equal(callbacks.play, undefined);
    const registerStart = source.indexOf('    function registerMediaElement(element, options = {}) {');
    const registerEnd = source.indexOf('    function scanMediaElements(root) {', registerStart);
    assert.match(source.slice(registerStart, registerEnd),
        /if \(entry\.detachedPlayWake\) \{[\s\S]*?removeEventListener\("play", entry\.detachedPlayWake\)/);
});


test('queued hotkeys cannot switch to a newly navigated URL in the same tab', async () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    const start = source.indexOf('async function getActiveTab(commandTab) {');
    const end = source.indexOf('async function getDomainState(tab) {', start);
    assert.ok(start >= 0 && end > start);
    let liveUrl = 'https://example.com/watch?v=old';
    const fn = runInNewContext('(' + source.slice(start, end).trim() + ')', {
        tabsGet: async id => ({ id, url: liveUrl }),
        tabsQuery: async () => [{ id: 4, url: liveUrl }]
    });
    const initial = { id: 4, url: liveUrl };
    assert.equal((await fn(initial)).url, initial.url);
    liveUrl = 'https://example.com/watch?v=new';
    assert.equal(await fn(initial), null, 'a queued hotkey must not target a later playlist item');
    assert.equal((await fn(null)).url, liveUrl, 'a new command without an origin may resolve the current tab');
    assert.equal(await fn({ id: 4, url: 'https://example.com/unrelated' }), null);
});


test('temporary route restrictions clamp effective gain without forgetting the requested boost', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = source.indexOf('function enforceBoostLimit(options = {}) {');
    const end = source.indexOf('function applyFallbackVolume(element, reason = "") {', begin);
    assert.ok(begin >= 0 && end > begin);
    let ceiling = 0;
    let bridgeSyncs = 0;
    const ctx = {
        tc: { vars: { dB: 12, requestedDb: 12 } },
        normalizeDbForCurrentMedia: requested => Math.min(requested, ceiling),
        syncPageAudioHook: () => { bridgeSyncs++; }
    };
    const enforce = runInNewContext('(' + source.slice(begin, end).trim() + ')', ctx);
    assert.equal(enforce({ sync: true }), true);
    assert.equal(ctx.tc.vars.dB, 0, 'temporary cross-origin route cannot boost');
    assert.equal(ctx.tc.vars.requestedDb, 12, 'requested volume must survive restriction');
    assert.equal(bridgeSyncs, 1);
    ceiling = 32;
    assert.equal(enforce({ sync: true }), true);
    assert.equal(ctx.tc.vars.dB, 12, 'requested boost restores when the route becomes safe');
    assert.equal(enforce({ sync: true }), false);
    assert.equal(bridgeSyncs, 2);

    ctx.tc.vars.requestedDb = -9;
    ceiling = 0;
    assert.equal(enforce(), true);
    assert.equal(ctx.tc.vars.dB, -9, 'attenuation still works on fallback-only audio');
    assert.equal(ctx.tc.vars.requestedDb, -9);

    assert.match(source, /tc\.vars\.requestedDb = normalizeDb\(msg\.dB\)/);
    assert.match(source, /tc\.vars\.requestedDb = normalizeDb\(s\.volume\)/);
    assert.match(source, /if \(enforceBoostLimit\(\)\) applyState\(\)/);
});


test('Remember saves requested boost rather than DRM-clamped displayed slider dB', async () => {
    const popup = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = popup.indexOf('async function currentTabUrl(tab) {');
    const end = popup.indexOf('function saveSiteSettings(tab)', start);
    assert.ok(start > 0 && end > start);
    const saved = [];
    const ctx = {
        cached: {
            requestedDb: 12,
            slider: { value: '0' },
            monoCheckbox: { checked: false },
            muteBtn: { classList: { contains: () => false } }
        },
        tabsGet: async id => ({ id, url: 'https://example.com/watch?v=next' }),
        document: { getElementById: id => id === 'remember-checkbox' ? { checked: true } : null },
        normalizeSiteSettingsEntryInput: () => 'example.com/watch',
        normalizeControlDb: db => Math.min(0, Number(db)),
        normalizeDb: Number,
        mutateSiteSettings: async mutation => { saved.push(mutation); },
        handleError: error => { throw error; }
    };
    runInNewContext(popup.slice(start, end) + '\nthis.saveNow = saveSiteSettingsNow;', ctx);
    await ctx.saveNow({ id: 12, url: 'https://example.com/watch?v=previous' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].patch.volume, 12, 'storage must retain requested boost, not applied 0 dB');
    assert.equal(saved[0].url, 'https://example.com/watch?v=next');

    ctx.cached.requestedDb = -9;
    ctx.cached.slider.value = '-9';
    await ctx.saveNow({ id: 12 });
    assert.equal(saved[1].patch.volume, -9, 'explicit attenuation must overwrite pending boost');
});

test('hotkey persists requested gain while native feedback reports actual limited volume', async () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    const start = source.indexOf('async function setVolume(tab, domainState, dB) {');
    const end = source.indexOf('async function setMono(tab, domainState, mono) {', start);
    assert.ok(start >= 0 && end > start);
    const feedback = [];
    const saved = [];
    const ctx = {
        normalizeDb: value => Number(value),
        sendHotkeyCommandAndConfirm: async () => ({
            volume: 0,
            requestedVolume: 12,
            muted: false
        }),
        showNativeVolumeFeedback: async (tabId, applied, muted) => {
            feedback.push({ tabId, applied, muted });
        },
        saveRememberedSettings: async (_tab, _state, updates) => { saved.push(updates); }
    };
    const fn = runInNewContext('(' + source.slice(start, end).trim() + ')', ctx);
    assert.equal(await fn({ id: 4 }, { settingsKey: 'example.com/watch' }, 12), true);
    assert.equal(feedback[0].applied, 0);
    assert.equal(saved[0].volume, 12);
});

test('content state exposes both requested and applied volume during temporary restrictions', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function getAudioControlState() {');
    const end = content.indexOf('function enforceBoostLimit(options = {}) {', begin);
    assert.ok(begin > 0 && end > begin);
    const vars = { dB: 0, requestedDb: 12, mono: false, muted: false, normalizerEnabled: false };
    const ctx = {
        tc: { vars },
        enforceBoostLimit: () => false,
        getBoostLimitInfo: () => ({ maxDb: 0, boostLimited: true, reason: 'cross-origin' }),
        getMonoAvailability: () => ({ available: false }),
        getNormalizerAvailability: () => ({ available: false }),
        normalizeDb: Number
    };
    const getState = runInNewContext('(' + content.slice(begin, end).trim() + ')', ctx);
    const state = getState();
    assert.equal(state.volume, 0);
    assert.equal(state.requestedVolume, 12);
    assert.equal(state.boostLimited, true);
});


test('boost limit invalidation automatically restores preserved gain with one reconciliation per event batch', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = content.indexOf('function invalidateBoostLimitCache() {');
    const end = content.indexOf('function getBoostLimitInfo() {', start);
    assert.ok(start > 0 && end > start);
    const events = [];
    let ceiling = 0;
    let applied = 0;
    const ctx = {
        boostLimitCache: {},
        boostReconcileScheduled: false,
        controlProfileReady: true,
        tc: { vars: { requestedDb: 12, dB: 0, isBlocked: false } },
        queueMicrotask: fn => { events.push(fn); },
        scheduleFrameBoostLimitReport: () => {},
        normalizeDbForCurrentMedia: value => Math.min(ceiling, value),
        applyState: () => {
            applied++;
            ctx.tc.vars.dB = Math.min(ctx.tc.vars.requestedDb, ceiling);
        }
    };
    const invalidate = runInNewContext('(' + content.slice(start, end).trim() + ')', ctx);
    ceiling = 32;
    invalidate();
    invalidate();
    invalidate();
    assert.equal(events.length, 1, 'multiple restriction changes schedule only one update');
    assert.equal(applied, 0, 'the state reconcile is deferred, avoiding mutation observer reentrancy');
    events.shift()();
    assert.equal(ctx.tc.vars.dB, 12);
    assert.equal(applied, 1);
    invalidate();
    events.shift()();
    assert.equal(applied, 1, 'unchanged verdict must not trigger audio rewiring');
    ceiling = 0;
    invalidate();
    events.shift()();
    assert.equal(ctx.tc.vars.dB, 0, 'new restrictions still clamp playback');
    assert.equal(ctx.tc.vars.requestedDb, 12, 'requested volume survives clamp');
    ceiling = 32;
    invalidate();
    events.shift()();
    assert.equal(ctx.tc.vars.dB, 12, 'restriction removal restores boost without opening popup');
});


test('Volume Up at a DRM/CORS ceiling never overwrites a preserved requested boost', async () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    const begin = source.indexOf('async function handleCommand(command, commandTab) {');
    const end = source.indexOf('async function showNativeVolumeFeedback(', begin);
    assert.ok(begin >= 0 && end > begin);
    let applied = 0;
    let ceiling = 0;
    let restricted = true;
    const changes = [];
    const ctx = {
        getActiveTab: async tab => tab,
        getDomainState: async () => ({ blocked: false, settingsKey: 'example.com/watch' }),
        getContentState: async () => ({
            volume: applied,
            mono: false,
            muted: false,
            monoAvailable: true,
            maxDb: ceiling,
            boostLimited: restricted
        }),
        getFallbackState: async () => ({ volume: 0, mono: false, muted: false }),
        setVolume: async (_tab, _domain, value) => {
            changes.push(value);
            applied = Math.min(value, ceiling);
        },
        setMono: async () => {},
        setMute: async () => {},
        HOTKEY_STEP_DB: 1
    };
    const handle = runInNewContext('(' + source.slice(begin, end).trim() + ')', ctx);
    const tab = { id: 5, url: 'https://example.com/watch?v=1' };
    await handle('volume-up', tab);
    assert.equal(changes.length, 0,
        'restricted volume-up at 0 dB must not replace a previously saved +12 dB request');
    await handle('volume-down', tab);
    assert.deepEqual(changes, [-1], 'volume-down must remain usable for safe attenuation');
    restricted = false;
    ceiling = 32;
    applied = 12;
    await handle('volume-up', tab);
    assert.deepEqual(changes, [-1, 13], 'normal volume-up works after restriction clears');
});


test('media src/CORS and page restriction attribute changes refresh boost verdicts', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = content.indexOf('function setupBoostLimitObserver() {');
    const end = content.indexOf('function stopBoostLimitObserver() {', begin);
    assert.ok(begin >= 0 && end > begin);
    let observerCallback;
    let observerOptions;
    let invalidations = 0;
    const rootElement = { nodeName: 'HTML' };
    const ctx = {
        boostLimitObserver: null,
        knownMediaSweepInterval: null,
        KNOWN_MEDIA_SWEEP_MS: 30000,
        document: { documentElement: rootElement },
        MutationObserver: function (callback) {
            observerCallback = callback;
            return { observe: (_root, options) => { observerOptions = options; } };
        },
        setInterval: () => 1,
        sweepKnownMediaElements: () => {},
        invalidateBoostLimitCache: () => { invalidations++; }
    };
    const install = runInNewContext('(' + content.slice(begin, end).trim() + ')', ctx);
    install();
    assert.equal(observerOptions.attributes, true);
    assert.ok(observerOptions.attributeFilter.includes('src'));
    assert.ok(observerOptions.attributeFilter.includes('crossorigin'));
    assert.ok(observerOptions.attributeFilter.includes('data-vc-page-media-restriction'));

    observerCallback([{ type: 'attributes', target: { nodeName: 'VIDEO' }, attributeName: 'src' }]);
    assert.equal(invalidations, 1);
    observerCallback([{ type: 'attributes', target: { nodeName: 'AUDIO' }, attributeName: 'crossorigin' }]);
    assert.equal(invalidations, 2);
    observerCallback([{ type: 'attributes', target: rootElement, attributeName: 'data-vc-page-media-restriction' }]);
    assert.equal(invalidations, 3);
    observerCallback([{ type: 'attributes', target: { nodeName: 'DIV' }, attributeName: 'src' }]);
    assert.equal(invalidations, 3, 'unrelated DOM changes must not trigger a scan');
    observerCallback([{ type: 'childList', addedNodes: [{ nodeName: 'VIDEO' }], removedNodes: [] }]);
    assert.equal(invalidations, 4, 'existing media insertion detection remains active');
});


test('isolated normalization sampler pauses on unrouteable DRM/CORS and resumes on clear media', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('function ensureIsolatedNormalizerTimer() {');
    const end = source.indexOf('function createGainNode() {', start);
    assert.ok(start > 0 && end > start);
    let available = true;
    let scheduled = 0;
    const cleared = [];
    const ctx = {
        tc: { vars: {
            isBlocked: false, normalizerEnabled: true, gainNode: {},
            audioCtx: { state: 'running' }, normalizerTimer: null
        } },
        getNormalizerAvailability: () => ({ available }),
        setInterval: (_fn, delay) => {
            assert.equal(delay, 100);
            return ++scheduled;
        },
        clearInterval: id => { cleared.push(id); },
        sampleIsolatedNormalizer: () => {}
    };
    const ensure = runInNewContext('(' + source.slice(start, end).trim() + ')', ctx);
    ensure();
    assert.equal(ctx.tc.vars.normalizerTimer, 1);
    ensure();
    assert.equal(scheduled, 1, 'a running route needs only one sample timer');
    available = false;
    ensure();
    assert.equal(ctx.tc.vars.normalizerTimer, null);
    assert.deepEqual(cleared, [1]);
    ensure();
    assert.equal(scheduled, 1, 'restricted audio must not restart its sampler');
    available = true;
    ensure();
    assert.equal(ctx.tc.vars.normalizerTimer, 2, 'the same saved preference resumes on clear audio');
    ctx.tc.vars.audioCtx.state = 'suspended';
    ensure();
    assert.equal(ctx.tc.vars.normalizerTimer, null, 'paused media must not keep a sampler alive');
    ctx.tc.vars.audioCtx.state = 'running';
    ensure();
    assert.equal(ctx.tc.vars.normalizerTimer, 3, 'playback resume restarts analysis');
    ctx.tc.vars.audioCtx.state = 'closed';
    ensure();
    assert.equal(ctx.tc.vars.normalizerTimer, null, 'closed AudioContexts cannot analyze');
    assert.match(source, /context\.suspend\(\)[\s\S]*?ensureIsolatedNormalizerTimer\(\)/);
});

test('a DRM transition stops stale automatic boost even when manual dB remains zero', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('function invalidateBoostLimitCache() {');
    const end = source.indexOf('function getBoostLimitInfo() {', start);
    assert.ok(start > 0 && end > start);
    const microtasks = [];
    let availability = true;
    let stateApplies = 0;
    let timerChecks = 0;
    const context = {
        boostLimitCache: {},
        boostReconcileScheduled: false,
        controlProfileReady: true,
        tc: { vars: {
            isBlocked: false, normalizerEnabled: true,
            requestedDb: 0, dB: 0, normalizerGainDb: 9, normalizerPeakDb: -8,
            gainNode: {}
        } },
        queueMicrotask: fn => { microtasks.push(fn); },
        scheduleFrameBoostLimitReport: () => {},
        normalizeDbForCurrentMedia: value => value,
        getNormalizerAvailability: () => ({ available: availability }),
        ensureIsolatedNormalizerTimer: () => { timerChecks++; },
        applyState: () => { stateApplies++; }
    };
    const invalidate = runInNewContext('(' + source.slice(start, end).trim() + ')', context);
    availability = false;
    invalidate();
    assert.equal(microtasks.length, 1);
    microtasks.shift()();
    assert.equal(context.tc.vars.normalizerGainDb, 0, 'unrouteable output must not keep old +9 dB normalization');
    assert.equal(context.tc.vars.normalizerPeakDb, -Infinity);
    assert.equal(stateApplies, 1);
    availability = true;
    invalidate();
    microtasks.shift()();
    assert.equal(timerChecks, 1, 'clear audio restarts checking even with unchanged manual gain');
});


test('expired iframe DRM/CORS reports invalidate the parent boost and Normalize verdict', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = source.indexOf('function getAggregatedFrameLimit() {');
    const end = source.indexOf('function ensureFrameReportPurge() {', begin);
    assert.ok(begin >= 0 && end > begin);
    let invalidated = 0;
    const cleared = [];
    let now = 20000;
    const ctx = {
        frameLimitReports: new Map([
            [1, { reason: 'restricted', ts: 1000 }],
            [2, { reason: 'cross-origin', ts: 18000 }]
        ]),
        frameReportPurgeInterval: 17,
        FRAME_REPORT_TTL_MS: 15000,
        isTopFrame: () => true,
        Date: { now: () => now },
        clearInterval: id => { cleared.push(id); },
        reasonSeverity: reason => reason === 'restricted' ? 3 : reason === 'cross-origin' ? 2 : 0,
        invalidateBoostLimitCache: () => { invalidated++; }
    };
    const aggregate = runInNewContext('(' + source.slice(begin, end).trim() + ')', ctx);
    assert.equal(aggregate().reason, 'cross-origin');
    assert.equal(invalidated, 1, 'purging expired DRM must re-evaluate restricted gain and Normalize');
    assert.equal(ctx.frameLimitReports.has(1), false);
    assert.deepEqual(cleared, [], 'the purge timer stays active while another frame reports');
    assert.equal(aggregate().reason, 'cross-origin');
    assert.equal(invalidated, 1, 'fresh restriction reads do not force repeated audio rebuilds');
    now = 36000;
    assert.equal(aggregate(), null);
    assert.equal(invalidated, 2, 'last expired iframe must release its boost limit without popup interaction');
    assert.deepEqual(cleared, [17]);
    assert.equal(ctx.frameReportPurgeInterval, null);
    assert.equal(aggregate(), null);
    assert.equal(invalidated, 2);
});


test('forced native routing clamps unsupported boost even before playback, then restores available range', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const begin = source.indexOf('function getBoostLimitInfo() {');
    const end = source.indexOf('// ----- Cross-frame boost-limit aggregation', begin);
    assert.ok(begin >= 0 && end > begin);
    const ctx = {
        tc: { vars: { isBlocked: false }, settings: { debugRouteMode: 'native' } },
        MAX_DB: 32,
        boostLimitCache: null,
        boostLimitCacheTime: 0,
        BOOST_LIMIT_CACHE_TTL_MS: 1000,
        document: { querySelectorAll: () => [] },
        getHookPageRestriction: () => '',
        getAggregatedFrameLimit: () => null,
        reasonSeverity: (reason) => reason === 'restricted' ? 3 : reason ? 2 : 0,
        isBoostLimitReasonBypassed: () => false,
        makeBoostLimitedResult: (reason) => ({ boostLimited: true, reason, maxDb: 0, note: reason })
    };
    const getLimit = runInNewContext(source.slice(begin, end) + '\ngetBoostLimitInfo', ctx);

    assert.equal(getLimit().maxDb, 0, 'forced native media cannot amplify above 0 dB');
    assert.equal(getLimit().reason, 'native-route');
    ctx.getHookPageRestriction = () => 'restricted';
    ctx.boostLimitCache = null;
    assert.equal(getLimit().reason, 'restricted', 'do not conceal actual protected media');
    ctx.getHookPageRestriction = () => 'cross-origin';
    ctx.boostLimitCache = null;
    assert.equal(getLimit().reason, 'cross-origin', 'retain actionable CORS restriction');
    ctx.getHookPageRestriction = () => '';
    ctx.tc.settings.debugRouteMode = 'auto';
    ctx.boostLimitCache = null;
    assert.equal(getLimit().maxDb, 32, 'switching back to auto must restore the available range');
    ctx.tc.vars.isBlocked = true;
    ctx.tc.settings.debugRouteMode = 'native';
    ctx.boostLimitCache = null;
    assert.equal(getLimit().maxDb, 32, 'disabled extension must not claim to control tab gain');
    assert.match(source, /"native-route": "Force native fallback is selected/);
    assert.match(source, /reason === "native-route"/);
});


test('isolated audio statechange stops sampling on external suspension and ignores stale contexts', () => {
    // Git's Windows checkouts may use CRLF; fragment boundaries must match
    // the same normalized newline convention on every CI runner.
    const source = readFileSync(join(root, 'cs.js'), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('const context = new (window.AudioContext || window.webkitAudioContext)();');
    const end = source.indexOf('\n    }\n\n    if (!tc.vars.gainNode', begin);
    assert.ok(begin > 0 && end > begin);
    const events = [];
    const tc = { vars: { audioCtx: null } };
    const ctx = {
        tc,
        window: { AudioContext: class AudioContext {
            constructor() { this.state = 'suspended'; }
        } },
        ensureIsolatedNormalizerTimer: () => events.push('timer-reconciled'),
        applyState: () => events.push('applied')
    };
    const instance = runInNewContext(
        '(function () {\n' + source.slice(begin, end) + '\nreturn tc.vars.audioCtx;\n})()', ctx
    );
    instance.onstatechange();
    assert.deepEqual(events, ['timer-reconciled'], 'suspended contexts must reconcile/stop sampling');
    instance.state = 'running';
    instance.onstatechange();
    assert.deepEqual(events, ['timer-reconciled', 'timer-reconciled', 'applied'],
        'running transition must restart sampling and apply the controls');
    instance.state = 'closed';
    instance.onstatechange();
    assert.deepEqual(events.slice(-1), ['timer-reconciled'], 'closed contexts must stop sampling');
    const oldLength = events.length;
    tc.vars.audioCtx = { state: 'running' };
    instance.onstatechange();
    assert.equal(events.length, oldLength, 'late events from replaced contexts are ignored');
});


test('failed captured MediaElementSource does not advertise unrestricted boost', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    const start = source.indexOf('function getBoostLimitReason(element) {');
    const end = source.indexOf('// Boost limit cache:', start);
    assert.ok(start >= 0 && end > start);
    const tc = { vars: { audioCtx: { state: 'running' } }, settings: {} };
    const reason = runInNewContext(
        source.slice(start, end) + '\ngetBoostLimitReason',
        {
            tc,
            isProbablyProtectedMedia: () => false,
            isLikelyCrossOriginMedia: () => false,
            isPageAudioManaged: () => false,
            isBoostLimitReasonBypassed: () => false
        }
    );
    const element = { dataset: { vcHooked: 'true', vcFallbackReason: 'route-failed' } };
    assert.equal(reason(element), 'route-failed',
        'a captured but disconnected source must be reported as unrouteable');
    delete element.dataset.vcFallbackReason;
    assert.equal(reason(element), '',
        'successful reconnection must clear the restriction');
    tc.vars.audioCtx.state = 'closed';
    assert.equal(reason(element), 'route-failed',
        'a closed context must be reported even if the failure flag has not arrived');
    tc.vars.audioCtx = { state: 'running' };
    element.dataset.vcHooked = 'false';
    element.dataset.vcFallbackReason = 'route-failed';
    assert.equal(reason(element), 'route-failed',
        'uncaptured failed routes must still use their existing fallback warning');
    assert.match(source, /already-captured element with a closed audio context may stay silent until reload/);
});

test('paused DRM and CORS players cannot limit a separately playing clear element', () => {
    const content = readFileSync(join(root, 'cs.js'), 'utf8');
    const hook = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(content, /for \(const el of document\.querySelectorAll\('audio, video'\)\) \{\s*if \(!isMediaPlaying\(el\)\) continue;/);
    assert.match(hook, /for \(const element of mediaElements\) \{[\s\S]*?if \(!isMediaPlaying\(element\)\) continue;/);
    assert.match(hook, /if \(isLikelyDrmMedia\(element\)\) \{[\s\S]*?return null;/);
});

test('MAIN normalizer sampler requires live routable audio and stops after pause', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('    function hasAnalyzableAudioRoute() {');
    const end = source.indexOf('    function startMaintenanceTimers() {', start);
    assert.ok(start > 0 && end > start);
    const active = new Set();
    const media = { paused: false, ended: false };
    const routes = new Map();
    const ctx = {
        state: { enabled: true, extensionActive: true, normalizerEnabled: true, debugRouteMode: 'auto' },
        mediaElements: new Set([media]), mediaRoutes: routes,
        destinationConnections: new Set(), graphs: new WeakMap(),
        nodeFromRef: value => value, isMediaPlaying: el => !el.paused && !el.ended,
        normalizerMeterTimerId: null,
        setInterval: () => { active.add(1); return 1; },
        clearInterval: id => active.delete(id),
        updateNormalizerAndMeter: () => {}
    };
    const sync = runInNewContext(source.slice(start, end) + '\nsyncNormalizerMeterTimer', ctx);
    sync();
    assert.equal(active.size, 0, 'no decoded audio route: no timer');
    routes.set(media, { context: { state: 'running' }, outputConnected: true });
    sync();
    assert.equal(active.size, 1);
    media.paused = true;
    sync();
    assert.equal(active.size, 0, 'paused route: timer stopped');
    media.paused = false;
    routes.get(media).context.state = 'suspended';
    sync();
    assert.equal(active.size, 0, 'suspended route: timer stopped');
    routes.get(media).context.state = 'running';
    ctx.state.debugRouteMode = 'native';
    sync();
    assert.equal(active.size, 0, 'native: timer stopped');
    ctx.state.debugRouteMode = 'auto';
    sync();
    assert.equal(active.size, 1, 'active WebAudio: sampler recovered');
});

test('Remember profile isolation follows SPA changes without writing to next URL', async () => {
    const source = readFileSync(join(root, 'popup.js'), 'utf8');
    const start = source.indexOf('async function currentTabUrl(tab) {');
    const end = source.indexOf('function saveSiteSettings(tab)', start);
    assert.ok(start > 0 && end > start);
    let url = 'https://example.com/old';
    const checkbox = { checked: true };
    const writes = [];
    const cached = { rememberUrl: url, rememberCheckbox: checkbox,
        requestedDb: -12, monoCheckbox: {checked:false},
        muteBtn: {classList:{contains:()=>false}}, slider:{value:-12} };
    const ctx = {
        tabsGet: async () => ({url}), cached, rememberRequestGeneration:0,
        document:{getElementById:()=>checkbox},
        storageGet:async()=>({siteSettings:{}}),
        getSiteSettingsKey:()=>null,
        normalizeSiteSettingsEntryInput:value=>new URL(value).pathname,
        normalizeDb:value=>Number(value),
        normalizeControlDb:value=>Number(value),
        mutateSiteSettings:async value=>writes.push(value),
        handleError:error=>{throw error}
    };
    runInNewContext(source.slice(start,end)+'\nthis.saveNow=saveSiteSettingsNow;',ctx);
    url='https://example.com/new';
    await ctx.saveNow({id:2});
    assert.equal(writes.length,0,'old Remember selection must not write a new path');
    assert.equal(cached.rememberUrl,url);
    assert.equal(checkbox.checked,false,'new path without profile starts unchecked');
    checkbox.checked=true;
    await ctx.saveNow({id:2});
    assert.equal(writes.length,1);
    assert.equal(writes[0].url,url);
});

test('reused media clears DRM evidence only on a real source swap without keys', () => {
    for (const file of ['cs.js','page-audio-hook.js']) {
        const source = readFileSync(join(root, file), 'utf8');
        const begin = source.indexOf('function elementDrmEvidence(element) {');
        const end = source.indexOf(file === 'cs.js'
            ? '// Gecko keys-attached marker:' : '    // Gecko keys-attached marker:', begin);
        assert.ok(begin >= 0 && end > begin, file + ': evidence function not found');
        const check = runInNewContext('(' + source.slice(begin,end).trim() + ')', {
            getMediaSourceUrl: el => el.src
        });
        const element = { src:'blob:new', dataset: {
            vcRestrictedMedia:'true', vcRestrictedMediaSource:'blob:old'
        }, mediaKeys: null, webkitKeys: null };
        assert.equal(check(element), false, file + ': clear the previous source marker');
        assert.equal(element.dataset.vcRestrictedMedia, undefined);
        element.dataset.vcRestrictedMedia = 'true';
        element.dataset.vcRestrictedMediaSource = 'blob:old';
        element.mediaKeys = {};
        assert.equal(check(element), true, file + ': attached keys still block capture');
        element.mediaKeys = null;
        element.src='blob:old';
        assert.equal(check(element), true, file + ': unchanged source stays marked DRM');
        element.src='';
        assert.equal(check(element), true, file + ': empty transient source cannot remove evidence');
    }
});

test('only extension-owned media AudioContext may be suspended', () => {
    const hook = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const section = hook.slice(hook.indexOf('function suspendMediaContextIfIdle() {'),
        hook.indexOf('function eachTrackedContext(', hook.indexOf('function suspendMediaContextIfIdle() {')));
    assert.match(section, /suspendContext\(mediaAudioContext/);
    assert.doesNotMatch(hook, /function suspendIdleContexts\(/,
        'a missing tracked destination does not prove a site-owned context is inactive');
    assert.doesNotMatch(hook, /trackSelf:\s*true/,
        'extension must not suspend arbitrary page contexts');
});

test('new MAIN-world media routes wake normalizer sampling after initial page state', () => {
    const page = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = page.indexOf('    function wireMediaRoute(route) {');
    const end = page.indexOf('    function scheduleMediaRouteRecovery(element, route) {', begin);
    assert.ok(begin >= 0 && end > begin);
    const code = page.slice(begin, end);
    assert.match(code, /if \(route\.outputConnected\) syncNormalizerMeterTimer\(\);/,
        'new media graph must start polling once its audio output connects');
    assert.match(code, /route\.currentMode === wantMode && route\.outputConnected[\s\S]*?syncNormalizerMeterTimer\(\);/,
        'existing connected route can recover sampling after a previous suspension');
});

test('MAIN sampler reconciles when an AudioContext resumes without a new play event', () => {
    const src = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    const begin = src.indexOf('    function resumeContext(context) {');
    const end = src.indexOf('    function readNativeMuted(element) {', begin);
    assert.ok(begin > 0 && end > begin);
    const events = [];
    const env = {
        pendingContextSuspends: new WeakMap(),
        syncNormalizerMeterTimer: () => events.push('sample'),
        log: () => {}
    };
    const ops = runInNewContext(src.slice(begin,end) + '\n({resumeContext,suspendContext})', env);
    const context = {state:'suspended',
        resume: async function(){this.state='running'; events.push('resume');},
        suspend: async function(){this.state='suspended'; events.push('suspend');}
    };
    return ops.resumeContext(context).then(async () => {
        assert.deepEqual(events, ['resume','sample']);
        await ops.suspendContext(context);
        assert.deepEqual(events, ['resume','sample','suspend','sample']);
        await ops.resumeContext(context);
        assert.deepEqual(events.slice(-2), ['resume','sample']);
    });
});
