import { NextRequest, NextResponse } from "next/server";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex, createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAINS } from "@/lib/chains";
import { upstreamRpc } from "@/lib/rpcServer";
import { isLocalHost, nodeOf } from "@/lib/local";
import { clients } from "@/lib/safe/relayCore";

export const dynamic = "force-dynamic";

/**
 * Your own relay, on a copy of the wallet running on your own computer (README: "Run it fully local"). Never on our
 * site: Vercel, or any name that isn't local.*, localhost or 127.0.0.1, gets a 404.
 *
 *   GET  /api/local/relay  → { address: null } or { address, balances: [{ chainId, wei }] }  (?chainId=8453: that one only)
 *   POST /api/local/relay  → makes the relay key once, saves it in web/.env.local, uses it at once (no restart)
 *
 * The key never leaves this server. Same as `npm run relay-key`.
 */

const local = (req: NextRequest) => !process.env.VERCEL && isLocalHost((req.headers.get("host") || "").split(":")[0]);
const address = () => {
  const pk = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  return pk ? privateKeyToAccount(pk).address : null;
};

export async function GET(req: NextRequest) {
  if (!local(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  const a = address();
  if (!a) return NextResponse.json({ address: null });
  // one network (the Fund your relay sheet, every few seconds): read from the node the relay itself sends through
  const one = Number(req.nextUrl.searchParams.get("chainId"));
  if (one) {
    try {
      const wei = await clients(one, nodeOf(req)).pc.getBalance({ address: a });
      return NextResponse.json({ address: a, balances: [{ chainId: one, wei: wei.toString() }] });
    } catch (e: any) {
      return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 400 });
    }
  }
  const balances = await Promise.all(
    CHAINS.map(async c => {
      const url = upstreamRpc(c.id);
      const wei = url
        ? await createPublicClient({ transport: http(url, { timeout: 8000 }) })
            .getBalance({ address: a })
            .then(String, () => null)
        : null;
      return { chainId: c.id, wei };
    }),
  );
  return NextResponse.json({ address: a, balances });
}

export async function POST(req: NextRequest) {
  if (!local(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  if (!process.env.RELAYER_PRIVATE_KEY) {
    const path = join(process.cwd(), ".env.local");
    const env = existsSync(path) ? readFileSync(path, "utf8") : "";
    const saved = env.match(/^RELAYER_PRIVATE_KEY=["']?(0x[0-9a-fA-F]{64})/m)?.[1];
    const key = (saved as Hex | undefined) ?? generatePrivateKey();
    if (!saved) appendFileSync(path, `${env && !env.endsWith("\n") ? "\n" : ""}RELAYER_PRIVATE_KEY=${key}\n`);
    process.env.RELAYER_PRIVATE_KEY = key;
  }
  return NextResponse.json({ address: address() });
}
