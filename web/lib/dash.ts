import "server-only";
import { type Address, type Hex, decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, keccak256, pad, parseAbi, toBytes, toHex, zeroAddress } from "viem";
import { CHAINS, type ChainInfo } from "./chains";
import { kv } from "./kv";
import { alchemyNetwork, rpc } from "./rpcServer";
import { DAO, MULTICALL3, MULTISEND_CALL_ONLY, RECOVERY_7D } from "./safe/config";
import { type Call, abi, safeAddress } from "./safe/core";
import { feePaid, unpackMultiSend } from "./safe/fee";
import { relayer } from "./safe/relayCore";
import { POPULAR } from "./safe/swap";

/**
 * The private dashboard's numbers (/dashboard, behind a password): totals over every Instant Wallet Safe, read from the chain.
 * Nothing is tracked in the app.
 *
 * Finding the wallets: every Instant Wallet's first setup adds the DAO as its 7-day recovery guardian, so the recovery
 * module logs GuardianAdded(wallet, DAO) at each deploy. A wallet counts only if its own SafeSetup log names one owner
 * that makes its address (`safeAddress`): that is exact, nobody else's Safe passes.
 * A wallet that was funded but never sent anything isn't on any chain yet, so it isn't counted.
 *
 * Money: the native coin and the well-known tokens (Swap's list) of every wallet on every chain, one Multicall3 read
 * per chain. Other tokens aren't counted: a made-up price on one would make up the total.
 *
 * Relay fees: a wallet's batch ends with a payment to the relay, in USDC or the chain's coin. A Safe logs each
 * transaction it runs (SafeMultiSigTransaction, SafeModuleTransaction), so the fee is read out of those. The coin is
 * priced at the time of the read, not of the payment. A claim card's fee (no Safe) isn't counted.
 *
 * KV (prefix dash:): `state` = the wallet list, each chain's last scanned block, the daily counts (server only, never
 * sent to a browser); `totals` = what the page gets, no addresses in it; `lock` = one run at a time.
 */

const P = "dash:";
const START = Math.floor(Date.UTC(2026, 8, 13) / 1000); // the repo's first commit: no Instant Wallet is older
const DAY = 86_400;
const STABLE = /^(USDC|USDT|DAI|USDBC|USDS|PYUSD|XDAI|WXDAI)$/i;

