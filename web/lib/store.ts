import { KIND_WEBAUTHN, walletAddress } from "./address";
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

/** The address is recomputed, never trusted from storage: it changes when the Factory does (v3 → v3.1). */
export const loadAccount = (): Account | null => {
  const a = get<Account>("iw3.account");
  return a ? { ...a, address: walletAddress(a.qx, a.qy, KIND_WEBAUTHN, a.credentialIdHash) } : null;
};
export const saveAccount = (a: Account | null) => set("iw3.account", a);

