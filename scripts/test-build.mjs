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
        assert.match(popupHtml, /src="shared\.js"/);
        assert.match(optionsHtml, /id="debugRouteMode"/);
        assert.match(optionsHtml, /src="options\.js"/);

        const popupCss = readFileSync(join(packageDir, 'popup.css'), 'utf8');
        const optionsCss = readFileSync(join(packageDir, 'options.css'), 'utf8');
        assert.match(popupCss, /--vc-range-steps/);
        assert.match(optionsCss, /\.site-debug-group/);
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

test('non-remembered SPA navigation resets ephemeral tab controls', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /lastResolvedControlUrl/);
    assert.match(source, /controlUrl !== lastResolvedControlUrl/);
    assert.match(source, /tc\.vars\.dB = 0/);
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

test('non-remembered controls reset on same-URL media boundaries', () => {
    const source = readFileSync(join(root, 'cs.js'), 'utf8');
    assert.match(source, /function resetEphemeralControlsForMediaBoundary\(element\)/);
    assert.match(source, /ephemeralBoundaryPending/);
    assert.match(source, /element\.addEventListener\('loadstart'/);
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
    assert.match(source, /refs\/tags\/\$env:RELEASE_TAG/);
    assert.match(source, /does not match manifest version/);
    assert.match(source, /filter=all_without_unlisted/);
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
