import { NextRequest, NextResponse } from "next/server";
import { formatUnits, getAddress, isAddress, parseEther, parseUnits } from "viem";
import { assetBalance, facilitatorClient, isLocal, localUsdc, publicClient, targetChain } from "~~/services/chain";
import { invalidatePortfolio } from "~~/services/portfolio";
import { isTestnet, mockUsdcAbi } from "~~/utils/chain";
import { ETH_ASSET } from "~~/utils/digests";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

/**
 * Local play chain only. `POST {wallet, amount:"100"}` mints MockUSDC into a wallet;
 * `POST {wallet, amount:"1", asset:"ETH"}` sends ETH from the facilitator (anvil account 0).
 * Works for a counterfactual address too — that is the point.
 */
export async function POST(req: NextRequest) {
  if (!isLocal) {
    return NextResponse.json(
      {
        error: isTestnet
          ? "minting only works on the local chain; on Base Sepolia get test USDC from faucet.circle.com and send it to the wallet address"
          : "minting only works on the local chain; send ETH or USDC to the wallet address instead",
      },
      { status: 400 },
    );
  }
  const body = await req.json().catch(() => ({}));
  if (!isAddress(body.wallet)) return NextResponse.json({ error: "wallet must be an address" }, { status: 400 });
  const amount = typeof body.amount === "string" ? body.amount.trim() : "100";
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0)
    return NextResponse.json({ error: "bad amount" }, { status: 400 });
  const eth = String(body.asset ?? "").toUpperCase() === "ETH" || body.asset === ETH_ASSET;
  try {
    const wallet = getAddress(body.wallet);
    const fc = facilitatorClient();
    let hash: `0x${string}`;
    let asset = ETH_ASSET;
    let decimals = 18;
    if (eth) {
      hash = await fc.sendTransaction({
        chain: targetChain,
        account: fc.account!,
        to: wallet,
        value: parseEther(amount),
      });
    } else {
      if (!localUsdc) return NextResponse.json({ error: "MockUSDC is not deployed on this chain" }, { status: 400 });
      asset = localUsdc.address;
      decimals = localUsdc.decimals;
      hash = await fc.writeContract({
        chain: targetChain,
        account: fc.account!,
        address: localUsdc.address,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [wallet, parseUnits(amount, localUsdc.decimals)],
      });
    }
    await publicClient().waitForTransactionReceipt({ hash });
    invalidatePortfolio(wallet);
    const balance = await assetBalance(wallet, asset);
    return NextResponse.json({
      txHash: hash,
      asset,
      balance: balance.toString(),
      balanceFormatted: formatUnits(balance, decimals),
    });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
