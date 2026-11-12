import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { avatarUrl } from "clear-signing-safe-kit";
import { mustRpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

const MAX = 3_000_000;

/**
 * `GET /api/avatar?name=atg.eth` -> that name's ENS avatar, the picture itself. The browser used to load it from
 * the avatar's own host (euc.li, an IPFS gateway), which then saw the IP and the name of whoever you were about to
 * pay. Now only we ask. It takes a name, never a URL: it can't be used to fetch anything else. Kept a day by the CDN.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name") || "";
  const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "public, s-maxage=300" } });
  if (!/^[^\s./]+(\.[^\s./]+)+$/.test(name) || name.length > 255) return none(400);
  try {
    const client = createPublicClient({ chain: mainnet, transport: http(mustRpc(1)) });
    const url = await avatarUrl(client as any, name);
    if (!url) return none(404);
    let body: ArrayBuffer;
    let type: string;
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
      if (!m) return none(404);
      type = m[1];
      body = new Uint8Array(m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]))).buffer;
    } else {
      const u = new URL(url);
      // a name's owner picks this address: only a public https host, never a bare IP or this machine
      if (u.protocol !== "https:" || /^[\d.]+$|^\[|^localhost$|\.local$|\.internal$/i.test(u.hostname)) return none(404);
      const r = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
      if (!r.ok || Number(r.headers.get("content-length") || 0) > MAX) return none(404);
      type = (r.headers.get("content-type") || "").split(";")[0].trim();
      body = await r.arrayBuffer();
    }
    if (!type.startsWith("image/") || body.byteLength > MAX) return none(404);
    return new NextResponse(body, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        // an SVG can hold a script: opened as a page it must run nothing
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return none(502);
  }
}
