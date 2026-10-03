import { type Address, type Chain, createPublicClient, getAddress, http } from "viem";
import { base, foundry, mainnet } from "viem/chains";

/**
 * Chains the wallet lives on. The Factory is deployed through the deterministic CREATE2 deployer, so it has
 * the same address on every chain and a key's wallet address is the same everywhere.
 *
 *   NEXT_PUBLIC_CHAINS           "8453,1" (default) or "31337" for a local anvil
 *   NEXT_PUBLIC_FACTORY_ADDRESS  the v3 Factory
 *
 * Browsers never see an RPC key: every read and every gas-key transaction goes through /api/rpc/<chainId>.
 */

export type ChainInfo = {
  id: number;
  name: string;
  short: string; // link prefix: instantwallet.io/base:0x…
  chain: Chain;
  explorer?: string;
  usdc?: Address;
  color: string;
};

const ALL: ChainInfo[] = [
  {
    id: base.id,
    name: "Base",
    short: "base",
    chain: base,
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    color: "#0052ff",
  },
  {
    id: mainnet.id,
    name: "Ethereum",
    short: "eth",
    chain: mainnet,
    explorer: "https://etherscan.io",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    color: "#627eea",
  },
  { id: foundry.id, name: "Local", short: "local", chain: foundry, color: "#787b78" },
];

const wanted = (process.env.NEXT_PUBLIC_CHAINS || "8453,1").split(",").map(s => Number(s.trim()));
export const CHAINS: ChainInfo[] = wanted.map(id => ALL.find(c => c.id === id)).filter((c): c is ChainInfo => !!c);
export const DEFAULT_CHAIN = CHAINS[0];

export function chainById(id: number): ChainInfo | undefined {
  return CHAINS.find(c => c.id === id);
}

export function chainByShort(short: string): ChainInfo | undefined {
  const s = short.toLowerCase();
  return CHAINS.find(c => c.short === s || c.name.toLowerCase() === s || String(c.id) === s) ??
    (s === "ethereum" || s === "mainnet" ? chainById(1) : undefined);
}

const f = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
export const FACTORY: Address | undefined = f && /^0x[0-9a-fA-F]{40}$/.test(f) ? getAddress(f) : undefined;

export const ETH: Address = "0x0000000000000000000000000000000000000000";

const clients = new Map<number, ReturnType<typeof createPublicClient>>();
/** Read client for a chain, through our RPC proxy (browser). Server code uses lib/rpcServer.ts directly. */
export function publicClient(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    const info = chainById(chainId);
    if (!info) throw new Error(`chain ${chainId} not enabled`);
    c = createPublicClient({ chain: info.chain, transport: http(rpcPath(chainId)), batch: { multicall: false } });
    clients.set(chainId, c);
  }
  return c;
}

export function rpcPath(chainId: number): string {
  return `${typeof window === "undefined" ? "" : window.location.origin}/api/rpc/${chainId}`;
}

export const explorerTx = (chainId: number, hash: string) =>
  chainById(chainId)?.explorer ? `${chainById(chainId)!.explorer}/tx/${hash}` : undefined;
export const explorerAddress = (chainId: number, addr: string) =>
  chainById(chainId)?.explorer ? `${chainById(chainId)!.explorer}/address/${addr}` : undefined;
