"use client";

/**
 * OptionsPage — a 1:1 replica of the extension's options.html, rendered as a
 * full tab inside the mock browser (the real extension opens options.html in
 * a tab — manifest options_ui.open_in_tab). The markup mirrors options.html
 * element-for-element and the CSS is the extension's own options.css (ported
 * to options.css next to this file). Every section drives the live preview's
 * store — the web equivalent of chrome.storage + storage.onChanged.
 *
 * Behavior ported from options.js: whitelist-mode label swap, inline
 * "already in list" status (4 s auto-dismiss), remembered-entry rows with
 * formatted volume editing (+3 dB ↔ numeric), rename-on-blur, the collapsed
 * normalizer details behind the master switch, change-committed number
 * fields with normalizeNormalizerConfig clamping, keycap shortcut rendering,
 * and the shortcuts-page fallback alert.
 */

import { useEffect, useRef, useState } from "react";
import {
  useExtensionStore,
  type RememberedEntry,
  type SiteDebugOverrides,
} from "@/lib/volume-control/store";
import {
  normalizeDb,
  normalizeNormalizerConfig,
  formatDb,
} from "@/lib/volume-control/core";
import type { NormalizerConfig } from "@/lib/volume-control/types";
import "./options.css";

/* ------------------------------------------------------------------ */
/* Input normalizers — shared.js parseSiteLikeInput /                   */
/* normalizeSiteSettingsEntryInput / normalizeBlocklistEntryInput.      */
/* Protocol, credentials, port and "www." are stripped; paths are kept  */
/* (wildcards allowed); a trailing "/" is trimmed.                      */
/* ------------------------------------------------------------------ */

function parseSiteLikeInput(value: string): { domain: string; path: string; query: string } | null {
  let raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (/^file:\/\//.test(raw) || raw === "file") return { domain: "file", path: "", query: "" };
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  raw = raw.replace(/^[^/@]+@/, ""); // credentials
  const hashIndex = raw.indexOf("#");
  if (hashIndex !== -1) raw = raw.slice(0, hashIndex);
  let query = "";
  const queryIndex = raw.indexOf("?");
  if (queryIndex !== -1) {
    query = raw.slice(queryIndex + 1);
    raw = raw.slice(0, queryIndex);
  }
  let domain = raw.split("/")[0] ?? "";
  domain = domain.replace(/:\d+$/, ""); // port
  domain = domain.replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) return null;
  if (!domain.includes(".") && domain !== "localhost") return null;
  let path = raw.slice(domain.length);
  path = path.replace(/\/+$/, "");
  return { domain, path, query };
}

function normalizeSiteSettingsEntryInput(value: string, options: { includeQuery?: boolean } = {}): string {
  const parsed = parseSiteLikeInput(value);
  if (!parsed) return "";
  if (parsed.domain === "file") return "file";
  const query = options.includeQuery && parsed.query ? `?${parsed.query}` : "";
  return parsed.domain + parsed.path + query;
}

