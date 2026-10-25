"use client";

/**
 * Volume Control — live preview home page.
 * The centerpiece is the browser mockup running the extension's real audio
 * engine; the surrounding sections document the feature set and live stats.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Github,
  MousePointerClick,
  UploadCloud,
  Keyboard,
  Volume2,
  SlidersHorizontal,
  Music4,
  AudioLines,
  Ban,
  Globe,
  Star,
  Users,
  Download,
  Heart,
  BarChart3,
  Puzzle,
} from "lucide-react";
import { BrowserFrame } from "@/components/demo/browser-frame";
import { SignalChain } from "@/components/demo/signal-chain";
import { useExtensionShortcuts } from "@/hooks/use-extension-shortcuts";
import { useExtensionStore } from "@/lib/volume-control/store";
import { asset, IS_STATIC_EXPORT } from "@/lib/asset-path";
import fallbackStats from "@/data/repo-stats.json";

interface RepoStats {
  firefox?: { averageDailyUsers?: number; rating?: number };
  edge?: { activeInstallCount?: number; rating?: number };
  github?: { stars?: number; forks?: number };
}

function useRepoStats() {
  // Static GitHub Pages build: no API routes — the stats snapshot ships with
  // the bundle, so it becomes the initial (and final) state. Otherwise hit
  // the live API, falling back to the snapshot if it is unavailable.
  const [stats, setStats] = useState<RepoStats | null>(
    IS_STATIC_EXPORT ? (fallbackStats as RepoStats) : null
  );
  useEffect(() => {
    if (IS_STATIC_EXPORT) return;
    fetch("/api/stats")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setStats(data ?? (fallbackStats as RepoStats)))
      .catch(() => setStats(fallbackStats as RepoStats));
  }, []);
  return stats;
}

const FEATURES = [
  {
    icon: Volume2,
    title: "Volume boost up to ±32 dB",
    text: "Boost quiet media far beyond the browser's normal range, or lower it to a whisper — with a safety limiter guarding against clipping.",
  },
  {
    icon: SlidersHorizontal,
    title: "Per-site settings",
    text: "Volume, mute, mono and Normalize are remembered per site or even per URL path, with wildcard support. The demo does exactly this — try both tabs.",
  },
  {
    icon: Music4,
    title: "Loudness normalization",
    text: "Music mode preserves song dynamics with multi-second loudness tracking; Adaptive mode levels speech and video fast. Peak-hold envelopes prevent pumping.",
  },
  {
    icon: AudioLines,
    title: "Mono down-mix",
    text: "Fold stereo into mono through a proper channel-splitter chain — useful for single-earbud listening or shared-room playback.",
  },
  {
    icon: Ban,
    title: "Site exclusions",
    text: "Blocklist or whitelist entire domains, path-scoped URLs and wildcard patterns. The Active toggle in the popup flips the current site instantly.",
  },
  {
    icon: Keyboard,
    title: "Keyboard shortcuts",
    text: "Alt+Shift+↑/↓ steps 1 dB, Alt+Shift+0 resets, Alt+Shift+M toggles mono — global commands that work without opening the popup. Active on this page.",
  },
];

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export default function Home() {
  const hydrateRemembered = useExtensionStore((s) => s.hydrateRemembered);
  const hydrateNormalizerConfig = useExtensionStore((s) => s.hydrateNormalizerConfig);
  const hydrateOptionsState = useExtensionStore((s) => s.hydrateOptionsState);
  const applySiteSettings = useExtensionStore((s) => s.applySiteSettings);
  const stats = useRepoStats();
  useExtensionShortcuts();

  useEffect(() => {
    let cancelled = false;
    // The options-page state (blocklists, debug defaults) is synchronous
    // localStorage — hydrate it first so applySiteSettings sees it.
    hydrateOptionsState();
    void (async () => {
      await hydrateNormalizerConfig();
      await hydrateRemembered();
      // Restore the initial site's remembered settings, exactly like the
      // content script re-running on a fresh page load.
      if (!cancelled) applySiteSettings(useExtensionStore.getState().site.key);
    })();
    return () => { cancelled = true; };
  }, [hydrateRemembered, hydrateNormalizerConfig, hydrateOptionsState, applySiteSettings]);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 selection:bg-emerald-500/30">
      {/* ------------------------------------------------------------- nav --- */}
      <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
          { }
          <img src={asset("/vc/ico.svg")} alt="" className="w-6 h-6 invert opacity-90" />
          <span className="font-semibold tracking-tight">Volume Control</span>
          <span className="hidden sm:inline text-xs text-zinc-500 border border-zinc-800 rounded-full px-2 py-0.5">
            live preview
          </span>
          <nav className="ml-auto flex items-center gap-2 sm:gap-4">
            <a
              href="https://github.com/Chaython/volumecontrol"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              <Github className="w-4 h-4" />
              {stats?.github?.stars !== undefined ? formatCount(stats.github.stars) : "GitHub"}
            </a>
            <a
              href="#demo"
              className="text-sm px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
            >
              Try the demo
            </a>
          </nav>
        </div>
      </header>

      {/* ------------------------------------------------------------ hero --- */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none opacity-40"
          style={{
            background:
              "radial-gradient(600px 280px at 20% -40%, rgba(16,185,129,0.25), transparent), radial-gradient(600px 280px at 85% -20%, rgba(16,185,129,0.12), transparent)",
          }}
          aria-hidden="true"
        />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-16 pb-10 sm:pt-24 sm:pb-14 text-center">
          <p className="inline-flex items-center gap-2 text-xs font-medium text-emerald-300 border border-emerald-500/30 bg-emerald-500/10 rounded-full px-3 py-1 mb-5">
            <Globe className="w-3.5 h-3.5" />
            v7.1 · open source · Firefox &amp; Chromium
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-[1.05] max-w-3xl mx-auto">
            Per-site volume control,
            <span className="text-emerald-400"> boosted to ±32 dB</span>
          </h1>
          <p className="mt-5 text-base sm:text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed">
            This page runs the extension&apos;s actual audio engine — the same WebAudio graph,
            normalizer and safety limiter as the add-on. Play a track, drop in your own files,
            and control everything through the real popup.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="#demo"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors"
            >
              <MousePointerClick className="w-4 h-4" />
              Open the live preview
            </a>
            <a
              href={asset("/downloads/volume-control-live-preview-source.zip")}
              download
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-zinc-700 hover:border-zinc-500 text-zinc-200 font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              Download source (.zip)
            </a>
            <a
              href="https://github.com/Chaython/volumecontrol"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-zinc-700 hover:border-zinc-500 text-zinc-200 font-medium transition-colors"
            >
              <Github className="w-4 h-4" />
              View source
            </a>
          </div>

          {stats && (
            <div className="mt-10 flex items-center justify-center gap-6 sm:gap-10 text-sm text-zinc-400 flex-wrap">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4 text-emerald-400" />
                <strong className="text-zinc-100 font-semibold">
                  {stats.firefox?.averageDailyUsers
                    ? stats.firefox.averageDailyUsers.toLocaleString()
                    : "—"}
                </strong>
                daily users
              </span>
              <span className="flex items-center gap-1.5">
                <Star className="w-4 h-4 text-amber-400" />
                <strong className="text-zinc-100 font-semibold">
                  {stats.firefox?.rating ? stats.firefox.rating.toFixed(1) : "—"}
                </strong>
                Firefox rating
              </span>
              <span className="flex items-center gap-1.5">
                <Github className="w-4 h-4" />
                <strong className="text-zinc-100 font-semibold">
                  {stats.github?.stars ?? "—"}
                </strong>
                GitHub stars
              </span>
              <a
                href={asset("/stats.html")}
                className="flex items-center gap-1.5 text-emerald-300 hover:text-emerald-200 transition-colors"
                title="Live usage statistics dashboard"
              >
                <BarChart3 className="w-4 h-4" />
                Full statistics
              </a>
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------ demo --- */}
      <section id="demo" className="scroll-mt-20 px-3 sm:px-6 pb-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-zinc-500 mb-5 text-center">
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-zinc-800 grid place-items-center text-[10px] text-zinc-300 font-semibold">1</span>
              Play a track inside the browser below
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-zinc-800 grid place-items-center text-[10px] text-zinc-300 font-semibold">2</span>
              Click the speaker icon in its toolbar
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-zinc-800 grid place-items-center text-[10px] text-zinc-300 font-semibold">3</span>
              <UploadCloud className="w-3.5 h-3.5" />
              Drop your own audio/video files
            </span>
          </div>

          <BrowserFrame />

          <div className="mt-6">
            <SignalChain />
          </div>

          <p className="mt-4 text-center text-xs text-zinc-600">
            Headphones recommended · nothing is uploaded · audio is processed locally by the
            ported extension code
          </p>
        </div>
      </section>

      {/* -------------------------------------------------------- features --- */}
      <section className="px-4 sm:px-6 py-16 sm:py-20">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-center">
            Everything the extension does
          </h2>
          <p className="mt-3 text-sm text-zinc-400 text-center max-w-2xl mx-auto">
            Each behavior below is implemented in this preview with the extension&apos;s own
            logic and constants.
          </p>
          <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((feature) => (
              <article
                key={feature.title}
                className="group rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 hover:border-emerald-500/40 hover:bg-zinc-900/70 transition-colors"
              >
                <span className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 grid place-items-center mb-4 group-hover:bg-emerald-500/20 transition-colors">
                  <feature.icon className="w-5 h-5" />
                </span>
                <h3 className="font-semibold text-zinc-100">{feature.title}</h3>
                <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{feature.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- install --- */}
      <section className="px-4 sm:px-6 pb-16 sm:pb-20">
        <div className="max-w-4xl mx-auto rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900/80 to-zinc-950 p-8 sm:p-10 text-center">
          <h2 className="text-2xl font-bold tracking-tight">Get the real extension</h2>
          <p className="mt-3 text-sm text-zinc-400 max-w-xl mx-auto">
            The live preview covers the core audio engine. The add-on adds cross-tab state,
            per-URL path rules, DRM/CORS guards on real sites, and browser-integrated hotkeys.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {!IS_STATIC_EXPORT && (
              <a
                href={asset("/downloads/volume-control-website-gh-pages.zip")}
                download
                title="Complete, deploy-ready project for https://chaython.github.io/volumecontrol/"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors"
              >
                <Download className="w-4 h-4" />
                Download GitHub&nbsp;Pages build
              </a>
            )}
            <a
              href={asset("/downloads/volume-control-live-preview-source.zip")}
              download
              title="Just the source files created for this site"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-zinc-100 hover:bg-white text-zinc-900 text-sm font-semibold transition-colors"
            >
              <Download className="w-4 h-4" />
              Download this site&apos;s source
            </a>
            <a
              href="https://addons.mozilla.org/en-US/firefox/addon/volume-control-boost-volume/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-zinc-100 hover:bg-white text-zinc-900 text-sm font-semibold transition-colors"
            >
              <Download className="w-4 h-4" />
              Firefox Add-ons
            </a>
            <a
              href="https://microsoftedge.microsoft.com/addons/detail/ipbghdjdmefdioebhaneohmkidjakfbc"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-zinc-700 hover:border-zinc-500 text-zinc-200 text-sm font-semibold transition-colors"
            >
              <Download className="w-4 h-4" />
              Microsoft Edge
            </a>
            <a
              href="https://github.com/Chaython/volumecontrol"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-zinc-700 hover:border-zinc-500 text-zinc-200 text-sm font-semibold transition-colors"
            >
              <Github className="w-4 h-4" />
              GitHub
            </a>
          </div>
        </div>

        {/* ------------------------------------------- tampermonkey edition --- */}
        <div className="mt-8 max-w-3xl mx-auto rounded-2xl border border-emerald-900/60 bg-emerald-950/30 p-6 sm:p-7 text-left">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid place-items-center w-9 h-9 rounded-xl bg-emerald-600/20 border border-emerald-700/50">
              <Puzzle className="w-5 h-5 text-emerald-400" />
            </span>
            <h3 className="text-lg font-bold text-zinc-100">
              No browser store? Try the Tampermonkey edition
            </h3>
          </div>
          <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
            The same engine, as a userscript. It embeds the extension&apos;s actual{" "}
            <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-xs">page-audio-hook.js</code>{" "}
            verbatim and runs it on any site — per-site Remember, the music normalizer, mono
            down-mix, the safety limiter and the real popup design, driven from a floating
            button with a live badge. Hotkeys match the add-on:
            <span className="text-zinc-300"> Alt+Shift+↑/↓</span> volume,{" "}
            <span className="text-zinc-300">Alt+Shift+0</span> reset,{" "}
            <span className="text-zinc-300">Alt+Shift+M</span> mono,{" "}
            <span className="text-zinc-300">Alt+Shift+U</span> mute,{" "}
            <span className="text-zinc-300">Alt+Shift+P</span> popup.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href={asset("/tampermonkey/volume-control.user.js")}
              target="_blank"
              rel="noreferrer"
              title="Opens the Tampermonkey install prompt"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors"
            >
              <Download className="w-4 h-4" />
              Install userscript
            </a>
            <a
              href={asset("/tampermonkey/volume-control.user.js")}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors underline underline-offset-2"
            >
              view source
            </a>
            <a
              href="https://github.com/Chaython/volumecontrol/tree/master/tampermonkey"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors underline underline-offset-2"
            >
              repo folder
            </a>
            <span className="text-xs text-zinc-500">
              requires Tampermonkey · auto-updates from this site · also attached to every GitHub release
            </span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- footer --- */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            { }
            <img src={asset("/vc/ico.svg")} alt="" className="w-4 h-4 invert opacity-60" />
            <span>
              Volume Control by{" "}
              <a
                href="https://github.com/Chaython"
                target="_blank"
                rel="noreferrer"
                className="text-zinc-300 hover:text-emerald-400 transition-colors"
              >
                Chaython
              </a>{" "}
              · live preview built with the extension&apos;s own code
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-zinc-300 transition-colors">
              Home
            </Link>
            <a
              href={asset("/stats.html")}
              className="hover:text-zinc-300 transition-colors"
            >
              Statistics
            </a>
            <a
              href="https://github.com/sponsors/Chaython"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 hover:text-zinc-300 transition-colors"
            >
              <Heart className="w-3.5 h-3.5 text-rose-500/80" />
              Sponsor
            </a>
            <a
              href="https://github.com/Chaython/volumecontrol/blob/master/LICENSE"
              target="_blank"
              rel="noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              License
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
