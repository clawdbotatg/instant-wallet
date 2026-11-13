// The rule of lib/safe/proven.ts (docs/PROVEN-BALANCES.md), against a fake portfolio and fake proofs. No network, no
// browser: npx tsx tools/proven-check.mts
import { type ProvenEvent, type Table, SETTLE_MS, near, next, pick, provenKey, stateOf } from "../lib/safe/proven";

let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);

const ETH = "0x0000000000000000000000000000000000000000";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const FAKE = "0x00000000000000000000000000000000deadbeef";
const BASE = 8453;
const T0 = 1_800_000_000_000; // ms, this device's clock
const S = SETTLE_MS;
let SHIFT = 0; // s: how far the blocks' own clock is from this device's (the rule must not care)

const run = (events: ProvenEvent[], t: Table = {}) => events.reduce((a, e) => next(a, e), t);
const seen = (at: number, rows: [number, string, bigint, number?][], late?: number[]): ProvenEvent => ({ kind: "seen", at, late, assets: rows.map(([chainId, asset, b, usd]) => ({ chainId, asset, balance: String(b), usd: usd ?? 1 })) });
// a proof that landed at `at` (device ms), for a block whose own time is ~15 s before (plus SHIFT)
const proof = (block: number, at: number, balances: Record<string, bigint | null>, chainId = 1): ProvenEvent => ({ kind: "proved", chainId, block, at, time: Math.round(at / 1000) - 15 + SHIFT, balances });
const read = (at: number, asset: string, b: bigint, chainId = 1) => seen(at, [[chainId, asset, b]]);
const st = (t: Table, asset: string, chainId = 1) => stateOf(t, { chainId, asset });
const row = (t: Table, asset: string, chainId = 1) => t[provenKey(chainId, asset)];

// honest, steady
{
  let t = run([seen(T0, [[1, ETH, 10n ** 18n], [1, USDC, 5_000_000n]])]);
  ok(st(t, ETH) === "unchecked" && st(t, USDC) === "unchecked", "before any proof: unchecked");
  t = run([proof(100, T0 + 12_000, { [ETH]: 10n ** 18n, [USDC]: 5_000_000n })], t);
  ok(st(t, ETH) === "checked" && st(t, USDC) === "checked", "honest steady balance: checked");
  ok(run([seen(T0 + 20_000, [[1, ETH, 10n ** 18n], [1, USDC, 5_000_000n]])], t) === t, "the same read again changes nothing (same table)");
}

// an honest payment, end to end
const payment = () =>
  run([
    read(T0, USDC, 5_000_000n),
    proof(100, T0 + 12_000, { [USDC]: 5_000_000n }),
    read(T0 + 200_000, USDC, 7_000_000n), // +2 USDC shows up
    proof(101, T0 + 212_000, { [USDC]: 5_000_000n }), // for a block before it
    read(T0 + 215_000, USDC, 7_000_000n),
    proof(102, T0 + 224_000, { [USDC]: 5_000_000n }),
    read(T0 + 227_000, USDC, 7_000_000n),
    read(T0 + 230_000, USDC, 7_000_000n),
  ]);
{
  let t = run([read(T0, USDC, 5_000_000n), proof(100, T0 + 12_000, { [USDC]: 5_000_000n }), read(T0 + 200_000, USDC, 7_000_000n)]);
  ok(st(t, USDC) === "unchecked", "new payment: the row fades (unchecked)");
  t = payment();
  ok(st(t, USDC) === "unchecked" && row(t, USDC).strikes === 0 && !row(t, USDC).doubt, "old-block proofs disagree, reads repeat the new number: no doubt, no strike");
  t = run([proof(103, T0 + 236_000, { [USDC]: 7_000_000n })], t);
  ok(st(t, USDC) === "checked" && row(t, USDC).strikes === 0, "then a proof has the payment: checked, never a strike");
}