const T_GUARDIAN = keccak256(toBytes("GuardianAdded(address,address)"));
const T_SETUP = keccak256(toBytes("SafeSetup(address,address[],uint256,address,address)"));
const T_EXEC = keccak256(toBytes("ExecutionSuccess(bytes32,uint256)"));
const T_MODULE = keccak256(toBytes("ExecutionFromModuleSuccess(address)"));
const T_MULTISIG = keccak256(toBytes("SafeMultiSigTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,bytes)"));
const T_MODTX = keccak256(toBytes("SafeModuleTransaction(address,address,uint256,bytes,uint8)"));
const VERSION = 2; // a change in what's read from the logs: bump it and every chain is read again from the start
const mc = parseAbi(["function getEthBalance(address addr) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);

type Wallet = { first: number; last: number; chains: number[] };
type State = {
  v: number;
  fee: number; // relay fees so far, dollars
  chains: Record<number, { block?: number; span?: number }>;
  wallets: Record<string, Wallet>; // by lowercase address
  days: Record<string, { tx: number; fee?: number }>; // by UTC date
  bal: Record<number, { at: number; coins: Record<string, number>; noPrice: string[] }>; // each chain's last good read
  usd: [number, number][]; // [time, total], about hourly
};

export type Totals = {
  at: number;
  totalUsd: number;
  wallets: number;
  funded: number; // wallets holding $1 or more
  new7: number;
  new30: number;
  active7: number;
  active30: number;
  tx7: number;
  tx30: number;
  feeUsd: number; // relay fees, all time
  fee7: number;
  fee30: number;
  chains: { id: number; name: string; usd: number; wallets: number; stale: boolean }[];
  coins: { symbol: string; usd: number }[];
  noPrice: string[];
  days: { date: string; tx: number; new: number; fee: number }[];
  usd: [number, number][];
  behind: string[]; // chains still being read from the start
  unread: string[]; // chains that couldn't be read this run
};

type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; blockTimestamp?: Hex };

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

const logs = (chainId: number, from: number, to: number, address: Address | Address[], topics: (Hex | Hex[] | null)[]) =>
  rpc<Log[]>(chainId, "eth_getLogs", [{ address, topics, fromBlock: toHex(from), toBlock: toHex(to) }]);

const blockTime = async (chainId: number, n: number) => Number(BigInt((await rpc<{ timestamp: Hex }>(chainId, "eth_getBlockByNumber", [toHex(n), false])).timestamp));

/** The first block at or after `ts`. */
async function blockAt(chainId: number, ts: number, head: number): Promise<number> {
  let lo = 1;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(chainId, mid)) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Seen = { wallet: string; ts: number };
type Fee = { ts: number; usdc: bigint; coin: bigint };

/** The relay's address. RELAYER_ADDRESS is for a machine without the relay's key (local dev). */
function relayAddress(): Address | undefined {
  try {
    return process.env.RELAYER_ADDRESS ? getAddress(process.env.RELAYER_ADDRESS) : relayer().address;
  } catch {
    return undefined;
  }
}

/** What one logged Safe transaction paid the relay. */
function feeOf(l: Log, relay: Address, usdc: Address | undefined): { usdc: bigint; eth: bigint } {
  try {
    const [to, value, data] =
      l.topics[0] === T_MULTISIG
        ? decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], l.data)
        : (decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }], l.data).slice(1) as [Address, bigint, Hex]);
    let calls: Call[] = [{ to, value, data }];
    if (to.toLowerCase() === MULTISEND_CALL_ONLY.toLowerCase()) calls = unpackMultiSend(data);
    else if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      const m = decodeFunctionData({ abi: abi.multicall3, data });
      if (m.functionName === "aggregate3Value") calls = m.args[0].map(c => ({ to: c.target, value: c.value, data: c.callData }));
    }
    return feePaid(calls, relay, usdc);
  } catch {
    return { usdc: 0n, eth: 0n }; // not one of our batches
  }
}
const BATCH = 8; // block ranges read at once on a chain that only answers short ones

const stamper = (chainId: number) => {
  const times = new Map<number, number>();
  return async (l: Log) => {
    if (l.blockTimestamp) return Number(BigInt(l.blockTimestamp));
    const n = Number(BigInt(l.blockNumber));
    if (!times.has(n)) times.set(n, await blockTime(chainId, n));
    return times.get(n)!;
  };
};

/** The Instant Wallets deployed on this chain in a block range. */
async function deploys(chainId: number, from: number, to: number, known: Set<string>): Promise<Seen[]> {
  const when = stamper(chainId);
  const cands = new Map<string, Log>();
  for (const l of await logs(chainId, from, to, RECOVERY_7D, [T_GUARDIAN, null, pad(DAO)])) cands.set(`0x${l.topics[1].slice(26)}`.toLowerCase(), l);
  const unsure = [...cands.keys()].filter(w => !known.has(w));
  const ours = new Set<string>();
  for (let i = 0; i < unsure.length; i += 200) {
    for (const l of await logs(chainId, from, to, unsure.slice(i, i + 200) as Address[], [T_SETUP])) {
      const [owners] = decodeAbiParameters([{ type: "address[]" }, { type: "uint256" }, { type: "address" }, { type: "address" }], l.data);
      if (owners.length === 1 && safeAddress(owners[0]).toLowerCase() === l.address.toLowerCase()) ours.add(l.address.toLowerCase());
    }
  }
  const out: Seen[] = [];
  for (const [w, l] of cands) if (known.has(w) || ours.has(w)) out.push({ wallet: w, ts: await when(l) });
  return out;
}

