// End to end for the Safe build (/safe) on a Base fork, through the real UI with a virtual passkey, a fake
// MetaMask (window.ethereum, signs with a test key) and a fake wedgie (navigator.serial, signs with a test P-256 key
// exactly like the wedgie-safe app). Every send goes through /api/safe/relay, which pays gas and is paid in the batch.
//
//   anvil --fork-url <base rpc> --network optimism --port 8545 &
//   NEXT_PUBLIC_CHAINS=8453 BASE_RPC_URL=http://127.0.0.1:8545 LOCAL_TOKENS_ONLY=1 \
//     LOCAL_TOKENS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 RELAYER_PRIVATE_KEY=<anvil key 0> npx next dev -p 3100 &
//   CHROME=<chromium> node tools/safe-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APP = process.env.APP || "http://localhost:3100";
const RPC = "http://127.0.0.1:8545";
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
const wedgiePk = p256.utils.randomSecretKey();
const wPub = p256.getPublicKey(wedgiePk, false);
const wKey = { x: hex(wPub.slice(1, 33)), y: hex(wPub.slice(33)) };
let wedgieSigns = 0;

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
page.on("console", m => m.type() === "error" && console.log("console", m.text().slice(0, 300)));

await page.exposeFunction("__hotSign", async json => {
  const t = JSON.parse(json);
  delete t.types.EIP712Domain;
  return hot.signTypedData(t);
});
await page.exposeFunction("__fakeWedgie", async msg => {
  if (msg.type === "hello") return { id: msg.id, type: "hello", safe: wKey };
  if (msg.type === "safe_sign") {
    wedgieSigns++;
    const t = msg.tx;
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
});
await ctx.addInitScript(hotAddr => {
  // fake MetaMask
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [hotAddr];
      if (method === "eth_signTypedData_v4") return window.__hotSign(params[1]);
      throw new Error("fake wallet: " + method);
    },
  };
  // fake wedgie on Web Serial
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

// ---------------------------------------------------------------- level 1
await page.goto(`${APP}/safe`);
await page.getByText("Create wallet").tap();
await page.getByText("Send", { exact: true }).waitFor({ timeout: 20000 });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
console.log("wallet", acct.address, "burner signer", acct.burnerSigner);
ok(cast(`code ${acct.address}`) === "0x", "counterfactual: nothing deployed yet");
await page.screenshot({ path: `${OUT}/s1-home-empty.png` });

const slot = execSync(`cast index address ${acct.address} 9`, { encoding: "utf8" }).trim();
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
setUsdc(acct.address, 2000_000_000n);
cast(`rpc anvil_setBalance ${acct.address} 0x2386f26fc10000`); // 0.01 ETH
void slot;
await page.waitForTimeout(13000);
await page.screenshot({ path: `${OUT}/s2-home-funded.png` });

async function send(to, pickText, amount, shot, button = "Send") {
  await page.locator(".balance .btn-green").tap();
  await page.getByText("Type it instead").tap();
  await page.getByPlaceholder("0x… or name.eth").fill(to);
  await page.locator(".picker .pill", { hasText: pickText }).first().tap();
  await page.locator("input.amount").fill(amount);
  await page.getByText("Review").tap();
  const go = page.locator(".confirm .btn-green");
  await go.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500); // the quote
  await page.screenshot({ path: `${OUT}/${shot}-review.png` });
  const signedBy = await page.locator(".line", { hasText: "Signed by" }).textContent();
  await go.tap();
  await page.getByText("Sent", { exact: true }).waitFor({ timeout: 90000 }).catch(async e => {
    console.log("on screen:", await page.locator(".err").allTextContents());
    await page.screenshot({ path: `${OUT}/${shot}-error.png` });
    throw e;
  });
  await page.screenshot({ path: `${OUT}/${shot}-sent.png` });
  await page.getByText("Done").tap();
  await page.waitForTimeout(13000);
  return signedBy;
}

const BOB = rand();
await send(BOB, "USDC", "25", "s3");
ok(usdcOf(BOB) === 25_000_000n, "first send arrived (deploy + send, one Face ID)");
ok(cast(`code ${acct.address}`).length > 4, "the first send deployed the Safe");
const fee1 = 2000_000_000n - 25_000_000n - usdcOf(acct.address);
ok(fee1 > 0n && fee1 < 5_000_000n, `relay fee paid in USDC: ${Number(fee1) / 1e6} (the fork runs at ~1 gwei; real Base ~0.01)`);
ok(cast(`call ${RECOVERY} "isGuardian(address,address)(bool)" ${acct.address} ${DAO}`) === "true", "DAO recovery is on from the first setup");

await send(BOB, "ETH", "0.001", "s4");
ok(cast(`balance ${BOB}`) === "1000000000000000", "ETH send arrived (fee in ETH)");

