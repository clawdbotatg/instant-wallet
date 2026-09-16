import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
};

/**
 * NEXT_PUBLIC_TARGET_NETWORK=base        -> Base mainnet (8453) via Alchemy   [default]
 * NEXT_PUBLIC_TARGET_NETWORK=mainnet     -> Ethereum (1) via Alchemy (same Factory address as Base)
 * NEXT_PUBLIC_TARGET_NETWORK=localhost   -> anvil (31337) at http://127.0.0.1:8545
 * NEXT_PUBLIC_TARGET_NETWORK=baseSepolia -> Base Sepolia (84532), kept as a harmless option
 */
const target = (process.env.NEXT_PUBLIC_TARGET_NETWORK || "base").toLowerCase();
const targetChain: chains.Chain =
  target === "localhost" || target === "anvil" || target === "foundry" || target === "hardhat"
    ? chains.foundry
    : target === "mainnet" || target === "ethereum" || target === "eth"
      ? chains.mainnet
      : target === "basesepolia" || target === "base-sepolia"
        ? chains.baseSepolia
        : chains.base;

const scaffoldConfig = {
  targetNetworks: [targetChain],
  pollingInterval: 3000,
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "",
  rpcOverrides: {
    [chains.foundry.id]: process.env.NEXT_PUBLIC_LOCAL_RPC_URL || "http://127.0.0.1:8545",
  },
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
