"use client";

/**
 * SignalChain — a live view of the actual WebAudio graph inside the ported
 * engine. Nodes light up as they engage: mono down-mix, safety limiter, and
 * the automatic gain from the normalizer. Values update at the engine's
 * 100 ms sampler rate, straight from the running audio graph.
 */

import { useEffect, useState } from "react";
import {
  AudioLines,
  Split,
  Merge,
  ArrowRight,
  AudioWaveform,
  TrendingUp,
  Volume2,
  ShieldCheck,
  ShieldOff,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { VolumeEngine } from "@/lib/volume-control/engine";
import type { ChainSnapshot } from "@/lib/volume-control/types";
import { useExtensionStore } from "@/lib/volume-control/store";

function NodeCard({
  label,
  sublabel,
  icon,
  active,
  dimmed,
  accent,
}: {
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
  active: boolean;
  dimmed?: boolean;
  accent?: "emerald" | "amber" | "zinc";
}) {
  const accentClass = accent === "emerald"
    ? "border-emerald-500/60 bg-emerald-500/10"
    : accent === "amber"
      ? "border-amber-500/60 bg-amber-500/10"
      : "";
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-xl border transition-all duration-200 min-w-[92px]",
        active
          ? accentClass || "border-zinc-600 bg-zinc-800"
          : "border-zinc-800 bg-zinc-900/60",
        dimmed && "opacity-35 saturate-0",
      )}
    >
      <span className={cn(
        "grid place-items-center w-8 h-8 rounded-lg",
        active ? (accent === "amber" ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400") : "bg-zinc-800 text-zinc-500",
      )}>
        {icon}
      </span>
      <span className="text-[11px] font-medium text-zinc-300 text-center leading-tight">{label}</span>
      {sublabel && <span className="text-[10px] text-zinc-500 font-mono text-center leading-tight">{sublabel}</span>}
    </div>
  );
}

function Arrow({ on }: { on: boolean }) {
  return (
    <ArrowRight className={cn("w-4 h-4 shrink-0 transition-colors", on ? "text-emerald-400" : "text-zinc-700")} />
  );
}

export function SignalChain() {
  const [chain, setChain] = useState<ChainSnapshot | null>(null);
  const normalizerEnabled = useExtensionStore((s) => s.normalizerEnabled);
  const dB = useExtensionStore((s) => s.dB);
  const muted = useExtensionStore((s) => s.muted);
  const extensionActive = useExtensionStore((s) => s.extensionActive);

  useEffect(() => {
    const engine = VolumeEngine.getInstance();
    return engine.onChain(setChain);
  }, []);

  const captured = chain?.captured ?? false;
  const mono = chain?.routingMode.startsWith("mono") ?? false;
  const limiter = chain?.limiterActive ?? false;
  const bypass = chain?.routingMode === "bypass";
  const gainValue = chain?.gainValue ?? 1;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-5 sm:p-6 overflow-x-auto">
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <AudioLines className="w-4 h-4 text-emerald-400" />
            Live signal chain
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            The real WebAudio graph from the ported extension code — {chain?.routes ?? 0}{" "}
            media element{chain?.routes === 1 ? "" : "s"} attached, context{" "}
            <span className="font-mono">{chain?.contextState ?? "none"}</span>.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className={cn("px-2 py-1 rounded-md border", bypass || !extensionActive
            ? "border-zinc-700 text-zinc-400"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300")}>
            {bypass || !extensionActive ? "bypass (unity)" : (chain?.routingMode ?? "stereo-direct")}
          </span>
          {chain?.restricted && (
            <span className="px-2 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300">
              fallback volume
            </span>
          )}
        </div>
      </div>

      <div className="flex items-stretch gap-2 sm:gap-3 min-w-max">
        <NodeCard
          label="Media element"
          sublabel={captured ? "captured" : "native playback"}
          icon={<AudioWaveform className="w-4 h-4" />}
          active={captured}
          accent="emerald"
        />
        <Arrow on={captured} />
        <NodeCard
          label="Input analyser"
          sublabel="fft 8192"
          icon={<TrendingUp className="w-4 h-4" />}
          active={captured}
          accent="emerald"
        />
        <Arrow on={captured} />
        <NodeCard
          label={muted ? "Gain (muted)" : `Gain ${gainValue >= 1 ? "+" : ""}${(20 * Math.log10(Math.max(gainValue, 1e-6))).toFixed(1)} dB`}
          sublabel={`slider ${dB >= 0 ? "+" : ""}${dB} dB`}
          icon={<Volume2 className="w-4 h-4" />}
          active={captured && (dB !== 0 || muted)}
          accent="emerald"
          dimmed={!captured}
        />
        <Arrow on={captured && mono} />
        <NodeCard
          label="Mono down-mix"
          sublabel="L+R → both"
          icon={<Split className="w-4 h-4" />}
          active={captured && mono}
          dimmed={!mono}
        />
        <Arrow on={captured && limiter} />
        <NodeCard
          label={limiter ? `Limiter ${chain?.limiterThresholdDb.toFixed(1)} dB` : "Limiter"}
          sublabel={limiter ? "ratio 20:1" : "bypassed"}
          icon={limiter ? <ShieldCheck className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
          active={captured && limiter}
          accent="amber"
          dimmed={!limiter}
        />
        <Arrow on={captured && limiter} />
        <NodeCard
          label="Output analyser"
          sublabel="fft 1024"
          icon={<AudioWaveform className="w-4 h-4" />}
          active={captured && limiter}
          accent="emerald"
          dimmed={!limiter}
        />
        <Arrow on={captured} />
        <NodeCard
          label="Destination"
          sublabel="speakers"
          icon={<Zap className="w-4 h-4" />}
          active
          accent="emerald"
        />
      </div>

      <p className="text-[11px] text-zinc-600 mt-4 leading-relaxed max-w-2xl">
        {normalizerEnabled
          ? "Normalize is measuring pre-gain loudness (RMS + peak envelope) and steering the same gain node, with a compressor guarding the ceiling."
          : "The safety limiter engages automatically whenever you boost above 0 dB or enable Normalize — exactly the extension's own protection logic."}
        {" "}Routing is lazy: at 0 dB with no processing, media plays natively without WebAudio capture.
      </p>
    </div>
  );
}
