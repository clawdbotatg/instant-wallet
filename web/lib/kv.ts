import "server-only";

/**
 * Upstash Redis (RELAY_KV_URL / RELAY_KV_TOKEN): the one store. Alerts, the relay, drops, names and limits all use it. Without it (local dev, a fork
 * test) one in-memory store shared by every route, kept in KV_FILE if set; production refuses to run without it.
 */

const URL_ = process.env.RELAY_KV_URL;
const TOKEN = process.env.RELAY_KV_TOKEN;
const mem: Map<string, { v: any; until: number }> = ((globalThis as any).__iwsKv ??= new Map());

// KV_FILE: the in-memory store kept in a JSON file, so it survives a restart (a copy run with run-local.sh: the
// shared tx queue, names, limits). Read once at start, written a moment after each change.
const FILE = process.env.KV_FILE;
if (FILE && !(globalThis as any).__iwsKvLoaded) {
  (globalThis as any).__iwsKvLoaded = true;
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(FILE)) for (const [k, e] of Object.entries(JSON.parse(readFileSync(FILE, "utf8")) as Record<string, { v: any; until: number | null }>))
      mem.set(k, { v: e.v, until: e.until ?? Infinity });
  } catch (e) {
    console.error("kv: couldn't read", FILE, e);
  }
}
let saving: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (!FILE || saving) return;
  saving = setTimeout(() => {
    saving = null;
    try {
      const { renameSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const now = Date.now();
      const out: Record<string, { v: any; until: number | null }> = {};
      for (const [k, e] of mem) if (e.until > now) out[k] = { v: e.v, until: e.until === Infinity ? null : e.until };
      writeFileSync(`${FILE}.tmp`, JSON.stringify(out));
      renameSync(`${FILE}.tmp`, FILE);
    } catch (e) {
      console.error("kv: couldn't write", FILE, e);
    }
  }, 500);
}
const READS = new Set(["GET", "MGET", "SMEMBERS", "LRANGE"]);

function memory(cmd: string[]): any {
  const [op, k, ...rest] = cmd;
  const now = Date.now();
  const cur = mem.get(k);
  const v = cur && cur.until > now ? cur.v : undefined;
  const until = cur && cur.until > now ? cur.until : Infinity;
  const put = (x: any, ex?: number) => mem.set(k, { v: x, until: ex ? now + ex * 1000 : until });
  switch (op) {
    case "GET":
      return v ?? null;
    case "SET":
      if (rest.includes("NX") && v !== undefined) return null;
      mem.set(k, { v: rest[0], until: rest.includes("EX") ? now + Number(rest[rest.indexOf("EX") + 1]) * 1000 : Infinity });
      return "OK";
    case "MGET":
      return cmd.slice(1).map(x => {
        const e = mem.get(x);
        return e && e.until > now ? e.v : null;
      });
    case "MSETNX": {
      const kvs = cmd.slice(1);
      for (let i = 0; i < kvs.length; i += 2) if ((mem.get(kvs[i])?.until ?? 0) > now) return 0;
      for (let i = 0; i < kvs.length; i += 2) mem.set(kvs[i], { v: kvs[i + 1], until: Infinity });
      return 1;
    }
    case "DEL":
      return mem.delete(k) ? 1 : 0;
    case "INCR":
    case "DECR":
      put(String(Number(v ?? 0) + (op === "INCR" ? 1 : -1)));
      return Number(mem.get(k)!.v);
    case "INCRBY":
      put(String(Number(v ?? 0) + Number(rest[0])));
      return Number(mem.get(k)!.v);
    case "EXPIRE":
      if (v !== undefined) put(v, Number(rest[0]));
      return v !== undefined ? 1 : 0;
    case "SADD":
      put([...new Set([...(v ?? []), ...rest])]);
      return 1;
    case "SREM":
      put((v ?? []).filter((x: string) => !rest.includes(x)));
      return 1;
    case "SMEMBERS":
      return v ?? [];
    case "RPUSH":
      put([...(v ?? []), ...rest]);
      return mem.get(k)!.v.length;
    case "LRANGE": {
      const l: string[] = v ?? [];
      const end = Number(rest[1]);
      return l.slice(Number(rest[0]), end < 0 ? l.length + end + 1 : end + 1);
    }
    case "EVAL":
      throw new Error("kv: no scripts in memory"); // the caller's plain fallback runs
  }
  return null;
}

export async function kv(cmd: (string | number)[]): Promise<any> {
  const c = cmd.map(String);
  if (!URL_ || !TOKEN) {
    if (process.env.VERCEL_ENV === "production") throw new Error("storage not configured");
    const out = memory(c);
    if (!READS.has(c[0])) save();
    return out;
  }
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(c),
    cache: "no-store",
    signal: AbortSignal.timeout(5000), // a hung call must not hold the request until the function is killed
  });
  const j = await r.json();
  if (j.error) throw new Error(`kv: ${j.error}`);
  return j.result;
}
