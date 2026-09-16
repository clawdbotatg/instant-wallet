import { type Address, type Chain, getAddress } from "viem";
import { base, baseSepolia, foundry, mainnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import scaffoldConfig from "~~/scaffold.config";
import { ETH_ASSET } from "~~/utils/digests";
import type { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * Isomorphic chain configuration (safe to import from client components).
 * Server-only pieces (RPC clients, the facilitator key) live in services/chain.ts.
 */
export const targetChain: Chain = scaffoldConfig.targetNetworks[0];
export const chainId = targetChain.id;
export const isLocal = chainId === foundry.id;
export const isBase = chainId === base.id;
export const isMainnet = chainId === mainnet.id;
export const isBaseSepolia = chainId === baseSepolia.id;
export const isTestnet = isBaseSepolia;

export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const MAINNET_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// ABIs are chain-independent: the local deployment carries the canonical ones.
const all = deployedContracts as GenericContractsDeclaration;
const local = all[foundry.id] ?? {};
const onChain = all[chainId] ?? {};

export const instantWalletAbi = (onChain.InstantWallet?.abi ??
  local.InstantWallet?.abi ??
  []) as (typeof deployedContracts)[31337]["InstantWallet"]["abi"];
export const factoryAbi = (onChain.Factory?.abi ??
  local.Factory?.abi ??
  []) as (typeof deployedContracts)[31337]["Factory"]["abi"];
export const mockUsdcAbi = (local.MockUSDC?.abi ?? []) as (typeof deployedContracts)[31337]["MockUSDC"]["abi"];

function envAddress(name: string): Address | undefined {
  const v = process.env[name];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : undefined;
}

/**
 * Factory address: env override, else the deployment for this chain. The factory is deployed through
 * the deterministic CREATE2 deployer, so on a real chain without its own entry we fall back to the
 * address recorded for any other real chain (never the local one).
 */
const otherRealFactory = isLocal
  ? undefined
  : Object.entries(all).find(([id, c]) => Number(id) !== foundry.id && c.Factory)?.[1]?.Factory?.address;
export const factoryAddress: Address | undefined =
  envAddress("NEXT_PUBLIC_FACTORY_ADDRESS") ??
  (onChain.Factory ? getAddress(onChain.Factory.address) : otherRealFactory ? getAddress(otherRealFactory) : undefined);

export type KnownAsset = { address: Address; symbol: string; decimals: number; name: string };

/** Native ETH as an asset row (asset = address(0) in every digest). */
export const ETH_META: KnownAsset = { address: ETH_ASSET, symbol: "ETH", decimals: 18, name: "Ether" };

/** The stablecoin we suggest for a first spender limit on this chain (the wallet may hold anything). */
export const DEFAULT_STABLE: KnownAsset | undefined = isBase
  ? { address: BASE_USDC, symbol: "USDC", decimals: 6, name: "USD Coin" }
  : isMainnet
    ? { address: MAINNET_USDC, symbol: "USDC", decimals: 6, name: "USD Coin" }
    : isBaseSepolia
      ? { address: BASE_SEPOLIA_USDC, symbol: "USDC", decimals: 6, name: "USD Coin" }
      : onChain.MockUSDC
        ? { address: getAddress(onChain.MockUSDC.address), symbol: "USDC", decimals: 6, name: "Mock USDC" }
        : undefined;

/** Assets always offered in pickers even when the wallet holds none of them yet. */
export const KNOWN_ASSETS: KnownAsset[] = [ETH_META, ...(DEFAULT_STABLE ? [DEFAULT_STABLE] : [])];

const EXPLORER = isBase
  ? "https://basescan.org"
  : isMainnet
    ? "https://etherscan.io"
    : isBaseSepolia
      ? "https://sepolia.basescan.org"
      : undefined;
export const hasExplorer = !!EXPLORER;
export const explorerTxUrl = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : `#tx-${hash}`);
export const explorerAddressUrl = (addr: string) => (EXPLORER ? `${EXPLORER}/address/${addr}` : `#addr-${addr}`);

export const chainLabel = isBase ? "Base" : isMainnet ? "Ethereum" : isBaseSepolia ? "Base Sepolia" : "Local";

/** Alchemy network slug for this chain (RPC subdomain and the data/prices APIs), if it has one. */
export const alchemyNetwork = isBase
  ? "base-mainnet"
  : isMainnet
    ? "eth-mainnet"
    : isBaseSepolia
      ? "base-sepolia"
      : undefined;
