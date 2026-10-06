import { NextRequest, NextResponse } from "next/server";
import { type Address, getAddress, isAddress, isHex, zeroAddress } from "viem";
import { chainById } from "@/lib/chains";
import { LIFI_DIAMOND, type SwapRoute } from "@/lib/safe/swap";

export const dynamic = "force-dynamic";

/**
 * A LI.FI route for a swap, checked before the browser sees it (docs/SWAP.md):
 *   GET /api/swap/quote?fromChain=8453&toChain=1&fromToken=0x…&toToken=0x…&amount=…&safe=0x…&slippageBps=50
 * The tx must go to LI.FI's diamond and pay the same Safe on the other side. LIFI_API_KEY (optional) lifts the
 * public rate limit.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    const fromChain = Number(q.get("fromChain"));
    const toChain = Number(q.get("toChain"));
    const fromToken = q.get("fromToken") || "";
    const toToken = q.get("toToken") || "";
    const safe = q.get("safe") || "";
    const amount = q.get("amount") || "";
    const slippageBps = Math.min(500, Math.max(10, Number(q.get("slippageBps")) || 50));
    if (!chainById(fromChain) || !chainById(toChain)) throw new Error("chain not enabled");
    if (!isAddress(fromToken) || !isAddress(toToken) || !isAddress(safe) || !/^\d+$/.test(amount)) throw new Error("bad request");
    const url = new URL("https://li.quest/v1/quote");
    for (const [k, v] of Object.entries({
      fromChain,
      toChain,
      fromToken,
      toToken,
      fromAmount: amount,
      fromAddress: safe,
      toAddress: safe,
      slippage: slippageBps / 10_000,
      integrator: "instant-wallet",
      order: "CHEAPEST",
    }))
      url.searchParams.set(k, String(v));
    const key = process.env.LIFI_API_KEY;
    const r = await fetch(url, { headers: key ? { "x-lifi-api-key": key } : {}, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return NextResponse.json({ error: j?.message || `LI.FI: ${r.status}` }, { status: 502 });

    const t = j.transactionRequest;
    const e = j.estimate;
    const me = getAddress(safe);
    // what we'll ask the owners to sign must be exactly what was asked for
    if (!t || !e || getAddress(t.to) !== LIFI_DIAMOND) throw new Error("LI.FI sent an unexpected contract");
    if (Number(t.chainId) !== fromChain || !isHex(t.data)) throw new Error("LI.FI sent a tx for another chain");
    if (getAddress(j.action.fromAddress) !== me || getAddress(j.action.toAddress) !== me) throw new Error("LI.FI changed the receiver");
    if (!t.data.toLowerCase().includes(me.slice(2).toLowerCase())) throw new Error("LI.FI's tx doesn't name this wallet");
    if (String(j.action.fromAmount) !== amount) throw new Error("LI.FI changed the amount");
    const native = getAddress(fromToken) === zeroAddress;
    const approval = native ? undefined : getAddress(e.approvalAddress);
    if (approval && approval !== LIFI_DIAMOND) throw new Error("LI.FI asked to approve another contract");
    if (BigInt(t.value) !== (native ? BigInt(amount) : 0n)) throw new Error("LI.FI's ETH value doesn't match");

    const tok = (x: any, chainId: number) => ({
      chainId,
      address: getAddress(x.address) as Address,
      symbol: String(x.symbol),
      decimals: Number(x.decimals),
      logo: x.logoURI,
      priceUsd: Number(x.priceUSD) || undefined,
    });
    const gas = (e.gasCosts ?? []).reduce((s: bigint, g: any) => s + BigInt(g.estimate || 0), 0n) || BigInt(t.gasLimit || 500_000);
    const route: SwapRoute = {
      via: "lifi",
      tool: j.toolDetails?.name || j.tool || "LI.FI",
      from: tok(j.action.fromToken, fromChain),
      to: tok(j.action.toToken, toChain),
      fromAmount: amount,
      toAmount: String(e.toAmount),
      toAmountMin: String(e.toAmountMin),
      toUsd: Number(e.toAmountUSD) || undefined,
      fromUsd: Number(e.fromAmountUSD) || undefined,
      seconds: fromChain === toChain ? 0 : Number(e.executionDuration) || 60,
      gas: gas.toString(),
      tx: { to: LIFI_DIAMOND, data: t.data, value: BigInt(t.value).toString() },
      approval,
      until: Date.now() + 60_000,
    };
    return NextResponse.json(route);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
