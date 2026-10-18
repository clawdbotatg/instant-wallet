// Drops (lib/drops.ts) against a local app on a Base fork: make a card drop and a crowd drop, fill the pots, claim
// with passkey wallets, and every refusal (a used card, a second claim, the cap, a wrong passkey, a paused or closed
// drop, an empty pot), 20 crowd claims at once (USDC and ETH), then take back.
//   anvil --fork-url <base rpc> --network optimism --port 8545 &
//   NEXT_PUBLIC_CHAINS=8453 BASE_RPC_URL=http://127.0.0.1:8545 RELAYER_PRIVATE_KEY=<anvil key 0> npx next dev -p 3100 &
//   npx tsx tools/drop-check.mts
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { execSync } from "node:child_process";
import { keccak256, toBytes, toHex } from "viem";
import { safeAddress, signerAddress } from "../lib/safe/core";

const APP = process.env.APP || "http://localhost:3100";
const RPC = "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const cast = (a: string) => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const num = (s: string) => BigInt(s.split(" ")[0]);
const usdcOf = (a: string) => num(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`));
const ethOf = (a: string) => BigInt(cast(`balance ${a}`));
const setUsdc = (who: string, amt: bigint) =>
  cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function key() {
  const pk = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(pk, false);
  const qx = toHex(pub.slice(1, 33)), qy = toHex(pub.slice(33));
  return { pk, qx, qy, wallet: safeAddress(signerAddress(qx, qy)) };
}
type Key = ReturnType<typeof key>;

// a passkey signature, built the way a browser's WebAuthn assertion is (lib/alerts.ts changeDigest, scope "drops")
function sign(k: Key, wallet: string, change: string, ts = Date.now()) {
  const h = keccak256(toBytes(`Instant Wallet drops\n${wallet.toLowerCase()}\n${change}\n${ts}`));
  const authData = new Uint8Array([...sha256(new TextEncoder().encode("instantwallet.io")), 5, 0, 0, 0, 0]);
  const fields = '"origin":"https://instantwallet.io","crossOrigin":false';
  const json = `{"type":"webauthn.get","challenge":"${b64url(toBytes(h))}",${fields}}`;
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(json))]));
  const sig = p256.sign(msg, k.pk, { prehash: false, format: "compact" });
  return { qx: k.qx, qy: k.qy, authenticatorData: toHex(authData), clientDataFields: fields, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), ts };
}

const post = async (path: string, body: object) => {
  const r = await fetch(`${APP}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as any };
};
const admin = (op: string, b: object = {}) => post("/api/drop/admin", { op, token, ...b });
// the page signs the code as the server reads it: capitals, letters and digits only
const claim = (k: Key, code: string, signer: Key = k) => post("/api/drop", { code, wallet: k.wallet, sig: sign(signer, k.wallet, `claim ${code.toUpperCase().replace(/[^0-9A-Z]/g, "")}`) });
const fee = async () => BigInt((await (await fetch(`${APP}/api/safe/relay?chainId=8453&kind=claim`)).json()).feeUsdc);
const fund = async (n: number, each: bigint) => BigInt(n) * (each + ((await fee()) * 3n) / 2n); // the fork's gas is ~1 gwei
const info = async (code: string) => (await fetch(`${APP}/api/drop?code=${code}`)).json() as Promise<any>;

// ---- log in
const me = key();
let r = await post("/api/drop/admin", { op: "login", wallet: me.wallet, sig: sign(key(), me.wallet, "login") });
ok(r.status === 403, `log in with someone else's passkey is refused (${r.j.error})`);
r = await post("/api/drop/admin", { op: "login", wallet: me.wallet, sig: sign(me, me.wallet, "login") });
const token: string = r.j.token;
ok(r.status === 200 && !!token, "log in with the wallet's own passkey");
r = await post("/api/drop/admin", { op: "list", token: "0".repeat(48) });
ok(r.status === 401, "a made-up session is refused");

// ---- a card drop: 3 × 5 USDC
r = await admin("create", { drop: { name: "Cards", chainId: 8453, token: "usdc", amount: "5", kind: "cards", count: 3 } });
const cards = r.j.drop;
ok(r.status === 200 && cards.cap === 3, `card drop made (${r.j.error ?? cards.id})`);
r = await admin("get", { id: cards.id });
const codes: string[] = r.j.codes.map((c: any) => c.code);
const pot1: string = r.j.pot.address;
ok(codes.length === 3 && codes.every(c => /^[2-9A-HJKMNP-Z]{10}$/.test(c)), `3 codes (${codes.join(" ")})`);

const a = key(), b = key();
r = await claim(a, codes[0]);
ok(r.status === 410 && /empty/.test(r.j.error), `an empty pot pays nothing (${r.j.error})`);
ok(!(await info(codes[0])).closed, "…and the card is still good after");

