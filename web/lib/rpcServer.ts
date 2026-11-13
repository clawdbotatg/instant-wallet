import "server-only";
import { knownChain } from "./chains";

/**
 * Upstream JSON-RPC URL per chain (server only; the Alchemy key never reaches a browser). RPC_URL_<chainId> (e.g.
 * RPC_URL_1=http://127.0.0.1:8545) is your own node for that network: on a copy you run yourself (run-local.sh), it
 * carries the reads and the relay's sends instead of Alchemy. Alchemy still lists coins and prices.
 */
export function upstreamRpc(chainId: number): string | undefined {
  const key = process.env.ALCHEMY_API_KEY;
  const own = process.env[`RPC_URL_${chainId}`];
  if (own) return own;
  if (chainId === 31337) return process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
  if (chainId === 8453 && process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
  if (chainId === 1 && process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;
  const net = alchemyNetwork(chainId);
  return key && net ? `https://${net}.g.alchemy.com/v2/${key}` : undefined;
}

/** The same, or it throws: viem's http(undefined) quietly uses the chain's public RPC, and we never use those. */
export function mustRpc(chainId: number): string {
  const url = upstreamRpc(chainId);
  if (!url) throw new Error(`no RPC for chain ${chainId}`);
  return url;
}

export const alchemyNetwork = (chainId: number) => knownChain(chainId)?.alchemy;

export async function rpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  const url = upstreamRpc(chainId);
  if (!url) throw new Error(`no RPC for chain ${chainId}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}
