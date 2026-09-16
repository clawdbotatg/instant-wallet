import type { DeviceInfo, FirstKey, WalletRequest } from "./types";
import { Redis } from "@upstash/redis";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { chainId } from "~~/utils/chain";

/**
 * The device-queue store: requests, device announces, signer->wallet pairings, signer labels.
 *
 * Two backends behind one async API:
 *  - Redis (Upstash REST) when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set — what a
 *    serverless host needs. Everything lives under `iw:<chainId>:` (the database is shared with
 *    another project, the prefix is mandatory): hashes `…:requests` (field = id -> JSON),
 *    `…:devices` (signerId -> JSON), `…:pairings` (signerId -> wallet), `…:labels`
 *    (`<wallet>:<signerId>` -> label), `…:keys` (wallet -> first key JSON, for counterfactual wallets). One request = one hash field, so patching a request is a
 *    single HSET and never a read-modify-write of the whole queue.
 *  - A JSON file in .instant/ (gitignored) otherwise — fine for one dev process.
 */

const PREFIX = `iw:${chainId}:`;
export const KEYS = {
  requests: `${PREFIX}requests`,
  devices: `${PREFIX}devices`,
  pairings: `${PREFIX}pairings`,
  labels: `${PREFIX}labels`,
  keys: `${PREFIX}keys`,
};
const MAX_REQUESTS = 300;

type Backend = {
  name: "redis" | "json";
  allRequests(): Promise<WalletRequest[]>;
  getRequest(id: string): Promise<WalletRequest | undefined>;
  putRequest(r: WalletRequest): Promise<void>;
  delRequests(ids: string[]): Promise<void>;
  allDevices(): Promise<Record<string, DeviceInfo>>;
  getDevice(signerId: string): Promise<DeviceInfo | undefined>;
  putDevice(signerId: string, d: DeviceInfo): Promise<void>;
  getPairing(signerId: string): Promise<`0x${string}` | undefined>;
  putPairing(signerId: string, wallet: `0x${string}`): Promise<void>;
  allLabels(): Promise<Record<string, string>>;
  putLabel(key: string, label: string): Promise<void>;
  getKey(wallet: string): Promise<FirstKey | undefined>;
  putKey(wallet: string, k: FirstKey): Promise<void>;
};

// ---------------------------------------------------------------- redis backend
function redisBackend(url: string, token: string): Backend {
  const r = new Redis({ url, token });
  const parse = <T>(v: unknown): T | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as T;
      } catch {
        return undefined;
      }
    }
    return v as T; // the client auto-deserializes JSON values
  };
  const parseAll = <T>(h: Record<string, unknown> | null): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(h ?? {})) {
      const p = parse<T>(v);
      if (p !== undefined) out[k] = p;
    }
    return out;
  };
  return {
    name: "redis",
    allRequests: async () => Object.values(parseAll<WalletRequest>(await r.hgetall(KEYS.requests))),
    getRequest: async id => parse<WalletRequest>(await r.hget(KEYS.requests, id)),
    putRequest: async req => {
      await r.hset(KEYS.requests, { [req.id]: JSON.stringify(req) });
    },
    delRequests: async ids => {
      if (ids.length) await r.hdel(KEYS.requests, ...ids);
    },
    allDevices: async () => parseAll<DeviceInfo>(await r.hgetall(KEYS.devices)),
    getDevice: async id => parse<DeviceInfo>(await r.hget(KEYS.devices, id)),
    putDevice: async (id, d) => {
      await r.hset(KEYS.devices, { [id]: JSON.stringify(d) });
    },
    getPairing: async id => ((await r.hget(KEYS.pairings, id)) as `0x${string}` | null) ?? undefined,
    putPairing: async (id, w) => {
      await r.hset(KEYS.pairings, { [id]: w });
    },
    allLabels: async () => ((await r.hgetall(KEYS.labels)) as Record<string, string> | null) ?? {},
    putLabel: async (k, label) => {
      await r.hset(KEYS.labels, { [k]: label });
    },
    getKey: async w => parse<FirstKey>(await r.hget(KEYS.keys, w)),
    putKey: async (w, k) => {
      await r.hset(KEYS.keys, { [w]: JSON.stringify(k) });
    },
  };
}

// ---------------------------------------------------------------- json backend
type FileStore = {
  requests: Record<string, WalletRequest>;
  devices: Record<string, DeviceInfo>;
  pairings: Record<string, `0x${string}`>;
  labels: Record<string, string>;
  keys: Record<string, FirstKey>;
};

