import type { Address } from "viem";
import { SIM_DEFAULT, type SafeTxLike, type SimAnswer, simulate as run } from "clear-signing-safe-kit";

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

/** Run it on this browser's simulator. null: no answer we can trust. */
export function simulate(chainId: number, safe: Address, tx: SafeTxLike): Promise<SimAnswer | null> {
  return run({ chain: chainId, safe, tx, url: simUrl(), store: "iws.simKeys" });
}
