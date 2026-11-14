// Proven balances (docs/PROVEN-BALANCES.md, lib/safe/proven.ts, <Proven> in components/bits.tsx) in a real browser:
// Home for a public wallet, view only, its /api/portfolio answer caught in the browser so the test is "the server".
// The proofs are real: this browser's light client, through the dev server's /api/rpc, against the Colibri prover.
//   1. switch off: no fade anywhere (drawn as before)
//   2. switch on (Settings → Your node), before any proof: Ethereum and Gnosis rows faded
//   3. proofs landed: honest rows full, a Base row still faded
//   4. a wrong amount and a made-up coin in the answer: red, with the proven number
//   5. the total at the top is never faded
//
//   ALCHEMY_API_KEY=… NEXT_PUBLIC_CHAINS=1,100,8453 npx next dev -p 3217 &     (a dev server: the test shortens
//   SETTLE_MS through window.__proven.settle, which a production build doesn't have)
//   CHROME=<chromium> APP=http://localhost:3217 node tools/proven-e2e.mjs /tmp/shots
// Run it from a temp folder if you like; it writes only the screenshots.
import { chromium } from "playwright-core";

const APP = process.env.APP || "http://localhost:3217";
const OUT = process.argv[2] || "/tmp";
const WALLET = process.env.WALLET || "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth: public, coins on all three
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // on Ethereum
const FAKE = "0x00000000000000000000000000000000deadbeef"; // no code: its proven balanceOf is no answer at all
let fails = 0;
const ok = (c, m) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);
const t0 = Date.now();
const log = m => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("  pageerror:", e.message));
page.on("console", m => m.type() === "warning" && m.text().startsWith("proven:") && log(m.text().slice(0, 300)));
// the store's rows for these coins (a dev server only): what the rule thinks, when an assertion fails
const table = keys => page.evaluate(k => Object.fromEntries(Object.entries(window.__proven?.table() ?? {}).filter(([x]) => k.some(y => x.includes(y))).map(([x, r]) => [x, { ...r, shown: String(r.shown), proven: r.proven == null ? r.proven : String(r.proven) }])), keys);

// ---- the server: the real answer once, then exactly what this test says
let real = null;
let lie = false;
let reads = 0;
await page.route("**/api/portfolio?**", async route => {
  // the server's real answer until it has every network (a full scan can be late at first), then always that one
  if (!real || real.late?.length) {
    const r = await route.fetch();
    real = await r.json();
    log(`real portfolio: ${real.assets?.length} coins, late ${JSON.stringify(real.late ?? [])}`);
  }
  reads++;
  const j = structuredClone(real);
  if (lie) {
    const u = j.assets.find(a => a.chainId === 1 && a.asset.toLowerCase() === USDC);
    // 1,000 USDC more than the chain says, and a coin it never had: both at the top of the list
    const wrong = { ...u, balance: String(BigInt(u.balance) + 1_000_000_000n), formatted: String(Number(u.formatted) + 1000), usd: (u.usd ?? 0) + 1000 };
    const fake = { chainId: 1, asset: FAKE, symbol: "FAKE", name: "Fake Dollar", decimals: 18, balance: String(250n * 10n ** 18n), formatted: "250", price: 1, usd: 250 };
    j.assets = [fake, wrong, ...j.assets.filter(a => a !== u)];
    j.totalUsd = (j.totalUsd ?? 0) + 1250;
  }
  await route.fulfill({ json: j });
});

// ---- what the page draws
const rows = () =>
  page.$$eval(".card.assets .asset", els =>
    els.map(el => {
      const right = el.querySelector(".right");
      const fine = el.querySelector(".grow .fine")?.textContent ?? "";
      return {
        sym: el.querySelector(".grow .sym")?.textContent ?? "",
        net: fine.split(" · ").pop(),
        cls: right?.className ?? "",
        opacity: right ? Number(getComputedStyle(right).opacity) : null,
        color: right ? getComputedStyle(right.querySelector(".sym")).color : null,
        usd: right?.querySelector(".sym")?.textContent ?? "",
        amount: right?.querySelector(".fine")?.textContent ?? "",
        mark: !!el.querySelector(".proven-mark"),
        words: el.querySelector(".grow .fine")?.textContent ?? "",
      };
    }),
  );
const total = () => page.$eval(".card.balance .big", el => ({ cls: el.className, opacity: Number(getComputedStyle(el).opacity), text: el.textContent, inProven: !!el.closest(".proven") || !!el.querySelector(".proven") }));
const until = async (f, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await page.waitForTimeout(1000);
  }
  log(`gave up waiting: ${what}`);
  return null;
};
const NETS = ["Ethereum", "Gnosis"];

