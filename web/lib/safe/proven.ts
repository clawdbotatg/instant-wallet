import type { Address } from "viem";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { LIGHT_CHAINS, LIGHT_CHUNK, lightBalances } from "./light";

/**
 * Home's balances, proven in the background (docs/PROVEN-BALANCES.md). Home draws what our server says at once; this
 * browser's light client (light.ts) then proves the same balances on Ethereum and Gnosis, and each coin gets a state:
 *   unchecked  no proof yet, or the number changed since the last one
 *   checked    the proof says the same number (within 0.001%: coins that grow every block, stETH, Aave)
 *   wrong      twice, a proof said another number and then the server said its number again
 *   cant       the proof failed (prover down, too old) or the network has no light client
 * A new payment is never wrong. Only this device's own clock is used (how long since a number showed up, since a proof
 * landed), never a block's time: a phone's clock can be off. A proof that disagrees is only a doubt; it becomes a
 * strike when the server, asked again after it, still says the same number. A proof in the first SETTLE_MS of a
 * number may be for a block before it, so it isn't even a doubt.
 *
 * The rule is `next` (pure: no clock, no network, tools/proven-check.mts tests it); `useProven` runs it in the page.
 */

export type ProvenState = "unchecked" | "checked" | "wrong" | "cant";
export type Row = {
  chainId: number;
  asset: string; // lowercase; 0x000…0 is the native coin
  shown: bigint; // what the server says
  since: number; // ms: when this number first showed
  usd: number; // to prove the biggest first
  state: ProvenState;
  strikes: number; // disagreeing proofs in a row that the server then said its number again after
  strikeBlock?: number; // the last strike's block: one block is one strike, however often it's asked
  doubt?: { block: number; at: number }; // a proof that disagreed (at: ms, this device), waiting for the server's next read
  proven?: bigint | null; // the last proof's number (null: that coin's call failed)
  block?: number; // and its block
};
export type Table = Readonly<Record<string, Row>>;
type Shown = { chainId: number; asset: string; balance: string; usd: number | null };
export type ProvenEvent =
  | { kind: "seen"; at: number; assets: Shown[]; late?: number[] } // a portfolio read landed at `at` (ms); late: networks it didn't read
  | { kind: "proved"; chainId: number; block: number; time: number; at: number; balances: Record<string, bigint | null> } // at: ms, when it landed. time (the block's, s) is never used: a device's clock can be off
  | { kind: "failed"; chainId: number; assets: string[] };

export const provenKey = (chainId: number, asset: string) => `${chainId}:${asset.toLowerCase()}`;
export const canProve = (chainId: number) => LIGHT_CHAINS.includes(chainId);

/** The same number, or within 0.001% of the bigger one. So zero is only ever near zero (against 0 the gap is the
 * whole number): dust isn't "about nothing", and nothing isn't "about dust". */
export function near(a: bigint, b: bigint): boolean {
  if (a === b) return true;
  const d = a > b ? a - b : b - a;
  return d * 100_000n <= (a > b ? a : b);
}

// A proof can be for a block up to 90 s old (max_latest_age_seconds in light.ts), so for two minutes after a number
// shows up a proof that disagrees may just be from before it (a payment the server saw first). 120 s: those 90 s plus
// a 15 s portfolio read (SafeApp's timeout) and a little slack.
export const SETTLE_MS = 120_000;

/** The next table after an event. Unchanged rows keep their object; nothing changed returns the same table.
 * `settle` is SETTLE_MS; only a test passes another. */
export function next(t: Table, e: ProvenEvent, settle = SETTLE_MS): Table {
  if (e.kind === "seen") return seen(t, e.at, e.assets, e.late);
  if (e.kind === "failed") return edit(t, e.chainId, e.assets, r => (r.state === "unchecked" ? { ...r, state: "cant" } : r));
  return edit(t, e.chainId, Object.keys(e.balances), r => proved(r, e.block, e.at, e.balances[r.asset], settle));
}

