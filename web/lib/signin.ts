import type { Siwe } from "./walletconnect";

/** Who asks: `url` is the site's own word. `origin` + `sure` come from something that really knows (WalletConnect's
 * Verify, the browser extension's tab, a Safe App's frame). */
export type Asker = { url: string; origin?: string; sure?: "yes" | "no" | "unknown" };

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).host.toLowerCase() : "";
  } catch {
    return "";
  }
};
const site = (h: string) => h.split(".").slice(-2).join(".");

/**
 * What is wrong with a sign-in request (ERC-4361), as red lines, and a grey note when nothing proves who asks.
 * A sign-in is only good on the site it names: a phishing page passes on a real site's sign-in. Over WalletConnect
 * the site names itself, so its word alone never clears it (audit 11-13): a proven origin wins, no name is red.
 */
export function signInCheck(siwe: Siwe, asker: Asker, safe: string): { red: string[]; note: string | null } {
  const red: string[] = [];
  let note: string | null = null;
  const domain = siwe.domain.toLowerCase();
  const claimed = hostOf(asker.url);
  const proven = asker.sure === "yes" ? hostOf(asker.origin ?? asker.url) : "";
  if (asker.sure === "no") red.push("WalletConnect says this site is not who it says it is.");
  if (proven) {
    if (proven !== domain) red.push(`This is a sign-in for ${domain}, but ${proven} is asking.`);
  } else if (!claimed) red.push(`This is a sign-in for ${domain}, but the site asking didn't say who it is.`);
  else if (claimed !== domain) red.push(`This is a sign-in for ${domain}, but ${claimed} is asking.`);
  else if (asker.sure !== "no") note = `Nothing proves ${domain} is the one asking. Go on only if you just started this there.`;
  const at = hostOf(siwe.uri);
  if (at && site(at) !== site(domain)) red.push(`It signs you in at ${at}, not ${domain}.`);
  if (siwe.address.toLowerCase() !== safe.toLowerCase()) red.push(`It names another account: ${siwe.address}`);
  return { red, note };
}
