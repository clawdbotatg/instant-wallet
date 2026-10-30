import { NextRequest, NextResponse } from "next/server";
import { explainer } from "clear-signing-safe-kit/explain";
import { CHAINS, knownChain } from "@/lib/chains";
import { rpc } from "@/lib/rpcServer";
import { nativeUsd } from "@/lib/safe/relayCore";

export const dynamic = "force-dynamic";

/**
 * `POST /api/explain {chain, safe, calls: [{to, value, data}]}` -> `{calls: [{what, fields: [{label, value, address?}], swap?} | null]}`.
 * Each call in words (clear-signing-safe-kit/explain: a Uniswap swap from its commands, else ERC-7730 clear signing,
 * the same data the wedgie reads). null: nothing for that call (the page falls back to lib/safe/describe.ts). The
 * coins it moves come from clear-sim, asked by the page itself (lib/safe/sim.ts), not from here.
 */
type Call = { to: string; value: string; data: string };

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MAX_CALLS = 20;
const MAX_DATA = 40_000;

const explain = explainer({
  token: async (chain, a) => {
    const m = await rpc<any>(chain, "alchemy_getTokenMetadata", [a]).catch(() => null);
    return m && typeof m.decimals === "number" ? { name: m.name || m.symbol || "", symbol: m.symbol || "?", decimals: m.decimals } : null;
  },
  chain: id => {
    const k = knownChain(id);
    return k ? { name: k.name, native: k.native.symbol } : null;
  },
  trusted: Object.fromEntries(CHAINS.filter(c => c.usdc).map(c => [c.id, [c.usdc!]])),
});

export async function POST(req: NextRequest) {
  let b: any;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const chain = Number(b?.chain);
  const safe = String(b?.safe || "");
  if (!ADDR.test(safe)) return NextResponse.json({ error: "bad safe" }, { status: 400 });
  if (!knownChain(chain)) return NextResponse.json({ error: "no such chain" }, { status: 404 });
  if (!Array.isArray(b.calls) || !b.calls.length || b.calls.length > MAX_CALLS) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const calls: Call[] = [];
  for (const c of b.calls) {
    const to = String(c?.to || "");
    const data = String(c?.data || "0x");
    const value = String(c?.value ?? "0");
    if (!ADDR.test(to) || !HEX.test(data) || data.length > MAX_DATA || !/^\d+$/.test(value)) return NextResponse.json({ error: "bad call" }, { status: 400 });
    calls.push({ to, data, value });
  }
  const told = await Promise.all(calls.map(c => explain(chain, safe, c)));
  // dollars next to a swap's coins: the chain's coin at the relay's price, USDC at $1
  if (told.some(t => t?.swap)) {
    const coin = knownChain(chain)!;
    const usdc = CHAINS.find(c => c.id === chain)?.usdc ? "USDC" : null;
    const px = await nativeUsd(chain).catch(() => null);
    const usd = (m: { symbol: string; amount: string; unknown?: boolean }) =>
      m.unknown || !m.amount ? undefined : m.symbol === coin.native.symbol && px ? Number(m.amount) * px : m.symbol === usdc ? Number(m.amount) : undefined;
    for (const t of told) if (t?.swap) Object.assign(t.swap, { pay: { ...t.swap.pay, usd: usd(t.swap.pay) }, get: { ...t.swap.get, usd: usd(t.swap.get) } });
  }
  return NextResponse.json({ calls: told });
}