function seen(t: Table, at: number, assets: Shown[], late: number[] = []): Table {
  const out: Record<string, Row> = {};
  let changed = false;
  // a late network wasn't read this time (the page keeps its old rows: keepLate): its rows stay exactly as they were
  for (const [k, r] of Object.entries(t)) if (late.includes(r.chainId)) out[k] = r;
  for (const a of assets) {
    if (!canProve(a.chainId) || late.includes(a.chainId)) continue;
    const k = provenKey(a.chainId, a.asset);
    const r = t[k];
    const shown = BigInt(a.balance);
    const usd = a.usd ?? 0;
    if (r && r.shown === shown) {
      let n = r.usd === usd ? r : { ...r, usd };
      // the server says it again after a proof that disagreed: now that's a strike
      if (r.doubt && at > r.doubt.at) {
        const strikes = r.strikes + 1;
        n = { ...n, strikes, strikeBlock: r.doubt.block, doubt: undefined, state: strikes >= 2 ? "wrong" : r.state };
      }
      out[k] = n;
      changed ||= n !== r;
      continue;
    }
    changed = true;
    // a new number starts over: its own "since", no strikes, no doubt. A coin that grows every block stays checked
    // while the new number is still within 0.001% of the last proof (Home reads every few seconds: it would never stay full).
    const still = r?.state === "checked" && r.proven != null && near(r.proven, shown);
    out[k] = { ...r, chainId: a.chainId, asset: a.asset.toLowerCase(), shown, since: at, usd, state: still ? "checked" : "unchecked", strikes: 0, strikeBlock: undefined, doubt: undefined };
  }
  if (!changed && Object.keys(out).length === Object.keys(t).length) return t;
  return out;
}

function proved(r: Row, block: number, at: number, p: bigint | null | undefined, settle: number): Row {
  if (p === undefined || (r.block !== undefined && block < r.block)) return r; // not asked, or older than what we have
  const proven = { ...r, proven: p, block };
  if (p !== null && near(p, r.shown)) return { ...proven, state: "checked", strikes: 0, strikeBlock: undefined, doubt: undefined };
  // another number, or none (no code, reverts: a coin the server made up)
  const state = r.state === "wrong" ? "wrong" : "unchecked";
  if (at - r.since < settle) return { ...proven, state }; // may be for a block before the number showed up
  if (block > (r.strikeBlock ?? -1)) return { ...proven, state, doubt: { block, at } };
  return { ...proven, state };
}

function edit(t: Table, chainId: number, assets: string[], f: (r: Row) => Row): Table {
  let out: Record<string, Row> | undefined;
  for (const a of assets) {
    const k = provenKey(chainId, a);
    const r = t[k];
    if (!r) continue;
    const n = f(r);
    if (n !== r) (out ??= { ...t })[k] = n;
  }
  return out ?? t;
}

// a re-check (`pick(…, true)`) proves again this many of the biggest coins, so a spend the server hides is caught
export const RECHECK_COINS = 20;

/** The coins of one network to prove next, biggest first: every one without a verdict (but not one whose doubt waits
 * for the server's next read: a new proof can't settle it), and on a re-check the biggest RECHECK_COINS again. At most
 * LIGHT_CHUNK (one call). */
export function pick(t: Table, chainId: number, recheck: boolean): string[] {
  const rows = Object.values(t)
    .filter(r => r.chainId === chainId)
    .sort((a, b) => b.usd - a.usd);
  const need = rows.filter(r => r.state !== "checked" && !r.doubt); // a wrong row too: the chain may have come round to the number
  const all = new Set([...need, ...(recheck ? rows.slice(0, RECHECK_COINS) : [])].map(r => r.asset));
  return [...all].slice(0, LIGHT_CHUNK);
}

/** A coin's state: a network without a light client is always cant; a coin not seen yet is unchecked. */
export function stateOf(t: Table, a: { chainId: number; asset: string }): ProvenState {
  if (!canProve(a.chainId)) return "cant";
  return t[provenKey(a.chainId, a.asset)]?.state ?? "unchecked";
}

// ---- in the page ----

/** Settings → Your node, on a network with a light client: prove its balances in this browser. Off by default, per
 * network. No network given: is any on (then full means proven, and every other network's coins stay faded). */
const KEY = "iws.proven";
function ons(): number[] {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "on") return LIGHT_CHAINS; // the first switch was one for both
    return (JSON.parse(v || "[]") as number[]).filter(canProve);
  } catch {
    return [];
  }
}
export const provenOn = (chainId?: number): boolean => (chainId === undefined ? ons().length > 0 : ons().includes(chainId));
export function setProven(chainId: number, on: boolean) {
  const all = ons().filter(c => c !== chainId);
  try {
    localStorage.setItem(KEY, JSON.stringify(on ? [...all, chainId] : all));
  } catch {}
  reset(wallet);
}

