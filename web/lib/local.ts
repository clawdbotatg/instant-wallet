/**
 * A copy of the wallet running on your own computer (README: "Run it fully local"): local.instantwallet.io,
 * localhost or 127.0.0.1. Our site never is one.
 */
export const isLocalHost = (host: string) => /^local\.|^localhost$|^127\.0\.0\.1$/.test(host);
export const isLocal = () => typeof window !== "undefined" && isLocalHost(window.location.hostname);

/** A request to a copy on your own computer (never our site). It skips the extras that would see your IP and that
 * your node can't stand in for: ENS avatar hosts, LI.FI. */
export const fromLocalCopy = (req: { headers: Headers }) => !process.env.VERCEL && isLocalHost((req.headers.get("host") || "").split(":")[0]);

/** The header a local copy's page sends its Settings → Your node in (chains.ts relayHeaders). */
export const NODE_HEADER = "x-iw-node";
/**
 * Settings → Your node, from a request to a copy on your own computer: its relay sends there (a .onion over Tor).
 * Never on our site: there it would let anyone point our relay at any URL.
 */
export function nodeOf(req: { headers: Headers }): string | undefined {
  if (process.env.VERCEL || !isLocalHost((req.headers.get("host") || "").split(":")[0])) return undefined;
  const u = req.headers.get(NODE_HEADER)?.trim();
  return u && /^https?:\/\/[^\s]+$/.test(u) ? u : undefined;
}

/**
 * Settings → No external traffic (server: lib/noext.ts), as this page knows it: the networks you have a node for, or
 * null when it's off (and always on our site). Kept in this browser so the page starts with only those networks.
 */
const NOEXT = "iws.noext";
export function noExt(): { chains: number[] } | null {
  if (!isLocal()) return null;
  try {
    const v = JSON.parse(localStorage.getItem(NOEXT) || "null");
    return v && Array.isArray(v.chains) ? v : null;
  } catch {
    return null;
  }
}
/** Ask this copy whether it's on (each page load; Settings flips it): a change reloads the page into the new mode. */
export async function syncNoExt(set?: boolean): Promise<string | undefined> {
  if (!isLocal()) return;
  const r = await fetch("/api/local/noext", set === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: set }) })
    .then(r => r.json())
    .catch(() => null);
  if (!r || r.error) return r?.error ?? "No answer.";
  const now = r.on ? JSON.stringify({ chains: r.chains }) : "null";
  if (now === JSON.stringify(noExt())) return;
  try {
    localStorage.setItem(NOEXT, now);
  } catch {}
  location.reload();
}
/** A picture from elsewhere, while No external traffic is on: through this copy, over Tor (app/api/local/img). */
export const viaHome = (u: string | undefined): string | undefined =>
  u && noExt() && /^https?:\/\//.test(u) && !u.startsWith(location.origin) ? `/api/local/img?u=${encodeURIComponent(u)}` : u;
