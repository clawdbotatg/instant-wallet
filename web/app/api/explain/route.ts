import { NextRequest, NextResponse } from "next/server";
import { fetchPrebuiltRegistryIndex, format, isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { DescriptorResolver, ExternalDataProvider, RegistryIndex, TokenResult, TrustedTokens } from "@ethereum-sourcify/clear-signing";
import { CHAINS, knownChain } from "@/lib/chains";
import { rpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/**
 * `POST /api/explain {chain, safe, calls: [{to, value, data}]}` -> `{calls: [{what, fields: [{label, value, address?}]} | null]}`.
 * Clear signing (ERC-7730): each call in its contract's own words, from the public registry through Sourcify's
 * formatter. null: no descriptor for that call (the page falls back to lib/safe/describe.ts). Port of wedgie-dev
 * api/explain.ts tier 1 (no 🤖 tier).
 * The same data the wedgie reads (wedgie-dev wire/release.py): the EF registry, then ours on top (OURS, clawdbotatg/clear-descriptors:
 * staged there before a registry PR), USDC as a trusted ERC-20. A call to the Safe itself reads as the 0x5afe… "This Safe"
 * binding. Its Roles module (the daily limit) has no descriptor yet: describe.ts reads it.
 */
type Call = { to: string; value: string; data: string };
type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[] } | null;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MAX_CALLS = 20;
const MAX_DATA = 40_000;

const REGISTRY = "https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/";
const OURS = "https://raw.githubusercontent.com/clawdbotatg/clear-descriptors/main/";
const THIS_SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";
const TRUSTED: TrustedTokens = Object.fromEntries(CHAINS.filter(c => c.usdc).map(c => [c.id, { [c.usdc!]: "erc20" as const }]));

const getJson = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(10_000) }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  });

/** Our descriptors: the files clear-descriptors' show.json adds (what wedgie.dev's build adds), by raw URL. */
async function ours(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const add: string[] = (await getJson(`${OURS}show.json`).catch(() => null))?.add ?? [];
  await Promise.all(
    add.map(async p => {
      const d = await getJson(OURS + p).catch(() => null);
      for (const x of d?.context?.contract?.deployments ?? []) out[`eip155:${x.chainId}:${String(x.address).toLowerCase()}`] = OURS + p;
    }),
  );
  return out;
}

// kept while this function instance is warm (an hour: a new descriptor of ours shows up without a deploy)
let built: { at: number; r: Promise<DescriptorResolver | undefined> } | null = null;
function resolver() {
  if (built && Date.now() - built.at < 3600_000) return built.r;
  const r = Promise.all([fetchPrebuiltRegistryIndex(), ours()])
    .then(([reg, our]): DescriptorResolver => {
      const lower = Object.fromEntries(Object.entries(reg.calldataIndex).map(([k, v]) => [k.toLowerCase(), v]));
      const index: RegistryIndex = { ...reg, calldataIndex: { ...lower, ...our } };
      return { index, fetchDescriptor: path => getJson(path.startsWith("https://") ? path : REGISTRY + path) };
    })
    .catch(() => {
      built = null;
      return undefined;
    });
  built = { at: Date.now(), r };
  return r;
}
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

async function clear(chain: number, safe: string, c: Call): Promise<Told> {
  try {
    const res = await resolver();
    if (!res) return null;
    const to = c.to.toLowerCase() === safe.toLowerCase() ? THIS_SAFE : c.to;
    const m = await format(
      { chainId: chain, to, data: c.data, value: BigInt(c.value || 0), from: safe },
      { externalDataProvider: provider(chain), descriptorResolverOptions: { type: "custom", resolver: res, trustedTokens: TRUSTED } },
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
  return NextResponse.json({ calls: await Promise.all(calls.map(c => clear(chain, safe, c))) });
}