const isUsdc = y => y.sym === "USDC" && y.net === "Ethereum";
const shot = async (n, name) => {
  const path = `${OUT}/${n}-${name}.png`;
  await page.screenshot({ path });
  console.log(`  shot ${path}`);
};
const totalFull = async state => {
  const t = await total();
  ok(t.opacity === 1 && !/\bproven\b/.test(t.cls) && !t.inProven, `${state}: the total is full (opacity ${t.opacity}, "${t.text}")`);
};

// ---- 1. switch off
await page.goto(`${APP}/?watch=${WALLET}`);
await page.evaluate(() => localStorage.removeItem("iws.proven"));
await page.reload();
await until(async () => new Set((await rows()).map(x => x.net)).size === 3 && (await total()).cls === "big", 120_000, "Home's fresh rows, all three networks");
let r = await rows();
log(`${r.length} rows: ${[...new Set(r.map(x => x.net))].join(", ")}`);
ok(r.length > 0 && (await page.$$(".proven, .proven-mark")).length === 0, "1 switch off: no .proven anywhere, rows drawn as before");
ok(r.every(x => x.cls === "right" && x.opacity === 1), "1 switch off: every row's numbers full, class just 'right'");
await totalFull("1");
await shot(1, "switch-off");

// ---- 2. switch on in Settings, before any proof
await page.evaluate(() => window.__proven?.settle(5_000)); // a dev server only: a disagreement may count 5 s after a number shows, not 2 min
ok(await page.evaluate(() => typeof window.__proven?.settle === "function"), "dev server has the settle hook");
await page.getByRole("button", { name: "Settings" }).click();
// Settings opens on the network with the most money (Base, for this wallet): it has no such switch
ok((await page.getByLabel("Prove balances").count()) === 0, "Settings on Base: no switch (no light client there)");
await page.locator(".pill.select", { hasText: "Base" }).first().click();
await page.locator(".picker.drop button", { hasText: "Ethereum" }).first().click();
const box = page.getByLabel("Prove balances");
await box.scrollIntoViewIfNeeded();
await box.check();
ok(await page.evaluate(() => localStorage.getItem("iws.proven") === "[1]"), "Settings → Your node on Ethereum: the switch turns it on there");
await page.evaluate(() => localStorage.setItem("iws.proven", "[1,100]")); // and Gnosis (its own switch, in its own section)
await page.locator(".card.step", { hasText: "Prove balances" }).screenshot({ path: `${OUT}/0-settings.png` });
console.log(`  shot ${OUT}/0-settings.png`);
await page.keyboard.press("Escape");
await page.waitForTimeout(900); // the fade's transition
r = await rows();
const mine = r.filter(x => NETS.includes(x.net));
ok(mine.length > 0 && mine.every(x => /\bproven faded\b/.test(x.cls) && Math.abs(x.opacity - 0.6) < 0.01), `2 before proofs: all ${mine.length} Ethereum/Gnosis rows faded (0.6)`);
ok(r.filter(x => !NETS.includes(x.net)).every(x => /\bfaded\b/.test(x.cls)), "2 before proofs: the other networks' rows faded too");
await totalFull("2");
await shot(2, "on-before-proofs");
await page.locator(".card.balance").screenshot({ path: `${OUT}/5-total-never-fades.png` });
console.log(`  shot ${OUT}/5-total-never-fades.png (with the rows below it faded)`);

// ---- 3. real proofs land
const full = await until(async () => {
  const x = await rows();
  return x.filter(y => NETS.includes(y.net)).every(y => y.cls === "right proven") && x;
}, 150_000, "every Ethereum/Gnosis row proven");
await page.waitForTimeout(900); // the last row's transition
r = await rows();
const proven = r.filter(x => x.cls === "right proven");
log(`proven: ${proven.map(x => `${x.sym}/${x.net}`).join(", ")}`);
ok(!!full, `3 after proofs: every Ethereum/Gnosis row full (${proven.length} rows)`);
ok(proven.every(x => x.opacity === 1), "3 after proofs: full is opacity 1");
const base = r.filter(x => x.net === "Base");
ok(base.length > 0 && base.every(x => /\bfaded\b/.test(x.cls) && Math.abs(x.opacity - 0.6) < 0.01), `3 after proofs: the ${base.length} Base rows still faded (no light client)`);
await totalFull("3");
const total0 = Number((await total()).text.replace(/[^\d.]/g, ""));
await shot(3, "proven");

