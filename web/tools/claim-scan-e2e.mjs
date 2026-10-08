// Claim cards, the two "already have a wallet" paths, on a Base fork (claim-e2e.mjs covers the new phone):
//   A. the phone camera opens the card's link in the browser that has the wallet: Claim it, no welcome screen
//   B. the wallet's own scan button reads the card's QR (a fake camera shows it): the claim opens, Claim it
// Both land in the same wallet. Same setup as claim-e2e.mjs; needs ffmpeg (the QR → a fake camera video).
//   CHROME=<chromium> node tools/claim-scan-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import QRCode from "qrcode";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OUT = process.argv[2] || "/tmp";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const usdcOf = a => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`).split(" ")[0]);
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const k1 = generatePrivateKey(), k2 = generatePrivateKey();
const [c1, c2] = [k1, k2].map(k => privateKeyToAccount(k).address);
setUsdc(c1, 3_000_000n);
setUsdc(c2, 4_000_000n);

// (the QR small in the frame, as a hand holds it: the scan box is the middle 72%)
// card 2 printed by the live site (another host): the scanner must still claim on this wallet's host
const link2 = `https://instant-wallet-b2jn.vercel.app/pk#${k2}`;
const png = `${OUT}/card2-qr.png`, vid = `${OUT}/card2-qr.y4m`;
await QRCode.toFile(png, link2, { width: 480, margin: 4 });
execSync(`ffmpeg -y -loglevel error -loop 1 -i ${png} -vf "scale=300:300,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p" -t 3 -r 10 ${vid}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${vid}`],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"] });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

// a phone that already has Instant Wallet
await page.goto(`${APP}/`);
await page.getByText("Create wallet").click();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 20000 });
const wallet = (await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")))).address;

// A. the camera app opens the link
await page.goto(`${APP}/pk#${k1}`);
await page.getByText("Claim it").waitFor({ timeout: 20000 });
ok((await page.getByText("Create wallet").count()) === 0, "A: a phone with a wallet goes straight to Claim it");
await page.screenshot({ path: `${OUT}/scan-a.png` });
await page.getByText("Claim it").click();
await page.getByText("Open my wallet").waitFor({ timeout: 90000 });
const afterA = usdcOf(wallet);
ok(afterA > 2_000_000n && usdcOf(c1) === 0n, `A: card 1's USDC is in that wallet (${afterA})`);

// B. the wallet's scan button
await page.getByText("Open my wallet").click();
await page.getByLabel("Scan to send").click();
await page.waitForURL(/\/claim$/, { timeout: 30000 }).catch(async e => { await page.screenshot({ path: `${OUT}/scan-b-fail.png` }); console.log(page.url(), (await page.evaluate(() => document.body.innerText)).slice(0, 400)); throw e; });
ok(new URL(page.url()).host === new URL(APP).host, "B: a card from another host opens the claim on this wallet's host");
await page.getByText("Claim it").waitFor({ timeout: 20000 });
await page.screenshot({ path: `${OUT}/scan-b.png` });
await page.getByText("Claim it").click();
await page.getByText("Open my wallet").waitFor({ timeout: 90000 });
const afterB = usdcOf(wallet);
ok(afterB - afterA > 3_000_000n && usdcOf(c2) === 0n, `B: card 2's USDC is in the same wallet (+${afterB - afterA})`);

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
