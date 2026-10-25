// ==UserScript==
// @name         Volume Control — Per-Site Volume Booster
// @namespace    https://github.com/Chaython/volumecontrol
// @version      7.1.4
// @description  Real per-site volume control from the Volume Control browser extension: ±32 dB boost, music/adaptive normalizer, mono down-mix and a safety limiter — running the extension's actual page-audio-hook engine on any site.
// @author       Chaython
// @license      ISC
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @icon         https://chaython.github.io/volumecontrol/vc/ico.svg
// @homepageURL  https://chaython.github.io/volumecontrol/
// @supportURL   https://github.com/Chaython/volumecontrol/issues
// @downloadURL  https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js
// @updateURL    https://chaython.github.io/volumecontrol/tampermonkey/volume-control.user.js
// ==/UserScript==

/*
 * Tampermonkey edition of Volume Control (https://github.com/Chaython/volumecontrol)
 *
 * This is NOT a re-implementation. The audio engine below is the extension's
 * real page-audio-hook.js (MAIN-world content script), embedded verbatim and
 * injected into the page exactly the way the extension injects it. This
 * userscript replaces only the surrounding machinery:
 *
 *   extension content script (cs.js)  →  this controller (bridge + settings)
 *   chrome.storage per-site settings   →  GM storage keyed by hostname
 *   browser-action popup               →  floating popup (same popup.css)
 *   toolbar badge                      →  badge on the floating button
 *   browser commands (hotkeys)         →  Alt+Shift+… page keybindings
 *
 * Bridge protocol (window.postMessage, token-guarded, v3) is identical to the
 * extension's: setState / heartbeat / requestState / meterUpdate /
 * pageRestrictionChanged / locationChanged.
 *
 * Canonical home: tampermonkey/ at the repository root. Rebuilt by
 * `node scripts/build-userscript.mjs` (also runs in CI on every engine
 * change and on every release), served from the website at
 * /tampermonkey/volume-control.user.js and attached to GitHub releases.
 */

