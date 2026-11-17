import "server-only";
import { http, type Transport } from "viem";
import { isOnion } from "./tor";

/**
 * Tor from the server, for a copy on your own computer (run-local.sh): the relay sends to the node set in
 * Settings → Your node, and a .onion goes over Tor. In Node tor-js opens TCP itself: no gateway. One client per
 * process, started on first use (~7 s), ~1 s a call after.
 */
let client: Promise<{ fetch: (url: string, init: any) => Promise<Response> }> | null = null;
function tor() {
  client ??= import("tor-js/wasm-file").then(m => new m.TorClient({}) as any);
  client.catch(() => (client = null));
  return client;
}

const torFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { signal: _, ...rest } = init ?? {};
  const headers = Object.fromEntries(new Headers(rest.headers).entries());
  return (await tor()).fetch(url, { ...rest, headers, anonOptions: { isolationKey: "relay" } });
};

/** A transport to `url`: over Tor for a .onion (a minute for Tor's first start), else plain. */
export const nodeTransport = (url: string): Transport =>
  isOnion(url) ? http(url, { fetchFn: torFetch, timeout: 60_000, retryCount: 1 }) : http(url);
