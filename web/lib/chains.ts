import { type Address, type Chain, createPublicClient, http } from "viem";
import { arbitrum, arc, avalanche, base, bsc, celo, foundry, gnosis, hyperEvm, mainnet, optimism, plasma, polygon, robinhood, sonic } from "viem/chains";

/**
 * Chains the wallet lives on: every one with the Safe 1.5.0 contracts, the passkey signer, recovery and Roles at
 * their usual addresses (checked on chain 2026-10-08), on Alchemy, and on LI.FI. A wallet's address is the same on
 * all of them.
 *
 *   NEXT_PUBLIC_CHAINS           all of them (default), a few ("8453,1"), or "31337" for a local anvil
 *
 * Browsers never see an RPC key: reads go through /api/rpc/<chainId>.
 */

export type ChainInfo = {
  id: number;
  name: string;
  short: string; // link prefix: instantwallet.io/base:0x…
  chain: Chain;
  explorer?: string;
  usdc?: Address; // Circle's USDC, 6 decimals (none on BNB, Plasma, Robinhood: fees there are in the native coin)
  color: string;
  icon?: string;
  alchemy?: string; // <alchemy>.g.alchemy.com
  dex?: string; // DexScreener's name for it
  native: { symbol: string; name: string; logo?: string };
  nativeBudget?: bigint; // the burner's daily native-coin limit, ~$100 (0.04 ETH where it's ETH)
  nativeIsUsdc?: boolean; // Arc: gas is USDC, and the native balance is the USDC token's balance again
};

const ETHER = { symbol: "ETH", name: "Ether", logo: "/tokens/eth.png" };
const e18 = 10n ** 18n;
const ex = (c: Chain) => c.blockExplorers?.default.url;

