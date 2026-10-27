// Runs on every site (not Instant Wallet itself), in the extension's own world. Answers what needs no key itself
// (address, network, reads), sends the rest to the background → the Instant Wallet tab.

const KEY_METHODS = ["eth_sendTransaction", "wallet_sendCalls", "personal_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4"];
const REFUSED = ["eth_sign", "eth_signTransaction", "eth_sendRawTransaction"];
const BASE = 8453;
const origin = location.origin;
const waiting = new Map(); // id → method, for requests answered later by the wallet tab
let st = { account: null, site: {}, takeover: false };

const toPage = m => window.postMessage({ __iw: "ext", ...m }, "*");
const hex = n => `0x${Number(n).toString(16)}`;
const err = (code, message) => ({ error: { code, message } });
const chainId = () => st.site.chainId ?? BASE;
const connected = () => !!(st.site.connected && st.account);
const accounts = () => (connected() ? [st.account.address] : []);
const chains = () => st.account?.chainIds?.length ? st.account.chainIds : [BASE];

async function load() {
  const { account = null, sites = {}, takeover = false } = await chrome.storage.local.get(["account", "sites", "takeover"]);
  st = { account, site: sites[origin] ?? {}, takeover };
}

async function saveSite(patch) {
  const { sites = {} } = await chrome.storage.local.get("sites");
  sites[origin] = { ...sites[origin], ...patch };
  await chrome.storage.local.set({ sites });
}

async function handle(method, params, id) {
  switch (method) {
    case "eth_chainId":
      return { result: hex(chainId()) };
    case "net_version":
      return { result: String(chainId()) };
    case "eth_accounts":
      return { result: accounts() };
    case "eth_requestAccounts":
    case "wallet_requestPermissions": {
      const perm = [{ parentCapability: "eth_accounts" }];
      if (!st.account) return ask("eth_requestAccounts", [], id, method); // no wallet seen yet: open Instant Wallet
      if (!connected()) await saveSite({ connected: true });
      return { result: method === "wallet_requestPermissions" ? perm : [st.account.address] };
    }
    case "wallet_getPermissions":
      return { result: connected() ? [{ parentCapability: "eth_accounts" }] : [] };
    case "wallet_revokePermissions":
      await saveSite({ connected: false });
      return { result: null };
    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain": {
      const want = Number(params?.[0]?.chainId);
      if (!chains().includes(want)) return err(4902, "Instant Wallet isn't on that network");
      if (want !== chainId()) await saveSite({ chainId: want });
      return { result: null };
    }
    case "wallet_getCapabilities": {
      const caps = {};
      for (const c of chains()) caps[hex(c)] = { atomic: { status: "supported" }, atomicBatch: { supported: true } };
      return { result: caps };
    }
    case "wallet_getCallsStatus":
      return callsStatus(String(params?.[0]));
    case "wallet_showCallsStatus":
      return { result: null };
    case "web3_clientVersion":
      return { result: "InstantWallet/0.1" };
  }
  if (KEY_METHODS.includes(method)) {
    if (!connected()) return err(4100, "Connect Instant Wallet first");
    return ask(method, params, id);
  }
  if (REFUSED.includes(method)) return err(4200, `${method} is not supported`);
  if (/^(eth|net|web3)_/.test(method)) return chrome.runtime.sendMessage({ type: "rpc", chainId: chainId(), method, params });
  return err(4200, `${method} is not supported`);
}

/** Needs the wallet tab: answered later, through chrome.runtime.onMessage below. */
async function ask(method, params, id, asked = method) {
  waiting.set(id, asked);
  const r = await chrome.runtime.sendMessage({ type: "ask", id, method, params, chainId: chainId() });
  if (r?.error) return waiting.delete(id), r;
  return null; // answered later
}

async function callsStatus(hash) {
  const { calls = {} } = await chrome.storage.local.get("calls");
  const c = calls[hash] ?? chainId();
  const r = await chrome.runtime.sendMessage({ type: "rpc", chainId: c, method: "eth_getTransactionReceipt", params: [hash] });
  if (r.error) return r;
  const rc = r.result;
  return {
    result: {
      version: "2.0.0",
      id: hash,
      chainId: hex(c),
      atomic: true,
      status: !rc ? 100 : rc.status === "0x1" ? 200 : 500,
      receipts: rc ? [{ logs: rc.logs, status: rc.status, blockHash: rc.blockHash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed, transactionHash: rc.transactionHash }] : [],
    },
  };
}

// from the page's provider (inpage.js)
window.addEventListener("message", async e => {
  if (e.source !== window || e.data?.__iw !== "page") return;
  const { id, method, params } = e.data;
  let answer;
  try {
    answer = await handle(String(method), Array.isArray(params) ? params : params == null ? [] : [params], id);
  } catch (x) {
    answer = err(-32603, String(x?.message || x));
  }
  if (answer) toPage({ type: "res", id, ...answer });
});

// answers from the wallet tab, through the background
chrome.runtime.onMessage.addListener(m => {
  if (m.type !== "res" || !waiting.has(m.id)) return;
  const asked = waiting.get(m.id);
  waiting.delete(m.id);
  if (!m.error && asked === "wallet_sendCalls" && m.result?.id) {
    chrome.storage.local.get("calls").then(({ calls = {} }) => chrome.storage.local.set({ calls: { ...calls, [m.result.id]: chainId() } }));
  }
  const result = asked === "wallet_requestPermissions" && !m.error ? [{ parentCapability: "eth_accounts" }] : m.result;
  toPage({ type: "res", id: m.id, ...(m.error ? { error: m.error } : { result }) });
});

// keep the page's provider in step: account, network, disconnect
chrome.storage.onChanged.addListener(async (_c, area) => {
  if (area !== "local") return;
  const before = { accounts: accounts().join(), chainId: chainId() };
  await load();
  if (accounts().join() !== before.accounts) toPage({ type: "event", name: "accountsChanged", data: accounts() });
  if (chainId() !== before.chainId) toPage({ type: "event", name: "chainChanged", data: hex(chainId()) });
});

load().then(() => toPage({ type: "init", chainId: hex(chainId()), accounts: accounts(), takeover: st.takeover }));
