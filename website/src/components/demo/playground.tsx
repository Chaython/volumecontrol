"use client";

/**
 * MediaPlayground — the demo.local page inside the browser mockup.
 * Contains built-in demo tracks (quiet music / dynamic range) plus any files
 * the user drops in. Every media element is attached to the ported
 * VolumeEngine, so the extension popup controls them exactly like the real
 * extension controls page media.
 */

import { useEffect, useRef } from "react";
import { UploadCloud, Music4, Waves, FileVideo, X, ShieldAlert, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { useExtensionStore } from "@/lib/volume-control/store";
import type { MediaItem } from "@/lib/volume-control/store";
import { VolumeEngine } from "@/lib/volume-control/engine";
import { asset } from "@/lib/asset-path";

/**
 * A media element wired into the engine for its entire mounted lifetime —
 * the equivalent of the extension's content script claiming an element.
 */
function EngineMedia({ item }: { item: MediaItem; browserDark?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const node = item.kind === "video" ? videoRef.current : audioRef.current;
    if (!node) return;
    const engine = VolumeEngine.getInstance();
    engine.attach(node);
    return () => engine.detach(node);
  }, [item]);

  if (item.kind === "video") {
    return (
      <div className="mt-2">
        <video
          ref={videoRef}
          src={item.url}
          controls
          playsInline
          className="w-full rounded-lg bg-black max-h-72"
        />
      </div>
    );
  }
  return (
    <div className="mt-2">
      <audio ref={audioRef} src={item.url} controls className="w-full" />
    </div>
  );
}

export { EngineMedia };

const DEMO_TRACKS: MediaItem[] = [
  {
    id: "demo-quiet-music",
    name: "Ambient Progression (quiet mix)",
    url: asset("/samples/quiet-music.mp3"),
    kind: "audio",
    isObjectUrl: false,
    tag: "−30 dBFS · try boosting +12 dB",
  },
  {
    id: "demo-dynamic-music",
    name: "Verse → Chorus (wide dynamics)",
    url: asset("/samples/dynamic-music.mp3"),
    kind: "audio",
    isObjectUrl: false,
    tag: "quiet verse, loud chorus · perfect for Normalize",
  },
];

