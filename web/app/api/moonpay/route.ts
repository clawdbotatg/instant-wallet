import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

export const dynamic = "force-dynamic";

const CODES = { USDC: "usdc_base", ETH: "eth_base" } as const;

/**
 * MoonPay (card, bank) into this wallet: `GET /api/moonpay?address=0x…&asset=USDC|ETH` → a signed buy link that
 * lands on Base. MoonPay needs a link with a preset wallet signed by our secret key. No passkey needed: the link
 * only says where the coins go, and MoonPay checks the buyer itself. Needs MOONPAY_PK + MOONPAY_SECRET
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
  const host = pk.startsWith("pk_test_") ? "https://buy-sandbox.moonpay.com" : "https://buy.moonpay.com";
  const search =
    "?" + new URLSearchParams({ apiKey: pk, currencyCode: CODES[asset], walletAddress: getAddress(address), baseCurrencyAmount: "50" }).toString();
  const signature = createHmac("sha256", secret).update(search).digest("base64");
  return NextResponse.json({ url: `${host}/${search}&signature=${encodeURIComponent(signature)}`, test: pk.startsWith("pk_test_") });
}
