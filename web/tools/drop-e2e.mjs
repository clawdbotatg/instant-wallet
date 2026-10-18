// Drops in the browser, on a Base fork (same setup as tools/drop-check.mts): an admin phone makes a wallet, logs in
// to /drops with Face ID, makes a crowd drop and a card drop; the pot is filled; a new phone opens the crowd link,
// makes a wallet and claims; a third phone opens the link, wanders to the home screen, makes its wallet there and
// claims from the banner; the PDF downloads; Present shows the count.
//   CHROME=<chromium> node tools/drop-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const OUT = process.argv[2] || "/tmp";
const APP = process.env.APP || "http://localhost:3100";
const RPC = "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const usdcOf = a => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`).split(" ")[0]);
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });
async function phone() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("pageerror", e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return page;
}
const wallet = page => page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")).address);
const dump = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log((await page.evaluate(() => document.body.innerText)).slice(0, 600));
};

// ---- the admin
const admin = await phone();
await admin.goto(APP);
await admin.getByText("Create wallet").tap();
await admin.locator(".card.balance").waitFor({ timeout: 30000 });
await admin.goto(`${APP}/drops`);
await admin.getByText("Log in with Face ID").tap();
await admin.getByText("New drop").waitFor({ timeout: 20000 });
ok(true, "admin logs in with Face ID");
await admin.getByText("New drop").tap();
const code = `TALK${Date.now() % 100000}`;
const fill = async (label, v) => admin.locator("label", { hasText: label }).locator("input").fill(v);
await fill("Name", "Test talk");
await fill("USDC per claim", "2");
await fill("Most claims", "5");
await fill("Code", code);
await admin.screenshot({ path: `${OUT}/drop-1-new.png` });
await admin.getByText("Make it").tap();
await admin.getByText("The pot", { exact: true }).waitFor({ timeout: 20000 });
ok(true, `crowd drop ${code} made`);
const token = await admin.evaluate(() => JSON.parse(localStorage.getItem("iw.dropAdmin")).token);
const api = (op, b = {}) => fetch(`${APP}/api/drop/admin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, token, ...b }) }).then(r => r.json());
const list = await api("list");
const crowd = list.drops.find(d => d.code === code);
const fee = BigInt((await fetch(`${APP}/api/safe/relay?chainId=8453&kind=claim`).then(r => r.json())).feeUsdc);
setUsdc(crowd.pot, 5n * (2_000_000n + fee * 2n));
await admin.getByText(/Enough for 5 of the 5/).waitFor({ timeout: 20000 });
ok(true, "the admin page sees the pot filled (enough for 5 of 5)");
await admin.screenshot({ path: `${OUT}/drop-2-pot.png` });

// ---- a new phone opens the link, makes a wallet, claims
const b = await phone();
await b.goto(`${APP}/d#${code}`);
await b.getByText("You get").waitFor({ timeout: 20000 });
ok(!b.url().includes("#"), "the code leaves the address bar");
await b.getByText("2 USDC on Base").waitFor({ timeout: 20000 });
ok(await b.getByText("$2.00").first().isVisible(), "it shows $2.00, 2 USDC on Base");
await b.screenshot({ path: `${OUT}/drop-3-new-phone.png` });
await b.getByText("Create wallet").tap();
await b.getByText("Claim $2.00").waitFor({ timeout: 20000 });
await b.getByText("Claim $2.00").tap();
await b.getByText("Open my wallet").waitFor({ timeout: 60000 }).catch(() => dump(b, "drop-4-fail"));
await b.screenshot({ path: `${OUT}/drop-4-done.png` });
const bw = await wallet(b);
ok(usdcOf(bw) === 2_000_000n, `the new wallet has 2 USDC (${usdcOf(bw)})`);
await b.goto("about:blank");
await b.goto(`${APP}/d#${code}`);
await b.getByText("already claimed").waitFor({ timeout: 20000 }).catch(() => dump(b, "drop-5-fail"));
ok(await b.getByText("already claimed").isVisible(), "the same phone twice: already claimed");

// ---- the code follows: open the link, go to the home screen, make the wallet there, claim from the banner
const c = await phone();
await c.goto(`${APP}/d#${code.toLowerCase()}`);
await c.getByText("You get").waitFor({ timeout: 20000 });
await c.goto(APP);
await c.getByText("Create wallet").tap();
await c.getByText("You have money to claim").waitFor({ timeout: 30000 }).catch(() => dump(c, "drop-6-fail"));
ok(await c.getByText(`The code ${code} is waiting`).isVisible(), "the home screen offers the code");
await c.screenshot({ path: `${OUT}/drop-6-banner.png` });
await c.getByText("Claim it").tap();
await c.getByText("Claim $2.00").tap();
await c.getByText("Open my wallet").waitFor({ timeout: 60000 }).catch(() => dump(c, "drop-7-fail"));
ok(usdcOf(await wallet(c)) === 2_000_000n, "claimed from the banner");
await c.goto(APP);
await c.locator(".card.balance").waitFor({ timeout: 30000 });
ok(!(await c.getByText("You have money to claim").isVisible()), "the banner is gone after");

// ---- typed: no link
const t = await phone();
await t.goto(`${APP}/d`);
await t.getByPlaceholder("Your code").fill(code.toLowerCase());
await t.getByText("Go").tap();
await t.getByText("You get").waitFor({ timeout: 20000 });
ok(true, "a typed code works");
await t.getByPlaceholder("Your code").count().then(n => ok(n === 0, "the form is gone"));
await t.evaluate(() => localStorage.removeItem("iw.drop")); // else /d opens the code waiting on this phone
await t.goto(`${APP}/d`);
await t.getByPlaceholder("Your code").fill("NOPE9999");
await t.getByText("Go").tap();
await t.getByText("isn't one of ours").waitFor({ timeout: 20000 });
ok(true, "a wrong code says so");

// ---- Present
await admin.getByText("Present").tap();
await admin.getByText("2 of 5 claimed").waitFor({ timeout: 20000 });
await admin.screenshot({ path: `${OUT}/drop-8-present.png` });
ok(true, "Present shows the QR and 2 of 5 claimed");
await admin.locator(".present").tap();

// ---- cards: PDF
await api("create", { drop: { name: "Cards", chainId: 8453, token: "usdc", amount: "5", kind: "cards", count: 12 } });
await admin.goto(`${APP}/drops`);
await admin.getByText("12 cards", { exact: false }).first().tap();
const [dl] = await Promise.all([admin.waitForEvent("download", { timeout: 30000 }), admin.getByText("Download PDF").tap()]);
ok(/claim-cards-12\.pdf/.test(dl.suggestedFilename()), `the PDF downloads (${dl.suggestedFilename()})`);
await admin.screenshot({ path: `${OUT}/drop-9-cards.png` });

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
