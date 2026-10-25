"use client";

/**
 * QuietFmSite — the quiet.fm page inside the browser mockup: a talk-radio
 * stream mixed far too quietly (−33 dBFS), the classic use case for the
 * extension's volume boost.
 */

import { useEffect, useRef } from "react";
import { Radio, MoonStar, SignalHigh } from "lucide-react";
import { cn } from "@/lib/utils";
import { VolumeEngine } from "@/lib/volume-control/engine";
import type { MediaItem } from "@/lib/volume-control/store";
import { asset } from "@/lib/asset-path";

const STREAM: MediaItem = {
  id: "quiet-fm-stream",
  name: "Late Night Talk — Episode 214",
  url: asset("/samples/quiet-fm-talk.mp3"),
  kind: "audio",
  isObjectUrl: false,
};

export function QuietFmSite({ browserDark }: { browserDark: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const node = audioRef.current;
    if (!node) return;
    const engine = VolumeEngine.getInstance();
    engine.attach(node);
    return () => engine.detach(node);
  }, []);

  return (
    <div className={cn("min-h-full", browserDark ? "bg-[#141216] text-zinc-200" : "bg-[#1c1917] text-stone-100")}>
      <header className={cn("border-b px-6 py-4", browserDark ? "border-zinc-800 bg-[#1d1a20]" : "border-stone-800 bg-[#241f22]")}>
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-400 grid place-items-center">
            <MoonStar className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Quiet FM — Late Night Talk</h1>
            <p className="text-xs text-stone-400">
              quiet.fm/radio · broadcasting to insomniacs since 1998
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        <article className={cn("rounded-2xl border p-6", browserDark ? "border-zinc-800 bg-[#1d1a20]" : "border-stone-800 bg-[#241f22]")}>
          <div className="flex items-center gap-4">
            <span className="relative w-14 h-14 rounded-full bg-amber-500/15 text-amber-400 grid place-items-center shrink-0">
              <Radio className="w-6 h-6" />
              <span className="absolute inset-0 rounded-full border border-amber-400/30 animate-ping" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-widest text-amber-400/90 font-semibold">Now streaming</p>
              <h2 className="text-base font-semibold truncate">Why is everything on the internet a different volume?</h2>
              <p className="text-xs text-stone-400 mt-0.5">with your host, The Quiet Broadcaster</p>
            </div>
          </div>

          <div className="mt-5">
            <audio ref={audioRef} src={STREAM.url} controls loop className="w-full" />
            <p className="text-[11px] text-stone-500 mt-2 flex items-center gap-1.5">
              <SignalHigh className="w-3.5 h-3.5" aria-hidden="true" />
              Stream mastered at −33 dBFS — crank the extension up to +32 dB and keep your
              system volume comfortable.
            </p>
          </div>
        </article>

        <section className="grid sm:grid-cols-2 gap-4">
          <div className={cn("rounded-xl border p-4", browserDark ? "border-zinc-800 bg-[#1d1a20]" : "border-stone-800 bg-[#241f22]")}>
            <h3 className="text-sm font-semibold mb-1.5">Tonight&apos;s topic</h3>
            <p className="text-xs text-stone-400 leading-relaxed">
              Loudness wars, the EBU R128 standard, and why your podcast app normalizes
              everything except the one podcast you actually listen to.
            </p>
          </div>
          <div className={cn("rounded-xl border p-4", browserDark ? "border-zinc-800 bg-[#1d1a20]" : "border-stone-800 bg-[#241f22]")}>
            <h3 className="text-sm font-semibold mb-1.5">Try this</h3>
            <p className="text-xs text-stone-400 leading-relaxed">
              Enable <span className="text-amber-400">Remember</span> on this site, set a boost,
              then switch tabs — quiet.fm keeps its settings while demo.local stays at 0 dB.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
