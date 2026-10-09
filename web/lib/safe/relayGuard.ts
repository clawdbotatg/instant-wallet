import "server-only";
import { type Address, type Hex, keccak256, size, slice } from "viem";
import { MODULE_FACTORY, MULTICALL3, PASSKEY_FACTORY, RECOVERY_7D, ROLES_MASTERCOPY } from "./config";
import { type Call, rolesAddress } from "./core";
import { approvesRouter, checkSwap, isSwapTarget } from "./swap";

/**
 * The relay's defences (review 2026-10-06): it pays gas up front, so it must not be made to pay for nothing.
 *   - only Instant Wallet shapes: token transfers, plain ETH sends, the wallet's own changes, and swaps through a
 *     known router that pay this wallet with no approval left behind; arbitrary calls only in an owner-signed
 *     batch from a site (WalletConnect), never into the wallet itself, and its reverts count like a swap's
 *   - one submission per signed tx (a reverted Safe tx keeps its nonce, so a signed body could be replayed)
 *   - rate limits per IP and per wallet; a wallet whose relayed tx reverted is refused for a day; many reverts pause
 *     the relay for an hour
 *   - one send at a time per chain (relayer nonces)
 * State lives in Upstash Redis (RELAY_KV_URL / RELAY_KV_TOKEN, keys "iws:"), else in this instance's memory.
 */

const URL_ = process.env.RELAY_KV_URL;
const TOKEN = process.env.RELAY_KV_TOKEN;
const mem = new Map<string, { v: number | string; until: number }>();

async function kv(cmd: (string | number)[]): Promise<any> {
  if (!URL_ || !TOKEN) {
    // memory is per serverless instance: fine for a local fork, not for production
    if (process.env.VERCEL_ENV === "production") throw new RelayRefused("relay storage not configured", 503);
    const [op, k, ...rest] = cmd.map(String);
    const now = Date.now();
    const cur = mem.get(k);
    const live = cur && cur.until > now ? cur : undefined;
    if (op === "SET") {
      const ex = rest.includes("EX") ? Number(rest[rest.indexOf("EX") + 1]) : 3600;
      if (rest.includes("NX") && live) return null;
      mem.set(k, { v: rest[0] ?? 1, until: now + ex * 1000 });
      return "OK";
    }
    if (op === "INCR") {
      const v = Number(live?.v ?? 0) + 1;
      mem.set(k, { v, until: live?.until ?? now + 3600_000 });
      return v;
    }
    if (op === "EXPIRE") {
      if (live) live.until = now + Number(rest[0]) * 1000;
      return 1;
    }
    if (op === "GET") return live ? String(live.v) : null;
    if (op === "DEL") return mem.delete(k) ? 1 : 0;
    return null;
  }
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
    cache: "no-store",
  });
  const j = await r.json();
  if (j.error) throw new Error(`kv: ${j.error}`);
  return j.result;
}

const P = "iws:relay:";

/** First caller wins (SET NX). */
export async function once(key: string, ttlSec: number): Promise<boolean> {
  return (await kv(["SET", P + key, 1, "NX", "EX", ttlSec])) === "OK";
}

async function bump(key: string, ttlSec: number): Promise<number> {
  const v = Number(await kv(["INCR", P + key]));
  if (v === 1) await kv(["EXPIRE", P + key, ttlSec]);
  return v;
}

export async function flagged(key: string): Promise<boolean> {
  return (await kv(["GET", P + key])) !== null;
}

export async function flag(key: string, ttlSec: number) {
  await kv(["SET", P + key, 1, "EX", ttlSec]);
}