// ---------------------------------------------------------------- level 2: add MetaMask
await page.locator(".level").tap();
await page.getByText("Connect and add").first().tap();
await page.getByRole("button", { name: "Sign", exact: true }).tap();
await page.getByText("Done").waitFor({ timeout: 90000 }).catch(() => {});
await page.waitForTimeout(14000);
await page.screenshot({ path: `${OUT}/s5-level2.png`, fullPage: true });
const owners2 = cast(`call ${acct.address} "getOwners()(address[])"`);
ok(owners2.toLowerCase().includes(hot.address.toLowerCase().slice(2)), "hot wallet is an owner");
ok(cast(`call ${acct.address} "getThreshold()(uint256)"`) === "2", "threshold 2");
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);

const CAROL = rand();
const by1 = await send(CAROL, "USDC", "40", "s6");
ok(usdcOf(CAROL) === 40_000_000n && /Instant wallet/.test(by1) && !/hot/.test(by1), "within the budget: Face ID alone (Roles)");
const DAVE = rand();
const by2 = await send(DAVE, "USDC", "300", "s7");
ok(usdcOf(DAVE) === 300_000_000n && /hot wallet/.test(by2), "over the budget: Face ID + hot wallet");

// ---------------------------------------------------------------- level 3: paper becomes the recovery
const paper = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").address; // anvil #2
await page.locator(".level").tap();
await page.getByPlaceholder("0x… the paper seed's address").fill(paper);
await page.getByText("Make it my recovery").tap();
await page.getByRole("button", { name: "Sign", exact: true }).tap();
await page.waitForTimeout(20000);
ok(cast(`call ${RECOVERY} "isGuardian(address,address)(bool)" ${acct.address} ${paper}`) === "true", "paper is the recovery address");
ok(cast(`call ${RECOVERY} "isGuardian(address,address)(bool)" ${acct.address} ${DAO}`) === "false", "the DAO is no longer the recovery address");

// ---------------------------------------------------------------- level 4: the wedgie
await page.getByText("Connect and add the wedgie").tap();
await page.getByRole("button", { name: "Sign", exact: true }).tap();
await page.waitForTimeout(25000);
await page.screenshot({ path: `${OUT}/s8-level4.png`, fullPage: true });
ok(cast(`call ${acct.address} "getThreshold()(uint256)"`) === "3", "threshold 3 with the wedgie");
ok(cast(`call ${acct.address} "getOwners()(address[])"`).split(",").length === 4, "4 owners (wedgie counts twice)");
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
const before = wedgieSigns;
const ERIN = rand();
const by3 = await send(ERIN, "USDC", "500", "s9");
ok(usdcOf(ERIN) === 500_000_000n && /wedgie/.test(by3) && wedgieSigns === before + 1, "big move at level 4: wedgie (one press) + hot wallet");

