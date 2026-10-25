import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Remembered per-site settings — the web equivalent of the extension's
 * chrome.storage.local "siteSettings" / "siteNormalizerSettings".
 *
 * GET    /api/settings            → all remembered rows
 * PUT    /api/settings            → upsert { siteKey, volume, mono, muted, normalizerEnabled }
 * DELETE /api/settings?site=key   → remove (Remember toggled off)
 */

const clampDb = (value: unknown): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-32, Math.min(32, n));
};

export async function GET() {
  try {
    const settings = await db.siteSetting.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json({ settings });
  } catch (error) {
    console.error("GET /api/settings failed:", error);
    return NextResponse.json({ settings: [] }, { status: 200 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const siteKey = String(body?.siteKey ?? "").trim();
    if (!siteKey) {
      return NextResponse.json({ error: "siteKey is required" }, { status: 400 });
    }
    const row = await db.siteSetting.upsert({
      where: { siteKey },
      update: {
        volume: clampDb(body.volume),
        mono: Boolean(body.mono),
        muted: Boolean(body.muted),
        normalizerEnabled: Boolean(body.normalizerEnabled),
      },
      create: {
        siteKey,
        volume: clampDb(body.volume),
        mono: Boolean(body.mono),
        muted: Boolean(body.muted),
        normalizerEnabled: Boolean(body.normalizerEnabled),
      },
    });
    return NextResponse.json({ setting: row });
  } catch (error) {
    console.error("PUT /api/settings failed:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site");
    if (!site) {
      return NextResponse.json({ error: "site is required" }, { status: 400 });
    }
    await db.siteSetting.deleteMany({ where: { siteKey: site } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/settings failed:", error);
    return NextResponse.json({ error: "Failed to remove settings" }, { status: 500 });
  }
}
