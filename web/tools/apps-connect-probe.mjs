// Which listed apps connect in our frame: open each from Apps, log the Safe Apps methods it asks for, look for the
// Safe's address in its page. Same setup as safe-apps-e2e.mjs.   CHROME=<chromium> node tools/apps-connect-probe.mjs /tmp/shots
import { chromium } from "playwright-core";
const APP = process.env.APP || "http://localhost:3100";
const OUT = process.argv[2] || "/tmp";
const NAMES = (process.env.APPS || "Aerodrome,Morpho").split(","); // names in the list, or links
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await page.goto(`${APP}/`);
await page.getByText("Create wallet").click();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 20000 });
const safe = (await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")))).address;
await page.evaluate(() => {
  window.__seen = [];
  addEventListener("message", e => e.data?.method && e.data?.env && window.__seen.push(e.data.method === "rpcCall" ? `rpc:${e.data.params?.call}` : e.data.method));
});
for (const name of NAMES) {
  await page.evaluate(() => (window.__seen = []));
  await page.getByRole("button", { name: "Apps" }).click();
  if (name.startsWith("http")) {
    await page.getByLabel("Safe App link").fill(name);
    await page.getByRole("button", { name: "Open", exact: true }).click();
  } else await page.locator(".apps .asset", { hasText: name }).first().click();
  await page.waitForTimeout(25000);
  const seen = await page.evaluate(() => [...new Set(window.__seen)]);
  const f = page.frames().find(x => x !== page.mainFrame());
  const text = f ? await f.evaluate(() => document.body.innerText + document.body.innerHTML).catch(() => "") : "";
  const shows = text.toLowerCase().includes(safe.slice(2, 6).toLowerCase()) && text.toLowerCase().includes(safe.slice(-4).toLowerCase());
  console.log(`${name}: asked [${seen.join(", ")}] · shows the Safe: ${shows}`);
  await page.screenshot({ path: `${OUT}/connect-${name.replace(/\W+/g, "")}.png` });
  await page.getByRole("button", { name: "Close", exact: true }).click();
}
await browser.close();
