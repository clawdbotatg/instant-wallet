// Ops helper: HLEN of the four iw:<chain>:* hashes; `node scripts/redis-keys.mjs del` DELs exactly those four keys.
import { Redis } from "@upstash/redis";
import { readFileSync } from "node:fs";
for (const line of readFileSync(process.env.ENV_FILE || ".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const keys = ["requests", "devices", "pairings", "labels"].map(k => `iw:31337:${k}`);
for (const k of keys) console.log(k, "HLEN", await r.hlen(k));
if (process.argv[2] === "del") {
  const n = await r.del(...keys);
  console.log("DEL", keys.join(" "), "->", n);
  for (const k of keys) console.log(k, "EXISTS", await r.exists(k));
}
