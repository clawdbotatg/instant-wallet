import { KIND_WEBAUTHN, walletAddress } from "./address";
import type { Account, Portfolio } from "./types";

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


/** The last balance this phone saw, per wallet: shown at launch while the fresh one loads. */
export const loadPortfolio = (address: string): Portfolio | null => get<Portfolio>(`iw3.portfolio.${address.toLowerCase()}`);
export const savePortfolio = (address: string, p: Portfolio) => set(`iw3.portfolio.${address.toLowerCase()}`, p);

/** Coins the user trashed off the home list (spam dust), as "chainId:address" lowercase. */
export const loadHidden = (): string[] => get<string[]>("iw3.hidden") ?? [];
export const saveHidden = (h: string[]) => set("iw3.hidden", h.length ? h : null);
/** Coins under a penny the user tapped Show for (they're hidden on their own otherwise). */
export const loadShown = (): string[] => get<string[]>("iw3.shown") ?? [];
export const saveShown = (h: string[]) => set("iw3.shown", h.length ? h : null);
/** Request QRs as an instantwallet.io link (any phone camera opens it) or a bare ethereum: request. On unless turned off. */
export const loadRequestLink = (): boolean => get<boolean>("iw3.requestLink") ?? true;
export const saveRequestLink = (on: boolean) => set("iw3.requestLink", on ? null : false);
/** NFT collections the user hid, as "chainId:contract" lowercase. */
export const loadHiddenNfts = (): string[] => get<string[]>("iw3.hiddenNfts") ?? [];
export const saveHiddenNfts = (h: string[]) => set("iw3.hiddenNfts", h.length ? h : null);
