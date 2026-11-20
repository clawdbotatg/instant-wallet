import { tooMany } from "@/lib/limit";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { NextRequest, NextResponse } from "next/server";
import { onrampChallenge } from "@/lib/onramp";
import { passkeyOwner } from "@/lib/passkeyAuth";

export const dynamic = "force-dynamic";

/**
 * Coinbase Pay (Apple Pay, card) into this wallet: `POST /api/onramp` → a one-time pay.coinbase.com link (a
 * 5-minute session token, locked to this address on Base). Only the wallet's own passkey can ask: the body is a
 * Face ID signature over onrampChallenge(address, asset, ts), from a passkey whose Safe signer owns `address`
 * (or, for a Safe not deployed yet, whose counterfactual Safe IS `address`): lib/passkeyAuth.ts. Needs CDP_API_KEY_ID +
 * CDP_API_KEY_SECRET (portal.cdp.coinbase.com, a Secret API key with Onramp).
 */
export async function POST(req: NextRequest) {
  if (await tooMany(req, "onramp", 60, 3600)) return Response.json({ error: "Too many. Wait a bit." }, { status: 429 }); // per IP, every instance
  const b = await req.json().catch(() => ({}));
  const asset = b.asset === "ETH" ? "ETH" : "USDC";
  const who = await passkeyOwner(req, b, "onramp", (address, ts) => onrampChallenge(address, asset, ts));
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: who.status });
  const address = who.address;

  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n");
  if (!apiKeyId || !apiKeySecret) return NextResponse.json({ error: "Deposits aren't set up yet" }, { status: 503 });
  // Vercel sets x-real-ip itself (a client can't spoof it there)
  // A copy on your own computer sees you as 127.0.0.1 or a home address: Coinbase refuses those ("private IP
  // addresses are not allowed"), so none is sent.
  const ip = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "").replace(/^::ffff:/i, "");
  const clientIp = !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip) ? undefined : ip;
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
