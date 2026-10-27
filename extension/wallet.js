// Runs on the Instant Wallet site. Passes sites' requests to the page (lib/extension.ts) and the answers back.
let ready = null; // { address, chainIds } while a wallet is open on this page

window.addEventListener("message", e => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (d?.__iwx === "ready") {
    ready = { address: d.address, chainIds: d.chainIds };
    chrome.runtime.sendMessage({ type: "ready", ...ready }).catch(() => {});
  } else if (d?.__iwx === "gone") {
    ready = null;
  } else if (d?.__iwx === "res") {
    chrome.runtime.sendMessage({ type: "res", rid: d.rid, result: d.result, error: d.error }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type === "ping") return reply({ ready: !!ready });
  if (m.type === "req") window.postMessage({ __iwx: "req", ...m.req }, location.origin);
});
