import { NextRequest, NextResponse } from "next/server";
import { type Address, getAddress, isAddress } from "viem";
import { instantWalletAbi, isDeployed, publicClient } from "~~/services/chain";
import { isBytes32 } from "~~/services/relay";
import { deviceFor, getPairing, listDevices, putDevice, setPairing } from "~~/services/store";
import { DEVICE_ONLINE_MS, type DeviceInfo } from "~~/services/types";
import { chainId } from "~~/utils/chain";
import { signerIdOf } from "~~/utils/digests";

export const dynamic = "force-dynamic";

async function isSignerOf(wallet: Address, signerId: Address): Promise<boolean> {
  if (!(await isDeployed(wallet))) return false;
  return (await publicClient().readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "isSigner",
    args: [signerId],
  })) as boolean;
}

/** Which wallet is this key paired with? Uses the remembered pairing, verified on chain. */
async function pairedWallet(signerId: Address, hint?: Address): Promise<Address | undefined> {
  const remembered = await getPairing(signerId);
  const candidates = [hint, remembered].filter(Boolean) as Address[];
  for (const w of candidates) {
    if (await isSignerOf(w, signerId).catch(() => false)) {
      if (remembered?.toLowerCase() !== w.toLowerCase()) await setPairing(signerId, w);
      return w;
    }
  }
  return undefined;
}

/** The device announces itself every 30 s: `{name, qx, qy, chipSerial, firmware}` -> `{paired, wallet, signerId, chainId}`. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isBytes32(body.qx) || !isBytes32(body.qy)) {
    return NextResponse.json({ error: "qx and qy must be 0x-prefixed 32-byte hex" }, { status: 400 });
  }
  const signerId = signerIdOf(body.qx, body.qy);
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "Instant Wallet device";
  const now = Date.now();
  const prev = await deviceFor(signerId);
  const info: DeviceInfo = {
    name,
    qx: body.qx,
    qy: body.qy,
    signerId,
    chipSerial: typeof body.chipSerial === "string" ? body.chipSerial.slice(0, 64) : prev?.chipSerial,
    firmware: typeof body.firmware === "string" ? body.firmware.slice(0, 64) : prev?.firmware,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
  };
  await putDevice(info);
  const hint = typeof body.wallet === "string" && isAddress(body.wallet) ? getAddress(body.wallet) : undefined;
  const wallet = await pairedWallet(signerId, hint);
  return NextResponse.json({ paired: !!wallet, wallet: wallet ?? null, signerId, chainId });
}

/** Browser: last announce(s) + online flag. `?wallet=0x…` also records which device is a signer there. */
export async function GET(req: NextRequest) {
  const walletParam = req.nextUrl.searchParams.get("wallet");
  const wallet = walletParam && isAddress(walletParam) ? getAddress(walletParam) : undefined;
  const now = Date.now();
  const devices = await Promise.all(
    (await listDevices())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(async d => {
        const paired = wallet ? await isSignerOf(wallet, d.signerId).catch(() => false) : undefined;
        if (paired) await setPairing(d.signerId, wallet!);
        return {
          ...d,
          online: now - d.lastSeen < DEVICE_ONLINE_MS,
          paired,
          pairedWallet: (paired ? wallet : await getPairing(d.signerId)) ?? null,
        };
      }),
  );
  return NextResponse.json({ device: devices[0] ?? null, devices, now });
}
