// Our own Safe Apps (github.com/clawdbotatg/instant-wallet-apps) in our frame, through both UIs, on a fork:
//   morpho (Base fork):     pick a vault, deposit 5 USDC (approve + deposit, one card), check the shares on chain
//   ens (Ethereum fork):    type a name, reserve, wait ENS's minute, register (USDC); the name points at the Safe
//   ens-primary (Ethereum): an old name (brantly.eth, its owner impersonated) points at the Safe;
//                           the top card offers it by itself (recent events), Set as primary → it's the Safe's primary name
// Setup as safe-e2e.mjs, plus the apps:   cd ../instant-wallet-apps && npm run dev   (5174)
//   Ethereum: anvil --fork-url <eth rpc>, NEXT_PUBLIC_CHAINS=1 MAINNET_RPC_URL=http://127.0.0.1:8545
//     LOCAL_TOKENS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
//   MODE=morpho|ens CHROME=<chromium> node tools/apps-ours-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const APP = process.env.APP || "http://localhost:3100";
const APPS = process.env.APPS_ORIGIN || "http://localhost:5174";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const MODE = process.env.MODE || "morpho";
const USDC = MODE.startsWith("ens") ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SLOT = 9;
const OUT = process.argv[2] || "/tmp";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const usdcOf = a => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`).split(" ")[0]);
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} ${USDC_SLOT}`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await page.goto(`${APP}/`);
await page.getByText("Create wallet").click();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 20000 });
const safe = (await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")))).address;
setUsdc(safe, 50_000_000n);
cast(`rpc anvil_setBalance ${safe} 0x16345785D8A0000`); // 0.1 ETH: a fee in ETH if the card picks it
if (MODE === "ens-primary") {
  // the name's owner (in another wallet) points it here, before the app opens
  const owner = "0x983110309620D911731Ac0932219af06091b6744", resolver = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63";
  cast(`rpc anvil_impersonateAccount ${owner}`);
  cast(`rpc anvil_setBalance ${owner} 0x16345785D8A0000`);
  cast(`send ${resolver} "setAddr(bytes32,address)" ${execSync("cast namehash brantly.eth", { encoding: "utf8" }).trim()} ${safe} --from ${owner} --unlocked`);
}

await page.getByRole("button", { name: "Apps" }).click();
const path = MODE.startsWith("ens") ? "ens" : MODE;
await page.getByLabel("Safe App link").fill(`${APPS}/${path}`);
await page.getByRole("button", { name: "Open", exact: true }).click();
let frame;
for (let i = 0; i < 200 && !frame; i++) {
  frame = page.frames().find(f => f.url().startsWith(`${APPS}/${path}`));
  if (!frame) await page.waitForTimeout(100);
}
const approve = async what => {
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/ours-${MODE}-${what}-before.png` });
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "Approve" && !b.disabled), null, { timeout: 60000 });
  await page.screenshot({ path: `${OUT}/ours-${MODE}-${what}.png` });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
};

if (MODE === "morpho") {
  await frame.locator(".card.pick").first().waitFor({ timeout: 60000 });
  const vaultName = await frame.locator(".card.pick b").first().textContent();
  await page.screenshot({ path: `${OUT}/ours-morpho-1-list.png` });
  await frame.locator(".card.pick").first().click();
  await frame.getByPlaceholder("Amount in USDC").fill("5");
  await frame.getByRole("button", { name: "Deposit", exact: true }).last().click();
  await approve("2-card");
  await frame.getByText("You have").first().waitFor({ timeout: 90000 });
  await page.screenshot({ path: `${OUT}/ours-morpho-3-done.png` });
  ok(usdcOf(safe) < 46_000_000n, `deposited 5 USDC into ${vaultName} (wallet now ${Number(usdcOf(safe)) / 1e6} USDC)`);
} else if (MODE === "ens-primary") {
  const name = "brantly.eth";
  // nothing typed: found from the last hours' address-changed events
  await frame.getByRole("button", { name: "Set as primary" }).waitFor({ timeout: 60000 });
  ok(await frame.getByText(name).first().isVisible(), `${name} offered at the top without typing`);
  await page.screenshot({ path: `${OUT}/ours-ens-primary-1-offer.png` });
  await frame.getByRole("button", { name: "Set as primary" }).click();
  await approve("2-card");
  await frame.getByText("Primary name of this wallet").waitFor({ timeout: 90000 });
  await page.screenshot({ path: `${OUT}/ours-ens-primary-3-done.png` });
  const pc = createPublicClient({ chain: mainnet, transport: http(RPC) });
  const primary = await pc.getEnsName({ address: safe, universalResolverAddress: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" }).catch(e => (console.log(e.shortMessage), null));
  ok(primary === name, `the Safe's primary name is ${primary}`);
  ok((await frame.getByRole("button", { name: "Set as primary" }).count()) === 0, "the offer goes away once it's primary");
} else {
  const label = `iwtest${Date.now() % 1e8}`;
  await frame.getByPlaceholder("Type a name").fill(label);
  await frame.getByRole("button", { name: "Step 1 of 2: Reserve" }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: `${OUT}/ours-ens-1-quote.png` });
  await frame.getByRole("button", { name: "Step 1 of 2: Reserve" }).click();
  await approve("2-commit");
  await frame.getByRole("button", { name: "Step 2 of 2: Register" }).waitFor({ timeout: 180000 });
  await frame.getByRole("button", { name: "Step 2 of 2: Register" }).click();
  await approve("3-register");
  await frame.getByText(`${label}.eth`).first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/ours-ens-4-done.png` });
  const pc = createPublicClient({ chain: mainnet, transport: http(RPC) });
  const ur = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe"; // ENS's universal resolver (v2)
  const resolved = await pc.getEnsAddress({ name: `${label}.eth`, universalResolverAddress: ur }).catch(e => (console.log(e.shortMessage), null));
  const primary = await pc.getEnsName({ address: safe, universalResolverAddress: ur }).catch(e => (console.log(e.shortMessage), null));
  ok(primary === `${label}.eth`, `the Safe's primary name is ${primary}`);
  ok(resolved?.toLowerCase() === safe.toLowerCase(), `${label}.eth resolves to the Safe (${resolved})`);
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
