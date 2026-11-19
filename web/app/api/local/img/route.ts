import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { fromLocalCopy } from "@/lib/local";
import { noExternal } from "@/lib/noext";
import { torFetch } from "@/lib/torServer";

export const dynamic = "force-dynamic";

/**
 * GET /api/local/img?u=<https link>: a picture from elsewhere (a coin's logo, an NFT), for a page with No external
 * traffic on (lib/noext.ts). Fetched over Tor, so the picture's host never sees your IP, and kept on disk, so it's
 * asked once. A copy on your own computer only, and only while it's on.
 */
const MAX = 8_000_000;
const TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|avif)|^video\/mp4/;

export async function GET(req: NextRequest) {
  if (!fromLocalCopy(req) || !noExternal() || !process.env.KV_FILE) return NextResponse.json({ error: "not here" }, { status: 404 });
  const u = req.nextUrl.searchParams.get("u") || "";
  if (!/^https?:\/\//.test(u)) return NextResponse.json({ error: "a link" }, { status: 400 });
  const dir = join(dirname(process.env.KV_FILE), "img");
  const f = join(dir, createHash("sha256").update(u).digest("hex"));
  const keep = { "cache-control": "private, max-age=604800" };
  try {
    const [type, body] = [readFileSync(f + ".type", "utf8"), readFileSync(f)];
    return new NextResponse(body, { headers: { "content-type": type, ...keep } });
  } catch {}
  const r = await torFetch(u, { method: "GET", redirect: "follow" }).catch(() => null);
  const type = (r?.headers.get("content-type") || "").split(";")[0].trim();
  if (!r?.ok || !TYPES.test(type)) return new NextResponse(null, { status: 502 });
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > MAX) return new NextResponse(null, { status: 502 });
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, body);
  writeFileSync(f + ".type", type);
  // an SVG is shown as an <img> only (no scripts run there), and never as a page of this site
  return new NextResponse(body, { headers: { "content-type": type, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", ...keep } });
}
