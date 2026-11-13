// WalletConnect on the Safe wallet, on a Base fork: the wallet's own scan button reads a site's wc: QR (a fake
// camera shows it), the site (sign-client, the real WalletConnect relay) connects at once (the scan was the yes) and asks:
//   personal_sign before the Safe exists   → ERC-6492, checked on the fork
//   wallet_sendCalls: approve + transfer   → one card, Face ID, the relay sends it; checked on chain
//   personal_sign / signTypedData after    → plain ERC-1271, checked on the fork
//   a call into the wallet itself          → refused on the card
// Same setup as safe-e2e.mjs (anvil fork + next dev on 3100 with RELAYER_PRIVATE_KEY funded); needs ffmpeg.
//   CHROME=<chromium> node tools/safe-wc-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import QRCode from "qrcode";
import { SignClient } from "@walletconnect/sign-client";
import { createPublicClient, encodeFunctionData, erc20Abi, http } from "viem";
import { base } from "viem/chains";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OUT = process.argv[2] || "/tmp";
const PROJECT_ID = process.env.WC_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const usdcOf = a => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`).split(" ")[0]);
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
const pc = createPublicClient({ chain: base, transport: http(RPC) });
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
const rand = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");

// the site
const dapp = await SignClient.init({
  projectId: PROJECT_ID,
  metadata: { name: "WC probe", description: "test dapp", url: "https://probe.example", icons: [] },
});
const { uri, approval } = await dapp.connect({
  optionalNamespaces: {
    eip155: {
      chains: ["eip155:8453"],
      methods: ["personal_sign", "eth_signTypedData_v4", "wallet_sendCalls", "wallet_getCallsStatus", "wallet_getCapabilities", "eth_sendTransaction"],
      events: ["chainChanged", "accountsChanged"],
    },
  },
});

// its QR, in front of a fake camera
const png = `${OUT}/wc-qr.png`, vid = `${OUT}/wc-qr.y4m`;
await QRCode.toFile(png, uri, { width: 480, margin: 4 });
execSync(`ffmpeg -y -loglevel error -loop 1 -i ${png} -vf "scale=360:360,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p" -t 3 -r 10 ${vid}`);

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

await page.goto(`${APP}/`);
await page.getByText("Create wallet").click();
await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 20000 });
const safe = (await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")))).address;
setUsdc(safe, 20_000_000n);
await page.waitForTimeout(3000); // the connect layer starts listening

// scan the site's QR with the wallet's own scan button
// (the scan itself is the Send sheet's now; this is what it does with a wc: code it reads)
await page.evaluate(u => window.dispatchEvent(new CustomEvent("iw:walletconnect", { detail: u })), uri);
const session = await approval(); // the scan was the yes: no question
await page.getByText("Connected to WC probe").waitFor({ timeout: 10000 });
await page.screenshot({ path: `${OUT}/wc-1-connected.png` });
ok(session.namespaces.eip155.accounts.some(a => a.toLowerCase() === `eip155:8453:${safe.toLowerCase()}`), "scan → connected at once: the site sees the Safe on Base");
const ask = (method, params) => dapp.request({ topic: session.topic, chainId: "eip155:8453", request: { method, params } });

const caps = await ask("wallet_getCapabilities", [safe, ["0x2105"]]);
ok(caps?.["0x2105"]?.atomic?.status === "supported", "wallet_getCapabilities: atomic on Base");

async function sign(method, params, verify, what) {
  const p = ask(method, params);
  await page.getByText("Sign this?").waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${OUT}/wc-sign-${what.replace(/\W+/g, "-")}.png` });
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  const sig = await p;
  ok(await verify(sig).catch(e => (console.log(e.shortMessage || e.message), false)), what);
}

const msg1 = "Sign in to probe.example";
ok(cast(`code ${safe}`) === "0x", "the Safe isn't deployed yet");
await sign("personal_sign", [`0x${Buffer.from(msg1).toString("hex")}`, safe], sig => pc.verifyMessage({ address: safe, message: msg1, signature: sig }), "personal_sign before deploy: valid (ERC-6492)");

