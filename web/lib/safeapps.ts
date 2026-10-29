import { type Address, type Hash, getAddress, numberToHex, zeroAddress } from "viem";
import { chainById, publicClient } from "./chains";
import { FALLBACK_HANDLER, SAFE_L2 } from "./safe/config";
import type { ChainState } from "./safe/state";

/**
 * Safe Apps in a frame (docs/APP-STORE.md). The app speaks the Safe Apps SDK to its parent (us):
 *   app → us  { id, method, params, env: { sdkVersion } }
 *   us → app  { id, success, version, data | error }   (no `version` and the app drops it)
 * Reads (safe info, chain, rpcCall, tx status) are answered here at once: wagmi's safe() connector gives
 * getSafeInfo 10 ms. Calls and messages become a request on the same card as WalletConnect's (topic
 * "app:<rid>"); respond() / respondError() in lib/walletconnect.ts send the answer back through appRespond().
 *
 * sendTransactions answers { safeTxHash: <the real tx hash> }: we relay at once, so there's nothing to wait
 * for, and getTxBySafeTxHash hands the same hash back as txHash (safe-apps-provider looks the receipt up by it).
 */

export type AppRequest = { topic: string; method: string; params: unknown[]; chainId: number; dapp: { name: string; url: string; icon?: string } };

const VERSION = "9.1.0";
const listeners = new Set<(r: AppRequest) => void>();
const open = new Map<string, { win: Window; origin: string; id: string; method: string }>();
let rid = 0;

export const isApp = (topic: string) => topic.startsWith("app:");

/** The connect layer takes the frame's calls and messages (one at a time, on its card). Returns the cleanup. */
export function serveApps(cb: (r: AppRequest) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function appRespond(topic: string, answer: { result: unknown } | { error: { code: number; message: string } }) {
  const o = open.get(topic);
  if (!o) return;
  open.delete(topic);
  if ("error" in answer) return o.win.postMessage({ id: o.id, success: false, error: answer.error.message, version: VERSION }, o.origin);
  const r = answer.result as any;
  const data =
    o.method === "sendTransactions" ? { safeTxHash: typeof r === "string" ? r : r?.id } : { signature: r }; // signMessage, signTypedMessage
  o.win.postMessage({ id: o.id, success: true, version: VERSION, data }, o.origin);
}

const READS = new Set([
  "eth_call", "eth_gasPrice", "eth_getLogs", "eth_getBalance", "eth_getCode", "eth_getBlockByHash", "eth_getBlockByNumber",
  "eth_getStorageAt", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount", "eth_estimateGas",
  "eth_blockNumber", "eth_chainId",
]);

/** Answer one frame. `state` is read on every message, so a refresh shows. Returns the cleanup. */
export function hostApp(
  frame: HTMLIFrameElement,
  app: { name: string; url: string; icon?: string },
  safe: Address,
  chainId: number,
  state: () => ChainState | undefined,
): () => void {
  const origin = new URL(app.url).origin;
  const on = async (e: MessageEvent) => {
    const win = frame.contentWindow;
    if (!win || e.source !== win || e.origin !== origin) return;
    const { id, method, params } = (e.data ?? {}) as { id?: string; method?: string; params?: any };
    if (typeof id !== "string" || typeof method !== "string" || !e.data?.env) return;
    const ok = (data: unknown) => win.postMessage({ id, success: true, version: VERSION, data }, origin);
    const no = (error: string) => win.postMessage({ id, success: false, error, version: VERSION }, origin);
    const ask = (m: string, p: unknown[]) => {
      const topic = `app:${++rid}`;
      open.set(topic, { win, origin, id, method });
      listeners.forEach(l => l({ topic, method: m, params: p, chainId, dapp: { name: app.name, url: origin, icon: app.icon } }));
    };
    try {
      switch (method) {
        case "getSafeInfo": {
          const st = state();
          return ok({
            safeAddress: safe,
            chainId,
            threshold: st?.threshold ?? 1,
            owners: st?.owners ?? [],
            isReadOnly: false,
            nonce: Number(st?.nonce ?? 0n),
            implementation: SAFE_L2,
            modules: st?.modules ?? [],
            fallbackHandler: FALLBACK_HANDLER,
            guard: zeroAddress,
            version: "1.5.0",
          });
        }
        case "getChainInfo": {
          const c = chainById(chainId);
          const x = c?.explorer ?? "";
          return ok({
            chainName: c?.name ?? String(chainId),
            chainId: String(chainId),
            shortName: c?.short ?? String(chainId),
            nativeCurrency: { name: c?.native.name ?? "Ether", symbol: c?.native.symbol ?? "ETH", decimals: 18, logoUri: "" },
            blockExplorerUriTemplate: { address: `${x}/address/{{address}}`, txHash: `${x}/tx/{{txHash}}`, api: "" },
          });
        }
        case "getEnvironmentInfo":
          return ok({ origin: window.location.origin });
        case "getCurrentTheme":
          return ok({ darkMode: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false });
        case "getSafeBalances":
          return ok({ fiatTotal: "0", items: [] });
        case "wallet_getPermissions":
        case "wallet_requestPermissions":
        case "requestAddressBook":
          return ok([]);
        case "rpcCall": {
          const call = String(params?.call);
          if (call === "safe_setSettings") return ok(params?.params?.[0] ?? {});
          if (!READS.has(call)) return no(`${call} is not supported`);
          return ok(await publicClient(chainId).request({ method: call as any, params: params?.params ?? [] }));
        }
        case "getTxBySafeTxHash": {
          const hash = params?.safeTxHash as Hash;
          const r = await publicClient(chainId).getTransactionReceipt({ hash }).catch(() => null);
          return ok({
            safeAddress: safe,
            txId: hash,
            txHash: hash,
            txStatus: !r ? "AWAITING_EXECUTION" : r.status === "success" ? "SUCCESS" : "FAILED",
            executedAt: null,
            txInfo: {},
            txData: null,
            detailedExecutionInfo: null,
          });
        }
        case "sendTransactions": {
          const txs = (params?.txs ?? []) as { to: string; value?: string | number; data?: string }[];
          if (!txs.length) return no("No transactions");
          const calls = txs.map(t => ({ to: getAddress(t.to), value: numberToHex(BigInt(t.value ?? 0)), data: t.data || "0x" }));
          return ask("wallet_sendCalls", [{ chainId: numberToHex(chainId), calls }]);
        }
        case "signMessage":
          return ask("personal_sign", [params?.message, safe]);
        case "signTypedMessage":
          return ask("eth_signTypedData_v4", [safe, params?.typedData]);
        default:
          return no(`${method} is not supported`);
      }
    } catch (err: any) {
      no(err?.shortMessage || err?.message || "Request failed");
    }
  };
  window.addEventListener("message", on);
  return () => {
    window.removeEventListener("message", on);
    for (const [topic, o] of open) if (o.origin === origin) open.delete(topic);
  };
}
