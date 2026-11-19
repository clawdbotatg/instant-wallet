import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Settings → No external traffic, on a copy running on your own computer (server side). On: nothing leaves your
 * computer but calls to your own nodes. Kept as a file beside the store (KV_FILE), so your indexer (same folder) sees
 * it too: { nodes: { chainId: url } }, the networks you have a node for. Never on our site.
 *   upstreamRpc   your node, or none (no Alchemy)
 *   guard()       every server fetch to anywhere else is refused (instrumentation.ts)
 * The page: a strict Content-Security-Policy (middleware.ts), networks without your node hidden (lib/chains.ts).
 */
export type NoExt = { nodes: Record<string, string> };
const file = () => (process.env.KV_FILE && !process.env.VERCEL ? join(dirname(process.env.KV_FILE), "no-external.json") : null);
let cache: { at: number; v: NoExt | null } = { at: 0, v: null };

export function noExternal(): NoExt | null {
  const f = file();
  if (!f) return null;
  if (Date.now() - cache.at < 2000) return cache.v;
  let v: NoExt | null = null;
  try {
    v = JSON.parse(readFileSync(f, "utf8"));
  } catch {}
  cache = { at: Date.now(), v };
  return v;
}

export function setNoExternal(v: NoExt | null) {
  const f = file();
  if (!f) throw new Error("not a local copy");
  if (v) writeFileSync(f, JSON.stringify(v));
  else rmSync(f, { force: true });
  cache = { at: 0, v: null };
}

/** This computer, your home network, a .onion (over Tor), or one of your nodes. */
export function home(host: string, nodes: Record<string, string> = {}): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|0\.0\.0\.0$)/.test(h) || /\.(local|onion)$/.test(h)) return true;
  return Object.values(nodes).some(u => {
    try {
      return new URL(u).hostname.toLowerCase() === h;
    } catch {
      return false;
    }
  });
}

/** Refuse every server fetch to the outside while it's on. Once per process. */
export function guard() {
  const g = globalThis as { __iwGuard?: boolean };
  if (g.__iwGuard) return;
  g.__iwGuard = true;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const on = noExternal();
    if (on) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      let host = "";
      try {
        host = new URL(String(url)).hostname;
      } catch {}
      if (host && !home(host, on.nodes)) throw new TypeError(`No external traffic: ${host}`);
    }
    return real(input, init);
  }) as typeof fetch;
}
