(() => {
    const HOOK_KEY = "__volumeControlPageAudioHook";
    const BRIDGE_SOURCE = "volume-control-extension";
    const BRIDGE_TARGET = "volume-control-page-audio";
    const MEDIA_MANAGED_ATTR = "vcPageAudioManaged";
    const MIN_DB = -32;
    const MAX_DB = 32;
    const BRIDGE_VERSION = 1;
    const HEARTBEAT_TIMEOUT_MS = 10000;
    const supportsWeakRef = typeof WeakRef !== "undefined";

    if (window[HOOK_KEY] && window[HOOK_KEY].installed) return;

    const state = {
        enabled: true,
        dB: 0,
        mono: false,
        muted: false,
        debugMode: false,
        extensionActive: true
    };
    function effectiveGain() {
        // When the extension is inactive (disabled, blocked, or heartbeat lost),
        // pass audio through at unity so page audio behaves natively.
        if (!state.extensionActive || !state.enabled) return 1.0;
        if (state.muted) return 0;
        return getGainValue(state.dB);
    }

    let lastHeartbeat = Date.now();

    const graphs = new WeakMap();
    const contexts = new Set();
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
        try {
            if (context && context.state === "suspended" && typeof context.resume === "function") {
                context.resume();
            }
        } catch (e) {
            log(`context resume failed: ${e && e.message}`);
        }
    }

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

        // If no routes remain, close the context to fully release the OS audio
        // device handle (critical for Bluetooth devices that stay active while
        // a running AudioContext holds the output stream open).
        if (!hasAnyRoute) {
            try {
                if (typeof mediaAudioContext.close === "function") {
                    mediaAudioContext.close();
                    mediaAudioContext = null;
                    log("media context closed (no active routes) — device handle released");
                } else if (typeof mediaAudioContext.suspend === "function") {
                    mediaAudioContext.suspend();
                }
            } catch (e) {
                log(`media context close failed: ${e && e.message}`);
            }
        } else {
            try {
                if (typeof mediaAudioContext.suspend === "function") {
                    mediaAudioContext.suspend();
                }
            } catch (e) {
                log(`media context suspend failed: ${e && e.message}`);
            }
        }
    }

    function suspendIdleContexts() {
        // Suspend page-level AudioContexts that the extension has routed through
        // but which no longer have any active audio sources. This is critical for
        // Bluetooth devices: a running AudioContext keeps the OS audio output
        // stream open, preventing the device from returning to idle.
        for (const ctx of Array.from(contexts)) {
            if (!ctx || ctx.state === "closed") {
                contexts.delete(ctx);
                continue;
            }
            if (ctx.state !== "running") continue;
            if (ctx === mediaAudioContext) continue; // handled by suspendMediaContextIfIdle

            // Check if any media route on this context is still playing.
            if (hasActiveMediaRoute(ctx)) continue;

            // Check if any destination connection on this context is still routed.
            // For page-owned audio (Howler, WebAudio apps), we conservatively assume
            // routed connections may still be active, so we only suspend contexts
            // that have NO routed connections at all.
            let hasRoutedConnection = false;
            for (const entry of destinationConnections) {
                if (nodeFromRef(entry.contextRef) === ctx && entry.routed) {
                    hasRoutedConnection = true;
                    break;
                }
            }
            if (hasRoutedConnection) continue;

            try {
                if (typeof ctx.suspend === "function") {
                    ctx.suspend();
                    log(`page context suspended (idle): state=${ctx.state}`);
                }
            } catch (e) {
                log(`page context suspend failed: ${e && e.message}`);
            }
        }
    }

    function disconnectMediaRouteOutput(route) {
        if (!route) return;

        safeDisconnect(route.gain);
        safeDisconnect(route.splitter);
        safeDisconnect(route.leftGain);
        safeDisconnect(route.rightGain);
        safeDisconnect(route.merger);
        route.outputConnected = false;
    }

    function releaseMediaRoute(element) {
        const route = mediaRoutes.get(element);
        if (!route) return;

        disconnectMediaRouteOutput(route);

        // Do NOT disconnect route.source from route.gain, and do NOT delete the
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
        const targetGain = effectiveGain();
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
    function currentRoutingMode() {
        const wantMono = state.extensionActive && state.enabled && state.mono;
        return (state.extensionActive && state.enabled) ? (wantMono ? "mono" : "stereo") : "bypass";
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

        // Skip the disconnect/reconnect cycle if the routing mode hasn't changed.
        const wantMode = currentRoutingMode();
        if (graph.currentMode === wantMode) return;
        graph.currentMode = wantMode;

        safeDisconnect(graph.gain);
        safeDisconnect(graph.splitter);
        safeDisconnect(graph.leftGain);
        safeDisconnect(graph.rightGain);
        safeDisconnect(graph.merger);

        try {
            if (state.extensionActive && state.enabled && state.mono) {
                connectMonoChain(graph.gain, graph.splitter, graph.leftGain, graph.rightGain, graph.merger, graph.context.destination);
            } else {
                connectNative(graph.gain, graph.context.destination);
            }
        } catch (e) {
            log(`graph wire failed: ${e && e.message}`);
        }
    }

    function ensureGraph(context) {
        if (!context || isOfflineContext(context)) return null;
        if (graphs.has(context)) return graphs.get(context);

        try {
            const gain = markNode(context.createGain());
            const splitter = markNode(context.createChannelSplitter(2));
            const leftGain = markNode(context.createGain());
            const rightGain = markNode(context.createGain());
            const merger = markNode(context.createChannelMerger(2));

            gain.channelInterpretation = "speakers";
            leftGain.gain.value = 0.5;
            rightGain.gain.value = 0.5;

            const graph = { context, gain, splitter, leftGain, rightGain, merger, currentMode: null };
            graphs.set(context, graph);
            contexts.add(context);
            wireGraph(graph);
            return graph;
        } catch (e) {
            log(`graph create failed: ${e && e.message}`);
            return null;
        }
    }

    function applyStateToGraphs() {
        for (const context of Array.from(contexts)) {
            if (!context || context.state === "closed") {
                contexts.delete(context);
                continue;
            }

            const graph = graphs.get(context);
            if (graph) wireGraph(graph);
        }
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
        const src = getMediaSourceUrl(element);
        if (!src || element.crossOrigin) return false;

        try {
            const url = new URL(src, document.baseURI);
            return url.protocol.indexOf("http") === 0 && url.origin !== window.location.origin;
        } catch (e) {
            return false;
        }
    }

    function createMediaRouteSource(context, element) {
        // captureStream() adds a delayed parallel copy, so blocked media falls back to native volume.
        if (isLikelyCrossOriginMedia(element)) {
            log(`skipping MediaElementAudioSource for cross-origin media: ${getMediaSourceUrl(element)}`);
            return null;
        }

        try {
            return {
                source: markNode(context.createMediaElementSource(element)),
                kind: "mediaElement"
            };
        } catch (e) {
            log(`createMediaElementSource failed: ${e && e.message}`);
        }

        return null;
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
                listenersInstalled: false
            };
            mediaState.set(element, entry);
        }
        return entry;
    }

    function mediaNeedsAudioRoute() {
        return state.extensionActive && state.enabled && (state.muted || state.mono || getGainValue(state.dB) > 1);
    }

    function pageAudioNeedsRoute() {
        return state.extensionActive && state.enabled && (state.muted || state.mono || Number(state.dB) !== 0);
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

            const graph = ensureGraph(nodeFromRef(entry.contextRef));
            if (!graph) continue;

            try {
                disconnectNative(source, dest, entry.outputIndex, entry.inputIndex);
            } catch (e) {
                log(`native destination disconnect failed: ${e && e.message}`);
            }

            try {
                connectNative(source, graph.gain, entry.outputIndex, 0);
                entry.routed = true;
            } catch (e) {
                log(`recorded destination route failed: ${e && e.message}`);
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
            if (graph) {
                try {
                    disconnectNative(source, graph.gain, entry.outputIndex, 0);
                } catch (e) {
                    log(`unroute disconnect failed: ${e && e.message}`);
                }
            }

            try {
                connectNative(source, dest, entry.outputIndex, entry.inputIndex);
                entry.routed = false;
            } catch (e) {
                log(`unroute reconnect failed: ${e && e.message}`);
            }
        }
    }

    function routeHowlerGlobal() {
        if (!pageAudioNeedsRoute()) return;

        const howler = window.Howler;
        if (!howler || !howler.ctx || !howler.masterGain) return;

        const masterGain = howler.masterGain;
        if (howlerRoutes.has(masterGain)) return;

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
        }

        try {
            connectNative(masterGain, graph.gain);
            howlerRoutes.set(masterGain, { context: howler.ctx, graph });
            trackDestinationConnection(masterGain, howler.ctx.destination, undefined, undefined, true);
            log("Howler master gain routed");
        } catch (e) {
            log(`Howler master route failed: ${e && e.message}`);
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
                disconnectNative(masterGain, graph.gain);
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
        const targetGain = effectiveGain();

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
            if (state.extensionActive && state.enabled && state.mono) {
                connectMonoChain(route.gain, route.splitter, route.leftGain, route.rightGain, route.merger, route.context.destination);
            } else {
                connectNative(route.gain, route.context.destination);
            }
            route.outputConnected = true;
        } catch (e) {
            log(`media graph wire failed: ${e && e.message}`);
        }
    }

    function ensureMediaRoute(element) {
        if (!mediaNeedsAudioRoute() || !isAudibleMediaElement(element)) return null;
        if (mediaRoutes.has(element)) return mediaRoutes.get(element);

        const context = getMediaContext();
        if (!context) return null;

        try {
            const routeSource = createMediaRouteSource(context, element);
            if (!routeSource) return null;

            const source = routeSource.source;
            const gain = markNode(context.createGain());
            const splitter = markNode(context.createChannelSplitter(2));
            const leftGain = markNode(context.createGain());
            const rightGain = markNode(context.createGain());
            const merger = markNode(context.createChannelMerger(2));

            gain.channelInterpretation = "speakers";
            leftGain.gain.value = 0.5;
            rightGain.gain.value = 0.5;
            // Set the gain value BEFORE connecting the source so there is no
            // brief moment of full-volume (gain=1.0) audio at route creation.
            gain.gain.value = effectiveGain();
            connectNative(source, gain);

            const route = {
                context,
                source,
                gain,
                splitter,
                leftGain,
                rightGain,
                merger,
                sourceKind: routeSource.kind,
                outputConnected: false,
                currentMode: null
            };
            mediaRoutes.set(element, route);
            wireMediaRoute(route);
            log(`media route attached (${route.sourceKind}): ${element.currentSrc || element.src || element.tagName}`);
            return route;
        } catch (e) {
            log(`media route failed: ${e && e.message}`);
            return null;
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
            if (existingRoute) disconnectMediaRouteOutput(existingRoute);

            const nativeVolume = existingRoute
                ? entry.baseVolume
                : Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
            setNativeVolume(element, nativeVolume);
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
            // Restore native volume BEFORE wiring the route so the WebAudio gain
            // is the only scaling applied. If we wire first, there is a brief
            // moment where effective volume = fallbackScaledVolume × gain, which
            // causes an audible dip-then-snap spike.
            setNativeVolume(element, entry.baseVolume);
            wireMediaRoute(route);
            // After wireMediaRoute, output should be reconnected. If the context
            // was suspended (e.g. after pause), resume it so audio flows again.
            if (route.outputConnected) resumeContext(route.context);
            else setTimeout(suspendMediaContextIfIdle, 250);
            return;
        }

        const fallbackVolume = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
        setNativeVolume(element, fallbackVolume);
    }

    function applyStateToMediaElements() {
        for (const element of Array.from(mediaElements)) {
            applyMediaElementState(element);
        }
    }

    function registerMediaElement(element, options = {}) {
        if (!isMediaElement(element)) return element;

        try {
            if (element.dataset) element.dataset[MEDIA_MANAGED_ATTR] = "true";
        } catch (e) {
            log(`media marker failed: ${e && e.message}`);
        }

        mediaElements.add(element);
        const entry = getMediaState(element);
        if (!entry.listenersInstalled && typeof element.addEventListener === "function") {
            const applyOnPlay = () => {
                mediaElements.add(element);
                applyMediaElementState(element);
            };
            const suspendWhenIdle = () => {
                if (!isMediaPlaying(element)) {
                    disconnectMediaRouteOutput(mediaRoutes.get(element));
                }
                setTimeout(suspendMediaContextIfIdle, 250);
            };
            const applyOnVolumeChange = () => {
                const currentEntry = getMediaState(element);
                if (currentEntry.ignoreVolumeEventsUntil > Date.now()) return;

                applyMediaElementState(element);
                setTimeout(suspendMediaContextIfIdle, 250);
            };
            const release = () => {
                releaseMediaRoute(element);
                mediaElements.delete(element);
                setTimeout(suspendMediaContextIfIdle, 250);
            };

            element.addEventListener("play", applyOnPlay, { passive: true });
            element.addEventListener("playing", applyOnPlay, { passive: true });
            element.addEventListener("volumechange", applyOnVolumeChange, { passive: true });
            element.addEventListener("pause", suspendWhenIdle, { passive: true });
            element.addEventListener("ended", release, { passive: true });
            element.addEventListener("emptied", release, { passive: true });
            element.addEventListener("error", release, { passive: true });
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

    function patchAudioNodeRouting() {
        if (!AudioNodePrototype || !nativeConnect || AudioNodePrototype.__volumeControlPatched) return;

        AudioNodePrototype.connect = function patchedConnect(destination, outputIndex, inputIndex) {
            if (isContextDestination(destination) && !vcNodes.has(this)) {
                const context = this.context || destination.context;
                const graph = (graphs.has(context) || pageAudioNeedsRoute()) ? ensureGraph(context) : null;
                if (graph) {
                    trackDestinationConnection(this, destination, outputIndex, inputIndex, true);
                    connectNative(this, graph.gain, outputIndex, 0);
                    return destination;
                }

                trackDestinationConnection(this, destination, outputIndex, inputIndex, false);
            }

            return nativeConnect.apply(this, arguments);
        };

        if (nativeDisconnect) {
            AudioNodePrototype.disconnect = function patchedDisconnect(destination) {
                if (arguments.length === 0 && !vcNodes.has(this)) {
                    removeDestinationConnectionsForSource(this);
                    return nativeDisconnect.apply(this, arguments);
                }

                if (isContextDestination(destination) && !vcNodes.has(this)) {
                    const entry = removeDestinationConnection(this, destination, arguments[1], arguments[2]);
                    if (entry && entry.routed) {
                        const graph = graphs.get(nodeFromRef(entry.contextRef));
                        if (graph) return disconnectNative(this, graph.gain, entry.outputIndex, 0);
                    }
                }

                return nativeDisconnect.apply(this, arguments);
            };
        }

        Object.defineProperty(AudioNodePrototype, "__volumeControlPatched", {
            value: true,
            configurable: false,
            enumerable: false
        });
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
                    const entry = getMediaState(this);

                    if (entry.applyingVolume) {
                        nativeVolumeDescriptor.set.call(this, Number.isNaN(n) ? value : n);
                        return;
                    }

                    entry.baseVolume = Number.isNaN(n) ? entry.baseVolume : Math.max(0, Math.min(1, n));

                    // Keep the native volume property in sync with baseVolume so that
                    // when the route is disconnected (e.g., on pause), the element's
                    // native volume matches what we last reported via the getter.
                    // Without this, the native volume drifts and can cause a spike
                    // when playback resumes before the WebAudio route is re-established.
                    entry.applyingVolume = true;
                    entry.ignoreVolumeEventsUntil = Date.now() + 100;
                    try {
                        nativeVolumeDescriptor.set.call(this, entry.baseVolume);
                    } catch (e) {
                        log(`native volume sync failed: ${e && e.message}`);
                    } finally {
                        entry.applyingVolume = false;
                    }

                    registerMediaElement(this);
                }
            });

            Object.defineProperty(window.HTMLMediaElement.prototype, "__volumeControlVolumePatched", {
                value: true,
                configurable: false,
                enumerable: false
            });
        } catch (e) {
            log(`media volume patch failed: ${e && e.message}`);
        }
    }

    function patchMediaPlayback() {
        if (!window.HTMLMediaElement || !nativePlay) return;
        if (window.HTMLMediaElement.prototype.__volumeControlPlayPatched) return;

        window.HTMLMediaElement.prototype.play = function patchedPlay() {
            registerMediaElement(this);
            return nativePlay.apply(this, arguments);
        };

        Object.defineProperty(window.HTMLMediaElement.prototype, "__volumeControlPlayPatched", {
            value: true,
            configurable: false,
            enumerable: false
        });
    }

    function patchAudioConstructor() {
        if (!nativeAudioConstructor || nativeAudioConstructor.__volumeControlPatched) return;

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
                configurable: false,
                enumerable: false
            });

            window.Audio = VolumeControlAudio;
        } catch (e) {
            log(`Audio constructor patch failed: ${e && e.message}`);
        }
    }

    function patchElementCreation() {
        if (!window.Document || window.Document.prototype.__volumeControlCreateElementPatched) return;

        const nativeCreateElement = window.Document.prototype.createElement;
        const nativeCreateElementNS = window.Document.prototype.createElementNS;

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
                configurable: false,
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
            window.postMessage({
                source: BRIDGE_TARGET,
                target: BRIDGE_SOURCE,
                command,
                ...extra
            }, "*");
        } catch (e) {
            log(`postToContentScript (${command}) failed: ${e && e.message}`);
        }
    }

    function handleBridgeMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE || data.target !== BRIDGE_TARGET) return;

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
        state.extensionActive = true;
        state.enabled = data.enabled !== false;
        state.dB = normalizeDb(data.dB);
        state.mono = Boolean(data.mono);
        state.muted = Boolean(data.muted);
        state.debugMode = Boolean(data.debugMode);

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
        state.extensionActive = false;

        unrouteDestinationConnections();
        unrouteHowlerGlobal();

        for (const element of Array.from(mediaElements)) {
            releaseMediaRoute(element);
        }

        suspendMediaContextIfIdle();
        suspendIdleContexts();
    }

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

    patchAudioNodeRouting();
    patchMediaVolume();
    patchMediaPlayback();
    patchAudioConstructor();
    patchElementCreation();

    // Poll for Howler for up to 30 seconds, then stop. Once Howler is detected,
    // clear the poll — routeKnownAudioLibraries will be called from handleBridgeMessage
    // on future state changes. Previously the poll only cleared after routing, which
    // meant it ran forever if the user set volume to 0 dB (unroute deletes the route).
    let howlerPollCount = 0;
    const howlerPoll = setInterval(() => {
        howlerPollCount++;
        if (window.Howler) {
            routeKnownAudioLibraries();
            clearInterval(howlerPoll);
        } else if (howlerPollCount >= 30) {
            // Give up after 30 seconds — Howler probably isn't on this page.
            clearInterval(howlerPoll);
        }
    }, 1000);

    // Periodically sweep dead destination connections (GC'd nodes) to prevent
    // the Set from growing unboundedly on pages that create many short-lived
    // audio nodes.
    setInterval(sweepDeadDestinationConnections, 30000);

    // Heartbeat checker: if the content script hasn't pinged us recently,
    // assume the extension has been disabled/updated and restore native behavior.
    setInterval(() => {
        if (state.extensionActive && Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
            restoreNativeBehavior();
        }
    }, 2000);

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            scanMediaElements(document);
        }, { once: true });
    } else {
        scanMediaElements(document);
    }

    window.addEventListener("message", handleBridgeMessage);
})();
