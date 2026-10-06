// A real first send through the LIVE relay, with a raw P-256 key standing in for a passkey (it signs the same
// WebAuthn envelope a browser does). Funds the counterfactual Safe with a little ETH from FUNDER_KEY, then sends
// some back with the fee paid in ETH: the relay deploys the signer + Safe and runs the tx in one transaction.
//   APP=https://… RPC=<chain rpc> CHAIN=8453 FUNDER_KEY=0x… npx tsx tools/safe-live.mts
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { createPublicClient, createWalletClient, formatEther, http, type Hex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { batch, encodeSignatures, encodeWebAuthn, safeAddress, safeTxHash, signerAddress, transfer } from "../lib/safe/core";

const APP = process.env.APP!;
const CHAIN = Number(process.env.CHAIN || 8453);
const chain = CHAIN === 1 ? mainnet : base;
const pc = createPublicClient({ chain, transport: http(process.env.RPC) });
const funder = privateKeyToAccount(process.env.FUNDER_KEY as Hex);
const wc = createWalletClient({ chain, transport: http(process.env.RPC), account: funder });
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const hex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;

const pk = p256.utils.randomSecretKey();
const pub = p256.getPublicKey(pk, false);
const x = hex(pub.slice(1, 33)), y = hex(pub.slice(33));
const signer = signerAddress(x, y);
const safe = safeAddress(signer);
console.log("burner signer", signer, "safe", safe);

const q = await fetch(`${APP}/api/safe/relay?chainId=${CHAIN}&kind=first`).then(r => r.json());
if (q.error) throw new Error(q.error);
console.log("quote", formatEther(BigInt(q.feeEth)), "ETH /", Number(q.feeUsdc) / 1e6, "USDC; relayer", q.relayer);
const back = 10_000_000_000_000n; // 0.00001 ETH
const fund = BigInt(q.feeEth) + back + 1_000_000_000_000n;
const fh = await wc.sendTransaction({ to: safe, value: fund });
await pc.waitForTransactionReceipt({ hash: fh });
console.log("funded", formatEther(fund), "ETH", fh);
await new Promise(r => setTimeout(r, 8000)); // let the relay's RPC node see the funding

const t = batch([transfer(zeroAddress, funder.address, back), transfer(zeroAddress, q.relayer, BigInt(q.feeEth))], 0n);
const h = safeTxHash(CHAIN, safe, t);
const authData = new Uint8Array([...sha(new TextEncoder().encode("instantwallet.io")), 5, 0, 0, 0, 1]);
const fields = '"origin":"https://instantwallet.io","crossOrigin":false';
const json = `{"type":"webauthn.get","challenge":"${Buffer.from(h.slice(2), "hex").toString("base64url")}",${fields}}`;
const digest = sha(new Uint8Array([...authData, ...sha(new TextEncoder().encode(json))]));
const sig = p256.sign(digest, pk, { prehash: false, format: "compact" });
const data = encodeWebAuthn({ authenticatorData: hex(authData), clientDataFields: fields, r: BigInt(hex(sig.slice(0, 32))), s: BigInt(hex(sig.slice(32))) });

const res = await fetch(`${APP}/api/safe/relay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(
    { chainId: CHAIN, kind: "exec", safe, tx: t, signatures: encodeSignatures([{ signer, data, kind: "contract" }]), deploy: { x, y } },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  ),
}).then(r => r.json());
if (!res.hash) throw new Error(JSON.stringify(res));
const rc = await pc.waitForTransactionReceipt({ hash: res.hash });
console.log("relayed", res.hash, rc.status, "gas", rc.gasUsed.toString());
const code = await pc.getCode({ address: safe });
console.log("safe deployed:", !!code && code !== "0x", "left in safe:", formatEther(await pc.getBalance({ address: safe })));
process.exit(rc.status === "success" ? 0 : 1);