/** A JSON value kept for a while (a transaction parked for the wedgie). */
export async function stash(key: string, v: unknown, ttlSec: number) {
  await kv(["SET", P + key, JSON.stringify(v), "EX", ttlSec]);
}
export async function unstash<T>(key: string): Promise<T | null> {
  const v = await kv(["GET", P + key]);
  try {
    return v === null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}
export async function drop(key: string) {
  await kv(["DEL", P + key]);
}

export class RelayRefused extends Error {
  status: number;
  constructor(message: string, status = 429) {
    super(message);
    this.status = status;
  }
}

export async function admit(ip: string, safe: Address) {
  if (await flagged(`badip:${ip}`)) throw new RelayRefused("A send from here failed on chain recently. Try again tomorrow.");
  if (await flagged(`bad:${safe}`)) throw new RelayRefused("This wallet's last relayed transaction failed on chain. Try again tomorrow.");
  if ((await bump(`ip:${ip}`, 3600)) > 60) throw new RelayRefused("Too many sends from here this hour.");
  if ((await bump(`safe:${safe}`, 3600)) > 40) throw new RelayRefused("Too many sends from this wallet this hour.");
}

/**
 * A relayed tx reverted: refuse that wallet and that IP for a day (no global pause: it would be a free outage).
 * A swap or a site's call can revert honestly (the price moved past the slippage between the estimate and the
 * block): the third one in a day counts.
 */
export async function reverted(safe: Address, ip: string, swap = false) {
  if (swap && (await bump(`swaprev:${safe}`, 86_400)) < 3) return;
  await flag(`bad:${safe}`, 86_400);
  await flag(`badip:${ip}`, 86_400);
}

/** A per-chain lock around nonce pick + broadcast. */
export async function withChainLock<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const key = `lock:${chainId}`;
  for (let i = 0; i < 40; i++) {
    if (await once(key, 20)) {
      try {
        return await fn();
      } finally {
        await kv(["DEL", P + key]).catch(() => {});
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new RelayRefused("The relay is busy. Try again.", 503);
}

const TRANSFER = "0xa9059cbb";

const sel = (d: Hex) => (size(d) >= 4 ? slice(d, 0, 4) : "0x");
/** Safe owner/module functions, Candide guardian/recovery functions, Roles admin: the wallet's own changes. */
const SAFE_SELF = new Set([
  "0xe318b52b", // swapOwner
  "0x0d582f13", // addOwnerWithThreshold
  "0xf8dc5dd9", // removeOwner
  "0x694e80c3", // changeThreshold
  "0x610b5925", // enableModule
  "0xe009cfde", // disableModule
]);

/**
 * Every call in a relayed batch must be one of the shapes Instant Wallet makes (review 2: anything that can run
 * attacker code could pass the estimate and revert on chain). The owners still sign every one of them.
 */
export async function checkCalls(
  safe: Address,
  calls: Call[],
  plainRecipient: (a: Address) => Promise<boolean>,
  allowDapp = false,
): Promise<{ swap: boolean; dapp: boolean }> {
  const roles = rolesAddress(safe).toLowerCase();
  let swap = false;
  let dapp = false;
  try {
    swap = checkSwap(safe, calls);
  } catch (e: any) {
    throw new RelayRefused(`The relay won't send this swap: ${e.message}.`, 400);
  }
  for (const c of calls) {
    const to = c.to.toLowerCase();
    const s = sel(c.data);
    if (to === safe.toLowerCase() && c.value === 0n && SAFE_SELF.has(s)) continue;
    if (to === RECOVERY_7D.toLowerCase() && c.value === 0n) continue; // Candide: guardians, cancel
    if (to === roles && c.value === 0n) continue; // Roles admin (only the Safe, its owner, may call it)
    if (to === PASSKEY_FACTORY.toLowerCase() && c.value === 0n && s === "0x0d2f0489") continue; // createSigner
    if (
      to === MODULE_FACTORY.toLowerCase() &&
      c.value === 0n &&
      s === "0xf1ab873c" && // deployModule(ROLES_MASTERCOPY, …)
      slice(c.data, 16, 36).toLowerCase() === ROLES_MASTERCOPY.toLowerCase()
    )
      continue;
    if (c.data === "0x" && (await plainRecipient(c.to))) continue; // ETH to an account, a 7702 account, or a Safe
    if (c.value === 0n && size(c.data) === 68 && s === TRANSFER) continue; // an ERC-20 transfer
    if (isSwapTarget(c.to) || approvesRouter(c)) continue; // a swap: checked above (receiver, approvals)
    // a site's call (WalletConnect), owner-signed: anything but the wallet's own guts (its guard, fallback, modules)
    if (allowDapp && to !== safe.toLowerCase() && to !== roles && to !== RECOVERY_7D.toLowerCase()) {
      dapp = true;
      continue;
    }
    throw new RelayRefused(
      c.data === "0x"
        ? "The relay doesn't send ETH to contracts. Send this one from a wallet that pays its own gas."
        : "The relay only sends transfers and wallet changes. Send this one from a wallet that pays its own gas.",
      400,
    );
  }
  return { swap, dapp };
}

/** Runtime code hashes of SafeProxy 1.3.0 and 1.5.0, and the singletons a real Safe points at. */
const SAFE_PROXY_CODE = new Set([
  "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000", // 1.3.0 (dao.buidlguidl.eth)
  "0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f", // 1.5.0
]);
const SAFE_SINGLETONS = new Set(
  [
    "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
    "0x3E5c63644E683549055b9Be8653de26E0B4CD36E",
    "0x69f4D1788e39c87893C980c06EdF4b7f686e2938",
    "0xfb1bffC9d739B8D520DaF37dF666da4C687191EA",
    "0x41675C099F32341bf84BFc5382aF534df5C7461a",
    "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
    "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
  ].map(a => a.toLowerCase()),
);

/** Can the relay send ETH here without running someone's arbitrary code? */
export function plainRecipientCheck(getCode: (a: Address) => Promise<Hex | undefined>, getSlot0: (a: Address) => Promise<Hex | undefined>) {
  return async (a: Address): Promise<boolean> => {
    const code = await getCode(a);
    if (!code || code === "0x") return true;
    if (code.startsWith("0xef0100") && size(code) === 23) return true; // EIP-7702: an EOA with delegated code
    if (!SAFE_PROXY_CODE.has(keccak256(code))) return false;
    const slot = await getSlot0(a);
    return !!slot && SAFE_SINGLETONS.has(("0x" + slot.slice(-40)).toLowerCase());
  };
}

export const isMulticall = (a: Address) => a.toLowerCase() === MULTICALL3.toLowerCase();
export type { Hex };
