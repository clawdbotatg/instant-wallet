import { isLocal, noExt } from "./local";

/**
 * The wallet's two modes (docs/MODES.md):
 *   mountain  "mountain man": as CROPS as it gets. Check everything, trust no server, pay what that costs
 *             (more node calls, slower, a red screen when a proof can't be had). The default on a copy on your
 *             own computer: the calls go to your own node.
 *   bro       "finance bro": smooth first. Cypherpunk where it's free, never at the cost of our rate limits
 *             or a slow screen. The default on instantwallet.io and in the app.
 * A mode only picks DEFAULTS. Every switch it sets can still be flipped by hand in Settings, and a switch
 * someone flipped stays as they left it when the mode changes. Either mode can be picked anywhere.
 * A new setting that trades smooth for checked: read its default from here, never from isLocal().
 */
export type Mode = "mountain" | "bro";
const KEY = "iws.mode";
const byPlace = (): Mode => (isLocal() ? "mountain" : "bro");
export function mode(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "mountain" || v === "bro") return v;
  } catch {}
  return byPlace();
}
export function setMode(m: Mode) {
  try {
    if (m === byPlace()) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, m);
  } catch {}
}
export const mountain = () => mode() === "mountain";
/** Proving in this browser (balances, the signing preview) is on unless someone turned it off. Not while No
 * external traffic is on: a proof needs a prover, and Colibri's is outside (turn it on by hand with your own). */
export const proveByDefault = () => mountain() && !noExt();
