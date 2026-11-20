// The local copy end to end (README: "Run it fully local"), on a Base fork: https://local.instantwallet.io:9443 with
// the run-local.sh certificate, a passkey made for instantwallet.io (virtual, like a phone's), a send through your
// own relay and one from your browser wallet. Run ./run-local.sh once first (certificate, hosts line, build).
//
//   cd web && node tools/local-e2e.mjs [shots dir]
//
// Starts its own anvil (Base fork, port 8546), app (port 3101, the build run-local.sh made) and https (9443), and
// stops them at the end. Your running copy on 443 is not touched. Needs ALCHEMY_API_KEY in web/.env.local.
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "local-e2e-"));
const DIR = path.join(os.homedir(), ".instantwallet-local");
const NAME = "local.instantwallet.io";
const APP = `https://${NAME}:9443`;
const RPC = "http://127.0.0.1:8546";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// a fresh relay key each run (funded on the fork below, never saved), and anvil's first unlocked account as the "MetaMask"
const RELAY_KEY = generatePrivateKey();
const relay = privateKeyToAccount(RELAY_KEY).address;
let hot;

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]),
);
if (!env.ALCHEMY_API_KEY) throw new Error("ALCHEMY_API_KEY missing in web/.env.local");
if (!fs.existsSync(path.join(DIR, `${NAME}.pem`))) throw new Error("Run ./run-local.sh once first (certificate)");
if (!fs.existsSync(".next/BUILD_ID")) throw new Error("No build: run ./run-local.sh once first");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
const cast = a => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const num = s => BigInt(s.split(" ")[0]);
const usdcOf = a => num(cast(`call ${USDC} "balanceOf(address)(uint256)" ${a}`));
const ethOf = a => BigInt(cast(`balance ${a}`));
const rand = () => "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");
const up = async (url, s = 90) => {
  for (let i = 0; i < s; i++) {
    if (await fetch(url, { method: url === RPC ? "POST" : "GET", headers: { "content-type": "application/json" }, body: url === RPC ? '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' : undefined }).then(r => r.ok, () => false)) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`${url} never came up`);
};

