// xdai.io (PLAN-xdai.md), with no chain: the dark look, the old Burner key's move screen, old key links, the old
// service worker's kill switch. The portfolio API is faked so the old key "holds" a token; nothing is sent.
//   CHROME=<chromium> APP=http://localhost:3100 node tools/xdai-probe.mjs /tmp/shots
import { chromium } from "playwright-core";
import { generatePrivateKey } from "viem/accounts";

const APP = process.env.APP || "http://localhost:3100";
const OUT = process.argv[2] || "/tmp";
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = async ({ key, tokens = [] } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  if (key) await ctx.addInitScript(k => localStorage.getItem("metaPrivateKey") === null && sessionStorage.getItem("seeded") === null && (localStorage.setItem("metaPrivateKey", k), sessionStorage.setItem("seeded", "1")), key);
  await ctx.route("**/api/portfolio**", r =>
    r.fulfill({
      json: {
        assets: [{ chainId: 100, asset: "0x0000000000000000000000000000000000000000", symbol: "xDAI", balance: "0", formatted: "0", price: 1, usd: 0 }, ...tokens],
        totalUsd: 0,
      },
    }),
  );
  return ctx.newPage();
};
const token = { chainId: 100, asset: "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83", symbol: "USDC.e", decimals: 6, balance: "3210000", formatted: "3.21", price: 1, usd: 3.21 };
const spam = { chainId: 100, asset: "0x1111111111111111111111111111111111111111", symbol: "SPAM", decimals: 18, balance: "1", formatted: "0.000000000000000001", price: null, usd: null };

// 1. main site look unchanged; ?brand=xdai turns on the dark look, and it sticks
let p = await page();
await p.goto(`${APP}/`);
ok((await p.evaluate(() => document.documentElement.dataset.brand)) === undefined, "main site: no brand");
await p.goto(`${APP}/?brand=xdai`);
await p.waitForSelector("text=Instant Wallet");
ok((await p.evaluate(() => document.documentElement.dataset.brand)) === "xdai", "?brand=xdai: dark look on");
ok((await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(18, 18, 18)", "dark background");
await p.goto(`${APP}/`);
ok((await p.evaluate(() => document.documentElement.dataset.brand)) === "xdai", "brand sticks after reload");
await p.screenshot({ path: `${OUT}/xdai-welcome.png` });
await p.context().close();

// 2. an old Burner key holding something: the move screen, then Not now leaves the key alone
const key = generatePrivateKey();
p = await page({ key, tokens: [token, spam] });
await p.goto(`${APP}/?brand=xdai`);
await p.waitForSelector("text=Your old Burner Wallet has", { timeout: 30000 }).catch(() => {});
await p.waitForSelector("text=Also here", { timeout: 30000 }).catch(() => {}); // after every network's balance is read
const txt = await p.evaluate(() => document.body.innerText);
ok(txt.includes("Your old Burner Wallet has"), "move screen shows");
// the old key has no xDAI (the chain is real, the key is new): the token can't pay its gas, so it's listed apart
ok(/Also here: 3\.21 USDC\.e on Gnosis/.test(txt) && /send (about [\d.e-]+|a little) xDAI/.test(txt), "no gas: says what to send in");
ok(txt.includes("$0.00") || txt.includes("$0"), "stuck token not counted in the total");
ok(!txt.includes("SPAM"), "spam token left out");
await p.screenshot({ path: `${OUT}/xdai-move.png` });
await p.getByText("Not now").click().catch(() => {});
await p.waitForTimeout(500);
ok(!(await p.evaluate(() => document.body.innerText)).includes("Your old Burner Wallet has"), "Not now: on to the wallet");
ok((await p.evaluate(() => localStorage.getItem("metaPrivateKey"))) === key, "Not now: key untouched");
await p.context().close();

// 3. an old key with nothing on it: straight to the wallet, key untouched
const empty = generatePrivateKey();
p = await page({ key: empty });
await p.goto(`${APP}/?brand=xdai`);
await p.waitForTimeout(8000);
ok(!(await p.evaluate(() => document.body.innerText)).includes("Your old Burner Wallet has"), "empty key: no move screen");
ok((await p.evaluate(() => localStorage.getItem("metaPrivateKey"))) === empty, "empty key: key untouched");
await p.context().close();

// 4. the same key on the main site: never read
p = await page({ key, tokens: [token] });
await p.goto(`${APP}/?brand=`);
await p.waitForTimeout(5000);
ok(!(await p.evaluate(() => document.body.innerText)).includes("Burner"), "main site: old key not used");
await p.context().close();

// 5. old Burner links: /#<key> and /<key> open the claim
p = await page();
await p.goto(`${APP}/#${key.slice(2)}`);
await p.waitForURL("**/pk", { timeout: 15000 }).catch(() => {});
ok(new URL(p.url()).pathname === "/pk", "/#<key> → /pk");
await p.goto(`${APP}/${key}`);
await p.waitForURL("**/pk", { timeout: 15000 }).catch(() => {});
ok(new URL(p.url()).pathname === "/pk", "/0x<key> → /pk");
ok(!p.url().includes(key.slice(2)), "key out of the address bar");

// printed xdai.io cards carry the key as 43 base64url characters: /pk#<b64> opens the claim, not "broken"
await p.goto(`${APP}/pk#${Buffer.from(key.slice(2), "hex").toString("base64url")}`);
await p.waitForTimeout(3000);
ok(!(await p.evaluate(() => document.body.innerText)).includes("broken"), "/pk#<base64url key> opens the claim");

// 6. the old service worker's replacement is served
const sw = await p.request.get(`${APP}/service-worker.js`);
ok(sw.ok() && (await sw.text()).includes("unregister"), "/service-worker.js kill switch");

// 7. ?burner=new plants a test key and shows its address to fund; a second visit keeps the same key
p = await page();
await p.goto(`${APP}/?burner=new`);
await p.waitForSelector("text=Test Burner");
const planted = await p.evaluate(() => localStorage.getItem("metaPrivateKey"));
ok(/^0x[0-9a-f]{64}$/.test(planted || ""), "?burner=new plants a key");
await p.goto(`${APP}/?burner=new`);
await p.waitForSelector("text=Test Burner");
ok((await p.evaluate(() => localStorage.getItem("metaPrivateKey"))) === planted, "?burner=new keeps the same key");
await p.context().close();

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
