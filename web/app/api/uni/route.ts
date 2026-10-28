import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, http, isAddress, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { upstreamRpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/**
 * `GET /api/uni?address=0x…` -> `{index, amount, proof}` when that address can still claim the 2020 UNI airdrop, else
 * `{}`. xdai.io's sweep (PLAN-xdai.md): old Burner keys that swapped on Uniswap got 400 UNI, and the claim never expires.
 * The claim data is Uniswap's own, in address-sorted chunks (what app.uniswap.org read); the chain says if it's taken.
 */
const UNI_DISTRIBUTOR = "0x090D4613473dEE047c3f2706764f49E0821D256e";
const CHUNKS = "https://raw.githubusercontent.com/Uniswap/mrkl-drop-data-chunks/final/chunks/";
let starts: string[] | null = null;

export async function GET(req: NextRequest) {
  const a = req.nextUrl.searchParams.get("address");
  if (!a || !isAddress(a)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const addr = a.toLowerCase();
  try {
    if (!starts) starts = Object.keys(await fetch(`${CHUNKS}mapping.json`).then(r => r.json())).sort();
    const start = starts.filter(s => s <= addr).pop();
    if (!start) return NextResponse.json({});
    const chunk: Record<string, { index: number; amount: string; proof: string[] }> = await fetch(`${CHUNKS}${start}.json`).then(r => r.json());
    const hit = chunk[getAddress(addr)] ?? chunk[addr];
    if (!hit) return NextResponse.json({});
    const client = createPublicClient({ chain: mainnet, transport: http(upstreamRpc(1)) });
    const claimed = await client.readContract({
      address: UNI_DISTRIBUTOR,
      abi: parseAbi(["function isClaimed(uint256 index) view returns (bool)"]),
      functionName: "isClaimed",
      args: [BigInt(hit.index)],
    });
    return NextResponse.json(claimed ? {} : { index: hit.index, amount: BigInt(hit.amount).toString(), proof: hit.proof });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 502 });
  }
}
