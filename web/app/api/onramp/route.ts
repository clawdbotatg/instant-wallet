import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Coinbase Pay (Apple Pay, card) into this wallet: `GET /api/onramp?address=0x…&asset=USDC|ETH` → a one-time
 * pay.coinbase.com link (a 5-minute session token, locked to this address on Base). Needs CDP_API_KEY_ID +
 * CDP_API_KEY_SECRET (portal.cdp.coinbase.com, a Secret API key with Onramp).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const address = q.get("address") || "";
  const asset = q.get("asset") === "ETH" ? "ETH" : "USDC";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return NextResponse.json({ error: "address?" }, { status: 400 });
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n");
  if (!apiKeyId || !apiKeySecret) return NextResponse.json({ error: "Deposits aren't set up yet" }, { status: 503 });
  // Vercel sets x-real-ip itself (a client can't spoof it there)
  const clientIp = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || undefined;
  try {
    const jwt = await generateJwt({ apiKeyId, apiKeySecret, requestMethod: "POST", requestHost: "api.developer.coinbase.com", requestPath: "/onramp/v1/token" });
    const r = await fetch("https://api.developer.coinbase.com/onramp/v1/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [{ address, blockchains: ["base"] }], assets: [asset], clientIp }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) return NextResponse.json({ error: j.message || j.errorMessage || `Coinbase said ${r.status}` }, { status: 502 });
    const u = new URL("https://pay.coinbase.com/buy/select-asset");
    u.search = new URLSearchParams({ sessionToken: j.token, defaultAsset: asset, defaultNetwork: "base", defaultPaymentMethod: "APPLE_PAY", presetFiatAmount: "50" }).toString();
    return NextResponse.json({ url: u.toString() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Coinbase didn't answer" }, { status: 502 });
  }
}
