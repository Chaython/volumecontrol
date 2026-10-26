"use client";

/**
 * Global keyboard shortcuts — the same commands the extension registers in
 * its manifest: Alt+Shift+Up/Down (±1 dB), Alt+Shift+0 (reset), Alt+Shift+M
 * (mono). They work even while the popup is closed, exactly like the real
 * extension's global commands, and update the toolbar badge.
 *
 * background.js handleCommand semantics:
 *  - volume-up/down step from the APPLIED volume (contentState.volume), and
 *    volume-up is guarded at a boost-limited ceiling so a press never
 *    replaces a preserved request with an invisible +1 dB change;
 *  - toggle-mono is ignored while mono is unavailable (DRM/CORS/native).
 */

import { useEffect } from "react";
import { useExtensionStore } from "@/lib/volume-control/store";
import { VolumeEngine } from "@/lib/volume-control/engine";
import { MAX_DB, MIN_DB, normalizeDb } from "@/lib/volume-control/core";

export function useExtensionShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey) return;
      const store = useExtensionStore.getState();
      if (!store.extensionActive) return;

      switch (event.code) {
        case "ArrowUp": {
          event.preventDefault();
          // background.js: "When DRM/CORS restricts playback to native
          // volume, a press at the effective 0 dB ceiling cannot make audio
          // louder. Do not replace a preserved +12 dB request with an
          // invisible +1 dB setting that only takes effect on a later,
          // routable song."
          const cs = VolumeEngine.getInstance().getAudioControlState();
          if (cs.boostLimited && cs.volume >= cs.maxDb) break;
          const next = Math.min(normalizeDb(cs.volume + 1), MAX_DB);
          if (next !== store.requestedDb) store.setVolume(next);
          break;
        }
        case "ArrowDown": {
          event.preventDefault();
          // background.js steps down from the applied volume, unguarded.
          const cs = VolumeEngine.getInstance().getAudioControlState();
          const nextDown = Math.max(normalizeDb(cs.volume - 1), MIN_DB);
          if (nextDown !== store.requestedDb) store.setVolume(nextDown);
          break;
        }
        case "Digit0":
        case "Numpad0": {
          event.preventDefault();
          store.setVolume(0);
          break;
        }
        case "KeyM": {
          event.preventDefault();
          // background.js toggle-mono: only when mono is available.
          const cs = VolumeEngine.getInstance().getAudioControlState();
          if (cs.monoAvailable !== false) store.toggleMono();
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
