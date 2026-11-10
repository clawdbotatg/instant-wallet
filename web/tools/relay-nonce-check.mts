// The relay's nonce memory (fix list 4b), with a fake node and no chain: a node stuck behind our last send still gets
// a new nonce each time, a failed send is not remembered, and after 10 s the node's count is used again.
//   npx tsx --conditions=react-server tools/relay-nonce-check.mts
const { relaySend, RelayRefused, NONCE_MEMORY } = await import("../lib/safe/relayGuard");
const who = "0x00000000000000000000000000000000000000AA";
let bad = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) bad++; };
const used: number[] = [];
const send = async (n: number) => { used.push(n); return "0x01" as const; };
// a node stuck behind us: it always says 5
await relaySend(1, who, async () => 5, send);
await relaySend(1, who, async () => 5, send);
await relaySend(1, who, async () => 5, send);
ok(used.join() === "5,6,7", `lagging node: nonces go up (${used.join()})`);
await relaySend(1, who, async () => 12, send);
ok(used.at(-1) === 12, "node ahead of our memory: its count is used");
// two at once
used.length = 0;
await Promise.all([relaySend(3, who, async () => 5, send), relaySend(3, who, async () => 5, send)]);
ok(used.slice().sort().join() === "5,6", `two at once: one each (${used.join()})`);
// a failed send isn't remembered
used.length = 0;
await relaySend(2, who, async () => 5, async () => { throw new Error("node said no"); }).catch(() => {});
await relaySend(2, who, async () => 5, send);
ok(used.join() === "5", "failed send: its nonce is used again");
// the count fails: refused as safe to retry, nothing sent
used.length = 0;
const e = await relaySend(4, who, async () => { throw new Error("timeout"); }, send).catch((x: any) => x);
ok(e instanceof RelayRefused && e.status === 503 && used.length === 0, "count fails: 503, nothing sent");
// a dropped tx: after the memory's life the node's count fills the gap
used.length = 0;
await relaySend(5, who, async () => 5, send);
await new Promise(r => setTimeout(r, NONCE_MEMORY * 1000 + 300));
await relaySend(5, who, async () => 5, send);
ok(used.join() === "5,5", `after ${NONCE_MEMORY} s: back to the node's count (${used.join()})`);
process.exit(bad ? 1 : 0);
