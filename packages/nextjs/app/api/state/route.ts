import { NextRequest, NextResponse } from "next/server";
import { formatEther, formatUnits, getAddress, isAddress } from "viem";
import { facilitatorAddress, isDeployed, isLocal, publicClient, tokenBalance, tokenMeta } from "~~/services/chain";
import { expireStale } from "~~/services/store";
import { readRecovery, readSigners } from "~~/services/wallet";
import { chainId, targetChain } from "~~/utils/chain";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

// The device polls every 12 s. Cache chain reads briefly so a poll is fast and the RPC stays quiet.
const CACHE_MS = 4000;
const cache = new Map<string, { at: number; value: any }>();

/** `GET /api/state?wallet=0x…` -> what the device shows on its home screen. */
export async function GET(req: NextRequest) {
  const w = req.nextUrl.searchParams.get("wallet");
  if (!w || !isAddress(w)) return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  const wallet = getAddress(w);
  try {
    await expireStale();
    const hit = cache.get(wallet);
    if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json(hit.value);
    const token = await tokenMeta();
    const deployed = await isDeployed(wallet);
    const relayer = facilitatorAddress();
    const [balance, relayBal, signers, recovery] = await Promise.all([
      tokenBalance(wallet),
      publicClient().getBalance({ address: relayer }),
      deployed ? readSigners(wallet) : Promise.resolve([]),
      deployed ? readRecovery(wallet) : Promise.resolve(null),
    ]);
    const value = {
      chain: { id: chainId, name: targetChain.name, isLocal },
      wallet: {
        address: wallet,
        ensName: null,
        deployed,
        balance: balance.toString(),
        balanceFormatted: formatUnits(balance, token.decimals),
      },
      token,
      relayer: { address: relayer, balanceFormatted: formatEther(relayBal) },
      signers,
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
