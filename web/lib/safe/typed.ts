import { formatUnits, getAddress, isAddress } from "viem";
import { chainById } from "../chains";

/**
 * A typed-data request (EIP-712), read for its card. A Safe's signature is good for a token's permit, Permit2 and
 * order books, so one of these can move money with no transaction: the card never says otherwise (audit 11-13).
 *   warn:  the red lines. A permit says who may spend what; anything else says a signature like this can move money.
 *   lines: the message, only the fields its own types name (the ones that are hashed), in their order. A key the
 *          types don't name is not signed, so it's not shown: a site can't add a line of its own.
 */
export type TypedCard = {
  kind: "permit" | "permit2" | "other";
  warn: string[];
  app: string;
  version?: string;
  contract?: string; // domain.verifyingContract: the contract that will take the signature
  chain?: number; // domain.chainId, when it names one
  otherChain?: number; // …and it isn't the network the wallet is asked on
  lines: string[];
};

const ANY = 2n ** 160n - 1n; // Permit2's "any amount"; an ERC-20's is bigger still
const PERMIT2_TYPES = ["PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom", "PermitWitnessTransferFrom", "PermitBatchWitnessTransferFrom"];
const MOST_LINES = 60;

const addr = (a: unknown) => (typeof a === "string" && isAddress(a) ? getAddress(a) : null);
const big = (v: unknown): bigint | null => {
  try {
    return typeof v === "bigint" ? v : typeof v === "number" || typeof v === "string" ? BigInt(v) : null;
  } catch {
    return null;
  }
};
const show = (v: unknown) => {
  const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
};

/** One allowance in words, as describe.ts says an approve(): <Words> draws each address with its name and blockie. */
function allow(chainId: number, spender: string, token: string, amount: bigint | null): string {
  const usdc = chainById(chainId)?.usdc;
  const isUsdc = !!usdc && usdc.toLowerCase() === token.toLowerCase();
  const coin = isUsdc ? "USDC" : `token ${token}`;
  if (amount === 0n) return `Stop ${spender} spending your ${coin}`;
  if (amount === null || amount >= ANY) return `Let ${spender} spend any amount of your ${coin}`;
  return `Let ${spender} spend ${isUsdc ? `up to ${formatUnits(amount, 6)} USDC` : `some of your ${coin}`}`;
}

/** The message's fields, as its types name them (struct by struct, arrays by index). */
function fields(types: Record<string, { name: string; type: string }[]>, type: string, value: any, label: string, out: string[], depth = 0) {
  if (out.length >= MOST_LINES || depth > 6) return;
  const arr = /^(.*)\[\d*\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) return void out.push(`${label}: ${show(value)}`);
    if (!value.length) return void out.push(`${label}: (none)`);
    return value.forEach((v, i) => fields(types, arr[1], v, `${label} ${i + 1}`, out, depth + 1));
  }
  const struct = types[type];
  if (!Array.isArray(struct)) return void out.push(`${label}: ${show(value)}`);
  for (const f of struct) {
    if (typeof f?.name !== "string" || typeof f?.type !== "string") continue;
    fields(types, f.type, value?.[f.name], label ? `${label}.${f.name}` : f.name, out, depth + 1);
  }
}

export function typedCard(raw: any, chainId: number, site: string): TypedCard {
  const { EIP712Domain: _, ...types } = (raw?.types ?? {}) as Record<string, { name: string; type: string }[]>;
  const d = raw?.domain ?? {};
  const m = raw?.message ?? {};
  const primary = String(raw?.primaryType ?? "");
  const names = new Set((Array.isArray(types[primary]) ? types[primary] : []).map(f => f?.name));
  const chain = d.chainId === undefined || d.chainId === null ? undefined : Number(d.chainId);
  const card: TypedCard = {
    kind: "other",
    warn: [],
    app: typeof d.name === "string" && d.name ? d.name.slice(0, 80) : "Unknown app",
    version: typeof d.version === "string" ? d.version.slice(0, 20) : undefined,
    contract: addr(d.verifyingContract) ?? undefined,
    chain,
    otherChain: chain !== undefined && chain !== chainId ? chain : undefined,
    lines: [],
  };
  fields(types, primary, m, "", card.lines);

  const spender = addr(m.spender);
  // a token's own permit (EIP-2612; DAI's has holder / allowed): the token is the contract the domain names
  if (primary === "Permit" && names.has("spender") && spender && card.contract) {
    const amount = names.has("value") ? big(m.value) : names.has("allowed") ? (m.allowed === true || m.allowed === "true" ? null : 0n) : null;
    card.kind = "permit";
    card.warn.push(allow(chainId, spender, card.contract, amount));
  } else if (PERMIT2_TYPES.includes(primary) && spender) {
    // Permit2: the tokens are in the message (details or permitted, one or a list)
    const key = names.has("details") ? "details" : names.has("permitted") ? "permitted" : null;
    const list = key ? (Array.isArray(m[key]) ? m[key] : [m[key]]) : [];
    const said = list.flatMap((x: any) => (addr(x?.token) ? [allow(chainId, spender, addr(x.token)!, big(x.amount))] : []));
    if (said.length && said.length === list.length) {
      card.kind = "permit2";
      card.warn.push(...said.slice(0, 10));
    }
  }
  if (card.kind === "other") card.warn.push(`A signature like this can move money. Only sign if you trust ${site || "the site asking"}.`);
  return card;
}
