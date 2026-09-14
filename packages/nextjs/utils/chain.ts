import { type Address, type Chain, getAddress } from "viem";
import { base, baseSepolia, foundry } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import scaffoldConfig from "~~/scaffold.config";
import type { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * Isomorphic chain configuration (safe to import from client components).
 * Server-only pieces (RPC clients, the facilitator key) live in services/chain.ts.
 */
export const targetChain: Chain = scaffoldConfig.targetNetworks[0];
export const chainId = targetChain.id;
export const isLocal = chainId === foundry.id;
export const isBase = chainId === base.id;
export const isBaseSepolia = chainId === baseSepolia.id;
export const isTestnet = isBaseSepolia;

export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// ABIs are chain-independent: the local deployment carries the canonical ones.
const local = (deployedContracts as GenericContractsDeclaration)[foundry.id] ?? {};
const onChain = (deployedContracts as GenericContractsDeclaration)[chainId] ?? {};

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

/** Factory address: env override, else the deployment for this chain. */
export const factoryAddress: Address | undefined =
  envAddress("NEXT_PUBLIC_FACTORY_ADDRESS") ?? (onChain.Factory ? getAddress(onChain.Factory.address) : undefined);

/** The stablecoin the spender limit applies to. */
export const tokenAddress: Address | undefined =
  envAddress("NEXT_PUBLIC_TOKEN_ADDRESS") ??
  (isBase
    ? BASE_USDC
    : isBaseSepolia
      ? BASE_SEPOLIA_USDC
      : onChain.MockUSDC
        ? getAddress(onChain.MockUSDC.address)
        : undefined);

const EXPLORER = isBase ? "https://basescan.org" : isBaseSepolia ? "https://sepolia.basescan.org" : undefined;
export const hasExplorer = !!EXPLORER;
export const explorerTxUrl = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : `#tx-${hash}`);
export const explorerAddressUrl = (addr: string) => (EXPLORER ? `${EXPLORER}/address/${addr}` : `#addr-${addr}`);

export const chainLabel = isBase ? "Base" : isBaseSepolia ? "Base Sepolia" : "Local";
