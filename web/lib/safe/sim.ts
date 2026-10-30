import { type Address, type Hex, formatUnits } from "viem";
import { MULTISEND_CALL_ONLY } from "./config";
import { type Call, multiSendData } from "./core";

/**
 * What a Safe tx moves in and out, from clear-sim (github.com/clawdbotatg/clear-sim, the simulator wedgie.dev and the
 * wedgie use; SPEC.md there). Asked from the browser, not our server, so anyone can point their wallet at their own
 * simulator (Settings → Simulator). Every answer is P-256 signed: checked against the key that simulator gave the
 * first time this browser used it (kept per URL), so the network in between can't change it.
 */
export const SIM_DEFAULT = "https://sim.wedgie.dev";
const KEY = "iws.sim";
const PINS = "iws.simKeys";

export function simUrl(): string {
  try {
    return localStorage.getItem(KEY) || SIM_DEFAULT;
  } catch {
    return SIM_DEFAULT;
  }
}
export function setSimUrl(u: string | null) {
  try {
    if (u && u.replace(/\/$/, "") !== SIM_DEFAULT) localStorage.setItem(KEY, u.replace(/\/$/, ""));
    else localStorage.removeItem(KEY);
  } catch {}
}

export type Change = { token: string; symbol: string; decimals: number; amount: string; usd: string };
export type SimAnswer = { block: number; ok: "ok" | "reverts"; tx: string; changes: Change[]; nonce: string; sig: string; r: string; s: string };
/** One coin moved: formatted amount (no sign), dollars (no sign) when priced. */
export type Move = { token: string; symbol: string; amount: string; usd?: number };
export type Sim = { pay: Move[]; get: Move[]; fails?: string; block?: number } | null;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** The simulator's public key: pinned the first time, then always that one (a changed key = a different simulator). */
async function pinned(url: string): Promise<{ x: string; y: string }> {
  let pins: Record<string, { x: string; y: string }> = {};
  try {
    pins = JSON.parse(localStorage.getItem(PINS) || "{}");
  } catch {}
  if (pins[url]) return pins[url];
  const k = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
  if (!/^[0-9a-f]{64}$/.test(k?.x) || !/^[0-9a-f]{64}$/.test(k?.y)) throw new Error("simulator: no key");
  pins[url] = { x: k.x, y: k.y };
  try {
    localStorage.setItem(PINS, JSON.stringify(pins));
  } catch {}
  return pins[url];
}

/** Check a clear-sim answer: our own tx hash and nonce, its signature, against the pinned key (SPEC.md "Checking it"). */
async function check(a: SimAnswer, k: { x: string; y: string }, chain: number, tx: string, nonce: string) {
  if (a.tx !== tx || a.nonce !== nonce) return false;
  const text = ["clear-sim v1", nonce, chain, tx, a.block, a.ok, ...a.changes.map(c => [c.token, c.symbol, c.decimals, c.amount, c.usd].join(","))].join("\n");
  const b64 = (h: string) => btoa(String.fromCharCode(...bytes(h))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64(k.x), y: b64(k.y) }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(a.r + a.s), new TextEncoder().encode(text));
}

/** The Safe tx for these calls: one call as itself, several as a MultiSend batch (a delegatecall, operation 1). */
export function asSafeTx(calls: Call[]): { to: Address; value: bigint; data: Hex; operation: 0 | 1 } {
  if (calls.length === 1) return { ...calls[0], operation: 0 };
  return { to: MULTISEND_CALL_ONLY, value: 0n, data: multiSendData(calls), operation: 1 };
}

/** Run it on the simulator: the Safe's net change per coin, signature checked. null: no answer we can trust. */
export async function simulate(chainId: number, safe: Address, t: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }): Promise<SimAnswer | null> {
  const url = simUrl();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const [from, to, data] = [safe.toLowerCase(), t.to.toLowerCase(), t.data.toLowerCase()];
  const tx = await sha256(`${from}\n${to}\n${t.value}\n${data}${t.operation ? "\n1" : ""}`);
  const [k, a] = await Promise.all([
    pinned(url),
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain: chainId, from, to, value: t.value.toString(), data, nonce, ...(t.operation ? { operation: 1 } : {}) }),
      signal: AbortSignal.timeout(20_000),
    }).then(r => r.json() as Promise<SimAnswer>),
  ]);
  if (!a?.r || !(await check(a, k, chainId, tx, nonce))) return null;
  return a;
}

/** The answer as coins out and in. `fees`: what the batch pays the relay, per token (lowercase, "eth" = the coin),
 * taken out of "pay" (shown on its own line). */
export function moves(a: SimAnswer, fees: Record<string, bigint> = {}): Sim {
  if (a.ok !== "ok") return { pay: [], get: [], fails: "reverts", block: a.block };
  const pay: Move[] = [];
  const get: Move[] = [];
  for (const c of a.changes) {
    let n = BigInt(c.amount);
    const all = n;
    const fee = fees[c.token] ?? 0n;
    if (n < 0n && fee) n += fee > -n ? -n : fee;
    if (n === 0n) continue;
    const usd = c.usd === "" ? undefined : Math.abs(Number(c.usd) * (all ? Number(n) / Number(all) : 1));
    const m: Move = { token: c.token, symbol: c.symbol, amount: c.decimals >= 0 ? formatUnits(n < 0n ? -n : n, c.decimals) : (n < 0n ? -n : n).toString(), usd };
    (n < 0n ? pay : get).push(m);
  }
  return { pay, get, block: a.block };
}