/** These wallets' transactions on this chain in a block range (one per transaction however many events it has), and the relay fees in them. */
async function activity(c: ChainInfo, from: number, to: number, wallets: string[], relay: Address | undefined): Promise<{ txs: Seen[]; fees: Fee[] }> {
  const when = stamper(c.id);
  const seen = new Set<string>();
  const txs: Seen[] = [];
  const fees: Fee[] = [];
  for (let i = 0; i < wallets.length; i += 300) {
    for (const l of await logs(c.id, from, to, wallets.slice(i, i + 300) as Address[], [[T_EXEC, T_MODULE, T_MULTISIG, T_MODTX]])) {
      if (l.topics[0] === T_MULTISIG || l.topics[0] === T_MODTX) {
        const f = relay && feeOf(l, relay, c.usdc);
        if (f && (f.usdc || f.eth)) fees.push({ ts: await when(l), usdc: f.usdc, coin: f.eth });
        continue;
      }
      if (seen.has(l.transactionHash)) continue;
      seen.add(l.transactionHash);
      txs.push({ wallet: l.address.toLowerCase(), ts: await when(l) });
    }
  }
  return { txs, fees };
}

/** Reads a chain on from where the last run stopped, until it's at the head or out of time. True: still behind. */
async function scanChain(c: ChainInfo, st: State, deadline: number, relay: Address | undefined, coinUsd: number): Promise<boolean> {
  const cs = (st.chains[c.id] ??= {});
  const head = Number(BigInt(await rpc<Hex>(c.id, "eth_blockNumber", []))) - 3;
  if (cs.block === undefined) cs.block = (await blockAt(c.id, START, head)) - 1;
  while (cs.block < head && Date.now() < deadline) {
    const span = cs.span ?? head - cs.block;
    const ranges: [number, number][] = [];
    for (let from = cs.block + 1; from <= head && ranges.length < BATCH; from += span) ranges.push([from, Math.min(head, from + span - 1)]);
    let found: Seen[][];
    let acts: { txs: Seen[]; fees: Fee[] }[];
    try {
      // the deploys first: a wallet's transactions can only follow its deploy on this chain
      found = await Promise.all(ranges.map(([a, b]) => deploys(c.id, a, b, new Set(Object.keys(st.wallets)))));
      const here = [...new Set([...Object.entries(st.wallets).filter(([, w]) => w.chains.includes(c.id)).map(([a]) => a), ...found.flat().map(d => d.wallet)])];
      acts = here.length ? await Promise.all(ranges.map(([a, b]) => activity(c, a, b, here, relay))) : [];
    } catch (e) {
      // some chains only answer a short range (Gnosis: 10,000 blocks): ask for less, and remember
      if (span <= 500) throw e;
      cs.span = span > 10_000 ? 10_000 : span > 2_000 ? 2_000 : 500;
      continue;
    }
    for (const d of found.flat()) {
      const w = (st.wallets[d.wallet] ??= { first: d.ts, last: 0, chains: [] });
      w.first = Math.min(w.first, d.ts);
      if (!w.chains.includes(c.id)) w.chains.push(c.id);
    }
    for (const t of acts.flatMap(a => a.txs)) {
      const w = st.wallets[t.wallet];
      if (!w) continue;
      w.last = Math.max(w.last, t.ts);
      (st.days[day(t.ts)] ??= { tx: 0 }).tx++;
    }
    for (const f of acts.flatMap(a => a.fees)) {
      const usd = Number(formatUnits(f.usdc, 6)) + Number(formatUnits(f.coin, 18)) * coinUsd;
      st.fee += usd;
      const d = (st.days[day(f.ts)] ??= { tx: 0 });
      d.fee = (d.fee ?? 0) + usd;
    }
    cs.block = ranges[ranges.length - 1][1];
  }
  return cs.block < head;
}

type Held = { symbol: string; address: Address; decimals: number; each: bigint[] }; // each: per wallet, in `wallets` order