function jsonBackend(): Backend {
  const FILE = process.env.INSTANT_STORE_PATH || join(process.cwd(), ".instant", `store-${chainId}.json`);
  const g = globalThis as unknown as { __instantStore?: FileStore };
  const empty = (): FileStore => ({ requests: {}, devices: {}, pairings: {}, labels: {}, keys: {} });
  const read = (): FileStore => {
    if (g.__instantStore) return g.__instantStore;
    let s = empty();
    if (existsSync(FILE)) {
      try {
        const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<FileStore> & { requests?: unknown };
        s = { ...empty(), ...raw } as FileStore;
        // older files kept requests as an array
        if (Array.isArray(raw.requests))
          s.requests = Object.fromEntries((raw.requests as WalletRequest[]).map(x => [x.id, x]));
      } catch {
        s = empty();
      }
    }
    g.__instantStore = s;
    return s;
  };
  const write = (s: FileStore) => {
    g.__instantStore = s;
    mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
  };
  return {
    name: "json",
    allRequests: async () => Object.values(read().requests),
    getRequest: async id => read().requests[id],
    putRequest: async req => {
      const s = read();
      s.requests[req.id] = req;
      write(s);
    },
    delRequests: async ids => {
      const s = read();
      for (const id of ids) delete s.requests[id];
      write(s);
    },
    allDevices: async () => read().devices,
    getDevice: async id => read().devices[id],
    putDevice: async (id, d) => {
      const s = read();
      s.devices[id] = d;
      write(s);
    },
    getPairing: async id => read().pairings[id],
    putPairing: async (id, w) => {
      const s = read();
      s.pairings[id] = w;
      write(s);
    },
    allLabels: async () => read().labels,
    putLabel: async (k, label) => {
      const s = read();
      s.labels[k] = label;
      write(s);
    },
    getKey: async w => read().keys[w],
    putKey: async (w, k) => {
      const s = read();
      s.keys[w] = k;
      write(s);
    },
  };
}

let _backend: Backend | undefined;
function backend(): Backend {
  if (_backend) return _backend;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _backend = url && token ? redisBackend(url, token) : jsonBackend();
  return _backend;
}
export const storeBackend = () => backend().name;

// ---------------------------------------------------------------- public API (async)

/** Every request, newest first. */
export async function listRequests(): Promise<WalletRequest[]> {
  return (await backend().allRequests()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function findRequest(id: string): Promise<WalletRequest | undefined> {
  return backend().getRequest(id);
}

/** Insert a new request and trim the queue to MAX_REQUESTS (oldest terminal ones go first). */
export async function addRequest(r: WalletRequest): Promise<void> {
  const b = backend();
  await b.putRequest(r);
  const all = await b.allRequests();
  if (all.length > MAX_REQUESTS) {
    const terminal = new Set(["confirmed", "failed", "rejected", "expired"]);
    const victims = all
      .filter(x => x.id !== r.id)
      .sort((a, c) => Number(terminal.has(c.status)) - Number(terminal.has(a.status)) || a.createdAt - c.createdAt)
      .slice(0, all.length - MAX_REQUESTS)
      .map(x => x.id);
    await b.delRequests(victims);
  }
}

/** Patch one request = one HSET (no whole-queue read-modify-write). */
export async function patchRequest(id: string, patch: Partial<WalletRequest>): Promise<WalletRequest> {
  const b = backend();
  const r = await b.getRequest(id);
  if (!r) throw new Error(`request ${id} not found`);
  const next = { ...r, ...patch, updatedAt: Date.now() } as WalletRequest;
  await b.putRequest(next);
  return next;
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Mark pending requests whose deadline passed. Idempotent, cheap. */
export async function expireStale(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stale = (await backend().allRequests()).filter(r => r.status === "pending" && r.deadline < now);
  for (const r of stale) {
    await patchRequest(r.id, { status: "expired", error: "not signed before the deadline" }).catch(() => {});
  }
}

export async function setPairing(signerId: string, wallet: `0x${string}`): Promise<void> {
  await backend().putPairing(signerId.toLowerCase(), wallet);
}
export async function getPairing(signerId: string): Promise<`0x${string}` | undefined> {
  return backend().getPairing(signerId.toLowerCase());
}

export async function setLabel(wallet: string, signerId: string, label: string): Promise<void> {
  if (!label.trim()) return;
  await backend().putLabel(`${wallet.toLowerCase()}:${signerId.toLowerCase()}`, label.trim().slice(0, 64));
}

/** signerId (lowercase) -> label, for one wallet. */
export async function labelsFor(wallet: string): Promise<Record<string, string>> {
  const w = wallet.toLowerCase() + ":";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(await backend().allLabels())) if (k.startsWith(w)) out[k.slice(w.length)] = v;
  return out;
}

export async function deviceFor(signerId: string): Promise<DeviceInfo | undefined> {
  return backend().getDevice(signerId.toLowerCase());
}
export async function listDevices(): Promise<DeviceInfo[]> {
  return Object.values(await backend().allDevices());
}
export async function putDevice(d: DeviceInfo): Promise<void> {
  await backend().putDevice(d.signerId.toLowerCase(), d);
}

/** Remember the first key of a (possibly counterfactual) wallet so the facilitator can deploy it later. */
export async function setFirstKey(wallet: string, k: Omit<FirstKey, "registeredAt">): Promise<void> {
  const prev = await backend().getKey(wallet.toLowerCase());
  if (prev) return; // the first key never changes
  await backend().putKey(wallet.toLowerCase(), { ...k, registeredAt: Date.now() });
}
export async function getFirstKey(wallet: string): Promise<FirstKey | undefined> {
  return backend().getKey(wallet.toLowerCase());
}
