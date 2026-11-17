import "server-only";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { http, type Transport } from "viem";
import { isOnion } from "./tor";

/**
 * Tor from the server, for a copy on your own computer (run-local.sh): the relay sends to the node set in
 * Settings → Your node, and a .onion goes over Tor. In Node tor-js opens TCP itself: no gateway. One client per
 * process, started on first use (~7 s), ~1 s a call after.
 */
const DIR = join(homedir(), ".instantwallet-local", "tor");
type Tor = Promise<{ fetch: (url: string, init: any) => Promise<Response> }>;
// on globalThis: each route may load its own copy of this file, and two Tor clients on one cache folder corrupt it
const g = globalThis as { __iwTor?: Tor | null };
function tor(): Tor {
  if (!g.__iwTor) {
    // its own cache folder (not tor-js's shared one), wiped when Tor says it's corrupt: the next call starts fresh
    const c: Tor = import("tor-js/wasm-file").then(async m => {
      const t = new m.TorClient({ storage: m.storage.addLocking(new m.storage.FilesystemStorage(DIR), "instantwallet") }) as any;
      await t.ready?.().catch((e: any) => {
        if (/corrupt/i.test(String(e?.message || e))) rmSync(DIR, { recursive: true, force: true });
        throw e;
      });
      return t;
    });
    g.__iwTor = c;
    c.catch(() => g.__iwTor === c && (g.__iwTor = null));
  }
  return g.__iwTor;
}

export const torFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { signal: _, ...rest } = init ?? {};
  const headers = Object.fromEntries(new Headers(rest.headers).entries());
  return (await tor()).fetch(url, { ...rest, headers, anonOptions: { isolationKey: "relay" } });
};

/** A transport to `url`: over Tor for a .onion (a minute for Tor's first start), else plain. */
export const nodeTransport = (url: string): Transport =>
  isOnion(url) ? http(url, { fetchFn: torFetch, timeout: 60_000, retryCount: 1 }) : http(url);
