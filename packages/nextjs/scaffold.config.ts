import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
};

/**
 * NEXT_PUBLIC_TARGET_NETWORK=localhost   -> anvil (31337) at http://127.0.0.1:8545
 * NEXT_PUBLIC_TARGET_NETWORK=baseSepolia -> Base Sepolia (84532) via Alchemy
 * NEXT_PUBLIC_TARGET_NETWORK=base        -> Base mainnet (8453) via Alchemy
 */
const target = (process.env.NEXT_PUBLIC_TARGET_NETWORK || "localhost").toLowerCase();
const targetChain: chains.Chain =
  target === "base"
    ? chains.base
    : target === "basesepolia" || target === "base-sepolia"
      ? chains.baseSepolia
      : chains.foundry;

const scaffoldConfig = {
  targetNetworks: [targetChain],
  pollingInterval: 3000,
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "",
  rpcOverrides: {
    [chains.foundry.id]: process.env.NEXT_PUBLIC_LOCAL_RPC_URL || "http://127.0.0.1:8545",
  },
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
