// A tx link that adds a signer shows it in red (audit 11-13: "Add signer 0x…" read as plain text; a signer owns
// the wallet). Opens /tx/<chain>/<safe>#<code> for a real Safe, as anyone sent a link would, and reads the card.
// Needs the app running (next dev -p 3100); reads the chain only.
//   CHROME=<chromium> node tools/link-warn-e2e.mjs [/tmp/shots]
import { chromium } from "playwright-core";

const APP = process.env.APP || "http://localhost:3100";
const OUT = process.argv[2];
// a real Safe on Base (the page reads its signers); nothing is signed or sent
const safe = process.env.SAFE || "0xcf589969582dd70544978114c9e5521f61fbe8e5", attacker = "0x2222222222222222222222222222222222222222", Z = "0x" + "0".repeat(40);
const W = x => String(x).replace(/^0x/, "").padStart(64, "0");
let fails = 0;
const ok = (c, m) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);
const link = (to, data) => {
  const t = { to, value: "0", data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce: "100000" };
  return `${APP}/tx/8453/${safe}#${Buffer.from(JSON.stringify({ t, s: [] })).toString("base64url")}`;
};
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
const card = async (name, url) => {
  await page.goto("about:blank");
  await page.goto(url);
  await page.locator("[data-what]").first().waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
  if (OUT) await page.screenshot({ path: `${OUT}/link-${name}.png` });
  return (await page.locator("[data-what]").first().innerText()).replace(/\s+/g, " ");
};
let t = await card("add-signer", link(safe, "0x0d582f13" + W(attacker) + W(1)));
ok(/⚠️ ?Adds 0x2222…2222 as a signer\. Then 1 signature can move everything\./.test(t), `a link that adds a signer: the red line ("${t.slice(0, 120)}")`);
t = await card("threshold", link(safe, "0x694e80c3" + W(1)));
ok(/⚠️ ?Changes how many must sign/.test(t), `a link that changes how many must sign: the red line ("${t.slice(0, 120)}")`);
t = await card("send", link(attacker, "0x"));
ok(!/⚠️/.test(t) || !/signer|must sign/.test(t), `a plain link: no signer warning ("${t.slice(0, 120)}")`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
