// The server caches never grow past their size: npx tsx tools/capped-check.mts
import { Capped } from "../lib/capped";
let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);
const m = new Capped<string, number>(3);
for (const k of ["a", "b", "c", "d"]) m.set(k, 1);
ok(m.size === 3 && !m.has("a") && m.has("d"), "a fourth key pushes out the first");
m.set("b", 2).set("e", 1);
ok(m.has("b") && !m.has("c") && m.get("b") === 2, "a key written again is the newest");
for (let i = 0; i < 1000; i++) m.set("k" + i, i);
ok(m.size === 3, "1000 more keys: still 3");
process.exit(bad ? 1 : 0);
