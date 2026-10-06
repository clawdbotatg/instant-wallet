import "server-only";
import { type Address, type Hex, size, slice } from "viem";
import { MODULE_FACTORY, MULTICALL3, PASSKEY_FACTORY, RECOVERY_7D } from "./config";
import { type Call, rolesAddress } from "./core";

/**
 * The relay's defences (review 2026-10-06): it pays gas up front, so it must not be made to pay for nothing.
 *   - only Instant Wallet shapes: token transfers, plain ETH sends, and the wallet's own changes (no arbitrary calls)
 *   - one submission per signed tx (a reverted Safe tx keeps its nonce, so a signed body could be replayed)
 *   - rate limits per IP and per wallet; a wallet whose relayed tx reverted is refused for a day; many reverts pause
 *     the relay for an hour
 *   - one send at a time per chain (relayer nonces)
 * State lives in Upstash Redis (RELAY_KV_URL / RELAY_KV_TOKEN, keys "iws:"), else in this instance's memory.
 */

const URL_ = process.env.RELAY_KV_URL;
const TOKEN = process.env.RELAY_KV_TOKEN;
const mem = new Map<string, { v: number; until: number }>();

async function kv(cmd: (string | number)[]): Promise<any> {
  if (!URL_ || !TOKEN) {
    const [op, k, ...rest] = cmd.map(String);
    const now = Date.now();
    const cur = mem.get(k);
    const live = cur && cur.until > now ? cur : undefined;
    if (op === "SET") {
      const ex = Number(rest[rest.indexOf("EX") + 1] || 3600);
      if (rest.includes("NX") && live) return null;
      mem.set(k, { v: Number(rest[0]) || 1, until: now + ex * 1000 });
      return "OK";
    }
    if (op === "INCR") {
      const v = (live?.v ?? 0) + 1;
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

export class RelayRefused extends Error {
  status: number;
  constructor(message: string, status = 429) {
    super(message);
    this.status = status;
  }
}

export async function admit(ip: string, safe: Address) {
  if (await flagged("paused")) throw new RelayRefused("The relay is paused for a bit. Try again in an hour, or send it yourself.", 503);
  if (await flagged(`bad:${safe}`)) throw new RelayRefused("This wallet's last relayed transaction failed on chain. Try again tomorrow.");
  if ((await bump(`ip:${ip}`, 3600)) > 60) throw new RelayRefused("Too many sends from here this hour.");
  if ((await bump(`safe:${safe}`, 3600)) > 40) throw new RelayRefused("Too many sends from this wallet this hour.");
}

export async function reverted(safe: Address) {
  await flag(`bad:${safe}`, 86_400);
  if ((await bump("reverts", 3600)) >= 10) await flag("paused", 3600);
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

/** Every call in a relayed batch must be one of the shapes Instant Wallet makes. */
export function checkCalls(safe: Address, calls: Call[]) {
  const own = new Set([safe, RECOVERY_7D, rolesAddress(safe), PASSKEY_FACTORY, MODULE_FACTORY].map(a => a.toLowerCase()));
  for (const c of calls) {
    const to = c.to.toLowerCase();
    if (own.has(to)) continue; // the wallet's own changes (owners still have to sign them)
    if (c.data === "0x") continue; // a plain ETH send
    if (c.value === 0n && size(c.data) === 68 && slice(c.data, 0, 4) === TRANSFER) continue; // an ERC-20 transfer
    throw new RelayRefused("The relay only sends transfers and wallet changes. Send this one from a wallet that pays its own gas.", 400);
  }
}

export const isMulticall = (a: Address) => a.toLowerCase() === MULTICALL3.toLowerCase();
export type { Hex };
