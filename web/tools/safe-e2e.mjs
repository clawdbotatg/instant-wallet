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
const fakeWedgie = async msg => {
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
await page.goto(`${APP}/`);
await page.getByText("Create wallet").tap();
await page.getByText("Receive", { exact: true }).waitFor({ timeout: 20000 });
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

async function send(to, pickText, amount, shot, keys) {
  // the green send button on that asset's row (it skips the scanner and picks the asset)
  await page.locator(".asset", { has: page.locator(".sym", { hasText: new RegExp(`^${pickText}$`) }) }).first().locator(".send-one").tap();
  await page.getByPlaceholder("0x… or name.eth").fill(to);
  await page.locator("input.amount").fill(amount);
  await page.getByText("Review").tap();
  const go = page.locator(".confirm .btn-green");
  await go.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500); // the quote
  const line = page.locator(".line", { hasText: "Signed by" });
  if (keys) {
    await line.locator(".pill", { hasText: keys }).tap(); // pick another way to sign
    await page.waitForTimeout(1500); // its quote
  }
  await page.screenshot({ path: `${OUT}/${shot}-review.png` });
  // the chosen way to sign (a pressed-in pill when there's a choice)
  const signedBy = (await line.locator(".pill.on").count()) ? await line.locator(".pill.on").textContent() : (await line.textContent()).replace(/^Signed by/, "");
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

// ---------------------------------------------------------------- swaps (level 1: Face ID alone)
async function swap(fromSym, amount, toSym, via, shot) {
  await page.evaluate(v => localStorage.setItem("iws.swapVia", v), via); // force one source, to test both
  await page.locator(".balance .btn", { hasText: "Swap" }).tap();
  // From: a select box with a filter
  const fromSel = page.locator(".swap .field").first().locator(".pill.select");
  if (!((await fromSel.textContent()) || "").includes(fromSym)) {
    await fromSel.tap();
    await page.getByPlaceholder("Filter").fill(fromSym.toLowerCase());
    await page.screenshot({ path: `${OUT}/${shot}-from.png` });
    await page.locator(".swap .picker .pill", { has: page.locator("b", { hasText: new RegExp(`^${fromSym}$`) }) }).first().tap();
  }
  await page.locator(".swap input.amount").fill(amount);
  // To: network select + token select (a filter, or Custom: paste a contract address)
  const toSel = page.locator(".swap .pair .pill.select").nth(1);
  await toSel.tap();
  if (toSym.startsWith("0x")) {
    await page.getByText("Custom: paste a contract address").tap();
    await page.getByPlaceholder(/Token contract on/).fill(toSym);
  } else {
    await page.getByPlaceholder("Filter").fill(toSym.toLowerCase());
    await page.locator(".swap .picker .pill", { has: page.locator("b", { hasText: new RegExp(`^${toSym}$`) }) }).first().tap();
  }
  await page.screenshot({ path: `${OUT}/${shot}-to.png` });
  await page.locator(".swap .get").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".go-swap")?.disabled, null, { timeout: 30000 });
  const how = await page.locator(".swap .via").textContent();
  await page.screenshot({ path: `${OUT}/${shot}-swap.png` });
  await page.locator(".go-swap").tap();
  await page.getByText("Swapped", { exact: true }).waitFor({ timeout: 90000 }).catch(async e => {
    console.log("on screen:", await page.locator(".err").allTextContents());
    await page.screenshot({ path: `${OUT}/${shot}-error.png` });
    throw e;
  });
  await page.screenshot({ path: `${OUT}/${shot}-swapped.png` });
  await page.getByText("Done").tap();
  await page.evaluate(() => localStorage.removeItem("iws.swapVia"));
  await page.waitForTimeout(13000);
  return how;
}
{
  const u0 = usdcOf(acct.address), e0 = BigInt(cast(`balance ${acct.address}`));
  const how = await swap("USDC", "100", "ETH", "uniswap", "s4a");
  const u1 = usdcOf(acct.address), e1 = BigInt(cast(`balance ${acct.address}`));
  ok(/Uniswap/.test(how) && u0 - u1 >= 100_000_000n && u0 - u1 < 102_000_000n && e1 > e0, `swap via Uniswap: 100 USDC → ${Number(e1 - e0) / 1e18} ETH (${how})`);
  const how2 = await swap("ETH", "0.002", USDC, "lifi", "s4b"); // USDC picked as a custom (pasted) token
  const u2 = usdcOf(acct.address), e2 = BigInt(cast(`balance ${acct.address}`));
  ok(/LI\.FI/.test(how2) && e1 - e2 >= 2_000_000_000_000_000n && u2 > u1, `swap via LI.FI: 0.002 ETH → ${Number(u2 - u1) / 1e6} USDC (${how2})`);
  ok(cast(`call ${USDC} "allowance(address,address)(uint256)" ${acct.address} 0x2626664c2603336E57B271c5C0b26F421741e481`) === "0", "no allowance left behind");
}

