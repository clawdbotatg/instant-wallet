import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hex } from "viem";
import {
  facilitatorClient,
  factoryAbi,
  isDeployed,
  publicClient,
  requireFactory,
  targetChain,
} from "~~/services/chain";
import { isBytes32 } from "~~/services/relay";
import { setPairing } from "~~/services/store";
import { chainId } from "~~/utils/chain";
import { ZERO_BYTES32, signerIdOf } from "~~/utils/digests";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

const SALT = ZERO_BYTES32;

async function predict(qx: Hex, qy: Hex): Promise<Address> {
  return (await publicClient().readContract({
    address: requireFactory(),
    abi: factoryAbi,
    functionName: "getWalletAddress",
    args: [qx, qy, SALT],
  })) as Address;
}

/** Predict the CREATE2 address (shown before deployment). */
export async function GET(req: NextRequest) {
  try {
    const qx = req.nextUrl.searchParams.get("qx");
    const qy = req.nextUrl.searchParams.get("qy");
    if (!isBytes32(qx) || !isBytes32(qy))
      return NextResponse.json({ error: "qx and qy must be bytes32" }, { status: 400 });
    const wallet = await predict(qx, qy);
    return NextResponse.json({ wallet, signerId: signerIdOf(qx, qy), chainId, deployed: await isDeployed(wallet) });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}

/** `POST {qx, qy, kind, credentialIdHash}` -> Factory.createWallet. The first key becomes the owner. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { qx, qy } = body;
    if (!isBytes32(qx) || !isBytes32(qy))
      return NextResponse.json({ error: "qx and qy must be bytes32" }, { status: 400 });
    const kind = Number(body.kind ?? 0);
    if (kind !== 0 && kind !== 1)
      return NextResponse.json({ error: "kind must be 0 (passkey) or 1 (raw)" }, { status: 400 });
    const credentialIdHash: Hex = isBytes32(body.credentialIdHash) ? body.credentialIdHash : ZERO_BYTES32;

    const wallet = await predict(qx, qy);
    const signerId = signerIdOf(qx, qy);
    if (await isDeployed(wallet)) {
      if (kind === 1) await setPairing(signerId, wallet);
      return NextResponse.json({ wallet, signerId, chainId, alreadyDeployed: true });
    }

    const pc = publicClient();
    const fc = facilitatorClient();
    const { request } = await pc.simulateContract({
      address: requireFactory(),
      abi: factoryAbi,
      functionName: "createWallet",
      args: [SALT, qx, qy, kind, credentialIdHash],
      account: fc.account!,
    });
    const txHash = await fc.writeContract({ ...request, chain: targetChain, account: fc.account! } as any);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success")
      return NextResponse.json({ error: "deployment reverted", txHash }, { status: 500 });
    if (kind === 1) await setPairing(signerId, wallet);
    return NextResponse.json({ wallet, signerId, chainId, txHash, blockNumber: receipt.blockNumber.toString() });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
