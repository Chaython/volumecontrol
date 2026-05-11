(() => {
    const HOOK_KEY = "__volumeControlPageAudioHook";
    const BRIDGE_SOURCE = "volume-control-extension";
    const BRIDGE_TARGET = "volume-control-page-audio";

    if (window[HOOK_KEY] && window[HOOK_KEY].installed) return;

    const state = {
        enabled: true,
        dB: 0,
        mono: false,
        debugMode: false
    };

    const graphs = new WeakMap();
    const contexts = new Set();
    const vcNodes = new WeakSet();
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

    function getGainValue(dB) {
        const n = Number(dB);
        if (Number.isNaN(n)) return 1.0;
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

    function suspendMediaContextIfIdle() {
        if (!mediaAudioContext || mediaAudioContext.state !== "running") return;

        for (const element of Array.from(mediaElements)) {
            if (mediaRoutes.has(element) && isMediaPlaying(element) && isAudibleMediaElement(element)) {
                return;
            }
        }

        try {
            if (typeof mediaAudioContext.suspend === "function") {
                mediaAudioContext.suspend();
            }
        } catch (e) {
            log(`media context suspend failed: ${e && e.message}`);
        }
    }

    function setGainValue(graph) {
        const targetGain = state.enabled ? getGainValue(state.dB) : 1.0;
        try {
            const now = graph.context.currentTime;
            graph.gain.gain.value = targetGain;
            if (graph.context.state === "running") {
                graph.gain.gain.cancelScheduledValues(now);
                graph.gain.gain.setValueAtTime(targetGain, now);
            }
        } catch (e) {
            log(`gain update failed: ${e && e.message}`);
        }
    }

    function wireGraph(graph) {
        setGainValue(graph);

        safeDisconnect(graph.gain);
        safeDisconnect(graph.splitter);
        safeDisconnect(graph.leftGain);
        safeDisconnect(graph.rightGain);
        safeDisconnect(graph.merger);

        try {
            if (state.enabled && state.mono) {
                connectNative(graph.gain, graph.splitter);
                connectNative(graph.splitter, graph.leftGain, 0);
                connectNative(graph.splitter, graph.rightGain, 1);

                connectNative(graph.leftGain, graph.merger, 0, 0);
                connectNative(graph.rightGain, graph.merger, 0, 0);
                connectNative(graph.leftGain, graph.merger, 0, 1);
                connectNative(graph.rightGain, graph.merger, 0, 1);
                connectNative(graph.merger, graph.context.destination);
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

            const graph = { context, gain, splitter, leftGain, rightGain, merger };
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
                listenersInstalled: false
            };
            mediaState.set(element, entry);
        }
        return entry;
    }

    function mediaNeedsAudioRoute() {
        return state.enabled && (state.mono || getGainValue(state.dB) > 1);
    }

    function wireMediaRoute(route) {
        const targetGain = state.enabled ? getGainValue(state.dB) : 1.0;

        try {
            const now = route.context.currentTime;
            route.gain.gain.value = targetGain;
            if (route.context.state === "running") {
                route.gain.gain.cancelScheduledValues(now);
                route.gain.gain.setValueAtTime(targetGain, now);
            }
        } catch (e) {
            log(`media gain update failed: ${e && e.message}`);
        }

        safeDisconnect(route.gain);
        safeDisconnect(route.splitter);
        safeDisconnect(route.leftGain);
        safeDisconnect(route.rightGain);
        safeDisconnect(route.merger);

        try {
            if (state.enabled && state.mono) {
                connectNative(route.gain, route.splitter);
                connectNative(route.splitter, route.leftGain, 0);
                connectNative(route.splitter, route.rightGain, 1);

                connectNative(route.leftGain, route.merger, 0, 0);
                connectNative(route.rightGain, route.merger, 0, 0);
                connectNative(route.leftGain, route.merger, 0, 1);
                connectNative(route.rightGain, route.merger, 0, 1);
                connectNative(route.merger, route.context.destination);
            } else {
                connectNative(route.gain, route.context.destination);
            }
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
            const source = markNode(context.createMediaElementSource(element));
            const gain = markNode(context.createGain());
            const splitter = markNode(context.createChannelSplitter(2));
            const leftGain = markNode(context.createGain());
            const rightGain = markNode(context.createGain());
            const merger = markNode(context.createChannelMerger(2));

            gain.channelInterpretation = "speakers";
            leftGain.gain.value = 0.5;
            rightGain.gain.value = 0.5;
            connectNative(source, gain);

            const route = { context, source, gain, splitter, leftGain, rightGain, merger };
            mediaRoutes.set(element, route);
            wireMediaRoute(route);
            log(`media route attached: ${element.currentSrc || element.src || element.tagName}`);
            return route;
        } catch (e) {
            log(`media route failed: ${e && e.message}`);
            return null;
        }
    }

    function applyMediaElementState(element, options = {}) {
        if (!isMediaElement(element)) return;

        const entry = getMediaState(element);
        const gain = state.enabled ? getGainValue(state.dB) : 1.0;
        const shouldUseRoute = Boolean(
            mediaRoutes.has(element) ||
            options.forceRoute ||
            isMediaPlaying(element)
        );
        const route = shouldUseRoute ? (mediaRoutes.get(element) || ensureMediaRoute(element)) : null;

        if (route) {
            setNativeVolume(element, entry.baseVolume);
            wireMediaRoute(route);
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

        mediaElements.add(element);
        const entry = getMediaState(element);
        if (!entry.listenersInstalled && typeof element.addEventListener === "function") {
            const applyOnPlay = () => {
                applyMediaElementState(element, { forceRoute: true });
                resumeContext(mediaAudioContext);
            };
            const suspendWhenIdle = () => setTimeout(suspendMediaContextIfIdle, 250);
            const release = () => {
                mediaElements.delete(element);
                suspendWhenIdle();
            };

            element.addEventListener("play", applyOnPlay, { passive: true });
            element.addEventListener("playing", applyOnPlay, { passive: true });
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
                const graph = ensureGraph(this.context || destination.context);
                if (graph) {
                    connectNative(this, graph.gain, outputIndex, 0);
                    return destination;
                }
            }

            return nativeConnect.apply(this, arguments);
        };

        if (nativeDisconnect) {
            AudioNodePrototype.disconnect = function patchedDisconnect(destination) {
                if (isContextDestination(destination) && !vcNodes.has(this)) {
                    const graph = graphs.get(this.context || destination.context);
                    if (graph) {
                        const args = Array.prototype.slice.call(arguments);
                        args[0] = graph.gain;
                        return nativeDisconnect.apply(this, args);
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
            registerMediaElement(this, { forceRoute: true });
            resumeContext(mediaAudioContext);
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

    function installMediaObserver() {
        if (!window.MutationObserver || !document.documentElement) return;

        try {
            const observer = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (isMediaElement(node)) registerMediaElement(node);
                        else if (node && node.querySelectorAll) scanMediaElements(node);
                    }
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {
            log(`media observer failed: ${e && e.message}`);
        }
    }

    function handleBridgeMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE || data.target !== BRIDGE_TARGET) return;
        if (data.command !== "setState") return;

        state.enabled = data.enabled !== false;
        state.dB = Number(data.dB) || 0;
        state.mono = Boolean(data.mono);
        state.debugMode = Boolean(data.debugMode);

        applyStateToGraphs();
        applyStateToMediaElements();
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

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            scanMediaElements(document);
            installMediaObserver();
        }, { once: true });
    } else {
        scanMediaElements(document);
        installMediaObserver();
    }

    window.addEventListener("message", handleBridgeMessage);
})();