// ---------------------------------------------------------------- level 2: add MetaMask
await page.locator(".top .me").tap();
await page.getByText("Connect and add").first().tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
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
ok(usdcOf(CAROL) === 40_000_000n && /Instant/.test(by1) && !/Hot/.test(by1), "within the budget: Face ID alone (Roles)");
const DAVE = rand();
const by2 = await send(DAVE, "USDC", "300", "s7");
ok(usdcOf(DAVE) === 300_000_000n && /Instant \+ Hot wallet/.test(by2), "over the budget: Face ID + hot wallet");

// ---------------------------------------------------------------- level 3: paper becomes the recovery
const paper = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").address; // anvil #2
await page.locator(".top .me").tap();
await page.locator(".guardian input").waitFor();
ok(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), "guardian: Save is off until the address changes");
await page.locator(".guardian input").tap();
await page.waitForTimeout(300);
await page.locator(".guardian input").fill(paper);
await page.getByRole("button", { name: "Save", exact: true }).tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(20000);
ok(cast(`call ${RECOVERY} "isGuardian(address,address)(bool)" ${acct.address} ${paper}`) === "true", "paper is the recovery address");
ok(cast(`call ${RECOVERY} "isGuardian(address,address)(bool)" ${acct.address} ${DAO}`) === "false", "the DAO is no longer the recovery address");

// ---------------------------------------------------------------- level 4: the wedgie
await page.getByText("Connect and add the wedgie").tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(25000);
await page.screenshot({ path: `${OUT}/s8-level4.png`, fullPage: true });
ok(cast(`call ${acct.address} "getThreshold()(uint256)"`) === "3", "threshold 3 with the wedgie");
ok(cast(`call ${acct.address} "getOwners()(address[])"`).split(",").length === 4, "4 owners (wedgie counts twice)");
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
const before = wedgieSigns;
const ERIN = rand();
const by3 = await send(ERIN, "USDC", "500", "s9", "Wedgie + Hot wallet");
ok(usdcOf(ERIN) === 500_000_000n && /^Wedgie \+ Hot wallet/.test(by3) && wedgieSigns === before + 1, `big move with all three keys, picked: wedgie (one press) + hot wallet (${by3})`);

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
await page.goto(`${APP}/`);
await page.getByText("I already have one").tap();
await page.getByText("Receive", { exact: true }).waitFor({ timeout: 30000 });
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
await page2.goto(`${APP}/`);
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
await page2.locator(".asset", { has: page2.locator(".sym", { hasText: /^USDC$/ }) }).first().locator(".send-one").tap();
await page2.getByPlaceholder("0x… or name.eth").fill(FRANK);
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
await page2.locator(".top .me").tap();
await page2.getByText("Connect and add").first().tap();
await page2.getByRole("button", { name: "Yes", exact: true }).tap();
await page2.waitForTimeout(25000);
const errs2 = await page2.locator(".err").allTextContents();
if (errs2.length) console.log("on screen:", errs2);
await page2.screenshot({ path: `${OUT}/s14-recovered-levelup.png`, fullPage: true });
ok(cast(`call ${acct.address} "getThreshold()(uint256)"`) === "2", "the recovered wallet adds its hot wallet again");
const members2 = cast(`call ${rolesOf} "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10`);
ok(members2.toLowerCase().includes(acct2.burnerSigner.toLowerCase().slice(2)), "the new phone has the budget now");
await page2.screenshot({ path: `${OUT}/s13-recovered-sent.png` });

