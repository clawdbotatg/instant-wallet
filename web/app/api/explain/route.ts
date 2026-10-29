import { NextRequest, NextResponse } from "next/server";
import { fetchPrebuiltRegistryIndex, format, isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { ExternalDataProvider, RegistryIndex, TokenResult } from "@ethereum-sourcify/clear-signing";
import { knownChain } from "@/lib/chains";
import { rpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/**
 * `POST /api/explain {chain, calls: [{to, value, data}]}` -> `{calls: [{what, fields: [{label, value, address?}]} | null]}`.
 * Clear signing (ERC-7730): each call in its contract's own words, from the public registry through Sourcify's
 * formatter. null: no descriptor for that call (the page falls back to lib/safe/describe.ts). Port of wedgie-dev
 * api/explain.ts tier 1 (no 🤖 tier).
 */
type Call = { to: string; value: string; data: string };
type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[] } | null;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MAX_CALLS = 20;
const MAX_DATA = 40_000;

// kept while this function instance is warm
let index: Promise<RegistryIndex | undefined> | null = null;
const registry = () =>
  (index ||= fetchPrebuiltRegistryIndex().catch(() => {
    index = null;
    return undefined;
  }));
const TOKENS = new Map<string, TokenResult | null>();

async function token(chain: number, a: string): Promise<TokenResult | null> {
  const k = `${chain}:${a.toLowerCase()}`;
  if (!TOKENS.has(k)) {
    const m = await rpc<any>(chain, "alchemy_getTokenMetadata", [a]).catch(() => null);
    TOKENS.set(k, m && typeof m.decimals === "number" ? { name: m.name || m.symbol || "", symbol: m.symbol || "?", decimals: m.decimals } : null);
  }
  return TOKENS.get(k)!;
}

const provider = (chain: number): ExternalDataProvider => ({
  resolveToken: (c, a) => token(c || chain, a),
  resolveChainInfo: async c => {
    const n = knownChain(c)?.native;
    return { name: knownChain(c)?.name ?? `chain ${c}`, nativeCurrency: { name: n?.name ?? "Ether", symbol: n?.symbol ?? "ETH", decimals: 18 } };
  },
});

async function clear(chain: number, c: Call): Promise<Told> {
  try {
    const m = await format(
      { chainId: chain, to: c.to, data: c.data, value: BigInt(c.value || 0) },
      { externalDataProvider: provider(chain), descriptorResolverOptions: { type: "github", index: await registry() } as any },
    );
    if (!m.intent && !m.interpolatedIntent) return null;
    if (m.warnings?.some(w => w.code === "NO_DESCRIPTOR" || w.code === "CALLDATA_DECODE_ERROR" || w.code === "NO_FORMAT_MATCH")) return null;
    const fields: Field[] = [];
    for (const f of m.fields || []) for (const x of isFieldGroup(f) ? f.fields : [f]) fields.push({ label: x.label, value: x.value, ...(x.rawAddress ? { address: x.rawAddress } : {}) });
    const intent = typeof m.intent === "string" ? m.intent : m.intent ? (Object.values(m.intent)[0] as string) : "";
    return { what: m.interpolatedIntent || intent, fields };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let b: any;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const chain = Number(b?.chain);
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
  return NextResponse.json({ calls: await Promise.all(calls.map(c => clear(chain, c))) });
}
