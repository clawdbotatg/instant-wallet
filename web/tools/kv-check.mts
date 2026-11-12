// The one store's memory side (local dev, tests) answers like Redis for what we use:
//   npx tsx --conditions=react-server tools/kv-check.mts
delete process.env.RELAY_KV_URL;
delete process.env.RELAY_KV_TOKEN;
const { kv } = await import("../lib/kv");
let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);
const k = "kvcheck:" + Date.now();
ok((await kv(["SET", k, 1, "NX", "EX", 60])) === "OK" && (await kv(["SET", k, 2, "EX", 60, "NX"])) === null, "SET NX: the first wins, in either word order");
ok((await kv(["GET", k])) === "1", "GET gives a string");
ok((await kv(["INCR", k])) === 2 && (await kv(["GET", k])) === "2", "INCR counts up");
await kv(["SET", k + "t", "x", "EX", 1]);
await new Promise(r => setTimeout(r, 1100));
ok((await kv(["GET", k + "t"])) === null, "EX: gone after its time");
await kv(["SADD", k + "s", "a"]);
await kv(["SADD", k + "s", "b"]);
await kv(["SREM", k + "s", "a"]);
ok(JSON.stringify(await kv(["SMEMBERS", k + "s"])) === '["b"]', "SADD, SREM, SMEMBERS");
ok(await kv(["EVAL", "return 1", 0]).then(() => false, () => true), "a script throws, so the caller's plain way runs");
ok((await kv(["DEL", k])) === 1 && (await kv(["GET", k])) === null, "DEL");
process.exit(bad ? 1 : 0);
