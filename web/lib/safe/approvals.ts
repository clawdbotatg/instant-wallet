import { type Address, type Hex, decodeFunctionData, encodeFunctionData, getAddress, pad, parseAbi, toEventSelector, zeroAddress } from "viem";
import { publicClient } from "../chains";
import { MULTICALL3 } from "./config";
import type { Call } from "./core";
import { callsOf } from "./describe";
import { SAFE_SVC } from "./share";

/**
 * Who can spend this wallet's coins (the Revoke app). Found from the chain alone: every Approval log naming this
 * wallet as owner, then each (coin, spender) read again now. Three kinds:
 *   coin    an ERC-20 allowance (approve)
 *   permit2 an allowance inside Permit2 (Uniswap's approvals contract), until it expires
 *   nft     a collection's setApprovalForAll
 * Instant Wallet's own Swap never leaves one (approve exact, swap, approve 0). Sites and Safe Apps can.
 */

export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const T_APPROVAL = toEventSelector("Approval(address,address,uint256)"); // ERC-20 and ERC-721
const T_FOR_ALL = toEventSelector("ApprovalForAll(address,address,bool)");
const T_P2_APPROVAL = toEventSelector("Approval(address,address,address,uint160,uint48)"); // Permit2: owner, token, spender
const T_P2_PERMIT = toEventSelector("Permit(address,address,address,uint160,uint48,uint48)"); // Permit2: owner, token, spender

const abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const p2 = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export type Approval = {
  key: string; // kind:coin:spender, lowercase
  kind: "coin" | "permit2" | "nft";
  chainId: number;
  token: Address; // the coin or the collection
  spender: Address;
  amount: bigint; // coin/permit2: what it may spend; nft: 1
  any: boolean; // any amount (or a whole collection)
  expires?: number; // permit2: seconds
  symbol: string;
  name: string;
  decimals: number;
};

const ANY = 2n ** 160n - 1n; // Permit2's "any amount" is uint160; an ERC-20's is uint256 (anything this big counts)

/** The logs: one ask per kind over the whole history (Alchemy answers up to 10K logs at once). */
async function logs(chainId: number, owner: Address, topic0: Hex, address?: Address) {
  return publicClient(chainId).request({
    method: "eth_getLogs",
    params: [{ fromBlock: "0x0", toBlock: "latest", topics: [topic0, pad(owner.toLowerCase() as Hex)], ...(address ? { address } : {}) }],
  } as any) as Promise<{ address: Address; topics: Hex[] }[]>;
}

const at = (t: Hex) => getAddress(`0x${t.slice(26)}`);

type Pair = { kind: Approval["kind"]; token: Address; spender: Address };

/** The (coin, spender) pairs ever approved, from the logs: one ask per kind over the whole history (Alchemy answers
 * up to 10K logs at once). Throws on a network whose node caps a log ask at 10K blocks (Gnosis, Avalanche, …). */
async function fromLogs(chainId: number, owner: Address): Promise<Pair[]> {
  const [a, f, pa, pp] = await Promise.all([
    logs(chainId, owner, T_APPROVAL),
    logs(chainId, owner, T_FOR_ALL),
    logs(chainId, owner, T_P2_APPROVAL, PERMIT2),
    logs(chainId, owner, T_P2_PERMIT, PERMIT2),
  ]);
  const out: Pair[] = [];
  // an ERC-20's Approval has 3 topics; an ERC-721's has 4 (one token, cleared when it moves): skipped
  for (const l of a) if (l.topics.length === 3) out.push({ kind: "coin", token: getAddress(l.address), spender: at(l.topics[2]) });
  for (const l of f) if (l.topics.length === 3) out.push({ kind: "nft", token: getAddress(l.address), spender: at(l.topics[2]) });
  for (const l of [...pa, ...pp]) if (l.topics.length === 4) out.push({ kind: "permit2", token: at(l.topics[2]), spender: at(l.topics[3]) });
  return out;
}

/** The same from the wallet's own executed transactions (Safe's service), where the logs can't be asked: every
 * approve, setApprovalForAll and Permit2 approve in them, batches opened up. A Permit2 signature (no tx) isn't seen. */