// a wrong amount
const lie = () => {
  const out: Table[] = [];
  let t = run([read(T0, USDC, 9_000_000n), proof(100, T0 + S + 10_000, { [USDC]: 5_000_000n })]);
  out.push(t);
  t = run([proof(101, T0 + S + 22_000, { [USDC]: 5_000_000n }), proof(102, T0 + S + 34_000, { [USDC]: 5_000_000n })], t);
  out.push(t);
  t = run([read(T0 + S + 37_000, USDC, 9_000_000n)], t);
  out.push(t);
  t = run([read(T0 + S + 40_000, USDC, 9_000_000n), proof(102, T0 + S + 41_000, { [USDC]: 5_000_000n }), read(T0 + S + 44_000, USDC, 9_000_000n)], t);
  out.push(t);
  t = run([proof(103, T0 + S + 50_000, { [USDC]: 5_000_000n }), read(T0 + S + 53_000, USDC, 9_000_000n)], t);
  out.push(t);
  return out;
};
{
  const [a, b, c, d, e] = lie();
  ok(st(a, USDC) === "unchecked" && row(a, USDC).strikes === 0 && row(a, USDC).doubt?.block === 100, "a disagreeing proof: a doubt, not a strike");
  ok(st(b, USDC) === "unchecked" && row(b, USDC).strikes === 0, "more disagreeing proofs with no read after them: still no strike");
  ok(c !== b && row(c, USDC).strikes === 1 && !row(c, USDC).doubt && st(c, USDC) === "unchecked", "the server says its number again after: one strike (and a changed table)");
  ok(row(d, USDC).strikes === 1, "the same block doubted twice is one strike");
  ok(st(e, USDC) === "wrong" && row(e, USDC).proven === 5_000_000n, "a newer block, read again: wrong, with the proven number");
  let t = run([read(T0 + S + 60_000, USDC, 5_000_000n)], e);
  ok(st(t, USDC) === "unchecked" && row(t, USDC).strikes === 0 && !row(t, USDC).doubt, "the shown number changes after wrong: back to unchecked, strikes cleared");
  t = run([proof(104, T0 + S + 70_000, { [USDC]: 5_000_000n })], t);
  ok(st(t, USDC) === "checked", "then the proof agrees: checked");
}

// the first two minutes of a number
{
  const t = run([read(T0, USDC, 9_000_000n), proof(100, T0 + S - 1_000, { [USDC]: 5_000_000n }), read(T0 + S + 5_000, USDC, 9_000_000n), read(T0 + S + 8_000, USDC, 9_000_000n)]);
  ok(!row(t, USDC).doubt && row(t, USDC).strikes === 0 && st(t, USDC) === "unchecked", "a disagreeing proof within 2 min of the number: no doubt, even when reads repeat it after");
}

// the device's clock doesn't matter
{
  const states = (shift: number) => {
    SHIFT = shift;
    const r = [...lie(), payment()].map(t => JSON.stringify(t, (_, v) => (typeof v === "bigint" ? String(v) : v)));
    SHIFT = 0;
    return r.join();
  };
  ok(states(600) === states(0) && states(-600) === states(0), "blocks' times shifted ±10 min: the same states");
}

// a strike, then an agreeing proof: the count starts over; a hidden spend after checked
{
  let t = run([read(T0, USDC, 9_000_000n), proof(100, T0 + S + 10_000, { [USDC]: 5_000_000n }), read(T0 + S + 13_000, USDC, 9_000_000n), proof(101, T0 + S + 22_000, { [USDC]: 9_000_000n })]);
  ok(st(t, USDC) === "checked" && row(t, USDC).strikes === 0, "strike then agree: checked, strikes cleared");
  t = run([proof(102, T0 + S + 34_000, { [USDC]: 5_000_000n })], t);
  ok(st(t, USDC) === "unchecked", "a hidden spend after checked: the doubt fades it");
  t = run([read(T0 + S + 37_000, USDC, 9_000_000n), proof(103, T0 + S + 46_000, { [USDC]: 5_000_000n }), read(T0 + S + 49_000, USDC, 9_000_000n)], t);
  ok(st(t, USDC) === "wrong", "read again twice after two proofs: wrong");
}

