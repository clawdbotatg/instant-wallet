import { walletAppBrowser } from "./passkey";

/** An error as words a person can read. */
export function friendly(e: any): string {
  const m = String(e?.shortMessage || e?.message || e);
  if (/NotAllowedError|cancel|abort|timed out/i.test(m + (e?.name ?? ""))) {
    const app = e?.blocked && walletAppBrowser();
    if (app) return `Passkeys don't work inside ${app}'s browser. Open this page in Safari or Chrome.`;
    return "Cancelled.";
  }
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
