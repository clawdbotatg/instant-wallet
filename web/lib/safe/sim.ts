import type { Address } from "viem";
import { SIM_DEFAULT, type SafeTxLike, type SimAnswer, simulate as run } from "clear-signing-safe-kit";
import { chainById, nativeSymbol, rpcPath } from "@/lib/chains";
import { nativeUsd, tokensUsd } from "@/lib/price";
import { LIGHT_CHAINS, PROVER, WRAPPED, lightRun, lightWarm } from "./light";

/**
 * What a Safe tx moves in and out, from clear-sim (the simulator wedgie.dev and the wedgie use), through
 * clear-signing-safe-kit: asked from the browser, its signed answer checked against the key pinned per simulator.
 * Settings → Simulator points it at your own.
 */
export { SIM_DEFAULT, asSafeTx, moves, type Moves as Sim, type Move, type SimAnswer } from "clear-signing-safe-kit";
const KEY = "iws.sim";

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

/** Settings → Simulator: the wedgie shows the coins too. It asks clear-sim (the only answer it can check), so
 * off = the transaction goes to no simulator before you sign, and the wedgie shows the words only. */
const WEDGIE = "iws.wedgieSim";
export function wedgieSim(): boolean {
  try {
    return localStorage.getItem(WEDGIE) !== "off";
  } catch {
    return true;
  }
}
export function setWedgieSim(on: boolean) {
  try {
    if (on) localStorage.removeItem(WEDGIE);
    else localStorage.setItem(WEDGIE, "off");
  } catch {}
}

/** Per network (Ethereum, Gnosis): the coins are worked out in this browser by a light client (lib/safe/light.ts),
 * not asked from clear-sim. prover: your own Colibri prover for the block headers, else theirs. */
const LIGHT = "iws.light";
type Light = Record<string, { on?: boolean; prover?: string }>;
function lights(): Light {
  try {
    return JSON.parse(localStorage.getItem(LIGHT) || "{}") || {};
  } catch {
    return {};
  }
}
export const canLight = (chainId: number) => LIGHT_CHAINS.includes(chainId);
export const lightOn = (chainId: number) => canLight(chainId) && !!lights()[chainId]?.on;
export const lightProver = (chainId: number) => lights()[chainId]?.prover || PROVER[chainId];
export function setLight(chainId: number, on: boolean, prover?: string) {
  const all = lights();
  const p = prover?.trim().replace(/\/$/, "");
  all[chainId] = { on, ...(p && p !== PROVER[chainId] ? { prover: p } : {}) };
  try {
    localStorage.setItem(LIGHT, JSON.stringify(all));
  } catch {}
  if (on) warm(chainId);
}
export const WASM = "/colibri/c4w.wasm";
const warm = (chainId: number) => lightWarm(chainId, rpcPath(chainId), lightProver(chainId), WASM);
// a page that opens with it on starts it now, so the first transaction doesn't wait for it
if (typeof window !== "undefined") setTimeout(() => LIGHT_CHAINS.filter(lightOn).forEach(warm), 2000);

/** The light client's answer, with dollars. A price isn't on the chain, so no node can prove it: it comes from our
 * price server (Alchemy), as everywhere else in the wallet. */
async function light(chainId: number, safe: Address, tx: SafeTxLike): Promise<SimAnswer> {
  const a = await lightRun({ chainId, safe, tx, rpc: rpcPath(chainId), prover: lightProver(chainId), wasm: WASM });
  const usdc = chainById(chainId)?.usdc?.toLowerCase();
  const coin = a.changes.some(c => c.token === "eth" || c.token === WRAPPED[chainId]) ? await nativeUsd(chainId) : 0;
  const rest = a.changes.map(c => c.token).filter(t => t !== "eth" && t !== usdc && t !== WRAPPED[chainId]);
  const priced = await tokensUsd(chainId, [...new Set(rest)]);
  const changes = a.changes.map(c => {
    const each = c.token === usdc ? 1 : c.token === "eth" || c.token === WRAPPED[chainId] ? coin : priced[c.token] ?? 0;
    return { ...c, symbol: c.token === "eth" ? nativeSymbol(chainId) : c.symbol, usd: each && c.decimals >= 0 ? String((Number(c.amount) / 10 ** c.decimals) * each) : "" };
  });
  return { ...a, changes, tx: "", nonce: "", sig: "", r: "", s: "" };
}

/** Run it: in this browser where the light client is on (it throws when it can't prove its answer: never the
 * unchecked one, never clear-sim instead), else on this browser's simulator. null: no answer we can trust. */
export function simulate(chainId: number, safe: Address, tx: SafeTxLike): Promise<SimAnswer | null> {
  if (lightOn(chainId)) return light(chainId, safe, tx);
  return run({ chain: chainId, safe, tx, url: simUrl(), store: "iws.simKeys" });
}
