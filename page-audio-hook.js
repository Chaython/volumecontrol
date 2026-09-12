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
        try {
            if (typeof mediaAudioContext.suspend === "function") {
                mediaAudioContext.suspend();
                log(hasAnyRoute
                    ? "media context suspended (idle routes kept) — device handle released"
                    : "media context suspended (no routes) — device handle released");
            }
        } catch (e) {
            log(`media context suspend failed: ${e && e.message}`);
        }
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
            if (context && selfSuspendedContexts.has(context)) {
                resumeContext(context);
                if (context.state === "running") selfSuspendedContexts.delete(context);
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

            try {
                if (typeof ctx.suspend === "function") {
                    ctx.suspend();
                    // Remember that WE suspended this context so a later
                    // destination connection resumes it (see
                    // resumeIfSelfSuspended).
                    selfSuspendedContexts.add(ctx);
                    log(`page context suspended (idle): state=${ctx.state}`);
                }
            } catch (e) {
                log(`page context suspend failed: ${e && e.message}`);
            }
        });
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
            const pageOrigin = (typeof document.origin === "string" && document.origin) || window.location.origin;
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

    function isRestrictedMediaElement(element) {
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

    function pageCreatedMediaKeys() {
        try {
            return document.documentElement.dataset.vcPageEmeActive === "true";
        } catch (e) {
            return false;
        }
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
            if (EME_AUDIO_SILENCED_WHEN_ROUTED && elementDrmEvidence(element)) {
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
                const nativeSetMediaKeys = proto.setMediaKeys;
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
                const nativeWebkitSetMediaKeys = proto.webkitSetMediaKeys;
                if (typeof nativeWebkitSetMediaKeys === "function") {
                    proto.webkitSetMediaKeys = function patchedWebkitSetMediaKeys(mediaKeys) {
                        if (mediaKeys) markElementRestricted(this);
                        return nativeWebkitSetMediaKeys.apply(this, arguments);
                    };
                }
                Object.defineProperty(proto, "__volumeControlSetMediaKeysPatched", {
                    value: true,
                    configurable: false,
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
                const nativeRequest = window.Navigator.prototype.requestMediaKeySystemAccess;
                window.Navigator.prototype.requestMediaKeySystemAccess = function patchedRequestMediaKeySystemAccess() {
                    const result = nativeRequest.apply(this, arguments);
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
                    configurable: false,
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
                const nativeCreateMediaKeys = window.MediaKeySystemAccess.prototype.createMediaKeys;
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
                    configurable: false,
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

    // Rate-limited fallback write shared by the paused and playing paths.
    // 250ms spacing bounds the write war against site volume managers, but a
    // SKIPPED correction is never dropped: sites reset element.volume on
    // track changes / replays, and if no further media event fires (event
    // starvation — YouTube auto-next in shuffled playlists, Facebook reels
    // replays) the reset volume would stick for seconds or until the user
    // manually moves the slider (issue #71). Schedule the corrective write
    // for the first allowed moment instead.
    function writeFallbackVolume(element, entry, wantedVolume) {
        const now = Date.now();
        if (entry.lastFallbackWriteAt === undefined || now - entry.lastFallbackWriteAt >= 250) {
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
            if (existingRoute) disconnectMediaRouteOutput(existingRoute);

            const nativeVolume = existingRoute
                ? entry.baseVolume
                : Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
            // Same 250ms write-rate limit as the playing fallback below: while
            // paused there is no playback guard against a site volume manager
            // answering every volumechange with its own write, so an
            // unconditional write here can re-ignite the write war the v6.11
            // rate limit extinguished for playing elements.
            writeFallbackVolume(element, entry, nativeVolume);
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
            setNativeVolume(element, entry.baseVolume);
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
        writeFallbackVolume(element, entry, fallbackVolume);
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
                const route = mediaRoutes.get(element);
                if (route) disconnectMediaRouteOutput(route);
                mediaElements.delete(element);
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
            // DRM detection: the moment the pipeline reports encrypted init
            // data, flag the element (sticky) so neither this hook nor the
            // content script ever routes it through WebAudio.
            element.addEventListener("encrypted", () => {
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
            element.addEventListener("timeupdate", () => {
                if (mediaRoutes.has(element)) return;      // already routed
                if (!isPendingEmeSuspect(element)) return; // cheap probe+src gate
                if (elementDrmEvidence(element)) return;   // restricted; events/audit own it
                applyMediaElementState(element);
            }, { passive: true });
            // Keep the aggregate page restriction fresh as this element's
            // lifecycle (src assignment, play, pause, ended) progresses.
            element.addEventListener("loadedmetadata", updatePageMediaRestriction, { passive: true });
            element.addEventListener("play", updatePageMediaRestriction, { passive: true });
            element.addEventListener("emptied", updatePageMediaRestriction, { passive: true });
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
                if (currentEntry.ignoreVolumeEventsUntil > Date.now()) {
                    // Only swallow the echo of OUR OWN write. If the native
                    // volume no longer matches what we last set, the page
                    // changed volume inside our ignore window and that
                    // change must be processed, not ignored.
                    if (currentEntry.lastNativeVolume === undefined ||
                        currentEntry.lastNativeVolume === readNativeVolume(element)) {
                        return;
                    }
                }

                applyMediaElementState(element);
                setTimeout(suspendMediaContextIfIdle, 250);
            };
            const release = () => {
                releaseMediaRoute(element);
                // v6.14: a new source (emptied) or a replay (ended/error)
                // must re-earn its EME decryption proof — the old source's
                // progress says nothing about the next one.
                resetEmePending(element);
                // Do NOT delete from mediaElements. The element is often reused
                // for the next video (e.g. YouTube/Twitch auto-next loads the
                // next source into the SAME <video> element). If we delete here,
                // suspendMediaContextIfIdle's hasAnyRoute check (which iterates
                // mediaElements) won't see the kept route, and it will close
                // mediaAudioContext. Once closed, the route is permanently dead
                // because createMediaElementSource() can only be called ONCE
                // per element per context -- the next video would then play
                // with NO audio because the element's output is piped into a
                // closed context that can never be revived. Keep the element
                // tracked here so the context stays alive (suspended, not
                // closed) and the route can be rewired on replay. Elements
                // that are actually removed from the DOM are cleaned up in
                // applyStateToMediaElements().
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

    // Elements inserted after DOMContentLoaded via innerHTML/insertAdjacentHTML
    // (template rendering, jQuery .html()) never pass through the patched
    // createElement; driven only through native controls, neither the patched
    // play() nor the volume setter ever runs for them — invisible to boost AND
    // to the restriction aggregate. Register any audio/video the moment it
    // enters the (light) DOM so our per-element listeners take over from there.
    function watchForInjectedMediaElements() {
        if (typeof MutationObserver === "undefined") return;
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
                    setNativeVolume(element, getMediaState(element).baseVolume);
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
    patchEmeApi();

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

    // Keep the published page-restriction aggregate fresh. Sources the
    // aggregate depends on (element.src assignment, currentSrc resolution,
    // setMediaKeys landing after claim time) are not all observable through
    // events, so a cheap 1s recompute closes the gaps. mediaElements is
    // tiny (a handful of entries on typical pages).
    //
    // The same tick drives two hardening loops:
    //  1. EME pending gate (v6.14): re-run the routing decision for unrouted
    //     pending suspects. Evaluating the gate also OBSERVES currentTime
    //     (the decryption-proof check), so this is the backup observation
    //     point for elements whose timeupdate events are late or missing —
    //     and it keeps freshly-restricted elements refusing.
    //  2. Fallback audit (issue #71): verify every playing, unrouted,
    //     audible element sits at the fallback volume the extension state
    //     demands. Sites reset video.volume on track changes / replays; if
    //     the corrective write was rate-limited and no further media event
    //     fires, the reset would stick (1-10s of wrong volume on YouTube
    //     auto-next, permanently on Facebook reels until manual action).
    //     The audit bounds any drift to ~1s without needing events.
    setInterval(() => {
        updatePageMediaRestriction();

        for (const element of Array.from(mediaElements)) {
            const entry = mediaState.get(element);
            if (!entry) continue;
            if (mediaRoutes.has(element)) continue;

            // 1. Pending EME suspect: re-run the routing decision (gate
            //    evaluation observes currentTime; restricted elements keep
            //    refusing via their evidence).
            if (isPendingEmeSuspect(element)) {
                applyMediaElementState(element);
                continue;
            }

            // 2. Fallback audit: playing + audible + previously
            //    fallback-managed + native volume drifted from the expected
            //    scaled value → re-apply (rate limit still applies).
            if (entry.lastFallbackWriteAt === undefined) continue;
            if (!isMediaPlaying(element) || !isAudibleMediaElement(element)) continue;
            const gain = effectiveGain();
            const expected = Math.max(0, Math.min(1, entry.baseVolume * Math.min(gain, 1)));
            if (Math.abs(readNativeVolume(element) - expected) > 0.02) {
                applyMediaElementState(element);
            }
        }
    }, 1000);

    // Periodically sweep media elements that have been removed from the DOM.
    // applyStateToMediaElements also does this on state changes, but on pages
    // that create many short-lived <audio>/<video> elements without triggering
    // state changes (e.g. a soundboard that fires many SFX), mediaElements
    // would otherwise accumulate disconnected elements forever -- and each one
    // keeps its (kept-for-replay) route's mediaAudioContext alive.
    // Elements detached while still playing are NOT swept: they are still
    // audible and must keep receiving gain updates (see isDetachedButAudible).
    // They get dropped by applyStateToMediaElements once they pause or end.
    setInterval(() => {
        for (const element of Array.from(mediaElements)) {
            if (!element.isConnected && !isDetachedButAudible(element)) {
                const route = mediaRoutes.get(element);
                if (route) disconnectMediaRouteOutput(route);
                mediaElements.delete(element);
            }
        }
        // After cleaning up dead elements, also try to release the media
        // context if no live elements remain. This mirrors what
        // suspendMediaContextIfIdle does, but is gated on actual DOM
        // presence rather than waiting for a media event that may never
        // come (e.g. an element that was removed while paused).
        setTimeout(suspendMediaContextIfIdle, 0);
    }, 30000);

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

    watchForInjectedMediaElements();

    // A media route context created before any user gesture (autoplay granted
    // via the Media Engagement Index) can be born 'suspended' by the autoplay
    // policy and stay that way — routed media would then be silent. Retry the
    // resume on the first user interaction; resumeContext no-ops once the
    // context is running.
    const resumeMediaContextOnGesture = () => {
        if (mediaAudioContext) resumeContext(mediaAudioContext);
    };
    document.addEventListener("pointerdown", resumeMediaContextOnGesture, { passive: true, capture: true });
    document.addEventListener("keydown", resumeMediaContextOnGesture, { passive: true, capture: true });

    window.addEventListener("message", handleBridgeMessage);
})();
