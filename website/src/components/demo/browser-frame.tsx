"use client";

/**
 * BrowserFrame — a mock browser window hosting the live preview.
 * The extension icon in the toolbar carries the real badge semantics from
 * background.js (+N green / −N red / 0 gray / MUTE red, cleared on navigation),
 * and anchors the popup replica exactly where a browser action popup appears.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Lock,
  Puzzle,
  Moon,
  Sun,
  X,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_SITES, useExtensionStore } from "@/lib/volume-control/store";
import { asset } from "@/lib/asset-path";
import { ExtensionPopup } from "./extension-popup";
import { MediaPlayground } from "./playground";
import { QuietFmSite } from "./quiet-fm";
import { OptionsPage } from "./options-page";

const OPTIONS_TAB_URL = "chrome-extension://volume-control/options.html";

export function BrowserFrame() {
  const site = useExtensionStore((s) => s.site);
  const navigating = useExtensionStore((s) => s.navigating);
  const popupOpen = useExtensionStore((s) => s.popupOpen);
  const badge = useExtensionStore((s) => s.badge);
  const extensionActive = useExtensionStore((s) => s.extensionActive);
  const openPopup = useExtensionStore((s) => s.openPopup);
  const closePopup = useExtensionStore((s) => s.closePopup);
  const navigate = useExtensionStore((s) => s.navigate);
  const optionsTabOpen = useExtensionStore((s) => s.optionsTabOpen);
  const viewingOptions = useExtensionStore((s) => s.viewingOptions);
  const openOptionsTab = useExtensionStore((s) => s.openOptionsTab);
  const closeOptionsTab = useExtensionStore((s) => s.closeOptionsTab);
  const showOptionsTab = useExtensionStore((s) => s.showOptionsTab);

  const [browserDark, setBrowserDark] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Close the popup when clicking anywhere in the page content, like a real
  // browser action popup.
  const handleContentClick = useCallback(() => {
    closePopup();
  }, [closePopup]);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const { addMediaItems } = useExtensionStore.getState();
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
  }, []);

  // -- drag & drop over the whole browser content area -----------------------
  const onDragEnter = (e: React.DragEvent) => {
    if (viewingOptions) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (viewingOptions) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={cn(
        "relative w-full max-w-5xl mx-auto rounded-2xl overflow-hidden shadow-2xl border transition-colors duration-300",
        browserDark ? "bg-[#202124] border-zinc-700" : "bg-[#dee1e6] border-zinc-300",
      )}
    >
      {/* --- title bar / tabs -------------------------------------------------- */}
      <div className={cn("flex items-end gap-2 px-3 pt-2 pb-0 transition-colors", browserDark ? "bg-[#202124]" : "bg-[#dee1e6]")}>
        <div className="flex gap-1.5 self-center pb-2.5" aria-hidden="true">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 flex items-end gap-1 min-w-0">
          {DEMO_SITES.map((s) => {
            const active = s.key === site.key && !viewingOptions;
            return (
              <button
                key={s.key}
                onClick={() => void navigate(s.key)}
                className={cn(
                  "group flex items-center gap-2 max-w-[240px] min-w-0 px-3 h-9 rounded-t-lg text-xs font-medium transition-colors",
                  active
                    ? browserDark
                      ? "bg-[#35363a] text-zinc-100"
                      : "bg-white text-zinc-800"
                    : browserDark
                      ? "bg-transparent text-zinc-400 hover:bg-[#292a2d]"
                      : "bg-[#c9cdd3] text-zinc-600 hover:bg-[#d3d7dc]",
                )}
                title={s.url}
              >
                { }
                <img src={asset("/vc/ico.svg")} alt="" className="w-4 h-4 shrink-0 saturate-0 opacity-80" />
                <span className="truncate">{s.tabTitle}</span>
                {active && <X className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60" aria-hidden="true" />}
              </button>
            );
          })}
          {optionsTabOpen && (
            <button
              onClick={showOptionsTab}
              className={cn(
                "group flex items-center gap-2 max-w-[240px] min-w-0 px-3 h-9 rounded-t-lg text-xs font-medium transition-colors",
                viewingOptions
                  ? browserDark
                    ? "bg-[#35363a] text-zinc-100"
                    : "bg-white text-zinc-800"
                  : browserDark
                    ? "bg-transparent text-zinc-400 hover:bg-[#292a2d]"
                    : "bg-[#c9cdd3] text-zinc-600 hover:bg-[#d3d7dc]",
              )}
              title={OPTIONS_TAB_URL}
            >
              <img src={asset("/vc/ico.svg")} alt="" className="w-4 h-4 shrink-0" />
              <span className="truncate">Volume Control Settings</span>
              <span
                role="button"
                aria-label="Close options tab"
                title="Close tab"
                className="grid place-items-center w-3.5 h-3.5 rounded-sm opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-black/10"
                onClick={(e) => {
                  e.stopPropagation();
                  closeOptionsTab();
                }}
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </span>
            </button>
          )}
          <button
            className={cn("w-8 h-9 grid place-items-center rounded-t-lg", browserDark ? "text-zinc-400 hover:bg-[#292a2d]" : "text-zinc-500 hover:bg-[#d3d7dc]")}
            aria-label="New tab (decorative)"
            tabIndex={-1}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* --- toolbar ----------------------------------------------------------- */}
      <div
        className={cn(
          "relative flex items-center gap-1 px-3 py-2 border-b transition-colors",
          browserDark ? "bg-[#35363a] border-zinc-700" : "bg-white border-zinc-200",
        )}
      >
        <div className={cn("flex items-center gap-0.5 mr-1", browserDark ? "text-zinc-400" : "text-zinc-500")}>
          <span className="w-8 h-8 grid place-items-center rounded-full hover:bg-black/5 cursor-default" title="Back">
            <ArrowLeft className="w-4 h-4" />
          </span>
          <span className="w-8 h-8 grid place-items-center rounded-full hover:bg-black/5 cursor-default" title="Forward">
            <ArrowRight className="w-4 h-4" />
          </span>
          <span
            className={cn("w-8 h-8 grid place-items-center rounded-full hover:bg-black/5", navigating && "animate-spin")}
            title="Reload"
            role="button"
            aria-label="Reload"
          >
            <RotateCw className="w-4 h-4" />
          </span>
        </div>

        {/* URL bar */}
        <div
          className={cn(
            "flex-1 flex items-center gap-2 h-8 px-3 rounded-full text-sm min-w-0",
            browserDark ? "bg-[#202124] text-zinc-300" : "bg-[#f1f3f4] text-zinc-700",
          )}
        >
          {viewingOptions ? (
            <img src={asset("/vc/ico.svg")} alt="" className={cn("w-3.5 h-3.5 shrink-0", browserDark ? "invert" : "")} />
          ) : (
            <Lock className="w-3.5 h-3.5 shrink-0 opacity-70" aria-hidden="true" />
          )}
          <span className="truncate select-none font-mono text-xs">{viewingOptions ? OPTIONS_TAB_URL : site.url}</span>
          {navigating && !viewingOptions && (
            <span className="ml-auto w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin opacity-60" aria-hidden="true" />
          )}
        </div>

        {/* Extension toolbar buttons */}
        <div className="flex items-center gap-0.5 ml-1">
          <button
            className={cn(
              "relative w-9 h-8 grid place-items-center rounded-md transition-colors",
              popupOpen
                ? browserDark ? "bg-[#423f56] text-zinc-100" : "bg-[#d3e3fd] text-zinc-900"
                : browserDark ? "text-zinc-300 hover:bg-white/10" : "text-zinc-600 hover:bg-black/5",
              !extensionActive && "opacity-60",
            )}
            onClick={() => {
              // The popup cannot open on chrome-extension:// pages (the
              // content script never runs there).
              if (viewingOptions) return;
              if (popupOpen) closePopup();
              else openPopup();
            }}
            title={badge?.title ?? "Volume Control"}
            aria-label="Volume Control"
            aria-pressed={popupOpen}
          >
            { }
            <img src={asset("/vc/ico.svg")} alt="" className={cn("w-5 h-5", browserDark ? "invert" : "")} />
            {badge && (
              <span
                className="absolute -bottom-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-[3px] text-[9px] font-bold leading-[14px] text-white text-center pointer-events-none"
                style={{ backgroundColor: badge.color, boxShadow: "0 0 0 1.5px rgba(255,255,255,0.9)" }}
              >
                {badge.text}
              </span>
            )}
          </button>
          <span className={cn("w-8 h-8 grid place-items-center rounded-md", browserDark ? "text-zinc-400 hover:bg-white/10" : "text-zinc-500 hover:bg-black/5")} title="Extensions">
            <Puzzle className="w-4 h-4" />
          </span>
          <button
            className={cn("w-8 h-8 grid place-items-center rounded-md", browserDark ? "text-zinc-400 hover:bg-white/10" : "text-zinc-500 hover:bg-black/5")}
            title={browserDark ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle browser theme"
            onClick={() => setBrowserDark((v) => !v)}
          >
            {browserDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>

        {popupOpen && !viewingOptions && <ExtensionPopup onOpenSettings={openOptionsTab} browserDark={browserDark} />}
      </div>

      {/* --- navigation progress bar ------------------------------------------- */}
      <div className={cn("relative h-0.5 overflow-hidden", browserDark ? "bg-zinc-700" : "bg-zinc-200")}>
        {navigating && (
          <div
            className={cn("absolute inset-y-0 left-0 w-1/3 rounded-full", browserDark ? "bg-[#8ab4f8]" : "bg-[#1a73e8]")}
            style={{ animation: "vc-load-slide 0.65s ease-in-out infinite" }}
          />
        )}
      </div>

      {/* --- page content ------------------------------------------------------- */}
      <div
        className={cn(
          "relative min-h-[540px] sm:min-h-[560px] overflow-y-auto max-h-[78vh] transition-colors",
          browserDark ? "bg-[#1b1b1f]" : "bg-white",
        )}
        onClick={handleContentClick}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {/* The demo site stays mounted while the options tab is active — its
            audio keeps playing in the background, exactly like a real browser. */}
        <div
          className="min-h-[540px] sm:min-h-[560px]"
          style={viewingOptions ? { display: "none" } : undefined}
        >
          {site.key === "demo.local"
            ? <MediaPlayground browserDark={browserDark} />
            : <QuietFmSite browserDark={browserDark} />}

          {/* Navigating / reloading overlay */}
          {navigating && !viewingOptions && (
            <div className={cn("absolute inset-0 z-40 grid place-items-center", browserDark ? "bg-[#1b1b1f]/80" : "bg-white/80")}>
              <div className="flex flex-col items-center gap-3">
                <span className={cn("w-8 h-8 rounded-full border-2 animate-spin", browserDark ? "border-zinc-500 border-t-transparent" : "border-zinc-300 border-t-zinc-600")} />
                <span className={cn("text-sm", browserDark ? "text-zinc-400" : "text-zinc-500")}>
                  {extensionActive ? "Loading…" : "Reloading…"}
                </span>
              </div>
            </div>
          )}

          {/* File drag overlay */}
          {dragging && !viewingOptions && (
            <div className="absolute inset-0 z-50 p-4 pointer-events-none">
              <div className="w-full h-full rounded-xl border-2 border-dashed border-emerald-500 bg-emerald-500/10 grid place-items-center">
                <div className="text-center pointer-events-none">
                  <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-300">
                    Drop audio or video files
                  </p>
                  <p className="text-sm text-emerald-600/80 dark:text-emerald-400/80">
                    They load into {site.key} — the extension hooks them like any real page media.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* The options page — a full chrome-extension:// tab (1:1 options.html) */}
        {viewingOptions && <OptionsPage browserDark={browserDark} />}
      </div>

    </div>
  );
}