// a made-up coin
{
  const steps = (p: bigint | null) => [read(T0, FAKE, 10n ** 24n), proof(100, T0 + S + 10_000, { [FAKE]: p }), read(T0 + S + 13_000, FAKE, 10n ** 24n), proof(101, T0 + S + 22_000, { [FAKE]: p }), read(T0 + S + 25_000, FAKE, 10n ** 24n)];
  const t = run(steps(null));
  ok(st(t, FAKE) === "wrong" && row(t, FAKE).proven === null, "made-up coin (no code): wrong after two proofs, each read again");
  ok(st(run(steps(0n)), FAKE) === "wrong", "a coin the chain says is 0: wrong");
}

// a coin that grows every block
{
  const b = 1_000_000_000_000_000_000n;
  let t = run([read(T0, STETH, b), proof(100, T0 + 12_000, { [STETH]: b - b / 200_000n })]); // 0.0005% less
  ok(st(t, STETH) === "checked", "a growing coin within 0.001%: checked");
  t = run([read(T0 + 3_000, STETH, b + b / 500_000n)], t); // Home's next read: a bit more again
  ok(st(t, STETH) === "checked", "its next read, still within 0.001% of the proof: stays checked (no flicker)");
  t = run([read(T0 + 6_000, STETH, b + b / 1_000n)], t);
  ok(st(t, STETH) === "unchecked", "a real change (0.1%): unchecked");
  ok(st(run([read(T0, STETH, b), proof(100, T0 + 12_000, { [STETH]: b - b / 50_000n })]), STETH) !== "checked", "0.002% off: not checked");
}

// zero vs dust
{
  ok(!near(0n, 1n) && !near(1n, 0n) && near(0n, 0n), "near(): zero is only near zero");
  ok(st(run([read(T0, USDC, 1n), proof(100, T0 + 12_000, { [USDC]: 0n })]), USDC) !== "checked", "shown dust, proven 0: not checked");
  ok(st(run([read(T0, ETH, 0n), proof(100, T0 + 12_000, { [ETH]: 1n })]), ETH) !== "checked", "shown 0, proven dust: not checked");
}

// the prover is down
{
  let t = run([seen(T0, [[1, ETH, 5n], [1, USDC, 7n]]), proof(100, T0 + 12_000, { [ETH]: 5n })]);
  t = run([{ kind: "failed", chainId: 1, assets: [ETH, USDC] }], t);
  ok(st(t, USDC) === "cant", "a failed proof: cant, never wrong");
  ok(st(t, ETH) === "checked", "an earlier checked survives a failed proof");
  const w = run([read(T0, USDC, 9n), proof(100, T0 + S + 10_000, { [USDC]: 5n }), { kind: "failed", chainId: 1, assets: [USDC] }, read(T0 + S + 13_000, USDC, 9n)]);
  ok(row(w, USDC).strikes === 1, "a failed proof leaves a doubt alone: the next read still strikes");
  t = run([seen(T0 + 20_000, [[1, ETH, 6n], [1, USDC, 7n]]), { kind: "failed", chainId: 1, assets: [ETH] }], t);
  ok(st(t, ETH) === "cant", "the shown number changed, then the proof failed: cant (the old checked doesn't carry over)");
  t = run([proof(101, T0 + 36_000, { [ETH]: 6n, [USDC]: 7n })], t);
  ok(st(t, ETH) === "checked" && st(t, USDC) === "checked", "the prover is back: checked");
}

