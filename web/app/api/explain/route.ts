import { NextRequest, NextResponse } from "next/server";
import { fetchPrebuiltRegistryIndex, format, isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { DescriptorResolver, ExternalDataProvider, RegistryIndex, TokenResult, TrustedTokens } from "@ethereum-sourcify/clear-signing";
import { formatUnits, toEventSelector } from "viem";
import { CHAINS, knownChain } from "@/lib/chains";
import { RELAY } from "@/lib/safe/describe";
import { rpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/**
 * `POST /api/explain {chain, safe, calls: [{to, value, data}]}` -> `{calls: [{what, fields: [{label, value, address?}]} | null], sim}`.
 * sim: what the whole batch does to the Safe's coins right now (`simulate`), or null when the chain can't say.
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

type Sim = { pay: Move[]; get: Move[]; fee: Move[]; fails?: string } | null;
type Move = { symbol: string; amount: string };
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // eth_simulateV1 traceTransfers: native coin moves, as Transfer logs

/** The batch run as the Safe on the latest block (eth_simulateV1, each call after the last): the coins it pays, gets,
 * and pays the relay. Read from Transfer logs, so it's what the contracts really do, whatever the calldata claims. */
async function simulate(chain: number, safe: string, calls: Call[]): Promise<Sim> {
  const r = await rpc<any[]>(chain, "eth_simulateV1", [
    { blockStateCalls: [{ calls: calls.map(c => ({ from: safe, to: c.to, data: c.data, value: "0x" + BigInt(c.value).toString(16) })) }], traceTransfers: true, validation: false },
    "latest",
  ]).catch(() => null);
  const out = r?.[0]?.calls as any[] | undefined;
  if (!out || out.length !== calls.length) return null;
  const bad = out.findIndex(c => c.status !== "0x1");
  if (bad >= 0) return { pay: [], get: [], fee: [], fails: `step ${bad + 1}: ${out[bad].error?.message || "reverted"}` };
  const me = safe.toLowerCase();
  const net = new Map<string, bigint>();
  const fee = new Map<string, bigint>();
  for (const c of out)
    for (const l of c.logs ?? []) {
      if (l.topics?.[0] !== TRANSFER || l.topics.length !== 3 || l.data === "0x") continue;
      const [from, to] = [l.topics[1], l.topics[2]].map((t: string) => "0x" + t.slice(26));
      const tok = String(l.address).toLowerCase();
      const v = BigInt(l.data);
      if (from === me && to === RELAY) fee.set(tok, (fee.get(tok) ?? 0n) + v);
      else if (from === me) net.set(tok, (net.get(tok) ?? 0n) - v);
      if (to === me && from !== me) net.set(tok, (net.get(tok) ?? 0n) + v);
    }
  const move = async (tok: string, v: bigint): Promise<Move> => {
    if (tok === NATIVE) return { symbol: knownChain(chain)?.native.symbol ?? "ETH", amount: formatUnits(v, 18) };
    const t = await token(chain, tok);
    return t ? { symbol: t.symbol, amount: formatUnits(v, t.decimals) } : { symbol: `token ${tok.slice(0, 6)}…${tok.slice(-4)}`, amount: v.toString() };
  };
  const nz = [...net].filter(([, v]) => v !== 0n);
  return {
    pay: await Promise.all(nz.filter(([, v]) => v < 0n).map(([t, v]) => move(t, -v))),
    get: await Promise.all(nz.filter(([, v]) => v > 0n).map(([t, v]) => move(t, v))),
    fee: await Promise.all([...fee].map(([t, v]) => move(t, v))),
  };
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
  const [told, sim] = await Promise.all([Promise.all(calls.map(c => clear(chain, safe, c))), simulate(chain, safe, calls).catch(() => null)]);
  return NextResponse.json({ calls: told, sim });
}
