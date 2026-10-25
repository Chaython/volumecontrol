import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Global normalizer configuration — the web equivalent of the extension's
 * chrome.storage.local "normalizerConfig" + "normalizerDefaultEnabled".
 *
 * GET /api/normalizer   → { config, defaultEnabled }
 * PUT /api/normalizer   → update config and/or defaultEnabled
 */

const CONFIG_SINGLETON = "singleton";

interface NormalizerConfigPayload {
  mode?: "music" | "adaptive";
  targetDb?: number;
  maxBoostDb?: number;
  ceilingDb?: number;
  responseMs?: number;
}

function clampConfig(input: NormalizerConfigPayload) {
  const numberOr = (candidate: unknown, fallback: number) => {
    if (candidate == null || (typeof candidate === "string" && !candidate.trim())) return fallback;
    const n = Number(candidate);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    mode: input.mode === "music" ? "music" : "adaptive",
    targetDb: Math.max(-30, Math.min(-6, numberOr(input.targetDb, -16))),
    maxBoostDb: Math.max(0, Math.min(24, numberOr(input.maxBoostDb, 12))),
    ceilingDb: Math.max(-6, Math.min(-0.1, numberOr(input.ceilingDb, -1))),
    responseMs: Math.max(100, Math.min(3000, Math.round(numberOr(input.responseMs, 600)))),
  };
}

async function readRow() {
  return db.globalConfig.upsert({
    where: { id: CONFIG_SINGLETON },
    update: {},
    create: { id: CONFIG_SINGLETON, normalizerConfigJson: "", normalizerDefaultEnabled: false },
  });
}

export async function GET() {
  try {
    const row = await readRow();
    let config: NormalizerConfigPayload | null = null;
    if (row.normalizerConfigJson) {
      try { config = JSON.parse(row.normalizerConfigJson); } catch { config = null; }
    }
    return NextResponse.json({ config, defaultEnabled: row.normalizerDefaultEnabled });
  } catch (error) {
    console.error("GET /api/normalizer failed:", error);
    return NextResponse.json({ config: null, defaultEnabled: false });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const row = await readRow();
    let configJson = row.normalizerConfigJson;
    if (body?.config && typeof body.config === "object") {
      const merged = { ...JSON.parse(configJson || "{}"), ...body.config };
      configJson = JSON.stringify(clampConfig(merged));
    }
    const defaultEnabled = typeof body?.defaultEnabled === "boolean"
      ? body.defaultEnabled
      : row.normalizerDefaultEnabled;
    const updated = await db.globalConfig.update({
      where: { id: CONFIG_SINGLETON },
      data: { normalizerConfigJson: configJson, normalizerDefaultEnabled: defaultEnabled },
    });
    return NextResponse.json({ ok: true, config: configJson ? JSON.parse(configJson) : null, defaultEnabled: updated.normalizerDefaultEnabled });
  } catch (error) {
    console.error("PUT /api/normalizer failed:", error);
    return NextResponse.json({ error: "Failed to save normalizer config" }, { status: 500 });
  }
}
