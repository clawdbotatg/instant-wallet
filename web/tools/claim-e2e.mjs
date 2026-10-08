// Claim cards on a Base fork (docs/CLAIM.md): a card holding USDC + ETH is opened by its link on a phone with no
// wallet; it makes one (virtual passkey) and claims: the USDC arrives minus the relay's fee (the card had no gas),
// the ETH arrives minus its own gas. The same link again shows it empty. The relay refuses a claim whose fee isn't
// to it, or a replay. Same setup as safe-e2e.mjs (anvil fork + next dev on :3100).
//   CHROME=<chromium> node tools/claim-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = process.env.USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OUT = process.argv[2] || "/tmp";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const num = s => BigInt(s.split(" ")[0]);
const usdcOf = a => num(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`));
const ethOf = a => BigInt(cast(`balance ${a}`));
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const key = generatePrivateKey();
const card = privateKeyToAccount(key).address;
setUsdc(card, 5_000_000n); // 5 USDC
cast(`rpc anvil_setBalance ${card} 0x38d7ea4c68000`); // 0.001 ETH
const q = await fetch(`${APP}/api/safe/relay?chainId=8453&kind=claim`).then(r => r.json());
const relayer = q.relayer;
const relayerUsdc = usdcOf(relayer);

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

await page.goto(`${APP}/claim#${key.slice(2)}`);
await page.getByText("Someone sent you").waitFor({ timeout: 20000 });
await page.getByText("5 USDC").first().waitFor({ timeout: 20000 });
ok(!page.url().includes("#"), "the key leaves the address bar");
await page.screenshot({ path: `${OUT}/claim-1-new-phone.png` });
await page.getByText("Create wallet").tap();
await page.getByText("Claim it").waitFor({ timeout: 20000 });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
await page.screenshot({ path: `${OUT}/claim-2-ready.png` });
await page.getByText("Claim it").tap();
await page.getByText("Open my wallet").waitFor({ timeout: 90000 });
await page.screenshot({ path: `${OUT}/claim-3-done.png` });
const got = usdcOf(acct.address);
const fee = usdcOf(relayer) - relayerUsdc;
ok(got > 0n && got + fee === 5_000_000n, `the wallet got ${got} USDC base units, the relay ${fee} (of 5 USDC)`);
ok(usdcOf(card) === 0n, "the card has no USDC left");
ok(ethOf(acct.address) > 900_000_000_000_000n, `the wallet got the ETH (${ethOf(acct.address)} wei)`);

await page.goto("about:blank");
await page.goto(`${APP}/claim#${key.slice(2)}`);
await page.getByText("Nothing on it").waitFor({ timeout: 20000 }).catch(async e => { await page.screenshot({ path: `${OUT}/claim-4-again.png` }); console.log(await page.evaluate(() => document.body.innerText)); throw e; });
ok(true, "the same link again: empty");

// ---- the relay: a claim must pay the relay, and only once
setUsdc(card, 2_000_000n);
const cardAcct = privateKeyToAccount(key);
const mk = async (dest, value) => {
  const nonce = "0x" + randomBytes(32).toString("hex");
  const validBefore = Math.floor(Date.now() / 1000) + 3600;
  const sig = await cardAcct.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: card, to: dest, value: BigInt(value), validAfter: 0n, validBefore: BigInt(validBefore), nonce },
  });
  return { from: card, to: dest, value: String(value), validAfter: "0", validBefore: String(validBefore), nonce, r: "0x" + sig.slice(2, 66), s: "0x" + sig.slice(66, 130), v: parseInt(sig.slice(130, 132), 16) };
};
const signed = { good: [await mk(acct.address, 1_500_000), await mk(relayer, 500_000)], noFee: [await mk(acct.address, 1_500_000), await mk(acct.address, 500_000)] };
const post = auths => fetch(`${APP}/api/safe/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: 8453, kind: "claim", auths }) });
ok((await post(signed.noFee)).status === 400, "a claim whose fee isn't to the relay is refused");
const r1 = await post(signed.good);
ok(r1.ok, `a good claim is relayed (${r1.status})`);
const r2 = await post(signed.good);
ok(!r2.ok && !(await r2.json()).hash, `the same claim again is refused (${r2.status}: the authorization is spent)`);

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
