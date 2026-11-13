// Drops (lib/drops.ts) against a local app on a Base fork: make a card drop and a crowd drop, fill the pots, claim
// with passkey wallets, and every refusal (a used card, a second claim, the cap, a wrong passkey, a paused or closed
// drop, an empty pot), 20 crowd claims at once (USDC and ETH), a claim killed mid-way (retried: paid once), another
// admin's drop (no changes), then take back.
//   anvil --fork-url <base rpc> --network optimism --port 8545 &
//   NEXT_PUBLIC_CHAINS=8453 BASE_RPC_URL=http://127.0.0.1:8545 DROP_TEST=1 RELAYER_PRIVATE_KEY=<anvil key 0> npx next dev -p 3100 &
//   npx tsx tools/drop-check.mts
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { execSync } from "node:child_process";
import { keccak256, toBytes, toHex } from "viem";
import { safeAddress, signerAddress } from "../lib/safe/core";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
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
  const authData = new Uint8Array([...sha256(new TextEncoder().encode(new URL(APP).hostname)), 5, 0, 0, 0, 0]);
  const fields = `"origin":"${new URL(APP).origin}","crossOrigin":false`;
  const json = `{"type":"webauthn.get","challenge":"${b64url(toBytes(h))}",${fields}}`;
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(json))]));
  const sig = p256.sign(msg, k.pk, { prehash: false, format: "compact" });
  return { qx: k.qx, qy: k.qy, authenticatorData: toHex(authData), clientDataFields: fields, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), ts };
}