// The pace, per network. A round of n coins costs about n node calls (measured 11-13, tools/proven-measure.mts: one
// eth_createAccessList + 1.1 to 1.3 eth_getProof per coin, + each contract's code the first time). Through our
// /api/rpc those count against its per-IP limit, 600 a minute and 20,000 a day (app/api/rpc/[chain]/route.ts), with
// every other read of the wallet. So a network starts its next round no sooner than PER_COIN_MS per coin just proven
// (50 coins: 30 s, ≈2 calls/s, both networks together under half the minute limit), and never twice in one block.
const BLOCK_MS = 12_000; // a new proof sooner is for the same block (Ethereum's slot; the prover's "latest" moves no faster)
const PER_COIN_MS = 600;
// The re-check of the biggest coins, for a spend the server hides: ≈25 node calls per network (RECHECK_COINS coins),
// so ≈50 for both networks. Every 5 min while someone is using the page: 12 an hour × 50 ≈ 600 calls an hour (once a
// minute would be 3,000, the day's 20,000 gone in under 7 hours). Left alone (no touch, key or scroll for a minute,
// as Home's own idle()), every 30 min: 2 × 50 = 100 an hour, 2,400 for a tab left open all day (5 min would be
// 14,400 of the 20,000, with every other read of the wallet still to come).
const RECHECK_MS = 5 * 60_000;
const IDLE_RECHECK_MS = 30 * 60_000;
const IDLE_MS = 60_000; // Home's idle(): a minute untouched
const RETRY_MS = 30_000; // a failed proof: again after 30 s, then 60, 120… up to RECHECK_MS (a prover that's down)
const BACK_MS = 5_000; // back to the tab: prove after the page's own read on return (see()), or this long, whichever is first

let wallet: string | undefined;
let table: Table = {};
const subs = new Set<() => void>();
const busy = new Set<number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const notBefore = new Map<number, number>();
const rechecked = new Map<number, number>();
const fails = new Map<number, number>();
let settle = SETTLE_MS;
/** Tests only (tools/proven-measure.mts store): a shorter SETTLE_MS, so a live run doesn't take minutes. */
export const setSettleForTest = (ms: number) => void (settle = ms);
// and the browser test (tools/proven-e2e.mjs) on a dev server. Next writes NODE_ENV into the bundle, so a production
// build has no such hook: no page can shorten the wait on our site.
const DEV = process.env.NODE_ENV !== "production";
if (DEV && typeof window !== "undefined") (window as any).__proven = { settle: setSettleForTest, table: () => table };
let touched = Date.now();
const recheckMs = () => (Date.now() - touched > IDLE_MS ? IDLE_RECHECK_MS : RECHECK_MS);

function apply(e: ProvenEvent) {
  const n = next(table, e, settle);
  if (n === table) return;
  table = n;
  subs.forEach(f => f());
}
function reset(w: string | undefined) {
  wallet = w;
  table = {};
  timers.forEach(clearTimeout);
  timers.clear();
  [notBefore, rechecked, fails].forEach(m => m.clear());
  subs.forEach(f => f());
}
const hidden = () => typeof document !== "undefined" && document.hidden;

/** When this network proves next: at once (or as soon as the pace allows) when a coin has no verdict, else at its re-check. */
function plan(chainId: number) {
  clearTimeout(timers.get(chainId));
  timers.delete(chainId);
  if (!provenOn(chainId) || hidden() || busy.has(chainId) || !Object.values(table).some(r => r.chainId === chainId)) return;
  const soon = notBefore.get(chainId) ?? 0;
  const at = pick(table, chainId, false).length ? soon : Math.max(soon, (rechecked.get(chainId) ?? 0) + recheckMs());
  timers.set(chainId, setTimeout(() => void round(chainId), Math.max(0, at - Date.now())));
}

