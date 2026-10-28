import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { type Hex, toHex } from "viem";
import { HDKey } from "viem/accounts";
import { claimKey } from "./claim";

/**
 * xdai.io (PLAN-xdai.md): the same Instant Wallet in a dark, 🔥 look, on the old Burner Wallet's domain, so the
 * Burner key still in that domain's localStorage can be moved into a passkey Safe. Wallets made there are their own
 * (passkeys belong to the domain).
 *
 * Preview builds can't be xdai.io: `?brand=xdai` turns the look on in this browser, `?brand=` turns it off.
 */
export const XDAI_HOSTS = ["xdai.io"];
const BRAND_KEY = "iw.brand";

/** Runs before first paint (layout.tsx), so the dark look never flashes white. Keep it plain ES5, no imports. */
export const BRAND_SCRIPT = `try{var q=new URLSearchParams(location.search).get("brand");if(q!==null){q?localStorage.setItem("${BRAND_KEY}",q):localStorage.removeItem("${BRAND_KEY}")}if(${JSON.stringify(XDAI_HOSTS)}.indexOf(location.hostname)>=0||localStorage.getItem("${BRAND_KEY}")==="xdai"){document.documentElement.setAttribute("data-brand","xdai");var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content","#121212")}}catch(e){}`;

export const isXdai = () => typeof document !== "undefined" && document.documentElement.dataset.brand === "xdai";

/** The old Burner Wallet's key (its localStorage `metaPrivateKey`), once it's moved: kept, never deleted. */
const BURNER_KEY = "metaPrivateKey";
const BURNER_MOVED = "iw.oldBurnerKey";

/** Its localStorage, or the cookie it fell back to when storage was blocked. A burned wallet left "0" there. */
export function burnerKey(): Hex | null {
  try {
    const k = claimKey(localStorage.getItem(BURNER_KEY) || "");
    if (k) return k;
  } catch {}
  const c = document.cookie.split("; ").find(x => x.startsWith(`${BURNER_KEY}=`));
  return c ? claimKey(decodeURIComponent(c.slice(BURNER_KEY.length + 1)).replace(/"/g, "")) : null;
}

/** After a move: the old key goes to `iw.oldBurnerKey` (a later screen can export it), so the move screen stops showing. */
export function retireBurnerKey(key: Hex) {
  try {
    localStorage.setItem(BURNER_MOVED, key);
    localStorage.removeItem(BURNER_KEY);
    document.cookie = `${BURNER_KEY}=; path=/; max-age=0`; // only once the copy above is saved
  } catch {}
}

/** The old Burner key this browser has, moved or not (Settings shows it so it can be copied out). */
export function oldBurnerKey(): Hex | null {
  try {
    const k = claimKey(localStorage.getItem(BURNER_MOVED) || "");
    if (k) return k;
  } catch {}
  return burnerKey();
}

/** Testing only, never on xdai.io or production: `?burner=new` plants a fresh key where the old Burner Wallet kept its key, as if
 *  this browser had used it. Fund its address, reload, and the move screen shows (PLAN-xdai.md). */
export function plantTestBurner(): Hex | null {
  if (XDAI_HOSTS.includes(window.location.hostname) || process.env.NEXT_PUBLIC_VERCEL_ENV === "production") return null;
  if (new URLSearchParams(window.location.search).get("burner") !== "new") return null;
  const k = burnerKey() ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
  try {
    localStorage.setItem(BURNER_KEY, k);
  } catch {}
  return k;
}

/**
 * The old Burner's "seed phrase" box: any text at all, not just real BIP-39 words. It ran the text through BIP-39's
 * seed step with no word check (bip39@2 mnemonicToSeed: PBKDF2-SHA512, salt "mnemonic", 2048 rounds), then took
 * m/44'/60'/0'/0/0 (ethereum-mnemonic-privatekey-utils). Same text in, same key out. The text is used exactly as typed.
 */
export function brainKey(phrase: string): Hex {
  const enc = new TextEncoder();
  const seed = pbkdf2(sha512, enc.encode(phrase.normalize("NFKD")), enc.encode("mnemonic"), { c: 2048, dkLen: 64 });
  return toHex(HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0").privateKey!);
}
