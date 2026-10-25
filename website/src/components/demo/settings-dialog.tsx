"use client";

/**
 * SettingsDialog — a replica of the extension's options page (options.html)
 * scoped to the settings that are live in the preview. The Normalizer section
 * is fully functional and writes through to the running engine + API.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useExtensionStore } from "@/lib/volume-control/store";
import { formatDb } from "@/lib/volume-control/core";
import type { NormalizerConfig } from "@/lib/volume-control/types";

function NumberField({
  id,
  label,
  unit,
  min,
  max,
  step,
  value,
  disabled,
  disabledTitle,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  disabledTitle?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-600">{label}</span>
      <span className="flex items-center gap-2" title={disabled ? disabledTitle : undefined}>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange(Math.max(min, Math.min(max, n)));
          }}
          className="w-24 px-2.5 py-1.5 rounded-lg border border-zinc-300 bg-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <span className="text-xs text-zinc-500">{unit}</span>
      </span>
    </label>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const config = useExtensionStore((s) => s.normalizerConfig);
  const defaultEnabled = useExtensionStore((s) => s.normalizerDefaultEnabled);
  const setNormalizerConfig = useExtensionStore((s) => s.setNormalizerConfig);
  const setNormalizerDefaultEnabled = useExtensionStore((s) => s.setNormalizerDefaultEnabled);
  const remembered = useExtensionStore((s) => s.remembered);

  const [draft, setDraft] = useState<NormalizerConfig>(config);
  const [lastConfig, setLastConfig] = useState<NormalizerConfig>(config);
  // Adjust local draft when the store config changes externally (render-phase
  // sync — the React-documented pattern instead of an effect).
  if (config !== lastConfig) {
    setLastConfig(config);
    setDraft(config);
  }

  const commit = (partial: Partial<NormalizerConfig>) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    setNormalizerConfig(partial);
  };

  const musicMode = draft.mode === "music";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto bg-white text-zinc-800 rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-left">Volume Control Settings</DialogTitle>
          <DialogDescription className="text-left">
            The options page, replicated. Normalizer settings apply live to the audio engine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 text-sm">
          {/* Remembered settings (read-only mirror of the API rows) */}
          <section>
            <h3 className="text-base font-semibold mb-1">Remembered Settings</h3>
            <p className="text-xs text-zinc-500 mb-3 leading-relaxed">
              Saved volume, mono and mute per site — persisted through this site&apos;s API
              (the web equivalent of the extension&apos;s chrome.storage).
            </p>
            <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100">
              {Object.keys(remembered).filter((k) => remembered[k]).length === 0 ? (
                <p className="px-4 py-3 text-xs text-zinc-400">
                  No remembered sites yet — toggle <strong>Remember</strong> in the popup on a
                  site to create one.
                </p>
              ) : (
                Object.entries(remembered)
                  .filter(([, has]) => has)
                  .map(([siteKey]) => (
                    <div key={siteKey} className="px-4 py-2.5 flex items-center justify-between text-xs">
                      <span className="font-mono">{siteKey}</span>
                      <span className="text-zinc-400">volume · mono · mute · normalize</span>
                    </div>
                  ))
              )}
            </div>
          </section>

          {/* Normalizer */}
          <section>
            <h3 className="text-base font-semibold mb-1">Normalizer</h3>
            <label
              htmlFor="normalizerDefaultEnabled"
              className="flex items-center justify-between gap-4 py-2 cursor-pointer"
            >
              <span className="text-xs text-zinc-600 max-w-[300px]">
                Normalize by default on sites without an override
              </span>
              <Switch
                id="normalizerDefaultEnabled"
                checked={defaultEnabled}
                onCheckedChange={setNormalizerDefaultEnabled}
                className="data-[state=checked]:bg-[#4CAF50]"
              />
            </label>

            <div className="mt-3 rounded-xl border border-zinc-200 p-4 space-y-4">
              <div>
                <label htmlFor="normalizerMode" className="text-xs font-medium text-zinc-600 block mb-1.5">
                  Normalization style
                </label>
                <select
                  id="normalizerMode"
                  value={draft.mode}
                  onChange={(e) => commit({ mode: e.target.value as "music" | "adaptive" })}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  <option value="music">Music — preserve song dynamics (recommended)</option>
                  <option value="adaptive">Adaptive — faster speech/video leveling</option>
                </select>
                <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
                  Music tracks loudness over several seconds and holds recent peaks, gradually
                  releasing them to reduce pumping. Adaptive responds quickly to loudness jumps.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <NumberField
                  id="normalizerTargetDb"
                  label="Target loudness"
                  unit="dBFS RMS"
                  min={-30}
                  max={-6}
                  step={1}
                  value={draft.targetDb}
                  onChange={(v) => commit({ targetDb: v })}
                />
                <NumberField
                  id="normalizerMaxBoostDb"
                  label="Maximum auto boost"
                  unit="dB"
                  min={0}
                  max={24}
                  step={1}
                  value={draft.maxBoostDb}
                  onChange={(v) => commit({ maxBoostDb: v })}
                />
                <NumberField
                  id="normalizerCeilingDb"
                  label="Compressor threshold"
                  unit="dBFS"
                  min={-6}
                  max={-0.1}
                  step={0.1}
                  value={draft.ceilingDb}
                  onChange={(v) => commit({ ceilingDb: v })}
                />
                <NumberField
                  id="normalizerResponseMs"
                  label="Response speed (Adaptive)"
                  unit="ms"
                  min={100}
                  max={3000}
                  step={50}
                  value={draft.responseMs}
                  disabled={musicMode}
                  disabledTitle="Music uses slower, dedicated loudness response times"
                  onChange={(v) => commit({ responseMs: v })}
                />
              </div>

              {/* Live preview of the ceiling position */}
              <div>
                <div className="flex justify-between text-[11px] text-zinc-500 mb-1">
                  <span>Automatic gain window</span>
                  <span className="font-mono">
                    ≤ +{draft.maxBoostDb} dB · ceiling {draft.ceilingDb} dBFS
                  </span>
                </div>
                <Slider
                  value={[Math.min(draft.maxBoostDb, Math.max(0, draft.ceilingDb - 2 + draft.maxBoostDb))]}
                  min={0}
                  max={24}
                  step={1}
                  disabled
                  aria-label="Automatic gain window (visual)"
                  className="opacity-70 cursor-default"
                />
                <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
                  Defaults: Music style, −16 dBFS RMS target, +12 dB max auto boost, −1 dBFS
                  compressor threshold. Automatic gain measures pre-slider audio with a noise
                  gate and source-peak headroom.
                </p>
              </div>
            </div>
          </section>

          {/* Keyboard shortcuts */}
          <section>
            <h3 className="text-base font-semibold mb-2">Keyboard Shortcuts</h3>
            <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100 text-xs">
              {[
                ["Increase volume by 1 dB", "Alt+Shift+↑"],
                ["Decrease volume by 1 dB", "Alt+Shift+↓"],
                ["Reset volume to 0 dB", "Alt+Shift+0"],
                ["Toggle mono audio", "Alt+Shift+M"],
              ].map(([action, keys]) => (
                <div key={keys} className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-zinc-600">{action}</span>
                  <kbd className="px-2 py-1 rounded-md bg-zinc-100 border border-zinc-200 font-mono text-[11px]">
                    {keys}
                  </kbd>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 mt-1.5">
              Active right now in this preview — try them while media is playing.
            </p>
          </section>

          {/* About */}
          <section className="rounded-xl bg-zinc-50 border border-zinc-200 p-4">
            <h3 className="text-sm font-semibold mb-2">
              About Volume Control <span className="text-zinc-400 font-normal">v7.1</span>
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              <a href="https://github.com/Chaython/volumecontrol/issues" target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                🐛 Report a Bug
              </a>
              <a href="https://github.com/sponsors/Chaython" target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                ❤️ Donate / Support
              </a>
              <a href="https://github.com/Chaython/volumecontrol/blob/master/LICENSE" target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                📄 View License
              </a>
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">
              Open source project hosted on GitHub. This live preview runs the extension&apos;s
              own audio-processing code (page-audio-hook.js) ported to the page —{" "}
              <span className="font-mono">{formatDb(0)}</span> means untouched.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