export function MediaPlayground({ browserDark }: { browserDark: boolean }) {
  const playlist = useExtensionStore((s) => s.playlists["demo.local"] ?? []);
  const addMediaItems = useExtensionStore((s) => s.addMediaItems);
  const removeMediaItem = useExtensionStore((s) => s.removeMediaItem);
  const restricted = useExtensionStore((s) => Boolean(s.restricted["demo.local"]));
  const setRestricted = useExtensionStore((s) => s.setRestricted);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | File[]) => {
    const items = Array.from(files)
      .filter((f) => f.type.startsWith("audio/") || f.type.startsWith("video/") ||
        /\.(mp3|wav|ogg|m4a|flac|aac|opus|webm|mp4|mkv|mov)$/i.test(f.name))
      .map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: f.name,
        url: URL.createObjectURL(f),
        kind: (f.type.startsWith("video/") ? "video" : "audio") as "audio" | "video",
        isObjectUrl: true,
      }));
    if (items.length > 0) addMediaItems(items);
  };

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) addFiles(event.target.files);
    event.target.value = "";
  };

  return (
    <div className={cn("min-h-full", browserDark ? "bg-[#1b1b1f] text-zinc-200" : "bg-white text-zinc-800")}>
      {/* Fake site header */}
      <header className={cn("border-b px-6 py-4", browserDark ? "border-zinc-800 bg-[#232329]" : "border-zinc-200 bg-[#fafbfc]")}>
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <span className={cn("w-9 h-9 rounded-lg grid place-items-center", browserDark ? "bg-emerald-900/40 text-emerald-300" : "bg-emerald-100 text-emerald-700")}>
            <Music4 className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Media Playground</h1>
            <p className={cn("text-xs", browserDark ? "text-zinc-400" : "text-zinc-500")}>
              demo.local — a test page full of HTML5 media. Open the Volume Control popup in the
              toolbar to control everything on this page.
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {/* Demo tracks */}
        <section aria-label="Demo tracks">
          <h2 className={cn("text-xs font-semibold uppercase tracking-wider mb-3", browserDark ? "text-zinc-500" : "text-zinc-400")}>
            Demo tracks
          </h2>
          <div className="space-y-3">
            {DEMO_TRACKS.map((track) => (
              <article
                key={track.id}
                className={cn(
                  "rounded-xl border p-4 transition-colors",
                  browserDark ? "border-zinc-800 bg-[#232329]" : "border-zinc-200 bg-white shadow-sm",
                )}
              >
                <div className="flex items-center gap-3">
                  <span className={cn("w-8 h-8 rounded-full grid place-items-center shrink-0", browserDark ? "bg-emerald-900/40 text-emerald-300" : "bg-emerald-50 text-emerald-600")}>
                    {track.id === "demo-quiet-music" ? <Waves className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{track.name}</p>
                    <p className={cn("text-xs", browserDark ? "text-zinc-500" : "text-zinc-400")}>{track.tag}</p>
                  </div>
                </div>
                <EngineMedia item={track} browserDark={browserDark} />
              </article>
            ))}
          </div>
        </section>

        {/* Dropped files */}
        {playlist.length > 0 && (
          <section aria-label="Your files">
            <h2 className={cn("text-xs font-semibold uppercase tracking-wider mb-3", browserDark ? "text-zinc-500" : "text-zinc-400")}>
              Your files ({playlist.length})
            </h2>
            <div className="space-y-3">
              {playlist.map((item) => (
                <article
                  key={item.id}
                  className={cn(
                    "rounded-xl border p-4 transition-colors",
                    browserDark ? "border-zinc-800 bg-[#232329]" : "border-zinc-200 bg-white shadow-sm",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className={cn("w-8 h-8 rounded-full grid place-items-center shrink-0", browserDark ? "bg-sky-900/40 text-sky-300" : "bg-sky-50 text-sky-600")}>
                      {item.kind === "video" ? <FileVideo className="w-4 h-4" /> : <Music4 className="w-4 h-4" />}
                    </span>
                    <p className="text-sm font-medium truncate flex-1 min-w-0" title={item.name}>
                      {item.name}
                    </p>
                    <button
                      onClick={() => removeMediaItem(item.id)}
                      className={cn("w-7 h-7 grid place-items-center rounded-md", browserDark ? "text-zinc-500 hover:bg-zinc-700" : "text-zinc-400 hover:bg-zinc-100")}
                      aria-label={`Remove ${item.name}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <EngineMedia item={item} browserDark={browserDark} />
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Drop zone */}
        <section aria-label="Drop zone">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
            className={cn(
              "w-full rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer",
              browserDark
                ? "border-zinc-700 hover:border-emerald-500/60 hover:bg-emerald-500/5"
                : "border-zinc-300 hover:border-emerald-500/60 hover:bg-emerald-50/50",
            )}
          >
            <UploadCloud className={cn("w-8 h-8 mx-auto mb-2", browserDark ? "text-zinc-500" : "text-zinc-400")} />
            <p className="text-sm font-medium">Drop audio / video files here, or click to browse</p>
            <p className={cn("text-xs mt-1", browserDark ? "text-zinc-500" : "text-zinc-400")}>
              Files stay on your device — playback is local, just like a real page.
            </p>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/*"
            multiple
            className="hidden"
            onChange={onFileChange}
          />
        </section>

        {/* DRM simulation */}
        <section aria-label="DRM simulation">
          <div className={cn("rounded-xl border p-4 flex items-start gap-3", restricted ? (browserDark ? "border-amber-700/60 bg-amber-950/30" : "border-amber-300 bg-amber-50") : (browserDark ? "border-zinc-800 bg-[#232329]" : "border-zinc-200 bg-[#fafbfc]"))}>
            <ShieldAlert className={cn("w-5 h-5 shrink-0 mt-0.5", restricted ? "text-amber-500" : browserDark ? "text-zinc-500" : "text-zinc-400")} />
            <div className="flex-1">
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={restricted}
                  onChange={(e) => setRestricted(e.target.checked)}
                  className="accent-amber-500 w-4 h-4"
                />
                Serve this page&apos;s media as DRM-protected
              </label>
              <p className={cn("text-xs mt-1.5 leading-relaxed", browserDark ? "text-zinc-400" : "text-zinc-500")}>
                Simulates Netflix/Spotify-style protected streams: the browser blocks WebAudio
                capture, so Volume Control switches to its fallback — the slider clamps to 0 dB,
                Mono and Normalize become unavailable, and volume is applied natively.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
