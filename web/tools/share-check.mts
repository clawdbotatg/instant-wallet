// A waiting tx from a link, the queue or Safe's service (lib/safe/share.ts): the hash the keys sign is worked out
// here from the tx shown, never taken from a server, and a tx that isn't clean hex and numbers is refused
// (audit 11-13: odd-length data was hashed as approve() and shown as an unknown call). Seconds, no network.
//   npx tsx tools/share-check.mts
import { encodeFunctionData, type Hex } from "viem";
import { abi, safeTxHash, type SafeTx } from "../lib/safe/core";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
(globalThis as any).location = { origin: "https://instantwallet.io" };
(globalThis as any).window = { dispatchEvent: () => true };
let queue: any = { txs: [] };
(globalThis as any).fetch = async (u: string) => ({ ok: true, json: async () => (String(u).startsWith("/api/safe/queue") ? queue : { results: [] }) });

const { fromLink, readWaiting, txLink } = await import("../lib/safe/share");

let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) bad++;
};

const CHAIN = 8453;
const safe = "0x1111111111111111111111111111111111111111" as const;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const attacker = "0x2222222222222222222222222222222222222222" as const;
const friend = "0x3333333333333333333333333333333333333333" as const;
const erc = (fn: "transfer" | "approve", to: string, n: bigint) => encodeFunctionData({ abi: abi.erc20, functionName: fn, args: [to as Hex, n] });
const wire = (t: SafeTx) => ({ to: t.to, value: t.value.toString(), data: t.data, operation: t.operation, safeTxGas: "0", baseGas: "0", gasPrice: "0", nonce: t.nonce.toString() });
const send: SafeTx = { to: usdc, value: 0n, data: erc("transfer", friend, 1_000_000n), operation: 0, nonce: 5n };
const drain: SafeTx = { to: usdc, value: 0n, data: erc("approve", attacker, 2n ** 256n - 1n), operation: 0, nonce: 5n };
const code = (t: any) => Buffer.from(JSON.stringify({ t, s: [] })).toString("base64url");

// ---- 2a: the queue's hash
queue = { txs: [{ tx: wire(send), hash: safeTxHash(CHAIN, safe, drain), sigs: [] }] };
let got = await readWaiting(CHAIN, safe, 0n, { svc: false });
ok(got.length === 0, "queue: a harmless tx with another tx's hash is dropped");
queue = { txs: [{ tx: wire(send), hash: safeTxHash(CHAIN, safe, send).toUpperCase().replace("0X", "0x"), sigs: [] }] };
got = await readWaiting(CHAIN, safe, 0n, { svc: false });
ok(got.length === 1 && got[0].hash === safeTxHash(CHAIN, safe, got[0].tx), "queue: a tx with its own hash comes through, hash worked out here");
queue = { txs: [{ tx: { ...wire(send), nonce: "nope" }, hash: safeTxHash(CHAIN, safe, send), sigs: [] }, { tx: wire(send), hash: safeTxHash(CHAIN, safe, send), sigs: [] }] };
got = await readWaiting(CHAIN, safe, 0n, { svc: false }).catch(() => []);
ok(got.length === 1, "queue: one broken entry doesn't hide the good one");
// this browser's own copy is checked the same way
queue = { txs: [] };
store.set(`iws.waiting.${CHAIN}:${safe}`, JSON.stringify({ [safeTxHash(CHAIN, safe, drain).toLowerCase()]: { tx: wire(send), sigs: [] } }));
got = await readWaiting(CHAIN, safe, 0n, { svc: false });
ok(got.length === 0, "this browser: a stored tx under another tx's hash is dropped");
store.clear();

// ---- 2b: only clean hex and numbers
// 135 hex digits: hashed (left-padded) as 0x095ea7b3… = approve(attacker, max); read as selector 0x95ea7b30
const odd = "0x" + drain.data.slice(3);
ok(fromLink(CHAIN, safe, code({ ...wire(send), data: odd })) === null, "link: odd-length data is refused");
for (const [what, t] of [
  ["operation 2", { ...wire(send), operation: 2 }],
  ["value -1", { ...wire(send), value: "-1" }],
  ["value 0x10", { ...wire(send), value: "0x10" }],
  ["nonce 1e3", { ...wire(send), nonce: "1e3" }],
  ["data zz", { ...wire(send), data: "zz" }],
  ["data 0xzz", { ...wire(send), data: "0xzz" }],
  ["no nonce", { ...wire(send), nonce: undefined }],
] as const)
  ok(fromLink(CHAIN, safe, code(t)) === null, `link: ${what} is refused`);
const link = txLink({ chainId: CHAIN, safe, tx: send, hash: safeTxHash(CHAIN, safe, send), sigs: [], label: "Send 1 USDC…" });
const back = fromLink(CHAIN, safe, link.split("#")[1]);
ok(!!back && back.hash === safeTxHash(CHAIN, safe, send) && back.tx.data === send.data && back.tx.nonce === 5n, "link: the app's own link comes back as the same tx and hash");
const plainSend = fromLink(CHAIN, safe, code({ to: friend, value: "1000", operation: 0, nonce: "0" }));
ok(!!plainSend && plainSend.tx.data === "0x" && plainSend.tx.value === 1000n, "link: a plain coin send with no data still reads");

if (bad) {
  console.error(`${bad} failed`);
  process.exit(1);
}
console.log("ok");
