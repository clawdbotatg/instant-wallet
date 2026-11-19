import "server-only";
import { kv } from "./kv";
import { ipOf } from "./limit";

/**
 * Limits and watching for the RPC proxy (app/api/rpc): our Alchemy key.
 * Per IP, per minute, hour and day, in weight: a costly call (logs, transfer history, proofs) counts HEAVY.
 * The whole site is only watched, never blocked: a launch-day rush of real people must not lock everyone out.
 * The numbers live in the store (iws:rpc:limits, JSON), so they change in seconds, no deploy:
 *   kv SET iws:rpc:limits '{"min":2000,"hour":24000,"day":120000,"heavy":5,"siteHour":200000}'
 * Telegram (OPS_TELEGRAM_CHAT, with the alerts bot): an IP past half a limit or blocked, once a day each; the site
 * past siteHour, once an hour; a daily summary (dailySummary, from the alerts watcher).
 */
// One load of a wallet's home page is about 200 in its first 10 seconds (measured 11-19: Austin's own page, two
// loads in a minute, was blocked at 300). So the minute takes 5 loads, the hour 60, the day 300.
export const DEFAULTS = { min: 1000, hour: 12_000, day: 60_000, heavy: 5, siteHour: 100_000 };
type Limits = typeof DEFAULTS;
const HEAVY = new Set(["eth_getLogs", "alchemy_getAssetTransfers", "alchemy_getTokenBalances", "eth_getProof", "eth_createAccessList"]);
const P = "iws:rpc:";

let cached: { at: number; v: Limits } | null = null;
export async function limits(): Promise<Limits> {
  if (cached && Date.now() - cached.at < 30_000) return cached.v;
  const raw = await kv(["GET", P + "limits"]).catch(() => null);
  let v = DEFAULTS;
  try {
    if (raw) v = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  cached = { at: Date.now(), v };
  return v;
}

// one round trip: each window's count up by w (its life set on the first), the site's, and the day's top list
const SCRIPT = `local w=tonumber(ARGV[1])
local function bump(k,ttl) local n=redis.call('INCRBY',k,w) if n==w then redis.call('EXPIRE',k,ttl) end return n end
local r={bump(KEYS[1],70),bump(KEYS[2],3700),bump(KEYS[3],90000),bump(KEYS[4],7200),bump(KEYS[5],180000)}
redis.call('ZINCRBY',KEYS[6],w,ARGV[2]) redis.call('EXPIRE',KEYS[6],180000)
return r`;

/** Counts this call; a reason when this IP is over a limit (the call is refused), else null. Never throws. */
export async function rpcCheck(req: Request, methods: string[]): Promise<string | null> {
  try {
    const L = await limits();
    const w = methods.reduce((a, m) => a + (HEAVY.has(m) ? L.heavy : 1), 0);
    const ip = ipOf(req);
    const t = new Date().toISOString(), day = t.slice(0, 10), hour = t.slice(0, 13);
    const keys = [`${P}m:${ip}:${t.slice(0, 16)}`, `${P}h:${ip}:${hour}`, `${P}d:${ip}:${day}`, `${P}site:${hour}`, `${P}site:${day}`, `${P}top:${day}`];
    let n: number[];
    try {
      n = (await kv(["EVAL", SCRIPT, keys.length, ...keys, w, ip])).map(Number);
    } catch {
      n = []; // no scripts (local memory store): plain counts, no top list
      for (const [i, ttl] of [70, 3700, 90000, 7200, 180000].entries()) {
        await kv(["SET", keys[i], 0, "EX", ttl, "NX"]);
        n.push(Number(await kv(["INCRBY", keys[i], w])));
      }
    }
    const [m, h, d, sh] = n;
    // what asked: each method's count in this request, and the page it came from (path only), so an alert names the screen
    const n2: Record<string, number> = {};
    for (const x of methods) n2[x] = (n2[x] ?? 0) + 1;
    let from = "";
    try {
      const u = new URL(req.headers.get("referer") ?? "");
      from = ` From ${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{6,}/g, "0x…")}.`; // never which wallet
    } catch {}
    const what = `${Object.entries(n2).map(([k, v]) => `${k} ×${v}`).join(", ")}.${from}`;
    const over = m > L.min ? "minute" : h > L.hour ? "hour" : d > L.day ? "day" : "";
    const half = m > L.min / 2 || h > L.hour / 2 || d > L.day / 2;
    if (over && (await first(`blocked:${ip}:${day}`, 90000)))
      void tell(`🚫 RPC: ${ip} blocked (over the ${over} limit). Today ${d} of ${L.day}; this hour ${h} of ${L.hour}. Asked now: ${what}`);
    else if (half && (await first(`half:${ip}:${day}`, 90000)))
      void tell(`⚠️ RPC: ${ip} past half a limit. This minute ${m}/${L.min}, hour ${h}/${L.hour}, day ${d}/${L.day}. Asked now: ${what}`);
    if (sh > L.siteHour && (await first(`sitehot:${hour}`, 7200)))
      void tell(`📈 RPC: the whole site is at ${sh} this hour (watch line ${L.siteHour}). Not blocking anyone.`);
    return over ? `Too many reads this ${over}. Wait a bit.` : null;
  } catch {
    return null; // the store down: reads still work
  }
}

const first = async (k: string, ttl: number) => (await kv(["SET", P + "said:" + k, 1, "NX", "EX", ttl]).catch(() => null)) === "OK";

export async function tell(text: string): Promise<boolean> {
  const chat = process.env.OPS_TELEGRAM_CHAT, token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chat || !token) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `Instant Wallet: ${text}`, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  return !!r?.ok;
}

/** Yesterday's RPC use, once a day (called by the alerts watcher, every 5 min). */
export async function dailySummary() {
  const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  if (!(await first(`summary:${y}`, 3 * 86400))) return;
  const total = Number((await kv(["GET", `${P}site:${y}`]).catch(() => 0)) || 0);
  const top: string[] = await kv(["ZREVRANGE", `${P}top:${y}`, 0, 4, "WITHSCORES"]).catch(() => []);
  const ips = Number(await kv(["ZCARD", `${P}top:${y}`]).catch(() => 0));
  const L = await limits();
  const lines = [];
  for (let i = 0; i + 1 < (top?.length ?? 0); i += 2) lines.push(`  ${top[i]}: ${top[i + 1]}${Number(top[i + 1]) > L.day ? " (blocked)" : ""}`);
  await tell(`📊 RPC on ${y}: ${total} (weighted) from ${ips} IPs. Limits per IP: ${L.min}/min, ${L.hour}/hour, ${L.day}/day.\nTop:\n${lines.join("\n") || "  none"}`);
}