// ---------------------------------------------------------------- a recovery someone else starts: alert + cancel
const thief = rand();
cast(`rpc anvil_impersonateAccount ${paper}`);
cast(`rpc anvil_setBalance ${paper} 0xde0b6b3a7640000`); // 1 ETH
execSync(`cast send ${RECOVERY} "confirmRecovery(address,address[],uint256,bool)" ${acct.address} "[${thief}]" 1 true --unlocked --from ${paper} --rpc-url ${RPC}`, { stdio: "ignore" });
await page.waitForTimeout(14000);
await page.screenshot({ path: `${OUT}/s10-recovery-alert.png` });
ok(await page.getByText("Someone is recovering this wallet").isVisible(), "the app shows the recovery alert");
await page.getByRole("button", { name: "Cancel it" }).tap();
await page.getByRole("button", { name: "Sign to cancel it" }).tap();
await page.waitForTimeout(25000);
const req = cast(`call ${RECOVERY} "getRecoveryRequest(address)((uint256,uint256,uint64,address[]))" ${acct.address}`);
ok(/^\(0, 0, 0/.test(req), `recovery cancelled (${req.slice(0, 40)})`);

// ---------------------------------------------------------------- log in again on a "new device"
await page.evaluate(() => localStorage.clear());
await page.goto(`${APP}/safe`);
await page.getByText("I already have one").tap();
await page.getByText("Send", { exact: true }).waitFor({ timeout: 30000 });
const again = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
ok(again.address === acct.address, "logged back in to the same wallet");
await page.screenshot({ path: `${OUT}/s11-relogin.png` });

// ---------------------------------------------------------------- the phone is lost: a new device recovers the wallet
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx2.addInitScript(hotAddr => {
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [hotAddr];
      if (method === "eth_signTypedData_v4") return window.__hotSign(params[1]);
      throw new Error("fake wallet: " + method);
    },
  };
}, hot.address);
const page2 = await ctx2.newPage();
await page2.exposeFunction("__hotSign", async json => {
  const t = JSON.parse(json);
  delete t.types.EIP712Domain;
  return hot.signTypedData(t);
});
page2.on("pageerror", e => console.log("pageerror2", e.message));
const cdp2 = await ctx2.newCDPSession(page2);
await cdp2.send("WebAuthn.enable");
await cdp2.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await page2.goto(`${APP}/safe`);
await page2.getByText("Lost my phone: recover a wallet").tap();
await page2.getByPlaceholder("0x… your wallet's address").fill(acct.address);
await page2.getByText("Make my new key").tap();
await page2.getByText("Waiting for recovery").waitFor({ timeout: 30000 });
await page2.screenshot({ path: `${OUT}/s12-waiting-for-recovery.png` });
const acct2 = await page2.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
ok(acct2.address === acct.address && acct2.burnerSigner !== acct.burnerSigner, "new phone: same wallet, new key");
// the paper seed (the recovery address) starts it, 7 days pass, anyone finishes it
execSync(`cast send ${RECOVERY} "confirmRecovery(address,address[],uint256,bool)" ${acct.address} "[${acct2.burnerSigner}]" 1 true --unlocked --from ${paper} --rpc-url ${RPC}`, { stdio: "ignore" });
cast("rpc evm_increaseTime 604801");
cast("rpc evm_mine");
execSync(`cast send ${RECOVERY} "finalizeRecovery(address)" ${acct.address} --unlocked --from ${paper} --rpc-url ${RPC}`, { stdio: "ignore" });
ok(cast(`call ${acct.address} "getOwners()(address[])"`).toLowerCase() === `[${acct2.burnerSigner.toLowerCase()}]`, "recovery finished: the new key is the only owner");
await page2.waitForTimeout(14000);
ok(!(await page2.getByText("Waiting for recovery").isVisible()), "the new phone sees it's an owner");
const FRANK = rand();
await page2.locator(".balance .btn-green").tap();
await page2.getByText("Type it instead").tap();
await page2.getByPlaceholder("0x… or name.eth").fill(FRANK);
await page2.locator(".picker .pill", { hasText: "USDC" }).first().tap();
await page2.locator("input.amount").fill("7");
await page2.getByText("Review").tap();
await page2.locator(".confirm .btn-green").waitFor({ timeout: 15000 });
await page2.waitForTimeout(1500);
await page2.locator(".confirm .btn-green").tap();
await page2.getByText("Sent", { exact: true }).waitFor({ timeout: 90000 }).catch(async e => {
  console.log("on screen:", await page2.locator(".err").allTextContents());
  throw e;
});
ok(usdcOf(FRANK) === 7_000_000n, "the recovered wallet sends from the new phone (its signer deployed on the way)");
await page2.getByText("Done").tap();
await page2.waitForTimeout(13000);
ok(await page2.getByText("Turn off the old phone's budget").isVisible(), "the new phone is told the lost phone still has a budget");
const rolesAddr = cast(`call ${acct.address} "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10`);
await page2.getByRole("button", { name: "Turn it off" }).tap();
await page2.getByRole("button", { name: "Sign to turn it off" }).tap();
await page2.waitForTimeout(20000);
const modsAfter = cast(`call ${acct.address} "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10`);
const rolesOf = rolesAddr.match(/0x[0-9a-fA-F]{40}/g).find(m => m.toLowerCase() !== RECOVERY.toLowerCase());
const members = cast(`call ${rolesOf} "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10`);
ok(!members.toLowerCase().includes(acct.burnerSigner.toLowerCase().slice(2)), `the lost phone is out of the budget (${members.slice(0, 50)})`);
ok(modsAfter === rolesAddr, "Roles stays on, ready for this phone");
// and the recovered phone can level up again (Roles exists: no second deploy)
await page2.locator(".level").tap();
await page2.getByText("Connect and add").first().tap();
await page2.getByRole("button", { name: "Sign", exact: true }).tap();
await page2.waitForTimeout(25000);
const errs2 = await page2.locator(".err").allTextContents();
if (errs2.length) console.log("on screen:", errs2);
await page2.screenshot({ path: `${OUT}/s14-recovered-levelup.png`, fullPage: true });
ok(cast(`call ${acct.address} "getThreshold()(uint256)"`) === "2", "the recovered wallet adds its hot wallet again");
const members2 = cast(`call ${rolesOf} "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10`);
ok(members2.toLowerCase().includes(acct2.burnerSigner.toLowerCase().slice(2)), "the new phone has the budget now");
await page2.screenshot({ path: `${OUT}/s13-recovered-sent.png` });

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
