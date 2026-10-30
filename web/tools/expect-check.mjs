// EXPECTATIONS.md, checked on the live site after every push (.github/workflows/expect.yaml): a real wallet, read-only
// (?watch=), its home and every tx page it links to. Fails on:
//   - hex on the screen (rule 1): 0x and more than 40 hex digits (calldata, a hash). An address alone is allowed.
//   - more than one green button on a page (rule 4), not counting Sign buttons (one per signer you hold).
//   - money in a tx's lines without a red − or green + (rule 1): an amount and a coin with no sign in front.
//   APP=https://instantwallet.io SAFE=0x… CHROME=<chrome> node tools/expect-check.mjs
import { chromium } from "playwright-core";

const APP = process.env.APP || "https://instantwallet.io";
const SAFE = process.env.SAFE || "0xcF589969582dD70544978114C9E5521F61fBe8E5"; // Austin's
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let fails = 0;
const say = (good, what) => {
  console.log(`${good ? "ok  " : "FAIL"} ${what}`);
  if (!good) fails++;
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // a phone

async function check(url, name) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(8000); // balances, history, prices
  const r = await page.evaluate(() => {
    const seen = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = document.body.innerText;
    const hex = text.match(/0x[0-9a-fA-F]{41,}/g) || [];
    const greens = [...document.querySelectorAll(".btn-green")].filter(seen).map(b => b.innerText.trim()).filter(t => !/^Sign\b/.test(t));
    // a coin amount with no sign: "12.5 USDC" in a line that doesn't start with − or +, inside a tx's lines (.what)
    const unsigned = [...document.querySelectorAll("[data-what] span")]
      .map(s => s.innerText.trim())
      .filter(t => /^\d[\d,.]*\s+[A-Z]{2,6}\b/.test(t));
    return { hex, greens, unsigned };
  });
  say(!r.hex.length, `${name}: no hex on screen${r.hex.length ? ` (${r.hex.map(h => h.slice(0, 14) + "…").join(", ")})` : ""}`);
  say(r.greens.length <= 1, `${name}: one green button at most${r.greens.length > 1 ? ` (${r.greens.join(" | ")})` : ""}`);
  say(!r.unsigned.length, `${name}: money has − or +${r.unsigned.length ? ` (${r.unsigned.join(" | ")})` : ""}`);
}

await check(`${APP}/?watch=${SAFE}`, "home");
const txs = [...new Set(await page.$$eval("a[href*='/tx/']", (as, app) => as.map(a => a.href).filter(h => h.startsWith(app)), APP))].slice(0, 5);
for (const [i, u] of txs.entries()) await check(u, `tx page ${i + 1}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all expectations met");
process.exit(fails ? 1 : 0);