function normalizeBlocklistEntryInput(value: string): string {
  return normalizeSiteSettingsEntryInput(value);
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts — chrome.commands.getAll() for this extension.    */
/* ------------------------------------------------------------------ */

interface CommandInfo {
  name: string;
  description: string;
  shortcut: string;
}

const COMMANDS: CommandInfo[] = [
  { name: "_execute_action", description: "Open volume control", shortcut: "" },
  { name: "volume-up", description: "Increase volume by 1 dB", shortcut: "Alt+Shift+Up" },
  { name: "volume-down", description: "Decrease volume by 1 dB", shortcut: "Alt+Shift+Down" },
  { name: "volume-reset", description: "Reset volume to 0 dB", shortcut: "Alt+Shift+0" },
  { name: "toggle-mono", description: "Toggle mono audio", shortcut: "Alt+Shift+M" },
  { name: "toggle-mute", description: "Toggle mute", shortcut: "" },
];

/* ------------------------------------------------------------------ */
/* Normalizer number field — commits on `change` (blur/Enter), like     */
/* options.js; the committed value is re-clamped through                */
/* normalizeNormalizerConfig.                                           */
/* ------------------------------------------------------------------ */

function NormalizerNumberField({
  id,
  label,
  unit,
  min,
  max,
  step,
  inputMode,
  value,
  disabled,
  title,
  onCommitRaw,
}: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  inputMode: "decimal" | "numeric";
  value: number;
  disabled?: boolean;
  title?: string;
  onCommitRaw: (raw: string) => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const shown = edit !== null ? edit : String(value);

  const commit = () => {
    if (edit === null) return;
    onCommitRaw(edit);
    setEdit(null);
  };

  return (
    <label htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        inputMode={inputMode}
        value={shown}
        disabled={disabled}
        title={title}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span className="setting-unit">{unit}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Remembered-settings row — options.js createMemoryEntry.              */
/* ------------------------------------------------------------------ */

function RememberedRow({
  domain,
  entry,
  onRemove,
  onUpdate,
  onRename,
}: {
  domain: string;
  entry: RememberedEntry;
  onRemove: (domain: string) => void;
  onUpdate: (domain: string, patch: Partial<RememberedEntry>) => void;
  onRename: (oldDomain: string, newDomain: string) => void;
}) {
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [volEdit, setVolEdit] = useState<string | null>(null);

  const commitRename = () => {
    if (nameEdit === null) return;
    const newName = normalizeSiteSettingsEntryInput(nameEdit, { includeQuery: true });
    if (!newName) {
      window.alert("Site cannot be empty.");
      setNameEdit(null);
      return;
    }
    if (newName !== domain) onRename(domain, newName);
    setNameEdit(null);
  };

  const commitVol = () => {
    if (volEdit === null) return;
    const raw = volEdit.trim();
    const v = raw ? Number(raw) : NaN;
    const numeric = Number.isFinite(v) ? normalizeDb(v) : entry.volume;
    setVolEdit(null);
    if (numeric !== entry.volume) {
      onUpdate(domain, {
        volume: numeric,
        mono: entry.mono,
        muted: entry.muted,
      });
    }
  };

  return (
    <div className="list-entry">
      <input
        type="text"
        className="domain-input"
        value={nameEdit !== null ? nameEdit : domain}
        title="Edit site"
        aria-label="Edit remembered site"
        onChange={(e) => setNameEdit(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <div className="controls-container">
        <div className="setting-group">
          <span>Vol</span>
          <input
            type="text"
            className="vol-input"
            value={volEdit !== null ? volEdit : formatDb(entry.volume)}
            onChange={(e) => setVolEdit(e.target.value)}
            onFocus={(e) => {
              setVolEdit(String(entry.volume));
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={commitVol}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <label className="mono-label">
            <input
              type="checkbox"
              checked={entry.mono}
              onChange={() => onUpdate(domain, { volume: entry.volume, mono: !entry.mono, muted: entry.muted })}
            />
            <span>Mono</span>
          </label>
          <label className="mono-label">
            <input
              type="checkbox"
              checked={entry.muted}
              onChange={() => onUpdate(domain, { volume: entry.volume, mono: entry.mono, muted: !entry.muted })}
            />
            <span>Mute</span>
          </label>
        </div>
        <button
          type="button"
          className="remove-btn"
          title="Remove remembered settings"
          onClick={() => onRemove(domain)}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Site-debug-override row — options.js createDebugEntry.               */
/* ------------------------------------------------------------------ */

function DebugRow({
  domain,
  value,
  onRemove,
  onUpdate,
  onRename,
}: {
  domain: string;
  value: SiteDebugOverrides;
  onRemove: (domain: string) => void;
  onUpdate: (domain: string, patch: Partial<SiteDebugOverrides>) => void;
  onRename: (oldDomain: string, newDomain: string) => void;
}) {
  const [nameEdit, setNameEdit] = useState<string | null>(null);

  const commitRename = () => {
    if (nameEdit === null) return;
    const newName = normalizeSiteSettingsEntryInput(nameEdit, { includeQuery: true });
    if (!newName) {
      window.alert("Site cannot be empty.");
      setNameEdit(null);
      return;
    }
    if (newName !== domain) onRename(domain, newName);
    setNameEdit(null);
  };

  const commit = (patch: Partial<SiteDebugOverrides>) => onUpdate(domain, patch);

  return (
    <div className="list-entry">
      <input
        type="text"
        className="domain-input"
        value={nameEdit !== null ? nameEdit : domain}
        title="Edit site debug override"
        aria-label="Edit site debug override"
        onChange={(e) => setNameEdit(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <div className="controls-container">
        <div className="setting-group site-debug-group">
          <label className="mono-label site-debug-option" title="Show debug borders on media elements for this site">
            <input
              type="checkbox"
              checked={value.debugMode}
              onChange={() => commit({ debugMode: !value.debugMode })}
            />
            <span>Highlight</span>
          </label>
          <label className="mono-label site-debug-option" title="Force DRM/EME audio capture for this site (dangerous)">
            <input
              type="checkbox"
              checked={value.forceDrmCapture}
              onChange={() => commit({ forceDrmCapture: !value.forceDrmCapture })}
            />
            <span>DRM</span>
          </label>
          <label className="mono-label site-debug-option" title="Skip the cross-origin media guard for this site (dangerous)">
            <input
              type="checkbox"
              checked={value.forceCorsCapture}
              onChange={() => commit({ forceCorsCapture: !value.forceCorsCapture })}
            />
            <span>CORS</span>
          </label>
          <select
            className="site-debug-route"
            title="HTML media route override for this site"
            value={value.debugRouteMode}
            onChange={(e) => commit({ debugRouteMode: e.target.value as SiteDebugOverrides["debugRouteMode"] })}
          >
            <option value="auto">Route: Auto</option>
            <option value="webaudio">Route: WebAudio</option>
            <option value="native">Route: Native</option>
          </select>
        </div>
        <button
          type="button"
          className="remove-btn"
          title="Remove site debug override"
          onClick={() => onRemove(domain)}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The options page.                                                    */
/* ------------------------------------------------------------------ */

export function OptionsPage({ browserDark }: { browserDark: boolean }) {
  // Access lists
  const blocklist = useExtensionStore((s) => s.blocklist);
  const whitelist = useExtensionStore((s) => s.whitelist);
  const whitelistMode = useExtensionStore((s) => s.whitelistMode);
  const setWhitelistMode = useExtensionStore((s) => s.setWhitelistMode);
  const addAccessEntry = useExtensionStore((s) => s.addAccessEntry);
  const removeAccessEntry = useExtensionStore((s) => s.removeAccessEntry);

  // Remembered settings
  const rememberedSettings = useExtensionStore((s) => s.rememberedSettings);
  const addRememberedEntry = useExtensionStore((s) => s.addRememberedEntry);
  const removeRememberedEntry = useExtensionStore((s) => s.removeRememberedEntry);
  const renameRememberedEntry = useExtensionStore((s) => s.renameRememberedEntry);
  const updateRememberedEntry = useExtensionStore((s) => s.updateRememberedEntry);

  // Site debug overrides
  const siteDebug = useExtensionStore((s) => s.siteDebug);
  const addSiteDebugEntry = useExtensionStore((s) => s.addSiteDebugEntry);
  const removeSiteDebugEntry = useExtensionStore((s) => s.removeSiteDebugEntry);
  const renameSiteDebugEntry = useExtensionStore((s) => s.renameSiteDebugEntry);
  const updateSiteDebugEntry = useExtensionStore((s) => s.updateSiteDebugEntry);

  // Global debug defaults
  const debugDefaults = useExtensionStore((s) => s.debugDefaults);
  const setDebugDefaults = useExtensionStore((s) => s.setDebugDefaults);

  // Normalizer
  const config = useExtensionStore((s) => s.normalizerConfig);
  const defaultEnabled = useExtensionStore((s) => s.normalizerDefaultEnabled);
  const setNormalizerConfig = useExtensionStore((s) => s.setNormalizerConfig);
  const setNormalizerDefaultEnabled = useExtensionStore((s) => s.setNormalizerDefaultEnabled);

  const [newFqdn, setNewFqdn] = useState("");
  const [newRememberedSite, setNewRememberedSite] = useState("");
  const [newDebugSite, setNewDebugSite] = useState("");
  const [fqdnStatus, setFqdnStatus] = useState("");
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
  }, []);

  const showStatus = (text: string) => {
    setFqdnStatus(text);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setFqdnStatus(""), 4000);
  };

  const accessList = whitelistMode ? whitelist : blocklist;

  const addFqdn = () => {
    const v = whitelistMode
      ? normalizeSiteSettingsEntryInput(newFqdn, { includeQuery: true })
      : normalizeBlocklistEntryInput(newFqdn);
    if (!v) return;
    const result = addAccessEntry(v);
    if (!result.ok) {
      showStatus(`"${v}" is already in your ${whitelistMode ? "whitelist" : "blocklist"}.`);
      return;
    }
    setNewFqdn("");
  };

  const addRemembered = () => {
    const v = normalizeSiteSettingsEntryInput(newRememberedSite, { includeQuery: true });
    if (!v) return;
    const result = addRememberedEntry(v);
    if (!result.ok) {
      window.alert("A remembered entry for that site/path already exists.");
      return;
    }
    setNewRememberedSite("");
  };

  const addDebugSite = () => {
    const v = normalizeSiteSettingsEntryInput(newDebugSite, { includeQuery: true });
    if (!v) return;
    const result = addSiteDebugEntry(v);
    if (!result.ok) {
      window.alert("A debug override for that site/path already exists.");
      return;
    }
    setNewDebugSite("");
  };

  /** options.js saveNormalizerConfig — build the full config from the raw
   *  field value (empty → that field's default), clamp, store, re-apply. */
  const commitNormalizerField = (field: keyof NormalizerConfig, raw: string) => {
    const trimmed = raw.trim();
    const patch: Partial<NormalizerConfig> = {};
    if (trimmed === "") {
      // numberOr(): an emptied field falls back to the extension default.
      const defaults = normalizeNormalizerConfig(null);
      (patch as Record<string, unknown>)[field] = defaults[field];
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return; // invalid text keeps the previous value
      (patch as Record<string, unknown>)[field] = n;
    }
    setNormalizerConfig(normalizeNormalizerConfig({ ...config, ...patch }));
  };

  const openShortcutsPage = () => {
    // A web page cannot open chrome://extensions/shortcuts — this is the
    // exact fallback options.js uses when the browser refuses.
    window.alert(
      "Could not open the shortcut settings page automatically. Please open your browser's extension shortcut settings manually.",
    );
  };

  const musicMode = config.mode === "music";

  return (
    <div className={`vc-options ${browserDark ? "vc-options-dark" : ""}`}>
      <h2>Settings</h2>

      <div className="toggle-box">
        <label>
          <input
            type="checkbox"
            id="whitelistMode"
            checked={whitelistMode}
            onChange={(e) => setWhitelistMode(e.target.checked)}
          />
          Enable Whitelist Mode
        </label>
        <span className="hint">
          <strong>Checked:</strong> Extension ONLY runs on sites in the Allowed Sites list below. Whitelist authorization is independent from Remembered Settings, so you can allow a site without sharing its saved volume between tabs. Enabling whitelist mode archives your current blocklist so it can be restored later.<br />
          <strong>Unchecked:</strong> Extension runs everywhere EXCEPT sites in the Blocked Sites list below.
        </span>
      </div>

      <h3 id="listTitle">{whitelistMode ? "Allowed Sites" : "Blocked Sites"}</h3>
      <div className="input-group">
        <input
          type="text"
          id="newFqdn"
          placeholder="example.com or example.com/videos/*"
          value={newFqdn}
          onChange={(e) => setNewFqdn(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFqdn();
            }
          }}
        />
        <button type="button" id="addFqdn" onClick={addFqdn}>Add Site</button>
      </div>
      <div id="addFqdnStatus" className="add-status" hidden={fqdnStatus === ""}>{fqdnStatus}</div>
      <div className="hint">
        <strong>Optional path:</strong> the list is a blocklist normally and an allow-list in Whitelist Mode. A path scopes the entry (e.g. <em>example.com/videos</em>); <em>*</em> matches within a path segment. Without a path, the whole site including subdomains is matched. Press <strong>Enter</strong> to add.
      </div>
      <div id="fqdnList" className="list-container">
        {accessList.length === 0 ? (
          <div className="empty-msg">No sites in list</div>
        ) : (
          accessList.map((d) => (
            <div className="list-entry" key={d}>
              <div className="domain-info">{d}</div>
              <div className="controls-container">
                <button
                  type="button"
                  className="remove-btn"
                  onClick={() => removeAccessEntry(d)}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <h3>Remembered Settings</h3>
      <div className="hint remembered-hint">
        Manage saved volume, mono, and mute per site or URL path. A path such as <em>example.com/videos</em> applies to that path and its descendants; <em>*</em> can match within a path segment. Queries are ignored by normal Remember behavior, but a manually entered URL such as <em>youtube.com/watch?v=abc</em> creates an exact query-scoped profile (and <em>?v=*</em> may be used as a query wildcard). These audio settings are independent from site access and debug overrides.
      </div>
      <div className="input-group">
        <input
          type="text"
          id="newRememberedSite"
          placeholder="example.com or example.com/videos"
          value={newRememberedSite}
          onChange={(e) => setNewRememberedSite(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRemembered();
          }}
        />
        <button type="button" id="addRemembered" onClick={addRemembered}>Add</button>
      </div>
      <div id="memoryList" className="list-container">
        {Object.keys(rememberedSettings).length === 0 ? (
          <div className="empty-msg">No remembered settings</div>
        ) : (
          Object.keys(rememberedSettings)
            .sort((a, b) => a.localeCompare(b))
            .map((d) => (
              <RememberedRow
                key={d}
                domain={d}
                entry={rememberedSettings[d]}
                onRemove={removeRememberedEntry}
                onUpdate={updateRememberedEntry}
                onRename={(oldDomain, newDomain) => {
                  const result = renameRememberedEntry(oldDomain, newDomain);
                  if (!result.ok && result.reason === "exists") {
                    window.alert("A remembered entry for that site/path already exists.");
                  }
                }}
              />
            ))
        )}
      </div>

      <h3>Site Debug Overrides</h3>
      <div className="hint remembered-hint">
        Persist DRM, CORS, debug highlight, and HTML media routing overrides independently from Remembered Settings. Turning Remember off in the popup will not remove these overrides.
      </div>
      <div className="input-group">
        <input
          type="text"
          id="newDebugSite"
          placeholder="example.com or example.com/videos"
          value={newDebugSite}
          onChange={(e) => setNewDebugSite(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addDebugSite();
          }}
        />
        <button type="button" id="addDebugSite" onClick={addDebugSite}>Add Override</button>
      </div>
      <div id="debugList" className="list-container">
        {Object.keys(siteDebug).length === 0 ? (
          <div className="empty-msg">No site debug overrides</div>
        ) : (
          Object.keys(siteDebug)
            .sort((a, b) => a.localeCompare(b))
            .map((d) => (
              <DebugRow
                key={d}
                domain={d}
                value={siteDebug[d]}
                onRemove={removeSiteDebugEntry}
                onUpdate={updateSiteDebugEntry}
                onRename={(oldDomain, newDomain) => {
                  const result = renameSiteDebugEntry(oldDomain, newDomain);
                  if (!result.ok && result.reason === "exists") {
                    window.alert("A debug override for that site/path already exists.");
                  }
                }}
              />
            ))
        )}
      </div>

      <h3>Normalizer</h3>
      <div className="toggle-box normalizer-master-switch">
        <label htmlFor="normalizerDefaultEnabled">
          <input
            type="checkbox"
            id="normalizerDefaultEnabled"
            aria-controls="normalizer-options-details"
            aria-expanded={defaultEnabled}
            checked={defaultEnabled}
            onChange={(e) => setNormalizerDefaultEnabled(e.target.checked)}
          />
          Normalize by default on sites without an override
        </label>
      </div>
      <div className="toggle-box normalizer-mode-setting">
        <label htmlFor="normalizerMode">Normalization style</label>
        <select
          id="normalizerMode"
          value={config.mode}
          onChange={(e) => setNormalizerConfig(normalizeNormalizerConfig({ ...config, mode: e.target.value as "music" | "adaptive" }))}
        >
          <option value="music">Music — preserve song dynamics (recommended)</option>
          <option value="adaptive">Adaptive — faster speech/video leveling</option>
        </select>
        <span className="hint">Music tracks loudness over several seconds and holds recent peaks and gradually releases them to reduce pumping. Adaptive responds quickly to loudness jumps. Applies to all sites using Normalize, even when the global default is off.</span>
      </div>
      <div id="normalizer-options-details" hidden={!defaultEnabled}>
        <div className="hint remembered-hint">
          Configure the real-time automatic gain controller and its WebAudio compressor (not a hard true-peak limiter). The popup&apos;s Normalize toggle is remembered separately per site/path from volume, mono, and mute.
        </div>
        <div className="toggle-box normalizer-settings">
          <div className="normalizer-setting-grid">
            <NormalizerNumberField
              id="normalizerTargetDb"
              label="Target loudness"
              unit="dBFS RMS"
              min={-30}
              max={-6}
              step={1}
              inputMode="decimal"
              value={config.targetDb}
              onCommitRaw={(raw) => commitNormalizerField("targetDb", raw)}
            />
            <NormalizerNumberField
              id="normalizerMaxBoostDb"
              label="Maximum auto boost"
              unit="dB"
              min={0}
              max={24}
              step={1}
              inputMode="decimal"
              value={config.maxBoostDb}
              onCommitRaw={(raw) => commitNormalizerField("maxBoostDb", raw)}
            />
            <NormalizerNumberField
              id="normalizerCeilingDb"
              label="Compressor threshold"
              unit="dBFS"
              min={-6}
              max={-0.1}
              step={0.1}
              inputMode="decimal"
              value={config.ceilingDb}
              onCommitRaw={(raw) => commitNormalizerField("ceilingDb", raw)}
            />
            <NormalizerNumberField
              id="normalizerResponseMs"
              label="Response speed (Adaptive)"
              unit="ms"
              min={100}
              max={3000}
              step={50}
              inputMode="numeric"
              value={config.responseMs}
              disabled={musicMode}
              title={musicMode
                ? "Music uses slower, dedicated loudness response times"
                : "Adaptive automatic gain response time"}
              onCommitRaw={(raw) => commitNormalizerField("responseMs", raw)}
            />
          </div>
          <label className="toggle-box" htmlFor="normalizerTruePeakExperimental">
            <input
              type="checkbox"
              id="normalizerTruePeakExperimental"
              checked={Boolean(config.experimentalTruePeak)}
              onChange={(e) => setNormalizerConfig(normalizeNormalizerConfig({ ...config, experimentalTruePeak: e.target.checked }))}
            />
            Experimental true-peak limiter (opt-in; isolated fallback route)
          </label>
          <span className="hint">Off by default. When enabled, uses the AudioWorklet only on the isolated compatibility audio route when protection is required; page-managed MAIN-world audio continues using the existing compressor. Adds about 5 ms latency. If module loading, processor initialization, or DSP processing fails, the route falls back to the existing compressor. Experimental; not certified BS.1770 true-peak protection. Avoid for time-critical audio.</span>
          <span className="hint">
            Defaults: Music style, −16 dBFS RMS target, +12 dB max auto boost, −1 dBFS compressor threshold. Response speed applies to Adaptive style. Automatic gain measures pre-slider audio, with a noise gate and source-peak headroom. This compressor is not a hard true-peak limiter; high manual boost can still distort.
          </span>
        </div>
      </div>

      <h3>Global Debug Defaults</h3>
      <div className="hint remembered-hint">These defaults apply everywhere unless a remembered site has <strong>Site debug</strong> enabled.</div>

      <div className="toggle-box debug-toggle-box">
        <label>
          <input
            type="checkbox"
            id="debugMode"
            checked={debugDefaults.debugMode}
            onChange={(e) => setDebugDefaults({ debugMode: e.target.checked })}
          />
          Show Debug Highlight
        </label>
        <span className="hint">
          Draws a <span className="debug-success-color">Green</span> border around video elements when successfully hooked.
        </span>
      </div>

      <div className="toggle-box danger-toggle-box">
        <label>
          <input
            type="checkbox"
            id="forceDrmCapture"
            checked={debugDefaults.forceDrmCapture}
            onChange={(e) => setDebugDefaults({ forceDrmCapture: e.target.checked })}
          />
          Force DRM Audio Capture (Debug Only)
        </label>
        <span className="hint danger-warning">
          <strong>Warning:</strong> disables Volume Control&apos;s DRM/EME safety checks and forces protected media through WebAudio. This can mute audio, prevent protected media from loading, or break playback on many pages. Reload affected tabs after changing this setting.
        </span>
      </div>

      <div className="toggle-box danger-toggle-box">
        <label>
          <input
            type="checkbox"
            id="forceCorsCapture"
            checked={debugDefaults.forceCorsCapture}
            onChange={(e) => setDebugDefaults({ forceCorsCapture: e.target.checked })}
          />
          Skip CORS Media Guard (Debug Only)
        </label>
        <span className="hint danger-warning">
          <strong>Warning:</strong> attempts WebAudio capture for cross-origin media instead of falling back safely. Browsers may output silence for tainted media. Reload affected tabs after changing this setting.
        </span>
      </div>

      <div className="toggle-box danger-toggle-box">
        <label htmlFor="debugRouteMode">HTML Media Route Override (Debug Only)</label>
        <select
          id="debugRouteMode"
          value={debugDefaults.debugRouteMode}
          onChange={(e) => setDebugDefaults({ debugRouteMode: e.target.value as SiteDebugOverrides["debugRouteMode"] })}
        >
          <option value="auto">Automatic (recommended)</option>
          <option value="webaudio">Force WebAudio / GainNode</option>
          <option value="native">Force native volume fallback</option>
        </select>
        <span className="hint danger-warning">
          <strong>Warning:</strong> Force WebAudio eagerly captures media elements, including attenuation. It chooses the HTML-media route but does not by itself bypass DRM or CORS; use the separate DRM/CORS debug toggles for those guards. Force native disables new MediaElementAudioSource capture, so boost and mono may be unavailable. Reload tabs when switching away from WebAudio because a captured media element cannot be uncaptured.
        </span>
      </div>

      <h3>Keyboard Shortcuts</h3>
      <div className="hint remembered-hint">
        Volume Control supports global keyboard shortcuts that work even when the popup is not open. Customize them using your browser&apos;s shortcut settings - click below to open the page directly.
      </div>
      <div className="input-group">
        <button type="button" id="openShortcutsPage" onClick={openShortcutsPage}>
          Open Browser Shortcut Settings
        </button>
        <button type="button" id="restoreShortcutDefaults" hidden>Restore Default Shortcuts</button>
      </div>
      <div id="shortcutsList" className="list-container">
        {COMMANDS.map((cmd) => (
          <div className="shortcut-entry" key={cmd.name}>
            <div className="shortcut-name">{cmd.description || cmd.name}</div>
            <div className="shortcut-keys">
              {cmd.shortcut ? (
                cmd.shortcut.split("+").map((part, i) => (
                  <span key={`${cmd.name}-${part}`} className="flex items-center gap-1">
                    {i > 0 && <span className="keycap-separator">+</span>}
                    <span className="keycap">{part.trim()}</span>
                  </span>
                ))
              ) : (
                <span className="shortcut-unset">Not set</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="footer-box">
        <h3
          className="about-heading"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <span>About Volume Control <strong id="manifest-version">7.1</strong></span>
        </h3>
        <div className="footer-links">
          <a
            href="https://github.com/Chaython/volumecontrol/issues"
            target="_blank"
            rel="noreferrer"
            className="footer-link"
          >
            &#128027; Report a Bug
          </a>
          <a
            href="https://github.com/sponsors/Chaython"
            target="_blank"
            rel="noreferrer"
            className="footer-link"
          >
            &#10084; Donate / Support
          </a>
          <a
            href="https://github.com/Chaython/volumecontrol/blob/master/LICENSE"
            target="_blank"
            rel="noreferrer"
            className="footer-link"
          >
            &#128196; View License
          </a>
        </div>
        <div className="version-info">
          Open Source project hosted on GitHub. Developed by Chaython.
        </div>
      </div>
    </div>
  );
}
