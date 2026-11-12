import type { Address, Hash } from "viem";
import type { Call } from "./core";

/**
 * What this browser has sent that isn't on chain yet: Activity shows it at the top ("Sending…") from the moment it
 * goes to the relay until its receipt lands, even after the sheet that sent it is pulled down (Austin, 11-06). One
 * that has its transaction hash is kept in this browser, so a reload (or the app closed and opened) still shows it
 * and watches for it to land (Austin, 11-11). One with no hash yet never reached the relay as far as we know: a
 * reload forgets it.
 */
export type Sending = { id: number; chainId: number; safe: Address; calls: Call[]; hash?: Hash; at: number; landed?: boolean };

const EVT = "iws:sending";
const KEPT = "iws:sending";
/** Past this a kept send is the chain's to show (or it never landed): the relay's own wait is 3 minutes. */
const KEEP_MS = 10 * 60_000;
let list: Sending[] = [];
let next = 1;
let read = false;
const tell = (landed = false) => {
  try {
    const out = list.filter(s => s.hash && !s.landed).map(s => ({ ...s, calls: s.calls.map(c => ({ ...c, value: c.value.toString() })) }));
    if (out.length) localStorage.setItem(KEPT, JSON.stringify(out));
    else localStorage.removeItem(KEPT);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { landed } }));
  } catch {}
};

/** Landed (or failed on chain): stays a little while, until Activity's chain read has it in its place. Never sent
 * (the relay said no): gone now. */
function finish(id: number) {
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
}

/** Once per page: the sends this browser kept, back on the list, each watched until its receipt. */
function restore() {
  if (read || typeof window === "undefined") return;
  read = true;
  let kept: any[] = [];
  try {
    kept = JSON.parse(localStorage.getItem(KEPT) || "[]");
  } catch {}
  if (!Array.isArray(kept)) return;
  for (const k of kept) {
    try {
      if (!k?.hash || !(Date.now() - k.at < KEEP_MS) || list.some(s => s.hash === k.hash)) continue;
      const s: Sending = { id: next++, chainId: Number(k.chainId), safe: k.safe, calls: (k.calls as any[]).map(c => ({ to: c.to, data: c.data, value: BigInt(c.value) })), hash: k.hash, at: k.at };
      list = [...list, s];
      import("../chains")
        .then(m => m.publicClient(s.chainId).waitForTransactionReceipt({ hash: s.hash!, timeout: 180_000, pollingInterval: 1500 }))
        .catch(() => {})
        .then(() => finish(s.id));
    } catch {}
  }
  tell();
}

export const sendingNow = () => (restore(), list);

/** On Activity's top from now on. Returns: hash (it's out, its transaction hash) and done (landed or failed). */
export function startSending(chainId: number, safe: Address, calls: Call[]) {
  restore();
  const id = next++;
  list = [{ id, chainId, safe, calls, at: Date.now() }, ...list];
  tell();
  return {
    hash: (hash: Hash) => {
      list = list.map(s => (s.id === id ? { ...s, hash } : s));
      tell();
    },
    done: () => finish(id),
  };
}

/** Runs `on` on every change; `landed`: one is on chain now (Activity reads the chain again). */
export function onSending(on: (landed: boolean) => void) {
  const h = (e: Event) => on(!!(e as CustomEvent).detail?.landed);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}