(function () {
    'use strict';

    // ============================================================= constants
    // (mirror shared.js / manifest.json)
    var MIN_DB = -32;
    var MAX_DB = 32;
    var BRIDGE_VERSION = 3;
    var BRIDGE_SOURCE = 'volume-control-extension';
    var BRIDGE_TARGET = 'volume-control-page-audio';
    var HEARTBEAT_MS = 3000;          // cs.js PAGE_BRIDGE_HEARTBEAT_MS
    var HOOK_KEY = '__volumeControlPageAudioHook';

    var IS_TOP_FRAME = (function () {
        try { return window.self === window.top; } catch (e) { return false; }
    })();

    // The real page-audio-hook.js, embedded verbatim by the build script.
    var ENGINE_SOURCE = "(() => {\n    const HOOK_KEY = \"__volumeControlPageAudioHook\";\n    const BRIDGE_SOURCE = \"volume-control-extension\";\n    const BRIDGE_TARGET = \"volume-control-page-audio\";\n    const MEDIA_MANAGED_ATTR = \"vcPageAudioManaged\";\n    const MIN_DB = -32;\n    const MAX_DB = 32;\n    const BRIDGE_VERSION = 3;\n    const HEARTBEAT_TIMEOUT_MS = 10000;\n    const supportsWeakRef = typeof WeakRef !== \"undefined\";\n\n    if (window[HOOK_KEY] && window[HOOK_KEY].installed) return;\n\n    const state = {\n        enabled: true,\n        dB: 0,\n        mono: false,\n        muted: false,\n        normalizerEnabled: false,\n        normalizerConfig: { mode: \"music\", targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 600 },\n        debugMode: false,\n        forceDrmCapture: false,\n        forceCorsCapture: false,\n        debugRouteMode: \"auto\",\n        extensionActive: false\n    };\n    function effectiveGain() {\n        // When the extension is inactive (disabled, blocked, or heartbeat lost),\n        // pass audio through at unity so page audio behaves natively.\n        if (!state.extensionActive || !state.enabled) return 1.0;\n        if (state.muted) return 0;\n        return getGainValue(state.dB);\n    }\n\n    let lastHeartbeat = Date.now();\n    let bridgeToken = null;\n    let hooksInstalled = false;\n    let mediaObserver = null;\n    let maintenanceTimerIds = [];\n    let normalizerMeterTimerId = null;\n    let howlerPollId = null;\n    let gestureListenersInstalled = false;\n    let authorizationResolved = false;\n    let preflightReleaseTimer = null;\n    const PREFLIGHT_FAILSAFE_MS = 3000;\n    const preflightMutedElements = new Set();\n    const preflightOriginalMuted = new WeakMap();\n    const preflightDesiredMuted = new WeakMap();\n    const pendingContextSuspends = new WeakMap();\n\n    const graphs = new WeakMap();\n    const contexts = new Set();\n    const vcNodes = new WeakSet();\n    const destinationConnections = new Set();\n    const howlerRoutes = new WeakMap();\n    const mediaElements = new Set();\n    const mediaState = new WeakMap();\n    const mediaRoutes = new WeakMap();\n    let mediaAudioContext = null;\n\n    const AudioNodePrototype = window.AudioNode && window.AudioNode.prototype;\n    const nativeConnect = AudioNodePrototype && AudioNodePrototype.connect;\n    const nativeDisconnect = AudioNodePrototype && AudioNodePrototype.disconnect;\n    const nativeAudioConstructor = window.Audio;\n    const nativePlay = window.HTMLMediaElement && window.HTMLMediaElement.prototype && window.HTMLMediaElement.prototype.play;\n    const nativeVolumeDescriptor = window.HTMLMediaElement && window.HTMLMediaElement.prototype\n        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, \"volume\")\n        : null;\n    const nativeMutedDescriptor = window.HTMLMediaElement && window.HTMLMediaElement.prototype\n        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, \"muted\")\n        : null;\n    const nativeSrcObjectDescriptor = window.HTMLMediaElement && window.HTMLMediaElement.prototype\n        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, \"srcObject\")\n        : null;\n    const DocumentPrototype = window.Document && window.Document.prototype;\n    const nativeCreateElement = DocumentPrototype && DocumentPrototype.createElement;\n    const nativeCreateElementNS = DocumentPrototype && DocumentPrototype.createElementNS;\n    const nativeSetMediaKeys = window.HTMLMediaElement && window.HTMLMediaElement.prototype\n        ? window.HTMLMediaElement.prototype.setMediaKeys\n        : null;\n    const nativeWebkitSetMediaKeys = window.HTMLMediaElement && window.HTMLMediaElement.prototype\n        ? window.HTMLMediaElement.prototype.webkitSetMediaKeys\n        : null;\n    const NavigatorPrototype = window.Navigator && window.Navigator.prototype;\n    const nativeRequestMediaKeySystemAccess = NavigatorPrototype && NavigatorPrototype.requestMediaKeySystemAccess;\n    const MediaKeySystemAccessPrototype = window.MediaKeySystemAccess && window.MediaKeySystemAccess.prototype;\n    const nativeCreateMediaKeys = MediaKeySystemAccessPrototype && MediaKeySystemAccessPrototype.createMediaKeys;\n    const nativeHistoryPushState = window.history && window.history.pushState;\n    const nativeHistoryReplaceState = window.history && window.history.replaceState;\n    let spaNavigationNotify = null;\n\n    function log(msg) {\n        if (state.debugMode) console.log(`[VolumeControl/PageAudio] ${msg}`);\n    }\n\n    function normalizeDb(value) {\n        const n = Number(value);\n        if (!Number.isFinite(n)) return 0;\n        return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));\n    }\n\n    function getGainValue(dB) {\n        const n = normalizeDb(dB);\n        return Math.pow(10, n / 20);\n    }\n\n    function dbToGain(dB) {\n        const n = Number(dB);\n        return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;\n    }\n\n    function normalizeNormalizerConfig(value = {}) {\n        if (!value || typeof value !== \"object\") value = {};\n        const finiteOr = (candidate, fallback) => {\n            if (candidate == null || (typeof candidate === \"string\" && !candidate.trim())) return fallback;\n            const n = Number(candidate);\n            return Number.isFinite(n) ? n : fallback;\n        };\n        return {\n            mode: value.mode === \"music\" ? \"music\" : \"adaptive\",\n            targetDb: Math.max(-30, Math.min(-6, finiteOr(value.targetDb, -16))),\n            maxBoostDb: Math.max(0, Math.min(24, finiteOr(value.maxBoostDb, 12))),\n            ceilingDb: Math.max(-6, Math.min(-0.1, finiteOr(value.ceilingDb, -1))),\n            responseMs: Math.max(100, Math.min(3000, Math.round(finiteOr(value.responseMs, 600))))\n        };\n    }\n\n    function configureLimiter(processor) {\n        if (!processor || !processor.limiter) return;\n        const config = normalizeNormalizerConfig(state.normalizerConfig);\n        try {\n            // At unity/attenuation, music needs no added peak compression.\n            // Keep the limiter node connected to avoid route clicks/latency\n            // changes, but move its threshold to 0 dBFS until boosted.\n            // Never do this for manual positive boost or adaptive mode.\n            const transparentMusic = state.normalizerEnabled && config.mode === \"music\" &&\n                state.dB <= 0 && (!Number.isFinite(processor.normalizerGainDb) ||\n                    processor.normalizerGainDb <= 0);\n            processor.limiter.threshold.value = transparentMusic ? 0 : config.ceilingDb;\n            processor.limiter.knee.value = 0;\n            processor.limiter.ratio.value = 20;\n            processor.limiter.attack.value = 0.003;\n            processor.limiter.release.value = 0.12;\n        } catch (e) {\n            log(`limiter configure failed: ${e && e.message}`);\n        }\n    }\n\n    function markNode(node) {\n        if (node) vcNodes.add(node);\n        return node;\n    }\n\n    function isOfflineContext(context) {\n        if (!context) return false;\n        if (typeof OfflineAudioContext !== \"undefined\" && context instanceof OfflineAudioContext) return true;\n        if (typeof webkitOfflineAudioContext !== \"undefined\" && context instanceof webkitOfflineAudioContext) return true;\n        return false;\n    }\n\n    function isContextDestination(node) {\n        return Boolean(node && node.context && node === node.context.destination && !isOfflineContext(node.context));\n    }\n\n    function isMediaElement(value) {\n        return Boolean(\n            value &&\n            window.HTMLMediaElement &&\n            value instanceof window.HTMLMediaElement\n        );\n    }\n\n    function getAudioContextConstructor() {\n        return window.AudioContext || window.webkitAudioContext || null;\n    }\n\n    function safeDisconnect(node) {\n        try {\n            node.disconnect();\n        } catch (e) {\n            // disconnect() throws when a node has no outgoing connections in some browsers.\n        }\n    }\n\n    function connectNative(source, destination, outputIndex, inputIndex) {\n        if (!nativeConnect) return;\n        if (outputIndex === undefined) return nativeConnect.call(source, destination);\n        if (inputIndex === undefined) return nativeConnect.call(source, destination, outputIndex);\n        return nativeConnect.call(source, destination, outputIndex, inputIndex);\n    }\n\n    function disconnectNative(source, destination, outputIndex, inputIndex) {\n        if (!nativeDisconnect) return;\n        if (destination === undefined) return nativeDisconnect.call(source);\n        if (outputIndex === undefined) return nativeDisconnect.call(source, destination);\n        if (inputIndex === undefined) return nativeDisconnect.call(source, destination, outputIndex);\n        return nativeDisconnect.call(source, destination, outputIndex, inputIndex);\n    }\n\n    function makeNodeRef(node) {\n        // Use WeakRef when available so GC'd nodes don't keep entries alive.\n        // Fall back to a deref-passthrough wrapper on older engines.\n        return supportsWeakRef ? new WeakRef(node) : { deref: () => node };\n    }\n\n    function nodeFromRef(ref) {\n        // Both WeakRef and the fallback wrapper expose .deref()\n        return ref ? ref.deref() : undefined;\n    }\n\n    function findDestinationConnection(source, destination, outputIndex, inputIndex) {\n        for (const entry of destinationConnections) {\n            const entrySource = nodeFromRef(entry.sourceRef);\n            const entryDest = nodeFromRef(entry.destinationRef);\n            if (\n                entrySource === source &&\n                entryDest === destination &&\n                entry.outputIndex === outputIndex &&\n                entry.inputIndex === inputIndex\n            ) {\n                return entry;\n            }\n        }\n        return null;\n    }\n\n    function trackDestinationConnection(source, destination, outputIndex, inputIndex, routed) {\n        const existing = findDestinationConnection(source, destination, outputIndex, inputIndex);\n        if (existing) {\n            existing.routed = routed;\n            return existing;\n        }\n\n        const entry = {\n            sourceRef: makeNodeRef(source),\n            destinationRef: makeNodeRef(destination),\n            contextRef: makeNodeRef(source.context || destination.context),\n            outputIndex,\n            inputIndex,\n            routed\n        };\n        destinationConnections.add(entry);\n        return entry;\n    }\n\n    function removeDestinationConnection(source, destination, outputIndex, inputIndex) {\n        const entry = findDestinationConnection(source, destination, outputIndex, inputIndex);\n        if (entry) destinationConnections.delete(entry);\n        return entry;\n    }\n\n    function removeDestinationConnectionsForSource(source) {\n        for (const entry of Array.from(destinationConnections)) {\n            if (nodeFromRef(entry.sourceRef) === source) destinationConnections.delete(entry);\n        }\n    }\n\n    function takeDestinationConnections(source, predicate) {\n        const matches = [];\n        for (const entry of Array.from(destinationConnections)) {\n            if (nodeFromRef(entry.sourceRef) !== source) continue;\n            if (!predicate(entry)) continue;\n            destinationConnections.delete(entry);\n            matches.push(entry);\n        }\n        return matches;\n    }\n\n    function disconnectTrackedRouteEntry(source, entry) {\n        if (!entry || !entry.routed) return false;\n        const graph = graphs.get(nodeFromRef(entry.contextRef));\n        if (!graph) return false;\n        try {\n            disconnectNative(source, graph.inputAnalyser, entry.outputIndex, 0);\n            return true;\n        } catch (e) {\n            log(`tracked route disconnect failed: ${e && e.message}`);\n            return false;\n        }\n    }\n\n    function sweepDeadDestinationConnections() {\n        // Periodically remove entries whose source or destination has been GC'd.\n        // This prevents the Set from growing unboundedly on pages that create\n        // many short-lived audio nodes.\n        for (const entry of Array.from(destinationConnections)) {\n            const source = nodeFromRef(entry.sourceRef);\n            const dest = nodeFromRef(entry.destinationRef);\n            const ctx = nodeFromRef(entry.contextRef);\n            if (!source || !dest || !ctx) {\n                destinationConnections.delete(entry);\n                continue;\n            }\n            // Also remove if the context has closed — all its nodes are dead.\n            if (ctx.state === \"closed\") {\n                destinationConnections.delete(entry);\n            }\n        }\n    }\n\n    function resumeContext(context) {\n        if (!context || typeof context.resume !== \"function\") return Promise.resolve();\n        const resumeNow = async () => {\n            try {\n                if (context.state === \"suspended\") await context.resume();\n                // A browser/user-gesture resume can occur without a new media\n                // play event or graph connection. Restart sampling on resume.\n                syncNormalizerMeterTimer();\n            } catch (e) {\n                log(`context resume failed: ${e && e.message}`);\n            }\n        };\n        const pending = pendingContextSuspends.get(context);\n        return pending ? pending.catch(() => {}).then(resumeNow) : resumeNow();\n    }\n\n    function suspendContext(context, { label = \"context\" } = {}) {\n        if (!context || typeof context.suspend !== \"function\") return Promise.resolve();\n        const existing = pendingContextSuspends.get(context);\n        if (existing) return existing;\n        if (context.state !== \"running\") return Promise.resolve();\n\n        let promise;\n        promise = Promise.resolve()\n            .then(() => context.suspend())\n            .then(() => syncNormalizerMeterTimer())\n            .catch((e) => {\n                log(`${label} suspend failed: ${e && e.message}`);\n            })\n            .finally(() => {\n                if (pendingContextSuspends.get(context) === promise) pendingContextSuspends.delete(context);\n            });\n        pendingContextSuspends.set(context, promise);\n        return promise;\n    }\n\n    function readNativeMuted(element) {\n        try {\n            if (nativeMutedDescriptor && nativeMutedDescriptor.get) {\n                return Boolean(nativeMutedDescriptor.get.call(element));\n            }\n            return Boolean(element && element.muted);\n        } catch (e) {\n            return false;\n        }\n    }\n\n    function writeNativeMuted(element, value) {\n        try {\n            if (nativeMutedDescriptor && nativeMutedDescriptor.set) {\n                nativeMutedDescriptor.set.call(element, Boolean(value));\n            } else if (element) {\n                element.muted = Boolean(value);\n            }\n        } catch (e) {}\n    }\n\n    // Keep the protective native mute invisible to page-owned UI/state.\n    function getRequestedMediaMuted(element) {\n        if (!authorizationResolved && preflightMutedElements.has(element)) {\n            return Boolean(preflightDesiredMuted.get(element));\n        }\n        return readNativeMuted(element);\n    }\n\n    function patchPreflightMuted() {\n        if (!nativeMutedDescriptor || !nativeMutedDescriptor.get || !nativeMutedDescriptor.set ||\n            !window.HTMLMediaElement || !window.HTMLMediaElement.prototype) return;\n\n        const proto = window.HTMLMediaElement.prototype;\n        const current = Object.getOwnPropertyDescriptor(proto, \"muted\");\n        if (!current || !current.configurable || (current.set && current.set.name === \"patchedPreflightMutedSetter\")) return;\n\n        try {\n            Object.defineProperty(proto, \"muted\", {\n                configurable: true,\n                enumerable: nativeMutedDescriptor.enumerable,\n                get: function patchedPreflightMutedGetter() {\n                    return getRequestedMediaMuted(this);\n                },\n                set: function patchedPreflightMutedSetter(value) {\n                    const desired = Boolean(value);\n                    if (!authorizationResolved && preflightMutedElements.has(this)) {\n                        // Preserve the site's newest intent but keep native audio\n                        // muted until authorization resolves. This avoids both a\n                        // loud startup burst and clobbering a site's mute/unmute.\n                        preflightDesiredMuted.set(this, desired);\n                        nativeMutedDescriptor.set.call(this, true);\n                        return;\n                    }\n                    nativeMutedDescriptor.set.call(this, desired);\n                }\n            });\n        } catch (e) {}\n    }\n\n    function restorePreflightMutedPatch() {\n        if (!nativeMutedDescriptor || !window.HTMLMediaElement || !window.HTMLMediaElement.prototype) return;\n        try {\n            const proto = window.HTMLMediaElement.prototype;\n            const current = Object.getOwnPropertyDescriptor(proto, \"muted\");\n            if (current && current.set && current.set.name === \"patchedPreflightMutedSetter\") {\n                Object.defineProperty(proto, \"muted\", nativeMutedDescriptor);\n            }\n        } catch (e) {}\n    }\n\n    function preflightMuteMedia(element) {\n        if (authorizationResolved || !isMediaElement(element) || preflightMutedElements.has(element)) return;\n        try {\n            const originalMuted = readNativeMuted(element);\n            preflightOriginalMuted.set(element, originalMuted);\n            preflightDesiredMuted.set(element, originalMuted);\n            preflightMutedElements.add(element);\n            writeNativeMuted(element, true);\n        } catch (e) {}\n    }\n\n    function releasePreflightMediaMute() {\n        authorizationResolved = true;\n        if (preflightReleaseTimer !== null) {\n            clearTimeout(preflightReleaseTimer);\n            preflightReleaseTimer = null;\n        }\n        for (const element of Array.from(preflightMutedElements)) {\n            const desiredMuted = preflightDesiredMuted.has(element)\n                ? Boolean(preflightDesiredMuted.get(element))\n                : Boolean(preflightOriginalMuted.get(element));\n            writeNativeMuted(element, desiredMuted);\n            preflightMutedElements.delete(element);\n        }\n        restorePreflightMutedPatch();\n    }\n\n    function preflightPlaybackCapture(event) {\n        if (!authorizationResolved) preflightMuteMedia(event && event.target);\n    }\n\n    patchPreflightMuted();\n    document.addEventListener(\"play\", preflightPlaybackCapture, true);\n    document.addEventListener(\"playing\", preflightPlaybackCapture, true);\n    // Do not drop the protective mute on an arbitrary 250 ms timer: service\n    // worker/content-script startup can legitimately take longer. setState()\n    // releases it as soon as authorization is known; this is only a last-resort\n    // escape hatch if the extension handshake never arrives.\n    preflightReleaseTimer = setTimeout(releasePreflightMediaMute, PREFLIGHT_FAILSAFE_MS);\n\n    function isMediaPlaying(element) {\n        return Boolean(element && !element.paused && !element.ended);\n    }\n\n    function isAudibleMediaElement(element) {\n        if (!isMediaElement(element)) return false;\n        // Startup's temporary physical mute is not the site's own mute:\n        // preflight must not prevent attaching a safe route before unmuting.\n        if (getRequestedMediaMuted(element)) return false;\n        return getMediaState(element).baseVolume > 0;\n    }\n\n    // Returns true if any media element has an active (playing + audible + connected)\n    // route on the given context. If context is omitted, checks the mediaAudioContext.\n    function hasActiveMediaRoute(context) {\n        for (const element of mediaElements) {\n            const route = mediaRoutes.get(element);\n            if (route && route.outputConnected &&\n                (!context || route.context === context) &&\n                isMediaPlaying(element) && isAudibleMediaElement(element)) {\n                return true;\n            }\n        }\n        return false;\n    }\n\n    // Disconnect the output side of all media routes on the given context.\n    // If context is omitted, disconnects all routes.\n    function disconnectAllMediaRouteOutputs(context) {\n        for (const element of Array.from(mediaElements)) {\n            const route = mediaRoutes.get(element);\n            if (route && (!context || route.context === context)) {\n                disconnectMediaRouteOutput(route);\n            }\n        }\n    }\n\n    function suspendMediaContextIfIdle() {\n        // Page-created AudioContexts are owned by the site. Missing tracked\n        // connections does not prove they are silent; never suspend those.\n        if (!mediaAudioContext || mediaAudioContext.state === \"closed\") return;\n        if (mediaAudioContext.state !== \"running\") return;\n\n        if (hasActiveMediaRoute(mediaAudioContext)) return;\n\n        disconnectAllMediaRouteOutputs(mediaAudioContext);\n\n        // Check if any media routes remain after disconnecting idle ones.\n        let hasAnyRoute = false;\n        for (const element of mediaElements) {\n            if (mediaRoutes.has(element)) { hasAnyRoute = true; break; }\n        }\n\n        // Suspend the context to release the OS audio device handle. This is\n        // critical for Bluetooth devices that stay active while a running\n        // AudioContext holds the output stream open. Per the WebAudio spec,\n        // a suspended context releases the audio device in all major browsers\n        // (Chrome, Firefox, Safari), so suspend() is sufficient for Bluetooth\n        // idle without the irrecoverable state that close() creates.\n        //\n        // We deliberately do NOT close() even when no routes remain. close()\n        // would destroy any MediaElementSource routes still held in mediaRoutes,\n        // and those routes can only be created ONCE per element per context.\n        // If the page later reuses the same <video> element (YouTube/Twitch\n        // auto-next, replay after ended, etc.), close() would permanently kill\n        // audio for that element until the page is reloaded. suspend() preserves\n        // the routes so they can be rewired on resume.\n        //\n        // hasAnyRoute is preserved here as documentation; suspend() works for\n        // both branches (with routes -> keep routes alive but idle; without\n        // routes -> just release the device handle).\n        suspendContext(mediaAudioContext, { label: \"media context\" }).then(() => {\n            log(hasAnyRoute\n                ? \"media context suspended (idle routes kept) — device handle released\"\n                : \"media context suspended (no routes) — device handle released\");\n        });\n    }\n\n    // Iterate every tracked page context, pruning dead/closed entries.\n    // Entries are WeakRefs when available: a strong Set would pin contexts\n    // the page abandoned without close() (games, per-interaction contexts)\n    // for the tab's lifetime — each retained context counts against Chrome's\n    // per-tab AudioContext quota, eventually breaking the SITE's own audio.\n    function eachTrackedContext(fn) {\n        for (const entry of Array.from(contexts)) {\n            const ctx = (supportsWeakRef && entry instanceof WeakRef)\n                ? (typeof entry.deref === \"function\" ? entry.deref() : null)\n                : entry;\n            if (!ctx || ctx.state === \"closed\") {\n                contexts.delete(entry);\n                continue;\n            }\n            fn(ctx);\n        }\n    }\n\n    function addTrackedContext(context) {\n        contexts.add(supportsWeakRef ? new WeakRef(context) : context);\n    }\n\n    // Never resume page-created AudioContexts suspended by the site itself.\n    // Only an in-flight extension-owned suspension can be reversed here.\n    function resumeIfSelfSuspended(context) {\n        try {\n            if (context && pendingContextSuspends.has(context)) {\n                resumeContext(context);\n            }\n        } catch (e) {}\n    }\n\n    function disconnectMediaRouteOutput(route) {\n        if (!route) return;\n\n        safeDisconnect(route.gain);\n        safeDisconnect(route.splitter);\n        safeDisconnect(route.leftGain);\n        safeDisconnect(route.rightGain);\n        safeDisconnect(route.merger);\n        safeDisconnect(route.limiter);\n        safeDisconnect(route.analyser);\n        route.outputConnected = false;\n    }\n\n    function cancelMediaRouteRecovery(route) {\n        if (!route || !route.recoveryTimer) return;\n        clearTimeout(route.recoveryTimer);\n        route.recoveryTimer = null;\n    }\n\n    function releaseMediaRoute(element) {\n        const route = mediaRoutes.get(element);\n        if (!route) return;\n\n        cancelMediaRouteRecovery(route);\n        disconnectMediaRouteOutput(route);\n\n        // Do NOT disconnect route.source from route.inputAnalyser, and do NOT delete the\n        // route from mediaRoutes. The MediaElementSourceNode can only be created\n        // once per element per context, so we must keep the existing source node\n        // alive so it can be reconnected when playback resumes (e.g., after\n        // 'ended' the user clicks replay). disconnectMediaRouteOutput already\n        // disconnected gain→destination, so no audio flows while idle.\n        //\n        // The WeakMap entry is automatically collected when the element itself\n        // is GC'd (WeakMap keys are weak), so there is no memory leak.\n\n        try {\n            setNativeVolume(element, getMediaState(element).baseVolume);\n        } catch (e) {\n            log(`media release volume restore failed: ${e && e.message}`);\n        }\n    }\n\n    // Direct MediaStreamSource capture bypasses the HTML player's volume/mute.\n    // Preserve the site's requested controls independently of extension gain.\n    function mediaSourceGain(processor) {\n        if (!processor || processor.sourceKind !== \"mediaStream\" || !processor.element) return 1;\n        const element = processor.element;\n        if (getRequestedMediaMuted(element)) return 0;\n        const base = Number(getMediaState(element).baseVolume);\n        return Number.isFinite(base) ? Math.max(0, Math.min(1, base)) : 1;\n    }\n\n    function clampUnprotectedOutput(processor) {\n        // The native MediaElementSource has already been captured and cannot\n        // be restored by reconnecting the HTML element. If a limited route\n        // fails, connect directly but never allow stale boost to reach it.\n        processor.limiterFallbackActive = true;\n        processor.normalizerGainDb = 0;\n        processor.musicLevelState = null;\n        processor.meterPeakDb = -Infinity;\n        try {\n            const param = processor.gain.gain;\n            const now = processor.context.currentTime;\n            const safeGain = Math.max(0, Math.min(1, effectiveGain())) * mediaSourceGain(processor);\n            param.cancelScheduledValues(now);\n            param.setValueAtTime(safeGain, now);\n            return true;\n        } catch (e) {\n            log(`safe output gain clamp failed: ${e && e.message}`);\n            // Do not connect an unprotected output if its AudioParam may\n            // still hold +20 dB (or a scheduled ramp back to that gain).\n            return false;\n        }\n    }\n\n    function clampDirectOutputGain(processor) {\n        // Do not expose the previous (possibly >1) auto/manual gain on the\n        // first audio block after a limited -> direct route transition.\n        // Reconnecting before the ordinary 15 ms ramp would bypass the\n        // compressor while that old boost is still audible.\n        try {\n            const param = processor.gain.gain;\n            const now = processor.context.currentTime;\n            const safeGain = Math.max(0, Math.min(1, effectiveGain())) * mediaSourceGain(processor);\n            param.cancelScheduledValues(now);\n            param.setValueAtTime(safeGain, now);\n            return true;\n        } catch (e) {\n            log(`direct output safety clamp failed: ${e && e.message}`);\n            // Keep the old limited route connected and retry on a future\n            // state sync; never open a direct path with an unknown AudioParam.\n            return false;\n        }\n    }\n\n    function setGainValue(graph) {\n        const autoGain = state.normalizerEnabled ? dbToGain(graph.normalizerGainDb || 0) : 1;\n        const targetGain = graph.limiterFallbackActive\n            ? Math.min(1, effectiveGain()) : effectiveGain() * autoGain;\n        try {\n            const now = graph.context.currentTime;\n            if (graph.context.state === \"running\") {\n                // Smooth ramp to avoid audible clicks/spikes when the user drags\n                // the slider rapidly. 15ms is short enough to feel responsive but\n                // long enough to prevent zipper noise.\n                graph.gain.gain.cancelScheduledValues(now);\n                graph.gain.gain.setValueAtTime(graph.gain.gain.value, now);\n                graph.gain.gain.linearRampToValueAtTime(targetGain, now + 0.015);\n            } else {\n                graph.gain.gain.value = targetGain;\n            }\n        } catch (e) {\n            log(`gain update failed: ${e && e.message}`);\n        }\n    }\n\n    // Compute the current routing mode string from state. Used by wireGraph and\n    // wireMediaRoute to skip redundant disconnect/reconnect cycles.\n    function safetyLimiterRequired() {\n        // Keep clipping protection for manual positive boosts. At unity or\n        // attenuation with Normalize off, bypass the compressor entirely:\n        // even a nominal -1 dBFS compressor introduces processing/latency.\n        return state.extensionActive && state.enabled &&\n            (state.normalizerEnabled || (!state.muted && state.dB > 0));\n    }\n\n    function currentRoutingMode() {\n        if (!state.extensionActive || !state.enabled) return \"bypass\";\n        return (state.mono ? \"mono\" : \"stereo\") +\n            (safetyLimiterRequired() ? \"-limited\" : \"-direct\");\n    }\n\n    // Connect a mono down-mix chain: gain → splitter → L/R gains → merger → destination.\n    // Used by wireGraph (page-level contexts) and wireMediaRoute (media element routes).\n    function connectMonoChain(gain, splitter, leftGain, rightGain, merger, destination) {\n        connectNative(gain, splitter);\n        connectNative(splitter, leftGain, 0);\n        connectNative(splitter, rightGain, 1);\n        connectNative(leftGain, merger, 0, 0);\n        connectNative(rightGain, merger, 0, 0);\n        connectNative(leftGain, merger, 0, 1);\n        connectNative(rightGain, merger, 0, 1);\n        connectNative(merger, destination);\n    }\n\n    function wireGraph(graph) {\n        // Configure first, but do not raise the gain until the destination is\n        // routed through the limiter. Reversed ordering can briefly expose\n        // an amplified, unprotected direct path on unmute/enable.\n        configureLimiter(graph);\n        const wantMode = currentRoutingMode();\n        if (graph.currentMode === wantMode && !graph.limiterFallbackActive) {\n            setGainValue(graph);\n            return;\n        }\n        if (!safetyLimiterRequired() && !clampDirectOutputGain(graph)) return;\n\n        safeDisconnect(graph.gain);\n        safeDisconnect(graph.splitter);\n        safeDisconnect(graph.leftGain);\n        safeDisconnect(graph.rightGain);\n        safeDisconnect(graph.merger);\n        safeDisconnect(graph.limiter);\n        safeDisconnect(graph.analyser);\n\n        try {\n            const useLimiter = safetyLimiterRequired();\n            const output = useLimiter ? graph.limiter : graph.context.destination;\n            if (state.extensionActive && state.enabled && state.mono) {\n                connectMonoChain(graph.gain, graph.splitter, graph.leftGain, graph.rightGain, graph.merger, output);\n            } else {\n                connectNative(graph.gain, output);\n            }\n            if (useLimiter) {\n                configureLimiter(graph);\n                connectNative(graph.limiter, graph.analyser);\n                connectNative(graph.analyser, graph.context.destination);\n            }\n            // A failed graph rebuild must be retryable on the next state sync.\n            graph.currentMode = wantMode;\n            graph.limiterFallbackActive = false;\n        } catch (e) {\n            graph.currentMode = null;\n            safeDisconnect(graph.gain);\n            safeDisconnect(graph.splitter);\n            safeDisconnect(graph.leftGain);\n            safeDisconnect(graph.rightGain);\n            safeDisconnect(graph.merger);\n            safeDisconnect(graph.limiter);\n            safeDisconnect(graph.analyser);\n            if (clampUnprotectedOutput(graph)) {\n                try {\n                    connectNative(graph.gain, graph.context.destination);\n                } catch (fallbackError) {\n                    log(`graph fallback failed: ${fallbackError && fallbackError.message}`);\n                }\n            }\n            log(`graph wire failed: ${e && e.message}`);\n        }\n        setGainValue(graph);\n    }\n\n    function ensureGraph(context) {\n        if (!context || isOfflineContext(context)) return null;\n        if (graphs.has(context)) return graphs.get(context);\n\n        try {\n            const gain = markNode(context.createGain());\n            // Measure source RMS before the slider and automatic gain.\n            const inputAnalyser = markNode(context.createAnalyser());\n            const splitter = markNode(context.createChannelSplitter(2));\n            const leftGain = markNode(context.createGain());\n            const rightGain = markNode(context.createGain());\n            const merger = markNode(context.createChannelMerger(2));\n            const limiter = markNode(context.createDynamicsCompressor());\n            const analyser = markNode(context.createAnalyser());\n\n            gain.channelInterpretation = \"speakers\";\n            leftGain.gain.value = 0.5;\n            rightGain.gain.value = 0.5;\n            analyser.fftSize = 1024;\n            analyser.smoothingTimeConstant = 0.35;\n            // 8192 frames span ~171ms at 48kHz, overlapping adjacent\n            // 100ms AGC samples rather than leaving ~15ms peak blind spots.\n            inputAnalyser.fftSize = 8192;\n            inputAnalyser.smoothingTimeConstant = 0.35;\n\n            const graph = {\n                context, gain, inputAnalyser, splitter, leftGain, rightGain, merger, limiter, analyser,\n                currentMode: null,\n                limiterFallbackActive: false,\n                normalizerGainDb: 0,\n                meterPeakDb: -Infinity,\n                meterBuffer: new Float32Array(analyser.fftSize),\n                inputBuffer: new Float32Array(inputAnalyser.fftSize)\n            };\n            connectNative(inputAnalyser, gain);\n            graphs.set(context, graph);\n            addTrackedContext(context);\n            wireGraph(graph);\n            return graph;\n        } catch (e) {\n            log(`graph create failed: ${e && e.message}`);\n            return null;\n        }\n    }\n\n    function applyStateToGraphs() {\n        eachTrackedContext((context) => {\n            const graph = graphs.get(context);\n            if (graph) wireGraph(graph);\n        });\n    }\n\n    function getMediaContext() {\n        if (mediaAudioContext && mediaAudioContext.state !== \"closed\") return mediaAudioContext;\n\n        const AudioContextConstructor = getAudioContextConstructor();\n        if (!AudioContextConstructor) return null;\n\n        try {\n            mediaAudioContext = new AudioContextConstructor();\n            return mediaAudioContext;\n        } catch (e) {\n            log(`media context create failed: ${e && e.message}`);\n            return null;\n        }\n    }\n\n    function getMediaSourceUrl(element) {\n        const directSrc = element.currentSrc || element.src;\n        if (directSrc) return directSrc;\n\n        try {\n            const source = element.querySelector && element.querySelector(\"source[src]\");\n            return source ? source.src : \"\";\n        } catch (e) {\n            return \"\";\n        }\n    }\n\n    function isLikelyCrossOriginMedia(element) {\n        // Dangerous debug override: attempt WebAudio capture even when the\n        // media URL is cross-origin. Browsers may output silence for tainted\n        // media; this exists only for troubleshooting/compatibility testing.\n        if (state.forceCorsCapture) return false;\n\n        const src = getMediaSourceUrl(element);\n        if (!src || element.crossOrigin) return false;\n\n        try {\n            const url = new URL(src, document.baseURI);\n            if (url.protocol.indexOf(\"http\") !== 0) return false;\n            // In inherited-origin about:blank frames, location.origin\n            // serializes as \"null\" while the document's effective origin is\n            // the creator's. Prefer document.origin (the effective origin);\n            // an actually-opaque origin (data:, sandboxed without\n            // allow-same-origin) is \"unknown\" rather than cross-origin, so\n            // same-origin media inside such frames is not falsely limited.\n            const pageOrigin = (typeof globalThis.origin === \"string\" && globalThis.origin) || window.location.origin;\n            if (!pageOrigin || pageOrigin === \"null\") return false;\n            return url.origin !== pageOrigin;\n        } catch (e) {\n            return false;\n        }\n    }\n\n    // Sticky per-element DRM flag. Written to a data-* attribute so the\n    // ISOLATED-world content script (which shares DOM attributes but not JS\n    // state) sees it too, for both its routing decisions and its boost-limit\n    // verdict.\n    function markElementRestricted(element) {\n        try {\n            if (element && element.dataset) {\n                element.dataset.vcRestrictedMedia = \"true\";\n                const source = getMediaSourceUrl(element);\n                if (source) element.dataset.vcRestrictedMediaSource = source;\n            }\n        } catch (e) {}\n        // The aggregate page restriction may have just appeared (this element\n        // is now DRM-restricted even if it is detached or in shadow DOM).\n        updatePageMediaRestriction();\n    }\n\n    function pageUsesEme() {\n        try {\n            return document.documentElement.dataset.vcPageUsesEme === \"true\";\n        } catch (e) {\n            return false;\n        }\n    }\n\n    // Engine-aware EME policy (v6.12). Chromium-family browsers (Chrome, Edge,\n    // Brave, Opera, Vivaldi) silence MediaElementAudioSourceNode output for\n    // encrypted/protected content: createMediaElementSource() detaches the\n    // element's native output and feeds the graph zeros, permanently muting\n    // the stream. Gecko (Firefox) is different — it explicitly SUPPORTS\n    // capturing EME media audio through WebAudio (Mozilla bug 1331763, shipped\n    // in Firefox 55: \"creating a MediaElementSource on a media element should\n    // always succeed (no matter it's restricted content or not)\" — Mozilla\n    // blocks only video capture via captureStream, never audio). Verified by\n    // reverse-engineering a competitor booster that boosts Netflix/Widevine on\n    // Firefox with a plain createMediaElementSource + GainNode chain.\n    // So on Gecko, DRM signals do NOT block routing and do NOT clamp the boost\n    // limit. Cross-origin taint, by contrast, silences routed audio in EVERY\n    // engine (spec-mandated) and stays enforced everywhere.\n    //\n    // Detection: navigator.userAgentData exists only in Chromium-family\n    // browsers; a UA containing \"Firefox/\" identifies Gecko. Anything else\n    // (Safari/WebKit, unknown, privacy-hardened UA stripping) keeps the\n    // conservative guard — the default is always \"refuse to route DRM\".\n    function isGeckoRuntime() {\n        try {\n            const ua = (typeof navigator !== \"undefined\" && navigator.userAgent) || \"\";\n            // Firefox-first: a UA that says Firefox proves Gecko even if a\n            // future Firefox release grows a userAgentData shim (which the\n            // old check would have misread as proof of Chromium).\n            if (ua.indexOf(\"Firefox/\") !== -1) return true;\n            if (typeof navigator !== \"undefined\" && navigator.userAgentData) return false;\n            return false;\n        } catch (e) {\n            return false;\n        }\n    }\n    const EME_AUDIO_SILENCED_WHEN_ROUTED = !isGeckoRuntime();\n\n    // Per-element DRM evidence (sticky): `encrypted` fired, or MediaKeys were\n    // attached. Shared with the ISOLATED world (dataset flags +\n    // element.mediaKeys).\n    function elementDrmEvidence(element) {\n        if (!element) return false;\n        try {\n            const keys = element.mediaKeys || element.webkitKeys;\n            if (element.dataset && element.dataset.vcRestrictedMedia === \"true\") {\n                const previous = element.dataset.vcRestrictedMediaSource;\n                const current = getMediaSourceUrl(element);\n                if (previous && current && previous !== current && !keys) {\n                    delete element.dataset.vcRestrictedMedia;\n                    delete element.dataset.vcRestrictedMediaSource;\n                } else {\n                    return true;\n                }\n            }\n            if (keys) return true;\n        } catch (e) {\n            // An uninspectable DRM state is not proof of a clear stream.\n            return true;\n        }\n        return false;\n    }\n\n    // Gecko keys-attached marker: Gecko's setMediaKeys() throws\n    // NotSupportedError when the element is already audio-captured\n    // (MozAudioCaptured), so EME elements become routable only AFTER keys\n    // attach. The setMediaKeys patch below writes vcEmeKeysAttached on\n    // native success.\n    function elementEmeKeysAttached(element) {\n        if (!element) return false;\n        try {\n            if (element.mediaKeys) return true;\n            if (element.dataset && element.dataset.vcEmeKeysAttached === \"true\") return true;\n        } catch (e) {\n            return false;\n        }\n        return false;\n    }\n\n    // Pending EME suspect: the page was granted EME access (probe) and the\n    // element has a blob: (MSE) source without per-element DRM evidence.\n    // Routing is refused while the element is under suspicion; if no\n    // evidence lands, the element is clear media and may be routed (Plex\n    // probes DRM at startup while playing clear direct-play content —\n    // issue #70).\n    //\n    // v6.14: suspicion is no longer cleared by a blind 3-second timer (v6.13\n    // — 3s of un-boosted playback on every probed-but-clear page). It is\n    // cleared by DECRYPTION PROOF: the element's currentTime actually\n    // advancing. EME content cannot decode a single frame without MediaKeys\n    // attached to that element, and every key-attachment path is visible to\n    // us (patched setMediaKeys/webkitSetMediaKeys — MAIN-world patches\n    // installed at document_start, before any page script runs; the\n    // element.mediaKeys / webkitKeys properties; the 'encrypted' init-data\n    // event). Therefore:\n    //   * progress + zero evidence  ⇒  clear media  ⇒  safe to route\n    //   * no progress (currentTime frozen while \"playing\" — playback blocked\n    //     waiting on a license) ⇒ keep refusing; the evidence race cannot\n    //     be lost because encrypted content cannot produce progress.\n    // Progress is observed at timeupdate cadence (spec: 15-250ms, ~4Hz in\n    // Chromium) via the per-element timeupdate listener, plus the 1s sweep\n    // as a backup, so clear MSE content routes within a couple hundred\n    // milliseconds of actually playing. When the page constructs MediaKeys\n    // (setMediaKeys imminent), earned proof is RESET (see the createMediaKeys\n    // patch) — routing then waits for post-restart progress or the evidence\n    // itself.\n    const EME_PENDING_MIN_PROGRESS_S = 0.01; // epsilon: supports playbackRate >= 0.04\n\n    function isPendingEmeSuspect(element) {\n        // Probe-level gate (v6.9 semantics): a page that was GRANTED key\n        // system access may attach keys to this blob: element at any moment.\n        // Refuse routing until decryption proof or DRM evidence arrives\n        // (Plex plays clear direct-play MSE on pages that probe DRM at\n        // startup).\n        if (!pageUsesEme()) return false;\n        const src = getMediaSourceUrl(element);\n        return Boolean(src) && src.indexOf(\"blob:\") === 0;\n    }\n\n    function resetEmePending(element) {\n        const entry = mediaState.get(element);\n        if (!entry) return;\n        entry.emePendingProgress = false;\n        entry.emePendingLastTime = undefined;\n    }\n\n    function emePendingCleared(element) {\n        // Decryption-proof gate. Observes currentTime on every evaluation\n        // (each evaluation also refreshes the baseline, so scripted seeks —\n        // a page setting currentTime — are recorded as baseline moves, not\n        // progress; genuine decode progress is a positive delta while not\n        // seeking).\n        const entry = getMediaState(element);\n        if (entry.emePendingProgress) return true;\n        let now = 0;\n        let seeking = false;\n        try {\n            now = Number(element.currentTime);\n            if (typeof element.seeking === \"boolean\") seeking = element.seeking;\n        } catch (e) {\n            return false;\n        }\n        if (!Number.isFinite(now)) return false;\n        const last = entry.emePendingLastTime;\n        entry.emePendingLastTime = now;\n        if (last !== undefined && !seeking && now > last + EME_PENDING_MIN_PROGRESS_S) {\n            entry.emePendingProgress = true;\n            log(`EME pending cleared by playback progress (clear media): ${getMediaSourceUrl(element)}`);\n            return true;\n        }\n        return false;\n    }\n\n    // DRM pipelines always use MSE, and MSE playback surfaces as a blob: URL.\n    // EME init data (encrypted event) and setMediaKeys can land AFTER playback\n    // starts when license setup is slow, so while a page is known to use EME we\n    // conservatively treat blob-sourced media as protected too. This closes the\n    // window where an element gets routed through WebAudio a few ms before its\n    // DRM flags appear — a one-way trip to permanent silence (on engines that\n    // silence protected audio; see EME_AUDIO_SILENCED_WHEN_ROUTED).\n    function isLikelyDrmMedia(element) {\n        // Debug override: deliberately bypass every DRM/EME routing guard and\n        // attempt MediaElementAudioSource capture even when it may break the\n        // site's protected-media pipeline. Cross-origin checks remain separate.\n        if (state.forceDrmCapture) return false;\n\n        // ROUTING gate. Returns true when the element must NOT be captured\n        // into WebAudio right now:\n        //  * Chromium (EME_AUDIO_SILENCED_WHEN_ROUTED): any per-element DRM\n        //    evidence, plus pending EME suspects (probe granted + blob: MSE\n        //    source) until decryption proof or evidence arrives.\n        //  * Gecko: EME audio IS routable (bug 1331763), but only once keys\n        //    are attached — capturing first makes the site's setMediaKeys()\n        //    throw NotSupportedError and breaks playback. Evidence without\n        //    keys, and pending suspects without proof, still refuse routing.\n        // Probe-only pages (Plex) never restrict the verdict: probing must\n        // not produce a false \"restricted\" note or a permanent routing\n        // refusal for clear MSE content (issue #70).\n        if (!element) return false;\n        if (EME_AUDIO_SILENCED_WHEN_ROUTED) {\n            if (elementDrmEvidence(element)) return true;\n            if (!isPendingEmeSuspect(element)) return false;\n            return !emePendingCleared(element);\n        }\n        if (elementEmeKeysAttached(element)) return false;\n        if (elementDrmEvidence(element)) return true;\n        if (!isPendingEmeSuspect(element)) return false;\n        return !emePendingCleared(element);\n    }\n\n    // Aggregate, DOM-visible summary of every tracked media element's boost\n    // limitation (DRM-restricted or cross-origin). The ISOLATED-world content\n    // script derives its popup verdict from document.querySelectorAll, which\n    // can only see elements attached to this document's light DOM — it is\n    // blind to the detached players many sites use (treblo.com and suno.com\n    // create <audio> via createElement/new Audio and never append it) and to\n    // elements hidden inside shadow DOM. This hook tracks ALL of those\n    // (claimed at creation/first play/first volume write), so publishing the\n    // aggregate on the documentElement lets the content script's boost-limit\n    // verdict include them.\n    let lastPublishedPageRestriction = null;\n    let pendingRelaxation = null; // { restriction, since } — surviving the hysteresis window\n    const RESTRICTION_RELAX_DELAY_MS = 500;\n\n    function restrictionSeverity(value) {\n        return value === \"restricted\" ? 2 : (value === \"cross-origin\" ? 1 : 0);\n    }\n\n    function publishPageMediaRestriction(restriction) {\n        lastPublishedPageRestriction = restriction;\n        try {\n            const ds = document.documentElement.dataset;\n            if (restriction) ds.vcPageMediaRestriction = restriction;\n            else delete ds.vcPageMediaRestriction;\n            log(`page media restriction: ${restriction || \"none\"}`);\n        } catch (e) {\n            log(`page media restriction publish failed: ${e && e.message}`);\n        }\n        // Tell the content script immediately: its boost-limit verdict caches\n        // for a second, and without this nudge a freshly-restricted page (DRM\n        // handshake completing, cross-origin src appearing) would keep serving\n        // the stale unrestricted verdict until the cache expires.\n        postToContentScript(\"pageRestrictionChanged\", { restriction });\n    }\n\n    function updatePageMediaRestriction() {\n        let restriction = \"\";\n        for (const element of mediaElements) {\n            // A paused/ended DRM player must not cap a separate clear player;\n            // routing guards remain active when playback begins.\n            if (!isMediaPlaying(element)) continue;\n            // VERDICT (the popup note + slider clamp) requires per-element\n            // DRM evidence on engines that silence routed EME audio. The\n            // pending window and page-level probes gate ROUTING only (see\n            // isLikelyDrmMedia) — a probed-but-clear page (Plex) must not\n            // show a restriction note (issue #70). On Gecko, DRM audio is\n            // routable (bug 1331763), so the verdict never restricts.\n            if (!state.forceDrmCapture && EME_AUDIO_SILENCED_WHEN_ROUTED && elementDrmEvidence(element)) {\n                restriction = \"restricted\";\n                break; // most severe; no need to keep scanning\n            }\n            if (!restriction && isLikelyCrossOriginMedia(element)) {\n                restriction = \"cross-origin\";\n            }\n        }\n\n        if (restriction === lastPublishedPageRestriction) {\n            // Nothing new to say; a pending relaxation that matches the\n            // published value is stale (transient during a src swap).\n            pendingRelaxation = null;\n            return;\n        }\n\n        if (lastPublishedPageRestriction === null) {\n            // First computation on this page — publish immediately.\n            pendingRelaxation = null;\n            publishPageMediaRestriction(restriction);\n            return;\n        }\n\n        if (restrictionSeverity(restriction) > restrictionSeverity(lastPublishedPageRestriction)) {\n            // Tightening (a restriction appeared or got more severe): publish\n            // at once — the popup must clamp its slider range BEFORE the user\n            // can drag into a region that cannot actually be boosted.\n            pendingRelaxation = null;\n            publishPageMediaRestriction(restriction);\n            return;\n        }\n\n        // Relaxation (\"\" while a new src loads after a track change, or\n        // \"cross-origin\" after \"restricted\"): src swaps make the aggregate\n        // transiently compute a LOWER value while the next source resolves.\n        // Publishing that instantly would flash the boost-limit note off and\n        // back on (the same visible symptom as the v6.8 cross-frame race).\n        // Require the relaxed value to stay stable for the hysteresis window;\n        // the 1s recompute interval will publish it on a later tick.\n        if (!pendingRelaxation || pendingRelaxation.restriction !== restriction) {\n            pendingRelaxation = { restriction, since: Date.now() };\n        } else if (Date.now() - pendingRelaxation.since >= RESTRICTION_RELAX_DELAY_MS) {\n            publishPageMediaRestriction(restriction);\n            pendingRelaxation = null;\n        }\n    }\n\n    function patchEmeApi() {\n        // EME awareness. On engines that silence protected audio in WebAudio\n        // (Chromium-family — see EME_AUDIO_SILENCED_WHEN_ROUTED),\n        // createMediaElementSource() on a DRM element detaches the native\n        // output and feeds the graph zeros, permanently muting the stream\n        // (there is no way back). To prevent it, we watch the EME entry\n        // points and flag protected elements/pages BEFORE any routing decision\n        // is made:\n        //   * setMediaKeys(keys) marks that element restricted (sticky).\n        //   * requestMediaKeySystemAccess() resolving marks the page as EME-using\n        //     (feeds isLikelyDrmMedia's conservative blob: heuristic).\n        // On Gecko (Firefox) the flags are still recorded for reporting, but\n        // they no longer gate routing or the verdict: Firefox routes EME audio\n        // through WebAudio audibly (bug 1331763), so DRM media is boostable\n        // there. The gates consult EME_AUDIO_SILENCED_WHEN_ROUTED.\n        if (window.HTMLMediaElement && window.HTMLMediaElement.prototype &&\n            !window.HTMLMediaElement.prototype.__volumeControlSetMediaKeysPatched) {\n            const proto = window.HTMLMediaElement.prototype;\n            try {\n                if (typeof nativeSetMediaKeys === \"function\") {\n                    proto.setMediaKeys = function patchedSetMediaKeys(mediaKeys) {\n                        if (mediaKeys) {\n                            if (EME_AUDIO_SILENCED_WHEN_ROUTED) {\n                                markElementRestricted(this);\n                                log(\"setMediaKeys: element marked DRM-restricted (WebAudio routing blocked)\");\n                            } else {\n                                log(\"setMediaKeys: EME keys attaching (Gecko: routable once attached)\");\n                            }\n                        }\n                        const setResult = nativeSetMediaKeys.apply(this, arguments);\n                        if (mediaKeys && !EME_AUDIO_SILENCED_WHEN_ROUTED) {\n                            // Gecko: route only AFTER keys attach —\n                            // setMediaKeys throws NotSupportedError on an\n                            // already-audio-captured element. On success, mark\n                            // the element routable and apply state promptly so\n                            // the route forms without waiting for the next\n                            // media event.\n                            const el = this;\n                            Promise.resolve(setResult).then(() => {\n                                try {\n                                    if (el.dataset) el.dataset.vcEmeKeysAttached = \"true\";\n                                } catch (e) {}\n                                updatePageMediaRestriction();\n                                applyMediaElementState(el);\n                            }, () => {});\n                        }\n                        return setResult;\n                    };\n                }\n                if (typeof nativeWebkitSetMediaKeys === \"function\") {\n                    proto.webkitSetMediaKeys = function patchedWebkitSetMediaKeys(mediaKeys) {\n                        if (mediaKeys) markElementRestricted(this);\n                        return nativeWebkitSetMediaKeys.apply(this, arguments);\n                    };\n                }\n                Object.defineProperty(proto, \"__volumeControlSetMediaKeysPatched\", {\n                    value: true,\n                    configurable: true,\n                    enumerable: false\n                });\n            } catch (e) {\n                log(`setMediaKeys patch failed: ${e && e.message}`);\n            }\n        }\n\n        if (window.Navigator && window.Navigator.prototype &&\n            typeof window.Navigator.prototype.requestMediaKeySystemAccess === \"function\" &&\n            !window.Navigator.prototype.__volumeControlRmksaPatched) {\n            try {\n                window.Navigator.prototype.requestMediaKeySystemAccess = function patchedRequestMediaKeySystemAccess() {\n                    const result = nativeRequestMediaKeySystemAccess.apply(this, arguments);\n                    // Only flag the page when a CDM is actually GRANTED. Players\n                    // that merely probe support and fall back to clear media\n                    // reject here and must not trip the conservative gate.\n                    try {\n                        Promise.resolve(result).then(() => {\n                            try {\n                                document.documentElement.dataset.vcPageUsesEme = \"true\";\n                            } catch (e) {}\n                            log(\"EME key system access granted — page flagged as using DRM\");\n                            // The EME+blob heuristic in isLikelyDrmMedia may\n                            // now classify tracked elements as protected.\n                            updatePageMediaRestriction();\n                        }, () => {});\n                    } catch (e) {}\n                    return result;\n                };\n                Object.defineProperty(window.Navigator.prototype, \"__volumeControlRmksaPatched\", {\n                    value: true,\n                    configurable: true,\n                    enumerable: false\n                });\n            } catch (e) {\n                log(`requestMediaKeySystemAccess patch failed: ${e && e.message}`);\n            }\n        }\n\n        // v6.13: two-level EME page detection. requestMediaKeySystemAccess\n        // resolving (above) only proves the page PROBED DRM support —\n        // app.plex.tv probes all three key systems at startup while playing\n        // clear direct-play content. The blob:-heuristic pending gate\n        // OPENS on that probe (requestMediaKeySystemAccess granted);\n        // actually constructing MediaKeys is the strong signal that\n        // setMediaKeys is imminent, so it RESETS any earned decryption\n        // proof (v6.14; v6.13 restarted the grace clock): clear media\n        // re-proves within one timeupdate (~250ms) if the element keeps\n        // progressing, while a would-be-DRM element stalls until the\n        // evidence lands.\n        if (window.MediaKeySystemAccess && window.MediaKeySystemAccess.prototype &&\n            typeof window.MediaKeySystemAccess.prototype.createMediaKeys === \"function\" &&\n            !window.MediaKeySystemAccess.prototype.__volumeControlCmkPatched) {\n            try {\n                window.MediaKeySystemAccess.prototype.createMediaKeys = function patchedCreateMediaKeys() {\n                    const result = nativeCreateMediaKeys.apply(this, arguments);\n                    try {\n                        document.documentElement.dataset.vcPageEmeActive = \"true\";\n                        log(\"MediaKeys created — page flagged as EME-active\");\n                        // The page is about to attach keys: reset the earned\n                        // progress proof for every tracked element so the\n                        // pending gate re-verifies after this point (fresh\n                        // timeupdate progress, or the imminent evidence).\n                        // Also bump a document-level sequence counter so the\n                        // ISOLATED-world content script invalidates its own\n                        // mirror of the proof (dataset is shared DOM).\n                        try {\n                            const ds = document.documentElement.dataset;\n                            ds.vcEmeResetSeq = String((Number(ds.vcEmeResetSeq) || 0) + 1);\n                        } catch (e) {}\n                        for (const element of Array.from(mediaElements)) {\n                            resetEmePending(element);\n                        }\n                        updatePageMediaRestriction();\n                        applyStateToMediaElements();\n                    } catch (e) {}\n                    return result;\n                };\n                Object.defineProperty(window.MediaKeySystemAccess.prototype, \"__volumeControlCmkPatched\", {\n                    value: true,\n                    configurable: true,\n                    enumerable: false\n                });\n            } catch (e) {\n                log(`createMediaKeys patch failed: ${e && e.message}`);\n            }\n        }\n    }\n\n    function createMediaRouteSource(context, element) {\n        // DRM-protected media must NEVER be routed through WebAudio on engines\n        // that silence protected audio (Chromium-family): the browser outputs\n        // silence for protected content in the graph while the element's native\n        // output stays detached — permanently muting the stream. On Gecko\n        // (Firefox), EME audio flows through the graph (bug 1331763), so\n        // isLikelyDrmMedia() returns false there and DRM media routes normally.\n        // Cross-origin taint, in every engine, still falls back to native\n        // volume scaling (spec-mandated silence when routed).\n        if (isLikelyDrmMedia(element)) {\n            log(`skipping MediaElementAudioSource for DRM-restricted media: ${getMediaSourceUrl(element)}`);\n            return null;\n        }\n\n        // captureStream() adds a delayed parallel copy, so blocked media falls back to native volume.\n        if (isLikelyCrossOriginMedia(element)) {\n            log(`skipping MediaElementAudioSource for cross-origin media: ${getMediaSourceUrl(element)}`);\n            return null;\n        }\n\n        try {\n            return {\n                source: markNode(context.createMediaElementSource(element)),\n                kind: \"mediaElement\",\n                muteNative: false,\n                stream: null\n            };\n        } catch (e) {\n            log(`createMediaElementSource failed: ${e && e.message}`);\n\n            // WebRTC call audio is commonly exposed through media.srcObject.\n            // Some engines/pages reject MediaElementAudioSourceNode for that\n            // element. If this was NOT the \"element already has a source node\"\n            // case, capture the MediaStream directly and silence the native\n            // element while our graph is connected so the call is not doubled.\n            const stream = getAudioMediaStream(element);\n            const alreadyOwned = e && (e.name === \"InvalidStateError\" || /already.*MediaElement/i.test(String(e.message || \"\")));\n            if (stream && !alreadyOwned && typeof context.createMediaStreamSource === \"function\") {\n                try {\n                    return {\n                        source: markNode(context.createMediaStreamSource(stream)),\n                        kind: \"mediaStream\",\n                        muteNative: true,\n                        stream\n                    };\n                } catch (streamError) {\n                    log(`createMediaStreamSource failed: ${streamError && streamError.message}`);\n                }\n            }\n        }\n\n        return null;\n    }\n\n    function readMediaSrcObject(element) {\n        try {\n            if (nativeSrcObjectDescriptor && nativeSrcObjectDescriptor.get) {\n                return nativeSrcObjectDescriptor.get.call(element);\n            }\n            return element && element.srcObject;\n        } catch (e) {\n            return null;\n        }\n    }\n\n    function isMediaStreamLike(value) {\n        return Boolean(value && typeof value.getTracks === \"function\" && typeof value.getAudioTracks === \"function\");\n    }\n\n    function getAudioMediaStream(element) {\n        const stream = readMediaSrcObject(element);\n        if (!isMediaStreamLike(stream)) return null;\n        try {\n            return stream.getAudioTracks().length ? stream : null;\n        } catch (e) {\n            return null;\n        }\n    }\n\n    function readNativeVolume(element) {\n        try {\n            if (nativeVolumeDescriptor && nativeVolumeDescriptor.get) {\n                return nativeVolumeDescriptor.get.call(element);\n            }\n        } catch (e) {\n            log(`native volume read failed: ${e && e.message}`);\n        }\n        return 1;\n    }\n\n    function setNativeVolume(element, value) {\n        const entry = getMediaState(element);\n        // An unchanged write can fire redundant player events and occasionally\n        // cause third-party volume managers to fight the extension.\n        entry.lastNativeVolume = value; // last extension-owned native write\n        if (Math.abs(readNativeVolume(element) - value) <= 0.000001) return;\n        entry.applyingVolume = true;\n        try {\n            if (nativeVolumeDescriptor && nativeVolumeDescriptor.set) {\n                nativeVolumeDescriptor.set.call(element, value);\n            }\n        } catch (e) {\n            log(`native volume set failed: ${e && e.message}`);\n        } finally {\n            entry.applyingVolume = false;\n        }\n    }\n\n    // Browser-provided video controls and isolated-world scripts can change the\n    // underlying native volume WITHOUT going through patchedVolumeSetter.\n    // Treat that real change as the player's chosen base instead of snapping\n    // the slider back to an outdated extension-stored base on volumechange.\n    function adoptNativePlayerVolume(element, entry) {\n        const actual = readNativeVolume(element);\n        if (!Number.isFinite(actual) || actual < 0 || actual > 1) return false;\n        if (Number.isFinite(entry.lastNativeVolume) &&\n            Math.abs(actual - entry.lastNativeVolume) <= 0.000001) return false;\n        entry.baseVolume = actual;\n        return true;\n    }\n\n    function getMediaState(element) {\n        let entry = mediaState.get(element);\n        if (!entry) {\n            entry = {\n                baseVolume: readNativeVolume(element),\n                applyingVolume: false,\n                lastObservedNativeMuted: readNativeMuted(element),\n                listenersInstalled: false,\n                listenerCleanup: null,\n                streamBacked: isMediaStreamLike(readMediaSrcObject(element)),\n                streamCleanup: null\n            };\n            mediaState.set(element, entry);\n        }\n        return entry;\n    }\n\n    function mediaNeedsAudioRoute() {\n        if (!state.extensionActive || !state.enabled) return false;\n        if (state.debugRouteMode === \"native\") return false;\n        if (state.debugRouteMode === \"webaudio\") return true;\n        return state.muted || state.mono || state.normalizerEnabled || getGainValue(state.dB) > 1;\n    }\n\n    function pageAudioNeedsRoute() {\n        return state.extensionActive && state.enabled && (state.muted || state.mono || state.normalizerEnabled || Number(state.dB) !== 0);\n    }\n\n    function routeRecordedDestinationConnections() {\n        if (!pageAudioNeedsRoute()) return;\n\n        for (const entry of Array.from(destinationConnections)) {\n            if (entry.routed) continue;\n            const source = nodeFromRef(entry.sourceRef);\n            const dest = nodeFromRef(entry.destinationRef);\n            if (!source || !dest) {\n                destinationConnections.delete(entry);\n                continue;\n            }\n\n            const entryContext = nodeFromRef(entry.contextRef);\n            // Re-routing implies audio should flow; revive a context we\n            // idled out or these sources would play into silence.\n            resumeIfSelfSuspended(entryContext);\n\n            const graph = ensureGraph(entryContext);\n            if (!graph) continue;\n\n            try {\n                disconnectNative(source, dest, entry.outputIndex, entry.inputIndex);\n            } catch (e) {\n                log(`native destination disconnect failed: ${e && e.message}`);\n                continue;\n            }\n\n            try {\n                connectNative(source, graph.inputAnalyser, entry.outputIndex, 0);\n                entry.routed = true;\n            } catch (e) {\n                log(`recorded destination route failed: ${e && e.message}`);\n                try {\n                    connectNative(source, dest, entry.outputIndex, entry.inputIndex);\n                    entry.routed = false;\n                } catch (rollbackError) {\n                    log(`recorded destination rollback failed: ${rollbackError && rollbackError.message}`);\n                }\n            }\n        }\n    }\n\n    function unrouteDestinationConnections() {\n        // When volume is at 0 dB with mono off, restore original source→destination\n        // connections and remove the extension's gain node from the audio path.\n        // This lets page-level AudioContexts go fully idle (no running gain node)\n        // and prevents the extension from holding Bluetooth devices active.\n        if (pageAudioNeedsRoute()) return;\n\n        for (const entry of Array.from(destinationConnections)) {\n            if (!entry.routed) continue;\n            const source = nodeFromRef(entry.sourceRef);\n            const dest = nodeFromRef(entry.destinationRef);\n            if (!source || !dest) {\n                destinationConnections.delete(entry);\n                continue;\n            }\n\n            const graph = graphs.get(nodeFromRef(entry.contextRef));\n            if (!graph) continue;\n\n            try {\n                disconnectNative(source, graph.inputAnalyser, entry.outputIndex, 0);\n            } catch (e) {\n                log(`unroute disconnect failed: ${e && e.message}`);\n                continue;\n            }\n\n            try {\n                connectNative(source, dest, entry.outputIndex, entry.inputIndex);\n                entry.routed = false;\n            } catch (e) {\n                log(`unroute reconnect failed: ${e && e.message}`);\n                try {\n                    connectNative(source, graph.inputAnalyser, entry.outputIndex, 0);\n                    entry.routed = true;\n                } catch (rollbackError) {\n                    log(`unroute rollback failed: ${rollbackError && rollbackError.message}`);\n                }\n            }\n        }\n    }\n\n    function routeHowlerGlobal() {\n        if (!pageAudioNeedsRoute()) return;\n\n        const howler = window.Howler;\n        if (!howler || !howler.ctx || !howler.masterGain) return;\n\n        const masterGain = howler.masterGain;\n        if (howlerRoutes.has(masterGain)) return;\n\n        // Howler is about to play through this context; if we idled it out\n        // earlier, revive it so the site's sounds are not swallowed.\n        resumeIfSelfSuspended(howler.ctx);\n\n        const existingRoute = findDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined);\n        if (existingRoute && existingRoute.routed) {\n            howlerRoutes.set(masterGain, { context: howler.ctx, graph: graphs.get(howler.ctx) });\n            return;\n        }\n\n        const graph = ensureGraph(howler.ctx);\n        if (!graph) return;\n\n        try {\n            disconnectNative(masterGain, howler.ctx.destination);\n        } catch (e) {\n            log(`Howler master disconnect failed: ${e && e.message}`);\n            return;\n        }\n\n        try {\n            connectNative(masterGain, graph.inputAnalyser);\n            howlerRoutes.set(masterGain, { context: howler.ctx, graph });\n            trackDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined, true);\n            log(\"Howler master gain routed\");\n        } catch (e) {\n            log(`Howler master route failed: ${e && e.message}`);\n            try {\n                connectNative(masterGain, howler.ctx.destination);\n            } catch (rollbackError) {\n                log(`Howler master rollback failed: ${rollbackError && rollbackError.message}`);\n            }\n        }\n    }\n\n    function unrouteHowlerGlobal() {\n        if (pageAudioNeedsRoute()) return;\n\n        const howler = window.Howler;\n        if (!howler || !howler.ctx || !howler.masterGain) return;\n\n        const masterGain = howler.masterGain;\n        const route = howlerRoutes.get(masterGain);\n        if (!route) return;\n\n        const entry = findDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined);\n        // unrouteDestinationConnections runs before this function and already\n        // restored masterGain -> destination when its tracked entry is no\n        // longer marked routed. Do not connect that native path a second time.\n        if (entry && !entry.routed) {\n            howlerRoutes.delete(masterGain);\n            destinationConnections.delete(entry);\n            return;\n        }\n\n        const graph = route.graph;\n        if (!graph) {\n            log(\"Howler master unroute deferred: missing routed graph\");\n            return;\n        }\n\n        try {\n            disconnectNative(masterGain, graph.inputAnalyser);\n        } catch (e) {\n            log(`Howler unroute disconnect failed: ${e && e.message}`);\n            return;\n        }\n\n        try {\n            connectNative(masterGain, howler.ctx.destination);\n            howlerRoutes.delete(masterGain);\n            if (entry) destinationConnections.delete(entry);\n            log(\"Howler master gain unrouted (restored native path)\");\n        } catch (e) {\n            log(`Howler unroute reconnect failed: ${e && e.message}`);\n            // Preserve the original audio route when reconnecting native fails.\n            // Otherwise the Howler master stays detached and the page goes\n            // silent until an unrelated playback event repairs the graph.\n            try {\n                connectNative(masterGain, graph.inputAnalyser);\n                if (entry) entry.routed = true;\n            } catch (rollbackError) {\n                log(`Howler unroute rollback failed: ${rollbackError && rollbackError.message}`);\n            }\n        }\n    }\n\n    function routeKnownAudioLibraries() {\n        // Route or unroute depending on current state. When volume returns to\n        // 0 dB with mono off, unroute so the page's audio path is native again.\n        if (pageAudioNeedsRoute()) {\n            routeHowlerGlobal();\n        } else {\n            unrouteHowlerGlobal();\n        }\n    }\n\n    function setMediaGainValue(route) {\n        const autoGain = state.normalizerEnabled ? dbToGain(route.normalizerGainDb || 0) : 1;\n        const targetGain = ((route.limiterFallbackActive || route.fallbackDirectOnly)\n            ? Math.max(0, Math.min(1, effectiveGain())) : effectiveGain() * autoGain) *\n            mediaSourceGain(route);\n\n        try {\n            const now = route.context.currentTime;\n            if (route.context.state === \"running\") {\n                // Smooth ramp to avoid audible clicks/spikes.\n                route.gain.gain.cancelScheduledValues(now);\n                route.gain.gain.setValueAtTime(route.gain.gain.value, now);\n                route.gain.gain.linearRampToValueAtTime(targetGain, now + 0.015);\n            } else {\n                route.gain.gain.value = targetGain;\n            }\n        } catch (e) {\n            log(`media gain update failed: ${e && e.message}`);\n        }\n    }\n\n    function resetMediaBoundaryGain(route) {\n        // Reusing an HTMLMediaElement keeps its previous AudioParam. The\n        // normalizer may have amplified a quiet track significantly. A\n        // 15ms ramp after the next track starts is too late to avoid a short\n        // loud burst, even when the rest of the output is limiter-protected.\n        try {\n            const param = route.gain.gain;\n            const now = route.context.currentTime;\n            const limited = route.outputConnected && !route.limiterFallbackActive &&\n                typeof route.currentMode === \"string\" && route.currentMode.endsWith(\"-limited\");\n            const manual = effectiveGain() * mediaSourceGain(route);\n            // Seeking may preserve negative automatic gain from the preceding\n            // passage. Resetting straight to manual/unity briefly makes loud\n            // material MUCH louder than it was before the seek.\n            const retainedAuto = state.normalizerEnabled\n                ? dbToGain(Math.min(0, Number(route.normalizerGainDb) || 0)) : 1;\n            const combined = manual * retainedAuto;\n            // Never expose positive gain if this path is direct or still\n            // waiting for the limiter to reconnect.\n            const safe = limited ? combined : Math.min(1, combined);\n            param.cancelScheduledValues(now);\n            param.setValueAtTime(Math.max(0, safe), now);\n            return true;\n        } catch (e) {\n            // If we cannot reset a stale boosted AudioParam, disconnect the\n            // route until a future state sync can safely reset it. The reset\n            // flag stays set to guard every attempted reconnection.\n            disconnectMediaRouteOutput(route);\n            log(`source boundary gain reset failed: ${e && e.message}`);\n            return false;\n        }\n    }\n\n    function wireMediaRoute(route) {\n        if (route.fallbackDirectOnly) {\n            // A captured MediaElementSource cannot go back to native audio.\n            // Retry a minimal source -> clamped gain -> destination chain\n            // without ever exposing positive gain outside a limiter.\n            if (route.sourceGainResetPending) {\n                if (!resetMediaBoundaryGain(route)) return;\n                route.sourceGainResetPending = false;\n            }\n            if (!clampUnprotectedOutput(route)) return;\n            if (!route.sourceConnected) {\n                try {\n                    connectNative(route.source, route.gain);\n                    route.sourceConnected = true;\n                } catch (e) {\n                    log(`media rescue source reconnect failed: ${e && e.message}`);\n                    return;\n                }\n            }\n            if (!route.outputConnected) {\n                try {\n                    connectNative(route.gain, route.context.destination);\n                    route.outputConnected = true;\n                    route.recoveryAttempts = 0;\n                } catch (e) {\n                    log(`media rescue output reconnect failed: ${e && e.message}`);\n                    return;\n                }\n            }\n            // The recovery path has no limiter: later gain updates must\n            // also remain <= unity, including when Normalize is on.\n            clampUnprotectedOutput(route);\n            if (route.outputConnected) route.recoveryAttempts = 0;\n            return;\n        }\n        if (route.sourceGainResetPending) {\n            if (!resetMediaBoundaryGain(route)) return;\n            route.sourceGainResetPending = false;\n        }\n        // A ceiling change is independent of routing/mono/boost mode.\n        configureLimiter(route);\n        // Skip the disconnect/reconnect cycle if the routing mode hasn't changed\n        // AND the output is still connected. On resume from pause, the output\n        // was disconnected by disconnectMediaRouteOutput but currentMode was\n        // not cleared, so we must fall through and reconnect.\n        const wantMode = currentRoutingMode();\n        if (route.currentMode === wantMode && route.outputConnected && !route.limiterFallbackActive) {\n            setMediaGainValue(route);\n            syncNormalizerMeterTimer();\n            route.recoveryAttempts = 0;\n            return;\n        }\n        if (!safetyLimiterRequired() && !clampDirectOutputGain(route)) return;\n\n        disconnectMediaRouteOutput(route);\n\n        try {\n            const useLimiter = safetyLimiterRequired();\n            const output = useLimiter ? route.limiter : route.context.destination;\n            if (state.extensionActive && state.enabled && state.mono) {\n                connectMonoChain(route.gain, route.splitter, route.leftGain, route.rightGain, route.merger, output);\n            } else {\n                connectNative(route.gain, output);\n            }\n            if (useLimiter) {\n                configureLimiter(route);\n                connectNative(route.limiter, route.analyser);\n                connectNative(route.analyser, route.context.destination);\n            }\n            route.outputConnected = true;\n            route.recoveryAttempts = 0;\n            route.currentMode = wantMode;\n            route.limiterFallbackActive = false;\n        } catch (e) {\n            route.currentMode = null;\n            disconnectMediaRouteOutput(route);\n            if (clampUnprotectedOutput(route)) {\n                try {\n                    connectNative(route.gain, route.context.destination);\n                    route.outputConnected = true;\n                } catch (fallbackError) {\n                    log(`media route fallback failed: ${fallbackError && fallbackError.message}`);\n                }\n            }\n            log(`media graph wire failed: ${e && e.message}`);\n        }\n        setMediaGainValue(route);\n        // Playback often starts after the initial setState when no route\n        // existed. Start the 100ms meter as soon as a usable graph connects.\n        // Without this, a paused-on-load video never starts normalization.\n        if (route.outputConnected) syncNormalizerMeterTimer();\n    }\n\n    function scheduleMediaRouteRecovery(element, route) {\n        // Unlike an irreversible MediaElementSource, a disconnected direct\n        // MediaStream route has a working native output. Do not leave that\n        // native output stuck at volume zero while retrying a failed graph.\n        if (route && route.muteNative && !route.outputConnected) {\n            setNativeVolume(element, nativeVolumeForBase(element, getMediaState(element).baseVolume));\n        }\n        if (!route || route.outputConnected || route.recoveryTimer ||\n            (route.recoveryAttempts || 0) >= 6 ||\n            !route.context || route.context.state === \"closed\") return;\n\n        // No second createMediaElementSource is possible. A transient\n        // connect() failure must retry the SAME captured node even when the\n        // player is already playing and will not emit another play event.\n        route.recoveryTimer = setTimeout(() => {\n            route.recoveryTimer = null;\n            if (mediaRoutes.get(element) !== route ||\n                route.context.state === \"closed\" || route.outputConnected) return;\n            route.recoveryAttempts = (route.recoveryAttempts || 0) + 1;\n            wireMediaRoute(route);\n            if (route.outputConnected) {\n                route.recoveryAttempts = 0;\n                // Once captured audio becomes audible again, suppress the\n                // parallel native output to prevent duplicate/echoed playback.\n                if (route.muteNative) setNativeVolume(element, 0);\n                // A paused source may reconnect successfully while the\n                // context is suspended. Do not awaken the audio device until\n                // playback actually resumes.\n                if (isMediaPlaying(element)) resumeContext(route.context);\n            } else {\n                scheduleMediaRouteRecovery(element, route);\n            }\n        }, 250);\n    }\n\n    function ensureMediaRoute(element) {\n        if (!mediaNeedsAudioRoute() || !isAudibleMediaElement(element)) return null;\n        if (isLikelyDrmMedia(element)) return null;\n        if (mediaRoutes.has(element)) {\n            const existing = mediaRoutes.get(element);\n            if (existing && existing.context && existing.context.state === \"closed\") {\n                if (existing.sourceKind === \"mediaStream\") {\n                    // createMediaStreamSource(stream) is repeatable on another\n                    // AudioContext, unlike createMediaElementSource(element).\n                    // Only this kind can be discarded and safely rebuilt.\n                    resetDirectMediaStreamRoute(element);\n                } else {\n                    log(`media route context is closed -- element audio is dead until page reload: ${getMediaSourceUrl(element) || element.tagName}`);\n                    return existing;\n                }\n            } else {\n                return existing;\n            }\n        }\n\n        // Cross-origin media without CORS cannot enter WebAudio at all.\n        // Check before constructing an AudioContext and eight graph nodes:\n        // a blocked route must not hold an unnecessary audio-device handle.\n        if (isLikelyCrossOriginMedia(element)) return null;\n\n        const context = getMediaContext();\n        if (!context) return null;\n\n        let routeSource = null;\n        let route = null;\n        try {\n            // Build every fallible node and allocate the analyser buffers BEFORE\n            // createMediaElementSource(). Once that call succeeds, native output\n            // is permanently redirected; a later allocation failure must not\n            // strand the element without a usable WebAudio path.\n            const gain = markNode(context.createGain());\n            const inputAnalyser = markNode(context.createAnalyser());\n            const splitter = markNode(context.createChannelSplitter(2));\n            const leftGain = markNode(context.createGain());\n            const rightGain = markNode(context.createGain());\n            const merger = markNode(context.createChannelMerger(2));\n            const limiter = markNode(context.createDynamicsCompressor());\n            const analyser = markNode(context.createAnalyser());\n\n            gain.channelInterpretation = \"speakers\";\n            leftGain.gain.value = 0.5;\n            rightGain.gain.value = 0.5;\n            analyser.fftSize = 1024;\n            analyser.smoothingTimeConstant = 0.35;\n            inputAnalyser.fftSize = 8192;\n            inputAnalyser.smoothingTimeConstant = 0.35;\n            // No positive gain until the limiter is actually wired.\n            gain.gain.value = Math.max(0, Math.min(1, effectiveGain()));\n            const meterBuffer = new Float32Array(analyser.fftSize);\n            const inputBuffer = new Float32Array(inputAnalyser.fftSize);\n            connectNative(inputAnalyser, gain);\n\n            routeSource = createMediaRouteSource(context, element);\n            if (!routeSource) return null;\n\n            route = {\n                context,\n                source: routeSource.source,\n                gain,\n                inputAnalyser,\n                splitter,\n                leftGain,\n                rightGain,\n                merger,\n                limiter,\n                analyser,\n                normalizerGainDb: 0,\n                meterPeakDb: -Infinity,\n                meterBuffer,\n                inputBuffer,\n                sourceKind: routeSource.kind,\n                element, // direct MediaStream routes need the player's base volume/mute\n                muteNative: Boolean(routeSource.muteNative),\n                stream: routeSource.stream || null,\n                outputConnected: false,\n                currentMode: null,\n                limiterFallbackActive: false\n            };\n            // Retain ownership BEFORE connecting the irreversible source, so\n            // a failed connection can be recovered without constructing a\n            // second MediaElementAudioSourceNode for this element.\n            mediaRoutes.set(element, route);\n            // Initialize before first decoded sample, not after a timer tick.\n            gain.gain.value = Math.max(0, Math.min(1, effectiveGain())) * mediaSourceGain(route);\n            connectNative(route.source, inputAnalyser);\n            log(`media route attached (${route.sourceKind}): ${element.currentSrc || element.src || element.tagName}`);\n            return route;\n        } catch (e) {\n            log(`media route failed: ${e && e.message}`);\n            if (routeSource && route) {\n                // Source capture already happened. Retain the existing route\n                // and recover with a gain-clamped direct connection. If that\n                // also fails, keep it disconnected and retry at the next\n                // playback/state update rather than leaking unbounded gain.\n                route.fallbackDirectOnly = true;\n                route.currentMode = \"rescue-direct\";\n                route.outputConnected = false;\n                route.sourceConnected = false;\n                safeDisconnect(route.source);\n                safeDisconnect(route.inputAnalyser);\n                safeDisconnect(route.gain);\n                mediaRoutes.set(element, route);\n                wireMediaRoute(route);\n                if (!route.outputConnected) scheduleMediaRouteRecovery(element, route);\n                return route;\n            }\n            return null;\n        }\n    }\n\n    // Rate-limited fallback write shared by the paused and playing paths.\n    // 250ms spacing bounds the write war against site volume managers, but a\n    // SKIPPED correction is never dropped: sites reset element.volume on\n    // track changes / replays, and if no further media event fires (event\n    // starvation — YouTube auto-next in shuffled playlists, Facebook reels\n    // replays) the reset volume would stick for seconds or until the user\n    // manually moves the slider (issue #71). Schedule the corrective write\n    // for the first allowed moment instead.\n    function writeFallbackVolume(element, entry, wantedVolume, immediate = false) {\n        const now = Date.now();\n        if (immediate || entry.lastFallbackWriteAt === undefined || now - entry.lastFallbackWriteAt >= 250) {\n            entry.lastFallbackWriteAt = now;\n            entry.pendingFallbackVolume = null;\n            setNativeVolume(element, wantedVolume);\n            return;\n        }\n        entry.pendingFallbackVolume = wantedVolume;\n        if (!entry.fallbackCorrectionTimer) {\n            const wait = Math.max(0, 250 - (now - entry.lastFallbackWriteAt)) + 1;\n            entry.fallbackCorrectionTimer = setTimeout(() => {\n                entry.fallbackCorrectionTimer = null;\n                // Re-run the full apply so the CURRENT state + baseVolume win.\n                try { applyMediaElementState(element); } catch (e) {}\n            }, wait);\n        }\n    }\n\n    function applyMediaElementState(element, options = {}) {\n        if (!isMediaElement(element)) return;\n\n        const entry = getMediaState(element);\n        const gain = effectiveGain();\n        // Unlike MediaElementSource, a direct stream source can safely be\n        // constructed on a new context if the old one was closed. Clear the\n        // stale route before selecting the existingRoute fast-path below.\n        const previousRoute = mediaRoutes.get(element);\n        if (previousRoute && previousRoute.sourceKind === \"mediaStream\") {\n            if (!state.extensionActive || !state.enabled) {\n                // Direct capture can be undone; preserve native player controls.\n                resetDirectMediaStreamRoute(element);\n                setNativeVolume(element, entry.baseVolume);\n                return;\n            }\n            if (previousRoute.context && previousRoute.context.state === \"closed\") {\n                resetDirectMediaStreamRoute(element);\n            }\n        }\n        const existingRoute = mediaRoutes.get(element);\n        const playing = isMediaPlaying(element);\n        const audible = isAudibleMediaElement(element);\n\n        if (!playing || !audible) {\n            // Keep an existing WebAudio route associated with a reused element.\n            // The context can still suspend while idle, but source transitions\n            // no longer restore an unscaled native volume between playlist items.\n            if (existingRoute) {\n                setNativeVolume(element, existingRoute.muteNative ? 0 : entry.baseVolume);\n                wireMediaRoute(existingRoute);\n                if (existingRoute.muteNative && !existingRoute.outputConnected) {\n                    setNativeVolume(element, nativeVolumeForBase(element, entry.baseVolume));\n                }\n                if (!existingRoute.outputConnected) scheduleMediaRouteRecovery(element, existingRoute);\n                return;\n            }\n\n            // WebRTC/MediaStream-backed elements are captured eagerly. Remote\n            // call audio can begin without a normal URL-backed play() path, so\n            // waiting for a later media event misses the call entirely on some\n            // sites (Snapchat Web is one example).\n            const eagerRequested = state.debugRouteMode === \"webaudio\" || options.eagerRoute || entry.streamBacked;\n            if (eagerRequested && audible && mediaNeedsAudioRoute()) {\n                const eagerRoute = ensureMediaRoute(element);\n                if (eagerRoute) {\n                    setNativeVolume(element, eagerRoute.muteNative ? 0 : entry.baseVolume);\n                    wireMediaRoute(eagerRoute);\n                    if (eagerRoute.muteNative && !eagerRoute.outputConnected) {\n                        setNativeVolume(element, nativeVolumeForBase(element, entry.baseVolume));\n                    }\n                    return;\n                }\n            }\n\n            const nativeVolume = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));\n            writeFallbackVolume(element, entry, nativeVolume, Boolean(options.immediateFallback));\n            return;\n        }\n\n        // ensureMediaRoute internally checks mediaNeedsAudioRoute(), so we\n        // just call it when a route might be needed. The old `forceRoute`\n        // parameter was a no-op (ensureMediaRoute ignored it) and has been\n        // removed to avoid confusion.\n        const route = existingRoute || (mediaNeedsAudioRoute()\n            ? ensureMediaRoute(element)\n            : null);\n\n        if (route) {\n            if (entry.fallbackCorrectionTimer) {\n                clearTimeout(entry.fallbackCorrectionTimer);\n                entry.fallbackCorrectionTimer = null;\n            }\n            entry.pendingFallbackVolume = null;\n            // Restore native volume BEFORE wiring the route so the WebAudio gain\n            // is the only scaling applied. If we wire first, there is a brief\n            // moment where effective volume = fallbackScaledVolume × gain, which\n            // causes an audible dip-then-snap spike.\n            setNativeVolume(element, route.muteNative ? 0 : entry.baseVolume);\n            wireMediaRoute(route);\n            if (route.muteNative && !route.outputConnected) {\n                setNativeVolume(element, nativeVolumeForBase(element, entry.baseVolume));\n            }\n            if (!route.outputConnected) scheduleMediaRouteRecovery(element, route);\n            // After wireMediaRoute, output should be reconnected. If the context\n            // was suspended (e.g. after pause), resume it so audio flows again.\n            if (route.outputConnected) resumeContext(route.context);\n            else setTimeout(suspendMediaContextIfIdle, 250);\n            return;\n        }\n\n        const fallbackVolume = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));\n        // Rate-limit our own fallback writes: some sites run volume managers\n        // that write their own value back on every volumechange (normalizers,\n        // \"smart volume\" features). Without a floor between our writes that\n        // escalates into a write war at event-loop speed (audible flutter +\n        // CPU churn). 250ms bounds the war while staying imperceptible. A\n        // skipped write schedules a deferred correction instead of dropping\n        // (issue #71 — see writeFallbackVolume).\n        writeFallbackVolume(element, entry, fallbackVolume, Boolean(options.immediateFallback));\n    }\n\n    function detachMediaElementListeners(element) {\n        const entry = mediaState.get(element);\n        if (!entry) return;\n        if (entry.listenerCleanup) {\n            try { entry.listenerCleanup(); } catch (e) {}\n            entry.listenerCleanup = null;\n        }\n        entry.listenersInstalled = false;\n        if (entry.streamCleanup) {\n            try { entry.streamCleanup(); } catch (e) {}\n            entry.streamCleanup = null;\n        }\n        entry.streamBacked = false;\n        entry.observedStream = null;\n    }\n\n    function cleanupTrackedMediaElement(element) {\n        const entry = mediaState.get(element);\n        if (entry) {\n            detachMediaElementListeners(element);\n            if (entry.fallbackCorrectionTimer) {\n                clearTimeout(entry.fallbackCorrectionTimer);\n                entry.fallbackCorrectionTimer = null;\n            }\n            entry.pendingFallbackVolume = null;\n        }\n        const route = mediaRoutes.get(element);\n        if (route) {\n            cancelMediaRouteRecovery(route);\n            disconnectMediaRouteOutput(route);\n\n            // A detached paused element may later autoplay again without\n            // being reinserted in the DOM or calling the patched play().\n            // Retain a one-shot event wake-up on the ELEMENT, not a strong\n            // global Set entry. Otherwise its captured MediaElementSource\n            // remains disconnected forever after idle cleanup.\n            if (!element.isConnected && typeof element.addEventListener === \"function\" &&\n                entry && !entry.detachedPlayWake) {\n                const wake = () => {\n                    entry.detachedPlayWake = null;\n                    try { element.removeEventListener(\"play\", wake); } catch (e) {}\n                    registerMediaElement(element, { immediateFallback: true, eagerRoute: true });\n                };\n                entry.detachedPlayWake = wake;\n                element.addEventListener(\"play\", wake, { once: true, passive: true });\n            }\n        }\n        mediaElements.delete(element);\n    }\n\n    // Returns true if an element that was removed from the DOM can still be\n    // heard. Sites like YouTube/Twitch/Twitter detach their <video> element\n    // during player rebuilds and ad transitions WHILE IT KEEPS PLAYING, and\n    // a detached media element keeps producing audio without being in the\n    // DOM. If we stopped tracking such an element, its route gain would\n    // freeze at whatever boost was active when it was detached — a stale\n    // +32 dB \"earrape\" boost that ignores every later volume change.\n    function isDetachedButAudible(element) {\n        if (element.isConnected) return false;\n        if (!isMediaPlaying(element)) return false;\n        const route = mediaRoutes.get(element);\n        if (route && route.outputConnected) return true;   // routed and live\n        return isAudibleMediaElement(element);             // native output audible\n    }\n\n    function applyStateToMediaElements() {\n        for (const element of Array.from(mediaElements)) {\n            if (!element.isConnected) {\n                // Detached element: keep updating it for as long as it can\n                // still be heard. Only drop it once it is truly quiescent.\n                if (isDetachedButAudible(element)) {\n                    applyMediaElementState(element);\n                    continue;\n                }\n                cleanupTrackedMediaElement(element);\n                continue;\n            }\n            applyMediaElementState(element);\n        }\n        updatePageMediaRestriction();\n        syncNormalizerMeterTimer();\n    }\n\n    function registerMediaElement(element, options = {}) {\n        if (!isMediaElement(element)) return element;\n\n        try {\n            if (element.dataset) element.dataset[MEDIA_MANAGED_ATTR] = \"true\";\n        } catch (e) {\n            log(`media marker failed: ${e && e.message}`);\n        }\n\n        mediaElements.add(element);\n        updatePageMediaRestriction();\n        const entry = getMediaState(element);\n        // A stream can be attached before page hooks are installed or\n        // replaced through a saved native setter. Bind lifecycle on discovery.\n        const currentStream = readMediaSrcObject(element);\n        if (entry.observedStream !== currentStream) {\n            if (entry.observedStream !== undefined) resetDirectMediaStreamRoute(element);\n            bindMediaStreamLifecycle(element, currentStream);\n        }\n        // DOM reinsertion or patched play() can register an element before the\n        // detached wake fires. Remove that obsolete one-shot listener.\n        if (entry.detachedPlayWake) {\n            try { element.removeEventListener(\"play\", entry.detachedPlayWake); } catch (e) {}\n            entry.detachedPlayWake = null;\n        }\n        if (!entry.listenersInstalled && typeof element.addEventListener === \"function\") {\n            const listenerCleanup = [];\n            const listen = (type, handler, options) => {\n                element.addEventListener(type, handler, options);\n                listenerCleanup.push(() => element.removeEventListener(type, handler, options));\n            };\n\n            // DRM detection: the moment the pipeline reports encrypted init\n            // data, flag the element (sticky) so neither this hook nor the\n            // content script ever routes it through WebAudio.\n            listen(\"encrypted\", () => {\n                markElementRestricted(element);\n                log(\"encrypted event: element marked DRM-restricted (WebAudio routing blocked)\");\n            }, { passive: true });\n            // v6.14: re-run the routing decision at timeupdate cadence\n            // (~4Hz in real browsers). The EME pending gate clears on\n            // playback progress (decryption proof) — this is what turns a\n            // pending suspect into routable clear media within a couple\n            // hundred milliseconds instead of a blind multi-second grace\n            // timer (v6.13's 3s, the source of the \"boost takes 3 seconds\n            // to kick in on Plex\" report). Cheap guards keep this a no-op\n            // for routed/restricted/non-suspect elements.\n            listen(\"timeupdate\", () => {\n                if (mediaRoutes.has(element)) return;      // already routed\n                if (!isPendingEmeSuspect(element)) return; // cheap probe+src gate\n                if (!state.forceDrmCapture && elementDrmEvidence(element)) return;\n                applyMediaElementState(element);\n            }, { passive: true });\n            // Keep the aggregate page restriction fresh as this element's\n            // lifecycle (src assignment, play, pause, ended) progresses.\n            listen(\"loadedmetadata\", updatePageMediaRestriction, { passive: true });\n            listen(\"play\", updatePageMediaRestriction, { passive: true });\n            listen(\"emptied\", updatePageMediaRestriction, { passive: true });\n            const applyOnPlay = () => {\n                mediaElements.add(element);\n                applyMediaElementState(element, { immediateFallback: true, eagerRoute: true });\n            };\n            const suspendWhenIdle = () => {\n                // Preserve the graph across pauses/source changes. The idle sweep\n                // may suspend the context later, but does not restore full native\n                // volume during a playlist transition.\n                setTimeout(suspendMediaContextIfIdle, 250);\n            };\n            const applyOnVolumeChange = () => {\n                const currentEntry = getMediaState(element);\n                // volumechange also fires for media.muted transitions, even if\n                // media.volume did not change. Handle mute/unmute independently\n                // or a player's native mute button can leave route state stale.\n                const nativeMuted = readNativeMuted(element);\n                const muteChanged = nativeMuted !== currentEntry.lastObservedNativeMuted;\n                currentEntry.lastObservedNativeMuted = nativeMuted;\n                // Ignore our own queued volume writes, but allow native player\n                // volume and mute changes even immediately after our writes.\n                const volumeChanged = adoptNativePlayerVolume(element, currentEntry);\n                if (!volumeChanged && !muteChanged) return;\n                applyMediaElementState(element, { immediateFallback: true, eagerRoute: true });\n                setTimeout(suspendMediaContextIfIdle, 250);\n            };\n            const sourceBoundary = () => {\n                // Source/replay changes re-earn EME proof but keep the same\n                // extension route and gain attached to the reused media element.\n                resetEmePending(element);\n                const route = mediaRoutes.get(element);\n                if (route) {\n                    // A reused HTMLMediaElement keeps its WebAudio route across\n                    // playlist transitions. Do not carry automatic boost from\n                    // a quiet track into the next (potentially loud) track.\n                    route.normalizerGainDb = 0;\n                    route.musicLevelState = null;\n                    route.meterPeakDb = -Infinity;\n                    route.sourceGainResetPending = true;\n                    setNativeVolume(element, route.muteNative ? 0 : getMediaState(element).baseVolume);\n                    wireMediaRoute(route);\n                    if (!route.outputConnected) scheduleMediaRouteRecovery(element, route);\n                } else {\n                    applyMediaElementState(element, { immediateFallback: true, eagerRoute: true });\n                }\n                setTimeout(suspendMediaContextIfIdle, 250);\n            };\n\n            const resetGainOnSeek = () => {\n                if (!state.normalizerEnabled || !state.extensionActive || !state.enabled) return;\n                const route = mediaRoutes.get(element);\n                if (!route) return;\n                // A seek within the same URL can jump straight from quiet\n                // material into a full-volume chorus. Do not carry positive\n                // automatic gain through the discontinuity; the next 100 ms\n                // detector tick cannot protect the very first audio block.\n                // Seeking is NOT a media source/DRM boundary.\n                // Discard potentially dangerous positive auto gain, but\n                // retain attenuation so a seek within a loud song cannot\n                // briefly jump back up to full-scale volume.\n                route.normalizerGainDb = Math.min(0, Number(route.normalizerGainDb) || 0);\n                route.musicLevelState = null;\n                route.meterPeakDb = -Infinity;\n                route.sourceGainResetPending = true;\n                wireMediaRoute(route);\n                if (!route.outputConnected) scheduleMediaRouteRecovery(element, route);\n            };\n            listen(\"seeking\", resetGainOnSeek, { passive: true });\n            listen(\"play\", applyOnPlay, { passive: true });\n            listen(\"playing\", applyOnPlay, { passive: true });\n            listen(\"volumechange\", applyOnVolumeChange, { passive: true });\n            listen(\"pause\", suspendWhenIdle, { passive: true });\n            listen(\"ended\", sourceBoundary, { passive: true });\n            listen(\"emptied\", sourceBoundary, { passive: true });\n            listen(\"error\", sourceBoundary, { passive: true });\n            entry.listenerCleanup = () => {\n                for (const cleanup of listenerCleanup.splice(0)) {\n                    try { cleanup(); } catch (e) {}\n                }\n            };\n            entry.listenersInstalled = true;\n        }\n        applyMediaElementState(element, options);\n        return element;\n    }\n\n    function scanMediaElements(root) {\n        try {\n            const scope = root && root.querySelectorAll ? root : document;\n            for (const element of scope.querySelectorAll(\"audio, video\")) {\n                registerMediaElement(element);\n            }\n        } catch (e) {\n            log(`media scan failed: ${e && e.message}`);\n        }\n    }\n\n    // Elements inserted after DOMContentLoaded via innerHTML/insertAdjacentHTML\n    // (template rendering, jQuery .html()) never pass through the patched\n    // createElement; driven only through native controls, neither the patched\n    // play() nor the volume setter ever runs for them — invisible to boost AND\n    // to the restriction aggregate. Register any audio/video the moment it\n    // enters the (light) DOM so our per-element listeners take over from there.\n    function watchForInjectedMediaElements() {\n        if (typeof MutationObserver === \"undefined\") return null;\n        const registerNode = (node) => {\n            if (!node || node.nodeType !== 1) return;\n            const tag = node.tagName;\n            if (tag === \"AUDIO\" || tag === \"VIDEO\") {\n                registerMediaElement(node);\n                return;\n            }\n            if (!node.querySelectorAll) return;\n            try {\n                const found = node.querySelectorAll(\"audio, video\");\n                for (const element of found) registerMediaElement(element);\n            } catch (e) {}\n        };\n        const observer = new MutationObserver((mutations) => {\n            for (const mutation of mutations) {\n                const added = mutation.addedNodes;\n                if (!added || !added.length) continue;\n                for (let i = 0; i < added.length; i++) {\n                    registerNode(added[i]);\n                }\n            }\n        });\n        const startObserving = () => {\n            try {\n                observer.observe(document.documentElement || document, { childList: true, subtree: true });\n            } catch (e) {}\n        };\n        if (document.documentElement) startObserving();\n        else document.addEventListener(\"DOMContentLoaded\", startObserving, { once: true });\n        return observer;\n    }\n\n    function patchAudioNodeRouting() {\n        if (!AudioNodePrototype || !nativeConnect || AudioNodePrototype.__volumeControlPatched) return;\n\n        AudioNodePrototype.connect = function patchedConnect(destination, outputIndex, inputIndex) {\n            if (isContextDestination(destination) && !vcNodes.has(this)) {\n                const context = this.context || destination.context;\n                // The page is (re)connecting something to the destination — it\n                // wants audio NOW. If we idled this context out (Bluetooth\n                // sweep), revive it before routing, otherwise the new sound\n                // would play into a suspended context (silent SFX bug).\n                resumeIfSelfSuspended(context);\n                const graph = (graphs.has(context) || pageAudioNeedsRoute()) ? ensureGraph(context) : null;\n                if (graph) {\n                    const entry = trackDestinationConnection(this, destination, outputIndex, inputIndex, true);\n                    try {\n                        connectNative(this, graph.inputAnalyser, outputIndex, 0);\n                        syncNormalizerMeterTimer();\n                        return destination;\n                    } catch (e) {\n                        entry.routed = false;\n                        log(`live destination route failed, using native path: ${e && e.message}`);\n                        return nativeConnect.apply(this, arguments);\n                    }\n                }\n\n                trackDestinationConnection(this, destination, outputIndex, inputIndex, false);\n            }\n\n            return nativeConnect.apply(this, arguments);\n        };\n\n        if (nativeDisconnect) {\n            AudioNodePrototype.disconnect = function patchedDisconnect(destination) {\n                if (vcNodes.has(this)) return nativeDisconnect.apply(this, arguments);\n\n                if (arguments.length === 0) {\n                    removeDestinationConnectionsForSource(this);\n                    return nativeDisconnect.apply(this, arguments);\n                }\n\n                // Standard overload: disconnect(outputIndex)\n                if (typeof destination === \"number\") {\n                    const outputIndex = destination;\n                    takeDestinationConnections(this, entry => entry.outputIndex === outputIndex);\n                    return nativeDisconnect.apply(this, arguments);\n                }\n\n                if (isContextDestination(destination)) {\n                    const outputIndex = arguments[1];\n                    const inputIndex = arguments[2];\n                    const matches = takeDestinationConnections(this, entry => {\n                        if (nodeFromRef(entry.destinationRef) !== destination) return false;\n                        if (arguments.length >= 2 && entry.outputIndex !== outputIndex) return false;\n                        if (arguments.length >= 3 && entry.inputIndex !== inputIndex) return false;\n                        return true;\n                    });\n\n                    if (matches.length) {\n                        let hadNative = false;\n                        for (const entry of matches) {\n                            if (entry.routed) disconnectTrackedRouteEntry(this, entry);\n                            else hadNative = true;\n                        }\n                        // Routed connections no longer point at the page's\n                        // destination, so calling native disconnect(destination)\n                        // for an all-routed set can throw InvalidAccessError.\n                        if (!hadNative) return undefined;\n                    }\n                }\n\n                return nativeDisconnect.apply(this, arguments);\n            };\n        }\n\n        Object.defineProperty(AudioNodePrototype, \"__volumeControlPatched\", {\n            value: true,\n            configurable: true,\n            enumerable: false\n        });\n    }\n\n    function nativeVolumeForBase(element, baseVolume) {\n        const base = Math.max(0, Math.min(1, Number(baseVolume) || 0));\n        if (!state.extensionActive || !state.enabled) return base;\n        const route = mediaRoutes.get(element);\n        if (route) {\n            // Do not unmute the native duplicate of an active direct stream.\n            if (route.muteNative && route.outputConnected) return 0;\n            if (route.muteNative) return Math.max(0, Math.min(1, base * Math.min(effectiveGain(), 1)));\n            return base;\n        }\n\n        // Native fallback applies only attenuation/mute. The page still reads\n        // baseVolume from our patched getter, so its own volume is independent\n        // from Volume Control's dB adjustment.\n        const gain = effectiveGain();\n        return Math.max(0, Math.min(1, base * Math.min(gain, 1)));\n    }\n\n    function patchMediaVolume() {\n        if (!nativeVolumeDescriptor || !nativeVolumeDescriptor.get || !nativeVolumeDescriptor.set) return;\n        if (window.HTMLMediaElement.prototype.__volumeControlVolumePatched) return;\n\n        try {\n            Object.defineProperty(window.HTMLMediaElement.prototype, \"volume\", {\n                configurable: true,\n                enumerable: nativeVolumeDescriptor.enumerable,\n                get: function patchedVolumeGetter() {\n                    const entry = mediaState.get(this);\n                    return entry ? entry.baseVolume : nativeVolumeDescriptor.get.call(this);\n                },\n                set: function patchedVolumeSetter(value) {\n                    const n = Number(value);\n\n                    // Preserve native HTMLMediaElement semantics. Browsers throw\n                    // for NaN/Infinity and values outside 0..1; silently\n                    // clamping here broke sites that intentionally rely on that\n                    // exception behavior.\n                    if (!Number.isFinite(n) || n < 0 || n > 1) {\n                        nativeVolumeDescriptor.set.call(this, value);\n                        return;\n                    }\n\n                    const entry = getMediaState(this);\n                    if (entry.applyingVolume) {\n                        nativeVolumeDescriptor.set.call(this, n);\n                        return;\n                    }\n\n                    entry.baseVolume = n;\n\n                    // Apply the extension-adjusted native target immediately.\n                    // The site's requested value remains entry.baseVolume, so a\n                    // playlist item setting video.volume = 1 cannot briefly\n                    // bypass negative dB attenuation.\n                    const nativeTarget = nativeVolumeForBase(this, entry.baseVolume);\n                    setNativeVolume(this, nativeTarget);\n\n                    registerMediaElement(this);\n                }\n            });\n\n            Object.defineProperty(window.HTMLMediaElement.prototype, \"__volumeControlVolumePatched\", {\n                value: true,\n                configurable: true,\n                enumerable: false\n            });\n        } catch (e) {\n            log(`media volume patch failed: ${e && e.message}`);\n        }\n    }\n\n    function resetDirectMediaStreamRoute(element) {\n        const route = mediaRoutes.get(element);\n        if (!route || route.sourceKind !== \"mediaStream\") return;\n        cancelMediaRouteRecovery(route);\n        disconnectMediaRouteOutput(route);\n        safeDisconnect(route.source);\n        mediaRoutes.delete(element);\n    }\n\n    function bindMediaStreamLifecycle(element, stream) {\n        const entry = getMediaState(element);\n        if (entry.streamCleanup) {\n            try { entry.streamCleanup(); } catch (e) {}\n            entry.streamCleanup = null;\n        }\n\n        entry.observedStream = stream;\n        entry.streamBacked = isMediaStreamLike(stream);\n        if (!entry.streamBacked || typeof stream.addEventListener !== \"function\") return;\n\n        const refresh = (event) => {\n            // Webcam video track switches do not change the captured audio.\n            // Rebuilding the audio graph on every video-only add/removetrack\n            // causes unnecessary call-audio gaps and device wake-ups.\n            if (event && event.track && event.track.kind !== \"audio\") return;\n            resetDirectMediaStreamRoute(element);\n            entry.streamBacked = isMediaStreamLike(readMediaSrcObject(element));\n            registerMediaElement(element, { immediateFallback: true, eagerRoute: true });\n        };\n        stream.addEventListener(\"addtrack\", refresh);\n        stream.addEventListener(\"removetrack\", refresh);\n        entry.streamCleanup = () => {\n            stream.removeEventListener(\"addtrack\", refresh);\n            stream.removeEventListener(\"removetrack\", refresh);\n        };\n    }\n\n    function patchMediaSrcObject() {\n        if (!nativeSrcObjectDescriptor || !nativeSrcObjectDescriptor.get || !nativeSrcObjectDescriptor.set) return;\n        if (window.HTMLMediaElement.prototype.__volumeControlSrcObjectPatched) return;\n\n        try {\n            Object.defineProperty(window.HTMLMediaElement.prototype, \"srcObject\", {\n                configurable: true,\n                enumerable: nativeSrcObjectDescriptor.enumerable,\n                get: function patchedSrcObjectGetter() {\n                    return nativeSrcObjectDescriptor.get.call(this);\n                },\n                set: function patchedSrcObjectSetter(value) {\n                    // The native setter can throw (invalid srcObject type).\n                    // Never destroy the EXISTING audible route until the\n                    // replacement is accepted; otherwise a rejected update\n                    // leaves the old stream attached with its output severed.\n                    const previous = readMediaSrcObject(this);\n                    nativeSrcObjectDescriptor.set.call(this, value);\n                    if (previous !== value) resetDirectMediaStreamRoute(this);\n                    bindMediaStreamLifecycle(this, value);\n                    registerMediaElement(this, { immediateFallback: true, eagerRoute: true });\n                    log(`srcObject assigned (${isMediaStreamLike(value) ? \"MediaStream\" : typeof value})`);\n                }\n            });\n\n            Object.defineProperty(window.HTMLMediaElement.prototype, \"__volumeControlSrcObjectPatched\", {\n                value: true,\n                configurable: true,\n                enumerable: false\n            });\n        } catch (e) {\n            log(`srcObject patch failed: ${e && e.message}`);\n        }\n    }\n\n    function patchMediaPlayback() {\n        if (!window.HTMLMediaElement || !nativePlay) return;\n        if (window.HTMLMediaElement.prototype.__volumeControlPlayPatched) return;\n\n        window.HTMLMediaElement.prototype.play = function patchedPlay() {\n            registerMediaElement(this);\n            const route = mediaRoutes.get(this);\n            if (route) {\n                wireMediaRoute(route);\n                resumeContext(route.context);\n            }\n            return nativePlay.apply(this, arguments);\n        };\n\n        Object.defineProperty(window.HTMLMediaElement.prototype, \"__volumeControlPlayPatched\", {\n            value: true,\n            configurable: true,\n            enumerable: false\n        });\n    }\n\n    function patchAudioConstructor() {\n        if (!nativeAudioConstructor || nativeAudioConstructor.__volumeControlPatched) return;\n        // If the page installed its own Audio constructor wrapper while we were\n        // disabled, do not overwrite it on re-enable.\n        if (window.Audio !== nativeAudioConstructor && !(window.Audio && window.Audio.__volumeControlPatched)) return;\n\n        try {\n            function VolumeControlAudio(src) {\n                const element = arguments.length > 0\n                    ? new nativeAudioConstructor(src)\n                    : new nativeAudioConstructor();\n                return registerMediaElement(element);\n            }\n\n            Object.setPrototypeOf(VolumeControlAudio, nativeAudioConstructor);\n            VolumeControlAudio.prototype = nativeAudioConstructor.prototype;\n\n            Object.defineProperty(VolumeControlAudio, \"__volumeControlPatched\", {\n                value: true,\n                configurable: true,\n                enumerable: false\n            });\n\n            window.Audio = VolumeControlAudio;\n        } catch (e) {\n            log(`Audio constructor patch failed: ${e && e.message}`);\n        }\n    }\n\n    function patchElementCreation() {\n        if (!window.Document || window.Document.prototype.__volumeControlCreateElementPatched) return;\n\n        try {\n            window.Document.prototype.createElement = function patchedCreateElement() {\n                const element = nativeCreateElement.apply(this, arguments);\n                return registerMediaElement(element);\n            };\n\n            if (nativeCreateElementNS) {\n                window.Document.prototype.createElementNS = function patchedCreateElementNS() {\n                    const element = nativeCreateElementNS.apply(this, arguments);\n                    return registerMediaElement(element);\n                };\n            }\n\n            Object.defineProperty(window.Document.prototype, \"__volumeControlCreateElementPatched\", {\n                value: true,\n                configurable: true,\n                enumerable: false\n            });\n        } catch (e) {\n            log(`createElement patch failed: ${e && e.message}`);\n        }\n    }\n\n    // Post a message from the page hook back to the content script (reverse\n    // direction of the normal bridge flow).\n    function postToContentScript(command, extra = {}) {\n        try {\n            if (!bridgeToken) return;\n            window.postMessage({\n                source: BRIDGE_TARGET,\n                target: BRIDGE_SOURCE,\n                token: bridgeToken,\n                command,\n                ...extra\n            }, \"*\");\n        } catch (e) {\n            log(`postToContentScript (${command}) failed: ${e && e.message}`);\n        }\n    }\n\n    function patchSpaNavigation() {\n        if (!window.history || window.history.__volumeControlNavigationPatched) return;\n\n        const notify = () => {\n            Promise.resolve().then(() => {\n                postToContentScript(\"locationChanged\", { href: window.location.href });\n            });\n        };\n        spaNavigationNotify = notify;\n\n        for (const method of [\"pushState\", \"replaceState\"]) {\n            const original = method === \"pushState\" ? nativeHistoryPushState : nativeHistoryReplaceState;\n            if (typeof original !== \"function\") continue;\n            window.history[method] = function patchedHistoryMethod() {\n                const result = original.apply(this, arguments);\n                notify();\n                return result;\n            };\n        }\n\n        window.addEventListener(\"popstate\", notify, { passive: true });\n        window.addEventListener(\"hashchange\", notify, { passive: true });\n\n        try {\n            Object.defineProperty(window.history, \"__volumeControlNavigationPatched\", {\n                value: true,\n                configurable: true,\n                enumerable: false\n            });\n        } catch (e) {}\n    }\n\n    function deletePatchMarker(target, key) {\n        if (!target) return;\n        try { delete target[key]; } catch (e) {}\n    }\n\n    function restorePatchedPageApis() {\n        stopMaintenanceTimers();\n\n        // Only restore a method when OUR wrapper is still installed. If the page\n        // replaced it after us, leave the page's newer implementation alone.\n        if (AudioNodePrototype) {\n            const ownsConnect = Boolean(AudioNodePrototype.connect && AudioNodePrototype.connect.name === \"patchedConnect\");\n            const ownsDisconnect = Boolean(!nativeDisconnect || (AudioNodePrototype.disconnect && AudioNodePrototype.disconnect.name === \"patchedDisconnect\"));\n            if (ownsConnect && nativeConnect) AudioNodePrototype.connect = nativeConnect;\n            if (ownsDisconnect && nativeDisconnect) AudioNodePrototype.disconnect = nativeDisconnect;\n            if (ownsConnect && ownsDisconnect) deletePatchMarker(AudioNodePrototype, \"__volumeControlPatched\");\n        }\n\n        if (window.HTMLMediaElement && window.HTMLMediaElement.prototype) {\n            const proto = window.HTMLMediaElement.prototype;\n            const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, \"volume\");\n            const ownsVolume = Boolean(volumeDescriptor && volumeDescriptor.set && volumeDescriptor.set.name === \"patchedVolumeSetter\");\n            if (ownsVolume && nativeVolumeDescriptor) Object.defineProperty(proto, \"volume\", nativeVolumeDescriptor);\n            const srcObjectDescriptor = Object.getOwnPropertyDescriptor(proto, \"srcObject\");\n            const ownsSrcObject = Boolean(srcObjectDescriptor && srcObjectDescriptor.set && srcObjectDescriptor.set.name === \"patchedSrcObjectSetter\");\n            if (ownsSrcObject && nativeSrcObjectDescriptor) Object.defineProperty(proto, \"srcObject\", nativeSrcObjectDescriptor);\n            const ownsPlay = Boolean(proto.play && proto.play.name === \"patchedPlay\");\n            if (ownsPlay && nativePlay) proto.play = nativePlay;\n            const ownsSetMediaKeys = Boolean(!nativeSetMediaKeys || (proto.setMediaKeys && proto.setMediaKeys.name === \"patchedSetMediaKeys\"));\n            const ownsWebkitSetMediaKeys = Boolean(!nativeWebkitSetMediaKeys || (proto.webkitSetMediaKeys && proto.webkitSetMediaKeys.name === \"patchedWebkitSetMediaKeys\"));\n            if (ownsSetMediaKeys && nativeSetMediaKeys) proto.setMediaKeys = nativeSetMediaKeys;\n            if (ownsWebkitSetMediaKeys && nativeWebkitSetMediaKeys) proto.webkitSetMediaKeys = nativeWebkitSetMediaKeys;\n            if (ownsVolume) deletePatchMarker(proto, \"__volumeControlVolumePatched\");\n            if (ownsSrcObject) deletePatchMarker(proto, \"__volumeControlSrcObjectPatched\");\n            if (ownsPlay) deletePatchMarker(proto, \"__volumeControlPlayPatched\");\n            if (ownsSetMediaKeys && ownsWebkitSetMediaKeys) deletePatchMarker(proto, \"__volumeControlSetMediaKeysPatched\");\n        }\n\n        if (window.Audio && window.Audio.name === \"VolumeControlAudio\" && nativeAudioConstructor) {\n            window.Audio = nativeAudioConstructor;\n        }\n\n        if (DocumentPrototype) {\n            const ownsCreateElement = Boolean(DocumentPrototype.createElement && DocumentPrototype.createElement.name === \"patchedCreateElement\");\n            const ownsCreateElementNS = Boolean(!nativeCreateElementNS || (DocumentPrototype.createElementNS && DocumentPrototype.createElementNS.name === \"patchedCreateElementNS\"));\n            if (ownsCreateElement && nativeCreateElement) DocumentPrototype.createElement = nativeCreateElement;\n            if (ownsCreateElementNS && nativeCreateElementNS) DocumentPrototype.createElementNS = nativeCreateElementNS;\n            if (ownsCreateElement && ownsCreateElementNS) deletePatchMarker(DocumentPrototype, \"__volumeControlCreateElementPatched\");\n        }\n\n        if (NavigatorPrototype &&\n            NavigatorPrototype.requestMediaKeySystemAccess &&\n            NavigatorPrototype.requestMediaKeySystemAccess.name === \"patchedRequestMediaKeySystemAccess\" &&\n            nativeRequestMediaKeySystemAccess) {\n            NavigatorPrototype.requestMediaKeySystemAccess = nativeRequestMediaKeySystemAccess;\n            deletePatchMarker(NavigatorPrototype, \"__volumeControlRmksaPatched\");\n        }\n\n        if (MediaKeySystemAccessPrototype &&\n            MediaKeySystemAccessPrototype.createMediaKeys &&\n            MediaKeySystemAccessPrototype.createMediaKeys.name === \"patchedCreateMediaKeys\" &&\n            nativeCreateMediaKeys) {\n            MediaKeySystemAccessPrototype.createMediaKeys = nativeCreateMediaKeys;\n            deletePatchMarker(MediaKeySystemAccessPrototype, \"__volumeControlCmkPatched\");\n        }\n\n        if (window.history) {\n            const ownsPushState = Boolean(window.history.pushState && window.history.pushState.name === \"patchedHistoryMethod\");\n            const ownsReplaceState = Boolean(window.history.replaceState && window.history.replaceState.name === \"patchedHistoryMethod\");\n            if (ownsPushState && nativeHistoryPushState) window.history.pushState = nativeHistoryPushState;\n            if (ownsReplaceState && nativeHistoryReplaceState) window.history.replaceState = nativeHistoryReplaceState;\n            if (ownsPushState && ownsReplaceState) deletePatchMarker(window.history, \"__volumeControlNavigationPatched\");\n        }\n        if (spaNavigationNotify) {\n            window.removeEventListener(\"popstate\", spaNavigationNotify);\n            window.removeEventListener(\"hashchange\", spaNavigationNotify);\n            spaNavigationNotify = null;\n        }\n\n        if (gestureListenersInstalled) {\n            document.removeEventListener(\"pointerdown\", resumeMediaContextOnGesture, true);\n            document.removeEventListener(\"keydown\", resumeMediaContextOnGesture, true);\n            gestureListenersInstalled = false;\n        }\n\n        for (const element of Array.from(mediaElements)) {\n            if (!mediaRoutes.has(element)) {\n                detachMediaElementListeners(element);\n                mediaElements.delete(element);\n            }\n        }\n\n        hooksInstalled = false;\n    }\n\n    function handleBridgeMessage(event) {\n        if (event.source !== window) return;\n\n        const data = event.data;\n        if (!data || data.source !== BRIDGE_SOURCE || data.target !== BRIDGE_TARGET) return;\n\n        if (!bridgeToken) {\n            if ((data.command !== \"setState\" && data.command !== \"heartbeat\") ||\n                typeof data.token !== \"string\" || data.token.length < 24) return;\n            bridgeToken = data.token;\n        } else if (data.token !== bridgeToken) {\n            if (!state.extensionActive &&\n                (data.command === \"setState\" || data.command === \"heartbeat\") &&\n                typeof data.token === \"string\" && data.token.length >= 24) {\n                bridgeToken = data.token;\n            } else {\n                return;\n            }\n        }\n\n        // Handle heartbeat from the content script. If the content script is\n        // unloaded (extension disabled/updated), the heartbeat stops and we\n        // restore native audio behavior.\n        if (data.command === \"heartbeat\") {\n            lastHeartbeat = Date.now();\n            if (!state.extensionActive) {\n                state.extensionActive = true;\n                log(\"Extension reconnected — requesting current state\");\n                // Request a fresh state sync from the content script. Our state\n                // was reset to defaults by restoreNativeBehavior, and the content\n                // script's syncPageAudioHook would skip if it thinks nothing changed.\n                postToContentScript(\"requestState\");\n            }\n            return;\n        }\n\n        if (data.command !== \"setState\") return;\n\n        // An old content script must not overwrite a newer page hook state.\n        // This validates protocol compatibility, not page-script authenticity:\n        // MAIN-world scripts can still observe window.postMessage traffic.\n        if (data.version !== undefined && data.version !== BRIDGE_VERSION &&\n            data.version !== BRIDGE_VERSION - 1) {\n            log(`Ignoring incompatible bridge state v${data.version}; expected v${BRIDGE_VERSION}`);\n            return;\n        }\n        if (typeof data.dB !== \"number\" || !Number.isFinite(data.dB) ||\n            typeof data.enabled !== \"boolean\" || typeof data.mono !== \"boolean\" ||\n            typeof data.muted !== \"boolean\" ||\n            (data.normalizerEnabled !== undefined && typeof data.normalizerEnabled !== \"boolean\")) {\n            log(\"Ignoring malformed bridge control state\");\n            return;\n        }\n\n        lastHeartbeat = Date.now();\n        const wasNormalizing = state.extensionActive && state.enabled && state.normalizerEnabled;\n        const previousNormalizerMode = state.normalizerConfig && state.normalizerConfig.mode;\n        state.extensionActive = true;\n        state.enabled = data.enabled !== false;\n        state.dB = normalizeDb(data.dB);\n        state.mono = Boolean(data.mono);\n        state.muted = Boolean(data.muted);\n        state.normalizerEnabled = Boolean(data.normalizerEnabled);\n        state.normalizerConfig = normalizeNormalizerConfig(data.normalizerConfig);\n        const nowNormalizing = state.enabled && state.normalizerEnabled;\n        if (wasNormalizing !== nowNormalizing ||\n            (nowNormalizing && previousNormalizerMode !== state.normalizerConfig.mode)) {\n            // Re-enable at unity gain rather than replaying stale auto gain.\n            // Do this before reconnecting graphs/MediaElementSource nodes.\n            eachTrackedContext((context) => {\n                const graph = graphs.get(context);\n                if (graph) {\n                    graph.normalizerGainDb = 0;\n                    graph.musicLevelState = null;\n                    graph.meterPeakDb = -Infinity;\n                }\n            });\n            for (const element of mediaElements) {\n                const route = mediaRoutes.get(element);\n                if (route) {\n                    route.normalizerGainDb = 0;\n                    route.musicLevelState = null;\n                    route.meterPeakDb = -Infinity;\n                }\n            }\n        }\n        state.debugMode = Boolean(data.debugMode);\n        state.forceDrmCapture = Boolean(data.forceDrmCapture);\n        state.forceCorsCapture = Boolean(data.forceCorsCapture);\n        state.debugRouteMode = data.debugRouteMode === \"webaudio\" || data.debugRouteMode === \"native\"\n            ? data.debugRouteMode\n            : \"auto\";\n\n        if (state.enabled) {\n            ensurePageHooksInstalled();\n        } else {\n            stopMaintenanceTimers();\n        }\n\n        // Route or unroute depending on whether audio processing is needed.\n        if (pageAudioNeedsRoute()) {\n            routeRecordedDestinationConnections();\n            routeKnownAudioLibraries();\n        } else {\n            unrouteDestinationConnections();\n            unrouteHowlerGlobal();\n        }\n        applyStateToGraphs();\n        applyStateToMediaElements();\n        releasePreflightMediaMute();\n        if (!state.enabled) restorePatchedPageApis();\n    }\n\n    function restoreNativeBehavior() {\n        // Called when the content script heartbeat times out, indicating the\n        // extension has been disabled or updated. We can't truly un-patch the\n        // prototypes (other code may hold references), but we can make all\n        // patched functions transparent by setting state to disabled/unity and\n        // unrouting everything so the audio path is native.\n        log(\"Extension heartbeat lost — restoring native audio behavior\");\n        state.enabled = false;\n        state.dB = 0;\n        state.mono = false;\n        state.muted = false;\n        state.normalizerEnabled = false;\n        state.normalizerConfig = normalizeNormalizerConfig({});\n        state.forceDrmCapture = false;\n        state.forceCorsCapture = false;\n        state.debugRouteMode = \"auto\";\n        state.extensionActive = false;\n        stopMaintenanceTimers();\n\n        unrouteDestinationConnections();\n        unrouteHowlerGlobal();\n\n        for (const element of Array.from(mediaElements)) {\n            const route = mediaRoutes.get(element);\n            if (route && route.sourceKind === \"mediaStream\") {\n                // Native output and native controls must work after disconnect.\n                resetDirectMediaStreamRoute(element);\n                setNativeVolume(element, getMediaState(element).baseVolume);\n                continue;\n            }\n            if (route && isMediaPlaying(element) && isAudibleMediaElement(element)) {\n                // Once createMediaElementSource() has been called, the element's\n                // native output is permanently detached — its ONLY remaining\n                // audio path is source→gain→destination. releaseMediaRoute()\n                // would disconnect that path and mute a PLAYING element until\n                // its next media event, which can be minutes away on a long\n                // track. effectiveGain() is already 1.0 (extensionActive=false),\n                // so keep the route wired and pass audio through at unity.\n                try {\n                    setNativeVolume(element, route.muteNative ? 0 : getMediaState(element).baseVolume);\n                } catch (e) {\n                    log(`native volume restore failed: ${e && e.message}`);\n                }\n                wireMediaRoute(route);\n                continue;\n            }\n            releaseMediaRoute(element);\n        }\n\n        suspendMediaContextIfIdle();\n        restorePatchedPageApis();\n        bridgeToken = null;\n    }\n\n    function runRestrictionAudit() {\n        updatePageMediaRestriction();\n        for (const element of Array.from(mediaElements)) {\n            const entry = mediaState.get(element);\n            if (!entry || mediaRoutes.has(element)) continue;\n            if (isPendingEmeSuspect(element)) {\n                applyMediaElementState(element);\n                continue;\n            }\n            if (entry.lastFallbackWriteAt === undefined) continue;\n            if (!isMediaPlaying(element) || !isAudibleMediaElement(element)) continue;\n            const gain = effectiveGain();\n            const expected = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));\n            if (Math.abs(readNativeVolume(element) - expected) > 0.02) applyMediaElementState(element);\n        }\n    }\n\n    function sweepDetachedMediaElements() {\n        for (const element of Array.from(mediaElements)) {\n            if (!element.isConnected && !isDetachedButAudible(element)) {\n                cleanupTrackedMediaElement(element);\n            }\n        }\n        setTimeout(suspendMediaContextIfIdle, 0);\n    }\n\n\n    function computeSafeNormalizerGainDb(previousDb, sourceRmsDb, sourcePeakDb, config) {\n        // Fifth argument: per-route history. Sixth/seventh: debug logging and route label.\n        const history = arguments[4];\n        const diagnosticsEnabled = arguments[5] === true;\n        const diagnosticRoute = typeof arguments[6] === \"string\" ? arguments[6] : \"unknown\";\n        const previous = Number.isFinite(previousDb) ? previousDb : 0;\n        function logDiagnostic(desiredGainDb, appliedGainDb, stage = \"active\") {\n            if (!diagnosticsEnabled || !history || typeof console === \"undefined\" ||\n                typeof console.debug !== \"function\") return;\n            const now = Date.now();\n            if (Number.isFinite(history.lastDiagnosticAt) && now - history.lastDiagnosticAt < 95) return;\n            history.lastDiagnosticAt = now;\n            const roundDb = value => Number.isFinite(value) ? Number(value.toFixed(2)) : value;\n            console.debug(\"[Volume Control][Normalizer]\", {\n                route: diagnosticRoute,\n                mode: config.mode,\n                stage,\n                inputRmsDb: roundDb(sourceRmsDb),\n                inputPeakDb: roundDb(sourcePeakDb),\n                peakEnvelopeDb: roundDb(history.peakDb),\n                desiredGainDb: roundDb(desiredGainDb),\n                appliedGainDb: roundDb(appliedGainDb)\n            });\n        }\n        if (history && history.mode !== config.mode) {\n            history.mode = config.mode;\n            history.rmsDb = null;\n            history.peakDb = -Infinity;\n            history.peakHoldSamples = 0;\n            history.audibleSamples = 0;\n            history.silentSamples = 0;\n            history.lastDiagnosticAt = null;\n        }\n        // Digital silence is valid analyser data. Fail closed only on invalid measurements.\n        if (!Number.isFinite(sourceRmsDb) || Number.isNaN(sourcePeakDb) ||\n            sourcePeakDb === Infinity || (sourceRmsDb > -55 && !Number.isFinite(sourcePeakDb))) {\n            if (history) {\n                history.rmsDb = null;\n                history.peakDb = -Infinity;\n                history.peakHoldSamples = 0;\n                history.audibleSamples = 0;\n                history.silentSamples = 0;\n            }\n            logDiagnostic(0, 0, \"invalid-input\");\n            return 0;\n        }\n        if (sourceRmsDb <= -55) {\n            // Don't pump up a fade or gap. Preserve attenuation briefly, then clear boost history.\n            if (config.mode === \"music\" && history && history.audibleSamples > 0 &&\n                ++history.silentSamples < 30) {\n                logDiagnostic(previous, previous, \"silence-hold\");\n                return previous;\n            }\n            if (history) {\n                history.rmsDb = null;\n                history.peakDb = -Infinity;\n                history.peakHoldSamples = 0;\n                history.audibleSamples = 0;\n                history.silentSamples = 0;\n            }\n            const silentGain = config.mode === \"music\" ? Math.min(0, previous) : 0;\n            logDiagnostic(silentGain, silentGain, \"silence\");\n            return silentGain;\n        }\n    \n        if (config.mode === \"music\" && history) {\n            history.silentSamples = 0;\n            history.audibleSamples = Math.min(1000, (history.audibleSamples || 0) + 1);\n            if (!Number.isFinite(history.rmsDb)) history.rmsDb = sourceRmsDb;\n    \n            // Follow section changes promptly; gain smoothing below handles audible transitions.\n            // Loudness envelope: 350 ms attack for louder sections, 900 ms release for quieter ones.\n            const rmsTimeMs = sourceRmsDb > history.rmsDb ? 350 : 900;\n            history.rmsDb += (sourceRmsDb - history.rmsDb) *\n                (1 - Math.exp(-100 / rmsTimeMs));\n    \n            // Hold transient peaks for four seconds, then release by 1.5 dB/s.\n            // This envelope limits positive boost only; it must never add attenuation.\n            if (!Number.isFinite(history.peakDb) || sourcePeakDb >= history.peakDb) {\n                history.peakDb = sourcePeakDb;\n                history.peakHoldSamples = 40;\n            } else if (history.peakHoldSamples > 0) {\n                history.peakHoldSamples--;\n            } else {\n                history.peakDb = Math.max(sourcePeakDb, history.peakDb - 0.15);\n            }\n            const safeBoostDb = Math.max(0, Math.min(\n                config.maxBoostDb, config.ceilingDb - 2 - history.peakDb));\n            const rmsTargetDb = config.targetDb - history.rmsDb;\n            // Apply peak headroom only when the loudness target asks for positive gain.\n            const desiredTargetDb = rmsTargetDb > 0\n                ? Math.min(rmsTargetDb, safeBoostDb)\n                : rmsTargetDb;\n            const desired = Math.max(-32, Math.min(\n                desiredTargetDb, history.audibleSamples < 25 ? 0 : Infinity));\n    \n            // A fresh peak sheds unsafe positive boost immediately; it never demands attenuation.\n            const instantaneousBoostLimit = Math.max(0, config.ceilingDb - 2 - sourcePeakDb);\n            if (previous > 0 && instantaneousBoostLimit < previous) {\n                const applied = Math.max(-32, Math.min(desired, instantaneousBoostLimit));\n                logDiagnostic(desired, applied);\n                return applied;\n            }\n    \n            // Recover prior attenuation smoothly, but keep actual positive boost deliberately gradual.\n            const timeMs = desired < previous ? 1600 : previous < 0 && desired > previous && history.audibleSamples >= 25 ? 900 : 6000;\n            const applied = previous + (desired - previous) * (1 - Math.exp(-100 / timeMs));\n            logDiagnostic(desired, applied);\n            return applied;\n        }\n    \n        // Adaptive mode retains the original fast voice/video leveling behavior.\n        const rmsTarget = config.targetDb - sourceRmsDb;\n        const peakHeadroom = config.ceilingDb - 2 - sourcePeakDb;\n        const desired = Math.max(-32, Math.min(config.maxBoostDb, rmsTarget, peakHeadroom));\n        const applied = desired <= previous\n            ? desired\n            : previous + (desired - previous) * (1 - Math.exp(-100 / Math.max(100, config.responseMs)));\n        logDiagnostic(desired, applied);\n        return applied;\n    }\n\n    function sampleProcessor(processor) {\n        if (!processor || !processor.analyser || !processor.context || processor.context.state !== \"running\") {\n            return { peakDb: -Infinity, gainDb: processor && Number(processor.normalizerGainDb) || 0 };\n        }\n        const analyser = processor.analyser;\n        if (!processor.meterBuffer || processor.meterBuffer.length !== analyser.fftSize) {\n            processor.meterBuffer = new Float32Array(analyser.fftSize);\n        }\n        try {\n            analyser.getFloatTimeDomainData(processor.meterBuffer);\n        } catch (e) {\n            return { peakDb: -Infinity, gainDb: Number(processor.normalizerGainDb) || 0 };\n        }\n\n        let peak = 0;\n        for (let i = 0; i < processor.meterBuffer.length; i++) {\n            const sample = processor.meterBuffer[i];\n            const abs = Math.abs(sample);\n            if (abs > peak) peak = abs;\n        }\n\n        const peakDb = peak > 0.000001 ? 20 * Math.log10(peak) : -Infinity;\n        processor.meterPeakDb = peakDb;\n\n        // The output analyser supplies peak metering only; source RMS feeds AGC.\n        // Otherwise moving the user's slider changes detected loudness and\n        // the normalizer gradually cancels their requested gain adjustment.\n        let sourceRmsDb = -120;\n        let sourcePeakDb = -Infinity;\n        let sourceReadValid = false;\n        const sourceAnalyser = processor.inputAnalyser;\n        if (sourceAnalyser) {\n            if (!processor.inputBuffer || processor.inputBuffer.length !== sourceAnalyser.fftSize) {\n                processor.inputBuffer = new Float32Array(sourceAnalyser.fftSize);\n            }\n            try {\n                sourceAnalyser.getFloatTimeDomainData(processor.inputBuffer);\n                let sourceSum = 0;\n                let sourcePeak = 0;\n                for (let i = 0; i < processor.inputBuffer.length; i++) {\n                    const sample = processor.inputBuffer[i];\n                    if (!Number.isFinite(sample)) throw new Error(\"invalid source sample\");\n                    sourceSum += sample * sample;\n                    sourcePeak = Math.max(sourcePeak, Math.abs(sample));\n                }\n                const sourceRms = Math.sqrt(sourceSum / Math.max(1, processor.inputBuffer.length));\n                sourceRmsDb = sourceRms > 0.000001 ? 20 * Math.log10(sourceRms) : -120;\n                sourcePeakDb = sourcePeak > 0.000001 ? 20 * Math.log10(sourcePeak) : -Infinity;\n                sourceReadValid = true;\n            } catch (e) {}\n        }\n        const config = normalizeNormalizerConfig(state.normalizerConfig);\n        let gainDb = Number(processor.normalizerGainDb) || 0;\n        const previousGainDb = gainDb;\n        if (state.normalizerEnabled && state.extensionActive && state.enabled && !state.muted &&\n            !processor.limiterFallbackActive) {\n            gainDb = computeSafeNormalizerGainDb(gainDb, sourceReadValid ? sourceRmsDb : NaN,\n                sourceReadValid ? sourcePeakDb : NaN, config,\n                processor.musicLevelState || (processor.musicLevelState = {}), state.debugMode, \"page-audio\");\n        } else {\n            gainDb = 0;\n        }\n\n        if (Math.abs(gainDb) < 0.01) gainDb = 0;\n        processor.normalizerGainDb = gainDb;\n        configureLimiter(processor);\n\n        try {\n            const now = processor.context.currentTime;\n            const target = (processor.limiterFallbackActive\n                ? Math.min(1, effectiveGain())\n                : effectiveGain() * (state.normalizerEnabled ? dbToGain(gainDb) : 1)) *\n                mediaSourceGain(processor);\n            processor.gain.gain.cancelScheduledValues(now);\n            processor.gain.gain.setTargetAtTime(target, now, gainDb < previousGainDb ? 0.008 : 0.035);\n        } catch (e) {}\n\n        return { peakDb, gainDb };\n    }\n\n    function updateNormalizerAndMeter() {\n        if (!state.normalizerEnabled || !hasAnalyzableAudioRoute()) {\n            syncNormalizerMeterTimer();\n            return;\n        }\n        let peakDb = -Infinity;\n        let gainDb = 0;\n        let gainCount = 0;\n\n        eachTrackedContext((context) => {\n            const graph = graphs.get(context);\n            if (!graph) return;\n            const sample = sampleProcessor(graph);\n            if (Number.isFinite(sample.peakDb)) peakDb = Math.max(peakDb, sample.peakDb);\n            if (Number.isFinite(sample.gainDb)) {\n                gainDb += sample.gainDb;\n                gainCount++;\n            }\n        });\n\n        for (const element of Array.from(mediaElements)) {\n            const route = mediaRoutes.get(element);\n            if (!route || !route.outputConnected) continue;\n            const sample = sampleProcessor(route);\n            if (Number.isFinite(sample.peakDb)) peakDb = Math.max(peakDb, sample.peakDb);\n            if (Number.isFinite(sample.gainDb)) {\n                gainDb += sample.gainDb;\n                gainCount++;\n            }\n        }\n\n        postToContentScript(\"meterUpdate\", {\n            peakDb,\n            normalizerGainDb: gainCount ? gainDb / gainCount : 0\n        });\n    }\n\n    function hasAnalyzableAudioRoute() {\n        // A saved preference is not evidence of routable decoded samples.\n        if (state.debugRouteMode === \"native\") return false;\n        for (const element of mediaElements) {\n            const route = mediaRoutes.get(element);\n            if (route && route.outputConnected &&\n                route.context && route.context.state === \"running\" &&\n                isMediaPlaying(element)) return true;\n        }\n        for (const entry of destinationConnections) {\n            if (!entry.routed) continue;\n            const context = nodeFromRef(entry.contextRef);\n            if (context && context.state === \"running\" && graphs.has(context)) return true;\n        }\n        return false;\n    }\n\n    function syncNormalizerMeterTimer() {\n        const shouldRun = state.extensionActive && state.enabled && state.normalizerEnabled &&\n            hasAnalyzableAudioRoute();\n        if (!shouldRun) {\n            if (normalizerMeterTimerId !== null) clearInterval(normalizerMeterTimerId);\n            normalizerMeterTimerId = null;\n            return;\n        }\n        if (normalizerMeterTimerId === null) {\n            normalizerMeterTimerId = setInterval(updateNormalizerAndMeter, 100);\n        }\n    }\n\n    function startMaintenanceTimers() {\n        // Called on every state sync; update the meter separately even when\n        // the lower-frequency maintenance timers are already installed.\n        syncNormalizerMeterTimer();\n        if (!state.extensionActive || !state.enabled || maintenanceTimerIds.length) return;\n\n        let howlerPollCount = 0;\n        howlerPollId = setInterval(() => {\n            howlerPollCount++;\n            if (window.Howler) {\n                routeKnownAudioLibraries();\n                clearInterval(howlerPollId);\n                howlerPollId = null;\n            } else if (howlerPollCount >= 30) {\n                clearInterval(howlerPollId);\n                howlerPollId = null;\n            }\n        }, 1000);\n\n        maintenanceTimerIds = [\n            setInterval(sweepDeadDestinationConnections, 30000),\n            setInterval(runRestrictionAudit, 1000),\n            setInterval(sweepDetachedMediaElements, 30000),\n            setInterval(() => {\n                if (state.extensionActive && Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {\n                    restoreNativeBehavior();\n                }\n            }, 2000)\n        ];\n    }\n\n    function stopMaintenanceTimers() {\n        if (normalizerMeterTimerId !== null) clearInterval(normalizerMeterTimerId);\n        normalizerMeterTimerId = null;\n        for (const id of maintenanceTimerIds) clearInterval(id);\n        maintenanceTimerIds = [];\n        if (howlerPollId !== null) {\n            clearInterval(howlerPollId);\n            howlerPollId = null;\n        }\n        if (mediaObserver) {\n            mediaObserver.disconnect();\n            mediaObserver = null;\n        }\n    }\n\n    const resumeMediaContextOnGesture = () => {\n        if (state.extensionActive && state.enabled && mediaAudioContext) resumeContext(mediaAudioContext);\n    };\n\n    function ensurePageHooksInstalled() {\n        if (!hooksInstalled) {\n            patchAudioNodeRouting();\n            patchMediaVolume();\n            patchMediaSrcObject();\n            patchMediaPlayback();\n            patchAudioConstructor();\n            patchElementCreation();\n            patchEmeApi();\n            patchSpaNavigation();\n            hooksInstalled = true;\n\n            if (!gestureListenersInstalled) {\n                document.addEventListener(\"pointerdown\", resumeMediaContextOnGesture, { passive: true, capture: true });\n                document.addEventListener(\"keydown\", resumeMediaContextOnGesture, { passive: true, capture: true });\n                gestureListenersInstalled = true;\n            }\n        }\n\n        if (document.documentElement) scanMediaElements(document);\n        else document.addEventListener(\"DOMContentLoaded\", () => {\n            if (state.extensionActive && state.enabled) scanMediaElements(document);\n        }, { once: true });\n\n        if (!mediaObserver) mediaObserver = watchForInjectedMediaElements();\n        startMaintenanceTimers();\n    }\n\n    // Install a transparent AudioNode destination interceptor immediately at\n    // document_start. It records graphs created before async storage/profile\n    // resolution but does not reroute or alter gain until an authenticated\n    // setState enables this document. Excluded pages restore the native methods\n    // as soon as their disabled state arrives.\n    patchAudioNodeRouting();\n\n    try {\n        Object.defineProperty(window, HOOK_KEY, {\n            value: { installed: true },\n            configurable: false,\n            enumerable: false,\n            writable: false\n        });\n    } catch (e) {\n        window[HOOK_KEY] = { installed: true };\n    }\n\n    window.addEventListener(\"message\", handleBridgeMessage);\n})();\n";
    // The extension's popup.css — the .vc-popup-scoped port (the real popup.css
    // targets html/body, which cannot match inside the shadow root below).
    var POPUP_CSS = "/* =============================================================\n   Volume Control popup — ported from the extension's popup.css\n   (v7.1) with two adaptations for the live preview:\n   1. Scoped under .vc-popup instead of html/body (420px width kept).\n   2. Dark mode via the .vc-popup-dark class (driven by the browser\n      mockup's theme toggle) instead of prefers-color-scheme, so the\n      demo can show the extension's real light/dark popup designs.\n   Everything else — slider ticks, switches, meter, notes, states —\n   is pixel-identical to the extension.\n   ============================================================= */\n\n.vc-popup {\n  width: 420px;\n  font-size: 18px;\n  margin: 0;\n  padding: 0;\n  font-family: \"Segoe UI\", Tahoma, sans-serif;\n  background-color: #fff;\n  color: #333;\n  box-sizing: border-box;\n}\n\n.vc-popup .hidden { display: none !important; }\n\n/* --- SLIDER STYLES (Cross-Browser Fix) --- */\n\n.vc-popup input[type=\"range\"] {\n  -webkit-appearance: none;\n  appearance: none;\n  --vc-range-steps: 64;\n  width: 100%;\n  height: 24px;\n  margin: 10px 0;\n  padding: 0;\n  background: transparent;\n  display: block;\n  cursor: pointer;\n}\n\n.vc-popup input[type=\"range\"]:focus { outline: none; }\n\n.vc-popup input[type=\"range\"]::-webkit-slider-runnable-track {\n  width: 100%;\n  height: 10px;\n  background-color: #e0e0e0;\n  background-image: repeating-linear-gradient(90deg, #bdbdbd, #bdbdbd 1px, transparent 1px, transparent calc(100% / var(--vc-range-steps)));\n  border-radius: 5px;\n  border: 1px solid #d0d0d0;\n  margin-top: 7px;\n}\n\n.vc-popup input[type=\"range\"]::-webkit-slider-thumb {\n  -webkit-appearance: none;\n  height: 24px;\n  width: 10px;\n  background: #555;\n  border-radius: 3px;\n  margin-top: -8px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);\n}\n\n.vc-popup input[type=\"range\"]::-moz-range-track {\n  width: 100%;\n  height: 10px;\n  background-color: #e0e0e0;\n  background-image: repeating-linear-gradient(90deg, #bdbdbd, #bdbdbd 1px, transparent 1px, transparent calc(100% / var(--vc-range-steps)));\n  border-radius: 5px;\n  border: 1px solid #d0d0d0;\n}\n\n.vc-popup input[type=\"range\"]::-moz-range-thumb {\n  height: 24px;\n  width: 10px;\n  background: #555;\n  border: none;\n  border-radius: 3px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);\n}\n\n/* --- TOGGLE SWITCH --- */\n.vc-popup .switch {\n  position: relative;\n  display: inline-block;\n  width: 40px;\n  height: 24px;\n  flex-shrink: 0;\n}\n\n.vc-popup .switch input { opacity: 0; width: 0; height: 0; }\n\n.vc-popup .slider {\n  position: absolute;\n  cursor: pointer;\n  top: 0; left: 0; right: 0; bottom: 0;\n  background-color: #ccc;\n  transition: 0.4s;\n  border-radius: 24px;\n}\n\n.vc-popup .slider:before {\n  position: absolute;\n  content: \"\";\n  height: 16px; width: 16px;\n  left: 4px; bottom: 4px;\n  background-color: white;\n  transition: 0.4s;\n  border-radius: 50%;\n}\n\n.vc-popup input:checked + .slider { background-color: #4CAF50; }\n.vc-popup input:checked + .slider:before { transform: translateX(16px); }\n\n/* --- TEXT & CONTROLS --- */\n.vc-popup #volume-text {\n  width: 3.5ch;\n  border: none;\n  background-color: transparent;\n  text-align: right;\n  font-size: 18px;\n  font-weight: bold;\n  color: #555;\n  padding: 0;\n  flex-shrink: 0;\n}\n\n.vc-popup .volume-limit-note {\n  margin: 2px 0 8px;\n  font-size: 12px;\n  line-height: 1.35;\n  color: #666;\n  text-align: center;\n}\n\n.vc-popup .settings {\n  font-size: 14px;\n  font-family: inherit;\n  color: #333;\n  background: transparent;\n  border: none;\n  padding: 0;\n  cursor: pointer;\n  margin: 0;\n  font-weight: normal;\n  text-decoration: none;\n  opacity: 0.9;\n  display: flex;\n  align-items: center;\n  height: 24px;\n}\n\n.vc-popup .settings:hover {\n  opacity: 1;\n  text-decoration: underline;\n  color: #000;\n}\n\n/* --- LAYOUT --- */\n.vc-popup .top-controls {\n  flex-direction: column;\n  width: 100%;\n  padding: 0 15px;\n  box-sizing: border-box;\n  margin-bottom: 15px;\n}\n\n.vc-popup #popup-content {\n  padding-top: 12px;\n}\n\n/* --- VOLUME ROW --- */\n.vc-popup .volume-row {\n  display: flex;\n  align-items: center;\n  position: relative;\n  width: 100%;\n  min-height: 28px;\n}\n\n.vc-popup .volume-row .volume-display {\n  position: absolute;\n  left: 50%;\n  transform: translateX(-50%);\n  display: flex;\n  align-items: baseline;\n  z-index: 1;\n}\n\n.vc-popup .volume-display .volume-unit {\n  font-size: 14px;\n  font-weight: normal;\n  color: #777;\n  margin-left: 2px;\n  user-select: none;\n}\n\n/* --- MUTE BUTTON --- */\n.vc-popup .mute-btn {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  background: transparent;\n  border: 1px solid #ccc;\n  border-radius: 4px;\n  padding: 3px 10px;\n  cursor: pointer;\n  font-family: inherit;\n  font-size: 14px;\n  color: #333;\n  height: 28px;\n  flex-shrink: 0;\n  margin-left: 0;\n  margin-right: auto;\n  transition: background-color 0.2s, border-color 0.2s, color 0.2s;\n}\n\n.vc-popup .mute-btn:hover {\n  background-color: #f0f0f0;\n  border-color: #999;\n}\n\n.vc-popup .mute-icon {\n  flex-shrink: 0;\n  fill: currentColor;\n}\n\n.vc-popup .mute-icon .wave-shape { display: block; }\n.vc-popup .mute-icon .mute-x { display: none; }\n\n.vc-popup .mute-btn.muted .wave-shape { display: none; }\n.vc-popup .mute-btn.muted .mute-x { display: block; }\n.vc-popup .mute-btn.muted .speaker-shape { fill: currentColor; }\n\n.vc-popup .mute-btn.muted {\n  background-color: #c62828;\n  border-color: #c62828;\n  color: #fff;\n}\n\n.vc-popup .mute-btn.muted:hover {\n  background-color: #d32f2f;\n  border-color: #d32f2f;\n}\n\n.vc-popup .mute-btn:focus-visible {\n  outline: 2px solid #4CAF50;\n  outline-offset: 2px;\n}\n\n.vc-popup .bot-controls {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 0 15px;\n  margin-bottom: 15px;\n}\n\n.vc-popup .left {\n  display: flex;\n  gap: 20px;\n  align-items: center;\n}\n\n.vc-popup .right {\n  display: flex;\n  gap: 20px;\n  align-items: center;\n}\n\n.vc-popup .switch-container {\n  display: flex;\n  align-items: center;\n  cursor: pointer;\n}\n\n.vc-popup .switch-container.is-disabled {\n  opacity: 0.45;\n  cursor: not-allowed;\n}\n\n.vc-popup .switch-container.is-disabled .slider,\n.vc-popup .switch-container.is-disabled .label-text {\n  cursor: not-allowed;\n}\n\n.vc-popup .label-text {\n  margin-left: 8px;\n  font-size: 14px;\n  user-select: none;\n  white-space: nowrap;\n  color: #333;\n}\n\n/* --- MESSAGES --- */\n.vc-popup .exclusion-message {\n  text-align: center;\n  padding: 15px;\n  color: #666;\n  width: 100%;\n  box-sizing: border-box;\n  background-color: #f9f9f9;\n  border-bottom: 1px solid #eee;\n  margin-bottom: 10px;\n  font-size: 0.9em;\n}\n\n.vc-popup .exclusion-title {\n  font-weight: 600;\n  color: #333;\n}\n\n.vc-popup .exclusion-detail {\n  margin-top: 6px;\n  font-size: 12px;\n  line-height: 1.35;\n  color: #666;\n}\n\n/* --- MUTED STATE --- */\n.vc-popup #popup-content.is-muted #volume-slider,\n.vc-popup #popup-content.is-muted #volume-text {\n  opacity: 0.45;\n  transition: opacity 0.2s;\n}\n.vc-popup #popup-content.is-muted #volume-slider {\n  cursor: not-allowed;\n}\n\n/* --- Normalizer + live peak meter --- */\n.vc-popup .normalizer-panel {\n  margin-top: 10px;\n  padding-top: 10px;\n  border-top: 1px solid rgba(127, 127, 127, 0.28);\n}\n\n.vc-popup .normalizer-header,\n.vc-popup .peak-meter-row {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.vc-popup .normalizer-header {\n  justify-content: space-between;\n  margin-bottom: 7px;\n}\n\n.vc-popup .normalizer-switch {\n  margin: 0;\n}\n\n.vc-popup .normalizer-gain,\n.vc-popup .peak-meter-text {\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n  font-size: 12px;\n}\n\n.vc-popup .normalizer-gain {\n  opacity: 0.8;\n}\n\n.vc-popup .peak-meter-row {\n  width: 100%;\n}\n\n.vc-popup .peak-meter {\n  position: relative;\n  flex: 1 1 auto;\n  height: 9px;\n  overflow: hidden;\n  border-radius: 999px;\n  background: rgba(127, 127, 127, 0.24);\n}\n\n.vc-popup .peak-meter-fill {\n  width: 0%;\n  height: 100%;\n  border-radius: inherit;\n  background: currentColor;\n  transition: width 90ms linear;\n}\n\n.vc-popup .peak-meter-ceiling {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 98.3333%;\n  width: 1px;\n  background: currentColor;\n  opacity: 0.7;\n}\n\n.vc-popup .peak-meter-text {\n  min-width: 66px;\n  text-align: right;\n}\n\n.vc-popup .normalizer-note {\n  margin: 6px 0 0;\n  font-size: 11px;\n  line-height: 1.25;\n  opacity: 0.82;\n}\n\n.vc-popup .normalizer-panel.is-unavailable .normalizer-switch {\n  opacity: 0.48;\n  cursor: not-allowed;\n}\n.vc-popup .normalizer-panel.is-unavailable .normalizer-switch .slider {\n  cursor: not-allowed;\n}\n.vc-popup .normalizer-panel.is-unavailable .peak-meter-row {\n  opacity: 0.5;\n}\n\n.vc-popup .normalizer-details[hidden] { display: none !important; }\n.vc-popup .normalizer-detail-header { display: flex; justify-content: flex-end; margin: 0 0 6px; }\n.vc-popup .normalizer-panel .normalizer-header { margin-bottom: 0; }\n.vc-popup .normalizer-panel .normalizer-details { padding-top: 8px; }\n.vc-popup .normalizer-panel.is-unavailable .normalizer-note {\n  opacity: 1;\n}\n\n/* --- DARK MODE (class-driven port of the extension's media query) --- */\n.vc-popup.vc-popup-dark {\n  background-color: #202124;\n  color: #e8eaed;\n}\n\n.vc-popup.vc-popup-dark input[type=\"range\"]::-webkit-slider-runnable-track {\n  background-color: #4a4a4a;\n  border-color: #555;\n  background-image: repeating-linear-gradient(90deg, #666, #666 1px, transparent 1px, transparent calc(100% / var(--vc-range-steps)));\n}\n\n.vc-popup.vc-popup-dark input[type=\"range\"]::-moz-range-track {\n  background-color: #4a4a4a;\n  border-color: #555;\n  background-image: repeating-linear-gradient(90deg, #666, #666 1px, transparent 1px, transparent calc(100% / var(--vc-range-steps)));\n}\n\n.vc-popup.vc-popup-dark input[type=\"range\"]::-webkit-slider-thumb { background: #a8c7fa; }\n.vc-popup.vc-popup-dark input[type=\"range\"]::-moz-range-thumb { background: #a8c7fa; }\n\n.vc-popup.vc-popup-dark .exclusion-message { background-color: #333; color: #ccc; border-color: #444; }\n.vc-popup.vc-popup-dark .exclusion-title { color: #e8eaed; }\n.vc-popup.vc-popup-dark .exclusion-detail { color: #bdc1c6; }\n.vc-popup.vc-popup-dark .volume-limit-note { color: #bdc1c6; }\n.vc-popup.vc-popup-dark .slider { background-color: #5f6368; }\n.vc-popup.vc-popup-dark input:checked + .slider { background-color: #8ab4f8; }\n.vc-popup.vc-popup-dark #volume-text { color: #e8eaed; }\n.vc-popup.vc-popup-dark .volume-display .volume-unit { color: #9aa0a6; }\n\n.vc-popup.vc-popup-dark .label-text { color: #e8eaed; }\n.vc-popup.vc-popup-dark .settings { color: #e8eaed; }\n.vc-popup.vc-popup-dark .settings:hover { color: #fff; }\n\n.vc-popup.vc-popup-dark .mute-btn {\n  border-color: #5f6368;\n  color: #e8eaed;\n}\n.vc-popup.vc-popup-dark .mute-btn:hover {\n  background-color: #2d2e31;\n  border-color: #8ab4f8;\n}\n.vc-popup.vc-popup-dark .mute-btn.muted {\n  background-color: #c62828;\n  border-color: #c62828;\n  color: #fff;\n}\n.vc-popup.vc-popup-dark .mute-btn.muted:hover {\n  background-color: #d32f2f;\n  border-color: #d32f2f;\n}\n\n/* --- STATE CLASSES --- */\n.vc-popup .excluded-site .top-controls,\n.vc-popup .excluded-site .left {\n  display: none !important;\n}\n.vc-popup .excluded-site .exclusion-message {\n  display: block !important;\n}\n.vc-popup .excluded-site .bot-controls {\n  justify-content: flex-end;\n}\n";

    // ============================================================= storage
    // GM storage (global, shared across sites) with a localStorage fallback so
    // the script also runs under Violentmonkey/Greasemonkey or bare <script>.
    var store = {
        get: function (key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    var v = GM_getValue(key);
                    return v === undefined ? fallback : v;
                }
                var raw = localStorage.getItem('vc-tm:' + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (e) { return fallback; }
        },
        set: function (key, value) {
            try {
                if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
                localStorage.setItem('vc-tm:' + key, JSON.stringify(value));
            } catch (e) { /* storage full / blocked — ignore */ }
        },
        del: function (key) {
            try {
                if (typeof GM_deleteValue === 'function') { GM_deleteValue(key); return; }
                localStorage.removeItem('vc-tm:' + key);
            } catch (e) { /* ignore */ }
        }
    };

    // ============================================================= helpers
    function normalizeDb(value) {
        var n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
    }
    function formatMeterDb(value) {
        var n = Number(value);
        if (!Number.isFinite(n) || n <= -90) return '\u2212\u221E dBFS';
        return n.toFixed(1) + ' dBFS';
    }
    function makeToken() {
        var s = '';
        try {
            if (unsafeWindow.crypto && unsafeWindow.crypto.getRandomValues) {
                var a = new Uint8Array(16);
                unsafeWindow.crypto.getRandomValues(a);
                for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
                return s;
            }
        } catch (e) { /* fall through */ }
        for (var j = 0; j < 32; j++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    // ============================================================= settings
    // Same per-site shape the extension persists (volume/mono/mute/normalize),
    // plus the site's "Active" (exclusion) flag and the global normalizer
    // configuration (options-page defaults).
    var DEFAULT_NORMALIZER_CONFIG = { mode: 'music', targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 600, experimentalTruePeak: false };

    function hostname() { return location.hostname || location.host || 'localhost'; }
    var HOST = hostname();
    var SITE_KEY = 'vc-site:' + HOST;
    var EXCLUDED_KEY = 'vc-excluded:' + HOST;

    // ---- site access lists (options.html "Blocked Sites"/"Allowed Sites") --
    var LISTS_KEY = 'vc-lists';
    var lists = (function () {
        var raw = store.get(LISTS_KEY, null);
        var merged = { blocklist: [], whitelist: [], whitelistMode: false };
        if (raw && typeof raw === 'object') {
            if (Array.isArray(raw.blocklist)) merged.blocklist = raw.blocklist.map(String);
            if (Array.isArray(raw.whitelist)) merged.whitelist = raw.whitelist.map(String);
            merged.whitelistMode = !!raw.whitelistMode;
        }
        return merged;
    })();
    function persistLists() { store.set(LISTS_KEY, lists); }
    function listEntryMatches(entry, host) {
        // options.js blocklistMatches(): the domain part decides (any path in
        // an entry is informational); matches the host and its subdomains.
        var domain = String(entry || '').split('/')[0].trim().toLowerCase();
        if (!domain) return false;
        return domain === host || host.endsWith('.' + domain);
    }
    function siteBlockedByLists() {
        if (lists.whitelistMode) {
            for (var i = 0; i < lists.whitelist.length; i++) {
                if (listEntryMatches(lists.whitelist[i], HOST)) return false;
            }
            return true;          // whitelist mode: unlisted sites are off
        }
        for (var j = 0; j < lists.blocklist.length; j++) {
            if (listEntryMatches(lists.blocklist[j], HOST)) return true;
        }
        return false;
    }
    // one-time migration: the pre-7.1.4 per-site "Active off" flag becomes a
    // blocklist entry (the extension migrated its legacy allow list likewise)
    (function migrateExcludedFlag() {
        if (store.get(EXCLUDED_KEY, false)) {
            if (!lists.blocklist.some(function (e) { return listEntryMatches(e, HOST); })) {
                lists.blocklist.push(HOST);
            }
            persistLists();
        }
        store.del(EXCLUDED_KEY);
    })();

    // ---- debug defaults + per-site overrides (options.html Debug section) --
    var DEBUG_DEFAULTS_KEY = 'vc-debug-defaults';
    var DEBUG_SITE_KEY = 'vc-debug:' + HOST;
    function normalizeDebugConfig(raw) {
        var out = { debugMode: false, forceDrmCapture: false, forceCorsCapture: false, debugRouteMode: 'auto' };
        if (raw && typeof raw === 'object') {
            out.debugMode = !!raw.debugMode;
            out.forceDrmCapture = !!raw.forceDrmCapture;
            out.forceCorsCapture = !!raw.forceCorsCapture;
            out.debugRouteMode = raw.debugRouteMode === 'webaudio' || raw.debugRouteMode === 'native'
                ? raw.debugRouteMode : 'auto';
        }
        return out;
    }
    var debugDefaults = normalizeDebugConfig(store.get(DEBUG_DEFAULTS_KEY, null));
    var siteDebug = normalizeDebugConfig(store.get(DEBUG_SITE_KEY, null) || null);
    function effectiveDebugConfig() {
        // options.html semantics: per-site overrides persist independently;
        // DRM/CORS force when either the global default or the site override
        // is on; the route prefers the site override, then the global default.
        return {
            debugMode: debugDefaults.debugMode || !!(siteDebug && siteDebug.debugMode),
            forceDrmCapture: debugDefaults.forceDrmCapture || !!(siteDebug && siteDebug.forceDrmCapture),
            forceCorsCapture: debugDefaults.forceCorsCapture || !!(siteDebug && siteDebug.forceCorsCapture),
            debugRouteMode: (siteDebug && siteDebug.debugRouteMode !== 'auto') ? siteDebug.debugRouteMode
                : debugDefaults.debugRouteMode
        };
    }
    function applyDebugHighlight(on) {
        // "Show Debug Highlight" — the options-page debug border around hooked
        // <video> elements (same rule as the demo site's globals.css), applied
        // at page level because the media lives outside the shadow root.
        try {
            document.documentElement.classList.toggle('vc-debug-highlight', !!on);
            if (on && !document.getElementById('vc-debug-highlight-style')) {
                var st = document.createElement('style');
                st.id = 'vc-debug-highlight-style';
                st.textContent = 'html.vc-debug-highlight video{outline:2px solid #2e7d32;outline-offset:2px;}';
                (document.head || document.documentElement).appendChild(st);
            }
        } catch (e) { /* page blocks styling */ }
    }
    applyDebugHighlight(effectiveDebugConfig().debugMode);

    var siteSettings = store.get(SITE_KEY, null) || null;   // {remember, volume, mono, muted, normalizer}
    var excluded = siteBlockedByLists();
    var normalizerConfig = (function () {
        var cfg = store.get('vc-normalizer-config', null);
        if (!cfg || typeof cfg !== 'object') return DEFAULT_NORMALIZER_CONFIG;
        var merged = {};
        for (var k in DEFAULT_NORMALIZER_CONFIG) merged[k] = DEFAULT_NORMALIZER_CONFIG[k];
        for (var k2 in cfg) if (k2 in merged) merged[k2] = cfg[k2];
        if (merged.mode !== 'music' && merged.mode !== 'adaptive') merged.mode = 'music';
        merged.targetDb = Math.max(-30, Math.min(-6, Number(merged.targetDb) || -16));
        merged.maxBoostDb = Math.max(0, Math.min(24, Number(merged.maxBoostDb) || 12));
        merged.ceilingDb = Math.max(-6, Math.min(-0.1, Number(merged.ceilingDb) || -1));
        merged.responseMs = Math.max(100, Math.min(3000, Number(merged.responseMs) || 600));
        return merged;
    })();

    // Live state (what the engine receives).
    var state = {
        enabled: !excluded,
        dB: siteSettings && siteSettings.remember ? normalizeDb(siteSettings.volume) : 0,
        mono: !!(siteSettings && siteSettings.remember && siteSettings.mono),
        muted: !!(siteSettings && siteSettings.remember && siteSettings.muted),
        normalizerEnabled: !!(siteSettings && siteSettings.remember && siteSettings.normalizer)
    };
    var remembered = !!(siteSettings && siteSettings.remember);
    var restriction = '';            // '' | 'restricted' | 'cross-origin'
    var meter = { peakDb: -Infinity, normalizerGainDb: 0 };
    var meterListeners = [];

    function persistSite() {
        if (!remembered) { store.del(SITE_KEY); return; }
        store.set(SITE_KEY, {
            remember: true,
            volume: state.dB,
            mono: state.mono,
            muted: state.muted,
            normalizer: state.normalizerEnabled
        });
    }

    // ============================================================= bridge
    var PAGE_BRIDGE_TOKEN = makeToken();

    function currentState() {
        return {
            enabled: state.enabled,
            dB: state.dB,
            mono: state.mono,
            muted: state.muted,
            normalizerEnabled: state.normalizerEnabled,
            normalizerConfig: normalizerConfig,
            debugMode: effectiveDebugConfig().debugMode,
            forceDrmCapture: effectiveDebugConfig().forceDrmCapture,
            forceCorsCapture: effectiveDebugConfig().forceCorsCapture,
            debugRouteMode: effectiveDebugConfig().debugRouteMode
        };
    }

    function sendState() {
        try {
            var s = currentState();
            var msg = {
                source: BRIDGE_SOURCE,
                target: BRIDGE_TARGET,
                token: PAGE_BRIDGE_TOKEN,
                command: 'setState',
                version: BRIDGE_VERSION
            };
            for (var k in s) msg[k] = s[k];
            window.postMessage(msg, '*');
        } catch (e) { /* page tearing down */ }
    }

    function sendHeartbeat() {
        try {
            window.postMessage({
                source: BRIDGE_SOURCE,
                target: BRIDGE_TARGET,
                token: PAGE_BRIDGE_TOKEN,
                command: 'heartbeat',
                version: BRIDGE_VERSION
            }, '*');
        } catch (e) { /* ignore */ }
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        var data = event.data;
        if (!data || data.source !== BRIDGE_TARGET || data.target !== BRIDGE_SOURCE) return;
        if (data.token !== PAGE_BRIDGE_TOKEN) return;

        if (data.command === 'requestState') {
            sendState();
        } else if (data.command === 'locationChanged') {
            // SPA navigation inside the same site — nothing changes for us
            // (settings are per-hostname), but re-sync in case the hook reset.
            sendState();
        } else if (data.command === 'pageRestrictionChanged') {
            restriction = data.restriction === 'restricted' ? 'restricted'
                : data.restriction === 'cross-origin' ? 'cross-origin' : '';
            notifyUI();
        } else if (data.command === 'meterUpdate') {
            var peak = Number(data.peakDb);
            var gain = Number(data.normalizerGainDb);
            meter.peakDb = Number.isFinite(peak) ? peak : -Infinity;
            meter.normalizerGainDb = Number.isFinite(gain) ? gain : 0;
            for (var i = 0; i < meterListeners.length; i++) {
                try { meterListeners[i](meter); } catch (e) { /* listener died */ }
            }
        }
    });

    // ============================================================= engine
    function hookInstalled() {
        try {
            var w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            return !!(w[HOOK_KEY] && w[HOOK_KEY].installed);
        } catch (e) { return false; }
    }

    function injectEngineInline() {
        // Exactly what the extension does: a MAIN-world <script> at
        // document_start. Blocked by strict page CSP on some sites.
        try {
            var s = document.createElement('script');
            s.textContent = ENGINE_SOURCE;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
            return true;
        } catch (e) { return false; }
    }

    function injectEngineSandbox() {
        // CSP-proof fallback: run the engine in this sandbox but hand it the
        // *page* window, so its prototype patches and history patches apply to
        // the real page (identical observable behavior).
        try {
            var w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            var fn = new Function('window', 'self', 'globalThis', ENGINE_SOURCE);
            fn(w, w, w);
            return true;
        } catch (e) { return false; }
    }

    function bootEngine() {
        if (hookInstalled()) { sendState(); startHeartbeat(); return; }
        injectEngineInline();
        var tries = 0;
        var poll = setInterval(function () {
            tries++;
            if (hookInstalled()) {
                clearInterval(poll);
                sendState();
                startHeartbeat();
            } else if (tries >= 20) {          // ~2s: CSP blocked the inline tag
                clearInterval(poll);
                injectEngineSandbox();
                if (hookInstalled()) { sendState(); startHeartbeat(); }
            }
        }, 100);
        // The engine may also already be mid-install from a previous frame
        // event; always start the heartbeat — it is harmless and the engine
        // reconnects on the first beat after its own 10s timeout.
        setTimeout(startHeartbeat, 2500);
    }

    var heartbeatTimer = null;
    function startHeartbeat() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    }

    // ============================================================= actions
    function setVolume(db) {
        state.dB = Math.max(MIN_DB, Math.min(restriction === 'restricted' ? 0 : MAX_DB, normalizeDb(db)));
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleMute() {
        state.muted = !state.muted;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleMono() {
        if (restriction === 'restricted') return;
        state.mono = !state.mono;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleNormalizer() {
        if (restriction === 'restricted') return;
        state.normalizerEnabled = !state.normalizerEnabled;
        persistSite();
        sendState();
        notifyUI();
    }
    function toggleRemember() {
        remembered = !remembered;
        if (remembered) persistSite(); else store.del(SITE_KEY);
        notifyUI();
    }
    function toggleActive() {
        // popup.js/options.js semantics: Active edits the access list that
        // governs this site — the blocklist entry in Blacklist mode, the
        // whitelist entry in Whitelist mode.
        if (lists.whitelistMode) {
            var allowed = lists.whitelist.some(function (e) { return listEntryMatches(e, HOST); });
            lists.whitelist = allowed
                ? lists.whitelist.filter(function (e) { return !listEntryMatches(e, HOST); })
                : lists.whitelist.concat([HOST]);
        } else {
            var blocked = lists.blocklist.some(function (e) { return listEntryMatches(e, HOST); });
            lists.blocklist = blocked
                ? lists.blocklist.filter(function (e) { return !listEntryMatches(e, HOST); })
                : lists.blocklist.concat([HOST]);
        }
        persistLists();
        excluded = siteBlockedByLists();
        state.enabled = !excluded;
        sendState();
        notifyUI();
    }
    function resetSiteSettings() {
        store.del(SITE_KEY);
        store.del(EXCLUDED_KEY);
        lists.blocklist = lists.blocklist.filter(function (e) { return !listEntryMatches(e, HOST); });
        persistLists();
        remembered = false;
        excluded = siteBlockedByLists();
        state.enabled = !excluded; state.dB = 0; state.mono = false;
        state.muted = false; state.normalizerEnabled = false;
        sendState();
        notifyUI();
    }

    // ============================================================= UI (top frame)
    var ui = null;

    function notifyUI() { if (ui) ui.refresh(); }

    function buildUI() {
        var host = document.createElement('div');
        host.id = 'volume-control-tm-host';
        // A real 42x42 box (not a 0x0 point): it is the positioning context
        // for the absolute button (inset 0) and the popup anchor (52px above
        // its bottom edge). Dragging rewrites right/bottom on this host.
        host.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:18px;width:42px;height:42px;';
        var shadow = host.attachShadow({ mode: 'open' });

        var style = document.createElement('style');
        style.textContent = POPUP_CSS + FLOATING_CSS + ADVANCED_CSS;
        shadow.appendChild(style);

        // ---- floating button (the "toolbar icon") ---------------------------
        var btn = document.createElement('button');
        btn.className = 'vc-tm-btn';
        btn.type = 'button';
        btn.title = 'Volume Control (Alt+Shift+P)';
        btn.setAttribute('aria-label', 'Volume Control');
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
            '<path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>' +
            '<path d="M14 8a5 5 0 0 1 0 8M16.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
            '</svg><span class="vc-tm-badge" aria-hidden="true"></span>';
        shadow.appendChild(btn);

        var badge = btn.querySelector('.vc-tm-badge');

        // ---- popup (popup.html structure, popup.css classes) ----------------
        var popupWrap = document.createElement('div');
        popupWrap.className = 'vc-popup-anchor';
        popupWrap.innerHTML = POPUP_HTML + ADVANCED_HTML;
        shadow.appendChild(popupWrap);
        var root = popupWrap.querySelector('.vc-popup.vc-main');
        var advRoot = popupWrap.querySelector('.vc-advanced');
        var content = root.querySelector('#popup-content');

        var slider = root.querySelector('#volume-slider');
        var volumeText = root.querySelector('#volume-text');
        var muteBtn = root.querySelector('#mute-btn');
        var muteLabel = root.querySelector('.mute-label');
        var limitNote = root.querySelector('#volume-limit-note');
        var boostWarning = root.querySelector('#volume-boost-warning');
        var normCheckbox = root.querySelector('#normalizer-checkbox');
        var normNote = root.querySelector('#normalizer-note');
        var normDetails = root.querySelector('#normalizer-details');
        var normGain = root.querySelector('#normalizer-gain');
        var meterFill = root.querySelector('#peak-meter-fill');
        var meterText = root.querySelector('#peak-meter-text');
        var meterEl = root.querySelector('.peak-meter');
        var peakWarn = root.querySelector('#peak-safety-warning');
        var monoCheckbox = root.querySelector('#mono-checkbox');
        var rememberCheckbox = root.querySelector('#remember-checkbox');
        var activeCheckbox = root.querySelector('#enable-checkbox');
        var settingsBtn = root.querySelector('#settings');
        var exclusionMsg = root.querySelector('.exclusion-message');
        var exclusionDetail = root.querySelector('.exclusion-detail');

        // ---- advanced view elements ------------------------------------------
        var advBack = advRoot.querySelector('.vc-adv-back');
        var advMode = advRoot.querySelector('#adv-mode');
        var advTarget = advRoot.querySelector('#adv-target');
        var advBoost = advRoot.querySelector('#adv-boost');
        var advCeiling = advRoot.querySelector('#adv-ceiling');
        var advResponse = advRoot.querySelector('#adv-response');
        var advTruePeak = advRoot.querySelector('#adv-truepeak');
        var advEngine = advRoot.querySelector('#adv-engine-status');
        var advDataNote = advRoot.querySelector('#adv-data-note');
        var advResetAll = advRoot.querySelector('#adv-reset-all');
        // site access + debug override elements (v7.1.4)
        var advListMode = advRoot.querySelector('#adv-list-mode');
        var advAccessStatus = advRoot.querySelector('#adv-access-status');
        var advSiteInput = advRoot.querySelector('#adv-site-input');
        var advSiteAdd = advRoot.querySelector('#adv-site-add');
        var advSiteStatus = advRoot.querySelector('#adv-site-status');
        var advSiteList = advRoot.querySelector('#adv-site-list');
        var advDbgHighlight = advRoot.querySelector('#adv-debug-highlight');
        var advForceDrm = advRoot.querySelector('#adv-force-drm');
        var advForceCors = advRoot.querySelector('#adv-force-cors');
        var advRoute = advRoot.querySelector('#adv-route');
        var advSiteDebug = advRoot.querySelector('#adv-site-debug');
        var advSiteDebugLabel = advRoot.querySelector('#adv-site-debug-label');
        var advSdControls = advRoot.querySelector('#adv-site-debug-controls');
        var advSdHighlight = advRoot.querySelector('#adv-sd-highlight');
        var advSdDrm = advRoot.querySelector('#adv-sd-drm');
        var advSdCors = advRoot.querySelector('#adv-sd-cors');
        var advSdRoute = advRoot.querySelector('#adv-sd-route');

        // dark mode follows the browser like the extension popup
        var darkQuery = null;
        try { darkQuery = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) {}
        function applyTheme() {
            var dark = !!(darkQuery && darkQuery.matches);
            root.classList.toggle('vc-popup-dark', dark);
            advRoot.classList.toggle('vc-popup-dark', dark);
        }
        applyTheme();
        if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);

        // ---- popup.js behaviors ---------------------------------------------
        var textDebounce = null;
        var wheelRemainder = 0;
        var lastMeterPaint = 0;

        function maxDb() { return restriction === 'restricted' ? 0 : MAX_DB; }
        function displayDb() { return Math.min(state.dB, maxDb()); }

        function commitText(raw) {
            var t = String(raw == null ? '' : raw).trim();
            if (!/^[+-]?\d+$/.test(t)) return;
            setVolume(Number(t));
            volumeText.value = (displayDb() >= 0 ? '+' : '') + displayDb();
        }

        slider.addEventListener('input', function () {
            setVolume(Number(slider.value));
        });
        volumeText.addEventListener('input', function () {
            if (textDebounce) clearTimeout(textDebounce);
            var raw = volumeText.value;
            textDebounce = setTimeout(function () { commitText(raw); }, 300);
        });
        volumeText.addEventListener('blur', function () {
            if (textDebounce) { clearTimeout(textDebounce); textDebounce = null; }
            commitText(volumeText.value);
            volumeText.value = (displayDb() >= 0 ? '+' : '') + displayDb();
        });
        volumeText.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') {
                if (textDebounce) { clearTimeout(textDebounce); textDebounce = null; }
                commitText(volumeText.value);
                volumeText.value = (displayDb() >= 0 ? '+' : '') + displayDb();
            }
        });
        root.addEventListener('wheel', function (e) {
            var active = shadow.activeElement;
            if (active && active.id === 'volume-text') return;
            var delta = Number(e.deltaY) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1);
            if (!Number.isFinite(delta) || delta === 0) return;
            var adjustment = delta;
            if (Math.abs(delta) >= 15) {
                wheelRemainder = 0;
            } else {
                if (wheelRemainder && Math.sign(delta) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
                wheelRemainder += delta;
                if (Math.abs(wheelRemainder) < 15) return;
                adjustment = wheelRemainder;
                wheelRemainder -= Math.sign(wheelRemainder) * 15;
            }
            var currentDb = Number(slider.value);
            var direction = adjustment > 0 ? -1 : 1;   // wheel down = quieter (popup.js)
            var nextDb = Math.min(normalizeDb(currentDb + direction), maxDb());
            if (nextDb === currentDb) return;
            e.preventDefault();
            setVolume(nextDb);
        }, { passive: false });

        muteBtn.addEventListener('click', toggleMute);
        normCheckbox.addEventListener('change', toggleNormalizer);
        monoCheckbox.addEventListener('change', toggleMono);
        rememberCheckbox.addEventListener('change', toggleRemember);
        activeCheckbox.addEventListener('change', toggleActive);
        settingsBtn.addEventListener('click', function () {
            // Open the in-popup Advanced view (the extension's options-page
            // settings that apply to the userscript engine). The website link
            // lives inside the view.
            if (!open) setOpen(true);
            setView('advanced');
            syncAdvanced();
            try { advBack.focus({ preventScroll: true }); } catch (e) {}
        });

        // ---- advanced view --------------------------------------------------
        var view = 'main';
        function setView(v) {
            view = v;
            popupWrap.setAttribute('data-view', v);
            if (v === 'advanced') fitAdvancedPanel();
        }
        setView('main');

        // The advanced panel is capped at calc(100vh - 120px), but a button
        // dragged high on the page leaves less room than that — cap the panel
        // to the space actually available above the anchor so its top (and the
        // sticky Back header) never spills past the top of the viewport.
        function fitAdvancedPanel() {
            try {
                var hostRect = host.getBoundingClientRect();
                var spaceAbove = Math.max(220, hostRect.bottom - 60);
                var cap = Math.min(spaceAbove, window.innerHeight - 120);
                advRoot.style.maxHeight = Math.round(cap) + 'px';
            } catch (e) { /* keep the CSS cap */ }
        }
        fitAdvancedPanel();
        window.addEventListener('resize', fitAdvancedPanel);

        function safeVal(input, v) {
            // do not clobber an input the user is editing right now
            if (shadow.activeElement === input) return;
            input.value = v;
        }
        function syncAdvanced() {
            safeVal(advMode, normalizerConfig.mode);
            safeVal(advTarget, normalizerConfig.targetDb);
            safeVal(advBoost, normalizerConfig.maxBoostDb);
            safeVal(advCeiling, normalizerConfig.ceilingDb);
            safeVal(advResponse, normalizerConfig.responseMs);
            if (shadow.activeElement !== advTruePeak) advTruePeak.checked = !!normalizerConfig.experimentalTruePeak;
            var installed = hookInstalled();
            advEngine.textContent = installed
                ? 'Engine: active on this page \u2014 hook installed'
                : 'Engine: waiting (strict-CSP pages fall back within ~2 s)';
            syncAccess();
            syncDebug();
        }
        function commitAdvanced() {
            var cfg = {
                mode: advMode.value === 'adaptive' ? 'adaptive' : 'music',
                targetDb: Math.max(-30, Math.min(-6, Math.round(Number(advTarget.value) || -16))),
                maxBoostDb: Math.max(0, Math.min(24, Math.round(Number(advBoost.value) || 12))),
                ceilingDb: Math.max(-6, Math.min(-0.1, Number(advCeiling.value) || -1)),
                responseMs: Math.max(100, Math.min(3000, Math.round(Number(advResponse.value) || 600))),
                experimentalTruePeak: !!advTruePeak.checked
            };
            normalizerConfig = cfg;
            store.set('vc-normalizer-config', cfg);
            sendState();          // engine applies the new config live
            syncAdvanced();
        }
        [advMode, advTarget, advBoost, advCeiling, advResponse, advTruePeak].forEach(function (el) {
            el.addEventListener('change', commitAdvanced);
        });

        // ---- site access lists (options.html Blocked/Allowed Sites) ---------
        function normalizeAccessInput(raw) {
            // shared.js input normalizer: strip scheme, credentials, port and
            // a leading www.; any path/query stays (informational).
            var v = String(raw == null ? '' : raw).trim().toLowerCase();
            v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
            v = v.replace(/^[^/@]+@/, '');
            v = v.replace(/:\d+(?=\/|$)/, '');
            v = v.replace(/^www\./, '');
            return v.replace(/^\/+/, '');
        }
        var accessStatusTimer = null;
        function showAccessStatus(text) {
            advSiteStatus.textContent = text;
            advSiteStatus.classList.remove('vc-empty');
            if (accessStatusTimer) clearTimeout(accessStatusTimer);
            accessStatusTimer = setTimeout(function () {
                advSiteStatus.textContent = '';
                advSiteStatus.classList.add('vc-empty');
            }, 4000);
        }
        function renderAccessList() {
            var entries = lists.whitelistMode ? lists.whitelist : lists.blocklist;
            advSiteList.innerHTML = '';
            entries.forEach(function (entry) {
                var row = document.createElement('div');
                row.className = 'vc-adv-entry' + (listEntryMatches(entry, HOST) ? ' vc-current' : '');
                var name = document.createElement('span');
                name.textContent = entry;
                name.title = 'Matches ' + String(entry).split('/')[0] + ' and its subdomains';
                var rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'vc-adv-remove';
                rm.textContent = '\u00d7';
                rm.setAttribute('aria-label', 'Remove ' + entry);
                rm.addEventListener('click', function () { removeAccessEntry(entry); });
                row.appendChild(name);
                row.appendChild(rm);
                advSiteList.appendChild(row);
            });
        }
        function syncAccess() {
            if (shadow.activeElement !== advListMode) {
                advListMode.value = lists.whitelistMode ? 'whitelist' : 'blacklist';
            }
            advAccessStatus.textContent = location.hostname + (excluded
                ? ' \u2014 blocked by the ' + (lists.whitelistMode ? 'whitelist (not listed)' : 'blocklist')
                : ' \u2014 active on this site');
            renderAccessList();
        }
        function applyAccessChange() {
            excluded = siteBlockedByLists();
            state.enabled = !excluded;
            sendState();
            syncAccess();
            refresh();
        }
        function addAccessEntry() {
            var entry = normalizeAccessInput(advSiteInput.value);
            var domain = entry.split('/')[0];
            if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
                showAccessStatus('Enter a domain like example.com');
                return;
            }
            var target = lists.whitelistMode ? lists.whitelist : lists.blocklist;
            if (target.indexOf(entry) !== -1) {
                showAccessStatus(entry + ' is already in the list.');
                return;
            }
            target.push(entry);
            persistLists();
            advSiteInput.value = '';
            applyAccessChange();
            showAccessStatus(entry + ' added to ' + (lists.whitelistMode ? 'allowed' : 'blocked') + ' sites.');
        }
        function removeAccessEntry(entry) {
            if (lists.whitelistMode) {
                lists.whitelist = lists.whitelist.filter(function (e) { return e !== entry; });
            } else {
                lists.blocklist = lists.blocklist.filter(function (e) { return e !== entry; });
            }
            persistLists();
            applyAccessChange();
        }
        advSiteAdd.addEventListener('click', addAccessEntry);
        advSiteInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); addAccessEntry(); }
        });
        advListMode.addEventListener('change', function () {
            lists.whitelistMode = advListMode.value === 'whitelist';
            persistLists();
            applyAccessChange();
        });

        // ---- debug overrides (options.html Debug section) --------------------
        function syncDebug() {
            if (shadow.activeElement !== advDbgHighlight) advDbgHighlight.checked = !!debugDefaults.debugMode;
            if (shadow.activeElement !== advForceDrm) advForceDrm.checked = !!debugDefaults.forceDrmCapture;
            if (shadow.activeElement !== advForceCors) advForceCors.checked = !!debugDefaults.forceCorsCapture;
            if (shadow.activeElement !== advRoute) advRoute.value = debugDefaults.debugRouteMode;
            advSiteDebugLabel.textContent = 'Override for this site \u2014 ' + location.hostname;
            advSiteDebug.checked = !!siteDebug;
            advSdControls.hidden = !siteDebug;
            advSdHighlight.checked = !!(siteDebug && siteDebug.debugMode);
            advSdDrm.checked = !!(siteDebug && siteDebug.forceDrmCapture);
            advSdCors.checked = !!(siteDebug && siteDebug.forceCorsCapture);
            advSdRoute.value = siteDebug ? siteDebug.debugRouteMode : 'auto';
        }
        function commitDebugDefaults() {
            debugDefaults = {
                debugMode: !!advDbgHighlight.checked,
                forceDrmCapture: !!advForceDrm.checked,
                forceCorsCapture: !!advForceCors.checked,
                debugRouteMode: (advRoute.value === 'webaudio' || advRoute.value === 'native') ? advRoute.value : 'auto'
            };
            store.set(DEBUG_DEFAULTS_KEY, debugDefaults);
            sendState();                                   // engine applies live
            applyDebugHighlight(effectiveDebugConfig().debugMode);
            syncDebug();
        }
        function commitSiteDebug() {
            siteDebug = {
                debugMode: !!advSdHighlight.checked,
                forceDrmCapture: !!advSdDrm.checked,
                forceCorsCapture: !!advSdCors.checked,
                debugRouteMode: (advSdRoute.value === 'webaudio' || advSdRoute.value === 'native') ? advSdRoute.value : 'auto'
            };
            store.set(DEBUG_SITE_KEY, siteDebug);
            sendState();
            applyDebugHighlight(effectiveDebugConfig().debugMode);
            syncDebug();
        }
        [advDbgHighlight, advForceDrm, advForceCors, advRoute].forEach(function (el) {
            el.addEventListener('change', commitDebugDefaults);
        });
        [advSdHighlight, advSdDrm, advSdCors, advSdRoute].forEach(function (el) {
            el.addEventListener('change', commitSiteDebug);
        });
        advSiteDebug.addEventListener('change', function () {
            if (advSiteDebug.checked) {
                siteDebug = normalizeDebugConfig(null);
                store.set(DEBUG_SITE_KEY, siteDebug);
            } else {
                siteDebug = null;
                store.del(DEBUG_SITE_KEY);
            }
            sendState();
            applyDebugHighlight(effectiveDebugConfig().debugMode);
            syncDebug();
        });
        advBack.addEventListener('click', function () {
            setView('main');
            try { slider.focus({ preventScroll: true }); } catch (e) {}
        });
        // engine status is async (CSP fallback) — refresh it while visible
        setInterval(function () {
            if (!open || view !== 'advanced') return;
            var installed = hookInstalled();
            advEngine.textContent = installed
                ? 'Engine: active on this page \u2014 hook installed'
                : 'Engine: waiting (strict-CSP pages fall back within ~2 s)';
        }, 1000);
        // Reset all data (two-click confirm; GM_listValues when available)
        var resetArmed = false, resetTimer = null;
        advResetAll.addEventListener('click', function () {
            if (!resetArmed) {
                resetArmed = true;
                advResetAll.textContent = 'Sure? Click again';
                clearTimeout(resetTimer);
                resetTimer = setTimeout(function () {
                    resetArmed = false; advResetAll.textContent = 'Reset all data';
                }, 3500);
                return;
            }
            var n = 0;
            try {
                if (typeof GM_listValues === 'function') {
                    GM_listValues().forEach(function (k) { store.del(k); n++; });
                } else {
                    ['vc-first-run', 'vc-btn-pos', 'vc-normalizer-config', SITE_KEY, EXCLUDED_KEY,
                     LISTS_KEY, DEBUG_DEFAULTS_KEY, DEBUG_SITE_KEY]
                        .forEach(function (k) { store.del(k); n++; });
                }
            } catch (e) {}
            // live state back to fresh-install values
            remembered = false;
            lists = { blocklist: [], whitelist: [], whitelistMode: false };
            debugDefaults = normalizeDebugConfig(null);
            siteDebug = null;
            applyDebugHighlight(false);
            excluded = siteBlockedByLists();
            state.enabled = true; state.dB = 0; state.mono = false;
            state.muted = false; state.normalizerEnabled = false;
            normalizerConfig = DEFAULT_NORMALIZER_CONFIG;
            sendState();
            refresh();
            syncAdvanced();
            advDataNote.textContent = n + ' entries cleared. Reload pages to see the first-run intro again.';
            resetArmed = false;
            advResetAll.textContent = 'Reset \u2713';
            setTimeout(function () { advResetAll.textContent = 'Reset all data'; }, 2500);
        });

        // ---- open/close -------------------------------------------------------
        // The class goes on the ANCHOR (popupWrap): FLOATING_CSS raises the
        // anchor from opacity:0 — toggling a class on the child popup can
        // never make it visible (the parent would stay at opacity:0).
        var open = false;
        function setOpen(v) {
            open = v;
            popupWrap.classList.toggle('vc-tm-open', open);
            if (open) {
                refresh();
                try { slider.focus({ preventScroll: true }); } catch (e) {}
            } else {
                setView('main');   // next open starts at the volume view
            }
        }
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (btn.dataset.dragged) return;   // this click just ended a drag
            setOpen(!open);
        });
        document.addEventListener('click', function (e) {
            if (!open) return;
            if (e.composedPath().indexOf(host) === -1) setOpen(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && open) setOpen(false);
        });

        // ---- drag (button) ----------------------------------------------------
        var drag = null;
        btn.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            drag = { x: e.clientX, y: e.clientY, moved: false };
        });
        window.addEventListener('pointermove', function (e) {
            if (!drag) return;
            var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
            drag.moved = true;
            // Measure the HOST, not the button: while dragging, the pointer
            // stays over the button, so its :hover scale(1.06) transform is
            // active — deriving position from btn.getBoundingClientRect()
            // accumulates the scale error on every pointermove and the button
            // drifts away from the pointer. The host is never transformed.
            var rect = host.getBoundingClientRect();
            var right = window.innerWidth - rect.right - dx;
            var bottom = window.innerHeight - rect.bottom - dy;
            right = Math.max(4, Math.min(window.innerWidth - rect.width - 4, right));
            bottom = Math.max(4, Math.min(window.innerHeight - rect.height - 4, bottom));
            host.style.right = right + 'px';
            host.style.bottom = bottom + 'px';
            drag.x = e.clientX; drag.y = e.clientY;
            store.set('vc-btn-pos', { right: right, bottom: bottom });
        });
        window.addEventListener('pointerup', function () {
            if (drag && drag.moved) btn.dataset.dragged = '1';
            drag = null;
            setTimeout(function () { delete btn.dataset.dragged; }, 50);
        });


        // restore position
        var pos = store.get('vc-btn-pos', null);
        if (pos && typeof pos.right === 'number' && typeof pos.bottom === 'number') {
            host.style.right = Math.max(4, pos.right) + 'px';
            host.style.bottom = Math.max(4, pos.bottom) + 'px';
        }

        // ---- fullscreen adoption ---------------------------------------------
        // When the page enters fullscreen (YouTube player etc.) everything
        // outside the fullscreen element is hidden — including this host. Move
        // the host INTO the fullscreen element so the button and popup stay
        // usable while watching, and back to <html> when fullscreen exits.
        // Media elements cannot render children, so those are skipped.
        function adoptFullscreen() {
            try {
                var fs = document.fullscreenElement || document.webkitFullscreenElement;
                if (fs && fs.appendChild) {
                    var tag = (fs.tagName || '').toLowerCase();
                    var canHoldChildren = tag !== 'video' && tag !== 'audio' && tag !== 'canvas'
                        && tag !== 'img' && tag !== 'picture' && tag !== 'iframe' && tag !== 'object';
                    if (canHoldChildren && fs !== host.parentNode) fs.appendChild(host);
                } else if (!fs && host.parentNode !== document.documentElement) {
                    document.documentElement.appendChild(host);
                }
            } catch (e) { /* page blocked the move — stay put */ }
        }
        document.addEventListener('fullscreenchange', adoptFullscreen);
        document.addEventListener('webkitfullscreenchange', adoptFullscreen);
        adoptFullscreen();   // in case the UI was built while already fullscreen

        // ---- one-time attention pulse (first run after install/update) -----
        function pulseButton() {
            btn.classList.remove('vc-tm-pulse');
            void btn.offsetWidth;            // restart the animation
            btn.classList.add('vc-tm-pulse');
            setTimeout(function () { btn.classList.remove('vc-tm-pulse'); }, 1700);
        }

        // ---- meter (125 ms paint throttle, like popup.js) ---------------------
        meterListeners.push(function (m) {
            var now = Date.now();
            if (now - lastMeterPaint < 125 || !open) return;
            lastMeterPaint = now;
            var peakDb = Number.isFinite(m.peakDb) ? m.peakDb : -Infinity;
            var clamped = Number.isFinite(peakDb) ? Math.max(-60, Math.min(0, peakDb)) : -60;
            meterFill.style.width = (((clamped + 60) / 60) * 100).toFixed(2) + '%';
            meterText.textContent = formatMeterDb(peakDb);
            meterEl.setAttribute('aria-valuenow', clamped.toFixed(1));
            var shown = Number.isFinite(m.normalizerGainDb) ? m.normalizerGainDb : 0;
            normGain.textContent = 'Gain ' + (shown >= 0 ? '+' : '') + shown.toFixed(1) + ' dB';
            peakWarn.classList.toggle('hidden',
                !(state.normalizerEnabled && restriction !== 'restricted' && Number.isFinite(peakDb) && peakDb >= -0.3));
        });

        // ---- refresh (badge + controls) ---------------------------------------
        function refresh() {
            var active = state.enabled;
            var m = maxDb();
            var shown = displayDb();

            // badge (background.js semantics)
            if (state.muted) {
                badge.textContent = 'MUTE'; badge.className = 'vc-tm-badge vc-tm-badge-red';
            } else if (shown > 0) {
                badge.textContent = '+' + shown; badge.className = 'vc-tm-badge vc-tm-badge-green';
            } else if (shown < 0) {
                badge.textContent = String(shown); badge.className = 'vc-tm-badge vc-tm-badge-red';
            } else {
                badge.textContent = '0'; badge.className = 'vc-tm-badge vc-tm-badge-gray';
            }
            badge.style.display = (state.muted || shown !== 0) ? '' : 'none';

            content.classList.toggle('excluded-site', !active);
            content.classList.toggle('is-muted', state.muted);
            exclusionMsg.classList.toggle('hidden', active);
            exclusionDetail.textContent = location.hostname + (lists.whitelistMode
                ? ' is not on the allowed-sites list. Toggle Active, or add it under Settings → Site access, to reactivate.'
                : ' is on the blocked-sites list. Toggle Active, or remove it under Settings → Site access, to reactivate.');

            slider.value = String(shown);
            slider.max = String(m);
            slider.style.setProperty('--vc-range-steps', String(Math.max(1, m - MIN_DB)));
            slider.disabled = !active;

            volumeText.value = (shown >= 0 ? '+' : '') + shown;
            volumeText.disabled = !active;

            muteBtn.classList.toggle('muted', state.muted);
            muteLabel.textContent = state.muted ? 'Unmute' : 'Mute';
            muteBtn.disabled = !active;

            var restricted = restriction === 'restricted';
            limitNote.classList.toggle('hidden', !(restricted && active));
            boostWarning.classList.toggle('hidden', !(shown >= 6 && active));

            normCheckbox.checked = state.normalizerEnabled;
            normCheckbox.disabled = restricted || !active;
            normNote.classList.toggle('hidden', !restricted);
            if (restricted) normNote.textContent = 'Normalize cannot process DRM-protected audio in this browser.';
            normDetails.hidden = !(state.normalizerEnabled && !restricted);

            monoCheckbox.checked = state.mono;
            monoCheckbox.disabled = restricted || !active;
            rememberCheckbox.checked = remembered;
            activeCheckbox.checked = active;
        }
        refresh();

        document.documentElement.appendChild(host);
        return {
            refresh: refresh,
            setOpen: setOpen,
            setView: setView,
            pulse: pulseButton,
            isOpen: function () { return open; },
            showAccess: function () {
                setView('advanced');
                syncAdvanced();
                try { advListMode.focus({ preventScroll: true }); } catch (e) {}
            }
        };
    }

    // popup.html markup (extension classes, popup.css-driven)
    var POPUP_HTML =
        '<div class="vc-popup vc-main" role="dialog" aria-label="Volume Control popup">' +
        '  <div id="popup-content" class="">' +
        '    <div class="exclusion-message hidden">' +
        '      <div class="exclusion-title">Volume Control is disabled for this site.</div>' +
        '      <div class="exclusion-detail"></div>' +
        '    </div>' +
        '    <div class="top-controls">' +
        '      <input type="range" id="volume-slider" min="-32" max="32" step="1" aria-label="Volume control"' +
        '        aria-describedby="volume-limit-note volume-boost-warning" title="Volume control (Alt+Shift+Up/Down to adjust)"/>' +
        '      <p id="volume-limit-note" class="volume-limit-note hidden" role="status">' +
        '        Boosting, mono, and Normalize may be unavailable on DRM/CORS-restricted media because the browser only allows fallback volume control. You can still lower volume and mute.' +
        '      </p>' +
        '      <p id="volume-boost-warning" class="volume-limit-note hidden" role="note">' +
        '        Large positive volume boosts can distort loud audio; the compressor is not a guaranteed true-peak limiter.' +
        '      </p>' +
        '      <div class="volume-row">' +
        '        <button id="mute-btn" class="mute-btn" type="button" title="Mute/Unmute" aria-label="Mute or unmute audio">' +
        '          <svg class="mute-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
        '            <path class="speaker-shape" d="M3 9v6h4l5 5V4L7 9H3z"/>' +
        '            <path class="wave-shape" d="M14 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '            <path class="wave-shape" d="M16.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '            <line class="mute-x" x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
        '          </svg>' +
        '          <span class="mute-label">Mute</span>' +
        '        </button>' +
        '        <span class="volume-display">' +
        '          <input type="text" id="volume-text" inputmode="numeric" aria-label="Volume in decibels"/>' +
        '          <span class="volume-unit" aria-hidden="true">dB</span>' +
        '        </span>' +
        '      </div>' +
        '      <div class="normalizer-panel">' +
        '        <div class="normalizer-header">' +
        '          <label class="switch-container normalizer-switch" for="normalizer-checkbox"' +
        '            title="Automatically even out loud and quiet audio">' +
        '            <div class="switch"><input type="checkbox" id="normalizer-checkbox"/><span class="slider"></span></div>' +
        '            <span class="label-text">Normalize</span>' +
        '          </label>' +
        '        </div>' +
        '        <p id="normalizer-note" class="normalizer-note hidden" role="status"></p>' +
        '        <div id="normalizer-details" class="normalizer-details" hidden>' +
        '          <div class="normalizer-detail-header">' +
        '            <span id="normalizer-gain" class="normalizer-gain" aria-live="polite">Gain +0.0 dB</span>' +
        '          </div>' +
        '          <div class="peak-meter-row">' +
        '            <div class="peak-meter" role="meter" aria-label="Output peak level" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60">' +
        '              <div id="peak-meter-fill" class="peak-meter-fill" style="width:0%"></div>' +
        '              <div class="peak-meter-ceiling" title="\u22121 dBFS reference mark, not a hard ceiling"></div>' +
        '            </div>' +
        '            <span id="peak-meter-text" class="peak-meter-text">\u2212\u221E dBFS</span>' +
        '          </div>' +
        '          <p id="peak-safety-warning" class="normalizer-note hidden" role="note">' +
        '            Output sample peaks are near digital full scale. Inter-sample peaks may be higher; lower manual boost if you hear distortion.' +
        '          </p>' +
        '        </div>' +
        '      </div>' +
        '    </div>' +
        '    <div class="bot-controls">' +
        '      <div class="left">' +
        '        <label class="switch-container" for="mono-checkbox" title="Toggle Mono Audio">' +
        '          <div class="switch"><input type="checkbox" id="mono-checkbox"/><span class="slider"></span></div>' +
        '          <span class="label-text">Mono</span>' +
        '        </label>' +
        '        <label class="switch-container" for="remember-checkbox" title="Remember volume for this site">' +
        '          <div class="switch"><input type="checkbox" id="remember-checkbox"/><span class="slider"></span></div>' +
        '          <span class="label-text">Remember</span>' +
        '        </label>' +
        '      </div>' +
        '      <div class="right">' +
        '        <label class="switch-container" for="enable-checkbox" title="Enable/Disable on this site">' +
        '          <div class="switch"><input type="checkbox" id="enable-checkbox"/><span class="slider"></span></div>' +
        '          <span class="label-text">Active</span>' +
        '        </label>' +
        '        <button id="settings" class="settings" type="button" aria-label="Open advanced options">Settings</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

    // advanced-options view (the extension options.html settings that apply
    // to the userscript engine — verbatim labels, ranges and units)
    var ADVANCED_HTML =
        '<div class="vc-popup vc-advanced" role="dialog" aria-label="Advanced options">' +
        '  <div class="vc-adv-head">' +
        '    <button class="vc-adv-back" type="button" aria-label="Back to volume controls">\u2039 Back</button>' +
        '    <span class="vc-adv-title">Advanced options</span>' +
        '    <a class="vc-adv-site" href="https://chaython.github.io/volumecontrol/" target="_blank" rel="noreferrer">Website \u2197</a>' +
        '  </div>' +
        '  <div class="vc-adv-body">' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Normalizer</div>' +
        '      <label class="vc-adv-row"><span>Normalization style</span>' +
        '        <select id="adv-mode">' +
        '          <option value="music">Music \u2014 preserve song dynamics (recommended)</option>' +
        '          <option value="adaptive">Adaptive \u2014 faster speech/video leveling</option>' +
        '        </select></label>' +
        '      <div class="vc-adv-grid">' +
        '        <label class="vc-adv-field"><span>Target loudness</span>' +
        '          <input type="number" id="adv-target" min="-30" max="-6" step="1" inputmode="decimal"/><em>dBFS RMS</em></label>' +
        '        <label class="vc-adv-field"><span>Maximum auto boost</span>' +
        '          <input type="number" id="adv-boost" min="0" max="24" step="1" inputmode="decimal"/><em>dB</em></label>' +
        '        <label class="vc-adv-field"><span>Compressor threshold</span>' +
        '          <input type="number" id="adv-ceiling" min="-6" max="-0.1" step="0.1" inputmode="decimal"/><em>dBFS</em></label>' +
        '        <label class="vc-adv-field"><span>Response speed (Adaptive)</span>' +
        '          <input type="number" id="adv-response" min="100" max="3000" step="50" inputmode="numeric"/><em>ms</em></label>' +
        '      </div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-truepeak"/>' +
        '        <span>Experimental true-peak limiter (opt-in; isolated fallback route)</span></label>' +
        '      <div class="vc-adv-hint">Defaults: Music style, \u221216 dBFS RMS target, +12 dB max auto boost, \u22121 dBFS compressor threshold. Response speed applies to Adaptive style. Changes apply live to every site using Normalize.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Site access</div>' +
        '      <div class="vc-adv-row"><span>List mode</span>' +
        '        <select id="adv-list-mode" aria-label="List mode">' +
        '          <option value="blacklist">Blacklist — block listed sites</option>' +
        '          <option value="whitelist">Whitelist — allow only listed sites</option>' +
        '        </select></div>' +
        '      <div class="vc-adv-row"><span id="adv-access-status"></span></div>' +
        '      <div class="vc-adv-addrow">' +
        '        <input type="text" id="adv-site-input" placeholder="example.com" aria-label="Site domain to add" spellcheck="false"/>' +
        '        <button id="adv-site-add" class="vc-adv-add" type="button">Add site</button>' +
        '      </div>' +
        '      <div id="adv-site-status" class="vc-adv-status vc-empty" role="status"></div>' +
        '      <div id="adv-site-list" class="vc-adv-list"></div>' +
        '      <div class="vc-adv-hint">Blacklist: listed sites are skipped entirely (native volume only). Whitelist: only listed sites run Volume Control. Entries match subdomains, and the popup’s Active toggle edits the same list for this site.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Debug overrides</div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-debug-highlight"/>' +
        '        <span>Show Debug Highlight — green border around hooked video elements</span></label>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-force-drm"/>' +
        '        <span>Force DRM Audio Capture (Debug Only)</span></label>' +
        '      <div class="vc-adv-hint vc-adv-warn">Warning: disables DRM/EME safety checks and forces protected media through WebAudio. This can mute audio or break playback. Reload the tab after changing.</div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-force-cors"/>' +
        '        <span>Skip CORS Media Guard (Debug Only)</span></label>' +
        '      <div class="vc-adv-hint vc-adv-warn">Warning: attempts WebAudio capture for cross-origin media; browsers may output silence for tainted media.</div>' +
        '      <div class="vc-adv-row"><span>HTML media route</span>' +
        '        <select id="adv-route" aria-label="HTML media route override">' +
        '          <option value="auto">Automatic (recommended)</option>' +
        '          <option value="webaudio">Force WebAudio / GainNode</option>' +
        '          <option value="native">Force native volume fallback</option>' +
        '        </select></div>' +
        '      <label class="vc-adv-check"><input type="checkbox" id="adv-site-debug"/>' +
        '        <span id="adv-site-debug-label">Override for this site</span></label>' +
        '      <div id="adv-site-debug-controls" class="vc-adv-sitebox" hidden>' +
        '        <label class="vc-adv-check"><input type="checkbox" id="adv-sd-highlight"/><span>Highlight</span></label>' +
        '        <label class="vc-adv-check"><input type="checkbox" id="adv-sd-drm"/><span>DRM</span></label>' +
        '        <label class="vc-adv-check"><input type="checkbox" id="adv-sd-cors"/><span>CORS</span></label>' +
        '        <select id="adv-sd-route" aria-label="Route override for this site">' +
        '          <option value="auto">Route: Auto</option>' +
        '          <option value="webaudio">Route: WebAudio</option>' +
        '          <option value="native">Route: Native</option>' +
        '        </select>' +
        '      </div>' +
        '      <div class="vc-adv-hint">Applies live to the engine on every open tab. Per-site overrides persist independently; DRM/CORS force when either the default or the site override is on.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Engine</div>' +
        '      <div class="vc-adv-row"><span id="adv-engine-status">Engine: \u2026</span></div>' +
        '      <div class="vc-adv-hint">The audio engine is the extension\u2019s real page-audio-hook.js. On strict-CSP sites the inline install is blocked and it falls back automatically \u2014 nothing to configure.</div>' +
        '    </div>' +
        '    <div class="vc-adv-section">' +
        '      <div class="vc-adv-h">Data</div>' +
        '      <div class="vc-adv-row vc-adv-data"><span id="adv-data-note">Sites, remembered volumes, positions, access lists, debug overrides.</span>' +
        '        <button id="adv-reset-all" class="vc-adv-danger" type="button">Reset all data</button></div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

    // floating-host additions (button + positioning of the popup itself).
    // The host (0x0, fixed, 18px from the corner, max z-index) is the single
    // positioning context: the button and the popup anchor are absolute
    // inside it, so the 18px margin, the saved drag position (host style) and
    // the popup offset all move together. The open state lives on the ANCHOR
    // (.vc-popup-anchor.vc-tm-open): a parent with opacity:0 hides the whole
    // subtree, so the class must raise the anchor itself, and closed-state
    // pointer-events:none inherits down (an invisible popup must not swallow
    // page clicks).
    var FLOATING_CSS = [
        '.vc-tm-btn{position:absolute;right:0;bottom:0;width:42px;height:42px;border-radius:50%;',
        'border:1px solid rgba(0,0,0,.15);background:#fff;color:#333;box-shadow:0 2px 10px rgba(0,0,0,.25);',
        'cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;',
        'transition:transform .12s ease,box-shadow .12s ease;}',
        '.vc-tm-btn:hover{transform:scale(1.06);box-shadow:0 4px 14px rgba(0,0,0,.3);}',
        '.vc-tm-btn:active{transform:scale(.97);}',
        '.vc-tm-badge{position:absolute;top:-7px;right:-7px;min-width:20px;height:18px;padding:0 5px;',
        'border-radius:9px;font:bold 11px/18px "Segoe UI",Tahoma,sans-serif;color:#fff;',
        'box-shadow:0 1px 3px rgba(0,0,0,.35);letter-spacing:.2px;}',
        '.vc-tm-badge-green{background:#2e7d32;}',
        '.vc-tm-badge-red{background:#c62828;}',
        '.vc-tm-badge-gray{background:#5f6368;}',
        '.vc-popup-anchor{position:absolute;right:0;bottom:52px;width:420px;max-width:calc(100vw - 24px);',
        'pointer-events:none;opacity:0;transform:translateY(6px) scale(.98);',
        'transition:opacity .14s ease,transform .14s ease;}',
        '.vc-popup-anchor.vc-tm-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}',
        '.vc-popup-anchor .vc-popup{box-shadow:0 12px 40px rgba(0,0,0,.35);',
        'border-radius:8px;overflow:hidden;}',
        '@media (max-width:480px){.vc-popup-anchor{width:calc(100vw - 24px);}}',
        '@media (prefers-color-scheme:dark){.vc-tm-btn{background:#202124;color:#e8eaed;border-color:rgba(255,255,255,.2);}}',
        '@keyframes vc-tm-pulse{0%{transform:scale(1);}45%{transform:scale(1.16);',
        'box-shadow:0 6px 26px rgba(0,0,0,.4);}100%{transform:scale(1);}}',
        '.vc-tm-btn.vc-tm-pulse{animation:vc-tm-pulse 1.3s ease 1;}'
    ].join('');

    // advanced-view styles (scoped to the shadow root; light + dark like popup.css)
    var ADVANCED_CSS = [
        '.vc-popup-anchor[data-view="advanced"] .vc-main{display:none;}',
        '.vc-popup-anchor[data-view="main"] .vc-advanced{display:none;}',
        // .vc-popup-anchor .vc-popup sets overflow:hidden (corner clipping) at
        // higher specificity — override it so this panel actually scrolls.
        '.vc-popup-anchor .vc-popup.vc-advanced{max-height:calc(100vh - 120px);overflow-y:auto;}',
        '.vc-advanced::-webkit-scrollbar{width:8px;}',
        '.vc-advanced::-webkit-scrollbar-thumb{background:rgba(0,0,0,.25);border-radius:4px;}',
        '.vc-adv-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.12);',
        'position:sticky;top:0;background:#fff;z-index:2;}',
        '.vc-adv-back{border:1px solid rgba(0,0,0,.2);background:#fff;color:#333;border-radius:6px;',
        'padding:4px 10px;font:600 12px/1.4 "Segoe UI",Tahoma,sans-serif;cursor:pointer;}',
        '.vc-adv-back:hover{background:#f1f3f4;}',
        '.vc-adv-title{flex:1;font:700 13px/1.4 "Segoe UI",Tahoma,sans-serif;color:#202124;}',
        '.vc-adv-site{font:600 12px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;text-decoration:none;}',
        '.vc-adv-site:hover{color:#202124;}',
        '.vc-adv-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px;}',
        '.vc-adv-section{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:10px;}',
        '.vc-adv-h{font:700 11px/1.4 "Segoe UI",Tahoma,sans-serif;color:#202124;text-transform:uppercase;',
        'letter-spacing:.5px;margin-bottom:8px;}',
        '.vc-adv-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:400 12px/1.5 "Segoe UI",Tahoma,sans-serif;color:#3c4043;}',
        '.vc-adv-row select{margin-left:auto;border:1px solid rgba(0,0,0,.25);border-radius:6px;background:#fff;',
        'color:#202124;padding:4px 6px;font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;max-width:230px;}',
        '.vc-adv-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;}',
        '.vc-adv-field{display:flex;flex-direction:column;gap:2px;font:600 11px/1.3 "Segoe UI",Tahoma,sans-serif;color:#5f6368;}',
        '.vc-adv-field input{border:1px solid rgba(0,0,0,.25);border-radius:6px;padding:5px 6px;width:100%;',
        'box-sizing:border-box;background:#fff;color:#202124;font:500 13px/1 "Segoe UI",Tahoma,sans-serif;}',
        '.vc-adv-field input:focus{outline:2px solid #9aa0a6;outline-offset:-1px;}',
        '.vc-adv-field em{font:400 10px/1.2 "Segoe UI",Tahoma,sans-serif;color:#80868b;font-style:normal;}',
        '.vc-adv-check{display:flex;gap:6px;align-items:flex-start;font:400 11px/1.4 "Segoe UI",Tahoma,sans-serif;',
        'color:#3c4043;margin-top:6px;cursor:pointer;}',
        '.vc-adv-check input{margin-top:2px;}',
        '.vc-adv-hint{font:400 11px/1.5 "Segoe UI",Tahoma,sans-serif;color:#80868b;margin-top:8px;}',
        '.vc-adv-data{justify-content:space-between;align-items:center;}',
        '.vc-adv-data span{font:400 11px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;max-width:230px;}',
        '.vc-adv-danger{border:1px solid #c62828;color:#c62828;background:#fff;border-radius:6px;padding:5px 10px;',
        'font:600 12px/1.4 "Segoe UI",Tahoma,sans-serif;cursor:pointer;white-space:nowrap;}',
        '.vc-adv-danger:hover{background:#fce8e6;}',
        '.vc-adv-addrow{display:flex;gap:6px;margin-top:8px;}',
        '.vc-adv-addrow input{flex:1;min-width:0;border:1px solid rgba(0,0,0,.25);border-radius:6px;padding:5px 8px;',
        'background:#fff;color:#202124;font:500 12px/1.2 "Segoe UI",Tahoma,sans-serif;}',
        '.vc-adv-addrow input:focus{outline:2px solid #9aa0a6;outline-offset:-1px;}',
        '.vc-adv-add{border:1px solid rgba(0,0,0,.25);background:#fff;color:#3c4043;border-radius:6px;',
        'padding:5px 10px;font:600 12px/1.2 "Segoe UI",Tahoma,sans-serif;cursor:pointer;white-space:nowrap;}',
        '.vc-adv-add:hover{background:#f1f3f4;}',
        '.vc-adv-status{font:400 11px/1.4 "Segoe UI",Tahoma,sans-serif;color:#5f6368;margin-top:6px;}',
        '.vc-adv-status.vc-empty{display:none;}',
        '.vc-adv-list{display:flex;flex-direction:column;gap:4px;margin-top:6px;}',
        '.vc-adv-entry{display:flex;align-items:center;justify-content:space-between;gap:8px;',
        'border:1px solid rgba(0,0,0,.12);border-radius:6px;padding:4px 6px 4px 10px;background:#fff;',
        'font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;color:#3c4043;}',
        '.vc-adv-entry.vc-current{border-color:#2e7d32;color:#2e7d32;}',
        '.vc-adv-remove{border:none;background:transparent;color:#c62828;font:700 14px/1 "Segoe UI",Tahoma,sans-serif;',
        'cursor:pointer;padding:2px 7px;border-radius:4px;}',
        '.vc-adv-remove:hover{background:#fce8e6;}',
        '.vc-adv-warn{color:#c62828;}',
        '.vc-adv-sitebox{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;',
        'border-top:1px dashed rgba(0,0,0,.15);padding-top:8px;}',
        '.vc-adv-sitebox select{border:1px solid rgba(0,0,0,.25);border-radius:6px;background:#fff;color:#202124;',
        'padding:4px 6px;font:500 12px/1.4 "Segoe UI",Tahoma,sans-serif;margin-left:auto;}',
        '.vc-popup-dark .vc-adv-head{border-color:rgba(255,255,255,.15);background:#202124;}',
        '.vc-popup-dark .vc-adv-back{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-back:hover{background:#3c4043;}',
        '.vc-popup-dark .vc-adv-title{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-site{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-site:hover{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-section{border-color:rgba(255,255,255,.15);}',
        '.vc-popup-dark .vc-adv-h{color:#e8eaed;}',
        '.vc-popup-dark .vc-adv-row{color:#bdc1c6;}',
        '.vc-popup-dark .vc-adv-row select{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-field{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-field input{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-check{color:#bdc1c6;}',
        '.vc-popup-dark .vc-adv-hint{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-data span{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-danger{background:transparent;}',
        '.vc-popup-dark .vc-adv-danger:hover{background:rgba(198,40,40,.2);}',
        '.vc-popup-dark .vc-adv-addrow input{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-add{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-adv-add:hover{background:#3c4043;}',
        '.vc-popup-dark .vc-adv-status{color:#9aa0a6;}',
        '.vc-popup-dark .vc-adv-entry{background:#292a2d;color:#bdc1c6;border-color:rgba(255,255,255,.15);}',
        '.vc-popup-dark .vc-adv-entry.vc-current{border-color:#81c995;color:#81c995;}',
        '.vc-popup-dark .vc-adv-remove:hover{background:rgba(198,40,40,.2);}',
        '.vc-popup-dark .vc-adv-sitebox{border-color:rgba(255,255,255,.15);}',
        '.vc-popup-dark .vc-adv-sitebox select{background:#292a2d;color:#e8eaed;border-color:rgba(255,255,255,.25);}',
        '.vc-popup-dark .vc-advanced::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);}'
    ].join('');

    // ============================================================= hotkeys
    function hotkeyTargetOk(target) {
        if (!target) return true;
        var t = target;
        var tag = (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
        if (t.isContentEditable) return false;
        return true;
    }

    document.addEventListener('keydown', function (e) {
        if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
        var key = e.key;
        if (key === 'ArrowUp') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            setVolume(state.dB + 1);
        } else if (key === 'ArrowDown') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            setVolume(state.dB - 1);
        } else if (key === '0') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            setVolume(0);
        } else if (key === 'm' || key === 'M') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            toggleMono();
        } else if (key === 'u' || key === 'U') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            toggleMute();
        } else if (key === 'p' || key === 'P') {
            if (!hotkeyTargetOk(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            // toggle via the controller's own open state — the previous DOM
            // query could not see into the shadow root, so P could only open
            if (ui && ui.isOpen) uiOpenToggle(!ui.isOpen());
        }
    }, true);

    function uiOpenToggle(open) {
        if (ui && ui.setOpen) ui.setOpen(open);
    }

    // ============================================================= menu
    if (IS_TOP_FRAME && typeof GM_registerMenuCommand === 'function') {
        try {
            GM_registerMenuCommand('Open Volume Control', function () { uiOpenToggle(true); });
            GM_registerMenuCommand('Volume +1 dB', function () { setVolume(state.dB + 1); });
            GM_registerMenuCommand('Volume −1 dB', function () { setVolume(state.dB - 1); });
            GM_registerMenuCommand('Reset volume (0 dB)', function () { setVolume(0); });
            GM_registerMenuCommand('Toggle mute', toggleMute);
            GM_registerMenuCommand('Toggle mono', toggleMono);
            GM_registerMenuCommand('Disable on this site', toggleActive);
            GM_registerMenuCommand('Site access lists (block/allow)', function () {
                uiOpenToggle(true);
                if (ui && ui.showAccess) ui.showAccess();
            });
            GM_registerMenuCommand('Reset settings for this site', resetSiteSettings);
        } catch (e) { /* menu not available */ }
    }

    // ============================================================= boot
    bootEngine();

    if (IS_TOP_FRAME) {
        var startUI = function () {
            if (ui) return;
            try { ui = buildUI(); } catch (e) { /* page blocks DOM insertion */ }
            // First run after install or update: open the popup once and
            // pulse the button, so the GUI is impossible to miss.
            if (ui && store.get('vc-first-run', true)) {
                store.set('vc-first-run', false);
                setTimeout(function () {
                    try { ui.pulse(); ui.setOpen(true); } catch (e) {}
                }, 650);
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startUI, { once: true });
        } else {
            startUI();
        }
    }
})();
