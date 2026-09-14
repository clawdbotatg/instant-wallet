import type { Address, Hex } from "viem";

/**
 * Browser-side account book (localStorage). One entry per (wallet, passkey) this browser knows.
 * Nothing secret lives here: credential ids and public keys only.
 */
export type StoredAccount = {
  wallet: Address;
  signerId: Address;
  credentialId: string;
  qx: Hex;
  qy: Hex;
  label: string;
  createdAt: number;
  lastUsed: number;
};

const KEY = "iw.accounts.v1";
const CURRENT = "iw.current";

function read(): StoredAccount[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredAccount[]) : [];
  } catch {
    return [];
  }
}
function write(list: StoredAccount[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event("iw:accounts"));
}

export function listAccounts(): StoredAccount[] {
  return read().sort((a, b) => b.lastUsed - a.lastUsed);
}

export function saveAccount(acc: Omit<StoredAccount, "createdAt" | "lastUsed"> & { createdAt?: number }) {
  const list = read().filter(
    a =>
      !(a.wallet.toLowerCase() === acc.wallet.toLowerCase() && a.signerId.toLowerCase() === acc.signerId.toLowerCase()),
  );
  list.push({ ...acc, createdAt: acc.createdAt ?? Date.now(), lastUsed: Date.now() });
  write(list);
  localStorage.setItem(CURRENT, acc.wallet);
}

export function touchAccount(wallet: string) {
  const list = read();
  for (const a of list) if (a.wallet.toLowerCase() === wallet.toLowerCase()) a.lastUsed = Date.now();
  write(list);
  localStorage.setItem(CURRENT, wallet);
}

export function forgetAccount(wallet: string, signerId?: string) {
  write(
    read().filter(
      a =>
        !(
          a.wallet.toLowerCase() === wallet.toLowerCase() &&
          (!signerId || a.signerId.toLowerCase() === signerId.toLowerCase())
        ),
    ),
  );
}

/** The passkey this browser holds for a wallet (there may be several; newest first). */
export function passkeysFor(wallet: string): StoredAccount[] {
  return listAccounts().filter(a => a.wallet.toLowerCase() === wallet.toLowerCase());
}

export function currentWallet(): Address | null {
  if (typeof window === "undefined") return null;
  return (localStorage.getItem(CURRENT) as Address | null) ?? listAccounts()[0]?.wallet ?? null;
}

export function knownSignerIds(): Set<string> {
  return new Set(read().map(a => a.signerId.toLowerCase()));
}

/** Local labels for signers (per wallet) — what this phone calls its own keys. */
export function labelFor(wallet: string, signerId: string): string | undefined {
  return read().find(
    a => a.wallet.toLowerCase() === wallet.toLowerCase() && a.signerId.toLowerCase() === signerId.toLowerCase(),
  )?.label;
}

export function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone · Face ID";
  if (/iPad/.test(ua)) return "iPad · Face ID";
  if (/Macintosh/.test(ua)) return "Mac · Touch ID";
  if (/Android/.test(ua)) return "Android · biometrics";
  if (/Windows/.test(ua)) return "Windows Hello";
  return "Passkey";
}

/** "Face ID" / "Touch ID" / "Windows Hello" — the verb for the confirm button. */
export function biometricName(): string {
  if (typeof navigator === "undefined") return "passkey";
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "Face ID";
  if (/Macintosh/.test(ua)) return "Touch ID";
  if (/Windows/.test(ua)) return "Windows Hello";
  return "passkey";
}
