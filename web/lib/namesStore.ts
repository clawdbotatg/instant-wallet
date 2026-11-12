import "server-only";
import { type Address, getAddress, isAddress } from "viem";
import { kv } from "./kv";
import { MAX_NAMES, labelProblem } from "./names";

/**
 * Who holds which inst.eth name (lib/names.ts), in the store the relay uses.
 *   iws:ens:n:<label>   → { a, at }      the wallet a name pays. Written once, never moved, never freed.
 *   iws:ens:a:<address> → { n, all }     a wallet's names: the one it shows (n) and every one it holds (all).
 */
type Held = { a: Address; at: number };
export type Mine = { n: string; all: string[] };

const N = (label: string) => `iws:ens:n:${label}`;
const A = (address: string) => `iws:ens:a:${address.toLowerCase()}`;

function read<T>(v: unknown): T | null {
  if (typeof v !== "string") return (v as T) ?? null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/** The wallet a name pays, or null: nobody has it. */
export async function nameOwner(label: string): Promise<Address | null> {
  if (labelProblem(label)) return null;
  const h = read<Held>(await kv(["GET", N(label)]));
  return h && isAddress(h.a) ? getAddress(h.a) : null;
}

/** A wallet's names, or null: it has none. */
export async function namesOf(address: string): Promise<Mine | null> {
  const m = read<Mine>(await kv(["GET", A(address)]));
  return m && typeof m.n === "string" && Array.isArray(m.all) ? m : null;
}

/** Give `label` to `address` (first come), or switch back to one it already holds. The caller has checked the passkey. */
export async function claimName(label: string, address: Address): Promise<{ ok: true; mine: Mine } | { ok: false; error: string; status: number }> {
  const problem = labelProblem(label);
  if (!label || problem) return { ok: false, error: problem || "Name?", status: 400 };
  const mine = (await namesOf(address)) ?? { n: "", all: [] };
  if (!mine.all.includes(label)) {
    if (mine.all.length >= MAX_NAMES) return { ok: false, error: `A wallet holds ${MAX_NAMES} names at most. Pick one of yours: ${mine.all.join(", ")}`, status: 409 };
    const took = await kv(["SET", N(label), JSON.stringify({ a: address, at: Math.floor(Date.now() / 1000) } satisfies Held), "NX"]);
    // not ours to take, unless an earlier claim of ours wrote the name and died before the list
    if (took !== "OK" && (await nameOwner(label))?.toLowerCase() !== address.toLowerCase()) return { ok: false, error: "Taken", status: 409 };
    mine.all.push(label);
  }
  mine.n = label;
  await kv(["SET", A(address), JSON.stringify(mine)]);
  return { ok: true, mine };
}
