import { type Address, type Hex, getAddress } from "viem";
import { type SafeTx, type Sig, ecdsaSig, safeMessageTypedData, safeTxTypedData } from "./core";
import { chainById, publicClient } from "../chains";

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

/** The browser wallet here that `a` is connected in (its name: MetaMask, Rainbow), or null. Asks each one quietly
 * (eth_accounts: no popup). One disconnected here stays null until it's connected again. */
const dropped = new Set<string>();
export async function hotName(a: Address): Promise<string | null> {
  if (dropped.has(a.toLowerCase())) return null;
  for (const { p, name } of wallets()) {
    const as = await p.request({ method: "eth_accounts" }).catch(() => []);
    if (Array.isArray(as) && as.some((x: string) => x.toLowerCase() === a.toLowerCase())) return name === "Your wallet" ? "Browser wallet" : name;
  }
  return null;
}
export const hotHas = async (a: Address) => (await hotName(a)) !== null;

/** Disconnect `a`: the wallet is asked to take this site's access back (MetaMask does; one that can't is just
 * left alone here until Connect is tapped again). */
export async function hotDrop(a: Address) {
  for (const { p } of wallets()) {
    const as = await p.request({ method: "eth_accounts" }).catch(() => []);
    if (Array.isArray(as) && as.some((x: string) => x.toLowerCase() === a.toLowerCase()))
      await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  }
  dropped.add(a.toLowerCase());
}

/** Connect, and say which address: one of `expect` when given (it fails, in words, if no wallet here holds one). */
export async function connectHot(expect?: Address[]): Promise<Address> {
  const { who } = await pick(expect);
  dropped.delete(who.toLowerCase());
  return who;
}

async function onChain(p: Provider, chainId: number) {
  // MetaMask refuses typed data for a chain other than the one it's on
  const want = "0x" + chainId.toString(16);
  const on = await p.request({ method: "eth_chainId" }).catch(() => want);
  if (on === want) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e: any) {
    if (e?.code === 4902) throw new Error(`Add ${chainById(chainId)?.name ?? "this network"} to your browser wallet first.`);
    throw e;
  }
}

/** Put the wallet that holds `a` on this network now (at Connect, and the Switch button). `force`: ask the wallet
 * even when it says it's there already (Austin 11-15: the button always makes the call). */
export async function hotSwitch(a: Address, chainId: number, force = false) {
  const { p } = await pick([a]);
  if (!force) return onChain(p, chainId);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + chainId.toString(16) }] });
  } catch (e: any) {
    if (e?.code === 4902) throw new Error(`Add ${chainById(chainId)?.name ?? "this network"} to your browser wallet first.`);
    throw e;
  }
}

/** The network the wallet that holds `a` is on now (no popup), or null. */
export async function hotChain(a: Address): Promise<number | null> {
  for (const { p } of wallets()) {
    const as = await p.request({ method: "eth_accounts" }).catch(() => []);
    if (!Array.isArray(as) || !as.some((x: string) => x.toLowerCase() === a.toLowerCase())) continue;
    const id = await p.request({ method: "eth_chainId" }).catch(() => null);
    return id ? Number(id) : null;
  }
  return null;
}

/**
 * The wallet's own node for this network refused it (Austin 11-15: "RPC 0x89 Custom eth_getBlockByNumber:
 * Unauthorized": the RPC saved in MetaMask for Polygon had a dead key). The wallet reads and sends through that
 * node, and only its owner can pick another: wallet_addEthereumChain for a network MetaMask already has adds our
 * URL to its list but keeps the old one as the default (read in metamask-extension's add-ethereum-chain.ts, 11-15;
 * tried, and it changed nothing). So: say exactly where to change it.
 */
const nodeRefused = (e: any) => e?.code !== 4001 && /unauthorized|forbidden|\b40[13]\b|\b429\b|rate limit|failed to fetch|RPC /i.test(String(e?.message || e));
/**
 * The transaction goes to the wallet with its gas worked out here, through our node (Austin 11-15: MetaMask, given
 * none, asks its own node for the latest block to work it out, eth_getBlockByNumber, and his said Unauthorized;
 * with `gas` in the request MetaMask skips that read: its transaction-controller, utils/gas.ts getGas). One that
 * would fail says so here, before the wallet opens. If the wallet's node still refuses, once more with the gas
 * price from our node too, so the wallet has nothing left to read before it sends.
 */
async function sendTx(p: Provider, chainId: number, tx: { from: Address; to: Address; data: Hex; value?: Hex }): Promise<Hex> {
  const pc = publicClient(chainId);
  const hex = (n: bigint) => "0x" + n.toString(16);
  const est = await pc.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
  const withGas = { ...tx, gas: hex((est * 13n) / 10n + 10_000n) };
  const send = (t: unknown) => p.request({ method: "eth_sendTransaction", params: [t] }) as Promise<Hex>;
  try {
    return await send(withGas);
  } catch (e: any) {
    if (!nodeRefused(e)) throw e;
    let first: any = e;
    try {
      const f = await pc.estimateFeesPerGas();
      const fees = f.maxFeePerGas ? { maxFeePerGas: hex(f.maxFeePerGas), maxPriorityFeePerGas: hex(f.maxPriorityFeePerGas ?? 0n) } : { gasPrice: hex(f.gasPrice!) };
      return await send({ ...withGas, ...fees });
    } catch (e2: any) {
      if (e2?.code === 4001) throw e2;
      if (nodeRefused(e2)) first = e2;
    }
    const net = chainById(chainId)?.name ?? "this network";
    // the proof, said: does the wallet's node answer anything at all? (Austin 11-15: his answered Unauthorized to
    // every read, the block number too; five tries here could not have worked)
    const dead = await p.request({ method: "eth_blockNumber" }).then(() => false, () => true);
    throw new Error(
      dead
        ? `Your browser wallet's ${net} RPC is dead: it refuses everything, even the block number ("${String(first?.message || first).slice(0, 60)}"). The wallet can't send anything on ${net} until you change it: in the wallet, Networks, ${net}, Edit, pick another RPC URL. A site can't change it.`
        : `Your browser wallet's ${net} RPC refused this ("${String(first?.message || first).slice(0, 80)}"). In the wallet: Networks, ${net}, Edit, and pick another RPC URL. Then tap Execute again.`,
    );
  }
}

/** Send a transaction from the browser wallet itself (it pays the gas): no relay. */
export async function hotSend(chainId: number, to: Address, data: Hex): Promise<Hex> {
  const { p, who } = await pick();
  await onChain(p, chainId);
  return sendTx(p, chainId, { from: who, to, data });
}

/** A plain transaction from `from` itself: only when a browser wallet here holds that address (a wallet opened to
 * watch that you also have in MetaMask). It fails, in words, when none does. */
export async function hotCall(chainId: number, from: Address, c: { to: Address; value: bigint; data: Hex }): Promise<Hex> {
  const { p, who } = await pick([from]);
  await onChain(p, chainId);
  return sendTx(p, chainId, { from: who, to: c.to, data: c.data, value: ("0x" + c.value.toString(16)) as Hex });
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
