import { NextRequest, NextResponse } from "next/server";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { facilitatorClient, isLocal, publicClient, targetChain, tokenBalance, tokenMeta } from "~~/services/chain";
import { isTestnet, mockUsdcAbi } from "~~/utils/chain";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

/** Local play chain only: mint MockUSDC into a wallet. `POST {wallet, amount:"100"}`. */
export async function POST(req: NextRequest) {
  if (!isLocal) {
    return NextResponse.json(
      {
        error: isTestnet
          ? "minting only works on the local chain; on Base Sepolia get test USDC from faucet.circle.com and send it to the wallet address"
          : "minting only works on the local chain; send USDC to the wallet address instead",
      },
      { status: 400 },
    );
  }
  const body = await req.json().catch(() => ({}));
  if (!isAddress(body.wallet)) return NextResponse.json({ error: "wallet must be an address" }, { status: 400 });
  const amount = typeof body.amount === "string" ? body.amount.trim() : "100";
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0)
    return NextResponse.json({ error: "bad amount" }, { status: 400 });
  try {
    const token = await tokenMeta();
    const wallet = getAddress(body.wallet);
    const fc = facilitatorClient();
    const hash = await fc.writeContract({
      chain: targetChain,
      account: fc.account!,
      address: token.address,
      abi: mockUsdcAbi,
      functionName: "mint",
      args: [wallet, parseUnits(amount, token.decimals)],
    });
    await publicClient().waitForTransactionReceipt({ hash });
    const balance = await tokenBalance(wallet);
    return NextResponse.json({
      txHash: hash,
      balance: balance.toString(),
      balanceFormatted: formatUnits(balance, token.decimals),
    });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
