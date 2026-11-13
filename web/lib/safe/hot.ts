import { type Address, type Hex, getAddress } from "viem";
import { type SafeTx, type Sig, ecdsaSig, safeMessageTypedData, safeTxTypedData } from "./core";

/**
 * The hot wallet: MetaMask, Rainbow, any browser wallet. It only ever signs Safe transactions and Safe messages as
 * typed data; it needs no gas unless you send a transaction yourself (`hotSend`).
 *
 * A browser can have several (MetaMask and Rainbow): each announces itself (EIP-6963), and `window.ethereum` is only
 * whichever won. We ask them all and use the one that holds the signer's address (Austin 11-12: the signer was in
 * one wallet, `window.ethereum` was the other, and the tx couldn't be signed).
 */
type Provider = { request(a: { method: string; params?: unknown }): Promise<any> };
const found: { p: Provider; name: string }[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: any) => {
    const p = e?.detail?.provider;
    if (p && !found.some(f => f.p === p)) found.push({ p, name: e.detail.info?.name || "Your wallet" });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}
function wallets(): { p: Provider; name: string }[] {
  if (typeof window === "undefined") return [];
  const w = (window as any).ethereum as Provider | undefined;
  const all = found.length ? [...found] : w ? [{ p: w, name: "Your wallet" }] : [];
  // the one used last first (it executes, it signs again), then the page's own
  return all.sort((x, y) => Number(y.p === last) - Number(x.p === last) || Number(y.p === w) - Number(x.p === w));
}
let last: Provider | undefined;
export const hotAvailable = () => wallets().length > 0;

/** The wallet that holds one of `expect` (any account, when none is asked for), and that address. Wallets already
 * connected are asked first, with no popup; then each one is asked to connect. */
async function pick(expect: Address[] = []): Promise<{ p: Provider; who: Address }> {
  const all = wallets();
  if (!all.length) throw new Error("No browser wallet here. Open this page in a browser with a wallet extension, or in your wallet app's browser.");
  const want = expect.map(a => a.toLowerCase());
  const match = (as: unknown) => {
    const list = Array.isArray(as) ? (as as string[]) : [];
    return want.length ? list.find(a => want.includes(a.toLowerCase())) : list[0];
  };
  const use = (p: Provider, a: string) => ((last = p), { p, who: getAddress(a) });
  for (const { p } of all) {
    const a = match(await p.request({ method: "eth_accounts" }).catch(() => []));
    if (a) return use(p, a);
  }
  const on: string[] = [];
  for (const { p, name } of all) {
    const as = await p.request({ method: "eth_requestAccounts" }).catch(() => []);
    const a = match(as);
    if (a) return use(p, a);
    if (Array.isArray(as) && as[0]) on.push(`${name} is on ${getAddress(as[0])}`);
  }
  if (!want.length) throw new Error("Connect your browser wallet first.");
  throw new Error(`Switch your wallet to ${expect.join(" or ")}${on.length ? ` (${on.join(", ")})` : ""}.`);
}

/** Is `a` connected in a browser wallet here already? Asks each one quietly (eth_accounts: no popup). */
export async function hotHas(a: Address): Promise<boolean> {
  for (const { p } of wallets()) {
    const as = await p.request({ method: "eth_accounts" }).catch(() => []);
    if (Array.isArray(as) && as.some((x: string) => x.toLowerCase() === a.toLowerCase())) return true;
  }
  return false;
}

/** Connect, and say which address: one of `expect` when given (it fails, in words, if no wallet here holds one). */
export async function connectHot(expect?: Address[]): Promise<Address> {
  return (await pick(expect)).who;
}

async function onChain(p: Provider, chainId: number) {
  // MetaMask refuses typed data for a chain other than the one it's on
  const want = "0x" + chainId.toString(16);
  const on = await p.request({ method: "eth_chainId" }).catch(() => want);
  if (on !== want) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
}

/** Send a transaction from the browser wallet itself (it pays the gas): no relay. */
export async function hotSend(chainId: number, to: Address, data: Hex): Promise<Hex> {
  const { p, who } = await pick();
  await onChain(p, chainId);
  return (await p.request({ method: "eth_sendTransaction", params: [{ from: who, to, data }] })) as Hex;
}

export async function hotSign(chainId: number, safe: Address, t: SafeTx, expect: Address): Promise<Sig> {
  return hotSignTyped(chainId, safeTxTypedData(chainId, safe, t), expect);
}

/** A SafeMessage (a site's message, ERC-1271): the same typed-data signature, over the message's hash. */
export async function hotSignMessage(chainId: number, safe: Address, hash: Hex, expect: Address): Promise<Sig> {
  return hotSignTyped(chainId, safeMessageTypedData(chainId, safe, hash), expect);
}

async function hotSignTyped(chainId: number, typed: unknown, expect: Address): Promise<Sig> {
  const { p, who } = await pick([expect]);
  await onChain(p, chainId);
  const sig = (await p.request({ method: "eth_signTypedData_v4", params: [who, JSON.stringify(typed)] })) as Hex;
  return ecdsaSig(who, sig);
}
