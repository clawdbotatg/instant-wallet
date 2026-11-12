import "server-only";

/**
 * Upstash Redis (RELAY_KV_URL / RELAY_KV_TOKEN): the one store. Alerts, the relay, drops, names and limits all use it. Without it (local dev, a fork
 * test) one in-memory store shared by every route; production refuses to run without it.
 */

const URL_ = process.env.RELAY_KV_URL;
const TOKEN = process.env.RELAY_KV_TOKEN;
const mem: Map<string, { v: any; until: number }> = ((globalThis as any).__iwsKv ??= new Map());

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
    case "DEL":
      return mem.delete(k) ? 1 : 0;
    case "INCR":
    case "DECR":
      put(String(Number(v ?? 0) + (op === "INCR" ? 1 : -1)));
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
    return memory(c);
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
