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
import scaffoldConfig from "~~/scaffold.config";
import {
  DEFAULT_STABLE,
  ETH_META,
  type KnownAsset,
  alchemyNetwork,
  chainId,
  factoryAbi,
  factoryAddress,
  instantWalletAbi,
  isBase,
  isLocal,
  targetChain,
} from "~~/utils/chain";
import { isEth } from "~~/utils/digests";

/**
 * Server-side chain access. Route handlers only.
 *
 *  - localhost: anvil at http://127.0.0.1:8545, facilitator = FACILITATOR_PRIVATE_KEY (anvil account 0)
 *  - base / mainnet: Alchemy (NEXT_PUBLIC_ALCHEMY_API_KEY), facilitator = FACILITATOR_PRIVATE_KEY
 */
export { chainId, isBase, isLocal, targetChain, factoryAddress, factoryAbi, instantWalletAbi };

export function rpcUrl(): string {
  if (isLocal)
    return (
      process.env.LOCAL_RPC_URL ||
      (scaffoldConfig.rpcOverrides as Record<number, string>)?.[chainId] ||
      "http://127.0.0.1:8545"
    );
  const override = process.env.RPC_URL || (scaffoldConfig.rpcOverrides as Record<number, string>)?.[chainId];
  if (override) return override;
  if (alchemyNetwork) {
    const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
    if (!key) throw new Error(`Set NEXT_PUBLIC_ALCHEMY_API_KEY (or RPC_URL) for ${targetChain.name}`);
    return `https://${alchemyNetwork}.g.alchemy.com/v2/${key}`;
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

/** The local play chain's MockUSDC (the only token we can mint); undefined elsewhere. */
export const localUsdc: KnownAsset | undefined = isLocal ? DEFAULT_STABLE : undefined;

export type AssetMeta = { address: Address; symbol: string; decimals: number; name?: string };

const _meta = new Map<string, AssetMeta>([[ETH_META.address, ETH_META]]);
if (DEFAULT_STABLE) _meta.set(DEFAULT_STABLE.address.toLowerCase(), DEFAULT_STABLE);

/** symbol + decimals of an asset (ETH = address(0)); ERC-20 reads are cached for the process. */
export async function assetMeta(asset: Address): Promise<AssetMeta> {
  const k = asset.toLowerCase();
  if (isEth(k)) return ETH_META;
  const hit = _meta.get(k);
  if (hit) return hit;
  const pc = publicClient();
  const [symbol, decimals] = await Promise.all([
    pc.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }).catch(() => "TOKEN"),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  const m = { address: asset, symbol, decimals: Number(decimals) };
  _meta.set(k, m);
  return m;
}

/** Balance of `asset` (ETH or ERC-20) held by `owner`, in base units. */
export async function assetBalance(owner: Address, asset: Address): Promise<bigint> {
  const pc = publicClient();
  if (isEth(asset)) return pc.getBalance({ address: owner });
  return pc.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function isDeployed(address: Address): Promise<boolean> {
  const code = await publicClient().getCode({ address });
  return !!code && code !== "0x";
}

/**
 * Fee (in the transferred asset's base units) the facilitator charges inside a transfer. Default 0.
 * `FACILITATOR_FEE_BPS` charges a share of the amount; `FACILITATOR_FEE` is a flat amount that only
 * applies to the chain's default stablecoin (it is denominated in that asset's base units).
 */
export type FeePolicy = { bps: number; flatStable: string };
export function feePolicy(): FeePolicy {
  const bps = process.env.FACILITATOR_FEE_BPS;
  const flat = process.env.FACILITATOR_FEE;
  return { bps: bps && /^\d+$/.test(bps) ? Number(bps) : 0, flatStable: flat && /^\d+$/.test(flat) ? flat : "0" };
}
export function facilitatorFee(asset: Address, amount: bigint): bigint {
  const bps = process.env.FACILITATOR_FEE_BPS;
  if (bps && /^\d+$/.test(bps)) return (amount * BigInt(bps)) / 10_000n;
  const flat = process.env.FACILITATOR_FEE;
  if (flat && /^\d+$/.test(flat) && DEFAULT_STABLE && asset.toLowerCase() === DEFAULT_STABLE.address.toLowerCase())
    return BigInt(flat);
  return 0n;
}
