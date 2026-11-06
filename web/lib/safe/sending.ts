import type { Address, Hash } from "viem";
import type { Call } from "./core";

/**
 * What this page has sent that isn't on chain yet: Activity shows it at the top ("Sending…") from the moment it goes
 * to the relay until its receipt lands, even after the sheet that sent it is pulled down (Austin, 11-06). This page
 * only: a reload forgets it, and the chain's own history shows it once it lands.
 */
export type Sending = { id: number; chainId: number; safe: Address; calls: Call[]; hash?: Hash; at: number; landed?: boolean };

const EVT = "iws:sending";
let list: Sending[] = [];
let next = 1;
const tell = (landed = false) => {
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { landed } }));
  } catch {}
};

export const sendingNow = () => list;

/** On Activity's top from now on. Returns: hash (it's out, its transaction hash) and done (landed or failed). */
export function startSending(chainId: number, safe: Address, calls: Call[]) {
  const id = next++;
  list = [{ id, chainId, safe, calls, at: Date.now() }, ...list];
  tell();
  return {
    hash: (hash: Hash) => {
      list = list.map(s => (s.id === id ? { ...s, hash } : s));
      tell();
    },
    // landed (or failed on chain): stays a little while, until Activity's chain read has it in its place; never sent
    // (the relay said no): gone now
    done: () => {
      const s = list.find(x => x.id === id);
      if (!s || s.landed) return;
      const drop = () => {
        list = list.filter(x => x.id !== id);
        tell();
      };
      if (!s.hash) return drop();
      list = list.map(x => (x.id === id ? { ...x, landed: true } : x));
      tell(true);
      setTimeout(drop, 30_000);
    },
  };
}

/** Runs `on` on every change; `landed`: one is on chain now (Activity reads the chain again). */
export function onSending(on: (landed: boolean) => void) {
  const h = (e: Event) => on(!!(e as CustomEvent).detail?.landed);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}
