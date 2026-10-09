import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { NextRequest, NextResponse } from "next/server";
import { type Hex, createPublicClient, getAddress, http, isAddress, isHex } from "viem";
import { base } from "viem/chains";
import { upstreamRpc } from "@/lib/rpcServer";
import { abi, safeAddress, signerAddress } from "@/lib/safe/core";
import { onrampChallenge } from "@/lib/onramp";
import { P256_N, base64urlToBytes, hexToBytes } from "@/lib/webauthn";

export const dynamic = "force-dynamic";

const MAX_AGE_S = 120;

/**
 * Coinbase Pay (Apple Pay, card) into this wallet: `POST /api/onramp` → a one-time pay.coinbase.com link (a
 * 5-minute session token, locked to this address on Base). Only the wallet's own passkey can ask: the body is a
 * Face ID signature over onrampChallenge(address, asset, ts), from a passkey whose Safe signer owns `address`
 * (or, for a Safe not deployed yet, whose counterfactual Safe IS `address`). Needs CDP_API_KEY_ID +
 * CDP_API_KEY_SECRET (portal.cdp.coinbase.com, a Secret API key with Onramp).
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const asset = b.asset === "ETH" ? "ETH" : "USDC";
  const ts = Number(b.ts);
  if (!isAddress(b.address || "")) return bad("address?");
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_AGE_S) return bad("Signature expired. Try again.");
  if (![b.qx, b.qy, b.r, b.s, b.authenticatorData].every(v => isHex(v)) || typeof b.clientDataJSON !== "string") return bad("signature?");
  const address = getAddress(b.address);

  // the passkey signed this exact request, on this site
  const host = req.headers.get("host") || "";
  let cd: any;
  try {
    cd = JSON.parse(b.clientDataJSON);
  } catch {
    return bad("signature?");
  }
  const want = onrampChallenge(address, asset, ts);
  if (cd.type !== "webauthn.get" || new URL(cd.origin).host !== host) return bad("Wrong site");
  if (bytesHex(base64urlToBytes(cd.challenge)) !== want.toLowerCase()) return bad("Signature is for a different request");
  const authData = hexToBytes(b.authenticatorData);
  if (bytesHex(authData.slice(0, 32)) !== bytesHex(sha256(new TextEncoder().encode(host.split(":")[0])))) return bad("Wrong site");
  if (!(authData[32] & 0x04)) return bad("Face ID required");
  const msg = sha256(concatBytes(authData, sha256(new TextEncoder().encode(b.clientDataJSON))));
  if (!verifyP256(b.qx, b.qy, b.r, b.s, msg)) return bad("Bad signature");

  // ...and that passkey is this wallet's owner
  const signer = signerAddress(b.qx, b.qy);
  const client = createPublicClient({ chain: base, transport: http(upstreamRpc(8453)) });
  try {
    const code = await client.getCode({ address });
    const owns =
      code && code !== "0x"
        ? (await client.readContract({ address, abi: abi.safe, functionName: "getOwners" })).some(o => o.toLowerCase() === signer.toLowerCase())
        : safeAddress(signer) === address;
    if (!owns) return NextResponse.json({ error: "This passkey isn't an owner of that wallet" }, { status: 403 });
  } catch {
    return NextResponse.json({ error: "Couldn't check the wallet. Try again." }, { status: 502 });
  }

  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n");
  if (!apiKeyId || !apiKeySecret) return NextResponse.json({ error: "Deposits aren't set up yet" }, { status: 503 });
  // Vercel sets x-real-ip itself (a client can't spoof it there)
  const clientIp = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || undefined;
  try {
    const jwt = await generateJwt({ apiKeyId, apiKeySecret, requestMethod: "POST", requestHost: "api.developer.coinbase.com", requestPath: "/onramp/v1/token" });
    const r = await fetch("https://api.developer.coinbase.com/onramp/v1/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [{ address, blockchains: ["base"] }], assets: [asset], clientIp }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) return NextResponse.json({ error: j.message || j.errorMessage || `Coinbase said ${r.status}` }, { status: 502 });
    const u = new URL("https://pay.coinbase.com/buy/select-asset");
    u.search = new URLSearchParams({ sessionToken: j.token, defaultAsset: asset, defaultNetwork: "base", defaultPaymentMethod: "APPLE_PAY", presetFiatAmount: "50" }).toString();
    return NextResponse.json({ url: u.toString() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Coinbase didn't answer" }, { status: 502 });
  }
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

const bytesHex = (u: Uint8Array) => "0x" + Buffer.from(u).toString("hex");

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** P-256 over msg (already hashed), either s (WebAuthn doesn't promise low-s). */
function verifyP256(qx: Hex, qy: Hex, r: Hex, s: Hex, msg: Uint8Array): boolean {
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(hexToBytes(qx), 1);
  pub.set(hexToBytes(qy), 33);
  for (const sB of [BigInt(s), P256_N - BigInt(s)]) {
    const sig = new Uint8Array(64);
    sig.set(hexToBytes(r), 0);
    sig.set(hexToBytes(`0x${sB.toString(16).padStart(64, "0")}`), 32);
    try {
      if (p256.verify(sig, msg, pub, { prehash: false, lowS: false })) return true;
    } catch {}
  }
  return false;
}
