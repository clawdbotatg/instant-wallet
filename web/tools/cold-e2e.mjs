// Cold storage end to end on a Base fork (README "Local end to end" setup; APP / RPC env override the ports).
// Passkey (virtual authenticator), the stand-in wedgie (/wedgie, same browser) and a test guardian (/guardian)
// run the scenarios from docs/COLD-STORAGE.md with a 10-minute wait, every send a real 4337 op with gas in USDC:
// set up cold storage (upgrade to 3.2 in the same Face ID) · passkey within / over its limit · wedgie alone waits ·
// both keys skip · passkey cancels a wedgie send · freeze stops the passkey · guardian replaces a lost wedgie.
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { p256 } from "@noble/curves/nist.js";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OUT = process.argv[2] || ".";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const num = s => BigInt(s.split(" ")[0]);
const usdcOf = a => num(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`));
const ok = (c, m) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || (process.exitCode = 1));
const rand = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
});
await page.clock.install(); // so the UI's countdowns can jump with the chain's clock below
const shot = n => page.screenshot({ path: `${OUT}/cold-${n}.png` });
const errs = async () => (await page.locator(".err").allTextContents()).join(" | ");

// guardian + stand-in wedgie keys live in this browser's storage
await page.goto(`${APP}/guardian`);
await page.waitForFunction(() => !!localStorage.getItem("iw3.test-guardian"));
const gPk = await page.evaluate(() => localStorage.getItem("iw3.test-guardian"));
const guardian = execSync(`cast wallet address ${gPk}`, { encoding: "utf8" }).trim();
cast(`rpc anvil_setBalance ${guardian} 0x2386f26fc10000`);

await page.goto(APP);
await page.getByText("Create wallet").tap();
await page.waitForFunction(() => !!localStorage.getItem("iw3.account"), null, { timeout: 30000 });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iw3.account")));
const W = acct.address;
console.log("wallet", W, "guardian", guardian);
const slot = execSync(`cast index address ${W} 9`, { encoding: "utf8" }).trim();
cast(`rpc anvil_setStorageAt ${USDC} ${slot} 0x${(1_000_000_000n).toString(16).padStart(64, "0")}`); // 1000 USDC
await page.waitForTimeout(11000);

async function passkeySend(to, amount, expectOk = true) {
  await page.goto(APP);
  await page.locator(".balance .btn-green").tap();
  await page.getByText("Type it instead").tap();
  await page.getByPlaceholder("0x… or name.eth").fill(to);
  await page.locator(".picker .pill", { hasText: "USDC" }).first().tap();
  await page.locator("input.amount").fill(amount);
  await page.getByText("Review").tap();
  await page.getByText("Send with Face ID").tap();
  if (expectOk) await page.getByText("Sent", { exact: true }).waitFor({ timeout: 60000 }).catch(async e => (console.log("on screen:", await errs()), Promise.reject(e)));
  else await page.locator(".err").first().waitFor({ timeout: 60000 });
}
async function openSafety() {
  await page.goto(APP);
  await page.locator(".me").tap();
  await page.getByText("Safety", { exact: true }).waitFor();
}

const BOB = rand();
await passkeySend(BOB, "1"); // deploys the wallet (3.1), permits the paymaster
ok(usdcOf(BOB) === 1_000_000n, "first send deploys the wallet");

// ---- set up cold storage: upgrade + wedgie owner + $100/day passkey + 10 min wait + test guardian, one Face ID
await openSafety();
await page.getByText("Use this browser's stand-in wedgie (testing)").tap();
await page.locator(".field", { hasText: "Guardian" }).locator("input").fill(guardian);
await shot("1-setup");
await page.getByText("Set up with Face ID").tap();
await page.getByText("Cold storage", { exact: true }).waitFor({ timeout: 90000 }).catch(async e => (console.log("on screen:", await errs()), Promise.reject(e)));
await shot("2-cold");
const call = (sig, ...a) => cast(`call ${W} "${sig}" ${a.join(" ")}`);
ok(call("version()(string)") === '"3.2.1"', "upgraded to 3.2 in the setup Face ID");
ok(call("coldDelay()(uint64)").startsWith("600"), "10-minute wait set");
ok(call("isGuardian(address)(bool)", guardian) === "true", "test guardian set");

// ---- passkey: within the limit instantly, over it refused
await passkeySend(BOB, "50");
ok(usdcOf(BOB) === 51_000_000n, "passkey sends $50 at once");
await passkeySend(BOB, "150", false);
ok(usdcOf(BOB) === 51_000_000n, "passkey can't send $150 (over its $100/day)");

// ---- wedgie alone: waits; passkey skips (both keys)
async function wedgieSend(to, amount) {
  await page.goto(`${APP}/wedgie`);
  await page.getByPlaceholder("0x…", { exact: true }).fill(W);
  await page.getByPlaceholder("to 0x…").fill(to);
  await page.getByPlaceholder("USDC").fill(amount);
  await page.getByText("Press A (sign)").tap();
  await page.getByText("Queued.").waitFor({ timeout: 90000 }).catch(async e => (console.log("on screen:", await page.locator(".fine").allTextContents()), Promise.reject(e)));
}
await wedgieSend(BOB, "300");
ok(usdcOf(BOB) === 51_000_000n, "wedgie's $300 waits");
await openSafety();
await page.getByText("Skip the wait (both keys)").waitFor({ timeout: 20000 });
await shot("3-waiting");
await page.getByText("Skip the wait (both keys)").tap();
await page.waitForFunction(() => !document.body.innerText.includes("Skip the wait"), null, { timeout: 90000 });
ok(usdcOf(BOB) === 351_000_000n, "passkey skipped the wait: $300 arrived");

// ---- stolen wedgie: its send gets cancelled by the passkey
await wedgieSend(BOB, "200");
await openSafety();
await page.getByText("Cancel", { exact: true }).first().waitFor({ timeout: 20000 });
await page.getByText("Cancel", { exact: true }).first().tap();
await page.waitForFunction(() => !document.body.innerText.includes("Waits "), null, { timeout: 90000 });
ok(usdcOf(BOB) === 351_000_000n, "passkey cancelled the wedgie's $200");

// ---- stolen phone: freeze, then the passkey can't send
await openSafety();
await page.getByText("❄️ Freeze wallet").tap();
await page.getByText(/Frozen for/).waitFor({ timeout: 90000 });
await shot("4-frozen");
await passkeySend(BOB, "5", false);
ok(usdcOf(BOB) === 351_000_000n, "frozen: the passkey can't send");

// ---- lost wedgie: the guardian replaces it after the recovery wait (plain txs, so time travel is fine now)
const sk = p256.utils.randomSecretKey();
const pub = hex(p256.getPublicKey(sk, false));
await page.goto(`${APP}/guardian`);
await page.getByPlaceholder("0x…", { exact: true }).fill(W);
await page.getByText("✓ This key is a guardian").waitFor({ timeout: 20000 });
await shot("5a-guardian");
await page.locator("button.pill", { hasText: /^wedgie / }).first().click();
await page.getByPlaceholder(/new wedgie key/).fill(`wedgie:0x${pub.slice(2, 66)}:0x${pub.slice(66)}`);
await page.getByText(/Start recovery/).tap();
await page.getByText(/Pending:/).waitFor({ timeout: 60000 });
cast("rpc evm_increaseTime 601");
cast("rpc evm_mine");
await page.clock.fastForward("10:02");
await page.waitForTimeout(7000);
await page.getByText("Finalize recovery").tap();
await page.getByText("Finalize: done").waitFor({ timeout: 60000 });
await shot("5-recovered");
const signers = call("getSigners()(address[],(bytes32,bytes32,uint8,uint8,uint64)[])");
ok(signers.toLowerCase().includes(pub.slice(2, 66).toLowerCase()), "guardian put the new wedgie in");

await browser.close();
