import type { NextConfig } from "next";

/**
 * Two build modes share this config:
 *
 *  1. Dev / full app (default) — API routes + Prisma persistence, served by
 *     `next dev` on :3000 (or a Node server in production).
 *  2. Static export (GitHub Pages) — enabled by `bun run build:static`, which
 *     sets NEXT_PUBLIC_STATIC_MODE=1. Emits a fully static `out/` folder with
 *     basePath /volumecontrol (https://chaython.github.io/volumecontrol/).
 *     Persistence falls back to localStorage (the store already mirrors
 *     everything there), and the client skips API calls entirely.
 */
const isStaticExport = process.env.NEXT_PUBLIC_STATIC_MODE === "1";

const nextConfig: NextConfig = isStaticExport
  ? {
      output: "export",
      basePath: process.env.NEXT_PUBLIC_BASE_PATH || "/volumecontrol",
      images: { unoptimized: true },
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    }
  : {
      output: "standalone",
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    };

export default nextConfig;
