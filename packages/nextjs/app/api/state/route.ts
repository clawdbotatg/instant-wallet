import { NextRequest, NextResponse } from "next/server";
import { formatEther, getAddress, isAddress } from "viem";
import { facilitatorAddress, isDeployed, isLocal, publicClient } from "~~/services/chain";
import { portfolio } from "~~/services/portfolio";
import { expireStale } from "~~/services/store";
import { readRecovery, readSigners } from "~~/services/wallet";
import { chainId, targetChain } from "~~/utils/chain";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

// The device polls every 12 s. Cache chain reads briefly so a poll is fast and the RPC stays quiet.
const CACHE_MS = 4000;
const cache = new Map<string, { at: number; value: any }>();

/**
 * `GET /api/state?wallet=0x…` -> what the device shows on its home screen (docs/PROTOCOL.md section 5):
 * `{chain, wallet:{address, ensName, deployed, balanceUsd, assets:[…]}, relayer, signers:[…, limits:[…]], pendingRecovery}`.
 */
export async function GET(req: NextRequest) {
  const w = req.nextUrl.searchParams.get("wallet");
  if (!w || !isAddress(w)) return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  const wallet = getAddress(w);
  try {
    await expireStale();
    const hit = cache.get(wallet);
    if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json(hit.value);
    const relayer = facilitatorAddress();
    const [deployed, pf, relayBal, signers, recovery] = await Promise.all([
      isDeployed(wallet),
      portfolio(wallet),
      publicClient().getBalance({ address: relayer }),
      readSigners(wallet),
      readRecovery(wallet).catch(() => null),
    ]);
    const value = {
      chain: { id: chainId, name: targetChain.name, isLocal },
      wallet: {
        address: wallet,
        ensName: null,
        deployed,
        balanceUsd: pf.totalUsd === null ? null : pf.totalUsd.toFixed(2),
        assets: pf.assets.map(a => ({
          asset: a.asset,
          symbol: a.symbol,
          decimals: a.decimals,
          balance: a.balance,
          balanceFormatted: a.balanceFormatted,
          usd: a.usd === null ? null : a.usd.toFixed(2),
        })),
      },
      relayer: { address: relayer, balanceFormatted: formatEther(relayBal) },
      signers: signers.map(s => ({
        ...s,
        limits: s.limits.map(l => ({
          asset: l.asset,
          symbol: l.symbol,
          decimals: l.decimals,
          limit: l.limit,
          remaining: l.remaining,
        })),
      })),
      pendingRecovery: recovery?.pending ?? null,
      recovery: recovery ? { address: recovery.recoveryAddress, delay: recovery.recoveryDelay } : null,
      now: Date.now(),
    };
    cache.set(wallet, { at: Date.now(), value });
    return NextResponse.json(value);
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
