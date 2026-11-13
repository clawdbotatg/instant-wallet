import { type Address, getAddress } from "viem";
import type { Mark } from "clear-signing-safe-kit";
import type { Call } from "./core";
import { WARN, describe, ours } from "./describe";

/** Who a plain send pays (the chain's coin, or a token transfer), so its headline can say so. */
function sentTo(c: Call): string | undefined {
  if (c.data === "0x" && c.value > 0n) return c.to;
  if (c.data.slice(0, 10).toLowerCase() === "0xa9059cbb" && c.data.length >= 138) return getAddress("0x" + c.data.slice(34, 74));
}

export type Field = { label: string; value: string; address?: string };
export type Told = { what: string; short?: string; fields: Field[]; who?: string; swap?: { pay: Move & { most?: boolean }; get: Move & { least?: boolean } }; src?: Exclude<Mark, "bot" | "raw"> } | null;
export type Move = { symbol: string; amount: string; usd?: number; unknown?: boolean };

/** Where a step's words came from (clear-signing-safe-kit MARKS: the same emoji on wedgie.dev). */
export type Src = Mark;
export type Line = { text: string; src: Src; approve?: boolean; warn?: boolean };

export const srcOf = (text: string, t: Told | undefined, mine: string | null): Src =>
  mine ? "code" : t ? (t.src ?? (t.swap ? "code" : "ef")) : text.startsWith(WARN) || text.startsWith("Call ") ? "raw" : "code";

/** An ERC-20 approve(spender, amount): its token:spender and amount. Only whole, exact calldata counts. */
function approval(c: Call): { key: string; amount: bigint } | null {
  if (c.value !== 0n || c.data.length !== 138 || c.data.slice(0, 10).toLowerCase() !== "0x095ea7b3") return null;
  return { key: `${c.to.toLowerCase()}:${c.data.slice(34, 74).toLowerCase()}`, amount: BigInt("0x" + c.data.slice(74)) };
}

/**
 * What a tx is for, one line per step: clear signing's intent and who it's with ("Deposit · Steakhouse Financial"),
 * else ours / describe.ts. Never the relay's fee. brief (headlines: Activity, signing): each step is the descriptor's
 * short intent (its full sentence can carry every address in the call), and who it's with is said once per run of steps.
 *
 * brief leaves out an approval only when the same batch sets it back to 0 (a swap's approve, swap, approve 0): then
 * it can't outlive the batch. Every other approval is said, and so is a call nothing can name ("Unknown call to…"):
 * a headline that hid them read "Send 0.01 USDC" over approve(attacker, any amount) (audit 11-13). `approve` and
 * `warn` mark those lines: a sheet that has one shows its full steps.
 */
export function intents(chainId: number, safe: Address, calls: Call[], told: Told[] | null, brief = false): Line[] {
  // what each token:spender allowance is when the batch ends
  const left = new Map<string, bigint>();
  for (const c of calls) {
    const a = approval(c);
    if (a) left.set(a.key, a.amount);
  }
  const lines = calls.flatMap((c, i) => {
    const mine = ours(chainId, c);
    if (mine?.startsWith("Network fee")) return [];
    const t = mine ? null : told?.[i];
    const said = mine ?? (t ? ((brief && t.short) || t.what) : describe(chainId, safe, c));
    // a send always says who to (Austin 11-11: Activity said "Send" and never where); <Words> draws it as <Who>
    const to = mine ? undefined : sentTo(c);
    let text = to && !/0x[0-9a-fA-F]{40}/.test(said) ? `${said} to ${to}` : said;
    // a call nothing can name: said, never dropped (the steps under it have the function and the bytes)
    const unknown = text.startsWith("Call ");
    if (unknown) text = `Unknown call to ${c.to}`;
    const a = approval(c);
    const gone = !!a && left.get(a.key) === 0n; // set back to 0 before the batch ends
    const approve = !gone && (/^Let /.test(text) || t?.what === "Approve");
    // "Morpho DAO" goes unsaid after "Borrow from Morpho Market"
    const who = t?.who && !text.includes(t.who.split(" ")[0]) ? t.who : undefined;
    return [{ text, approve, gone, warn: unknown || text.startsWith(WARN), who, src: unknown ? ("raw" as Src) : srcOf(text, t ?? undefined, mine) }];
  });
  const keep = brief && lines.some(l => !l.gone) ? lines.filter(l => !l.gone) : lines;
  return keep.map((l, i) => ({
    text: l.who && (!brief || keep[i + 1]?.who !== l.who) ? `${l.text} · ${l.who}` : l.text,
    src: l.src,
    ...(l.approve ? { approve: true } : {}),
    ...(l.warn ? { warn: true } : {}),
  }));
}