// two calls, one card: an approve to a random spender (not a known router: a site's call) + a transfer
const spender = rand(), to = rand();
const calls = [
  { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 5_000_000n] }), value: "0x0" },
  { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1_000_000n] }), value: "0x0" },
];
const sendP = ask("wallet_sendCalls", [{ version: "2.0.0", chainId: "0x2105", from: safe, atomicRequired: true, calls }]);
await page.getByRole("button", { name: "Sign", exact: true }).waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
const batchCard = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: `${OUT}/wc-2-calls.png` });
// audit 11-13: an approval that outlives the batch is on the card, whatever else the batch does
ok(/spend up to 5 USDC/.test(batchCard) && /Send\s+Amount: 1 USDC/.test(batchCard), "approve + transfer: the card says both");
await page.getByRole("button", { name: "Sign", exact: true }).click();
const res = await sendP;
ok(/^0x[0-9a-f]{64}$/i.test(res?.id), `wallet_sendCalls answered with the tx (${res?.id?.slice(0, 10)}…)`);
const allowance = BigInt(cast(`call ${USDC} "allowance(address,address)(uint256)" ${safe} ${spender}`).split(" ")[0]);
ok(allowance === 5_000_000n && usdcOf(to) === 1_000_000n, "both calls landed: allowance 5 USDC, 1 USDC sent");
ok(cast(`code ${safe}`) !== "0x", "the first site call deployed the Safe");
const status = await ask("wallet_getCallsStatus", [res.id]);
ok(status?.status === 200, `wallet_getCallsStatus: ${status?.status}`);

const msg2 = "Second sign-in";
await sign("personal_sign", [`0x${Buffer.from(msg2).toString("hex")}`, safe], sig => pc.verifyMessage({ address: safe, message: msg2, signature: sig }), "personal_sign after deploy: valid (ERC-1271)");
const typed = {
  domain: { name: "Probe", version: "1", chainId: 8453, verifyingContract: USDC },
  types: { Mail: [{ name: "contents", type: "string" }] },
  primaryType: "Mail",
  message: { contents: "hello" },
};
await sign(
  "eth_signTypedData_v4",
  [safe, JSON.stringify({ ...typed, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...typed.types } })],
  sig => pc.verifyTypedData({ address: safe, ...typed, signature: sig }),
  "eth_signTypedData_v4: valid (ERC-1271)",
);

// audit 11-13: a token's permit is typed data too, and the Safe's signature is good for it. The card says who may
// spend what, in red, never "moves no money"; a key the types don't name isn't shown. Then the spender uses it.
const taker = rand();
const deadline = Math.floor(Date.now() / 1000) + 3600;
const permitTypes = { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const permit = {
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  types: permitTypes,
  primaryType: "Permit",
  message: { owner: safe, spender: taker, value: "3000000", nonce: Number(cast(`call ${USDC} "nonces(address)(uint256)" ${safe}`).split(" ")[0]), deadline },
};
const permitP = ask("eth_signTypedData_v4", [safe, JSON.stringify({ ...permit, message: { ...permit.message, note: "Free refund, moves no money" } })]);
await page.getByText("Sign this?").waitFor({ timeout: 30000 });
await page.locator("[data-typed-warn]").first().waitFor({ timeout: 10000 });
const card = await page.evaluate(() => document.body.innerText);
const red = await page.locator("[data-typed-warn]").first().innerText();
await page.screenshot({ path: `${OUT}/wc-permit.png` });
ok(/^Let .* spend up to 3 USDC$/.test(red.replace(/\s+/g, " ").trim()), `a USDC permit's card says it in red: "${red.replace(/\s+/g, " ").trim()}"`);
ok(!/moves no money/i.test(card) && !/refund/i.test(card), "…never 'moves no money', and the site's extra line isn't shown");
await page.getByRole("button", { name: "Sign", exact: true }).click();
const permitSig = await permitP;
const before = usdcOf(taker);
cast(`rpc anvil_setBalance ${taker} 0x16345785D8A0000`);
cast(`rpc anvil_impersonateAccount ${taker}`);
const sendAs = a => execSync(`cast send ${a} --from ${taker} --unlocked --rpc-url ${RPC}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let took = "";
try {
  sendAs(`${USDC} "permit(address,address,uint256,uint256,bytes)" ${safe} ${taker} 3000000 ${deadline} ${permitSig}`);
  sendAs(`${USDC} "transferFrom(address,address,uint256)" ${safe} ${taker} 3000000`);
} catch (e) {
  took = String(e.stderr || e.message).slice(0, 300);
}
// it works: that's why the card is red (if USDC ever refuses a Safe's signature here, this line says so)
ok(usdcOf(taker) - before === 3_000_000n, `the signature is a real USDC permit: the spender took 3 USDC with it, no transaction from the wallet ${took}`);

// a site asking the wallet to change itself: refused on the card
const evilP = ask("eth_sendTransaction", [{ from: safe, to: safe, data: "0xe19a9dd9" + "0".repeat(64), value: "0x0" }]).catch(e => e);
await page.getByText("A site can't change your wallet's keys or settings.").waitFor({ timeout: 30000 });
ok((await page.getByRole("button", { name: "Sign", exact: true }).count()) === 0, "a call into the wallet itself: refused, no Sign button");
await page.screenshot({ path: `${OUT}/wc-3-refused.png` });
await page.getByRole("button", { name: "Reject", exact: true }).click();
const evil = await evilP;
ok(evil instanceof Error || evil?.message, "the site gets a rejection");

await browser.close();
await dapp.core.relayer.transportClose().catch(() => {});
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
