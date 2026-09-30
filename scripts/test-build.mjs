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
    assert.match(source, /if \(!currentState\.enabled && !pageHookActivated\) return/);
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
    assert.match(source, /type: "ensureForUrl"/);
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


test('CI uses a trusted local JavaScript action for downloadable build artifacts', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const action = readFileSync(join(root, '.github/actions/upload-build/action.yml'), 'utf8');
    const implementation = readFileSync(join(root, '.github/actions/upload-build/index.mjs'), 'utf8');
    assert.match(workflow, /uses: \.\/\.github\/actions\/upload-build/);
    assert.match(action, /using: node24/);
    assert.match(implementation, /ACTIONS_RUNTIME_TOKEN|@actions\/artifact/);
});


test('MAIN hook preflights early WebAudio but restores page APIs on exclusion', () => {
    const source = readFileSync(join(root, 'page-audio-hook.js'), 'utf8');
    assert.match(source, /patchAudioNodeRouting\(\);\s*\n\s*try \{/);
    assert.match(source, /function restorePatchedPageApis\(\)/);
    assert.match(source, /if \(!state\.enabled\) restorePatchedPageApis\(\)/);
    assert.match(source, /bridgeToken = null/);
    assert.match(source, /data\.command !== "setState" && data\.command !== "heartbeat"/);
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
    assert.match(source, /syncPageAudioHook\(\);\s*\n\s*stopPageBridgeTimers\(\)/);
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
