(() => {
    const HOOK_KEY = "__volumeControlPageAudioHook";
    const BRIDGE_SOURCE = "volume-control-extension";
    const BRIDGE_TARGET = "volume-control-page-audio";
    const MEDIA_MANAGED_ATTR = "vcPageAudioManaged";
    const MIN_DB = -32;
    const MAX_DB = 32;
    const BRIDGE_VERSION = 3;
    const HEARTBEAT_TIMEOUT_MS = 10000;
    const supportsWeakRef = typeof WeakRef !== "undefined";

    if (window[HOOK_KEY] && window[HOOK_KEY].installed) return;

    const state = {
        enabled: true,
        dB: 0,
        mono: false,
        muted: false,
        normalizerEnabled: false,
        normalizerConfig: { targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 600 },
        debugMode: false,
        forceDrmCapture: false,
        forceCorsCapture: false,
        debugRouteMode: "auto",
        extensionActive: false
    };
    function effectiveGain() {
        // When the extension is inactive (disabled, blocked, or heartbeat lost),
        // pass audio through at unity so page audio behaves natively.
        if (!state.extensionActive || !state.enabled) return 1.0;
        if (state.muted) return 0;
        return getGainValue(state.dB);
    }

    let lastHeartbeat = Date.now();
    let bridgeToken = null;
    let hooksInstalled = false;
    let mediaObserver = null;
    let maintenanceTimerIds = [];
    let normalizerMeterTimerId = null;
    let howlerPollId = null;
    let gestureListenersInstalled = false;
    let authorizationResolved = false;
    let preflightReleaseTimer = null;
    const PREFLIGHT_FAILSAFE_MS = 3000;
    const preflightMutedElements = new Set();
    const preflightOriginalMuted = new WeakMap();
    const preflightDesiredMuted = new WeakMap();
    const pendingContextSuspends = new WeakMap();

    const graphs = new WeakMap();
    const contexts = new Set();
    const selfSuspendedContexts = new WeakSet();
    const vcNodes = new WeakSet();
    const destinationConnections = new Set();
    const howlerRoutes = new WeakMap();
    const mediaElements = new Set();
    const mediaState = new WeakMap();
    const mediaRoutes = new WeakMap();
    let mediaAudioContext = null;

    const AudioNodePrototype = window.AudioNode && window.AudioNode.prototype;
    const nativeConnect = AudioNodePrototype && AudioNodePrototype.connect;
    const nativeDisconnect = AudioNodePrototype && AudioNodePrototype.disconnect;
    const nativeAudioConstructor = window.Audio;
    const nativePlay = window.HTMLMediaElement && window.HTMLMediaElement.prototype && window.HTMLMediaElement.prototype.play;
    const nativeVolumeDescriptor = window.HTMLMediaElement && window.HTMLMediaElement.prototype
        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "volume")
        : null;
    const nativeMutedDescriptor = window.HTMLMediaElement && window.HTMLMediaElement.prototype
        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "muted")
        : null;
    const nativeSrcObjectDescriptor = window.HTMLMediaElement && window.HTMLMediaElement.prototype
        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "srcObject")
        : null;
    const DocumentPrototype = window.Document && window.Document.prototype;
    const nativeCreateElement = DocumentPrototype && DocumentPrototype.createElement;
    const nativeCreateElementNS = DocumentPrototype && DocumentPrototype.createElementNS;
    const nativeSetMediaKeys = window.HTMLMediaElement && window.HTMLMediaElement.prototype
        ? window.HTMLMediaElement.prototype.setMediaKeys
        : null;
    const nativeWebkitSetMediaKeys = window.HTMLMediaElement && window.HTMLMediaElement.prototype
        ? window.HTMLMediaElement.prototype.webkitSetMediaKeys
        : null;
    const NavigatorPrototype = window.Navigator && window.Navigator.prototype;
    const nativeRequestMediaKeySystemAccess = NavigatorPrototype && NavigatorPrototype.requestMediaKeySystemAccess;
    const MediaKeySystemAccessPrototype = window.MediaKeySystemAccess && window.MediaKeySystemAccess.prototype;
    const nativeCreateMediaKeys = MediaKeySystemAccessPrototype && MediaKeySystemAccessPrototype.createMediaKeys;
    const nativeHistoryPushState = window.history && window.history.pushState;
    const nativeHistoryReplaceState = window.history && window.history.replaceState;
    let spaNavigationNotify = null;

    function log(msg) {
        if (state.debugMode) console.log(`[VolumeControl/PageAudio] ${msg}`);
    }

    function normalizeDb(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(n)));
    }

    function getGainValue(dB) {
        const n = normalizeDb(dB);
        return Math.pow(10, n / 20);
    }

    function dbToGain(dB) {
        const n = Number(dB);
        return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
    }

    function normalizeNormalizerConfig(value = {}) {
        if (!value || typeof value !== "object") value = {};
        const finiteOr = (candidate, fallback) => {
            if (candidate == null || (typeof candidate === "string" && !candidate.trim())) return fallback;
            const n = Number(candidate);
            return Number.isFinite(n) ? n : fallback;
        };
        return {
            targetDb: Math.max(-30, Math.min(-6, finiteOr(value.targetDb, -16))),
            maxBoostDb: Math.max(0, Math.min(24, finiteOr(value.maxBoostDb, 12))),
            ceilingDb: Math.max(-6, Math.min(-0.1, finiteOr(value.ceilingDb, -1))),
            responseMs: Math.max(100, Math.min(3000, Math.round(finiteOr(value.responseMs, 600))))
        };
    }

    function configureLimiter(processor) {
        if (!processor || !processor.limiter) return;
        const config = normalizeNormalizerConfig(state.normalizerConfig);
        try {
            processor.limiter.threshold.value = config.ceilingDb;
            processor.limiter.knee.value = 0;
            processor.limiter.ratio.value = 20;
            processor.limiter.attack.value = 0.003;
            processor.limiter.release.value = 0.12;
        } catch (e) {
            log(`limiter configure failed: ${e && e.message}`);
        }
    }

    function markNode(node) {
        if (node) vcNodes.add(node);
        return node;
    }

    function isOfflineContext(context) {
        if (!context) return false;
        if (typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext) return true;
        if (typeof webkitOfflineAudioContext !== "undefined" && context instanceof webkitOfflineAudioContext) return true;
        return false;
    }

    function isContextDestination(node) {
        return Boolean(node && node.context && node === node.context.destination && !isOfflineContext(node.context));
    }

    function isMediaElement(value) {
        return Boolean(
            value &&
            window.HTMLMediaElement &&
            value instanceof window.HTMLMediaElement
        );
    }

    function getAudioContextConstructor() {
        return window.AudioContext || window.webkitAudioContext || null;
    }

    function safeDisconnect(node) {
        try {
            node.disconnect();
        } catch (e) {
            // disconnect() throws when a node has no outgoing connections in some browsers.
        }
    }

    function connectNative(source, destination, outputIndex, inputIndex) {
        if (!nativeConnect) return;
        if (outputIndex === undefined) return nativeConnect.call(source, destination);
        if (inputIndex === undefined) return nativeConnect.call(source, destination, outputIndex);
        return nativeConnect.call(source, destination, outputIndex, inputIndex);
    }

    function disconnectNative(source, destination, outputIndex, inputIndex) {
        if (!nativeDisconnect) return;
        if (destination === undefined) return nativeDisconnect.call(source);
        if (outputIndex === undefined) return nativeDisconnect.call(source, destination);
        if (inputIndex === undefined) return nativeDisconnect.call(source, destination, outputIndex);
        return nativeDisconnect.call(source, destination, outputIndex, inputIndex);
    }

    function makeNodeRef(node) {
        // Use WeakRef when available so GC'd nodes don't keep entries alive.
        // Fall back to a deref-passthrough wrapper on older engines.
        return supportsWeakRef ? new WeakRef(node) : { deref: () => node };
    }

    function nodeFromRef(ref) {
        // Both WeakRef and the fallback wrapper expose .deref()
        return ref ? ref.deref() : undefined;
    }

    function findDestinationConnection(source, destination, outputIndex, inputIndex) {
        for (const entry of destinationConnections) {
            const entrySource = nodeFromRef(entry.sourceRef);
            const entryDest = nodeFromRef(entry.destinationRef);
            if (
                entrySource === source &&
                entryDest === destination &&
                entry.outputIndex === outputIndex &&
                entry.inputIndex === inputIndex
            ) {
                return entry;
            }
        }
        return null;
    }

    function trackDestinationConnection(source, destination, outputIndex, inputIndex, routed) {
        const existing = findDestinationConnection(source, destination, outputIndex, inputIndex);
        if (existing) {
            existing.routed = routed;
            return existing;
        }

        const entry = {
            sourceRef: makeNodeRef(source),
            destinationRef: makeNodeRef(destination),
            contextRef: makeNodeRef(source.context || destination.context),
            outputIndex,
            inputIndex,
            routed
        };
        destinationConnections.add(entry);
        return entry;
    }

    function removeDestinationConnection(source, destination, outputIndex, inputIndex) {
        const entry = findDestinationConnection(source, destination, outputIndex, inputIndex);
        if (entry) destinationConnections.delete(entry);
        return entry;
    }

    function removeDestinationConnectionsForSource(source) {
        for (const entry of Array.from(destinationConnections)) {
            if (nodeFromRef(entry.sourceRef) === source) destinationConnections.delete(entry);
        }
    }

    function takeDestinationConnections(source, predicate) {
        const matches = [];
        for (const entry of Array.from(destinationConnections)) {
            if (nodeFromRef(entry.sourceRef) !== source) continue;
            if (!predicate(entry)) continue;
            destinationConnections.delete(entry);
            matches.push(entry);
        }
        return matches;
    }

    function disconnectTrackedRouteEntry(source, entry) {
        if (!entry || !entry.routed) return false;
        const graph = graphs.get(nodeFromRef(entry.contextRef));
        if (!graph) return false;
        try {
            disconnectNative(source, graph.inputAnalyser, entry.outputIndex, 0);
            return true;
        } catch (e) {
            log(`tracked route disconnect failed: ${e && e.message}`);
            return false;
        }
    }

    function sweepDeadDestinationConnections() {
        // Periodically remove entries whose source or destination has been GC'd.
        // This prevents the Set from growing unboundedly on pages that create
        // many short-lived audio nodes.
        for (const entry of Array.from(destinationConnections)) {
            const source = nodeFromRef(entry.sourceRef);
            const dest = nodeFromRef(entry.destinationRef);
            const ctx = nodeFromRef(entry.contextRef);
            if (!source || !dest || !ctx) {
                destinationConnections.delete(entry);
                continue;
            }
            // Also remove if the context has closed — all its nodes are dead.
            if (ctx.state === "closed") {
                destinationConnections.delete(entry);
            }
        }
    }

    function resumeContext(context) {
        if (!context || typeof context.resume !== "function") return Promise.resolve();
        const resumeNow = async () => {
            try {
                if (context.state === "suspended") await context.resume();
                selfSuspendedContexts.delete(context);
            } catch (e) {
                log(`context resume failed: ${e && e.message}`);
            }
        };
        const pending = pendingContextSuspends.get(context);
        return pending ? pending.catch(() => {}).then(resumeNow) : resumeNow();
    }

    function suspendContext(context, { trackSelf = false, label = "context" } = {}) {
        if (!context || typeof context.suspend !== "function") return Promise.resolve();
        const existing = pendingContextSuspends.get(context);
        if (existing) return existing;
        if (context.state !== "running") return Promise.resolve();

        let promise;
        promise = Promise.resolve()
            .then(() => context.suspend())
            .then(() => {
                if (trackSelf && context.state === "suspended") selfSuspendedContexts.add(context);
            })
            .catch((e) => {
                log(`${label} suspend failed: ${e && e.message}`);
            })
            .finally(() => {
                if (pendingContextSuspends.get(context) === promise) pendingContextSuspends.delete(context);
            });
        pendingContextSuspends.set(context, promise);
        return promise;
    }

    function readNativeMuted(element) {
        try {
            if (nativeMutedDescriptor && nativeMutedDescriptor.get) {
                return Boolean(nativeMutedDescriptor.get.call(element));
            }
            return Boolean(element && element.muted);
        } catch (e) {
            return false;
        }
    }

    function writeNativeMuted(element, value) {
        try {
            if (nativeMutedDescriptor && nativeMutedDescriptor.set) {
                nativeMutedDescriptor.set.call(element, Boolean(value));
            } else if (element) {
                element.muted = Boolean(value);
            }
        } catch (e) {}
    }

    function patchPreflightMuted() {
        if (!nativeMutedDescriptor || !nativeMutedDescriptor.get || !nativeMutedDescriptor.set ||
            !window.HTMLMediaElement || !window.HTMLMediaElement.prototype) return;

        const proto = window.HTMLMediaElement.prototype;
        const current = Object.getOwnPropertyDescriptor(proto, "muted");
        if (!current || !current.configurable || (current.set && current.set.name === "patchedPreflightMutedSetter")) return;

        try {
            Object.defineProperty(proto, "muted", {
                configurable: true,
                enumerable: nativeMutedDescriptor.enumerable,
                get: function patchedPreflightMutedGetter() {
                    return nativeMutedDescriptor.get.call(this);
                },
                set: function patchedPreflightMutedSetter(value) {
                    const desired = Boolean(value);
                    if (!authorizationResolved && preflightMutedElements.has(this)) {
                        // Preserve the site's newest intent but keep native audio
                        // muted until authorization resolves. This avoids both a
                        // loud startup burst and clobbering a site's mute/unmute.
                        preflightDesiredMuted.set(this, desired);
                        nativeMutedDescriptor.set.call(this, true);
                        return;
                    }
                    nativeMutedDescriptor.set.call(this, desired);
                }
            });
        } catch (e) {}
    }

    function restorePreflightMutedPatch() {
        if (!nativeMutedDescriptor || !window.HTMLMediaElement || !window.HTMLMediaElement.prototype) return;
        try {
            const proto = window.HTMLMediaElement.prototype;
            const current = Object.getOwnPropertyDescriptor(proto, "muted");
            if (current && current.set && current.set.name === "patchedPreflightMutedSetter") {
                Object.defineProperty(proto, "muted", nativeMutedDescriptor);
            }
        } catch (e) {}
    }

    function preflightMuteMedia(element) {
        if (authorizationResolved || !isMediaElement(element) || preflightMutedElements.has(element)) return;
        try {
            const originalMuted = readNativeMuted(element);
            preflightOriginalMuted.set(element, originalMuted);
            preflightDesiredMuted.set(element, originalMuted);
            preflightMutedElements.add(element);
            writeNativeMuted(element, true);
        } catch (e) {}
    }

    function releasePreflightMediaMute() {
        authorizationResolved = true;
        if (preflightReleaseTimer !== null) {
            clearTimeout(preflightReleaseTimer);
            preflightReleaseTimer = null;
        }
        for (const element of Array.from(preflightMutedElements)) {
            const desiredMuted = preflightDesiredMuted.has(element)
                ? Boolean(preflightDesiredMuted.get(element))
                : Boolean(preflightOriginalMuted.get(element));
            writeNativeMuted(element, desiredMuted);
            preflightMutedElements.delete(element);
        }
        restorePreflightMutedPatch();
    }

    function preflightPlaybackCapture(event) {
        if (!authorizationResolved) preflightMuteMedia(event && event.target);
    }

    patchPreflightMuted();
    document.addEventListener("play", preflightPlaybackCapture, true);
    document.addEventListener("playing", preflightPlaybackCapture, true);
    // Do not drop the protective mute on an arbitrary 250 ms timer: service
    // worker/content-script startup can legitimately take longer. setState()
    // releases it as soon as authorization is known; this is only a last-resort
    // escape hatch if the extension handshake never arrives.
    preflightReleaseTimer = setTimeout(releasePreflightMediaMute, PREFLIGHT_FAILSAFE_MS);

    function isMediaPlaying(element) {
        return Boolean(element && !element.paused && !element.ended);
    }

    function isAudibleMediaElement(element) {
        if (!isMediaElement(element)) return false;
        if (element.muted) return false;
        return getMediaState(element).baseVolume > 0;
    }

    // Returns true if any media element has an active (playing + audible + connected)
    // route on the given context. If context is omitted, checks the mediaAudioContext.
    function hasActiveMediaRoute(context) {
        for (const element of mediaElements) {
            const route = mediaRoutes.get(element);
            if (route && route.outputConnected &&
                (!context || route.context === context) &&
                isMediaPlaying(element) && isAudibleMediaElement(element)) {
                return true;
            }
        }
        return false;
    }

    // Disconnect the output side of all media routes on the given context.
    // If context is omitted, disconnects all routes.
    function disconnectAllMediaRouteOutputs(context) {
        for (const element of Array.from(mediaElements)) {
            const route = mediaRoutes.get(element);
            if (route && (!context || route.context === context)) {
                disconnectMediaRouteOutput(route);
            }
        }
    }

    function suspendMediaContextIfIdle() {
        // Also suspend any idle page-level contexts we've routed through.
        suspendIdleContexts();

        if (!mediaAudioContext || mediaAudioContext.state === "closed") return;
        if (mediaAudioContext.state !== "running") return;

        if (hasActiveMediaRoute(mediaAudioContext)) return;

        disconnectAllMediaRouteOutputs(mediaAudioContext);

        // Check if any media routes remain after disconnecting idle ones.
        let hasAnyRoute = false;
        for (const element of mediaElements) {
            if (mediaRoutes.has(element)) { hasAnyRoute = true; break; }
        }

        // Suspend the context to release the OS audio device handle. This is
        // critical for Bluetooth devices that stay active while a running
        // AudioContext holds the output stream open. Per the WebAudio spec,
        // a suspended context releases the audio device in all major browsers
        // (Chrome, Firefox, Safari), so suspend() is sufficient for Bluetooth
        // idle without the irrecoverable state that close() creates.
        //
        // We deliberately do NOT close() even when no routes remain. close()
        // would destroy any MediaElementSource routes still held in mediaRoutes,
        // and those routes can only be created ONCE per element per context.
        // If the page later reuses the same <video> element (YouTube/Twitch
        // auto-next, replay after ended, etc.), close() would permanently kill
        // audio for that element until the page is reloaded. suspend() preserves
        // the routes so they can be rewired on resume.
        //
        // hasAnyRoute is preserved here as documentation; suspend() works for
        // both branches (with routes -> keep routes alive but idle; without
        // routes -> just release the device handle).
        suspendContext(mediaAudioContext, { label: "media context" }).then(() => {
            log(hasAnyRoute
                ? "media context suspended (idle routes kept) — device handle released"
                : "media context suspended (no routes) — device handle released");
        });
    }

    // Iterate every tracked page context, pruning dead/closed entries.
    // Entries are WeakRefs when available: a strong Set would pin contexts
    // the page abandoned without close() (games, per-interaction contexts)
    // for the tab's lifetime — each retained context counts against Chrome's
    // per-tab AudioContext quota, eventually breaking the SITE's own audio.
    function eachTrackedContext(fn) {
        for (const entry of Array.from(contexts)) {
            const ctx = (supportsWeakRef && entry instanceof WeakRef)
                ? (typeof entry.deref === "function" ? entry.deref() : null)
                : entry;
            if (!ctx || ctx.state === "closed") {
                contexts.delete(entry);
                continue;
            }
            fn(ctx);
        }
    }

    function addTrackedContext(context) {
        contexts.add(supportsWeakRef ? new WeakRef(context) : context);
    }

    // Resume a context ONLY when the extension itself suspended it. Pages call
    // suspend() deliberately (pause-on-blur, battery savers); those must stay
    // suspended. A context WE suspended that receives a new destination
    // connection (page playing its next sound) must be revived, or the new
    // audio would silently play into a suspended context — "extension killed
    // my game audio".
    function resumeIfSelfSuspended(context) {
        try {
            if (context && (selfSuspendedContexts.has(context) || pendingContextSuspends.has(context))) {
                resumeContext(context);
            }
        } catch (e) {}
    }

    function suspendIdleContexts() {
        // Suspend page-level AudioContexts that the extension has routed through
        // but which no longer have any active audio sources. This is critical for
        // Bluetooth devices: a running AudioContext keeps the OS audio output
        // stream open, preventing the device from returning to idle.
        eachTrackedContext((ctx) => {
            if (ctx.state !== "running") return;
            if (ctx === mediaAudioContext) return; // handled by suspendMediaContextIfIdle

            // Check if any media route on this context is still playing.
            if (hasActiveMediaRoute(ctx)) return;

            // Check if any destination connection on this context is still
            // tracked (routed OR native). Counting only routed connections
            // meant a context whose connections we had restored to native
            // (e.g. after the user set 0 dB) would be suspended while its
            // audio was still playing — killing audio on sites whose graphs
            // we had previously routed through.
            let hasTrackedConnection = false;
            for (const entry of destinationConnections) {
                if (nodeFromRef(entry.contextRef) === ctx) {
                    hasTrackedConnection = true;
                    break;
                }
            }
            if (hasTrackedConnection) return;

            suspendContext(ctx, { trackSelf: true, label: "page context" }).then(() => {
                log(`page context suspended (idle): state=${ctx.state}`);
            });
        });
    }

    function disconnectMediaRouteOutput(route) {
        if (!route) return;

        safeDisconnect(route.gain);
        safeDisconnect(route.splitter);
        safeDisconnect(route.leftGain);
        safeDisconnect(route.rightGain);
        safeDisconnect(route.merger);
        safeDisconnect(route.limiter);
        safeDisconnect(route.analyser);
        route.outputConnected = false;
    }

    function releaseMediaRoute(element) {
        const route = mediaRoutes.get(element);
        if (!route) return;

        disconnectMediaRouteOutput(route);

        // Do NOT disconnect route.source from route.inputAnalyser, and do NOT delete the
        // route from mediaRoutes. The MediaElementSourceNode can only be created
        // once per element per context, so we must keep the existing source node
        // alive so it can be reconnected when playback resumes (e.g., after
        // 'ended' the user clicks replay). disconnectMediaRouteOutput already
        // disconnected gain→destination, so no audio flows while idle.
        //
        // The WeakMap entry is automatically collected when the element itself
        // is GC'd (WeakMap keys are weak), so there is no memory leak.

        try {
            setNativeVolume(element, getMediaState(element).baseVolume);
        } catch (e) {
            log(`media release volume restore failed: ${e && e.message}`);
        }
    }

    function setGainValue(graph) {
        const autoGain = state.normalizerEnabled ? dbToGain(graph.normalizerGainDb || 0) : 1;
        const targetGain = effectiveGain() * autoGain;
        try {
            const now = graph.context.currentTime;
            if (graph.context.state === "running") {
                // Smooth ramp to avoid audible clicks/spikes when the user drags
                // the slider rapidly. 15ms is short enough to feel responsive but
                // long enough to prevent zipper noise.
                graph.gain.gain.cancelScheduledValues(now);
                graph.gain.gain.setValueAtTime(graph.gain.gain.value, now);
                graph.gain.gain.linearRampToValueAtTime(targetGain, now + 0.015);
            } else {
                graph.gain.gain.value = targetGain;
            }
        } catch (e) {
            log(`gain update failed: ${e && e.message}`);
        }
    }

    // Compute the current routing mode string from state. Used by wireGraph and
    // wireMediaRoute to skip redundant disconnect/reconnect cycles.
    function safetyLimiterRequired() {
        // Keep clipping protection for manual positive boosts. At unity or
        // attenuation with Normalize off, bypass the compressor entirely:
        // even a nominal -1 dBFS compressor introduces processing/latency.
        return state.extensionActive && state.enabled &&
            (state.normalizerEnabled || (!state.muted && state.dB > 0));
    }

    function currentRoutingMode() {
        if (!state.extensionActive || !state.enabled) return "bypass";
        return (state.mono ? "mono" : "stereo") +
            (safetyLimiterRequired() ? "-limited" : "-direct");
    }

    // Connect a mono down-mix chain: gain → splitter → L/R gains → merger → destination.
    // Used by wireGraph (page-level contexts) and wireMediaRoute (media element routes).
    function connectMonoChain(gain, splitter, leftGain, rightGain, merger, destination) {
        connectNative(gain, splitter);
        connectNative(splitter, leftGain, 0);
        connectNative(splitter, rightGain, 1);
        connectNative(leftGain, merger, 0, 0);
        connectNative(rightGain, merger, 0, 0);
        connectNative(leftGain, merger, 0, 1);
        connectNative(rightGain, merger, 0, 1);
        connectNative(merger, destination);
    }

    function wireGraph(graph) {
        setGainValue(graph);
        // Configuration changes must take effect even when the topology is
        // unchanged (e.g. positive manual boost, Normalize off).
        configureLimiter(graph);

        // Skip the disconnect/reconnect cycle if the routing mode hasn't changed.
        const wantMode = currentRoutingMode();
        if (graph.currentMode === wantMode) return;

        safeDisconnect(graph.gain);
        safeDisconnect(graph.splitter);
        safeDisconnect(graph.leftGain);
        safeDisconnect(graph.rightGain);
        safeDisconnect(graph.merger);
        safeDisconnect(graph.limiter);
        safeDisconnect(graph.analyser);

        try {
            const useLimiter = safetyLimiterRequired();
            const output = useLimiter ? graph.limiter : graph.context.destination;
            if (state.extensionActive && state.enabled && state.mono) {
                connectMonoChain(graph.gain, graph.splitter, graph.leftGain, graph.rightGain, graph.merger, output);
            } else {
                connectNative(graph.gain, output);
            }
            if (useLimiter) {
                configureLimiter(graph);
                connectNative(graph.limiter, graph.analyser);
                connectNative(graph.analyser, graph.context.destination);
            }
            // A failed graph rebuild must be retryable on the next state sync.
            graph.currentMode = wantMode;
        } catch (e) {
            graph.currentMode = null;
            log(`graph wire failed: ${e && e.message}`);
        }
    }

    function ensureGraph(context) {
        if (!context || isOfflineContext(context)) return null;
        if (graphs.has(context)) return graphs.get(context);

        try {
            const gain = markNode(context.createGain());
            // Measure source RMS before the slider and automatic gain.
            const inputAnalyser = markNode(context.createAnalyser());
            const splitter = markNode(context.createChannelSplitter(2));
            const leftGain = markNode(context.createGain());
            const rightGain = markNode(context.createGain());
            const merger = markNode(context.createChannelMerger(2));
            const limiter = markNode(context.createDynamicsCompressor());
            const analyser = markNode(context.createAnalyser());

            gain.channelInterpretation = "speakers";
            leftGain.gain.value = 0.5;
            rightGain.gain.value = 0.5;
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.35;
            inputAnalyser.fftSize = 1024;
            inputAnalyser.smoothingTimeConstant = 0.35;

            const graph = {
                context, gain, inputAnalyser, splitter, leftGain, rightGain, merger, limiter, analyser,
                currentMode: null,
                normalizerGainDb: 0,
                meterPeakDb: -Infinity,
                meterBuffer: new Float32Array(analyser.fftSize),
                inputBuffer: new Float32Array(inputAnalyser.fftSize)
            };
            connectNative(inputAnalyser, gain);
            graphs.set(context, graph);
            addTrackedContext(context);
            wireGraph(graph);
            return graph;
        } catch (e) {
            log(`graph create failed: ${e && e.message}`);
            return null;
        }
    }

    function applyStateToGraphs() {
        eachTrackedContext((context) => {
            const graph = graphs.get(context);
            if (graph) wireGraph(graph);
        });
    }

    function getMediaContext() {
        if (mediaAudioContext && mediaAudioContext.state !== "closed") return mediaAudioContext;

        const AudioContextConstructor = getAudioContextConstructor();
        if (!AudioContextConstructor) return null;

        try {
            mediaAudioContext = new AudioContextConstructor();
            return mediaAudioContext;
        } catch (e) {
            log(`media context create failed: ${e && e.message}`);
            return null;
        }
    }

    function getMediaSourceUrl(element) {
        const directSrc = element.currentSrc || element.src;
        if (directSrc) return directSrc;

        try {
            const source = element.querySelector && element.querySelector("source[src]");
            return source ? source.src : "";
        } catch (e) {
            return "";
        }
    }

    function isLikelyCrossOriginMedia(element) {
        // Dangerous debug override: attempt WebAudio capture even when the
        // media URL is cross-origin. Browsers may output silence for tainted
        // media; this exists only for troubleshooting/compatibility testing.
        if (state.forceCorsCapture) return false;

        const src = getMediaSourceUrl(element);
        if (!src || element.crossOrigin) return false;

        try {
            const url = new URL(src, document.baseURI);
            if (url.protocol.indexOf("http") !== 0) return false;
            // In inherited-origin about:blank frames, location.origin
            // serializes as "null" while the document's effective origin is
            // the creator's. Prefer document.origin (the effective origin);
            // an actually-opaque origin (data:, sandboxed without
            // allow-same-origin) is "unknown" rather than cross-origin, so
            // same-origin media inside such frames is not falsely limited.
            const pageOrigin = (typeof globalThis.origin === "string" && globalThis.origin) || window.location.origin;
            if (!pageOrigin || pageOrigin === "null") return false;
            return url.origin !== pageOrigin;
        } catch (e) {
            return false;
        }
    }

    // Sticky per-element DRM flag. Written to a data-* attribute so the
    // ISOLATED-world content script (which shares DOM attributes but not JS
    // state) sees it too, for both its routing decisions and its boost-limit
    // verdict.
    function markElementRestricted(element) {
        try {
            if (element && element.dataset) element.dataset.vcRestrictedMedia = "true";
        } catch (e) {}
        // The aggregate page restriction may have just appeared (this element
        // is now DRM-restricted even if it is detached or in shadow DOM).
        updatePageMediaRestriction();
    }

    function pageUsesEme() {
        try {
            return document.documentElement.dataset.vcPageUsesEme === "true";
        } catch (e) {
            return false;
        }
    }

    // Engine-aware EME policy (v6.12). Chromium-family browsers (Chrome, Edge,
    // Brave, Opera, Vivaldi) silence MediaElementAudioSourceNode output for
    // encrypted/protected content: createMediaElementSource() detaches the
    // element's native output and feeds the graph zeros, permanently muting
    // the stream. Gecko (Firefox) is different — it explicitly SUPPORTS
    // capturing EME media audio through WebAudio (Mozilla bug 1331763, shipped
    // in Firefox 55: "creating a MediaElementSource on a media element should
    // always succeed (no matter it's restricted content or not)" — Mozilla
    // blocks only video capture via captureStream, never audio). Verified by
    // reverse-engineering a competitor booster that boosts Netflix/Widevine on
    // Firefox with a plain createMediaElementSource + GainNode chain.
    // So on Gecko, DRM signals do NOT block routing and do NOT clamp the boost
    // limit. Cross-origin taint, by contrast, silences routed audio in EVERY
    // engine (spec-mandated) and stays enforced everywhere.
    //
    // Detection: navigator.userAgentData exists only in Chromium-family
    // browsers; a UA containing "Firefox/" identifies Gecko. Anything else
    // (Safari/WebKit, unknown, privacy-hardened UA stripping) keeps the
    // conservative guard — the default is always "refuse to route DRM".
    function isGeckoRuntime() {
        try {
            const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
            // Firefox-first: a UA that says Firefox proves Gecko even if a
            // future Firefox release grows a userAgentData shim (which the
            // old check would have misread as proof of Chromium).
            if (ua.indexOf("Firefox/") !== -1) return true;
            if (typeof navigator !== "undefined" && navigator.userAgentData) return false;
            return false;
        } catch (e) {
            return false;
        }
    }
    const EME_AUDIO_SILENCED_WHEN_ROUTED = !isGeckoRuntime();

    // Per-element DRM evidence (sticky): `encrypted` fired, or MediaKeys were
    // attached. Shared with the ISOLATED world (dataset flags +
    // element.mediaKeys).
    function elementDrmEvidence(element) {
        if (!element) return false;
        try {
            if (element.dataset && element.dataset.vcRestrictedMedia === "true") return true;
            if (element.mediaKeys) return true;
            if (element.webkitKeys) return true;
        } catch (e) {
            return false;
        }
        return false;
    }

    // Gecko keys-attached marker: Gecko's setMediaKeys() throws
    // NotSupportedError when the element is already audio-captured
    // (MozAudioCaptured), so EME elements become routable only AFTER keys
    // attach. The setMediaKeys patch below writes vcEmeKeysAttached on
    // native success.
    function elementEmeKeysAttached(element) {
        if (!element) return false;
        try {
            if (element.mediaKeys) return true;
            if (element.dataset && element.dataset.vcEmeKeysAttached === "true") return true;
        } catch (e) {
            return false;
        }
        return false;
    }

    // Pending EME suspect: the page was granted EME access (probe) and the
    // element has a blob: (MSE) source without per-element DRM evidence.
    // Routing is refused while the element is under suspicion; if no
    // evidence lands, the element is clear media and may be routed (Plex
    // probes DRM at startup while playing clear direct-play content —
    // issue #70).
    //
    // v6.14: suspicion is no longer cleared by a blind 3-second timer (v6.13
    // — 3s of un-boosted playback on every probed-but-clear page). It is
    // cleared by DECRYPTION PROOF: the element's currentTime actually
    // advancing. EME content cannot decode a single frame without MediaKeys
    // attached to that element, and every key-attachment path is visible to
    // us (patched setMediaKeys/webkitSetMediaKeys — MAIN-world patches
    // installed at document_start, before any page script runs; the
    // element.mediaKeys / webkitKeys properties; the 'encrypted' init-data
    // event). Therefore:
    //   * progress + zero evidence  ⇒  clear media  ⇒  safe to route
    //   * no progress (currentTime frozen while "playing" — playback blocked
    //     waiting on a license) ⇒ keep refusing; the evidence race cannot
    //     be lost because encrypted content cannot produce progress.
    // Progress is observed at timeupdate cadence (spec: 15-250ms, ~4Hz in
    // Chromium) via the per-element timeupdate listener, plus the 1s sweep
    // as a backup, so clear MSE content routes within a couple hundred
    // milliseconds of actually playing. When the page constructs MediaKeys
    // (setMediaKeys imminent), earned proof is RESET (see the createMediaKeys
    // patch) — routing then waits for post-restart progress or the evidence
    // itself.
    const EME_PENDING_MIN_PROGRESS_S = 0.01; // epsilon: supports playbackRate >= 0.04

    function isPendingEmeSuspect(element) {
        // Probe-level gate (v6.9 semantics): a page that was GRANTED key
        // system access may attach keys to this blob: element at any moment.
        // Refuse routing until decryption proof or DRM evidence arrives
        // (Plex plays clear direct-play MSE on pages that probe DRM at
        // startup).
        if (!pageUsesEme()) return false;
        const src = getMediaSourceUrl(element);
        return Boolean(src) && src.indexOf("blob:") === 0;
    }

    function resetEmePending(element) {
        const entry = mediaState.get(element);
        if (!entry) return;
        entry.emePendingProgress = false;
        entry.emePendingLastTime = undefined;
    }

    function emePendingCleared(element) {
        // Decryption-proof gate. Observes currentTime on every evaluation
        // (each evaluation also refreshes the baseline, so scripted seeks —
        // a page setting currentTime — are recorded as baseline moves, not
        // progress; genuine decode progress is a positive delta while not
        // seeking).
        const entry = getMediaState(element);
        if (entry.emePendingProgress) return true;
        let now = 0;
        let seeking = false;
        try {
            now = Number(element.currentTime);
            if (typeof element.seeking === "boolean") seeking = element.seeking;
        } catch (e) {
            return false;
        }
        if (!Number.isFinite(now)) return false;
        const last = entry.emePendingLastTime;
        entry.emePendingLastTime = now;
        if (last !== undefined && !seeking && now > last + EME_PENDING_MIN_PROGRESS_S) {
            entry.emePendingProgress = true;
            log(`EME pending cleared by playback progress (clear media): ${getMediaSourceUrl(element)}`);
            return true;
        }
        return false;
    }

    // DRM pipelines always use MSE, and MSE playback surfaces as a blob: URL.
    // EME init data (encrypted event) and setMediaKeys can land AFTER playback
    // starts when license setup is slow, so while a page is known to use EME we
    // conservatively treat blob-sourced media as protected too. This closes the
    // window where an element gets routed through WebAudio a few ms before its
    // DRM flags appear — a one-way trip to permanent silence (on engines that
    // silence protected audio; see EME_AUDIO_SILENCED_WHEN_ROUTED).
    function isLikelyDrmMedia(element) {
        // Debug override: deliberately bypass every DRM/EME routing guard and
        // attempt MediaElementAudioSource capture even when it may break the
        // site's protected-media pipeline. Cross-origin checks remain separate.
        if (state.forceDrmCapture) return false;

        // ROUTING gate. Returns true when the element must NOT be captured
        // into WebAudio right now:
        //  * Chromium (EME_AUDIO_SILENCED_WHEN_ROUTED): any per-element DRM
        //    evidence, plus pending EME suspects (probe granted + blob: MSE
        //    source) until decryption proof or evidence arrives.
        //  * Gecko: EME audio IS routable (bug 1331763), but only once keys
        //    are attached — capturing first makes the site's setMediaKeys()
        //    throw NotSupportedError and breaks playback. Evidence without
        //    keys, and pending suspects without proof, still refuse routing.
        // Probe-only pages (Plex) never restrict the verdict: probing must
        // not produce a false "restricted" note or a permanent routing
        // refusal for clear MSE content (issue #70).
        if (!element) return false;
        if (EME_AUDIO_SILENCED_WHEN_ROUTED) {
            if (elementDrmEvidence(element)) return true;
            if (!isPendingEmeSuspect(element)) return false;
            return !emePendingCleared(element);
        }
        if (elementEmeKeysAttached(element)) return false;
        if (elementDrmEvidence(element)) return true;
        if (!isPendingEmeSuspect(element)) return false;
        return !emePendingCleared(element);
    }

    // Aggregate, DOM-visible summary of every tracked media element's boost
    // limitation (DRM-restricted or cross-origin). The ISOLATED-world content
    // script derives its popup verdict from document.querySelectorAll, which
    // can only see elements attached to this document's light DOM — it is
    // blind to the detached players many sites use (treblo.com and suno.com
    // create <audio> via createElement/new Audio and never append it) and to
    // elements hidden inside shadow DOM. This hook tracks ALL of those
    // (claimed at creation/first play/first volume write), so publishing the
    // aggregate on the documentElement lets the content script's boost-limit
    // verdict include them.
    let lastPublishedPageRestriction = null;
    let pendingRelaxation = null; // { restriction, since } — surviving the hysteresis window
    const RESTRICTION_RELAX_DELAY_MS = 500;

    function restrictionSeverity(value) {
        return value === "restricted" ? 2 : (value === "cross-origin" ? 1 : 0);
    }

    function publishPageMediaRestriction(restriction) {
        lastPublishedPageRestriction = restriction;
        try {
            const ds = document.documentElement.dataset;
            if (restriction) ds.vcPageMediaRestriction = restriction;
            else delete ds.vcPageMediaRestriction;
            log(`page media restriction: ${restriction || "none"}`);
        } catch (e) {
            log(`page media restriction publish failed: ${e && e.message}`);
        }
        // Tell the content script immediately: its boost-limit verdict caches
        // for a second, and without this nudge a freshly-restricted page (DRM
        // handshake completing, cross-origin src appearing) would keep serving
        // the stale unrestricted verdict until the cache expires.
        postToContentScript("pageRestrictionChanged", { restriction });
    }

    function updatePageMediaRestriction() {
        let restriction = "";
        for (const element of mediaElements) {
            // Mirror the content script's verdict gate: an element that is
            // neither playing nor holding a source cannot limit boost.
            if (!isMediaPlaying(element) && !getMediaSourceUrl(element)) continue;
            // VERDICT (the popup note + slider clamp) requires per-element
            // DRM evidence on engines that silence routed EME audio. The
            // pending window and page-level probes gate ROUTING only (see
            // isLikelyDrmMedia) — a probed-but-clear page (Plex) must not
            // show a restriction note (issue #70). On Gecko, DRM audio is
            // routable (bug 1331763), so the verdict never restricts.
            if (!state.forceDrmCapture && EME_AUDIO_SILENCED_WHEN_ROUTED && elementDrmEvidence(element)) {
                restriction = "restricted";
                break; // most severe; no need to keep scanning
            }
            if (!restriction && isLikelyCrossOriginMedia(element)) {
                restriction = "cross-origin";
            }
        }

        if (restriction === lastPublishedPageRestriction) {
            // Nothing new to say; a pending relaxation that matches the
            // published value is stale (transient during a src swap).
            pendingRelaxation = null;
            return;
        }

        if (lastPublishedPageRestriction === null) {
            // First computation on this page — publish immediately.
            pendingRelaxation = null;
            publishPageMediaRestriction(restriction);
            return;
        }

        if (restrictionSeverity(restriction) > restrictionSeverity(lastPublishedPageRestriction)) {
            // Tightening (a restriction appeared or got more severe): publish
            // at once — the popup must clamp its slider range BEFORE the user
            // can drag into a region that cannot actually be boosted.
            pendingRelaxation = null;
            publishPageMediaRestriction(restriction);
            return;
        }

        // Relaxation ("" while a new src loads after a track change, or
        // "cross-origin" after "restricted"): src swaps make the aggregate
        // transiently compute a LOWER value while the next source resolves.
        // Publishing that instantly would flash the boost-limit note off and
        // back on (the same visible symptom as the v6.8 cross-frame race).
        // Require the relaxed value to stay stable for the hysteresis window;
        // the 1s recompute interval will publish it on a later tick.
        if (!pendingRelaxation || pendingRelaxation.restriction !== restriction) {
            pendingRelaxation = { restriction, since: Date.now() };
        } else if (Date.now() - pendingRelaxation.since >= RESTRICTION_RELAX_DELAY_MS) {
            publishPageMediaRestriction(restriction);
            pendingRelaxation = null;
        }
    }

    function patchEmeApi() {
        // EME awareness. On engines that silence protected audio in WebAudio
        // (Chromium-family — see EME_AUDIO_SILENCED_WHEN_ROUTED),
        // createMediaElementSource() on a DRM element detaches the native
        // output and feeds the graph zeros, permanently muting the stream
        // (there is no way back). To prevent it, we watch the EME entry
        // points and flag protected elements/pages BEFORE any routing decision
        // is made:
        //   * setMediaKeys(keys) marks that element restricted (sticky).
        //   * requestMediaKeySystemAccess() resolving marks the page as EME-using
        //     (feeds isLikelyDrmMedia's conservative blob: heuristic).
        // On Gecko (Firefox) the flags are still recorded for reporting, but
        // they no longer gate routing or the verdict: Firefox routes EME audio
        // through WebAudio audibly (bug 1331763), so DRM media is boostable
        // there. The gates consult EME_AUDIO_SILENCED_WHEN_ROUTED.
        if (window.HTMLMediaElement && window.HTMLMediaElement.prototype &&
            !window.HTMLMediaElement.prototype.__volumeControlSetMediaKeysPatched) {
            const proto = window.HTMLMediaElement.prototype;
            try {
                if (typeof nativeSetMediaKeys === "function") {
                    proto.setMediaKeys = function patchedSetMediaKeys(mediaKeys) {
                        if (mediaKeys) {
                            if (EME_AUDIO_SILENCED_WHEN_ROUTED) {
                                markElementRestricted(this);
                                log("setMediaKeys: element marked DRM-restricted (WebAudio routing blocked)");
                            } else {
                                log("setMediaKeys: EME keys attaching (Gecko: routable once attached)");
                            }
                        }
                        const setResult = nativeSetMediaKeys.apply(this, arguments);
                        if (mediaKeys && !EME_AUDIO_SILENCED_WHEN_ROUTED) {
                            // Gecko: route only AFTER keys attach —
                            // setMediaKeys throws NotSupportedError on an
                            // already-audio-captured element. On success, mark
                            // the element routable and apply state promptly so
                            // the route forms without waiting for the next
                            // media event.
                            const el = this;
                            Promise.resolve(setResult).then(() => {
                                try {
                                    if (el.dataset) el.dataset.vcEmeKeysAttached = "true";
                                } catch (e) {}
                                updatePageMediaRestriction();
                                applyMediaElementState(el);
                            }, () => {});
                        }
                        return setResult;
                    };
                }
                if (typeof nativeWebkitSetMediaKeys === "function") {
                    proto.webkitSetMediaKeys = function patchedWebkitSetMediaKeys(mediaKeys) {
                        if (mediaKeys) markElementRestricted(this);
                        return nativeWebkitSetMediaKeys.apply(this, arguments);
                    };
                }
                Object.defineProperty(proto, "__volumeControlSetMediaKeysPatched", {
                    value: true,
                    configurable: true,
                    enumerable: false
                });
            } catch (e) {
                log(`setMediaKeys patch failed: ${e && e.message}`);
            }
        }

        if (window.Navigator && window.Navigator.prototype &&
            typeof window.Navigator.prototype.requestMediaKeySystemAccess === "function" &&
            !window.Navigator.prototype.__volumeControlRmksaPatched) {
            try {
                window.Navigator.prototype.requestMediaKeySystemAccess = function patchedRequestMediaKeySystemAccess() {
                    const result = nativeRequestMediaKeySystemAccess.apply(this, arguments);
                    // Only flag the page when a CDM is actually GRANTED. Players
                    // that merely probe support and fall back to clear media
                    // reject here and must not trip the conservative gate.
                    try {
                        Promise.resolve(result).then(() => {
                            try {
                                document.documentElement.dataset.vcPageUsesEme = "true";
                            } catch (e) {}
                            log("EME key system access granted — page flagged as using DRM");
                            // The EME+blob heuristic in isLikelyDrmMedia may
                            // now classify tracked elements as protected.
                            updatePageMediaRestriction();
                        }, () => {});
                    } catch (e) {}
                    return result;
                };
                Object.defineProperty(window.Navigator.prototype, "__volumeControlRmksaPatched", {
                    value: true,
                    configurable: true,
                    enumerable: false
                });
            } catch (e) {
                log(`requestMediaKeySystemAccess patch failed: ${e && e.message}`);
            }
        }

        // v6.13: two-level EME page detection. requestMediaKeySystemAccess
        // resolving (above) only proves the page PROBED DRM support —
        // app.plex.tv probes all three key systems at startup while playing
        // clear direct-play content. The blob:-heuristic pending gate
        // OPENS on that probe (requestMediaKeySystemAccess granted);
        // actually constructing MediaKeys is the strong signal that
        // setMediaKeys is imminent, so it RESETS any earned decryption
        // proof (v6.14; v6.13 restarted the grace clock): clear media
        // re-proves within one timeupdate (~250ms) if the element keeps
        // progressing, while a would-be-DRM element stalls until the
        // evidence lands.
        if (window.MediaKeySystemAccess && window.MediaKeySystemAccess.prototype &&
            typeof window.MediaKeySystemAccess.prototype.createMediaKeys === "function" &&
            !window.MediaKeySystemAccess.prototype.__volumeControlCmkPatched) {
            try {
                window.MediaKeySystemAccess.prototype.createMediaKeys = function patchedCreateMediaKeys() {
                    const result = nativeCreateMediaKeys.apply(this, arguments);
                    try {
                        document.documentElement.dataset.vcPageEmeActive = "true";
                        log("MediaKeys created — page flagged as EME-active");
                        // The page is about to attach keys: reset the earned
                        // progress proof for every tracked element so the
                        // pending gate re-verifies after this point (fresh
                        // timeupdate progress, or the imminent evidence).
                        // Also bump a document-level sequence counter so the
                        // ISOLATED-world content script invalidates its own
                        // mirror of the proof (dataset is shared DOM).
                        try {
                            const ds = document.documentElement.dataset;
                            ds.vcEmeResetSeq = String((Number(ds.vcEmeResetSeq) || 0) + 1);
                        } catch (e) {}
                        for (const element of Array.from(mediaElements)) {
                            resetEmePending(element);
                        }
                        updatePageMediaRestriction();
                        applyStateToMediaElements();
                    } catch (e) {}
                    return result;
                };
                Object.defineProperty(window.MediaKeySystemAccess.prototype, "__volumeControlCmkPatched", {
                    value: true,
                    configurable: true,
                    enumerable: false
                });
            } catch (e) {
                log(`createMediaKeys patch failed: ${e && e.message}`);
            }
        }
    }

    function createMediaRouteSource(context, element) {
        // DRM-protected media must NEVER be routed through WebAudio on engines
        // that silence protected audio (Chromium-family): the browser outputs
        // silence for protected content in the graph while the element's native
        // output stays detached — permanently muting the stream. On Gecko
        // (Firefox), EME audio flows through the graph (bug 1331763), so
        // isLikelyDrmMedia() returns false there and DRM media routes normally.
        // Cross-origin taint, in every engine, still falls back to native
        // volume scaling (spec-mandated silence when routed).
        if (isLikelyDrmMedia(element)) {
            log(`skipping MediaElementAudioSource for DRM-restricted media: ${getMediaSourceUrl(element)}`);
            return null;
        }

        // captureStream() adds a delayed parallel copy, so blocked media falls back to native volume.
        if (isLikelyCrossOriginMedia(element)) {
            log(`skipping MediaElementAudioSource for cross-origin media: ${getMediaSourceUrl(element)}`);
            return null;
        }

        try {
            return {
                source: markNode(context.createMediaElementSource(element)),
                kind: "mediaElement",
                muteNative: false,
                stream: null
            };
        } catch (e) {
            log(`createMediaElementSource failed: ${e && e.message}`);

            // WebRTC call audio is commonly exposed through media.srcObject.
            // Some engines/pages reject MediaElementAudioSourceNode for that
            // element. If this was NOT the "element already has a source node"
            // case, capture the MediaStream directly and silence the native
            // element while our graph is connected so the call is not doubled.
            const stream = getAudioMediaStream(element);
            const alreadyOwned = e && (e.name === "InvalidStateError" || /already.*MediaElement/i.test(String(e.message || "")));
            if (stream && !alreadyOwned && typeof context.createMediaStreamSource === "function") {
                try {
                    return {
                        source: markNode(context.createMediaStreamSource(stream)),
                        kind: "mediaStream",
                        muteNative: true,
                        stream
                    };
                } catch (streamError) {
                    log(`createMediaStreamSource failed: ${streamError && streamError.message}`);
                }
            }
        }

        return null;
    }

    function readMediaSrcObject(element) {
        try {
            if (nativeSrcObjectDescriptor && nativeSrcObjectDescriptor.get) {
                return nativeSrcObjectDescriptor.get.call(element);
            }
            return element && element.srcObject;
        } catch (e) {
            return null;
        }
    }

    function isMediaStreamLike(value) {
        return Boolean(value && typeof value.getTracks === "function" && typeof value.getAudioTracks === "function");
    }

    function getAudioMediaStream(element) {
        const stream = readMediaSrcObject(element);
        if (!isMediaStreamLike(stream)) return null;
        try {
            return stream.getAudioTracks().length ? stream : null;
        } catch (e) {
            return null;
        }
    }

    function readNativeVolume(element) {
        try {
            if (nativeVolumeDescriptor && nativeVolumeDescriptor.get) {
                return nativeVolumeDescriptor.get.call(element);
            }
        } catch (e) {
            log(`native volume read failed: ${e && e.message}`);
        }
        return 1;
    }

    function setNativeVolume(element, value) {
        const entry = getMediaState(element);
        entry.applyingVolume = true;
        entry.ignoreVolumeEventsUntil = Date.now() + 100;
        entry.lastNativeVolume = value; // remember what we wrote (see applyOnVolumeChange)
        try {
            if (nativeVolumeDescriptor && nativeVolumeDescriptor.set) {
                nativeVolumeDescriptor.set.call(element, value);
            }
        } catch (e) {
            log(`native volume set failed: ${e && e.message}`);
        } finally {
            entry.applyingVolume = false;
        }
    }

    function getMediaState(element) {
        let entry = mediaState.get(element);
        if (!entry) {
            entry = {
                baseVolume: readNativeVolume(element),
                applyingVolume: false,
                ignoreVolumeEventsUntil: 0,
                listenersInstalled: false,
                listenerCleanup: null,
                streamBacked: isMediaStreamLike(readMediaSrcObject(element)),
                streamCleanup: null
            };
            mediaState.set(element, entry);
        }
        return entry;
    }

    function mediaNeedsAudioRoute() {
        if (!state.extensionActive || !state.enabled) return false;
        if (state.debugRouteMode === "native") return false;
        if (state.debugRouteMode === "webaudio") return true;
        return state.muted || state.mono || state.normalizerEnabled || getGainValue(state.dB) > 1;
    }

    function pageAudioNeedsRoute() {
        return state.extensionActive && state.enabled && (state.muted || state.mono || state.normalizerEnabled || Number(state.dB) !== 0);
    }

    function routeRecordedDestinationConnections() {
        if (!pageAudioNeedsRoute()) return;

        for (const entry of Array.from(destinationConnections)) {
            if (entry.routed) continue;
            const source = nodeFromRef(entry.sourceRef);
            const dest = nodeFromRef(entry.destinationRef);
            if (!source || !dest) {
                destinationConnections.delete(entry);
                continue;
            }

            const entryContext = nodeFromRef(entry.contextRef);
            // Re-routing implies audio should flow; revive a context we
            // idled out or these sources would play into silence.
            resumeIfSelfSuspended(entryContext);

            const graph = ensureGraph(entryContext);
            if (!graph) continue;

            try {
                disconnectNative(source, dest, entry.outputIndex, entry.inputIndex);
            } catch (e) {
                log(`native destination disconnect failed: ${e && e.message}`);
                continue;
            }

            try {
                connectNative(source, graph.inputAnalyser, entry.outputIndex, 0);
                entry.routed = true;
            } catch (e) {
                log(`recorded destination route failed: ${e && e.message}`);
                try {
                    connectNative(source, dest, entry.outputIndex, entry.inputIndex);
                    entry.routed = false;
                } catch (rollbackError) {
                    log(`recorded destination rollback failed: ${rollbackError && rollbackError.message}`);
                }
            }
        }
    }

    function unrouteDestinationConnections() {
        // When volume is at 0 dB with mono off, restore original source→destination
        // connections and remove the extension's gain node from the audio path.
        // This lets page-level AudioContexts go fully idle (no running gain node)
        // and prevents the extension from holding Bluetooth devices active.
        if (pageAudioNeedsRoute()) return;

        for (const entry of Array.from(destinationConnections)) {
            if (!entry.routed) continue;
            const source = nodeFromRef(entry.sourceRef);
            const dest = nodeFromRef(entry.destinationRef);
            if (!source || !dest) {
                destinationConnections.delete(entry);
                continue;
            }

            const graph = graphs.get(nodeFromRef(entry.contextRef));
            if (!graph) continue;

            try {
                disconnectNative(source, graph.inputAnalyser, entry.outputIndex, 0);
            } catch (e) {
                log(`unroute disconnect failed: ${e && e.message}`);
                continue;
            }

            try {
                connectNative(source, dest, entry.outputIndex, entry.inputIndex);
                entry.routed = false;
            } catch (e) {
                log(`unroute reconnect failed: ${e && e.message}`);
                try {
                    connectNative(source, graph.inputAnalyser, entry.outputIndex, 0);
                    entry.routed = true;
                } catch (rollbackError) {
                    log(`unroute rollback failed: ${rollbackError && rollbackError.message}`);
                }
            }
        }
    }

    function routeHowlerGlobal() {
        if (!pageAudioNeedsRoute()) return;

        const howler = window.Howler;
        if (!howler || !howler.ctx || !howler.masterGain) return;

        const masterGain = howler.masterGain;
        if (howlerRoutes.has(masterGain)) return;

        // Howler is about to play through this context; if we idled it out
        // earlier, revive it so the site's sounds are not swallowed.
        resumeIfSelfSuspended(howler.ctx);

        const existingRoute = findDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined);
        if (existingRoute && existingRoute.routed) {
            howlerRoutes.set(masterGain, { context: howler.ctx, graph: graphs.get(howler.ctx) });
            return;
        }

        const graph = ensureGraph(howler.ctx);
        if (!graph) return;

        try {
            disconnectNative(masterGain, howler.ctx.destination);
        } catch (e) {
            log(`Howler master disconnect failed: ${e && e.message}`);
            return;
        }

        try {
            connectNative(masterGain, graph.inputAnalyser);
            howlerRoutes.set(masterGain, { context: howler.ctx, graph });
            trackDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined, true);
            log("Howler master gain routed");
        } catch (e) {
            log(`Howler master route failed: ${e && e.message}`);
            try {
                connectNative(masterGain, howler.ctx.destination);
            } catch (rollbackError) {
                log(`Howler master rollback failed: ${rollbackError && rollbackError.message}`);
            }
        }
    }

    function unrouteHowlerGlobal() {
        if (pageAudioNeedsRoute()) return;

        const howler = window.Howler;
        if (!howler || !howler.ctx || !howler.masterGain) return;

        const masterGain = howler.masterGain;
        const route = howlerRoutes.get(masterGain);
        if (!route) return;

        const graph = route.graph;
        if (graph) {
            try {
                disconnectNative(masterGain, graph.inputAnalyser);
            } catch (e) {
                log(`Howler unroute disconnect failed: ${e && e.message}`);
            }
        }

        try {
            connectNative(masterGain, howler.ctx.destination);
            howlerRoutes.delete(masterGain);
            const entry = findDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined);
            if (entry) destinationConnections.delete(entry);
            log("Howler master gain unrouted (restored native path)");
        } catch (e) {
            log(`Howler unroute reconnect failed: ${e && e.message}`);
        }
    }

    function routeKnownAudioLibraries() {
        // Route or unroute depending on current state. When volume returns to
        // 0 dB with mono off, unroute so the page's audio path is native again.
        if (pageAudioNeedsRoute()) {
            routeHowlerGlobal();
        } else {
            unrouteHowlerGlobal();
        }
    }

    function wireMediaRoute(route) {
        // A ceiling change is independent of routing/mono/boost mode.
        configureLimiter(route);
        const autoGain = state.normalizerEnabled ? dbToGain(route.normalizerGainDb || 0) : 1;
        const targetGain = effectiveGain() * autoGain;

        try {
            const now = route.context.currentTime;
            if (route.context.state === "running") {
                // Smooth ramp to avoid audible clicks/spikes.
                route.gain.gain.cancelScheduledValues(now);
                route.gain.gain.setValueAtTime(route.gain.gain.value, now);
                route.gain.gain.linearRampToValueAtTime(targetGain, now + 0.015);
            } else {
                route.gain.gain.value = targetGain;
            }
        } catch (e) {
            log(`media gain update failed: ${e && e.message}`);
        }

        // Skip the disconnect/reconnect cycle if the routing mode hasn't changed
        // AND the output is still connected. On resume from pause, the output
        // was disconnected by disconnectMediaRouteOutput but currentMode was
        // not cleared, so we must fall through and reconnect.
        const wantMode = currentRoutingMode();
        if (route.currentMode === wantMode && route.outputConnected) return;
        route.currentMode = wantMode;

        disconnectMediaRouteOutput(route);

        try {
            const useLimiter = safetyLimiterRequired();
            const output = useLimiter ? route.limiter : route.context.destination;
            if (state.extensionActive && state.enabled && state.mono) {
                connectMonoChain(route.gain, route.splitter, route.leftGain, route.rightGain, route.merger, output);
            } else {
                connectNative(route.gain, output);
            }
            if (useLimiter) {
                configureLimiter(route);
                connectNative(route.limiter, route.analyser);
                connectNative(route.analyser, route.context.destination);
            }
            route.outputConnected = true;
        } catch (e) {
            log(`media graph wire failed: ${e && e.message}`);
        }
    }

    function ensureMediaRoute(element) {
        if (!mediaNeedsAudioRoute() || !isAudibleMediaElement(element)) return null;
        // DRM-restricted media is never routed (see createMediaRouteSource).
        if (isLikelyDrmMedia(element)) return null;
        if (mediaRoutes.has(element)) {
            const existing = mediaRoutes.get(element);
            // Defensive: if the route's context was closed out from under us
            // (e.g. the page itself called .close() on it, or the tab was
            // suspended by the OS and the context did not survive), we cannot
            // recover via a new context -- createMediaElementSource() throws
            // InvalidStateError when called twice on the same element. Log
            // loudly so this is diagnosable; audio for this element will not
            // play again until the page is reloaded.
            if (existing && existing.context && existing.context.state === "closed") {
                log(`media route context is closed -- element audio is dead until page reload: ${getMediaSourceUrl(element) || element.tagName}`);
            }
            return existing;
        }

        const context = getMediaContext();
        if (!context) return null;

        try {
            const routeSource = createMediaRouteSource(context, element);
            if (!routeSource) return null;

            const source = routeSource.source;
            const gain = markNode(context.createGain());
            // Measure source RMS before the slider and automatic gain.
            const inputAnalyser = markNode(context.createAnalyser());
            const splitter = markNode(context.createChannelSplitter(2));
            const leftGain = markNode(context.createGain());
            const rightGain = markNode(context.createGain());
            const merger = markNode(context.createChannelMerger(2));
            const limiter = markNode(context.createDynamicsCompressor());
            const analyser = markNode(context.createAnalyser());

            gain.channelInterpretation = "speakers";
            leftGain.gain.value = 0.5;
            rightGain.gain.value = 0.5;
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.35;
            inputAnalyser.fftSize = 1024;
            inputAnalyser.smoothingTimeConstant = 0.35;
            // Set the gain value BEFORE connecting the source so there is no
            // brief moment of full-volume (gain=1.0) audio at route creation.
            gain.gain.value = effectiveGain();
            connectNative(source, inputAnalyser);
            connectNative(inputAnalyser, gain);

            const route = {
                context,
                source,
                gain,
                inputAnalyser,
                splitter,
                leftGain,
                rightGain,
                merger,
                limiter,
                analyser,
                normalizerGainDb: 0,
                meterPeakDb: -Infinity,
                meterBuffer: new Float32Array(analyser.fftSize),
                inputBuffer: new Float32Array(inputAnalyser.fftSize),
                sourceKind: routeSource.kind,
                muteNative: Boolean(routeSource.muteNative),
                stream: routeSource.stream || null,
                outputConnected: false,
                currentMode: null
            };
            mediaRoutes.set(element, route);
            // The caller restores base/native volume before exposing the route,
            // avoiding fallback-volume × GainNode transition artifacts.
            log(`media route attached (${route.sourceKind}): ${element.currentSrc || element.src || element.tagName}`);
            return route;
        } catch (e) {
            log(`media route failed: ${e && e.message}`);
            return null;
        }
    }

    // Rate-limited fallback write shared by the paused and playing paths.
    // 250ms spacing bounds the write war against site volume managers, but a
    // SKIPPED correction is never dropped: sites reset element.volume on
    // track changes / replays, and if no further media event fires (event
    // starvation — YouTube auto-next in shuffled playlists, Facebook reels
    // replays) the reset volume would stick for seconds or until the user
    // manually moves the slider (issue #71). Schedule the corrective write
    // for the first allowed moment instead.
    function writeFallbackVolume(element, entry, wantedVolume, immediate = false) {
        const now = Date.now();
        if (immediate || entry.lastFallbackWriteAt === undefined || now - entry.lastFallbackWriteAt >= 250) {
            entry.lastFallbackWriteAt = now;
            entry.pendingFallbackVolume = null;
            setNativeVolume(element, wantedVolume);
            return;
        }
        entry.pendingFallbackVolume = wantedVolume;
        if (!entry.fallbackCorrectionTimer) {
            const wait = Math.max(0, 250 - (now - entry.lastFallbackWriteAt)) + 1;
            entry.fallbackCorrectionTimer = setTimeout(() => {
                entry.fallbackCorrectionTimer = null;
                // Re-run the full apply so the CURRENT state + baseVolume win.
                try { applyMediaElementState(element); } catch (e) {}
            }, wait);
        }
    }

    function applyMediaElementState(element, options = {}) {
        if (!isMediaElement(element)) return;

        const entry = getMediaState(element);
        const gain = effectiveGain();
        const existingRoute = mediaRoutes.get(element);
        const playing = isMediaPlaying(element);
        const audible = isAudibleMediaElement(element);

        if (!playing || !audible) {
            // Keep an existing WebAudio route associated with a reused element.
            // The context can still suspend while idle, but source transitions
            // no longer restore an unscaled native volume between playlist items.
            if (existingRoute) {
                setNativeVolume(element, existingRoute.muteNative ? 0 : entry.baseVolume);
                wireMediaRoute(existingRoute);
                return;
            }

            // WebRTC/MediaStream-backed elements are captured eagerly. Remote
            // call audio can begin without a normal URL-backed play() path, so
            // waiting for a later media event misses the call entirely on some
            // sites (Snapchat Web is one example).
            const eagerRequested = state.debugRouteMode === "webaudio" || options.eagerRoute || entry.streamBacked;
            if (eagerRequested && audible && mediaNeedsAudioRoute()) {
                const eagerRoute = ensureMediaRoute(element);
                if (eagerRoute) {
                    setNativeVolume(element, eagerRoute.muteNative ? 0 : entry.baseVolume);
                    wireMediaRoute(eagerRoute);
                    return;
                }
            }

            const nativeVolume = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
            writeFallbackVolume(element, entry, nativeVolume, Boolean(options.immediateFallback));
            return;
        }

        // ensureMediaRoute internally checks mediaNeedsAudioRoute(), so we
        // just call it when a route might be needed. The old `forceRoute`
        // parameter was a no-op (ensureMediaRoute ignored it) and has been
        // removed to avoid confusion.
        const route = existingRoute || (mediaNeedsAudioRoute()
            ? ensureMediaRoute(element)
            : null);

        if (route) {
            if (entry.fallbackCorrectionTimer) {
                clearTimeout(entry.fallbackCorrectionTimer);
                entry.fallbackCorrectionTimer = null;
            }
            entry.pendingFallbackVolume = null;
            // Restore native volume BEFORE wiring the route so the WebAudio gain
            // is the only scaling applied. If we wire first, there is a brief
            // moment where effective volume = fallbackScaledVolume × gain, which
            // causes an audible dip-then-snap spike.
            setNativeVolume(element, route.muteNative ? 0 : entry.baseVolume);
            wireMediaRoute(route);
            // After wireMediaRoute, output should be reconnected. If the context
            // was suspended (e.g. after pause), resume it so audio flows again.
            if (route.outputConnected) resumeContext(route.context);
            else setTimeout(suspendMediaContextIfIdle, 250);
            return;
        }

        const fallbackVolume = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
        // Rate-limit our own fallback writes: some sites run volume managers
        // that write their own value back on every volumechange (normalizers,
        // "smart volume" features). Without a floor between our writes that
        // escalates into a write war at event-loop speed (audible flutter +
        // CPU churn). 250ms bounds the war while staying imperceptible. A
        // skipped write schedules a deferred correction instead of dropping
        // (issue #71 — see writeFallbackVolume).
        writeFallbackVolume(element, entry, fallbackVolume, Boolean(options.immediateFallback));
    }

    function detachMediaElementListeners(element) {
        const entry = mediaState.get(element);
        if (!entry) return;
        if (entry.listenerCleanup) {
            try { entry.listenerCleanup(); } catch (e) {}
            entry.listenerCleanup = null;
        }
        entry.listenersInstalled = false;
        if (entry.streamCleanup) {
            try { entry.streamCleanup(); } catch (e) {}
            entry.streamCleanup = null;
        }
        entry.streamBacked = false;
    }

    function cleanupTrackedMediaElement(element) {
        const entry = mediaState.get(element);
        if (entry) {
            detachMediaElementListeners(element);
            if (entry.fallbackCorrectionTimer) {
                clearTimeout(entry.fallbackCorrectionTimer);
                entry.fallbackCorrectionTimer = null;
            }
            entry.pendingFallbackVolume = null;
        }
        const route = mediaRoutes.get(element);
        if (route) disconnectMediaRouteOutput(route);
        mediaElements.delete(element);
    }

    // Returns true if an element that was removed from the DOM can still be
    // heard. Sites like YouTube/Twitch/Twitter detach their <video> element
    // during player rebuilds and ad transitions WHILE IT KEEPS PLAYING, and
    // a detached media element keeps producing audio without being in the
    // DOM. If we stopped tracking such an element, its route gain would
    // freeze at whatever boost was active when it was detached — a stale
    // +32 dB "earrape" boost that ignores every later volume change.
    function isDetachedButAudible(element) {
        if (element.isConnected) return false;
        if (!isMediaPlaying(element)) return false;
        const route = mediaRoutes.get(element);
        if (route && route.outputConnected) return true;   // routed and live
        return isAudibleMediaElement(element);             // native output audible
    }

    function applyStateToMediaElements() {
        for (const element of Array.from(mediaElements)) {
            if (!element.isConnected) {
                // Detached element: keep updating it for as long as it can
                // still be heard. Only drop it once it is truly quiescent.
                if (isDetachedButAudible(element)) {
                    applyMediaElementState(element);
                    continue;
                }
                cleanupTrackedMediaElement(element);
                continue;
            }
            applyMediaElementState(element);
        }
        updatePageMediaRestriction();
    }

    function registerMediaElement(element, options = {}) {
        if (!isMediaElement(element)) return element;

        try {
            if (element.dataset) element.dataset[MEDIA_MANAGED_ATTR] = "true";
        } catch (e) {
            log(`media marker failed: ${e && e.message}`);
        }

        mediaElements.add(element);
        updatePageMediaRestriction();
        const entry = getMediaState(element);
        if (!entry.listenersInstalled && typeof element.addEventListener === "function") {
            const listenerCleanup = [];
            const listen = (type, handler, options) => {
                element.addEventListener(type, handler, options);
                listenerCleanup.push(() => element.removeEventListener(type, handler, options));
            };

            // DRM detection: the moment the pipeline reports encrypted init
            // data, flag the element (sticky) so neither this hook nor the
            // content script ever routes it through WebAudio.
            listen("encrypted", () => {
                markElementRestricted(element);
                log("encrypted event: element marked DRM-restricted (WebAudio routing blocked)");
            }, { passive: true });
            // v6.14: re-run the routing decision at timeupdate cadence
            // (~4Hz in real browsers). The EME pending gate clears on
            // playback progress (decryption proof) — this is what turns a
            // pending suspect into routable clear media within a couple
            // hundred milliseconds instead of a blind multi-second grace
            // timer (v6.13's 3s, the source of the "boost takes 3 seconds
            // to kick in on Plex" report). Cheap guards keep this a no-op
            // for routed/restricted/non-suspect elements.
            listen("timeupdate", () => {
                if (mediaRoutes.has(element)) return;      // already routed
                if (!isPendingEmeSuspect(element)) return; // cheap probe+src gate
                if (!state.forceDrmCapture && elementDrmEvidence(element)) return;
                applyMediaElementState(element);
            }, { passive: true });
            // Keep the aggregate page restriction fresh as this element's
            // lifecycle (src assignment, play, pause, ended) progresses.
            listen("loadedmetadata", updatePageMediaRestriction, { passive: true });
            listen("play", updatePageMediaRestriction, { passive: true });
            listen("emptied", updatePageMediaRestriction, { passive: true });
            const applyOnPlay = () => {
                mediaElements.add(element);
                applyMediaElementState(element, { immediateFallback: true, eagerRoute: true });
            };
            const suspendWhenIdle = () => {
                // Preserve the graph across pauses/source changes. The idle sweep
                // may suspend the context later, but does not restore full native
                // volume during a playlist transition.
                setTimeout(suspendMediaContextIfIdle, 250);
            };
            const applyOnVolumeChange = () => {
                const currentEntry = getMediaState(element);
                if (currentEntry.ignoreVolumeEventsUntil > Date.now()) {
                    if (currentEntry.lastNativeVolume === undefined ||
                        currentEntry.lastNativeVolume === readNativeVolume(element)) {
                        return;
                    }
                }

                applyMediaElementState(element, { immediateFallback: true, eagerRoute: true });
                setTimeout(suspendMediaContextIfIdle, 250);
            };
            const sourceBoundary = () => {
                // Source/replay changes re-earn EME proof but keep the same
                // extension route and gain attached to the reused media element.
                resetEmePending(element);
                const route = mediaRoutes.get(element);
                if (route) {
                    // A reused HTMLMediaElement keeps its WebAudio route across
                    // playlist transitions. Do not carry automatic boost from
                    // a quiet track into the next (potentially loud) track.
                    route.normalizerGainDb = 0;
                    route.meterPeakDb = -Infinity;
                    setNativeVolume(element, route.muteNative ? 0 : getMediaState(element).baseVolume);
                    wireMediaRoute(route);
                } else {
                    applyMediaElementState(element, { immediateFallback: true, eagerRoute: true });
                }
                setTimeout(suspendMediaContextIfIdle, 250);
            };

            listen("play", applyOnPlay, { passive: true });
            listen("playing", applyOnPlay, { passive: true });
            listen("volumechange", applyOnVolumeChange, { passive: true });
            listen("pause", suspendWhenIdle, { passive: true });
            listen("ended", sourceBoundary, { passive: true });
            listen("emptied", sourceBoundary, { passive: true });
            listen("error", sourceBoundary, { passive: true });
            entry.listenerCleanup = () => {
                for (const cleanup of listenerCleanup.splice(0)) {
                    try { cleanup(); } catch (e) {}
                }
            };
            entry.listenersInstalled = true;
        }
        applyMediaElementState(element, options);
        return element;
    }

    function scanMediaElements(root) {
        try {
            const scope = root && root.querySelectorAll ? root : document;
            for (const element of scope.querySelectorAll("audio, video")) {
                registerMediaElement(element);
            }
        } catch (e) {
            log(`media scan failed: ${e && e.message}`);
        }
    }

    // Elements inserted after DOMContentLoaded via innerHTML/insertAdjacentHTML
    // (template rendering, jQuery .html()) never pass through the patched
    // createElement; driven only through native controls, neither the patched
    // play() nor the volume setter ever runs for them — invisible to boost AND
    // to the restriction aggregate. Register any audio/video the moment it
    // enters the (light) DOM so our per-element listeners take over from there.
    function watchForInjectedMediaElements() {
        if (typeof MutationObserver === "undefined") return null;
        const registerNode = (node) => {
            if (!node || node.nodeType !== 1) return;
            const tag = node.tagName;
            if (tag === "AUDIO" || tag === "VIDEO") {
                registerMediaElement(node);
                return;
            }
            if (!node.querySelectorAll) return;
            try {
                const found = node.querySelectorAll("audio, video");
                for (const element of found) registerMediaElement(element);
            } catch (e) {}
        };
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                const added = mutation.addedNodes;
                if (!added || !added.length) continue;
                for (let i = 0; i < added.length; i++) {
                    registerNode(added[i]);
                }
            }
        });
        const startObserving = () => {
            try {
                observer.observe(document.documentElement || document, { childList: true, subtree: true });
            } catch (e) {}
        };
        if (document.documentElement) startObserving();
        else document.addEventListener("DOMContentLoaded", startObserving, { once: true });
        return observer;
    }

    function patchAudioNodeRouting() {
        if (!AudioNodePrototype || !nativeConnect || AudioNodePrototype.__volumeControlPatched) return;

        AudioNodePrototype.connect = function patchedConnect(destination, outputIndex, inputIndex) {
            if (isContextDestination(destination) && !vcNodes.has(this)) {
                const context = this.context || destination.context;
                // The page is (re)connecting something to the destination — it
                // wants audio NOW. If we idled this context out (Bluetooth
                // sweep), revive it before routing, otherwise the new sound
                // would play into a suspended context (silent SFX bug).
                resumeIfSelfSuspended(context);
                const graph = (graphs.has(context) || pageAudioNeedsRoute()) ? ensureGraph(context) : null;
                if (graph) {
                    const entry = trackDestinationConnection(this, destination, outputIndex, inputIndex, true);
                    try {
                        connectNative(this, graph.inputAnalyser, outputIndex, 0);
                        return destination;
                    } catch (e) {
                        entry.routed = false;
                        log(`live destination route failed, using native path: ${e && e.message}`);
                        return nativeConnect.apply(this, arguments);
                    }
                }

                trackDestinationConnection(this, destination, outputIndex, inputIndex, false);
            }

            return nativeConnect.apply(this, arguments);
        };

        if (nativeDisconnect) {
            AudioNodePrototype.disconnect = function patchedDisconnect(destination) {
                if (vcNodes.has(this)) return nativeDisconnect.apply(this, arguments);

                if (arguments.length === 0) {
                    removeDestinationConnectionsForSource(this);
                    return nativeDisconnect.apply(this, arguments);
                }

                // Standard overload: disconnect(outputIndex)
                if (typeof destination === "number") {
                    const outputIndex = destination;
                    takeDestinationConnections(this, entry => entry.outputIndex === outputIndex);
                    return nativeDisconnect.apply(this, arguments);
                }

                if (isContextDestination(destination)) {
                    const outputIndex = arguments[1];
                    const inputIndex = arguments[2];
                    const matches = takeDestinationConnections(this, entry => {
                        if (nodeFromRef(entry.destinationRef) !== destination) return false;
                        if (arguments.length >= 2 && entry.outputIndex !== outputIndex) return false;
                        if (arguments.length >= 3 && entry.inputIndex !== inputIndex) return false;
                        return true;
                    });

                    if (matches.length) {
                        let hadNative = false;
                        for (const entry of matches) {
                            if (entry.routed) disconnectTrackedRouteEntry(this, entry);
                            else hadNative = true;
                        }
                        // Routed connections no longer point at the page's
                        // destination, so calling native disconnect(destination)
                        // for an all-routed set can throw InvalidAccessError.
                        if (!hadNative) return undefined;
                    }
                }

                return nativeDisconnect.apply(this, arguments);
            };
        }

        Object.defineProperty(AudioNodePrototype, "__volumeControlPatched", {
            value: true,
            configurable: true,
            enumerable: false
        });
    }

    function nativeVolumeForBase(element, baseVolume) {
        const base = Math.max(0, Math.min(1, Number(baseVolume) || 0));
        if (!state.extensionActive || !state.enabled) return base;
        if (mediaRoutes.has(element)) return base;

        // Native fallback applies only attenuation/mute. The page still reads
        // baseVolume from our patched getter, so its own volume is independent
        // from Volume Control's dB adjustment.
        const gain = effectiveGain();
        return Math.max(0, Math.min(1, base * Math.min(gain, 1)));
    }

    function patchMediaVolume() {
        if (!nativeVolumeDescriptor || !nativeVolumeDescriptor.get || !nativeVolumeDescriptor.set) return;
        if (window.HTMLMediaElement.prototype.__volumeControlVolumePatched) return;

        try {
            Object.defineProperty(window.HTMLMediaElement.prototype, "volume", {
                configurable: true,
                enumerable: nativeVolumeDescriptor.enumerable,
                get: function patchedVolumeGetter() {
                    const entry = mediaState.get(this);
                    return entry ? entry.baseVolume : nativeVolumeDescriptor.get.call(this);
                },
                set: function patchedVolumeSetter(value) {
                    const n = Number(value);

                    // Preserve native HTMLMediaElement semantics. Browsers throw
                    // for NaN/Infinity and values outside 0..1; silently
                    // clamping here broke sites that intentionally rely on that
                    // exception behavior.
                    if (!Number.isFinite(n) || n < 0 || n > 1) {
                        nativeVolumeDescriptor.set.call(this, value);
                        return;
                    }

                    const entry = getMediaState(this);
                    if (entry.applyingVolume) {
                        nativeVolumeDescriptor.set.call(this, n);
                        return;
                    }

                    entry.baseVolume = n;

                    // Apply the extension-adjusted native target immediately.
                    // The site's requested value remains entry.baseVolume, so a
                    // playlist item setting video.volume = 1 cannot briefly
                    // bypass negative dB attenuation.
                    const nativeTarget = nativeVolumeForBase(this, entry.baseVolume);
                    setNativeVolume(this, nativeTarget);

                    registerMediaElement(this);
                }
            });

            Object.defineProperty(window.HTMLMediaElement.prototype, "__volumeControlVolumePatched", {
                value: true,
                configurable: true,
                enumerable: false
            });
        } catch (e) {
            log(`media volume patch failed: ${e && e.message}`);
        }
    }

    function resetDirectMediaStreamRoute(element) {
        const route = mediaRoutes.get(element);
        if (!route || route.sourceKind !== "mediaStream") return;
        disconnectMediaRouteOutput(route);
        safeDisconnect(route.source);
        mediaRoutes.delete(element);
    }

    function bindMediaStreamLifecycle(element, stream) {
        const entry = getMediaState(element);
        if (entry.streamCleanup) {
            try { entry.streamCleanup(); } catch (e) {}
            entry.streamCleanup = null;
        }

        entry.streamBacked = isMediaStreamLike(stream);
        if (!entry.streamBacked || typeof stream.addEventListener !== "function") return;

        const refresh = () => {
            resetDirectMediaStreamRoute(element);
            entry.streamBacked = isMediaStreamLike(readMediaSrcObject(element));
            registerMediaElement(element, { immediateFallback: true, eagerRoute: true });
        };
        stream.addEventListener("addtrack", refresh);
        stream.addEventListener("removetrack", refresh);
        entry.streamCleanup = () => {
            stream.removeEventListener("addtrack", refresh);
            stream.removeEventListener("removetrack", refresh);
        };
    }

    function patchMediaSrcObject() {
        if (!nativeSrcObjectDescriptor || !nativeSrcObjectDescriptor.get || !nativeSrcObjectDescriptor.set) return;
        if (window.HTMLMediaElement.prototype.__volumeControlSrcObjectPatched) return;

        try {
            Object.defineProperty(window.HTMLMediaElement.prototype, "srcObject", {
                configurable: true,
                enumerable: nativeSrcObjectDescriptor.enumerable,
                get: function patchedSrcObjectGetter() {
                    return nativeSrcObjectDescriptor.get.call(this);
                },
                set: function patchedSrcObjectSetter(value) {
                    // A direct MediaStream route is tied to the old stream, so
                    // tear only that route down before replacing srcObject.
                    resetDirectMediaStreamRoute(this);
                    nativeSrcObjectDescriptor.set.call(this, value);
                    bindMediaStreamLifecycle(this, value);
                    registerMediaElement(this, { immediateFallback: true, eagerRoute: true });
                    log(`srcObject assigned (${isMediaStreamLike(value) ? "MediaStream" : typeof value})`);
                }
            });

            Object.defineProperty(window.HTMLMediaElement.prototype, "__volumeControlSrcObjectPatched", {
                value: true,
                configurable: true,
                enumerable: false
            });
        } catch (e) {
            log(`srcObject patch failed: ${e && e.message}`);
        }
    }

    function patchMediaPlayback() {
        if (!window.HTMLMediaElement || !nativePlay) return;
        if (window.HTMLMediaElement.prototype.__volumeControlPlayPatched) return;

        window.HTMLMediaElement.prototype.play = function patchedPlay() {
            registerMediaElement(this);
            const route = mediaRoutes.get(this);
            if (route) {
                wireMediaRoute(route);
                resumeContext(route.context);
            }
            return nativePlay.apply(this, arguments);
        };

        Object.defineProperty(window.HTMLMediaElement.prototype, "__volumeControlPlayPatched", {
            value: true,
            configurable: true,
            enumerable: false
        });
    }

    function patchAudioConstructor() {
        if (!nativeAudioConstructor || nativeAudioConstructor.__volumeControlPatched) return;
        // If the page installed its own Audio constructor wrapper while we were
        // disabled, do not overwrite it on re-enable.
        if (window.Audio !== nativeAudioConstructor && !(window.Audio && window.Audio.__volumeControlPatched)) return;

        try {
            function VolumeControlAudio(src) {
                const element = arguments.length > 0
                    ? new nativeAudioConstructor(src)
                    : new nativeAudioConstructor();
                return registerMediaElement(element);
            }

            Object.setPrototypeOf(VolumeControlAudio, nativeAudioConstructor);
            VolumeControlAudio.prototype = nativeAudioConstructor.prototype;

            Object.defineProperty(VolumeControlAudio, "__volumeControlPatched", {
                value: true,
                configurable: true,
                enumerable: false
            });

            window.Audio = VolumeControlAudio;
        } catch (e) {
            log(`Audio constructor patch failed: ${e && e.message}`);
        }
    }

    function patchElementCreation() {
        if (!window.Document || window.Document.prototype.__volumeControlCreateElementPatched) return;

        try {
            window.Document.prototype.createElement = function patchedCreateElement() {
                const element = nativeCreateElement.apply(this, arguments);
                return registerMediaElement(element);
            };

            if (nativeCreateElementNS) {
                window.Document.prototype.createElementNS = function patchedCreateElementNS() {
                    const element = nativeCreateElementNS.apply(this, arguments);
                    return registerMediaElement(element);
                };
            }

            Object.defineProperty(window.Document.prototype, "__volumeControlCreateElementPatched", {
                value: true,
                configurable: true,
                enumerable: false
            });
        } catch (e) {
            log(`createElement patch failed: ${e && e.message}`);
        }
    }

    // Post a message from the page hook back to the content script (reverse
    // direction of the normal bridge flow).
    function postToContentScript(command, extra = {}) {
        try {
            if (!bridgeToken) return;
            window.postMessage({
                source: BRIDGE_TARGET,
                target: BRIDGE_SOURCE,
                token: bridgeToken,
                command,
                ...extra
            }, "*");
        } catch (e) {
            log(`postToContentScript (${command}) failed: ${e && e.message}`);
        }
    }

    function patchSpaNavigation() {
        if (!window.history || window.history.__volumeControlNavigationPatched) return;

        const notify = () => {
            Promise.resolve().then(() => {
                postToContentScript("locationChanged", { href: window.location.href });
            });
        };
        spaNavigationNotify = notify;

        for (const method of ["pushState", "replaceState"]) {
            const original = method === "pushState" ? nativeHistoryPushState : nativeHistoryReplaceState;
            if (typeof original !== "function") continue;
            window.history[method] = function patchedHistoryMethod() {
                const result = original.apply(this, arguments);
                notify();
                return result;
            };
        }

        window.addEventListener("popstate", notify, { passive: true });
        window.addEventListener("hashchange", notify, { passive: true });

        try {
            Object.defineProperty(window.history, "__volumeControlNavigationPatched", {
                value: true,
                configurable: true,
                enumerable: false
            });
        } catch (e) {}
    }

    function deletePatchMarker(target, key) {
        if (!target) return;
        try { delete target[key]; } catch (e) {}
    }

    function restorePatchedPageApis() {
        stopMaintenanceTimers();

        // Only restore a method when OUR wrapper is still installed. If the page
        // replaced it after us, leave the page's newer implementation alone.
        if (AudioNodePrototype) {
            const ownsConnect = Boolean(AudioNodePrototype.connect && AudioNodePrototype.connect.name === "patchedConnect");
            const ownsDisconnect = Boolean(!nativeDisconnect || (AudioNodePrototype.disconnect && AudioNodePrototype.disconnect.name === "patchedDisconnect"));
            if (ownsConnect && nativeConnect) AudioNodePrototype.connect = nativeConnect;
            if (ownsDisconnect && nativeDisconnect) AudioNodePrototype.disconnect = nativeDisconnect;
            if (ownsConnect && ownsDisconnect) deletePatchMarker(AudioNodePrototype, "__volumeControlPatched");
        }

        if (window.HTMLMediaElement && window.HTMLMediaElement.prototype) {
            const proto = window.HTMLMediaElement.prototype;
            const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, "volume");
            const ownsVolume = Boolean(volumeDescriptor && volumeDescriptor.set && volumeDescriptor.set.name === "patchedVolumeSetter");
            if (ownsVolume && nativeVolumeDescriptor) Object.defineProperty(proto, "volume", nativeVolumeDescriptor);
            const srcObjectDescriptor = Object.getOwnPropertyDescriptor(proto, "srcObject");
            const ownsSrcObject = Boolean(srcObjectDescriptor && srcObjectDescriptor.set && srcObjectDescriptor.set.name === "patchedSrcObjectSetter");
            if (ownsSrcObject && nativeSrcObjectDescriptor) Object.defineProperty(proto, "srcObject", nativeSrcObjectDescriptor);
            const ownsPlay = Boolean(proto.play && proto.play.name === "patchedPlay");
            if (ownsPlay && nativePlay) proto.play = nativePlay;
            const ownsSetMediaKeys = Boolean(!nativeSetMediaKeys || (proto.setMediaKeys && proto.setMediaKeys.name === "patchedSetMediaKeys"));
            const ownsWebkitSetMediaKeys = Boolean(!nativeWebkitSetMediaKeys || (proto.webkitSetMediaKeys && proto.webkitSetMediaKeys.name === "patchedWebkitSetMediaKeys"));
            if (ownsSetMediaKeys && nativeSetMediaKeys) proto.setMediaKeys = nativeSetMediaKeys;
            if (ownsWebkitSetMediaKeys && nativeWebkitSetMediaKeys) proto.webkitSetMediaKeys = nativeWebkitSetMediaKeys;
            if (ownsVolume) deletePatchMarker(proto, "__volumeControlVolumePatched");
            if (ownsSrcObject) deletePatchMarker(proto, "__volumeControlSrcObjectPatched");
            if (ownsPlay) deletePatchMarker(proto, "__volumeControlPlayPatched");
            if (ownsSetMediaKeys && ownsWebkitSetMediaKeys) deletePatchMarker(proto, "__volumeControlSetMediaKeysPatched");
        }

        if (window.Audio && window.Audio.name === "VolumeControlAudio" && nativeAudioConstructor) {
            window.Audio = nativeAudioConstructor;
        }

        if (DocumentPrototype) {
            const ownsCreateElement = Boolean(DocumentPrototype.createElement && DocumentPrototype.createElement.name === "patchedCreateElement");
            const ownsCreateElementNS = Boolean(!nativeCreateElementNS || (DocumentPrototype.createElementNS && DocumentPrototype.createElementNS.name === "patchedCreateElementNS"));
            if (ownsCreateElement && nativeCreateElement) DocumentPrototype.createElement = nativeCreateElement;
            if (ownsCreateElementNS && nativeCreateElementNS) DocumentPrototype.createElementNS = nativeCreateElementNS;
            if (ownsCreateElement && ownsCreateElementNS) deletePatchMarker(DocumentPrototype, "__volumeControlCreateElementPatched");
        }

        if (NavigatorPrototype &&
            NavigatorPrototype.requestMediaKeySystemAccess &&
            NavigatorPrototype.requestMediaKeySystemAccess.name === "patchedRequestMediaKeySystemAccess" &&
            nativeRequestMediaKeySystemAccess) {
            NavigatorPrototype.requestMediaKeySystemAccess = nativeRequestMediaKeySystemAccess;
            deletePatchMarker(NavigatorPrototype, "__volumeControlRmksaPatched");
        }

        if (MediaKeySystemAccessPrototype &&
            MediaKeySystemAccessPrototype.createMediaKeys &&
            MediaKeySystemAccessPrototype.createMediaKeys.name === "patchedCreateMediaKeys" &&
            nativeCreateMediaKeys) {
            MediaKeySystemAccessPrototype.createMediaKeys = nativeCreateMediaKeys;
            deletePatchMarker(MediaKeySystemAccessPrototype, "__volumeControlCmkPatched");
        }

        if (window.history) {
            const ownsPushState = Boolean(window.history.pushState && window.history.pushState.name === "patchedHistoryMethod");
            const ownsReplaceState = Boolean(window.history.replaceState && window.history.replaceState.name === "patchedHistoryMethod");
            if (ownsPushState && nativeHistoryPushState) window.history.pushState = nativeHistoryPushState;
            if (ownsReplaceState && nativeHistoryReplaceState) window.history.replaceState = nativeHistoryReplaceState;
            if (ownsPushState && ownsReplaceState) deletePatchMarker(window.history, "__volumeControlNavigationPatched");
        }
        if (spaNavigationNotify) {
            window.removeEventListener("popstate", spaNavigationNotify);
            window.removeEventListener("hashchange", spaNavigationNotify);
            spaNavigationNotify = null;
        }

        if (gestureListenersInstalled) {
            document.removeEventListener("pointerdown", resumeMediaContextOnGesture, true);
            document.removeEventListener("keydown", resumeMediaContextOnGesture, true);
            gestureListenersInstalled = false;
        }

        for (const element of Array.from(mediaElements)) {
            if (!mediaRoutes.has(element)) {
                detachMediaElementListeners(element);
                mediaElements.delete(element);
            }
        }

        hooksInstalled = false;
    }

    function handleBridgeMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE || data.target !== BRIDGE_TARGET) return;

        if (!bridgeToken) {
            if ((data.command !== "setState" && data.command !== "heartbeat") ||
                typeof data.token !== "string" || data.token.length < 24) return;
            bridgeToken = data.token;
        } else if (data.token !== bridgeToken) {
            if (!state.extensionActive &&
                (data.command === "setState" || data.command === "heartbeat") &&
                typeof data.token === "string" && data.token.length >= 24) {
                bridgeToken = data.token;
            } else {
                return;
            }
        }

        // Handle heartbeat from the content script. If the content script is
        // unloaded (extension disabled/updated), the heartbeat stops and we
        // restore native audio behavior.
        if (data.command === "heartbeat") {
            lastHeartbeat = Date.now();
            if (!state.extensionActive) {
                state.extensionActive = true;
                log("Extension reconnected — requesting current state");
                // Request a fresh state sync from the content script. Our state
                // was reset to defaults by restoreNativeBehavior, and the content
                // script's syncPageAudioHook would skip if it thinks nothing changed.
                postToContentScript("requestState");
            }
            return;
        }

        if (data.command !== "setState") return;

        // Version check — log a warning on mismatch but continue processing.
        if (data.version !== undefined && data.version !== BRIDGE_VERSION) {
            log(`Bridge version mismatch: page hook v${BRIDGE_VERSION}, content script v${data.version}. Some features may not work correctly.`);
        }

        lastHeartbeat = Date.now();
        const wasNormalizing = state.extensionActive && state.enabled && state.normalizerEnabled;
        state.extensionActive = true;
        state.enabled = data.enabled !== false;
        state.dB = normalizeDb(data.dB);
        state.mono = Boolean(data.mono);
        state.muted = Boolean(data.muted);
        state.normalizerEnabled = Boolean(data.normalizerEnabled);
        state.normalizerConfig = normalizeNormalizerConfig(data.normalizerConfig);
        const nowNormalizing = state.enabled && state.normalizerEnabled;
        if (wasNormalizing !== nowNormalizing) {
            // Re-enable at unity gain rather than replaying stale auto gain.
            // Do this before reconnecting graphs/MediaElementSource nodes.
            eachTrackedContext((context) => {
                const graph = graphs.get(context);
                if (graph) {
                    graph.normalizerGainDb = 0;
                    graph.meterPeakDb = -Infinity;
                }
            });
            for (const element of mediaElements) {
                const route = mediaRoutes.get(element);
                if (route) {
                    route.normalizerGainDb = 0;
                    route.meterPeakDb = -Infinity;
                }
            }
        }
        state.debugMode = Boolean(data.debugMode);
        state.forceDrmCapture = Boolean(data.forceDrmCapture);
        state.forceCorsCapture = Boolean(data.forceCorsCapture);
        state.debugRouteMode = data.debugRouteMode === "webaudio" || data.debugRouteMode === "native"
            ? data.debugRouteMode
            : "auto";

        if (state.enabled) {
            ensurePageHooksInstalled();
        } else {
            stopMaintenanceTimers();
        }

        // Route or unroute depending on whether audio processing is needed.
        if (pageAudioNeedsRoute()) {
            routeRecordedDestinationConnections();
            routeKnownAudioLibraries();
        } else {
            unrouteDestinationConnections();
            unrouteHowlerGlobal();
        }
        applyStateToGraphs();
        applyStateToMediaElements();
        releasePreflightMediaMute();
        if (!state.enabled) restorePatchedPageApis();
    }

    function restoreNativeBehavior() {
        // Called when the content script heartbeat times out, indicating the
        // extension has been disabled or updated. We can't truly un-patch the
        // prototypes (other code may hold references), but we can make all
        // patched functions transparent by setting state to disabled/unity and
        // unrouting everything so the audio path is native.
        log("Extension heartbeat lost — restoring native audio behavior");
        state.enabled = false;
        state.dB = 0;
        state.mono = false;
        state.muted = false;
        state.normalizerEnabled = false;
        state.normalizerConfig = normalizeNormalizerConfig({});
        state.forceDrmCapture = false;
        state.forceCorsCapture = false;
        state.debugRouteMode = "auto";
        state.extensionActive = false;
        stopMaintenanceTimers();

        unrouteDestinationConnections();
        unrouteHowlerGlobal();

        for (const element of Array.from(mediaElements)) {
            const route = mediaRoutes.get(element);
            if (route && isMediaPlaying(element) && isAudibleMediaElement(element)) {
                // Once createMediaElementSource() has been called, the element's
                // native output is permanently detached — its ONLY remaining
                // audio path is source→gain→destination. releaseMediaRoute()
                // would disconnect that path and mute a PLAYING element until
                // its next media event, which can be minutes away on a long
                // track. effectiveGain() is already 1.0 (extensionActive=false),
                // so keep the route wired and pass audio through at unity.
                try {
                    setNativeVolume(element, route.muteNative ? 0 : getMediaState(element).baseVolume);
                } catch (e) {
                    log(`native volume restore failed: ${e && e.message}`);
                }
                wireMediaRoute(route);
                continue;
            }
            releaseMediaRoute(element);
        }

        suspendMediaContextIfIdle();
        suspendIdleContexts();
        restorePatchedPageApis();
        bridgeToken = null;
    }

    function runRestrictionAudit() {
        updatePageMediaRestriction();
        for (const element of Array.from(mediaElements)) {
            const entry = mediaState.get(element);
            if (!entry || mediaRoutes.has(element)) continue;
            if (isPendingEmeSuspect(element)) {
                applyMediaElementState(element);
                continue;
            }
            if (entry.lastFallbackWriteAt === undefined) continue;
            if (!isMediaPlaying(element) || !isAudibleMediaElement(element)) continue;
            const gain = effectiveGain();
            const expected = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
            if (Math.abs(readNativeVolume(element) - expected) > 0.02) applyMediaElementState(element);
        }
    }

    function sweepDetachedMediaElements() {
        for (const element of Array.from(mediaElements)) {
            if (!element.isConnected && !isDetachedButAudible(element)) {
                cleanupTrackedMediaElement(element);
            }
        }
        setTimeout(suspendMediaContextIfIdle, 0);
    }


    function sampleProcessor(processor) {
        if (!processor || !processor.analyser || !processor.context || processor.context.state !== "running") {
            return { peakDb: -Infinity, gainDb: processor && Number(processor.normalizerGainDb) || 0 };
        }
        const analyser = processor.analyser;
        if (!processor.meterBuffer || processor.meterBuffer.length !== analyser.fftSize) {
            processor.meterBuffer = new Float32Array(analyser.fftSize);
        }
        try {
            analyser.getFloatTimeDomainData(processor.meterBuffer);
        } catch (e) {
            return { peakDb: -Infinity, gainDb: Number(processor.normalizerGainDb) || 0 };
        }

        let peak = 0;
        for (let i = 0; i < processor.meterBuffer.length; i++) {
            const sample = processor.meterBuffer[i];
            const abs = Math.abs(sample);
            if (abs > peak) peak = abs;
        }

        const peakDb = peak > 0.000001 ? 20 * Math.log10(peak) : -Infinity;
        processor.meterPeakDb = peakDb;

        // The output analyser supplies peak metering only; source RMS feeds AGC.
        // Otherwise moving the user's slider changes detected loudness and
        // the normalizer gradually cancels their requested gain adjustment.
        let sourceRmsDb = -120;
        const sourceAnalyser = processor.inputAnalyser;
        if (sourceAnalyser) {
            if (!processor.inputBuffer || processor.inputBuffer.length !== sourceAnalyser.fftSize) {
                processor.inputBuffer = new Float32Array(sourceAnalyser.fftSize);
            }
            try {
                sourceAnalyser.getFloatTimeDomainData(processor.inputBuffer);
                let sourceSum = 0;
                for (let i = 0; i < processor.inputBuffer.length; i++) {
                    sourceSum += processor.inputBuffer[i] * processor.inputBuffer[i];
                }
                const sourceRms = Math.sqrt(sourceSum / Math.max(1, processor.inputBuffer.length));
                sourceRmsDb = sourceRms > 0.000001 ? 20 * Math.log10(sourceRms) : -120;
            } catch (e) {}
        }
        const config = normalizeNormalizerConfig(state.normalizerConfig);
        let gainDb = Number(processor.normalizerGainDb) || 0;
        if (state.normalizerEnabled && state.extensionActive && state.enabled && !state.muted && sourceRmsDb > -80) {
            const desired = Math.max(-18, Math.min(config.maxBoostDb, config.targetDb - sourceRmsDb));
            const intervalMs = 100;
            const alpha = 1 - Math.exp(-intervalMs / Math.max(100, config.responseMs));
            gainDb += (desired - gainDb) * alpha;
        } else {
            gainDb += (0 - gainDb) * 0.35;
        }

        if (Math.abs(gainDb) < 0.01) gainDb = 0;
        processor.normalizerGainDb = gainDb;
        configureLimiter(processor);

        try {
            const now = processor.context.currentTime;
            const target = effectiveGain() * (state.normalizerEnabled ? dbToGain(gainDb) : 1);
            processor.gain.gain.cancelScheduledValues(now);
            processor.gain.gain.setTargetAtTime(target, now, 0.035);
        } catch (e) {}

        return { peakDb, gainDb };
    }

    function updateNormalizerAndMeter() {
        if (!state.normalizerEnabled) return;
        let peakDb = -Infinity;
        let gainDb = 0;
        let gainCount = 0;

        eachTrackedContext((context) => {
            const graph = graphs.get(context);
            if (!graph) return;
            const sample = sampleProcessor(graph);
            if (Number.isFinite(sample.peakDb)) peakDb = Math.max(peakDb, sample.peakDb);
            if (Number.isFinite(sample.gainDb)) {
                gainDb += sample.gainDb;
                gainCount++;
            }
        });

        for (const element of Array.from(mediaElements)) {
            const route = mediaRoutes.get(element);
            if (!route || !route.outputConnected) continue;
            const sample = sampleProcessor(route);
            if (Number.isFinite(sample.peakDb)) peakDb = Math.max(peakDb, sample.peakDb);
            if (Number.isFinite(sample.gainDb)) {
                gainDb += sample.gainDb;
                gainCount++;
            }
        }

        postToContentScript("meterUpdate", {
            peakDb,
            normalizerGainDb: gainCount ? gainDb / gainCount : 0
        });
    }

    function syncNormalizerMeterTimer() {
        const shouldRun = state.extensionActive && state.enabled && state.normalizerEnabled;
        if (!shouldRun) {
            if (normalizerMeterTimerId !== null) clearInterval(normalizerMeterTimerId);
            normalizerMeterTimerId = null;
            return;
        }
        if (normalizerMeterTimerId === null) {
            normalizerMeterTimerId = setInterval(updateNormalizerAndMeter, 100);
        }
    }

    function startMaintenanceTimers() {
        // Called on every state sync; update the meter separately even when
        // the lower-frequency maintenance timers are already installed.
        syncNormalizerMeterTimer();
        if (!state.extensionActive || !state.enabled || maintenanceTimerIds.length) return;

        let howlerPollCount = 0;
        howlerPollId = setInterval(() => {
            howlerPollCount++;
            if (window.Howler) {
                routeKnownAudioLibraries();
                clearInterval(howlerPollId);
                howlerPollId = null;
            } else if (howlerPollCount >= 30) {
                clearInterval(howlerPollId);
                howlerPollId = null;
            }
        }, 1000);

        maintenanceTimerIds = [
            setInterval(sweepDeadDestinationConnections, 30000),
            setInterval(runRestrictionAudit, 1000),
            setInterval(sweepDetachedMediaElements, 30000),
            setInterval(() => {
                if (state.extensionActive && Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
                    restoreNativeBehavior();
                }
            }, 2000)
        ];
    }

    function stopMaintenanceTimers() {
        if (normalizerMeterTimerId !== null) clearInterval(normalizerMeterTimerId);
        normalizerMeterTimerId = null;
        for (const id of maintenanceTimerIds) clearInterval(id);
        maintenanceTimerIds = [];
        if (howlerPollId !== null) {
            clearInterval(howlerPollId);
            howlerPollId = null;
        }
        if (mediaObserver) {
            mediaObserver.disconnect();
            mediaObserver = null;
        }
    }

    const resumeMediaContextOnGesture = () => {
        if (state.extensionActive && state.enabled && mediaAudioContext) resumeContext(mediaAudioContext);
    };

    function ensurePageHooksInstalled() {
        if (!hooksInstalled) {
            patchAudioNodeRouting();
            patchMediaVolume();
            patchMediaSrcObject();
            patchMediaPlayback();
            patchAudioConstructor();
            patchElementCreation();
            patchEmeApi();
            patchSpaNavigation();
            hooksInstalled = true;

            if (!gestureListenersInstalled) {
                document.addEventListener("pointerdown", resumeMediaContextOnGesture, { passive: true, capture: true });
                document.addEventListener("keydown", resumeMediaContextOnGesture, { passive: true, capture: true });
                gestureListenersInstalled = true;
            }
        }

        if (document.documentElement) scanMediaElements(document);
        else document.addEventListener("DOMContentLoaded", () => {
            if (state.extensionActive && state.enabled) scanMediaElements(document);
        }, { once: true });

        if (!mediaObserver) mediaObserver = watchForInjectedMediaElements();
        startMaintenanceTimers();
    }

    // Install a transparent AudioNode destination interceptor immediately at
    // document_start. It records graphs created before async storage/profile
    // resolution but does not reroute or alter gain until an authenticated
    // setState enables this document. Excluded pages restore the native methods
    // as soon as their disabled state arrives.
    patchAudioNodeRouting();

    try {
        Object.defineProperty(window, HOOK_KEY, {
            value: { installed: true },
            configurable: false,
            enumerable: false,
            writable: false
        });
    } catch (e) {
        window[HOOK_KEY] = { installed: true };
    }

    window.addEventListener("message", handleBridgeMessage);
})();
