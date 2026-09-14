import {
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import scaffoldConfig from "~~/scaffold.config";
import {
  chainId,
  factoryAbi,
  factoryAddress,
  instantWalletAbi,
  isBase,
  isLocal,
  targetChain,
  tokenAddress,
} from "~~/utils/chain";

/**
 * Server-side chain access. Route handlers only.
 *
 *  - localhost: anvil at http://127.0.0.1:8545, facilitator = FACILITATOR_PRIVATE_KEY (anvil account 0)
 *  - base:      Alchemy (NEXT_PUBLIC_ALCHEMY_API_KEY), facilitator = FACILITATOR_PRIVATE_KEY
 */
export { chainId, isBase, isLocal, targetChain, tokenAddress, factoryAddress, factoryAbi, instantWalletAbi };

export function rpcUrl(): string {
  if (isLocal)
    return (
      process.env.LOCAL_RPC_URL ||
      (scaffoldConfig.rpcOverrides as Record<number, string>)?.[chainId] ||
      "http://127.0.0.1:8545"
    );
  const override = process.env.RPC_URL || (scaffoldConfig.rpcOverrides as Record<number, string>)?.[chainId];
  if (override) return override;
  const alchemy = chainId === base.id ? "base-mainnet" : chainId === baseSepolia.id ? "base-sepolia" : undefined;
  if (alchemy) {
    const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
    if (!key) throw new Error(`Set NEXT_PUBLIC_ALCHEMY_API_KEY (or RPC_URL) for ${targetChain.name}`);
    return `https://${alchemy}.g.alchemy.com/v2/${key}`;
  }
  throw new Error(`No RPC configured for chain ${chainId}`);
}

let _public: PublicClient | undefined;
export function publicClient(): PublicClient {
  if (!_public) _public = createPublicClient({ chain: targetChain, transport: http(rpcUrl()) });
  return _public;
}

let _facilitator: WalletClient | undefined;
export function facilitatorClient(): WalletClient {
  if (_facilitator) return _facilitator;
  const pk = process.env.FACILITATOR_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("FACILITATOR_PRIVATE_KEY is not set in packages/nextjs/.env.local");
  }
  _facilitator = createWalletClient({
    chain: targetChain,
    transport: http(rpcUrl()),
    account: privateKeyToAccount(pk as `0x${string}`),
  });
  return _facilitator;
}

export function facilitatorAddress(): Address {
  return facilitatorClient().account!.address;
}

export function requireFactory(): Address {
  if (!factoryAddress) throw new Error(`Factory is not deployed on chain ${chainId} (set NEXT_PUBLIC_FACTORY_ADDRESS)`);
  return factoryAddress;
}

export function requireToken(): Address {
  if (!tokenAddress) throw new Error(`No token configured for chain ${chainId} (set NEXT_PUBLIC_TOKEN_ADDRESS)`);
  return tokenAddress;
}

let _tokenMeta: { address: Address; symbol: string; decimals: number } | undefined;
export async function tokenMeta() {
  const address = requireToken();
  if (_tokenMeta && _tokenMeta.address === address) return _tokenMeta;
  const pc = publicClient();
  const [symbol, decimals] = await Promise.all([
    pc.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  _tokenMeta = { address, symbol, decimals };
  return _tokenMeta;
}

export async function tokenBalance(owner: Address, token?: Address): Promise<bigint> {
  return publicClient().readContract({
    address: token ?? requireToken(),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function isDeployed(address: Address): Promise<boolean> {
  const code = await publicClient().getCode({ address });
  return !!code && code !== "0x";
}

/** Small fee (in token base units) charged inside every transfer so the facilitator path is exercised. */
export function facilitatorFee(decimals: number): bigint {
  const env = process.env.FACILITATOR_FEE;
  if (env && /^\d+$/.test(env)) return BigInt(env);
  // 0.02 USDC at 6 decimals
  return 2n * 10n ** BigInt(Math.max(0, decimals - 2));
}
