import { type Hex, formatUnits, keccak256, toBytes } from "viem";
import { assertChallenge } from "./passkey";
import { toWebAuthnSig } from "./safe/sign";
import type { SafeAccount } from "./safe/state";

/**
 * Drops in the browser (lib/drops.ts is the server). A drop link is <origin>/d#<CODE>; the code also works typed.
 * The code is kept on this device for a day (STASH), so it waits while the person makes a wallet, backs it up, or
 * wanders off; the home screen offers it again.
 */

export type DropInfo = {
  code: string;
  name: string;
  chainId: number;
  token: "usdc" | "eth";
  amount: string;
  decimals: number;
  kind: "cards" | "crowd";
  claimed: number;
  cap: number;
  closesAt: number | null;
  closed: string | null;
};

export const normCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 24);
export const dropUrl = (origin: string, code: string) => `${origin}/d#${code}`;

/** The code in a drop link (any host), or null. */
export function dropCode(text: string): string | null {
  try {
    const u = new URL(text.trim());
    const c = normCode(decodeURIComponent(u.hash.slice(1)));
    return /^\/d\/?$/.test(u.pathname) && c.length >= 4 ? c : null;
  } catch {
    return null;
  }
}

const STASH = "iw.drop";
export function stashCode(code: string) {
  try {
    localStorage.setItem(STASH, JSON.stringify({ code, at: Date.now() }));
  } catch {}
}
export function stashedCode(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(STASH) || "null");
    if (v?.code && Date.now() - v.at < 86_400_000) return v.code;
    localStorage.removeItem(STASH);
  } catch {}
  return null;
}
export function clearStash() {
  try {
    localStorage.removeItem(STASH);
  } catch {}
}

/** "5 USDC", "0.001 ETH". */
export const dropAmount = (d: { amount: string; decimals: number; token: string }) => `${formatUnits(BigInt(d.amount), d.decimals)} ${d.token.toUpperCase()}`;

/** Face ID over a drops message (same bytes as changeDigest(…, "drops") in lib/alerts.ts). Call straight from a tap. */
export async function dropSig(a: SafeAccount, change: string) {
  const ts = Date.now();
  const h: Hex = keccak256(toBytes(`Instant Wallet drops\n${a.address.toLowerCase()}\n${change}\n${ts}`));
  const s = await assertChallenge(a.credentialId, h);
  const w = toWebAuthnSig(s.authenticatorData, s.clientDataJSON, s.r, s.s, h);
  return { qx: a.qx, qy: a.qy, authenticatorData: w.authenticatorData, clientDataFields: w.clientDataFields, r: s.r, s: s.s, ts };
}
