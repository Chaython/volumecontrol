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

for (const browser of ['chrome', 'firefox']) {
    const packageDir = join(fixtureRoot, 'dist', browser);

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

test('background hotkeys preserve remembered debug/profile fields', () => {
    const source = readFileSync(join(root, 'background.js'), 'utf8');
    assert.match(source, /\.\.\.\(current \|\| \{\}\)/);
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
