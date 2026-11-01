import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

export const dynamic = "force-dynamic";

const CODES = { USDC: "usdc_base", ETH: "eth_base" } as const;
// test mode has no Base coins: sandbox links use Ethereum's (no real money moves there)
const TEST_CODES = { USDC: "usdc", ETH: "eth" } as const;

/**
 * MoonPay (card, bank) into this wallet: `GET /api/moonpay?address=0x…&asset=USDC|ETH` → a signed buy link that
 * lands on Base. MoonPay needs a link with a preset wallet signed by our secret key. No passkey needed: the link
 * only says where the coins go, and MoonPay checks the buyer itself. MoonPay also wants the link tied to the buyer's IP
 * (allowedIpAddress = HMAC of it): the phone that asks here is the one that opens it. Needs MOONPAY_PK + MOONPAY_SECRET
 * (dashboard.moonpay.com → Developers); a pk_test_ key makes sandbox links.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const address = q.get("address") || "";
  if (!isAddress(address)) return NextResponse.json({ error: "address?" }, { status: 400 });
  const asset = q.get("asset") === "ETH" ? "ETH" : "USDC";
  const pk = process.env.MOONPAY_PK;
  const secret = process.env.MOONPAY_SECRET;
  if (!pk || !secret) return NextResponse.json({ error: "MoonPay isn't set up yet" }, { status: 503 });
  const test = pk.startsWith("pk_test_");
  const host = test ? "https://buy-sandbox.moonpay.com" : "https://buy.moonpay.com";
  const p = new URLSearchParams({ apiKey: pk, currencyCode: (test ? TEST_CODES : CODES)[asset], walletAddress: getAddress(address), baseCurrencyAmount: "50" });
  // Vercel sets x-real-ip itself (a client can't spoof it there)
  const ip = canonIp(req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "");
  if (ip) p.set("allowedIpAddress", createHmac("sha256", secret).update(ip).digest("base64"));
  const search = "?" + p.toString();
  const signature = createHmac("sha256", secret).update(search).digest("base64");
  return NextResponse.json({ url: `${host}/${search}&signature=${encodeURIComponent(signature)}`, test });
}

/** The form MoonPay hashes: IPv4 dotted, IPv6 RFC 5952 (lowercase, :: compressed), IPv4-mapped IPv6 as IPv4. */
function canonIp(raw: string): string {
  const ip = raw.trim().replace(/^\[|\](:\d+)?$/g, "");
  if (!ip) return "";
  if (!ip.includes(":")) return ip.split(".").map(n => String(Number(n))).join(".");
  try {
    const h = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) return [parseInt(m[1], 16) >> 8, parseInt(m[1], 16) & 255, parseInt(m[2], 16) >> 8, parseInt(m[2], 16) & 255].join(".");
    return h;
  } catch {
    return "";
  }
}
