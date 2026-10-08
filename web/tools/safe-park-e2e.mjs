// The wedgie hand-off on a Base fork: a big send started on a "phone" (no Web Serial) signs with Face ID and parks
// on /api/safe/pending; the "computer" (the fake wedgie on Web Serial) sees a card, one press sends it.
// Same setup as safe-e2e.mjs (anvil fork + next dev); RPC= / APP= pick another fork / app port.
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = process.env.USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base; Ethereum: 0xA0b8…eB48
const RECOVERY = "0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2";
const DAO = "0xeF899e80aA814ab8D8e232f9Ed6403A633C727ec";
const OUT = process.argv[2] || "/tmp";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const num = s => BigInt(s.split(" ")[0]);
const usdcOf = a => num(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`));
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
const rand = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = b => new Uint8Array(createHash("sha256").update(b).digest());
const hex = b => "0x" + Buffer.from(b).toString("hex");
const b64url = b => Buffer.from(b).toString("base64url");

// ---- the fake keys
const hot = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1
let wedgiePk, wKey;
const newWedgie = () => {
  wedgiePk = p256.utils.randomSecretKey();
  const wPub = p256.getPublicKey(wedgiePk, false);
  wKey = { x: hex(wPub.slice(1, 33)), y: hex(wPub.slice(33)) };
};
newWedgie();
let wedgieSigns = 0;

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
let page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
page.on("console", m => m.type() === "error" && console.log("console", m.text().slice(0, 300)));

const hotSign = async json => {
  const t = JSON.parse(json);
  delete t.types.EIP712Domain;
  return hot.signTypedData(t);
};
await page.exposeFunction("__hotSign", hotSign);
let wPieces = ""; // a big tx's data, sent ahead in pieces (safe_data), as wedgie-safe takes it
const fakeWedgie = async msg => {
  if (msg.type === "hello") return { id: msg.id, type: "hello", safe: wKey, safe_chunk: 4000 };
  if (msg.type === "safe_data") {
    if (msg.at === 0) wPieces = "";
    if (msg.at !== wPieces.length / 2 || msg.hex.length > 4000) return { id: msg.id, type: "error", error: "bad piece" };
    wPieces += msg.hex;
    return { id: msg.id, type: "safe_data", have: wPieces.length / 2 };
  }
  if (msg.type === "safe_sign") {
    wedgieSigns++;
    const t = msg.tx.data === "@" ? { ...msg.tx, data: "0x" + wPieces } : msg.tx;
    if (process.env.WEDGIE_DUMP) fs.appendFileSync(process.env.WEDGIE_DUMP, JSON.stringify(t) + "\n"); // what the wedgie is asked to show
    const h = hashTypedData({
      domain: { chainId: t.chainId, verifyingContract: t.safe },
      types: {
        SafeTx: [
          { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      message: { ...t, value: BigInt(t.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(t.nonce) },
    });
    const authData = Buffer.concat([sha(Buffer.from("wedgie.dev")), Buffer.from([5, 0, 0, 0, 0])]);
    const fields = '"origin":"https://wedgie.dev"';
    const json = `{"type":"webauthn.get","challenge":"${b64url(Buffer.from(h.slice(2), "hex"))}",${fields}}`;
    const digest = sha(Buffer.concat([authData, Buffer.from(sha(Buffer.from(json)))]));
    const sig = p256.sign(digest, wedgiePk, { prehash: false, format: "compact" });
    const r = hex(sig.slice(0, 32)), s = hex(sig.slice(32));
    return { id: msg.id, type: "safe_sig", safeTxHash: h, ...wKey, r, s, authenticatorData: hex(authData), clientDataFields: fields };
  }
  return { id: msg.id, type: "error" };
};
await page.exposeFunction("__fakeWedgie", fakeWedgie);
await ctx.addInitScript(hotAddr => {
  // fake MetaMask
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [hotAddr];
      if (method === "eth_signTypedData_v4") return window.__hotSign(params[1]);
      throw new Error("fake wallet: " + method);
    },
  };
  // fake wedgie on Web Serial (not on the "phone": localStorage test.phone)
  if (localStorage.getItem("test.phone") === "1") {
    delete Navigator.prototype.serial; // desktop Chrome has Web Serial; a phone doesn't
    return;
  }
  const enc = new TextEncoder();
  const port = {
    getInfo: () => ({ usbVendorId: 0x2e8a }),
    async open() {
      let ctrl;
      this.readable = new ReadableStream({ start: c => (ctrl = c) });
      this.writable = new WritableStream({
        async write(chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n")) {
            if (!line.trim()) continue;
            const reply = await window.__fakeWedgie(JSON.parse(line));
            ctrl.enqueue(enc.encode(JSON.stringify(reply) + "\n"));
          }
        },
      });
    },
    async close() {},
  };
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { getPorts: async () => [port], requestPort: async () => port, addEventListener() {}, removeEventListener() {} },
  });
}, hot.address);

const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);

// a wallet with Instant + wedgie (2/2), made on the "computer"
await page.goto(`${APP}/`);
await page.getByText("Create wallet").tap();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 20000 });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
setUsdc(acct.address, 2000_000_000n);
cast(`rpc anvil_setBalance ${acct.address} 0x2386f26fc10000`);
await page.waitForTimeout(13000);
await page.locator(".fab-settings").tap();
await page.getByText("Connect and add the wedgie", { exact: true }).tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(25000);
const errs0 = await page.locator(".err").allTextContents();
if (errs0.length) console.log("on screen:", errs0);
ok(cast(`code ${acct.address}`) !== "0x" && cast(`call ${acct.address} "getThreshold()(uint256)"`) === "3", "wedgie added: threshold 3");
await page.keyboard.press("Escape");

// the "phone": no wedgie here. A big send signs with Face ID and parks
await page.evaluate(() => localStorage.setItem("test.phone", "1"));
await page.reload();
await page.waitForTimeout(13000);
const HAL = rand();
await page.locator(".asset", { has: page.locator(".sym", { hasText: /^USDC$/ }) }).first().locator(".send-one").tap();
await page.getByPlaceholder("0x… or name.eth").fill(HAL);
const unit = page.locator('[aria-label^="Type USDC"]');
if (await unit.count()) await unit.tap(); // type the token amount
await page.locator("input.amount").fill("300");
await page.getByText("Review").tap();
await page.locator(".confirm .btn-green").waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/p1-phone-review.png` });
const w0 = wedgieSigns;
await page.locator(".confirm .btn-green").tap();
await page.getByText("Now the wedgie").waitFor({ timeout: 60000 }).catch(async e => {
  console.log("on screen:", await page.locator(".err").allTextContents());
  await page.screenshot({ path: `${OUT}/p1-error.png` });
  throw e;
});
await page.screenshot({ path: `${OUT}/p2-phone-parked.png` });
ok(usdcOf(HAL) === 0n && wedgieSigns === w0, "parked: nothing sent, the wedgie wasn't asked");
const pend = await (await fetch(`${APP}/api/safe/pending?chainId=8453&safe=${acct.address}`)).json();
ok(!!pend.pending && pend.pending.sigs.length === 1, "the server holds it with one signature (Face ID)");
await page.getByText("OK", { exact: true }).tap();
await page.waitForTimeout(3000);
ok(await page.getByText("Waiting for your wedgie").isVisible(), "the phone's home says it's waiting for the wedgie");
await page.screenshot({ path: `${OUT}/p3-phone-home.png` });

