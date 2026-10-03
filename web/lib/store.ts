import type { Hex } from "viem";
import type { Account } from "./types";

/** localStorage, wrapped: private windows and blocked storage throw, and the app must still render. */
function get<T>(k: string): T | null {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function set(k: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage unavailable: this session only
  }
}

export const loadAccount = () => get<Account>("iw3.account");
export const saveAccount = (a: Account | null) => set("iw3.account", a);

/** The gas key's private key, per wallet address. */
export const loadGasKey = (wallet: string) => get<Hex>(`iw3.gas.${wallet.toLowerCase()}`);
export const saveGasKey = (wallet: string, pk: Hex) => set(`iw3.gas.${wallet.toLowerCase()}`, pk);