/** Every wallet's balance of the chain's native coin and well-known tokens. */
async function balances(c: ChainInfo, wallets: Address[]): Promise<Held[]> {
  const seen = new Set<string>();
  const tokens = (POPULAR[c.id] ?? []).filter(t => !seen.has(t.address.toLowerCase()) && seen.add(t.address.toLowerCase()));
  const calls = tokens.flatMap(t =>
    wallets.map(w =>
      t.address === zeroAddress
        ? { target: MULTICALL3, allowFailure: true, callData: encodeFunctionData({ abi: mc, functionName: "getEthBalance", args: [w] }) }
        : { target: getAddress(t.address), allowFailure: true, callData: encodeFunctionData({ abi: mc, functionName: "balanceOf", args: [w] }) },
    ),
  );
  const out: bigint[] = [];
  for (let i = 0; i < calls.length; i += 400) {
    const data = await rpc<Hex>(c.id, "eth_call", [{ to: MULTICALL3, data: encodeFunctionData({ abi: abi.multicall3, functionName: "aggregate3", args: [calls.slice(i, i + 400)] }) }, "latest"]);
    for (const r of decodeFunctionResult({ abi: abi.multicall3, functionName: "aggregate3", data })) out.push(r.success && r.returnData.length >= 66 ? BigInt(r.returnData.slice(0, 66)) : 0n);
  }
  return tokens.map((t, i) => ({ symbol: t.symbol, address: getAddress(t.address), decimals: t.decimals, each: out.slice(i * wallets.length, (i + 1) * wallets.length) }));
}