async function fromSafeTxs(chainId: number, owner: Address): Promise<Pair[]> {
  if (!SAFE_SVC[chainId]) throw new Error("Can't list them on this network yet.");
  const out: Pair[] = [];
  let path: string | null = `safes/${owner}/multisig-transactions/?executed=true&limit=100`;
  for (let page = 0; path && page < 3; page++) {
    const r = await fetch(`/api/safe/svc?u=${encodeURIComponent(`${SAFE_SVC[chainId].key}/api/v1/${path}`)}`);
    if (!r.ok) throw new Error("Safe's service didn't answer. Try again later.");
    const j: any = await r.json();
    for (const t of j.results ?? []) {
      if (!t.data) continue;
      for (const c of callsOf({ to: getAddress(t.to), value: BigInt(t.value ?? 0), data: t.data, operation: Number(t.operation) as 0 | 1 })) {
        const sel = c.data.slice(0, 10).toLowerCase();
        try {
          if (sel === "0x095ea7b3") out.push({ kind: "coin", token: c.to, spender: decodeFunctionData({ abi, data: c.data }).args![0] as Address });
          else if (sel === "0xa22cb465") out.push({ kind: "nft", token: c.to, spender: decodeFunctionData({ abi, data: c.data }).args![0] as Address });
          else if (sel === "0x87517c45" && c.to.toLowerCase() === PERMIT2.toLowerCase()) {
            const [token, spender] = decodeFunctionData({ abi: p2, data: c.data }).args as unknown as [Address, Address];
            out.push({ kind: "permit2", token, spender });
          }
        } catch {}
      }
    }
    path = j.next ? String(j.next).split("/api/v1/")[1] ?? null : null;
  }
  return out;
}

/** Everything that can still spend from `owner` on this network, the biggest danger first (any amount). */
export async function findApprovals(chainId: number, owner: Address): Promise<Approval[]> {
  const found = await fromLogs(chainId, owner).catch(e => {
    if (/block range/i.test(String(e?.details ?? e?.message ?? e))) return fromSafeTxs(chainId, owner);
    throw e;
  });
  const pairs = new Map<string, Pair>();
  for (const p of found) if (p.spender !== zeroAddress) pairs.set(`${p.kind}:${p.token}:${p.spender}`.toLowerCase(), { ...p, token: getAddress(p.token), spender: getAddress(p.spender) });
  const list = [...pairs.entries()];
  if (!list.length) return [];

  const pc = publicClient(chainId);
  const now = await pc.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: list.map(([, p]) =>
      p.kind === "coin"
        ? { address: p.token, abi, functionName: "allowance", args: [owner, p.spender] }
        : p.kind === "nft"
          ? { address: p.token, abi, functionName: "isApprovedForAll", args: [owner, p.spender] }
          : { address: PERMIT2, abi: p2, functionName: "allowance", args: [owner, p.token, p.spender] },
    ) as any,
  });
  const t = Date.now() / 1000;
  const live = list
    .map(([key, p], i) => {
      const r = now[i];
      if (r.status !== "success") return null;
      if (p.kind === "coin") {
        const amount = r.result as bigint;
        return amount > 0n ? { key, ...p, amount, any: amount >= ANY } : null;
      }
      if (p.kind === "nft") return r.result ? { key, ...p, amount: 1n, any: true } : null;
      const [amount, expiration] = r.result as [bigint, number];
      return amount > 0n && expiration > t ? { key, ...p, amount, any: amount >= ANY, expires: Number(expiration) } : null;
    })
    .filter(x => !!x);
  if (!live.length) return [];

  // each coin's name, once
  const tokens = [...new Set(live.map(x => x.token))];
  const meta = await pc.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: tokens.flatMap(address => [
      { address, abi, functionName: "symbol" },
      { address, abi, functionName: "name" },
      { address, abi, functionName: "decimals" },
    ]) as any,
  });
  const info = new Map(
    tokens.map((tk, i) => [
      tk,
      {
        symbol: meta[i * 3].status === "success" ? String(meta[i * 3].result).slice(0, 16) : "?",
        name: meta[i * 3 + 1].status === "success" ? String(meta[i * 3 + 1].result).slice(0, 40) : "",
        decimals: meta[i * 3 + 2].status === "success" ? Number(meta[i * 3 + 2].result) : 18,
      },
    ]),
  );
  return live
    .map(x => ({ ...x, chainId, ...info.get(x.token)! }))
    .sort((a, b) => Number(b.any) - Number(a.any) || a.symbol.localeCompare(b.symbol));
}

/** The call that takes it back. */
export function revokeCall(x: Approval): Call {
  if (x.kind === "coin") return { to: x.token, value: 0n, data: encodeFunctionData({ abi, functionName: "approve", args: [x.spender, 0n] }) };
  if (x.kind === "nft") return { to: x.token, value: 0n, data: encodeFunctionData({ abi, functionName: "setApprovalForAll", args: [x.spender, false] }) };
  return { to: PERMIT2, value: 0n, data: encodeFunctionData({ abi: p2, functionName: "approve", args: [x.token, x.spender, 0n, 0] }) };
}
