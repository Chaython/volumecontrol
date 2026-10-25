"use client";

/**
 * ExtensionPopup — a React replica of the extension's popup.html/popup.js.
 * The markup mirrors popup.html element-for-element and the CSS is the
 * extension's own popup.css (ported to popup.css next to this file).
 * Every control drives the ported VolumeEngine through the extension store —
 * this is the real audio processing, not a mock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useExtensionStore, effectiveRestricted } from "@/lib/volume-control/store";
import { VolumeEngine } from "@/lib/volume-control/engine";
import {
  MIN_DB,
  MAX_DB,
  normalizeDb,
  formatMeterDb,
} from "@/lib/volume-control/core";
import type { MeterState } from "@/lib/volume-control/types";
import "./popup.css";

const WHEEL_STEP_DB = 1;

function parseDbText(value: string): number | null {
  const raw = String(value ?? "").trim();
  if (!/^[+-]?\d+$/.test(raw)) return null;
  return normalizeDb(Number(raw));
}

export function ExtensionPopup({
  onOpenSettings,
  browserDark,
}: {
  onOpenSettings: () => void;
  browserDark: boolean;
}) {
  const site = useExtensionStore((s) => s.site);
  const requestedDb = useExtensionStore((s) => s.requestedDb);
  const dB = useExtensionStore((s) => s.dB);
  const muted = useExtensionStore((s) => s.muted);
  const mono = useExtensionStore((s) => s.mono);
  const normalizerEnabled = useExtensionStore((s) => s.normalizerEnabled);
  const extensionActive = useExtensionStore((s) => s.extensionActive);
  const remembered = useExtensionStore((s) => s.remembered[s.site.key]);
  // The popup mirrors the ENGINE verdict (cs.js pageRestrictionChanged
  // semantics), not the raw simulation flag — the debug "Force DRM Audio
  // Capture" override (global or per-site) lifts the restriction live.
  const restricted = useExtensionStore((s) => effectiveRestricted(s, s.site.key));
  const setVolume = useExtensionStore((s) => s.setVolume);
  const toggleMute = useExtensionStore((s) => s.toggleMute);
  const toggleMono = useExtensionStore((s) => s.toggleMono);
  const toggleNormalizer = useExtensionStore((s) => s.toggleNormalizer);
  const toggleRemember = useExtensionStore((s) => s.toggleRemember);
  const toggleActive = useExtensionStore((s) => s.toggleActive);
  const closePopup = useExtensionStore((s) => s.closePopup);

  const maxDb = restricted ? 0 : MAX_DB;
  const boostLimited = restricted;
  const monoAvailable = !restricted;
  const normalizerAvailable = !restricted;
  const siteRemembered = Boolean(remembered);

  // --- displayed volume (slider + text). Derived from the store like
  // popup.js setDisplayedVolume — clamped to the current boost limit.
  const [textValue, setTextValue] = useState<string | null>(null);
  const [editingText, setEditingText] = useState(false);
  const textDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelRemainder = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);

  const displayDb = Math.min(requestedDb, maxDb);

  const commitVolume = useCallback((value: number) => {
    const clamped = Math.min(normalizeDb(value), maxDb);
    setVolume(clamped);
  }, [maxDb, setVolume]);

  // --- slider ---------------------------------------------------------------
  const handleSliderInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(Number(event.target.value));
  };

  // --- dB text input (300 ms debounce, change commits — popup.js) -----------
  const commitText = useCallback((raw: string) => {
    const parsed = parseDbText(raw);
    if (parsed !== null) commitVolume(parsed);
  }, [commitVolume]);

  const handleTextInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setTextValue(raw);
    setEditingText(true);
    if (textDebounce.current) clearTimeout(textDebounce.current);
    textDebounce.current = setTimeout(() => commitText(raw), 300);
  };

  const handleTextCommit = (event: React.FocusEvent<HTMLInputElement>) => {
    if (textDebounce.current) clearTimeout(textDebounce.current);
    const raw = event.target.value;
    commitText(raw);
    setEditingText(false);
    setTextValue(null);
  };

  const handleTextKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // stopPropagation so arrow keys edit the number instead of the slider.
    event.stopPropagation();
    if (event.key === "Enter") {
      if (textDebounce.current) clearTimeout(textDebounce.current);
      commitText((event.target as HTMLInputElement).value);
      setEditingText(false);
      setTextValue(null);
    }
  };

  // --- mouse wheel (1 dB per notch, sub-notch accumulation — popup.js) ------
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement && (document.activeElement as HTMLElement).id === "volume-text") return;
      const delta = Number(e.deltaY) *
        (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1);
      if (!Number.isFinite(delta) || delta === 0) return;
      let adjustment = delta;
      if (Math.abs(delta) >= 15) {
        wheelRemainder.current = 0;
      } else {
        if (wheelRemainder.current && Math.sign(delta) !== Math.sign(wheelRemainder.current)) {
          wheelRemainder.current = 0;
        }
        wheelRemainder.current += delta;
        if (Math.abs(wheelRemainder.current) < 15) return;
        adjustment = wheelRemainder.current;
        wheelRemainder.current -= Math.sign(wheelRemainder.current) * 15;
      }
      const currentDb = sliderRef.current ? Number(sliderRef.current.value) : 0;
      const direction = adjustment > 0 ? -1 : 1;
      const nextDb = Math.min(normalizeDb(currentDb + direction * WHEEL_STEP_DB), maxDb);
      if (nextDb === currentDb) return;
      e.preventDefault();
      commitVolume(nextDb);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [commitVolume, maxDb]);

  // Focus the slider when the popup opens (popup.js does this on first keydown,
  // Chrome focuses popups automatically — we do it directly for parity).
  useEffect(() => {
    sliderRef.current?.focus({ preventScroll: true });
  }, []);

  // --- normalizer meter (engine 100 ms sampler → popup 125 ms poll) ---------
  const [meter, setMeter] = useState<MeterState>({ peakDb: -Infinity, normalizerGainDb: 0 });
  useEffect(() => {
    const engine = VolumeEngine.getInstance();
    let last = 0;
    return engine.onMeter((m) => {
      const now = Date.now();
      if (now - last >= 125) {
        last = now;
        setMeter(m);
      }
    });
  }, []);

  const meterPercent = useMemo(() => {
    const peakDb = Number.isFinite(meter.peakDb) ? meter.peakDb : -Infinity;
    const clampedPeak = Number.isFinite(peakDb) ? Math.max(-60, Math.min(0, peakDb)) : -60;
    return ((clampedPeak + 60) / 60) * 100;
  }, [meter.peakDb]);

  const peakDb = meter.peakDb;
  const gainText = (() => {
    const shown = Number.isFinite(meter.normalizerGainDb) ? meter.normalizerGainDb : 0;
    return `Gain ${shown >= 0 ? "+" : ""}${shown.toFixed(1)} dB`;
  })();

  const showPeakWarning = normalizerEnabled && normalizerAvailable &&
    Number.isFinite(peakDb) && peakDb >= -0.3;
  const detailsVisible = normalizerEnabled && normalizerAvailable;

  const normalizerNote = normalizerAvailable
    ? ""
    : "Normalize cannot process DRM-protected audio in this browser.";

  const monoTooltip = monoAvailable
    ? "Toggle Mono Audio"
    : "Mono unavailable while DRM/restricted media is using fallback audio.";

  return (
    <div className="vc-popup-anchor">
      <div
        ref={rootRef}
        className={`vc-popup ${browserDark ? "vc-popup-dark" : ""}`}
        role="dialog"
        aria-label="Volume Control popup"
      >
        <div
          id="popup-content"
          className={`${!extensionActive ? "excluded-site" : ""} ${muted ? "is-muted" : ""}`}
        >
          <div className={`exclusion-message ${extensionActive ? "hidden" : ""}`}>
            <div className="exclusion-title">Volume Control is disabled for this site.</div>
            <div className="exclusion-detail">
              {site.url} was added to the blocked sites list. Remove it from Settings to
              reactivate.
            </div>
          </div>

          <div className="top-controls">
            <input
              ref={sliderRef}
              type="range"
              id="volume-slider"
              value={displayDb}
              min={MIN_DB}
              max={maxDb}
              step={1}
              aria-label="Volume control"
              aria-describedby="volume-limit-note volume-boost-warning"
              title="Volume control (Alt+Shift+↑/↓ to adjust)"
              onChange={handleSliderInput}
              disabled={!extensionActive}
              style={{ ["--vc-range-steps" as string]: String(Math.max(1, maxDb - MIN_DB)) }}
            />
            <p id="volume-limit-note" className={`volume-limit-note ${boostLimited && extensionActive ? "" : "hidden"}`} role="status">
              Boosting, mono, and Normalize may be unavailable on DRM/CORS-restricted media because the browser only allows fallback volume control. You can still lower volume and mute.
            </p>
            <p id="volume-boost-warning" className={`volume-limit-note ${displayDb >= 6 ? "" : "hidden"}`} role="note">
              Large positive volume boosts can distort loud audio; the compressor is not a guaranteed true-peak limiter.
            </p>
            <div className="volume-row">
              <button
                id="mute-btn"
                className={`mute-btn ${muted ? "muted" : ""}`}
                title="Mute/Unmute"
                aria-label="Mute or unmute audio"
                aria-pressed={muted}
                onClick={toggleMute}
                disabled={!extensionActive}
              >
                <svg className="mute-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path className="speaker-shape" d="M3 9v6h4l5 5V4L7 9H3z" />
                  <path className="wave-shape" d="M14 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path className="wave-shape" d="M16.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line className="mute-x" x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
                <span className="mute-label">{muted ? "Unmute" : "Mute"}</span>
              </button>
              <span className="volume-display">
                <input
                  type="text"
                  id="volume-text"
                  value={editingText && textValue !== null
                    ? textValue
                    : (displayDb >= 0 ? `+${displayDb}` : String(displayDb))}
                  inputMode="numeric"
                  aria-label="Volume in decibels"
                  onChange={handleTextInput}
                  onBlur={handleTextCommit}
                  onKeyDown={handleTextKeyDown}
                  disabled={!extensionActive}
                />
                <span className="volume-unit" aria-hidden="true">dB</span>
              </span>
            </div>

            <div className={`normalizer-panel ${normalizerAvailable ? "" : "is-unavailable"}`}>
              <div className="normalizer-header">
                <label
                  className="switch-container normalizer-switch"
                  htmlFor="normalizer-checkbox"
                  title={normalizerAvailable
                    ? "Automatically even out loud and quiet audio"
                    : `${normalizerNote} Your saved Normalize preference will resume when supported audio plays.`}
                >
                  <div className="switch">
                    <input
                      type="checkbox"
                      id="normalizer-checkbox"
                      checked={normalizerEnabled}
                      disabled={!normalizerAvailable || !extensionActive}
                      onChange={toggleNormalizer}
                    />
                    <span className="slider"></span>
                  </div>
                  <span className="label-text">Normalize</span>
                </label>
              </div>
              <p id="normalizer-note" className={`normalizer-note ${normalizerAvailable ? "hidden" : ""}`} role="status">
                {normalizerNote}
              </p>
              <div id="normalizer-details" className="normalizer-details" hidden={!detailsVisible}>
                <div className="normalizer-detail-header">
                  <span id="normalizer-gain" className="normalizer-gain" aria-live="polite">
                    {gainText}
                  </span>
                </div>
                <div className="peak-meter-row">
                  <div
                    className="peak-meter"
                    role="meter"
                    aria-label="Output peak level"
                    aria-valuemin={-60}
                    aria-valuemax={0}
                    aria-valuenow={Number(Math.max(-60, Math.min(0, Number.isFinite(peakDb) ? peakDb : -60)).toFixed(1))}
                  >
                    <div id="peak-meter-fill" className="peak-meter-fill" style={{ width: `${meterPercent.toFixed(2)}%` }}></div>
                    <div className="peak-meter-ceiling" title="−1 dBFS reference mark, not a hard ceiling"></div>
                  </div>
                  <span id="peak-meter-text" className="peak-meter-text">{formatMeterDb(peakDb)}</span>
                </div>
                <p id="peak-safety-warning" className={`normalizer-note ${showPeakWarning ? "" : "hidden"}`} role="note">
                  Output sample peaks are near digital full scale. Inter-sample peaks may be higher; lower manual boost if you hear distortion.
                </p>
              </div>
            </div>
          </div>

          <div className="bot-controls">
            <div className="left">
              <label
                className={`switch-container ${monoAvailable ? "" : "is-disabled"}`}
                htmlFor="mono-checkbox"
                title={monoTooltip}
              >
                <div className="switch">
                  <input
                    type="checkbox"
                    id="mono-checkbox"
                    checked={mono}
                    disabled={!monoAvailable || !extensionActive}
                    onChange={toggleMono}
                  />
                  <span className="slider"></span>
                </div>
                <span className="label-text">Mono</span>
              </label>

              <label className="switch-container" htmlFor="remember-checkbox" title="Remember volume for this site">
                <div className="switch">
                  <input
                    type="checkbox"
                    id="remember-checkbox"
                    checked={siteRemembered}
                    onChange={() => void toggleRemember()}
                  />
                  <span className="slider"></span>
                </div>
                <span className="label-text">Remember</span>
              </label>
            </div>

            <div className="right">
              <label className="switch-container" htmlFor="enable-checkbox" title="Enable/Disable on this site">
                <div className="switch">
                  <input
                    type="checkbox"
                    id="enable-checkbox"
                    checked={extensionActive}
                    onChange={toggleActive}
                  />
                  <span className="slider"></span>
                </div>
                <span className="label-text">Active</span>
              </label>

              <button id="settings" className="settings" aria-label="Open settings" onClick={onOpenSettings}>
                Settings
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