// ---------------------------------------------------------------- any order: a new wallet adds the wedgie first
await page.close();
newWedgie();
page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror3", e.message));
await page.exposeFunction("__hotSign", hotSign);
await page.exposeFunction("__fakeWedgie", fakeWedgie);
const cdp3 = await ctx.newCDPSession(page);
await cdp3.send("WebAuthn.enable");
await cdp3.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await page.goto(`${APP}/`);
await page.evaluate(() => localStorage.clear());
await page.goto(`${APP}/`);
await page.getByText("Create wallet").tap();
await page.getByText("Receive", { exact: true }).waitFor({ timeout: 20000 });
const acct3 = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
setUsdc(acct3.address, 2000_000_000n);
cast(`rpc anvil_setBalance ${acct3.address} 0x2386f26fc10000`);
await page.waitForTimeout(13000);
const lvl = async () => (await page.locator(".top .me .lvl").textContent()).replace(/\s/g, "");
ok((await lvl()) === "LVL1", "a new wallet: LVL1");
await page.locator(".top .me").tap();
await page.getByText("Connect and add the wedgie", { exact: true }).tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(25000);
const errs3 = await page.locator(".err").allTextContents();
if (errs3.length) console.log("on screen:", errs3);
await page.screenshot({ path: `${OUT}/s15-wedgie-first.png`, fullPage: true });
ok(cast(`call ${acct3.address} "getThreshold()(uint256)"`) === "3", "wedgie first (deploys the wallet too): threshold 3");
ok(cast(`call ${acct3.address} "getOwners()(address[])"`).split(",").length === 3, "3 owners: Instant + the wedgie's two slots");
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
ok((await lvl()) === "LVL2", "Instant + wedgie: LVL2");
let w0 = wedgieSigns;
const GUS = rand();
const by4 = await send(GUS, "USDC", "30", "s16");
ok(usdcOf(GUS) === 30_000_000n && !/Wedgie/.test(by4) && wedgieSigns === w0, "Instant + wedgie, within the budget: Face ID alone");
const HAL = rand();
const by5 = await send(HAL, "USDC", "300", "s17");
ok(usdcOf(HAL) === 300_000_000n && /^Instant \+ Wedgie/.test(by5) && wedgieSigns === w0 + 1, "Instant + wedgie, over the budget: Face ID + wedgie");
// then the hot wallet: the wedgie signs it, 3 of 4 after
w0 = wedgieSigns;
await page.locator(".top .me").tap();
await page.getByText("Connect and add", { exact: true }).tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(25000);
ok(cast(`call ${acct3.address} "getOwners()(address[])"`).toLowerCase().includes(hot.address.toLowerCase().slice(2)), "hot wallet added after the wedgie");
ok(cast(`call ${acct3.address} "getThreshold()(uint256)"`) === "3" && wedgieSigns === w0 + 1, "still threshold 3 (now 3 of 4); the wedgie signed it");
// and paper last
await page.locator(".guardian input").tap();
await page.waitForTimeout(300);
await page.locator(".guardian input").fill(paper);
await page.getByRole("button", { name: "Save", exact: true }).tap();
await page.getByRole("button", { name: "Yes", exact: true }).tap();
await page.waitForTimeout(25000);
ok(cast(`call ${RECOVERY} "isGuardian(address,address)(bool)" ${acct3.address} ${paper}`) === "true", "paper after the wedgie: it's the recovery address");
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
ok((await lvl()) === "LVL3", "Instant + hot + wedgie: LVL3");
await page.screenshot({ path: `${OUT}/s18-any-order-done.png` });

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
