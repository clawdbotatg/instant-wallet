import "server-only";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Address, type Hex, createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, knownChain } from "./chains";
import { AUTH_TYPES, type ClaimAuth, authCall, usdc3009 } from "./claim";
import { kv } from "./kv";
import { upstreamRpc } from "./rpcServer";
import { MULTICALL3 } from "./safe/config";
import { abi } from "./safe/core";
import { GAS_BUDGET } from "./safe/fee";
import { L1_ALLOWANCE, clients, quote, tipFloor } from "./safe/relayCore";
import { withChainLock, withLock } from "./safe/relayGuard";

/**
 * Drops (docs/DROPS.md): one pot of money, many codes. A card code pays once; a crowd code (one QR on a slide) pays
 * each wallet once, until the cap or the window runs out. The server pays only a passkey wallet whose key signed
 * the claim, so a code is worth nothing without making an Instant Wallet.
 *
 * Each drop's pot is its own address. Its key is derived here from DROP_SECRET and the drop's id: no key is stored
 * anywhere, and one pot's key can't reach another's. USDC leaves the pot as two EIP-3009 transfers the relay submits
 * (the pot needs no gas, the relay's fee comes out of the pot); ETH leaves it as a plain send, the pot paying the gas.
 *
 * Storage (lib/kv.ts), keys "iws:drop:":
 *   d:<id>        the drop (JSON)          list           every drop id
 *   c:<CODE>      its drop id              codes:<id>     a card drop's codes, in order
 *   u:<CODE>      a used card (JSON)       w:<id>:<addr>  a crowd claim, one per wallet
 *   n:<id>        claims so far            log:<id>       every claim (JSON)
 *   s:<token>     an admin's session       nonce:<chain>:<pot>  an ETH pot's last nonce
 */

export type DropToken = "usdc" | "eth";
export type DropKind = "cards" | "crowd";
export type Drop = {
  id: string;
  name: string;
  chainId: number;
  token: DropToken;
  amount: string; // per claim, in the token's smallest unit; usd: in dollars (6 decimals), paid in ETH at the price then
  usd?: boolean;
  kind: DropKind;
  cap: number; // cards: how many were made; crowd: the most claims
  code?: string; // crowd: the one code
  closesAt?: number; // ms; none = open until ended
  paused?: boolean;
  ended?: boolean;
  admin: Address;
  createdAt: number;
};
export type ClaimRecord = { code: string; wallet: Address; tx: Hex; at: number };

export const DROP_CHAINS = [8453, 1].filter(id => CHAINS.some(c => c.id === id));
export const decimals = (t: DropToken) => (t === "usdc" ? 6 : 18);

const P = "iws:drop:";
const ETH_DUST = 50_000_000_000_000n; // 0.00005 ETH: not worth moving (take back leaves it)

export class DropRefused extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- the pot's key

function secret(): Uint8Array {
  const s = process.env.DROP_SECRET;
  if (!s) {
    if (process.env.VERCEL_ENV === "production") throw new Error("drops not configured");
    return new TextEncoder().encode("instant-wallet local dev drops");
  }
  return new TextEncoder().encode(s);
}

export function potKey(id: string): Hex {
  const k = toHex(hkdf(sha256, secret(), new TextEncoder().encode("instant-wallet drops"), new TextEncoder().encode(id), 32));
  privateKeyToAccount(k); // throws on the (2^-128) key that isn't a valid secp256k1 scalar
  return k;
}
export const potAddress = (id: string) => privateKeyToAccount(potKey(id)).address;

// ---------------------------------------------------------------- codes

const ALPHA = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
export function newCode(n: number): string {
  let s = "";
  while (s.length < n) for (const x of crypto.getRandomValues(new Uint8Array(n))) if (x < 248 && s.length < n) s += ALPHA[x % 31]; // 248 = 8 × 31: no bias
  return s;
}
export const normCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 24);

// ---------------------------------------------------------------- the drop list