// ---- 4. the server says a wrong amount and a made-up coin
lie = true;
const before = reads;
await until(async () => reads > before + 1 && (await rows()).some(x => x.sym === "FAKE"), 30_000, "the lie on screen");
r = await rows();
ok(/\bfaded\b/.test(r.find(x => x.sym === "FAKE")?.cls ?? "") && /\bfaded\b/.test(r.find(x => isUsdc(x))?.cls ?? ""), "4 a new number first: faded, not red (a new payment is never wrong)");
await page.waitForTimeout(800);
await shot(4, "a-lie-shows-faded");
let tick = 0;
const red = await until(async () => {
  if (++tick % 30 === 0) log(JSON.stringify(await table([FAKE, `1:${USDC}`])));
  const x = await rows();
  const f = x.find(y => y.sym === "FAKE");
  const u = x.find(y => isUsdc(y));
  return f && u && /\bwrong\b/.test(f.cls) && /\bwrong\b/.test(u.cls) && x;
}, 240_000, "both lies red");
ok(!!red, "4 the made-up coin and the wrong amount go red");
if (!red) log(JSON.stringify(await table([FAKE, `1:${USDC}`])));
if (red) {
  await page.waitForTimeout(800); // the color's transition
  r = await rows();
  const f = r.find(y => y.sym === "FAKE");
  const u = r.find(y => isUsdc(y));
  const realU = real.assets.find(a => a.chainId === 1 && a.asset.toLowerCase() === USDC);
  log(`FAKE: ${f.usd} / ${f.amount} / mark ${f.mark} / ${f.color}`);
  log(`USDC: ${u.usd} / ${u.amount} / mark ${u.mark} / ${u.color}; the chain (as the server first said): ${realU.formatted}`);
  ok(f.usd === "$0.00" && f.amount === "0 FAKE", "4 the made-up coin shows the proven number: $0.00, 0 FAKE");
  ok(Math.abs(Number(u.amount.replace(/[^\d.]/g, "")) - Number(realU.formatted)) < 1, `4 the wrong amount shows the proven number (${u.amount}), not the server's (+1,000)`);
  ok(f.mark && u.mark && r.filter(y => y.mark).length === 2, "4 both rows have the red ! and no other row does");
  ok(!/match|chain|wrong/i.test(f.words + u.words) && /Ethereum/.test(u.words), `4 no words about it in the row (the line under USDC still reads "${u.words}")`);
  await page.locator(".card.assets .asset", { hasText: "USDC" }).locator(".proven-mark [role=button]").first().tap();
  const sheet = page.locator(".sheet").last();
  await sheet.waitFor();
  const said = await sheet.innerText();
  log(`the ! opens: ${said.replace(/\n+/g, " | ")}`);
  ok(/Our server/.test(said) && (await sheet.locator("s").innerText()).replace(/,/g, "").includes(String(Math.floor(Number(realU.formatted) + 1000))), "4 the ! opens a sheet: our server's number, struck out");
  ok((await sheet.locator("b").last().innerText()).replace(/,/g, "").includes(String(Math.floor(Number(realU.formatted)))), "4 and the network's number");
  ok(page.url().includes("watch") && !(await page.locator("text=Send to").count()), "4 the tap on the ! didn't open Send");
  await shot(4, "wrong-sheet");
  await sheet.getByRole("button", { name: "Done" }).tap();
  await sheet.waitFor({ state: "detached" });
  const tot = Number((await total()).text.replace(/[^\d.]/g, ""));
  ok(Math.abs(tot - total0) < 200, `4 the total counts the proven numbers: ${tot} (was ${total0}; the server's lies add 1,250+)`);
  ok(f.color === "rgb(227, 49, 44)" && u.color === "rgb(227, 49, 44)" && f.opacity === 1, "4 red is the app's red (--coral), full, no −");
  ok(!f.usd.includes("−") && !u.usd.includes("−"), "4 no minus sign (that is <Money>'s money out)");
  await totalFull("4");
  await page.locator(".card.assets .asset", { hasText: "FAKE" }).scrollIntoViewIfNeeded();
  await shot(4, "wrong-red");
}

// ---- and off again: drawn as before at once
await page.evaluate(() => localStorage.removeItem("iws.proven"));
await page.reload();
await until(async () => (await rows()).length > 0 && (await total()).cls === "big", 60_000, "Home again");
ok((await page.$$(".proven, .proven-mark")).length === 0, "off again: no .proven anywhere");

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