/** One proof for one network: one at a time per network, never in a hidden tab. */
async function round(chainId: number) {
  timers.delete(chainId);
  const w = wallet;
  if (!w || !provenOn(chainId) || hidden() || busy.has(chainId)) return;
  const recheck = Date.now() - (rechecked.get(chainId) ?? 0) >= recheckMs();
  const coins = pick(table, chainId, recheck);
  if (!coins.length) return;
  busy.add(chainId);
  try {
    // the same node and prover as the preview's light client (sim.ts): your own node when you set one, never ours instead
    const [{ rpcPath }, { lightProver, WASM }] = await Promise.all([import("@/lib/chains"), import("./sim")]);
    const r = await lightBalances({ chainId, wallet: w as Address, coins: coins as Address[], rpc: rpcPath(chainId), prover: lightProver(chainId), wasm: WASM });
    if (w !== wallet) return;
    apply({ kind: "proved", chainId, ...r, at: Date.now() });
    fails.delete(chainId);
    if (recheck) rechecked.set(chainId, Date.now());
    notBefore.set(chainId, Date.now() + Math.max(BLOCK_MS, coins.length * PER_COIN_MS));
  } catch (e) {
    if (DEV) console.warn("proven: a round failed", chainId, coins.length, e);
    if (w !== wallet) return;
    apply({ kind: "failed", chainId, assets: coins });
    const f = (fails.get(chainId) ?? 0) + 1;
    fails.set(chainId, f);
    notBefore.set(chainId, Date.now() + Math.min(RETRY_MS * 2 ** (f - 1), RECHECK_MS));
  } finally {
    busy.delete(chainId);
    if (w === wallet) plan(chainId);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    timers.forEach(clearTimeout);
    timers.clear();
    // back: Home reads its balances again on return, and that read (see()) starts the proofs; else these few seconds do
    if (!hidden()) LIGHT_CHAINS.forEach(c => timers.set(c, setTimeout(() => plan(c), BACK_MS)));
  });
  // someone's here again after a minute alone: the re-check goes back from 30 min to 5
  const touch = () => {
    const was = Date.now() - touched > IDLE_MS;
    touched = Date.now();
    if (was) LIGHT_CHAINS.forEach(c => busy.has(c) || plan(c));
  };
  for (const e of ["pointerdown", "keydown", "wheel", "touchmove"]) window.addEventListener(e, touch, { passive: true, capture: true });
}

/**
 * A portfolio read landed: note its numbers and prove what needs it. Call it on EVERY read, the same numbers again
 * too: a read that repeats a number after a proof disagreed with it is what makes a strike. `late`: the read's
 * `portfolio.late` (networks it didn't read; their rows are left as they were).
 */
export function see(address: Address, assets: readonly Shown[], late?: readonly number[]) {
  if (!provenOn()) return;
  if (address.toLowerCase() !== wallet) reset(address.toLowerCase());
  apply({ kind: "seen", at: Date.now(), assets: [...assets], late: late ? [...late] : undefined });
  LIGHT_CHAINS.forEach(c => busy.has(c) || plan(c));
}
const anyOn = () => provenOn();
export const provenTable = () => table;
export const onProven = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const EMPTY: Table = {};

/**
 * Home's coins, proven in the background: `state(asset)` for each row (null while the switch is off: draw it as
 * today), `proven(asset)` the proven number for a wrong one. Pass a FRESH read only, never the portfolio saved from
 * the last visit. `late`: the caller passes `portfolio.late`. One wallet at a time (the open one). It never holds up
 * the portfolio read: the proofs run on their own, through the node, not our server.
 * Its effect runs when `assets` is a new array. SafeApp keeps the SAME portfolio object when a read changes nothing,
 * so a repeated number would never reach the rule and nothing could ever go wrong: also call `see()` in loadBalance
 * on every answer (calling both is fine: a read seen twice counts once).
 */
export function useProven(assets: readonly Shown[] | null | undefined, address: Address | undefined, late?: readonly number[]) {
  const on = useSyncExternalStore(onProven, anyOn, () => false);
  const t = useSyncExternalStore(onProven, provenTable, () => EMPTY);
  useEffect(() => {
    if (on && address && assets) see(address, assets, late);
  }, [on, address, assets, late]);
  return useMemo(
    () => ({
      on,
      state: (a: { chainId: number; asset: string }): ProvenState | null => (on ? stateOf(t, a) : null),
      proven: (a: { chainId: number; asset: string }): bigint | null | undefined => {
        const r = t[provenKey(a.chainId, a.asset)];
        return on && r?.state === "wrong" ? r.proven : undefined;
      },
    }),
    [on, t],
  );
}
