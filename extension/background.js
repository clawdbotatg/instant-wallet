// Instant Wallet extension, the background. It holds no keys. It routes: a site's request → the Instant Wallet tab,
// the answer → back to the site. Chrome stops this worker when idle, so nothing lives in memory: where an answer
// goes rides in the request id (rid = tab:frame:id), the rest is chrome.storage.
//   local:   account { address, chainIds }, wallet (the Instant Wallet origin last used), sites { origin: { chainId, connected } },
//            takeover (act as MetaMask), calls { hash: chainId }
//   session: queue (requests waiting for a wallet to open)

const WALLETS = ["https://instantwallet.io", "https://instant-wallet-b2jn.vercel.app"];
const WALLET_TABS = WALLETS.map(o => `${o}/*`);

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const fromWallet = WALLETS.includes(sender.origin);
  (fromWallet ? fromWalletPage(m, sender) : fromSite(m, sender)).then(reply, e => reply({ error: { code: -32603, message: String(e?.message || e) } }));
  return true;
});

// ------------------------------------------------------------------ sites

async function fromSite(m, sender) {
  if (m.type === "open") return openWallet(); // the popup's button
  if (!sender.tab || m.type === "ready" || m.type === "res") return { error: { code: 4100, message: "Not allowed" } };
  if (m.type === "rpc") return rpc(m.chainId, m.method, m.params);
  if (m.type === "ask") {
    // connect (no wallet known yet) or a key request: queue it for the Instant Wallet tab, answer later
    const origin = sender.origin;
    const entry = {
      rid: `${sender.tab.id}:${sender.frameId ?? 0}:${m.id}`,
      origin,
      icon: sender.tab.favIconUrl,
      method: m.method,
      params: m.params,
      chainId: m.chainId,
    };
    await forward(entry);
    return { queued: true };
  }
  return { error: { code: 4200, message: "Unknown" } };
}

async function rpc(chainId, method, params) {
  const { wallet = WALLETS[0] } = await chrome.storage.local.get("wallet");
  const res = await fetch(`${wallet}/api/rpc/${Number(chainId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
  });
  const j = await res.json().catch(() => ({ error: { code: -32603, message: `RPC ${res.status}` } }));
  return j.error ? { error: j.error.code ? j.error : { code: -32603, message: String(j.error) } } : { result: j.result };
}

// ------------------------------------------------------------------ the wallet tab

async function fromWalletPage(m, sender) {
  if (m.type === "ready") {
    const address = String(m.address);
    const chainIds = (m.chainIds || []).map(Number);
    await chrome.storage.local.set({ account: { address, chainIds }, wallet: sender.origin });
    await flush(sender.tab);
    return {};
  }
  if (m.type === "res") {
    const [tabId, frameId, id] = String(m.rid).split(":");
    await chrome.tabs.sendMessage(Number(tabId), { type: "res", id: Number(id), result: m.result, error: m.error }, { frameId: Number(frameId) }).catch(() => {});
    await focus(await chrome.tabs.get(Number(tabId)).catch(() => null));
    return {};
  }
  return {};
}

/** Send one request to a wallet tab that's open and unlocked, or queue it and open one. */
async function forward(entry) {
  const tab = await readyWallet();
  if (tab && entry.method !== "eth_requestAccounts") {
    await chrome.tabs.sendMessage(tab.id, { type: "req", req: entry });
    return focus(tab);
  }
  if (tab && entry.method === "eth_requestAccounts") return flushOne(entry, tab);
  const { queue = [] } = await chrome.storage.session.get("queue");
  await chrome.storage.session.set({ queue: [...queue, entry] });
  await openWallet();
}

/** A wallet page came up: answer the connects, hand it the rest. */
async function flush(tab) {
  const { queue = [] } = await chrome.storage.session.get("queue");
  if (!queue.length) return;
  await chrome.storage.session.set({ queue: [] });
  for (const entry of queue) await flushOne(entry, tab);
}

async function flushOne(entry, tab) {
  if (entry.method === "eth_requestAccounts") {
    const { account, sites = {} } = await chrome.storage.local.get(["account", "sites"]);
    await chrome.storage.local.set({ sites: { ...sites, [entry.origin]: { ...sites[entry.origin], connected: true } } });
    const [tabId, frameId, id] = entry.rid.split(":");
    await chrome.tabs.sendMessage(Number(tabId), { type: "res", id: Number(id), result: [account.address] }, { frameId: Number(frameId) }).catch(() => {});
    return focus(await chrome.tabs.get(Number(tabId)).catch(() => null));
  }
  await chrome.tabs.sendMessage(tab.id, { type: "req", req: entry }).catch(() => {});
  await focus(tab);
}

async function readyWallet() {
  for (const t of await chrome.tabs.query({ url: WALLET_TABS })) {
    const r = await chrome.tabs.sendMessage(t.id, { type: "ping" }).catch(() => null);
    if (r?.ready) return t;
  }
  return null;
}

async function openWallet() {
  const [open] = await chrome.tabs.query({ url: WALLET_TABS });
  if (open) return focus(open);
  const { wallet = WALLETS[0] } = await chrome.storage.local.get("wallet");
  await chrome.tabs.create({ url: `${wallet}/` });
}

async function focus(tab) {
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}