// a forged park is refused (no real owner signature)
const forged = { ...pend.pending, sigs: [{ ...pend.pending.sigs[0], data: "0x" + "00".repeat(400) }] };
const fr = await fetch(`${APP}/api/safe/pending`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forged) });
ok(fr.status === 400, "a park with a bad signature is refused");

// the "computer": the card signs with the wedgie and sends
await page.evaluate(() => localStorage.removeItem("test.phone"));
await page.reload();
await page.getByText("Sign with your wedgie").waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/p4-computer-card.png` });
await page.getByRole("button", { name: "Sign and send" }).tap();
await page.waitForTimeout(20000);
const errs = await page.locator(".err").allTextContents();
if (errs.length) console.log("on screen:", errs);
ok(usdcOf(HAL) === 300_000_000n && wedgieSigns === w0 + 1, "the computer finished it: one wedgie press, 300 USDC sent");
await page.waitForTimeout(16000);
ok(!(await page.getByText("Sign with your wedgie").count()), "the card is gone after it's sent");
await page.screenshot({ path: `${OUT}/p5-computer-done.png` });

// a smaller daily limit (owners: Face ID + the wedgie), then 5 USDC is over it
const w1 = wedgieSigns;
await page.locator(".fab-settings").tap();
await page.getByPlaceholder("100").fill("2");
await page.getByRole("button", { name: "Save", exact: true }).first().tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(20000);
const errsL = await page.locator(".err").allTextContents();
if (errsL.length) console.log("on screen:", errsL);
await page.screenshot({ path: `${OUT}/p6-limit.png`, fullPage: true });
ok(wedgieSigns === w1 + 1 && (await page.getByText(/\/2 USDC/).count()) > 0, "daily limit changed to 2 USDC (the wedgie signed)");

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
