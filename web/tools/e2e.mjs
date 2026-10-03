// End-to-end: create wallet with a virtual passkey, fund it on anvil, send USDC + ETH, re-login, open a link.
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
const APP = "http://localhost:3100";
const RPC = "http://127.0.0.1:8545";
const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const FACTORY = "0x0Dedc086740f95fc3cd7B5b46cE0EB91b00A318F";
const OUT = process.argv[2];
const EXE = process.env.CHROME;
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
});
await page.goto(APP);
await page.getByText("Create wallet").tap();
await page.getByText("Send", { exact: true }).waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/1-home-empty.png` });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iw3.account")));
const gasPk = await page.evaluate(a => JSON.parse(localStorage.getItem(`iw3.gas.${a.toLowerCase()}`)), acct.address);
console.log("wallet", acct.address);
const onchain = cast(`call ${FACTORY} "getAddress(bytes32,bytes32,uint8,bytes32)(address)" ${acct.qx} ${acct.qy} 0 ${acct.credentialIdHash}`);
ok(onchain.toLowerCase() === acct.address.toLowerCase(), "address computed in the browser = Factory.getAddress");
const gasAddr = execSync(`cast wallet address ${gasPk}`, { encoding: "utf8" }).trim();

// fund: 100 USDC + 1 ETH to the (undeployed) wallet, 0.05 ETH to the gas key
cast(`send ${USDC} "mint(address,uint256)" ${acct.address} 100000000 --private-key ${PK0}`);
cast(`send ${acct.address} --value 1ether --private-key ${PK0}`);
cast(`send ${gasAddr} --value 0.05ether --private-key ${PK0}`);
await page.waitForTimeout(11000);
await page.screenshot({ path: `${OUT}/2-home-funded.png` });

const BOB = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");
async function send(sym, amount, shot) {
  await page.locator(".balance .btn-green").tap();
  await page.getByText("Type it instead").tap();
  await page.getByPlaceholder("0x… or name.eth").fill(BOB);
  await page.locator(".picker .pill", { hasText: sym }).first().tap();
  await page.locator("input.amount").fill(amount);
  await page.screenshot({ path: `${OUT}/${shot}-form.png` });
  await page.getByText("Review").tap();
  await page.screenshot({ path: `${OUT}/${shot}-confirm.png` });
  await page.getByText("Send with Face ID").tap();
  await page.getByText("Sent", { exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${OUT}/${shot}-sent.png` });
  await page.getByText("Done").tap();
}
await send("USDC", "12.5", "3");
ok(cast(`call ${USDC} "balanceOf(address)(uint256)" ${BOB}`).startsWith("12500000"), "first send (deploy + USDC) arrived");
ok(cast(`code ${acct.address}`).length > 4, "wallet deployed by the first send");
await send("ETH", "0.25", "4");
ok(cast(`balance ${BOB}`) === "250000000000000000", "second send (ETH) arrived");

// forget + log back in: the deployed candidate wins with one Face ID
await page.locator(".me").tap();
await page.getByText("Forget this wallet on this device").tap();
await page.getByText("I already have one").tap();
await page.getByText("Send", { exact: true }).waitFor({ timeout: 15000 });
const again = await page.evaluate(() => JSON.parse(localStorage.getItem("iw3.account")));
ok(again.address === acct.address, "login recovers the same wallet");

// payment link
await page.goto(`${APP}/local:${BOB};0.01`);
await page.getByText("Review").waitFor({ timeout: 15000 });
ok((await page.locator("input.amount").inputValue()) === "0.01", "link prefills amount");
ok((await page.getByPlaceholder("0x… or name.eth").inputValue()).toLowerCase() === BOB, "link prefills recipient");
await page.screenshot({ path: `${OUT}/5-link.png` });
await browser.close();