const id8 = () => newCode(8).toLowerCase();
export const getDrop = async (id: string): Promise<Drop | null> => {
  const v = await kv(["GET", `${P}d:${id}`]);
  return v ? (JSON.parse(v) as Drop) : null;
};
const saveDrop = (d: Drop) => kv(["SET", `${P}d:${d.id}`, JSON.stringify(d)]);
export const listDrops = async (): Promise<Drop[]> => {
  const ids = (await kv(["SMEMBERS", `${P}list`])) as string[];
  const all = await Promise.all(ids.map(getDrop));
  return all.filter((d): d is Drop => !!d).sort((a, b) => b.createdAt - a.createdAt);
};
export const claimedCount = async (id: string) => Number((await kv(["GET", `${P}n:${id}`])) ?? 0);
export const cardCodes = async (id: string): Promise<string[]> => kv(["LRANGE", `${P}codes:${id}`, 0, -1]);
export const usedCard = async (code: string): Promise<ClaimRecord | "pending" | null> => {
  const v = await kv(["GET", `${P}u:${code}`]);
  return v === null ? null : v === "pending" ? "pending" : (JSON.parse(v) as ClaimRecord);
};
export const walletClaimed = async (id: string, wallet: string) => (await kv(["GET", `${P}w:${id}:${wallet.toLowerCase()}`])) !== null;
export const claims = async (id: string): Promise<ClaimRecord[]> => ((await kv(["LRANGE", `${P}log:${id}`, 0, -1])) as string[]).map(x => JSON.parse(x));

export type NewDrop = { name: string; chainId: number; token: DropToken; amount: string; kind: DropKind; count: number; minutes?: number; code?: string };

export async function createDrop(admin: Address, n: NewDrop): Promise<Drop> {
  const name = String(n.name ?? "").trim().slice(0, 60) || "Drop";
  if (!DROP_CHAINS.includes(Number(n.chainId))) throw new DropRefused("That network isn't on for drops.");
  if (n.token !== "usdc" && n.token !== "eth") throw new DropRefused("USDC or ETH.");
  if (n.kind !== "cards" && n.kind !== "crowd") throw new DropRefused("Cards or crowd?");
  let amount: bigint;
  try {
    amount = parseUnits(String(n.amount).trim(), 6); // dollars, for ETH too

  } catch {
    throw new DropRefused("That amount doesn't look right.");
  }
  if (amount <= 0n) throw new DropRefused("The amount must be more than 0.");
  const count = Math.floor(Number(n.count));
  const max = n.kind === "cards" ? 500 : 10_000;
  if (!(count >= 1 && count <= max)) throw new DropRefused(n.kind === "cards" ? "1 to 500 cards." : "A cap of 1 to 10,000 claims.");
  const minutes = n.minutes ? Math.floor(Number(n.minutes)) : 0;
  if (minutes < 0 || minutes > 60 * 24 * 365) throw new DropRefused("The window doesn't look right.");
  const d: Drop = {
    id: id8(),
    name,
    chainId: Number(n.chainId),
    token: n.token,
    amount: amount.toString(),
    ...(n.token === "eth" ? { usd: true } : {}),
    kind: n.kind,
    cap: count,
    admin,
    createdAt: Date.now(),
    ...(minutes ? { closesAt: Date.now() + minutes * 60_000 } : {}),
  };
  if (d.kind === "crowd") {
    const code = n.code ? normCode(n.code) : newCode(6);
    if (code.length < 4) throw new DropRefused("The code needs at least 4 letters or digits.");
    if ((await kv(["SET", `${P}c:${code}`, d.id, "NX"])) !== "OK") throw new DropRefused(`The code ${code} is taken. Pick another.`);
    d.code = code;
  } else {
    const codes: string[] = [];
    while (codes.length < count) {
      const c = newCode(10);
      if ((await kv(["SET", `${P}c:${c}`, d.id, "NX"])) === "OK") codes.push(c);
    }
    for (let i = 0; i < codes.length; i += 100) await kv(["RPUSH", `${P}codes:${d.id}`, ...codes.slice(i, i + 100)]);
  }
  await saveDrop(d);
  await kv(["SADD", `${P}list`, d.id]);
  return d;
}

export async function updateDrop(id: string, ch: { paused?: boolean; ended?: boolean; minutes?: number }): Promise<Drop> {
  const d = await getDrop(id);
  if (!d) throw new DropRefused("No such drop.", 404);
  if (typeof ch.paused === "boolean") d.paused = ch.paused;
  if (ch.ended) d.ended = true;
  if (typeof ch.minutes === "number") {
    if (ch.minutes > 0) d.closesAt = Date.now() + Math.floor(ch.minutes) * 60_000;
    else delete d.closesAt;
  }
  await saveDrop(d);
  return d;
}

/** Why a drop can't pay now, or null. */
export function closed(d: Drop, claimed: number): string | null {
  if (d.ended) return "This drop has ended.";
  if (d.paused) return "This drop is paused. Try again in a bit.";
  if (d.closesAt && Date.now() > d.closesAt) return "This drop has closed.";
  if (d.kind === "crowd" && claimed >= d.cap) return "All gone: everyone already claimed this one.";
  return null;
}

