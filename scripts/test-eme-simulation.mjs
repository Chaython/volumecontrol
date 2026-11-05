import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const pageSource = readFileSync(new URL('../page-audio-hook.js', import.meta.url), 'utf8');

// Execute the real EME policy functions from page-audio-hook.js with a small
// deterministic media-element/document model. This is deliberately not a
// reimplementation of the policy: every decision below comes from production
// functions (isLikelyDrmMedia, elementDrmEvidence, and emePendingCleared).
function createEmeHarness(userAgent = 'Mozilla/5.0 Firefox/159.0') {
    const start = pageSource.indexOf('    function isGeckoRuntime() {');
    const end = pageSource.indexOf('    // Aggregate, DOM-visible summary', start);
    assert.ok(start >= 0 && end > start, 'could not locate production EME policy block');
    const policy = pageSource.slice(start, end);
    const document = { documentElement: { dataset: {} } };
    const mediaState = new WeakMap();
    const state = { forceDrmCapture: false };
    const harness = runInNewContext(`
        (() => {
            const state = injected.state;
            const document = injected.document;
            const navigator = injected.navigator;
            const mediaState = injected.mediaState;
            function getMediaState(element) {
                let entry = mediaState.get(element);
                if (!entry) {
                    entry = { emePendingProgress: false, emePendingLastTime: undefined };
                    mediaState.set(element, entry);
                }
                return entry;
            }
            function getMediaSourceUrl(element) {
                return element.currentSrc || element.src || '';
            }
            function pageUsesEme() {
                return document.documentElement.dataset.vcPageUsesEme === 'true';
            }
            function log() {}
            ${policy}
            return {
                isGecko: isGeckoRuntime(),
                audioSilencedWhenRouted: EME_AUDIO_SILENCED_WHEN_ROUTED,
                isLikelyDrmMedia,
                updateEmeKeysAttachedMarker,
                resetEmePending
            };
        })()
    `, {
        injected: { state, document, navigator: { userAgent }, mediaState }
    });
    return { ...harness, document, state, mediaState };
}

function mediaElement(overrides = {}) {
    return {
        currentSrc: 'blob:https://tv.youtube.com/stream-id',
        src: '',
        currentTime: 0,
        seeking: false,
        mediaKeys: null,
        webkitKeys: null,
        dataset: {},
        ...overrides
    };
}

test('Firefox 159 keeps EME/MSE media unrouted until keys attach or clear playback is proven', () => {
    const h = createEmeHarness();
    const element = mediaElement();
    h.document.documentElement.dataset.vcPageUsesEme = 'true';

    assert.equal(h.isGecko, true);
    assert.equal(h.audioSilencedWhenRouted, false);
    assert.equal(h.isLikelyDrmMedia(element), true,
        'a probed blob: stream must not be captured before its EME state is known');

    // Gecko setMediaKeys success is represented by the same dataset marker
    // written by the production patchedSetMediaKeys promise continuation.
    element.dataset.vcEmeKeysAttached = 'true';
    assert.equal(h.isLikelyDrmMedia(element), false,
        'once Gecko keys are attached, the route may be created');
});


test('Firefox clears the keys-attached marker after successful setMediaKeys(null)', () => {
    const h = createEmeHarness();
    const element = mediaElement();
    h.document.documentElement.dataset.vcPageUsesEme = 'true';

    h.updateEmeKeysAttachedMarker(element, {});
    assert.equal(h.isLikelyDrmMedia(element), false,
        'attached keys permit Gecko routing');

    h.updateEmeKeysAttachedMarker(element, null);
    assert.equal(element.dataset.vcEmeKeysAttached, undefined,
        'detaching keys must remove the cached marker');
    assert.equal(h.isLikelyDrmMedia(element), true,
        'a reused blob: element must return to the pending EME gate');
});

test('Firefox EME probe does not permanently block clear MSE after decoded time advances', () => {
    const h = createEmeHarness();
    const element = mediaElement();
    h.document.documentElement.dataset.vcPageUsesEme = 'true';

    assert.equal(h.isLikelyDrmMedia(element), true);
    element.currentTime = 0.5;
    assert.equal(h.isLikelyDrmMedia(element), false,
        'positive playback progress without DRM evidence proves clear media');
});

test('Firefox DRM evidence without attached keys continues to block capture', () => {
    const h = createEmeHarness();
    const element = mediaElement({
        dataset: { vcRestrictedMedia: 'true' }
    });
    h.document.documentElement.dataset.vcPageUsesEme = 'true';

    assert.equal(h.isLikelyDrmMedia(element), true);
});

test('Chromium continues to block MediaElementSource capture for protected media', () => {
    const h = createEmeHarness('Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36');
    const element = mediaElement({ mediaKeys: {} });

    assert.equal(h.isGecko, false);
    assert.equal(h.audioSilencedWhenRouted, true);
    assert.equal(h.isLikelyDrmMedia(element), true,
        'Chromium protected audio must remain native to avoid permanent silence');
});

test('an EME probe alone does not block ordinary non-MSE media', () => {
    const h = createEmeHarness();
    const element = mediaElement({ currentSrc: 'https://cdn.example.test/audio.mp4' });
    h.document.documentElement.dataset.vcPageUsesEme = 'true';

    assert.equal(h.isLikelyDrmMedia(element), false);
});

test('the dangerous DRM debug override remains explicit and bypasses the policy', () => {
    const h = createEmeHarness();
    const element = mediaElement({ mediaKeys: {} });
    h.state.forceDrmCapture = true;

    assert.equal(h.isLikelyDrmMedia(element), false);
});

test('ensureMediaRoute checks the production DRM guard before creating a media-element source', () => {
    const start = pageSource.indexOf('    function ensureMediaRoute(element) {');
    const end = pageSource.indexOf('    function ', start + 10);
    assert.ok(start >= 0 && end > start);
    const routeFactory = pageSource.slice(start, end);
    const guard = routeFactory.indexOf('if (isLikelyDrmMedia(element)) return null;');
    const capture = routeFactory.indexOf('createMediaElementSource');
    assert.ok(guard >= 0, 'route creation must call the DRM policy');
    assert.ok(capture > guard, 'DRM policy must run before one-way MediaElementSource capture');
});