/** Dollar prices by `chainId:address` (the native coin is the zero address). No entry: no price. */
async function prices(need: { chainId: number; address: Address; symbol: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const k = (x: { chainId: number; address: Address }) => `${x.chainId}:${x.address.toLowerCase()}`;
  const key = process.env.ALCHEMY_API_KEY;
  const todo = need.filter(x => (STABLE.test(x.symbol) ? (out.set(k(x), 1), false) : true)); // every token here is from our own list
  if (!key || !todo.length) return out;
  const syms = [...new Set(todo.filter(x => x.address === zeroAddress).map(x => x.symbol))];
  if (syms.length) {
    const j = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?${syms.map(s => `symbols=${s}`).join("&")}`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
    for (const d of j?.data ?? []) {
      const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
      if (Number.isFinite(v)) for (const x of todo) if (x.address === zeroAddress && x.symbol.toUpperCase() === String(d.symbol).toUpperCase()) out.set(k(x), v);
    }
  }
  const toks = todo.filter(x => x.address !== zeroAddress && alchemyNetwork(x.chainId));
  for (let i = 0; i < toks.length; i += 25) {
    const part = toks.slice(i, i + 25);
    const j = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses: part.map(x => ({ network: alchemyNetwork(x.chainId), address: x.address })) }),
      cache: "no-store",
    }).then(r => r.json()).catch(() => null);
    for (const d of j?.data ?? []) {
      const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
      const x = part.find(y => alchemyNetwork(y.chainId) === d.network && y.address.toLowerCase() === String(d.address).toLowerCase());
      if (x && Number.isFinite(v)) out.set(k(x), v);
    }
  }
  return out;
}

const load = async <T>(key: string): Promise<T | null> => {
  const v = await kv(["GET", P + key]);
  return v ? (JSON.parse(v) as T) : null;
};

export const totals = () => load<Totals>("totals");

/** Reads the chains and saves new totals. One run at a time; a second caller gets what's saved. */
export async function refresh(): Promise<Totals | null> {
  if ((await kv(["SET", `${P}lock`, 1, "NX", "EX", 100])) !== "OK") return totals();
  try {
    const old = await load<State>("state");
    const st: State = old?.v === VERSION ? old : { v: VERSION, fee: 0, chains: {}, wallets: {}, days: {}, bal: {}, usd: old?.usd ?? [] };
    const relay = relayAddress();
    const coin = await prices(CHAINS.filter(c => !c.nativeIsUsdc).map(c => ({ chainId: c.id, address: zeroAddress, symbol: c.native.symbol })));
    const now = Math.floor(Date.now() / 1000);
    const deadline = Date.now() + 35_000;
    const unread = new Set<string>();
    const behind: string[] = [];
    await Promise.all(
      CHAINS.map(async c => {
        try {
          if (await scanChain(c, st, deadline, relay, c.nativeIsUsdc ? 1 : (coin.get(`${c.id}:${zeroAddress}`) ?? 0))) behind.push(c.name);
        } catch {
          unread.add(c.name);
        }
      }),
    );

    const addrs = Object.keys(st.wallets).map(w => getAddress(w));
    const held = new Map<number, Held[]>();
    await Promise.all(
      CHAINS.map(async c => {
        try {
          if (addrs.length) held.set(c.id, await balances(c, addrs));
        } catch {
          unread.add(c.name);
        }
      }),
    );
    const price = await prices([...held].flatMap(([chainId, hs]) => hs.filter(h => h.each.some(b => b > 0n)).map(h => ({ chainId, address: h.address, symbol: h.symbol }))));
    const perWallet = new Array<number>(addrs.length).fill(0); // in memory only
    for (const [chainId, hs] of held) {
      const coins: Record<string, number> = {};
      const noPrice: string[] = [];
      for (const h of hs) {
        const p = price.get(`${chainId}:${h.address.toLowerCase()}`);
        if (!h.each.some(b => b > 0n)) continue;
        if (p === undefined) {
          noPrice.push(h.symbol);
          continue;
        }
        h.each.forEach((b, i) => {
          const usd = Number(formatUnits(b, h.decimals)) * p;
          perWallet[i] += usd;
          coins[h.symbol] = (coins[h.symbol] ?? 0) + usd;
        });
      }
      st.bal[chainId] = { at: now, coins, noPrice };
    }

    const sum = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);
    const chains = CHAINS.map(c => ({
      id: c.id,
      name: c.name,
      usd: sum(st.bal[c.id]?.coins ?? {}),
      wallets: Object.values(st.wallets).filter(w => w.chains.includes(c.id)).length,
      stale: !held.has(c.id) && addrs.length > 0,
    }));
    const coins: Record<string, number> = {};
    for (const b of Object.values(st.bal)) for (const [s, v] of Object.entries(b.coins)) coins[s] = (coins[s] ?? 0) + v;
    const totalUsd = chains.reduce((s, c) => s + c.usd, 0);
    if (!st.usd.length || now - st.usd[st.usd.length - 1][0] > 55 * 60) st.usd = [...st.usd, [now, Math.round(totalUsd)] as [number, number]].slice(-24 * 120);

    const ws = Object.values(st.wallets);
    const born: Record<string, number> = {};
    for (const w of ws) born[day(w.first)] = (born[day(w.first)] ?? 0) + 1;
    const days = Array.from({ length: 30 }, (_, i) => day(now - (29 - i) * DAY)).map(date => ({ date, tx: st.days[date]?.tx ?? 0, new: born[date] ?? 0, fee: st.days[date]?.fee ?? 0 }));
    const t: Totals = {
      at: now,
      totalUsd,
      wallets: ws.length,
      funded: perWallet.filter(v => v >= 1).length,
      new7: ws.filter(w => w.first > now - 7 * DAY).length,
      new30: ws.filter(w => w.first > now - 30 * DAY).length,
      active7: ws.filter(w => w.last > now - 7 * DAY).length,
      active30: ws.filter(w => w.last > now - 30 * DAY).length,
      tx7: days.slice(-7).reduce((s, d) => s + d.tx, 0),
      tx30: days.reduce((s, d) => s + d.tx, 0),
      feeUsd: st.fee,
      fee7: days.slice(-7).reduce((s, d) => s + d.fee, 0),
      fee30: days.reduce((s, d) => s + d.fee, 0),
      chains: chains.filter(c => c.usd >= 0.01 || c.wallets || c.stale).sort((a, b) => b.usd - a.usd),
      coins: Object.entries(coins).map(([symbol, usd]) => ({ symbol, usd })).filter(c => c.usd >= 0.01).sort((a, b) => b.usd - a.usd),
      noPrice: [...new Set(Object.values(st.bal).flatMap(b => b.noPrice))],
      days,
      usd: st.usd,
      behind,
      unread: [...unread],
    };
    await kv(["SET", `${P}state`, JSON.stringify(st)]);
    await kv(["SET", `${P}totals`, JSON.stringify(t)]);
    return t;
  } finally {
    await kv(["DEL", `${P}lock`]).catch(() => {});
  }
}
