// End-to-end on a Base fork: create a wallet with a virtual passkey, fund it with USDC + ETH (never any gas money),
// send USDC (first op: deploy + permit + send, one Face ID), send ETH, send everything, re-login, open a link.
// Every send is an ERC-4337 op through /api/bundler (self mode: our route calls the real EntryPoint v0.8) with gas
// paid in USDC by the real Circle Paymaster on the fork. Setup: README "Local end to end".
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
const APP = "http://localhost:3100";
const RPC = "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACTORY = "0x896c8D40022A79FC1228dB800FD3aaf7f21d7469";
const OUT = process.argv[2];
const EXE = process.env.CHROME;
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const num = s => BigInt(s.split(" ")[0]);
const usdcOf = a => num(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`));
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };
const rand = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
});
await page.goto(APP);
await page.getByText("Create wallet").tap();
await page.getByText("Send", { exact: true }).waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/1-home-empty.png` });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iw3.account")));
console.log("wallet", acct.address);
const onchain = cast(`call ${FACTORY} "getAddress(bytes32,bytes32,uint8,bytes32)(address)" ${acct.qx} ${acct.qy} 0 ${acct.credentialIdHash}`);
ok(onchain.toLowerCase() === acct.address.toLowerCase(), "address computed in the browser = Factory.getAddress");

// fund the (undeployed) wallet: 100 USDC (FiatToken balances = slot 9) + 0.01 ETH. No gas key, no ETH for gas.
const slot = execSync(`cast index address ${acct.address} 9`, { encoding: "utf8" }).trim();
cast(`rpc anvil_setStorageAt ${USDC} ${slot} 0x${(100_000_000n).toString(16).padStart(64, "0")}`);
cast(`rpc anvil_setBalance ${acct.address} 0x2386f26fc10000`);
await page.waitForTimeout(11000);
await page.screenshot({ path: `${OUT}/2-home-funded.png` });

const BOB = rand();
async function send(to, pickText, amount, shot) {
  await page.locator(".balance .btn-green").tap();
  await page.getByText("Type it instead").tap();
  await page.getByPlaceholder("0x… or name.eth").fill(to);
  await page.locator(".picker .pill", { hasText: pickText }).first().tap();
  if (amount) await page.locator("input.amount").fill(amount);
  await page.screenshot({ path: `${OUT}/${shot}-form.png` });
  await page.getByText("Review").tap();
  await page.screenshot({ path: `${OUT}/${shot}-confirm.png` });
  await page.locator(".confirm .btn-green").tap();
  await page.getByText("Sent", { exact: true }).waitFor({ timeout: 60000 }).catch(async e => {
    console.log("on screen:", await page.locator(".err").allTextContents());
    throw e;
  });
  await page.screenshot({ path: `${OUT}/${shot}-sent.png` });
  await page.getByText("Done").tap();
}
await send(BOB, "USDC", "12.5", "3");
ok(usdcOf(BOB) === 12_500_000n, "first send (deploy + permit + USDC) arrived");
ok(cast(`code ${acct.address}`).length > 4, "wallet deployed by the first send");
const fee1 = 100_000_000n - 12_500_000n - usdcOf(acct.address);
ok(fee1 > 0n && fee1 < 200_000n, `fee paid in USDC (${Number(fee1) / 1e6})`);
ok(cast(`balance ${acct.address}`) === "10000000000000000", "wallet's ETH untouched by gas");

await page.waitForTimeout(11000);
await send(BOB, "ETH", "0.002", "4");
ok(cast(`balance ${BOB}`) === "2000000000000000", "second send (ETH, no permit) arrived");

await page.waitForTimeout(11000);
const CAROL = rand();
await send(CAROL, "Everything", null, "5");
ok(cast(`balance ${CAROL}`) === "8000000000000000", "send all: all the ETH arrived");
const left = usdcOf(acct.address);
ok(usdcOf(CAROL) > 87_000_000n && left < 200_000n, `send all: USDC arrived, ${Number(left) / 1e6} left behind (fee refund)`);

// forget + log back in: the deployed candidate wins with one Face ID
await page.locator(".me").tap();
await page.getByText("Forget this wallet on this device").tap();
await page.getByText("I already have one").tap();
await page.getByText("Send", { exact: true }).waitFor({ timeout: 15000 });
const again = await page.evaluate(() => JSON.parse(localStorage.getItem("iw3.account")));
ok(again.address === acct.address, "login recovers the same wallet");

// payment link
await page.goto(`${APP}/base:${BOB};0.01`);
await page.getByText("Review").waitFor({ timeout: 15000 });
ok((await page.getByPlaceholder("0x… or name.eth").inputValue()).toLowerCase() === BOB, "link prefills recipient");
await page.screenshot({ path: `${OUT}/6-link.png` });
await browser.close();
