/**
 * Public-asset path helper.
 *
 * In the sandbox dev server assets live at the root ("/samples/…", "/vc/…").
 * On GitHub Pages the site is served from the /volumecontrol sub-path, so the
 * static build sets NEXT_PUBLIC_BASE_PATH and every public asset reference is
 * prefixed through this helper. In dev the prefix is "" and paths are
 * completely unchanged.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function asset(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** True when running as a static export (GitHub Pages build). */
export const IS_STATIC_EXPORT = process.env.NEXT_PUBLIC_STATIC_MODE === "1";