export async function byCode(raw: string): Promise<{ code: string; drop: Drop } | null> {
  const code = normCode(raw);
  if (code.length < 4) return null;
  const id = await kv(["GET", `${P}c:${code}`]);
  const drop = id && (await getDrop(id));
  return drop ? { code, drop } : null;
}

// ---------------------------------------------------------------- claiming

async function bump(key: string, ttl: number) {
  const v = Number(await kv(["INCR", P + key]));
  if (v === 1) await kv(["EXPIRE", P + key, ttl]);
  return v;
}

/**
 * Pay one claim. The caller has checked the passkey. Reserve first (the card, or this wallet's crowd claim, and a
 * place under the cap), then send; a send that fails gives the reservation back, so a failure never burns a code
 * and a retry never pays twice.
 */
export async function claim(code: string, d: Drop, wallet: Address, ip: string): Promise<{ hash: Hex }> {
  if ((await bump(`ip:${ip}`, 3600)) > 300) throw new DropRefused("Too many claims from here this hour.", 429);
  const why = closed(d, await claimedCount(d.id));
  if (why) throw new DropRefused(why, 410);
  const hold = d.kind === "cards" ? `${P}u:${code}` : `${P}w:${d.id}:${wallet.toLowerCase()}`;
  if ((await kv(["SET", hold, "pending", "NX"])) !== "OK") {
    if (d.kind === "crowd") throw new DropRefused("This wallet already claimed this one.", 409);
    throw new DropRefused("This card was claimed already.", 410);
  }
  const n = Number(await kv(["INCR", `${P}n:${d.id}`]));
  const release = async () => {
    await kv(["DEL", hold]);
    await kv(["DECR", `${P}n:${d.id}`]);
  };
  if (d.kind === "crowd" && n > d.cap) {
    await release();
    throw new DropRefused("All gone: everyone already claimed this one.", 410);
  }
  let hash: Hex;
  try {
    hash = d.token === "usdc" ? await sendUsdc(d.chainId, potKey(d.id), wallet, BigInt(d.amount)) : await sendEth(d.chainId, potKey(d.id), wallet, await weiOf(d));
  } catch (e) {
    await release();
    throw e;
  }
  const rec: ClaimRecord = { code, wallet, tx: hash, at: Date.now() };
  await kv(["SET", hold, JSON.stringify(rec)]);
  await kv(["RPUSH", `${P}log:${d.id}`, JSON.stringify(rec)]);
  return { hash };
}

// ---------------------------------------------------------------- the ETH price

// Uniswap v3 WETH/USDC 0.05%, the deepest pool on each chain. [pool, true if USDC is token0]
const POOLS: Record<number, [Address, boolean]> = {
  1: ["0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", true],
  8453: ["0xd0b53D9277642d899DF5C87A3966A349A798F224", false],
};
const slot0 = [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }] as const;

/** Dollars per ETH, from the pool right now. */
export async function ethUsd(chainId: number): Promise<number> {
  const [pool, usdcFirst] = POOLS[chainId] ?? POOLS[1];
  const pc = createPublicClient({ chain: knownChain(POOLS[chainId] ? chainId : 1)!.chain, transport: http(upstreamRpc(POOLS[chainId] ? chainId : 1)) });
  const [sqrt] = await pc.readContract({ address: pool, abi: slot0, functionName: "slot0" });
  const p = (Number(sqrt) / 2 ** 96) ** 2; // token1 per token0, smallest units
  const v = usdcFirst ? 1e12 / p : p * 1e12;
  if (!(v > 100 && v < 1e6)) throw new Error("no ETH price");
  return v;
}

/** What one claim pays, in wei. */
export async function weiOf(d: Drop, price?: number): Promise<bigint> {
  if (!d.usd) return BigInt(d.amount);
  return (BigInt(d.amount) * 10n ** 12n * 1_000_000n) / BigInt(Math.round((price ?? (await ethUsd(d.chainId))) * 1e6));
}

// ---------------------------------------------------------------- moving money out of a pot

const usdcOf = (chainId: number) => getAddress(CHAINS.find(c => c.id === chainId)!.usdc!);
const domains = new Map<number, { name: string; version: string }>();

/** What one USDC claim costs the pot in fees right now (6 decimals). */
export const usdcFee = async (chainId: number) => BigInt((await quote(chainId, "claim")).feeUsdc);

