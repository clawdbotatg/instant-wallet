// Runs in the site's own page. The EIP-1193 provider sites talk to. Always listed in the site's wallet picker as
// "Instant Wallet" (EIP-6963), next to MetaMask and Rainbow, never in their way. With "Act as MetaMask" on, it also
// becomes window.ethereum and says it's MetaMask (the way Impersonator and WalletChan do it: no lock).
(() => {
  if (window.__instantWallet) return;
  const ICON = "data:image/png;base64,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";
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: "Instant Wallet", icon: ICON, rdns: "io.instantwallet" });
  const listeners = {};
  const waiting = new Map();
  let nextId = 1;

  const emit = (name, data) => (listeners[name] || []).slice().forEach(fn => {
    try { fn(data); } catch (e) { console.error(e); }
  });

  const provider = {
    isInstantWallet: true,
    chainId: null,
    selectedAddress: null,
    request({ method, params } = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        window.postMessage({ __iw: "page", id, method, params }, "*");
      });
    },
    on(name, fn) { (listeners[name] ||= []).push(fn); return provider; },
    once(name, fn) { const w = d => (provider.removeListener(name, w), fn(d)); return provider.on(name, w); },
    removeListener(name, fn) { listeners[name] = (listeners[name] || []).filter(f => f !== fn); return provider; },
    removeAllListeners(name) { if (name) delete listeners[name]; else for (const k in listeners) delete listeners[k]; return provider; },
    isConnected: () => true,
    enable: () => provider.request({ method: "eth_requestAccounts" }),
    // old sites
    sendAsync(payload, cb) {
      provider.request(payload).then(result => cb(null, { id: payload.id, jsonrpc: "2.0", result }), e => cb(e, { id: payload.id, jsonrpc: "2.0", error: e }));
    },
    send(a, b) {
      if (typeof a === "string") return provider.request({ method: a, params: b });
      if (typeof b === "function") return provider.sendAsync(a, b);
      return provider.request(a);
    },
  };
  provider.off = provider.removeListener;
  provider.addListener = provider.on;

  window.addEventListener("message", e => {
    if (e.source !== window || e.data?.__iw !== "ext") return;
    const m = e.data;
    if (m.type === "res") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data }));
      else {
        if (Array.isArray(m.result) && /^0x[0-9a-fA-F]{40}$/.test(m.result[0] ?? "")) provider.selectedAddress = m.result[0];
        w.resolve(m.result);
      }
    } else if (m.type === "event") {
      if (m.name === "accountsChanged") provider.selectedAddress = m.data[0] ?? null;
      if (m.name === "chainChanged") provider.chainId = m.data;
      emit(m.name, m.data);
    } else if (m.type === "init") {
      provider.chainId = m.chainId;
      provider.selectedAddress = m.accounts[0] ?? null;
      emit("connect", { chainId: m.chainId });
      if (m.takeover) takeOver();
    }
  });

  function takeOver() {
    provider.isMetaMask = true;
    try {
      try { delete window.ethereum; } catch {}
      window.ethereum = provider;
      if (window.ethereum !== provider) Object.defineProperty(window, "ethereum", { value: provider, writable: true, configurable: true, enumerable: true });
      window.dispatchEvent(new Event("ethereum#initialized"));
    } catch {
      console.warn("Instant Wallet: another wallet holds window.ethereum. Pick Instant Wallet from the site's wallet list instead.");
    }
  }

  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  Object.defineProperty(window, "__instantWallet", { value: provider });
})();
