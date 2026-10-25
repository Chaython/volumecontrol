"use client";

/**
 * Global keyboard shortcuts — the same commands the extension registers in
 * its manifest: Alt+Shift+Up/Down (±1 dB), Alt+Shift+0 (reset), Alt+Shift+M
 * (mono). They work even while the popup is closed, exactly like the real
 * extension's global commands, and update the toolbar badge.
 */

import { useEffect } from "react";
import { useExtensionStore } from "@/lib/volume-control/store";
import { MAX_DB, MIN_DB } from "@/lib/volume-control/core";

export function useExtensionShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey) return;
      const store = useExtensionStore.getState();
      if (!store.extensionActive) return;

      switch (event.code) {
        case "ArrowUp": {
          event.preventDefault();
          const next = Math.min(store.requestedDb + 1, MAX_DB);
          // The real extension suppresses +1 when boost-limited at the ceiling
          // so there is no invisible change that only applies later.
          if (next !== store.requestedDb) store.setVolume(next);
          break;
        }
        case "ArrowDown": {
          event.preventDefault();
          const nextDown = Math.max(store.requestedDb - 1, MIN_DB);
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
          store.toggleMono();
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
