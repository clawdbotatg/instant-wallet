// The /pq lab page in headless Chromium with a virtual passkey that supports PRF: one tap → both signatures.
//   npx next build && npx next start -p 3199 &   then   CHROME=<chromium> node tools/pq-lab-probe.mjs [url]
import { chromium } from "playwright-core";

const URL_ = process.argv[2] ?? "http://localhost:3199/pq";
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await (await browser.newContext()).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
});
await page.goto(URL_);
await page.evaluate(() =>
  navigator.credentials.create({
    publicKey: {
      challenge: new Uint8Array(32), rp: { name: "t", id: location.hostname }, user: { id: new Uint8Array(16), name: "t", displayName: "t" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: {} },
    },
  }),
);
await page.getByText("Tap to test").click();
await page.locator(".kv, .err").first().waitFor({ timeout: 120000 });
const text = await page.locator(".app").innerText();
console.log(text);
await browser.close();
process.exit(/Total/.test(text) ? 0 : 1);
