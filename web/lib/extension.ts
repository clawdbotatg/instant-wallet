/**
 * The Instant Wallet browser extension (extension/ at the repo root). A site on this computer asks the extension,
 * the extension hands the request to this page through its content script, the same card as a WalletConnect
 * request signs it, and the answer goes back the same way. The extension holds no keys.
 *
 *   page → extension  { __iwx: "ready", address, chainIds }   a wallet is open here: send me sites' requests
 *                     { __iwx: "gone" }                       it closed
 *                     { __iwx: "res", rid, result | error }   the answer to one request
 *   extension → page  { __iwx: "req", rid, origin, icon?, method, params, chainId }
 *
 * `origin` comes from the browser (the site's tab), never from the site. A request's WalletConnect `topic` is
 * "ext:<rid>", so respond() / respondError() in lib/walletconnect.ts send the answer here.
 */

export type ExtRequest = { rid: string; origin: string; icon?: string; method: string; params: unknown[]; chainId: number };

const post = (m: Record<string, unknown>) => window.postMessage(m, window.location.origin);

export const isExt = (topic: string) => topic.startsWith("ext:");

export function extRespond(topic: string, answer: { result: unknown } | { error: { code: number; message: string } }) {
  post({ __iwx: "res", rid: topic.slice(4), ...answer });
}

export const extReady = (address: string, chainIds: number[]) => post({ __iwx: "ready", address, chainIds });
export const extGone = () => post({ __iwx: "gone" });

export function onExtRequest(cb: (r: ExtRequest) => void): () => void {
  const h = (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin || e.data?.__iwx !== "req") return;
    const { rid, origin, icon, method, params, chainId } = e.data;
    if (typeof rid !== "string" || typeof origin !== "string" || typeof method !== "string") return;
    cb({ rid, origin, icon: typeof icon === "string" ? icon : undefined, method, params: Array.isArray(params) ? params : [], chainId: Number(chainId) });
  };
  window.addEventListener("message", h);
  return () => window.removeEventListener("message", h);
}