let ipN = 0;
// each call from its own IP, unless the test names one: the cap on failed claims (5 with DROP_TEST) is per IP
const post = async (path: string, body: object, ip = `10.0.${++ipN >> 8}.${ipN & 255}`) => {
  const r = await fetch(`${APP}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
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

// ---- one IP: claims that pay don't count toward its cap, failed ones do (5 with DROP_TEST)
r = await admin("create", { drop: { name: "Wifi", chainId: 8453, token: "usdc", amount: "1", kind: "crowd", count: 8 } });
const wifi = r.j.drop;
setUsdc((await admin("get", { id: wifi.id })).j.pot.address, await fund(8, 1_000_000n));
const from = (k: Key, ip: string) => post("/api/drop", { code: wifi.code, wallet: k.wallet, sig: sign(k, k.wallet, `claim ${wifi.code}`) }, ip);
ks = Array.from({ length: 7 }, key);
rs = [];
for (const k of ks) rs.push(await from(k, "7.7.7.7"));
ok(rs.every(x => x.status === 200), `7 claims from one IP all paid (${rs.map(x => x.status).join(" ")})`);
rs = [];
for (let i = 0; i < 5; i++) rs.push(await from(ks[0], "7.7.7.7"));
ok(rs.every(x => x.status === 409), "5 repeats from that IP are refused as repeats");
r = await from(key(), "7.7.7.7");
ok(r.status === 429, `after 5 failed claims that IP is stopped (${r.j.error})`);
r = await from(key(), "7.7.7.8");
ok(r.status === 200, "another IP still claims");

// ---- 20 at once: ETH
r = await admin("create", { drop: { name: "Eth", chainId: 8453, token: "eth", amount: "2", kind: "crowd", count: 20 } });
const eth = r.j.drop;
const pot4g = (await admin("get", { id: eth.id })).j.pot;
const pot4: string = pot4g.address;
const each = BigInt(pot4g.each); // $2 of ETH at the Uniswap price
ok(pot4g.ethUsd > 100 && Math.abs(Number(each) / 1e18 * pot4g.ethUsd - 2) < 0.01, `$2 of ETH = ${Number(each) / 1e18} ETH at $${pot4g.ethUsd.toFixed(2)}`);
cast(`rpc anvil_setBalance ${pot4} 0x${(25n * (each + 10n ** 13n)).toString(16)}`);
ks = Array.from({ length: 20 }, key);
rs = await Promise.all(ks.map(k => claim(k, eth.code)));
ok(rs.every(x => x.status === 200), `20 ETH claims at once all paid (${rs.filter(x => x.status !== 200).map(x => x.j.error).join("; ") || "ok"})`);
ok(ks.every(k => ethOf(k.wallet) === each), "each wallet has $2 of ETH");

// ---- a claim killed mid-way: `die` (DROP_TEST=1) stops it just before or just after the send; a retry takes over after 2 s
const dying = (k: Key, code: string, die: string) => post("/api/drop", { code, wallet: k.wallet, die, sig: sign(k, k.wallet, `claim ${code}`) });
const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
r = await admin("create", { drop: { name: "Killed", chainId: 8453, token: "usdc", amount: "1", kind: "cards", count: 2 } });
const kd = r.j.drop;
const kg = (await admin("get", { id: kd.id })).j;
setUsdc(kg.pot.address, await fund(4, 1_000_000n));
const [k1, k2, k3] = [key(), key(), key()];
r = await dying(k1, kg.codes[0].code, "after");
ok(r.status !== 200 && usdcOf(k1.wallet) === 1_000_000n, `USDC: killed after the send: no answer, but it paid (${r.j.error})`);
r = await claim(k1, kg.codes[0].code);
ok(r.status === 409 && /on its way/.test(r.j.error), `a retry right away waits (${r.j.error})`);
await wait(2500);
r = await claim(k1, kg.codes[0].code);
ok(r.status === 200 && usdcOf(k1.wallet) === 1_000_000n, `the retry says claimed and pays nothing more (${r.j.error ?? usdcOf(k1.wallet)})`);
r = await claim(k2, kg.codes[0].code);
ok(r.status === 410, `the card is used (${r.j.error})`);
r = await dying(k2, kg.codes[1].code, "before");
ok(r.status !== 200 && usdcOf(k2.wallet) === 0n, `USDC: killed before the send: nothing paid (${r.j.error})`);
await wait(2500);
r = await claim(k3, kg.codes[1].code);
ok(r.status === 200 && usdcOf(k3.wallet) === 1_000_000n && usdcOf(k2.wallet) === 0n, `another wallet takes the card over and is paid once (${r.j.error ?? ""})`);
ok((await admin("get", { id: kd.id })).j.claimed === 2, "2 claimed, not more");

r = await admin("create", { drop: { name: "KilledEth", chainId: 8453, token: "eth", amount: "2", kind: "crowd", count: 5 } });
const ke = r.j.drop;
const keg = (await admin("get", { id: ke.id })).j.pot;
const kEach = BigInt(keg.each);
cast(`rpc anvil_setBalance ${keg.address} 0x${(5n * (kEach + 10n ** 13n)).toString(16)}`);
const [k4, k5] = [key(), key()];
r = await dying(k4, ke.code, "after");
ok(r.status !== 200 && ethOf(k4.wallet) === kEach, `ETH: killed after the send: it paid (${r.j.error})`);
await wait(2500);
r = await claim(k4, ke.code);
ok(r.status === 200 && ethOf(k4.wallet) === kEach, `the retry finds the tx and pays nothing more (${r.j.error ?? ethOf(k4.wallet)})`);
r = await dying(k5, ke.code, "before");
ok(r.status !== 200 && ethOf(k5.wallet) === 0n, `ETH: killed before the send: nothing paid (${r.j.error})`);
await wait(2500);
r = await claim(k5, ke.code);
ok(r.status === 200 && ethOf(k5.wallet) === kEach, `the retry pays once (${r.j.error ?? ethOf(k5.wallet)})`);
ok(cast(`nonce ${keg.address}`) === "2", `the pot sent 2 txs: the retry took the same nonce (${cast(`nonce ${keg.address}`)})`);
r = await claim(k5, ke.code);
ok(r.status === 409, `and again is refused (${r.j.error})`);

// ---- another admin sees a drop, can't change it or take it back
const other = key();
const t2: string = (await post("/api/drop/admin", { op: "login", wallet: other.wallet, sig: sign(other, other.wallet, "login") })).j.token;
r = await post("/api/drop/admin", { op: "get", token: t2, id: cards.id });
ok(r.status === 200 && r.j.mine === false, "another admin sees the drop");
r = await post("/api/drop/admin", { op: "set", token: t2, id: cards.id, paused: true });
ok(r.status === 403, `…can't pause it (${r.j.error})`);
r = await post("/api/drop/admin", { op: "takeback", token: t2, id: cards.id });
ok(r.status === 403 && usdcOf(other.wallet) === 0n, `…can't take it back (${r.j.error})`);

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