// ---- anvil, the app, https
const kids = [];
const run = (cmd, args, extra = {}) => {
  const k = spawn(cmd, args, { env: { ...process.env, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
  k.stderr.on("data", d => process.env.VERBOSE && process.stderr.write(d));
  kids.push(k);
  return k;
};
const stop = () => kids.forEach(k => k.kill());
process.on("exit", stop);
process.on("SIGINT", () => process.exit(1));

run("anvil", ["--fork-url", `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`, "--network", "optimism", "--port", "8546", "--silent"]); // optimism: Base's P-256 precompile (the passkey check)
await up(RPC);
hot = JSON.parse(cast("rpc eth_accounts"))[0];
// the relay starts empty: the first send opens Fund your relay, and the "MetaMask" funds it there
const store = path.join(OUT, "store.json");
run("npx", ["next", "start", "-p", "3101"], {
  RPC_URL_8453: RPC,
  RELAYER_PRIVATE_KEY: RELAY_KEY,
  KV_FILE: store,
  LOCAL_TOKENS_ONLY: "1",
  LOCAL_TOKENS: USDC,
});
run("npx", ["-y", "local-ssl-proxy@2.0.5", "--source", "9443", "--target", "3101", "--cert", path.join(DIR, `${NAME}.pem`), "--key", path.join(DIR, `${NAME}-key.pem`)]);
await up("http://127.0.0.1:3101/api/version");
// checked against the mkcert root, as Chrome does through the Mac's keychain
for (let i = 0; ; i++) {
  try {
    execSync(`curl -sf -o /dev/null --cacert "$(mkcert -CAROOT)/rootCA.pem" ${APP}/api/version`);
    break;
  } catch {
    if (i > 30) throw new Error(`${APP} unreachable: is ${NAME} in /etc/hosts, and the certificate trusted? (./run-local.sh)`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ---- a browser: a virtual passkey, and a "MetaMask" (EIP-6963) whose sends go to the fork as anvil #1
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.exposeFunction("__fork", async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
});
await ctx.addInitScript(who => {
  const provider = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [who];
      if (method === "eth_chainId") return "0x2105";
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_sendTransaction") return window.__fork("eth_sendTransaction", [{ ...params[0], from: who }]); // anvil's accounts are unlocked
      return window.__fork(method, params || []);
    },
  };
  const info = { uuid: "00000000-0000-4000-8000-000000000001", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, hot);
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror", e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

try {
  // ---- a new wallet; its passkey belongs to instantwallet.io, so it opens on the real site too
  await page.goto(`${APP}/`);
  ok(await page.getByText("Run it on your own computer").isVisible(), "welcome page links to the guide");
  await page.getByText("Create wallet").tap();
  await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 30000 });
  const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  ok(creds.length === 1 && creds[0].rpId === "instantwallet.io", `passkey made for instantwallet.io (got ${creds.map(c => c.rpId)})`);
  const acct = await page.evaluate(() => JSON.parse(localStorage.getItem("iws.account")));
  console.log("wallet", acct.address);

  // ---- money on the fork: USDC (balance slot 9) and ETH; the relay and the "MetaMask" have anvil's ETH already
  cast(`rpc anvil_setStorageAt ${USDC} ${execSync(`cast index address ${acct.address} 9`, { encoding: "utf8" }).trim()} 0x${(500_000_000n).toString(16).padStart(64, "0")}`);
  cast(`rpc anvil_setBalance ${acct.address} 0x2386f26fc10000`); // 0.01 ETH
  await page.reload();
  await page.locator(".asset", { has: page.locator(".sym", { hasText: /^USDC$/ }) }).first().waitFor({ timeout: 30000 });

  const review = async (sym, to, amount) => {
    await page.locator(".asset", { has: page.locator(".sym", { hasText: new RegExp(`^${sym}$`) }) }).first().tap();
    await page.getByPlaceholder("0x… or name.eth").fill(to);
    await page.locator("input.amount").fill(amount);
    await page.getByText("Review").tap();
    await page.locator(".confirm .btn-green").waitFor({ timeout: 20000 });
    await page.waitForTimeout(2000); // the quote
  };
  const executed = async shot => {
    await page.getByRole("heading", { name: "Executed", exact: true }).waitFor({ timeout: 90000 }).catch(async e => {
      console.log("on screen:", await page.locator(".err").allTextContents());
      await page.screenshot({ path: `${OUT}/${shot}-error.png` });
      throw e;
    });
    await page.screenshot({ path: `${OUT}/${shot}-sent.png` });
    await page.getByText("Done").tap();
    await page.waitForTimeout(3000);
  };

  // ---- 1. through your own relay: it deploys the wallet, sends, and is paid the fee
  const BOB = rand();
  const r0 = usdcOf(relay);
  // ---- 0. the relay is empty: Review opens Fund your relay. Closed, the error line has the button that opens it again.
  // Funded from the browser wallet, it closes itself and the fee is there to sign
  await review("USDC", BOB, "25");
  const fund = page.getByRole("heading", { name: "Fund your relay", exact: true });
  ok(await fund.isVisible(), "an empty relay: Review opens Fund your relay");
  ok(await page.locator(".sheet .qr img.code").last().isVisible(), "it shows the relay's address as a QR code");
  ok(/It has\s*0 ETH/.test(await page.locator(".sheet").last().innerText()), "it says what the relay has: 0 ETH");
  await page.screenshot({ path: `${OUT}/0-fund.png` });
  await page.keyboard.press("Escape");
  await fund.waitFor({ state: "hidden", timeout: 5000 });
  ok(await page.getByRole("button", { name: "Sign", exact: true }).isDisabled(), "closed unfunded: nothing to sign");
  const again = page.getByRole("button", { name: "Fund your relay" });
  ok(await again.isVisible(), "the error line has a Fund your relay button");
  await page.screenshot({ path: `${OUT}/0-closed.png` });
  await again.tap();
  await fund.waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /^Send \$[0-9.]+ from my wallet$/ }).tap();
  await fund.waitFor({ state: "hidden", timeout: 30000 });
  ok(ethOf(relay) > 0n, `the browser wallet funded the relay: ${Number(ethOf(relay)) / 1e18} ETH`);
  await page.locator(".confirm .btn-green:not([disabled])").waitFor({ timeout: 20000 });
  ok((await page.locator(".err").count()) === 0, "funded: the sheet closed itself, the fee is there, no error left");
  await page.screenshot({ path: `${OUT}/1-review.png` });
  cast(`rpc anvil_setBalance ${relay} 0x8ac7230489e80000`); // 10 ETH: anvil wants a whole block's gas in the bank to estimate
  await page.locator(".confirm .btn-green").tap();
  await executed("1");
  ok(usdcOf(BOB) === 25_000_000n, "relay send arrived (deploy + send)");
  ok(cast(`code ${acct.address}`).length > 4, "the wallet is deployed");
  ok(usdcOf(relay) > r0, `your relay was paid its fee: ${Number(usdcOf(relay) - r0) / 1e6} USDC`);

  // ---- 2. from your browser wallet: no relay, no fee
  const CAROL = rand();
  const u0 = usdcOf(acct.address), h0 = ethOf(hot), rl0 = usdcOf(relay);
  await review("USDC", CAROL, "10");
  const mine = page.getByText("Execute from my wallet");
  ok(await mine.isVisible(), "the dark gray Execute from my wallet button is there");
  await mine.tap();
  await executed("2");
  ok(usdcOf(CAROL) === 10_000_000n, "browser-wallet send arrived");
  ok(u0 - usdcOf(acct.address) === 10_000_000n, "no fee taken from the wallet");
  ok(usdcOf(relay) === rl0, "the relay wasn't used");
  ok(ethOf(hot) < h0, "the browser wallet paid the gas");

  // ---- 2b. the relay runs dry: Fund your relay has Execute from my wallet, and that executes it with no relay
  const ERIN = rand();
  cast(`rpc anvil_setBalance ${relay} 0x0`);
  await review("USDC", ERIN, "3");
  await fund.waitFor({ timeout: 5000 });
  const dark = page.locator(".sheet").last().getByText("Execute from my wallet");
  ok(await dark.isVisible(), "Fund your relay has the dark gray Execute from my wallet button");
  await page.screenshot({ path: `${OUT}/2b-fund.png` });
  await dark.tap();
  await executed("2b");
  ok(usdcOf(ERIN) === 3_000_000n, "from Fund your relay: the browser wallet executed it");
  ok(ethOf(relay) === 0n, "the empty relay wasn't used");
  cast(`rpc anvil_setBalance ${relay} 0x8ac7230489e80000`);

  // ---- 3. Settings: your relay, and what's off here
  await page.goto(`${APP}/`);
  await page.getByText("Deposit", { exact: true }).waitFor({ timeout: 30000 });
  // asked from the page (the browser trusts the certificate; this script's Node doesn't)
  const ask = (url, body) => page.evaluate(([u, b]) => fetch(u, b ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : {}).then(r => r.json()), [url, body]);
  const words = await ask("/api/explain", { chain: 8453, safe: acct.address, calls: [{ to: acct.address, value: "0", data: "0x0d582f13" + "0".repeat(24) + "3".repeat(40) + "0".repeat(63) + "2" }] });
  ok(words.calls?.[0]?.what === "Add owner", `tx words on the local copy (${words.calls?.[0]?.what})`);
  const relayInfo = await ask("/api/local/relay");
  ok(relayInfo.address?.toLowerCase() === relay.toLowerCase(), "Your relay shows the relay's address");
  ok(fs.existsSync(store) && fs.readFileSync(store, "utf8").length > 2, "the store is kept in a file");

  // ---- 4. Settings → No external traffic: a send through your relay, and nothing leaves but calls to your node
  const set = await ask("/api/local/noext", { on: true });
  ok(set.on === true && set.chains?.includes(8453), `No external traffic is on, Base has your node (${JSON.stringify(set)})`);
  const out = new Set(); // the page's requests to anywhere but this copy
  page.on("request", r => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && u.hostname !== NAME) out.add(u.hostname);
  });
  // the server: its connections to anywhere but this computer, sampled while it works
  const pid = execSync("lsof -ti tcp:3101 -sTCP:LISTEN", { encoding: "utf8" }).trim().split("\n")[0];
  const far = new Set();
  const watch = setInterval(() => {
    try {
      for (const l of execSync(`lsof -a -p ${pid} -i -n -P`, { encoding: "utf8" }).split("\n")) {
        const m = l.match(/->(\[?[0-9a-f.:]+\]?):(\d+)/i);
        if (m && !/^(127\.|\[?::1\]?$)/.test(m[1])) far.add(`${m[1]}:${m[2]}`);
      }
    } catch {}
  }, 150);
  await new Promise(r => setTimeout(r, 8000)); // connections kept open from before close
  far.clear();
  await page.goto(`${APP}/`);
  await page.waitForTimeout(4000); // the page learns it's on and reloads once
  await page.locator(".asset", { has: page.locator(".sym", { hasText: /^USDC$/ }) }).first().waitFor({ timeout: 30000 });
  const DAVE = rand();
  await review("USDC", DAVE, "5");
  await page.screenshot({ path: `${OUT}/4-review.png` });
  await page.locator(".confirm .btn-green").tap();
  await executed("4");
  clearInterval(watch);
  ok(usdcOf(DAVE) === 5_000_000n, "No external traffic: relay send arrived");
  ok(out.size === 0, `No external traffic: the page asked nothing outside (${[...out].join(", ") || "none"})`);
  ok(far.size === 0, `No external traffic: the server connected nowhere outside (${[...far].join(", ") || "none"})`);
} catch (e) {
  fails++;
  console.log("FAIL", e.message.split("\n")[0]);
  await page.screenshot({ path: `${OUT}/error.png` }).catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `${fails} failed (shots: ${OUT})` : `all passed (shots: ${OUT})`);
process.exit(fails ? 1 : 0);