/** USDC: the pot signs value → `to` and the fee → the relay; the relay submits both. "all" = everything but the fee. */
export async function sendUsdc(chainId: number, key: Hex, to: Address, value: bigint | "all"): Promise<Hex> {
  const { info, pc, wc } = clients(chainId);
  const pot = privateKeyToAccount(key);
  const usdc = usdcOf(chainId);
  const [q, bal] = await Promise.all([quote(chainId, "claim"), pc.readContract({ address: usdc, abi: abi.erc20, functionName: "balanceOf", args: [pot.address] }) as Promise<bigint>]);
  const fee = BigInt(q.feeUsdc);
  const v = value === "all" ? bal - fee : value;
  if (v <= 0n || bal < v + fee) throw new DropRefused("The pot is empty. Ask whoever made this drop to top it up.", 410);
  let dom = domains.get(chainId);
  if (!dom) {
    const [name, version] = await Promise.all([pc.readContract({ address: usdc, abi: usdc3009, functionName: "name" }), pc.readContract({ address: usdc, abi: usdc3009, functionName: "version" })]);
    domains.set(chainId, (dom = { name, version }));
  }
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sign = async (dest: Address, amount: bigint): Promise<ClaimAuth> => {
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const sig = await pot.signTypedData({
      domain: { name: dom.name, version: dom.version, chainId, verifyingContract: usdc },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: pot.address, to: dest, value: amount, validAfter: 0n, validBefore, nonce },
    });
    return {
      from: pot.address,
      to: dest,
      value: amount.toString(),
      validAfter: "0",
      validBefore: validBefore.toString(),
      nonce,
      r: `0x${sig.slice(2, 66)}` as Hex,
      s: `0x${sig.slice(66, 130)}` as Hex,
      v: parseInt(sig.slice(130, 132), 16),
    };
  };
  const auths = [await sign(to, v), await sign(wc.account.address, fee)];
  const data = encodeFunctionData({
    abi: abi.multicall3,
    functionName: "aggregate3",
    args: [auths.map(a => ({ target: usdc, allowFailure: false, callData: authCall(a) }))],
  });
  const me = wc.account.address;
  const gas = await pc.estimateGas({ account: me, to: MULTICALL3, data, maxFeePerGas: BigInt(q.gasPrice), maxPriorityFeePerGas: 1n }).catch((e: any) => {
    throw new Error(`it would fail on chain: ${e?.shortMessage || e?.message || e}`);
  });
  if (gas > GAS_BUDGET.claim) throw new Error("that claim costs more gas than it should");
  const fees = await tipped(pc, chainId);
  const hash = await withChainLock(chainId, () => wc.sendTransaction({ to: MULTICALL3, data, gas: (gas * 13n) / 10n, chain: info.chain, ...fees }));
  await landed(pc, hash).catch(async e => {
    // many claims at once each saw enough in the pot; the ones that ran it dry say so
    const now = (await pc.readContract({ address: usdc, abi: abi.erc20, functionName: "balanceOf", args: [pot.address] }).catch(() => 0n)) as bigint;
    throw now < v + fee ? new DropRefused("The pot is empty. Ask whoever made this drop to top it up.", 410) : e;
  });
  return hash;
}

/** ETH: the pot sends it and pays the gas. One send at a time per pot (its nonce). "all" = everything but the gas. */
export async function sendEth(chainId: number, key: Hex, to: Address, value: bigint | "all"): Promise<Hex> {
  const { info, pc } = clients(chainId);
  const pot = privateKeyToAccount(key);
  const wc = createWalletClient({ chain: info.chain, transport: http(upstreamRpc(chainId)!), account: pot });
  const hash = await withLock(`pot:${chainId}:${pot.address}`, async () => {
    const [f, bal, pending, last] = await Promise.all([
      tipped(pc, chainId, true),
      pc.getBalance({ address: pot.address }),
      pc.getTransactionCount({ address: pot.address, blockTag: "pending" }),
      kv(["GET", `${P}nonce:${chainId}:${pot.address}`]),
    ]);
    // a Safe's receive() costs a little more than a plain address; an undeployed wallet is a plain address
    const gas = ((await pc.estimateGas({ account: pot.address, to, value: 1n }).catch(() => 60_000n)) * 12n) / 10n;
    const cost = gas * f.maxFeePerGas + (chainId === 1 ? 0n : 1_000_000_000_000n); // + an L2's L1 data fee
    const v = value === "all" ? bal - cost : value;
    if (v <= 0n || bal < v + cost) throw new DropRefused("The pot is empty. Ask whoever made this drop to top it up.", 410);
    // a load-balanced RPC can lag our own last send: never reuse a nonce
    const nonce = last !== null && Number(last) + 1 > pending ? Number(last) + 1 : pending;
    const h = await wc.sendTransaction({ to, value: v, gas, nonce, chain: info.chain, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas });
    await kv(["SET", `${P}nonce:${chainId}:${pot.address}`, nonce, "EX", 3600]);
    return h;
  });
  await landed(pc, hash);
  return hash;
}