setUsdc(pot1, await fund(3, 5_000_000n));
const start = usdcOf(pot1);
r = await claim(a, codes[0], b);
ok(r.status === 403, `a claim signed by another passkey is refused (${r.j.error})`);
r = await claim(a, codes[0]);
ok(r.status === 200 && usdcOf(a.wallet) === 5_000_000n, `card claimed: the wallet has 5 USDC (${r.j.error ?? usdcOf(a.wallet)})`);
const spent = start - usdcOf(pot1);
ok(spent > 5_000_000n && spent < 5_000_000n + (await fee()) * 2n, `the pot paid 5 + the relay's fee (${spent})`);
r = await claim(b, codes[0]);
ok(r.status === 410, `the same card again is refused (${r.j.error})`);
ok((await info(codes[0])).closed === "This card was claimed already.", "it shows as claimed");
r = await claim(a, codes[1].toLowerCase().replace(/(.{5})/, "$1-"));
ok(r.status === 200 && usdcOf(a.wallet) === 10_000_000n, `${r.j.error ?? ""} a typed code (lowercase, a dash) works; one wallet can claim two cards`);

r = await admin("set", { id: cards.id, paused: true });
r = await claim(b, codes[2]);
ok(r.status === 410 && /paused/.test(r.j.error), `a paused drop pays nothing (${r.j.error})`);
await admin("set", { id: cards.id, paused: false });

// ---- a crowd drop: cap 2, 1 USDC
r = await admin("create", { drop: { name: "Talk", chainId: 8453, token: "usdc", amount: "1", kind: "crowd", count: 2, code: "gwei-" + Date.now() % 10000, minutes: 30 } });
const crowd = r.j.drop;
ok(r.status === 200 && /^GWEI\d+$/.test(crowd.code), `crowd drop made, code ${crowd.code}`);
r = await admin("create", { drop: { name: "Dup", chainId: 8453, token: "usdc", amount: "1", kind: "crowd", count: 2, code: crowd.code } });
ok(r.status === 400 && /taken/.test(r.j.error), "the same crowd code twice is refused");
setUsdc((await admin("get", { id: crowd.id })).j.pot.address, 10_000_000n);
const c = key(), d = key(), e = key();
r = await claim(c, crowd.code);
ok(r.status === 200, "crowd claim 1");
r = await claim(c, crowd.code);
ok(r.status === 409, `the same wallet twice is refused (${r.j.error})`);
r = await claim(d, crowd.code);
ok(r.status === 200, "crowd claim 2");
r = await claim(e, crowd.code);
ok(r.status === 410 && /All gone/.test(r.j.error), `past the cap is refused (${r.j.error})`);
ok((await info(crowd.code)).claimed === 2, "2 claimed");

// ---- 20 at once: USDC
r = await admin("create", { drop: { name: "Rush", chainId: 8453, token: "usdc", amount: "1", kind: "crowd", count: 20 } });
const rush = r.j.drop;
setUsdc((await admin("get", { id: rush.id })).j.pot.address, await fund(20, 1_000_000n));
let ks = Array.from({ length: 20 }, key);
let rs = await Promise.all(ks.map(k => claim(k, rush.code)));
ok(rs.every(x => x.status === 200), `20 USDC claims at once all paid (${rs.filter(x => x.status !== 200).map(x => x.j.error).join("; ") || "ok"})`);
ok(ks.every(k => usdcOf(k.wallet) === 1_000_000n), "each wallet has 1 USDC");

// ---- 20 at once: ETH
r = await admin("create", { drop: { name: "Eth", chainId: 8453, token: "eth", amount: "0.001", kind: "crowd", count: 20 } });
const eth = r.j.drop;
const pot4: string = (await admin("get", { id: eth.id })).j.pot.address;
cast(`rpc anvil_setBalance ${pot4} 0x${(25n * 10n ** 15n).toString(16)}`); // 0.025 ETH
ks = Array.from({ length: 20 }, key);
rs = await Promise.all(ks.map(k => claim(k, eth.code)));
ok(rs.every(x => x.status === 200), `20 ETH claims at once all paid (${rs.filter(x => x.status !== 200).map(x => x.j.error).join("; ") || "ok"})`);
ok(ks.every(k => ethOf(k.wallet) === 10n ** 15n), "each wallet has 0.001 ETH");

// ---- closed window
await admin("set", { id: crowd.id, minutes: 0 });
r = await admin("create", { drop: { name: "Late", chainId: 8453, token: "usdc", amount: "1", kind: "crowd", count: 5, minutes: 1 } });
const late = r.j.drop;
cast(`rpc evm_increaseTime 0x0`); // the window is the server's clock, not the chain's: close it from the admin side
await admin("set", { id: late.id, ended: true });
r = await claim(key(), late.code);
ok(r.status === 410 && /ended/.test(r.j.error), `an ended drop pays nothing (${r.j.error})`);

// ---- take back
const before = usdcOf(me.wallet);
const rest = usdcOf(pot1);
r = await admin("takeback", { id: cards.id });
ok(r.status === 200 && usdcOf(pot1) === 0n && usdcOf(me.wallet) > before + rest - (await fee()) * 2n, `take back: the rest of the card pot is in the admin's wallet (${r.j.error ?? usdcOf(me.wallet) - before})`);
const eb = ethOf(me.wallet);
r = await admin("takeback", { id: eth.id });
ok(r.status === 200 && ethOf(me.wallet) > eb, `take back ETH (${r.j.error ?? ethOf(me.wallet) - eb})`);

r = await admin("list");
ok(r.j.drops.length >= 5, `list shows the drops (${r.j.drops.length})`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
