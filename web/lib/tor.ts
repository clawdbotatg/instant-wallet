import type { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { NODE_HEADER, isLocal } from "./local";

/**
 * Your node over Tor (docs/ANON-RPC.md). A node address whose host ends in .onion (Settings → Your node) is reached
 * through Tor running in this browser: anon-rpc's harness loads tor-js (hash-pinned on chain) into a sandboxed
 * iframe and hands back a fetch. The node sees the question, never this browser's IP. No fallback to our proxy: a
 * Tor read that fails, fails.
 */

/** tor-js on mainnet (anon-rpc adopters.json5). Its owner can change the code; see docs/ANON-RPC.md Open #5. */
const TOR_JS = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";
/** KPS gateway: how a browser reaches Tor. The EF demo gateway until we run ours (Open #1). */
const GATEWAY = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
/** The test node's filter takes 8 requests at once; keep under it. */
const AT_ONCE = 6;

export const isOnion = (url: string | undefined | null) => {
  try {
    return !!url && new URL(url).hostname.endsWith(".onion");
  } catch {
    return false;
  }
};

export type TorState = "off" | "starting" | "on" | "failed";
let state: TorState = "off";
const watchers = new Set<(s: TorState) => void>();
const set = (s: TorState) => ((state = s), watchers.forEach(f => f(s)));
/** Settings shows "Starting Tor…" until the first answer. */
export function onTor(f: (s: TorState) => void) {
  watchers.add(f);
  f(state);
  return () => void watchers.delete(f);
}

let worker: Promise<AnonRpcWorker> | null = null;
/** One Tor client per page, started the first time a Tor node is used. Browser only. */
function tor(): Promise<AnonRpcWorker> {
  if (typeof window === "undefined") return Promise.reject(new Error("Tor runs in the browser only"));
  if (!worker) {
    set("starting");
    worker = import("@anon-rpc/browser-harness").then(async ({ AnonRpcWorker }) => {
      const w = new AnonRpcWorker({
        address: TOR_JS,
        config: { gateways: [GATEWAY] },
        // Reads tor-js's code hash on mainnet, through our proxy. Not private, and needn't be: it shows only that
        // this browser uses anon-rpc, no address.
        preExisting: {
          rpcProvider: {
            request: ({ method, params }) =>
              fetch(`${location.origin}/api/rpc/1`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
              })
                .then(r => r.json())
                .then(j => {
                  if (j.error) throw new Error(j.error.message);
                  return j.result;
                }),
          },
        },
      });
      await w.ready;
      return w;
    });
    worker.catch(() => {
      worker = null; // the next read tries again
      set("failed");
    });
  }
  return worker;
}

let running = 0;
const queue: (() => void)[] = [];
const slot = () => (running < AT_ONCE ? (running++, Promise.resolve()) : new Promise<void>(r => queue.push(() => (running++, r()))));
const free = () => (running--, queue.shift()?.());

/**
 * A fetch that sends .onion URLs over Tor and anything else as usual (the light client's prover). `key` keeps
 * accounts on separate Tor circuits.
 */
export const torFetch =
  (key = "wallet"): typeof fetch =>
  async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isOnion(url)) return fetch(input, init);
    // a copy on your own computer: its server reaches Tor directly (app/api/local/tor), no gateway, no Tor here
    if (isLocal())
      return fetch(`${location.origin}/api/local/tor`, { ...init, method: "POST", headers: { "content-type": "application/json", [NODE_HEADER]: url } });
    await slot();
    try {
      const w = await tor();
      // the worker can't take a signal; viem's timeout still ends the wait
      const { signal: _, ...rest } = init ?? {};
      const r = await w.fetch(url, { ...rest, anonOptions: { isolationKey: key } });
      set("on");
      return r;
    } finally {
      free();
    }
  };