const ALL: ChainInfo[] = [
  {
    id: base.id,
    name: "Base",
    short: "base",
    chain: base,
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    color: "#0052ff",
    icon: "/tokens/base.webp",
    alchemy: "base-mainnet",
    dex: "base",
    native: ETHER,
  },
  {
    id: mainnet.id,
    name: "Ethereum",
    short: "eth",
    chain: mainnet,
    explorer: "https://etherscan.io",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    color: "#627eea",
    icon: "/tokens/ethereum.webp",
    alchemy: "eth-mainnet",
    dex: "ethereum",
    native: ETHER,
  },
  { id: arbitrum.id, name: "Arbitrum", short: "arb", chain: arbitrum, explorer: ex(arbitrum), usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", color: "#213147", icon: "/chains/arbitrum.svg", alchemy: "arb-mainnet", dex: "arbitrum", native: ETHER },
  { id: optimism.id, name: "Optimism", short: "op", chain: optimism, explorer: ex(optimism), usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", color: "#ff0420", icon: "/chains/optimism.svg", alchemy: "opt-mainnet", dex: "optimism", native: ETHER },
  { id: robinhood.id, name: "Robinhood", short: "robinhood", chain: robinhood, explorer: ex(robinhood), color: "#1d1d1d", icon: "/chains/robinhood.svg", alchemy: "robinhood-mainnet", dex: "robinhood", native: ETHER },
  { id: polygon.id, name: "Polygon", short: "polygon", chain: polygon, explorer: ex(polygon), usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", color: "#8247e5", icon: "/chains/polygon.svg", alchemy: "polygon-mainnet", dex: "polygon", native: { symbol: "POL", name: "Polygon", logo: "/tokens/pol.png" }, nativeBudget: 1000n * e18 },
  { id: avalanche.id, name: "Avalanche", short: "avax", chain: avalanche, explorer: ex(avalanche), usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", color: "#e84142", icon: "/chains/avalanche.svg", alchemy: "avax-mainnet", dex: "avalanche", native: { symbol: "AVAX", name: "Avalanche", logo: "/tokens/avax.png" }, nativeBudget: 10n * e18 },
  { id: bsc.id, name: "BNB Chain", short: "bnb", chain: bsc, explorer: ex(bsc), color: "#f0b90b", icon: "/chains/bsc.svg", alchemy: "bnb-mainnet", dex: "bsc", native: { symbol: "BNB", name: "BNB", logo: "/tokens/bnb.png" }, nativeBudget: (15n * e18) / 100n },
  { id: gnosis.id, name: "Gnosis", short: "gnosis", chain: gnosis, explorer: ex(gnosis), usdc: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", color: "#3e6957", icon: "/chains/gnosis.svg", alchemy: "gnosis-mainnet", dex: "gnosischain", native: { symbol: "xDAI", name: "xDAI", logo: "/tokens/xdai.png" }, nativeBudget: 100n * e18 },
  { id: celo.id, name: "Celo", short: "celo", chain: celo, explorer: ex(celo), usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", color: "#fcbe00", icon: "/chains/celo.svg", alchemy: "celo-mainnet", dex: "celo", native: { symbol: "CELO", name: "Celo", logo: "/tokens/celo.png" }, nativeBudget: 1000n * e18 },
  { id: sonic.id, name: "Sonic", short: "sonic", chain: sonic, explorer: ex(sonic), usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", color: "#1a2b4c", icon: "/chains/sonic.svg", alchemy: "sonic-mainnet", dex: "sonic", native: { symbol: "S", name: "Sonic", logo: "/tokens/s.png" }, nativeBudget: 2500n * e18 },
  { id: hyperEvm.id, name: "HyperEVM", short: "hyperevm", chain: hyperEvm, explorer: ex(hyperEvm), usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", color: "#0f3933", icon: "/chains/hyperevm.svg", alchemy: "hyperliquid-mainnet", dex: "hyperevm", native: { symbol: "HYPE", name: "Hyperliquid", logo: "/tokens/hype.png" }, nativeBudget: (12n * e18) / 10n },
  { id: plasma.id, name: "Plasma", short: "plasma", chain: plasma, explorer: ex(plasma), color: "#162f29", icon: "/chains/plasma.svg", alchemy: "plasma-mainnet", dex: "plasma", native: { symbol: "XPL", name: "Plasma", logo: "/tokens/xpl.png" }, nativeBudget: 1000n * e18 },
  { id: arc.id, name: "Arc", short: "arc", chain: arc, explorer: ex(arc), usdc: "0x3600000000000000000000000000000000000000", color: "#1b1b1b", icon: "/chains/arc.svg", alchemy: "arc-mainnet", dex: "arc", native: { symbol: "USDC", name: "USDC", logo: "/tokens/usdc.png" }, nativeBudget: 100n * e18, nativeIsUsdc: true },
  { id: foundry.id, name: "Local", short: "local", chain: foundry, color: "#787b78", native: ETHER },
];

const wanted = (process.env.NEXT_PUBLIC_CHAINS || ALL.filter(c => c.id !== foundry.id).map(c => c.id).join(",")).split(",").map(s => Number(s.trim()));
export const CHAINS: ChainInfo[] = wanted.map(id => ALL.find(c => c.id === id)).filter((c): c is ChainInfo => !!c);
export const DEFAULT_CHAIN = CHAINS[0];

/** Any known chain, enabled or not (the server still resolves ENS on Ethereum when only Base is enabled). */
export const knownChain = (id: number) => ALL.find(c => c.id === id);

/** The native coin's symbol on a chain: "ETH", "POL", "BNB", … */
export const nativeSymbol = (chainId: number) => chainById(chainId)?.native.symbol ?? "ETH";

export function chainById(id: number): ChainInfo | undefined {
  return CHAINS.find(c => c.id === id);
}

export function chainByShort(short: string): ChainInfo | undefined {
  const s = short.toLowerCase();
  return CHAINS.find(c => c.short === s || c.name.toLowerCase() === s || String(c.id) === s) ??
    (s === "ethereum" || s === "mainnet" ? chainById(1) : undefined);
}

/** InstantWallet v3.1 + its Factory: CREATE2 through the deterministic deployer, the same on every chain (anvil too). */
export const FACTORY: Address = "0x896c8D40022A79FC1228dB800FD3aaf7f21d7469";
export const IMPLEMENTATION: Address = "0xBd1569c8978fB403079b75eBAcc369F0E7244B6F";
/** Chains with the v3.1 contracts and Circle Paymaster: the only ones a send can go out on today. */
export const SENDABLE = new Set([8453]);

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