// a late network (the read timed out there; the page keeps its old rows)
{
  let t = run([seen(T0, [[1, USDC, 9n], [100, ETH, 3n]]), proof(100, T0 + S + 10_000, { [USDC]: 5n })]);
  const before = row(t, USDC);
  t = run([seen(T0 + S + 13_000, [[1, USDC, 9n], [100, ETH, 3n]], [1]), seen(T0 + S + 16_000, [[100, ETH, 3n]], [1])], t);
  ok(row(t, USDC) === before && row(t, USDC).strikes === 0, "a read that lists the network as late: its rows untouched, never a strike (even with the old rows in it, or none)");
  t = run([seen(T0 + S + 19_000, [[1, USDC, 11n], [100, ETH, 3n]], [1])], t);
  ok(row(t, USDC) === before, "a late read with another number: still untouched (since kept)");
  t = run([seen(T0 + S + 22_000, [[1, USDC, 11n], [100, ETH, 3n]])], t);
  ok(row(t, USDC).since === T0 + S + 22_000 && !row(t, USDC).doubt && st(t, USDC) === "unchecked", "no longer late, a changed number: starts over");
}

// back from a hidden tab: the number shown is hours old, the proof is new
{
  let t = run([read(T0, USDC, 5n), proof(100, T0 + 12_000, { [USDC]: 5n })]);
  t = run([proof(900, T0 + 3 * 3600_000, { [USDC]: 8n })], t); // proved on return, before the page's read lands
  ok(row(t, USDC).strikes === 0 && st(t, USDC) === "unchecked", "back: the new proof disagrees with the old number: a doubt only");
  t = run([read(T0 + 3 * 3600_000 + 2_000, USDC, 8n)], t);
  ok(row(t, USDC).strikes === 0 && !row(t, USDC).doubt, "then the read brings the new number: no strike");
  t = run([proof(901, T0 + 3 * 3600_000 + 14_000, { [USDC]: 8n })], t);
  ok(st(t, USDC) === "checked", "and the next proof checks it");
}

// networks
{
  const t = run([seen(T0, [[BASE, USDC, 5n], [100, ETH, 3n]]), proof(100, T0 + 12_000, { [ETH]: 3n }, 100)]);
  ok(st(t, USDC, BASE) === "cant", "a network without a light client: cant");
  ok(!(provenKey(BASE, USDC) in t), "and it's never tracked or proven");
  ok(st(t, ETH, 100) === "checked" && st(t, ETH, 1) === "unchecked", "Gnosis is its own network: its proof doesn't touch Ethereum's ETH");
}

// old proofs, coins that leave
{
  let t = run([read(T0, USDC, 5n), proof(105, T0 + 60_000, { [USDC]: 5n })]);
  t = run([proof(104, T0 + 48_000, { [USDC]: 9n })], t);
  ok(st(t, USDC) === "checked" && row(t, USDC).block === 105, "a proof for an older block than the last one is dropped");
  t = run([seen(T0 + 70_000, [])], t);
  ok(!(provenKey(1, USDC) in t), "a coin no longer shown is dropped");
}

// what to prove next
{
  const t = run([seen(T0, Array.from({ length: 80 }, (_, i) => [1, "0x" + (i + 1).toString(16).padStart(40, "0"), 1n, i] as [number, string, bigint, number]))]);
  const p = pick(t, 1, false);
  ok(p.length === 50 && p[0] === "0x" + (80).toString(16).padStart(40, "0"), "pick: one call's worth (50), biggest by dollars first");
  const done = run([proof(100, T0 + 12_000, Object.fromEntries(Object.values(t).map(r => [r.asset, 1n])))], t);
  ok(pick(done, 1, false).length === 0, "pick: nothing when all are checked");
  ok(pick(done, 1, true).length === 20, "pick on a re-check: the 20 biggest again");
  ok(pick(done, 100, true).length === 0, "pick: only that network's coins");
  const doubted = lie()[0];
  ok(pick(doubted, 1, false).length === 0, "pick: not a coin whose doubt waits for the server's next read");
}

process.exit(bad ? 1 : 0);
