// Claim cards in bulk on a Base fork (docs/CLAIM.md): make 26 cards × 1 USDC, fill them from a fake browser wallet
// (anvil #1) through BuidlGuidl's splitter (25 in one splitERC20 + 1 plain transfer), check each card got 1 USDC,
// download the PDF, claim one card, and see the batch count it as claimed. Same setup as claim-e2e.mjs.
//   CHROME=<chromium> node tools/claim-batch-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OUT = process.argv[2] || "/tmp";
const N = 26;
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const usdcOf = a => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`).split(" ")[0]);
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const giver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1, unlocked on anvil
setUsdc(giver, 100_000_000n);
let sends = 0;

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
await page.exposeFunction("__rpc", async (method, params) => {
  if (method === "eth_sendTransaction") sends++;
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
});
await ctx.addInitScript(giver => {
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [giver];
      if (method === "wallet_switchEthereumChain") return null;
      return window.__rpc(method, params || []);
    },
  };
}, giver);

await page.goto(`${APP}/claim/new`);
await page.getByText("Make many").click();
await page.getByLabel("How many cards").fill(String(N));
await page.getByLabel("USDC on each").fill("1");
await page.getByText(`Make ${N} cards`).click();
await page.getByText(`Fill ${N} cards with my wallet`).waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/batch-1-empty.png`, fullPage: true });
await page.getByText(`Fill ${N} cards with my wallet`).click();
await page.getByText(`${N} ready · 0 claimed`).waitFor({ timeout: 90000 });
await page.screenshot({ path: `${OUT}/batch-2-ready.png`, fullPage: true });
ok(sends === 3, `3 wallet transactions: approve, splitERC20 (25), transfer (1) — got ${sends}`);
const cards = await page.evaluate(() => JSON.parse(localStorage.getItem("iw.cards")));
ok(cards.length === N && cards.every(c => usdcOf(privateKeyToAccount(c.key).address) === 1_000_000n), `all ${N} cards hold 1 USDC`);
ok(usdcOf(giver) === 100_000_000n - BigInt(N) * 1_000_000n, "the giver paid exactly 26 USDC");

const [dl] = await Promise.all([page.waitForEvent("download"), page.getByText("Download PDF").click()]);
const pdfPath = `${OUT}/claim-cards.pdf`;
await dl.saveAs(pdfPath);
const pdf = fs.readFileSync(pdfPath, "latin1");
ok(pdf.startsWith("%PDF") && (pdf.match(/\/Type \/Page\b/g) || []).length === 3, `PDF: 3 pages for 26 cards (${dl.suggestedFilename()})`);

// claim card 1 in another (fresh) context, then the batch counts it
const p2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const cdp = await p2.context().newCDPSession(p2);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await p2.goto(`${APP}/pk#${cards[0].key}`);
await p2.getByText("Create wallet").click();
await p2.getByText("Claim it").click();
await p2.getByText("Open my wallet").waitFor({ timeout: 90000 });
await page.getByText(`${N - 1} ready · 1 claimed`).waitFor({ timeout: 30000 });
ok(true, "the batch shows 1 claimed");

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
