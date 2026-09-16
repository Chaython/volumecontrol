import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

    test(`${browser}: other assets preserve source bytes and encoding`, () => {
        for (const name of assets.filter(name => !name.endsWith('.js'))) {
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
        assert.equal(shared.isUrlBlockedByEntry('https://example.com/videos/one', 'example.com/videos/*'), true);
        assert.equal(shared.isUrlBlockedByEntry('https://example.com/', 'example.com/videos/*'), false);
    });
}

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
