// Safe Apps in our frame (lib/safeapps.ts), on a Base fork: Apps → paste a probe app's link → it speaks the raw
// Safe Apps SDK protocol to us, the way @safe-global/safe-apps-sdk does:
//   getSafeInfo under wagmi's 10 ms        getChainInfo, rpcCall (balance through our RPC)
//   sendTransactions: approve + transfer   → one card, Face ID, relayed; { safeTxHash } is the tx; checked on chain
//   getTxBySafeTxHash                       → SUCCESS + the same hash (safe-apps-provider finds the receipt by it)
//   signMessage                             → ERC-1271/6492 signature, checked on the fork
//   a call into the wallet itself           → refused on the card, the app gets an error
// Same setup as safe-e2e.mjs (anvil fork + next dev on 3100 with RELAYER_PRIVATE_KEY funded).
//   CHROME=<chromium> node tools/safe-apps-e2e.mjs /tmp/shots
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import http from "node:http";
import { createPublicClient, encodeFunctionData, erc20Abi, http as viemHttp } from "viem";
import { base } from "viem/chains";

const APP = process.env.APP || "http://localhost:3100";
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OUT = process.argv[2] || "/tmp";
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const usdcOf = a => BigInt(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`).split(" ")[0]);
const setUsdc = (who, amt) => cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${who} 9`, { encoding: "utf8" }).trim()} 0x${amt.toString(16).padStart(64, "0")}`);
const pc = createPublicClient({ chain: base, transport: viemHttp(RPC) });
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
const rand = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");

// the probe app: the SDK's wire format, nothing else
const PROBE = `<!doctype html><meta charset="utf-8"><title>Probe</title><body>probe<script>
const pending = {}; let n = 0;
addEventListener("message", e => { if (e.source !== parent) return; const d = e.data; if (d && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } });
window.call = (method, params = {}) => new Promise(r => { const id = "p" + ++n; pending[id] = r; parent.postMessage({ id, method, params, env: { sdkVersion: "9.1.0" } }, "*"); });
window.timed = async () => { const t = performance.now(); const r = await call("getSafeInfo"); return { ms: performance.now() - t, r }; };
</script>`;
const server = http.createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PROBE)).listen(5199);

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
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

await page.getByRole("button", { name: "Apps" }).click();
await page.getByText("Earn interest on USDC").waitFor({ timeout: 10000 });
await page.screenshot({ path: `${OUT}/apps-1-list.png` });
ok((await page.getByRole("button", { name: "Swap", exact: false }).count()) > 0, "the Apps sheet lists Swap");
await page.getByLabel("Safe App link").fill("http://localhost:5199/");
await page.getByRole("button", { name: "Open", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".appframe iframe"), null, { timeout: 20000 });
let frame;
for (let i = 0; i < 100 && !frame; i++) {
  frame = page.frames().find(f => f.url().startsWith("http://localhost:5199"));
  if (!frame) await page.waitForTimeout(100);
}
await frame.waitForFunction(() => typeof window.call === "function");

const t = await frame.evaluate(() => timed());
ok(t.r.success && t.r.version && t.r.data.safeAddress === safe && t.r.data.chainId === 8453, `getSafeInfo: the Safe on Base`);
ok(t.ms < 10, `getSafeInfo answered in ${t.ms.toFixed(1)} ms (wagmi waits 10)`);
const ci = await frame.evaluate(() => call("getChainInfo"));
ok(ci.data?.chainId === "8453", "getChainInfo: Base");
const bal = await frame.evaluate(
  ([u, s]) => call("rpcCall", { call: "eth_call", params: [{ to: u, data: "0x70a08231000000000000000000000000" + s.slice(2) }, "latest"] }),
  [USDC, safe],
);
ok(BigInt(bal.data) === 20_000_000n, "rpcCall eth_call: 20 USDC through our RPC");
const bad = await frame.evaluate(() => call("rpcCall", { call: "eth_sendRawTransaction", params: ["0x00"] }));
ok(!bad.success, "rpcCall refuses a write");

// two calls, one card
const spender = rand(), to = rand();
const txs = [
  { to: USDC, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 5_000_000n] }) },
  { to: USDC, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1_000_000n] }) },
];
const sent = frame.evaluate(txs => call("sendTransactions", { txs }), txs);
await page.getByText("2 steps, all or nothing").waitFor({ timeout: 30000 });
await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/apps-2-calls.png` });
await page.getByRole("button", { name: "Approve", exact: true }).click();
const res = await sent;
const hash = res.data?.safeTxHash;
ok(res.success && /^0x[0-9a-f]{64}$/i.test(hash), `sendTransactions → { safeTxHash: ${hash?.slice(0, 10)}… }`);
await pc.waitForTransactionReceipt({ hash });
const allowance = BigInt(cast(`call ${USDC} "allowance(address,address)(uint256)" ${safe} ${spender}`).split(" ")[0]);
ok(allowance === 5_000_000n && usdcOf(to) === 1_000_000n, "both calls landed: allowance 5 USDC, 1 USDC sent");
const tx = await frame.evaluate(h => call("getTxBySafeTxHash", { safeTxHash: h }), hash);
ok(tx.data?.txStatus === "SUCCESS" && tx.data?.txHash === hash, `getTxBySafeTxHash: ${tx.data?.txStatus}`);

// a message
const msg = "Sign in to the probe";
const signed = frame.evaluate(m => call("signMessage", { message: m }), msg);
await page.getByText("Sign this?").waitFor({ timeout: 30000 });
await page.getByRole("button", { name: "Sign", exact: true }).click();
const sig = await signed;
ok(sig.success && (await pc.verifyMessage({ address: safe, message: msg, signature: sig.data.signature }).catch(() => false)), "signMessage: valid for the Safe");

// into the wallet itself: refused
const evil = frame.evaluate(s => call("sendTransactions", { txs: [{ to: s, value: "0", data: "0xe19a9dd9" + "0".repeat(64) }] }), safe);
await page.getByText("A site can't change your wallet's keys or settings.").waitFor({ timeout: 30000 });
ok((await page.getByRole("button", { name: "Approve", exact: true }).count()) === 0, "a call into the wallet: no Approve button");
await page.getByRole("button", { name: "Reject", exact: true }).click();
ok(!(await evil).success, "the app gets the rejection");
await page.screenshot({ path: `${OUT}/apps-3-frame.png` });

await page.getByRole("button", { name: "Close", exact: true }).click();
ok((await page.locator(".appframe").count()) === 0, "Close leaves the app");

await browser.close();
server.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
