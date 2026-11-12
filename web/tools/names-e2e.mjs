// A public name through the real UI with a virtual passkey: make a wallet, tap its title, take [name].inst.eth,
// see it as the title and in the top pill, see a held-back name refused.
//   RELAY_KV_URL= RELAY_KV_TOKEN= npx next dev -p 3111 &
//   CHROME=<chromium> node tools/names-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";

const APP = process.env.APP || "http://localhost:3111";
const OUT = process.argv[2] || "/tmp";
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

await page.goto(`${APP}/`);
await page.getByText("Create wallet").tap();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 30000 });
const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
console.log("wallet", acct.address);

const tag = Math.random().toString(36).slice(2, 7);
const label = `my-wallet-${tag}`;
await page.locator(".pill.me").tap();
const title = page.getByRole("button", { name: /^Rename / });
await title.waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/n1-receive.png` });
await title.tap();
const box = page.getByPlaceholder("name", { exact: true });
const save = page.getByRole("button", { name: "Save" });

await box.fill("support");
await page.getByText("Taken", { exact: true }).waitFor({ timeout: 5000 });
ok(await save.isDisabled(), "support: Taken, Save is off");
await box.fill("ab");
ok(await page.getByText("3 or more letters").isVisible(), "ab: 3 or more letters");

await box.fill(`My Wallet ${tag}`);
ok((await box.inputValue()) === label, `"My Wallet ${tag}" is typed as ${label}`);
await page.locator("form .btn-green:not([disabled])").waitFor({ timeout: 8000 }); // it asked, and the name is free
await page.screenshot({ path: `${OUT}/n2-typing.png` });
await save.tap();
await page.getByRole("button", { name: `Rename ${label}.inst.eth` }).waitFor({ timeout: 20000 });
ok(true, `the title is ${label}.inst.eth`);
await page.screenshot({ path: `${OUT}/n3-named.png` });

const got = await fetch(`${APP}/api/ens?name=${label}.inst.eth`).then(r => r.json());
ok(got.address?.toLowerCase() === acct.address.toLowerCase(), "the name looks up to this wallet");

// the box starts from the name it has; Cancel leaves it
await page.getByRole("button", { name: /^Rename / }).tap();
ok((await box.inputValue()) === label, "the box starts from its name");
await page.getByRole("button", { name: "Cancel" }).tap();

await page.reload();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 30000 });
await page.locator(".pill.me", { hasText: `${label}.inst.eth` }).waitFor({ timeout: 20000 });
ok(true, "after a reload the top pill shows the name");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/n4-home.png` });

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