async function tipped(pc: ReturnType<typeof clients>["pc"], chainId: number, always = false): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const floor = tipFloor(chainId);
  if (!floor && !always) return {} as any;
  const f = await pc.estimateFeesPerGas();
  const tip = f.maxPriorityFeePerGas > floor ? f.maxPriorityFeePerGas : floor;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: f.maxFeePerGas - f.maxPriorityFeePerGas + tip };
}

/** Wait for it; a revert is a failed claim (the reservation goes back). A slow chain past the wait counts as sent. */
async function landed(pc: ReturnType<typeof clients>["pc"], hash: Hex) {
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 45_000 }).catch(() => null);
  if (rc && rc.status !== "success") throw new Error("The transfer failed on chain. Try again.");
}

export async function potBalances(d: Drop): Promise<{ address: Address; usdc: string; eth: string; feeUsdc: string; gasEth: string; ethUsd: number; each: string }> {
  const { pc } = clients(d.chainId);
  const address = potAddress(d.id);
  const [usdc, eth, feeUsdc, f, price] = await Promise.all([
    pc.readContract({ address: usdcOf(d.chainId), abi: abi.erc20, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
    pc.getBalance({ address }),
    usdcFee(d.chainId).catch(() => 0n),
    pc.estimateFeesPerGas().catch(() => ({ maxFeePerGas: 0n })),
    ethUsd(d.chainId).catch(() => 0),
  ]);
  const gasEth = 30_000n * f.maxFeePerGas + (d.chainId === 1 ? 0n : L1_ALLOWANCE);
  const each = d.token === "usdc" ? BigInt(d.amount) : price ? await weiOf(d, price) : 0n; // per claim, in the token
  return { address, usdc: usdc.toString(), eth: eth.toString(), feeUsdc: feeUsdc.toString(), gasEth: gasEth.toString(), ethUsd: price, each: each.toString() };
}

/** Everything left in the pot (USDC and ETH) to `to`. */
export async function takeBack(d: Drop, to: Address): Promise<Hex[]> {
  const b = await potBalances(d);
  const out: Hex[] = [];
  if (BigInt(b.usdc) > BigInt(b.feeUsdc)) out.push(await sendUsdc(d.chainId, potKey(d.id), to, "all"));
  if (BigInt(b.eth) > ETH_DUST) out.push(await sendEth(d.chainId, potKey(d.id), to, "all"));
  if (!out.length) throw new DropRefused("Nothing to take back.");
  return out;
}

// ---------------------------------------------------------------- admins

/** DROP_ADMINS: wallet addresses, comma-separated. Unset in local dev = anyone. */
export function isAdmin(w: Address): boolean {
  const list = process.env.DROP_ADMINS;
  if (!list) return process.env.VERCEL_ENV !== "production" && process.env.NODE_ENV !== "production";
  return list.split(",").some(a => a.trim().toLowerCase() === w.toLowerCase());
}
export async function newSession(w: Address): Promise<string> {
  const t = toHex(crypto.getRandomValues(new Uint8Array(24))).slice(2);
  await kv(["SET", `${P}s:${t}`, w, "EX", 12 * 3600]);
  return t;
}
export async function sessionWallet(t: unknown): Promise<Address | null> {
  if (typeof t !== "string" || !/^[0-9a-f]{48}$/.test(t)) return null;
  const w = await kv(["GET", `${P}s:${t}`]);
  return w && isAdmin(w) ? getAddress(w) : null;
}

/** Wallet login (atg.eth etc.): a one-time message, signed in any wallet (EOA or smart wallet, checked on Ethereum). */
export async function walletChallenge(): Promise<string> {
  const n = toHex(crypto.getRandomValues(new Uint8Array(12))).slice(2);
  await kv(["SET", `${P}ch:${n}`, "1", "EX", 600]);
  return `Log in to Instant Wallet drops\nnonce: ${n}`;
}
export async function walletLogin(wallet: Address, message: string, signature: Hex): Promise<boolean> {
  const n = /\nnonce: ([0-9a-f]{24})$/.exec(message)?.[1];
  if (!n || !(await kv(["DEL", `${P}ch:${n}`]))) return false;
  return createPublicClient({ chain: knownChain(1)!.chain, transport: http(upstreamRpc(1)) }).verifyMessage({ address: wallet, message, signature });
}
