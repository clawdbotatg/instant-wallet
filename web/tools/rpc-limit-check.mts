// lib/rpcWatch.ts: per-IP limits per minute/hour/day, costly calls weigh more, numbers from the store. Memory store, no network.
//   npx tsx --conditions=react-server tools/rpc-limit-check.mts
import { kv } from "../lib/kv";
import { rpcCheck } from "../lib/rpcWatch";
let f = 0;
const ok = (c: boolean, m: string) => { console.log(c ? "PASS" : "FAIL", m); if (!c) f++; };
await kv(["SET", "iws:rpc:limits", JSON.stringify({ min: 10, hour: 1000, day: 100000, heavy: 5 })]);
const req = (ip: string) => new Request("http://x", { headers: { "x-forwarded-for": ip } });
const a: (string | null)[] = [];
for (let i = 0; i < 11; i++) a.push(await rpcCheck(req("1.1.1.1"), ["eth_call"]));
ok(a.slice(0, 10).every(x => x === null) && /minute/.test(a[10] ?? ""), "10 calls a minute pass, the 11th is refused");
ok((await rpcCheck(req("2.2.2.2"), ["eth_call"])) === null, "another IP isn't affected");
ok((await rpcCheck(req("3.3.3.3"), ["eth_getLogs", "eth_getLogs"])) === null && /minute/.test((await rpcCheck(req("3.3.3.3"), ["eth_call"])) ?? ""), "costly calls weigh 5: two logs + one call = 11");
process.exit(f ? 1 : 0);
