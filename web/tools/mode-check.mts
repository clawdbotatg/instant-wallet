/**
 * The two modes (lib/mode.ts, docs/MODES.md): what each turns on by default, and that a switch flipped by hand wins.
 *   npx tsx tools/mode-check.mts
 */
const mem = new Map<string, string>();
const g = globalThis as any;
g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const at = (hostname: string) => ((g.window = { location: { hostname } }), mem.clear());

const { mode, setMode } = await import("../lib/mode");
const { provenOn, setProven } = await import("../lib/safe/proven");
const { lightOn, lightSoft, setLight } = await import("../lib/safe/sim");

let bad = 0;
const ok = (c: boolean, what: string) => (console.log(`${c ? "✓" : "✗"} ${what}`), c || bad++);

at("instantwallet.io");
ok(mode() === "bro", "our site: finance bro");
ok(!provenOn(1) && !provenOn(100) && !lightOn(1) && !lightOn(100), "our site: nothing proven by default");
ok(lightSoft(1) && lightSoft(100) && !lightSoft(8453), "our site: the preview is proven softly (the simulator stays the fallback), not on Base");
setLight(100, false);
ok(!lightSoft(100) && !lightOn(100) && lightSoft(1), "our site: turned off by hand, it's off");
setLight(100, true);
ok(lightOn(100) && !lightSoft(100), "our site: turned on by hand, it's strict");
mem.delete("iws.light");
setProven(1, true);
ok(provenOn(1) && !provenOn(100) && mem.get("iws.proven") === "[1]", "our site: Prove balances by hand, that network only");
setMode("mountain");
ok(mode() === "mountain" && provenOn(100) && lightOn(1) && !lightSoft(1), "our site, mountain man picked: proving on, strict");
ok(!provenOn(8453) && !lightOn(8453), "Base: never (no light client)");

at("local.instantwallet.io");
ok(mode() === "mountain", "a copy on your own computer: mountain man");
ok(provenOn(1) && provenOn(100) && lightOn(1) && lightOn(100), "local: balances and the preview proven by default");
setProven(1, false);
setLight(100, false);
ok(!provenOn(1) && provenOn(100) && lightOn(1) && !lightOn(100), "local: a switch turned off by hand stays off");
setMode("bro");
ok(!provenOn(100) && !lightOn(1), "local, finance bro picked: proving off");
setMode("mountain");
ok(!provenOn(1) && !lightOn(100) && !mem.has("iws.mode"), "back: the hand-set switches kept, the mode key gone");
mem.clear();
mem.set("iws.noext", JSON.stringify({ chains: [1] }));
ok(!provenOn(1) && !lightOn(1) && !lightSoft(1), "local with No external traffic: no proving by default (the prover is outside)");
setLight(1, true);
ok(lightOn(1), "…but on by hand works");
mem.clear();
mem.set("iws.noext", JSON.stringify({ chains: [1, 100] }));
mem.set("iws.beacon", "[1]");
ok(provenOn(1) && lightOn(1), "local with No external traffic and your node's consensus side: proving on (no prover needed)");
ok(!provenOn(100) && !lightOn(100), "…only on that network");
setProven(1, false);
ok(!provenOn(1) && lightOn(1), "…and a switch turned off by hand stays off");
at("instantwallet.io");
mem.set("iws.beacon", "[1]");
ok(!provenOn(1) && !lightOn(1), "our site: never from a node's consensus side");

at("localhost");
mem.set("iws.proven", "on");
setMode("bro");
ok(provenOn(1) && provenOn(100), "the old one-for-both switch still reads as on");

console.log(bad ? `\n${bad} failed` : "\nmodes ✓");
process.exit(bad ? 1 : 0);
