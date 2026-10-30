import "server-only";
import { type Hex, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById } from "@/lib/chains";
import { upstreamRpc } from "@/lib/rpcServer";
import { GAS_BUDGET, GAS_TYPICAL, type Quote, type SendKind } from "@/lib/safe/fee";

/** The relay's key, chains, and fee quote: shared by /api/safe/relay and drops (lib/drops.ts). */

export function relayer() {
  const pk = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("relay not configured");
  return privateKeyToAccount(pk);
}

export function clients(chainId: number) {
  const info = chainById(chainId);
  const url = info && upstreamRpc(chainId);
  if (!info || !url) throw new Error("chain not enabled");
  const transport = http(url);
  return {
    info,
    pc: createPublicClient({ chain: info.chain, transport }),
    wc: createWalletClient({ chain: info.chain, transport, account: relayer() }),
  };
}

export const L1_ALLOWANCE = 200_000_000_000n; // 0.0000002 ETH

// Ethereum: the RPC suggests a 0 tip when blocks aren't full, and a 0-tip tx can sit for minutes (10-10: 3 min for a
// swap). Pay at least ~the median tip so it lands in the next block or two.
const TIP_FLOOR: Record<number, bigint> = { 1: 100_000_000n }; // 0.1 gwei
export const tipFloor = (chainId: number) => TIP_FLOOR[chainId] ?? 0n;

const prices = new Map<string, { v: number; at: number }>();
/** The chain's native coin in dollars (ETH, POL, BNB, …): Coinbase for ETH as before, Alchemy's prices for the rest. */
export async function nativeUsd(chainId: number): Promise<number> {
  const info = chainById(chainId)!;
  if (info.nativeIsUsdc) return 1;
  const sym = info.native.symbol.toUpperCase();
  const hit = prices.get(sym);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: number;
  if (sym === "ETH") {
    const j = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { cache: "no-store" }).then(r => r.json());
    v = Number(j?.data?.amount);
    if (!(v > 100)) throw new Error("no ETH price");
  } else {
    const j = await fetch(`https://api.g.alchemy.com/prices/v1/${process.env.ALCHEMY_API_KEY}/tokens/by-symbol?symbols=${sym}`, { cache: "no-store" }).then(r => r.json());
    v = Number(j?.data?.[0]?.prices?.find((p: any) => p.currency === "usd")?.value);
    if (!(v > 0)) throw new Error(`no ${sym} price`);
  }
  prices.set(sym, { v, at: Date.now() });
  return v;
}

export async function quote(chainId: number, kind: SendKind, extra = 0n): Promise<Quote> {
  const { pc } = clients(chainId);
  const gasPrice = (await pc.getGasPrice()) + tipFloor(chainId); // what a tx pays now (base fee + tip), not the 2× max fee cap
  const usd = await nativeUsd(chainId);
  // typical gas × 1.5, + the L1 data fee on an L2 (~$0.0002 on Base today; this allows ~2.5×)
  const gas = GAS_TYPICAL[kind] + (extra > 0n ? (extra < GAS_BUDGET[kind] ? extra : GAS_BUDGET[kind]) : 0n);
  const feeEth = (gas * gasPrice * 15n) / 10n + (chainId === 1 ? 0n : L1_ALLOWANCE);
  const feeUsdc = BigInt(Math.ceil((Number(feeEth) / 1e18) * usd * 1e6));
  return {
    chainId,
    relayer: relayer().address,
    kind,
    gasPrice: gasPrice.toString(),
    ethUsd: usd,
    feeEth: feeEth.toString(),
    feeUsdc: feeUsdc.toString(),
    until: Date.now() + 5 * 60_000,
  };
}

