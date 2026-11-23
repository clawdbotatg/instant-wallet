import { type Address, type Hex, encodeFunctionData } from "viem";
import { chainById, publicClient } from "../chains";
import { abi } from "./core";
import { hotHas } from "./hot";
import { type ChainState, type Recovery, type SafeAccount, knownAccounts, watchAccount, watchWith } from "./state";

/**
 * Recover this wallet (Austin 11-23): the wallet on screen was opened by its address, and this browser holds one of
 * its recovery addresses. Three ways to hold one:
 *   - a browser wallet here IS the recovery address: it sends the transaction itself
 *   - one of this browser's own Instant Wallets is the recovery address: it sends it, as it sends anything
 *   - the recovery address is a Safe (the DAO) and this browser holds one of its signers: a transaction on that Safe,
 *     signed here, then by its other signers on its page
 * Per network: each network's wallet has its own recovery, started and finished on its own.
 */
export type Via = { wallet: Address } | { account: SafeAccount };
export type Party = {
  chainId: number;
  module: Address;
  days: number;
  address: Address; // the recovery address
  owners: Address[] | null; // its signers when it's a Safe on this network, else null
  request: Recovery; // a recovery running on this module
};

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// a recovery address's signers on a network, read once per page (null: not a Safe there)
const ownersOf = new Map<string, Promise<Address[] | null>>();
function safeOwners(chainId: number, a: Address): Promise<Address[] | null> {
  const k = `${chainId}:${a.toLowerCase()}`;
  let p = ownersOf.get(k);
  if (!p) {
    p = publicClient(chainId)
      .readContract({ address: a, abi: abi.safe, functionName: "getOwners" })
      .then(o => [...(o as Address[])], () => null);
    ownersOf.set(k, p);
  }
  return p;
}

/** Every recovery address of the wallet, per network it's on. */
export async function recoveryParties(states: ChainState[]): Promise<Party[]> {
  const out: Promise<Party>[] = [];
  for (const st of states)
    if (st.deployed)
      for (const r of st.recoveries)
        for (const g of r.guardians ?? [])
          out.push(safeOwners(st.chainId, g).then(owners => ({ chainId: st.chainId, module: r.module, days: r.days, address: g, owners, request: r.request })));
  return Promise.all(out);
}

/** The addresses a browser wallet could hold to act for one of them: asked for at Connect. */
export const partyWallets = (ps: Party[]): Address[] => [...new Set(ps.flatMap(p => p.owners ?? [p.address]))];

/** How this browser acts for a recovery address, or null: it holds none of it. Quiet: no popup. */
export async function viaFor(p: Party): Promise<Via | null> {
  const known = knownAccounts();
  const own = known.find(k => eq(k.address, p.address));
  if (own) return { account: own };
  if (!p.owners) return (await hotHas(p.address).catch(() => false)) ? { wallet: p.address } : null;
  const k = known.find(k => p.owners!.some(o => eq(o, k.burnerSigner)));
  if (k) return { account: watchWith(k, p.address) };
  for (const o of p.owners) if (await hotHas(o).catch(() => false)) return { account: { ...watchAccount(p.address), me: o } };
  return null;
}

export const startCall = (p: Party, wallet: Address, newSigner: Address): { to: Address; value: bigint; data: Hex } => ({
  to: p.module,
  value: 0n,
  data: encodeFunctionData({ abi: abi.recovery, functionName: "confirmRecovery", args: [wallet, [newSigner], 1n, true] }),
});
export const finishCall = (p: Party, wallet: Address): { to: Address; value: bigint; data: Hex } => ({
  to: p.module,
  value: 0n,
  data: encodeFunctionData({ abi: abi.recovery, functionName: "finalizeRecovery", args: [wallet] }),
});

/** The coin a Safe pays its fee in: USDC when it has some there, else the network's coin. */
export async function feeCoin(chainId: number, safe: Address): Promise<"usdc" | "eth"> {
  const usdc = chainById(chainId)?.usdc;
  if (!usdc) return "eth";
  const n = (await publicClient(chainId)
    .readContract({ address: usdc, abi: abi.erc20, functionName: "balanceOf", args: [safe] })
    .catch(() => 0n)) as bigint;
  return n > 0n ? "usdc" : "eth";
}
