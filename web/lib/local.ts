/**
 * A copy of the wallet running on your own computer (README: "Run it fully local"): local.instantwallet.io,
 * localhost or 127.0.0.1. Our site never is one.
 */
export const isLocalHost = (host: string) => /^local\.|^localhost$|^127\.0\.0\.1$/.test(host);
export const isLocal = () => typeof window !== "undefined" && isLocalHost(window.location.hostname);

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
