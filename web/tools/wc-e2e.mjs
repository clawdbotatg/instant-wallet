// WalletConnect end to end: a fake dapp (sign-client, real WalletConnect relay) connects to the wallet in a
// headless browser with a virtual passkey, then asks: capabilities, personal_sign (checked on Base with
// ERC-1271/6492), and a 2-call wallet_sendCalls (the card must show both steps; rejected, so nothing is spent).
//   APP=http://localhost:3100 CHROME=<chromium> node tools/wc-e2e.mjs <outdir>
import { chromium } from "playwright-core";
import { SignClient } from "@walletconnect/sign-client";
import { createPublicClient, encodeFunctionData, erc20Abi, http } from "viem";
import { base } from "viem/chains";

const APP = process.env.APP || "http://localhost:3100";
const OUT = process.argv[2] || ".";
const PROJECT_ID = process.env.WC_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ok = (c, m) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || (process.exitCode = 1));

const dapp = await SignClient.init({
  projectId: PROJECT_ID,
  metadata: { name: "WC probe", description: "test dapp", url: "https://probe.example", icons: [] },
});
const { uri, approval } = await dapp.connect({
  optionalNamespaces: {
    eip155: {
      chains: ["eip155:8453"],
      methods: ["personal_sign", "wallet_sendCalls", "wallet_getCapabilities", "eth_sendTransaction"],
      events: ["chainChanged", "accountsChanged"],
    },
  },
});

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
});
await page.goto(APP);
await page.getByText("Create wallet").tap();
await page.waitForFunction(() => !!localStorage.getItem("iw3.account"), null, { timeout: 30000 });
const address = (await page.evaluate(() => JSON.parse(localStorage.getItem("iw3.account")))).address;

await page.waitForTimeout(3000); // let WalletConnectLayer (mounted by App) start listening
await page.evaluate(u => window.dispatchEvent(new CustomEvent("iw:walletconnect", { detail: u })), uri);
await page.getByText("Connect?").waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/wc-1-connect.png` });
await page.getByRole("button", { name: "Connect", exact: true }).click();
const session = await approval();
ok(session.namespaces.eip155.accounts.some(a => a.toLowerCase().endsWith(address.toLowerCase())), "dapp sees the wallet address");
const ask = (method, params) => dapp.request({ topic: session.topic, chainId: "eip155:8453", request: { method, params } });

const caps = await ask("wallet_getCapabilities", [address, ["0x2105"]]);
ok(caps?.["0x2105"]?.atomic?.status === "supported", "wallet_getCapabilities: atomic supported on Base");

const message = "Sign in to probe.example";
const sigP = ask("personal_sign", [`0x${Buffer.from(message).toString("hex")}`, address]);
await page.getByText("Sign this?").waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/wc-2-sign.png` });
await page.getByText("Approve with Face ID").click();
const signature = await sigP;
const pc = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC || "https://mainnet.base.org") });
ok(await pc.verifyMessage({ address, message, signature }), "personal_sign verifies on Base (ERC-1271 via ERC-6492, wallet not deployed)");

const calls = [
  { to: USDC, value: "0x0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x000000000000000000000000000000000000dEaD", 5_000_000n] }) },
  { to: "0x000000000000000000000000000000000000dEaD", value: "0x0", data: "0x12345678" },
];
const sendP = ask("wallet_sendCalls", [{ version: "2.0.0", chainId: "0x2105", from: address, atomicRequired: true, calls }]).then(
  () => "approved",
  e => e,
);
await page.getByText("2 steps, one Face ID").waitFor({ timeout: 30000 });
ok(await page.getByText("5 USDC").isVisible(), "batch card decodes the USDC approve");
await page.screenshot({ path: `${OUT}/wc-3-calls.png` });
await page.getByText("Reject", { exact: true }).click();
const r = await sendP;
ok(r?.code === 4001 || /reject/i.test(r?.message || ""), "reject answers the dapp with 4001");

await browser.close();
await dapp.core.relayer.transportClose().catch(() => {});
process.exit();
