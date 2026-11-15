// The relay charges a padded tx its real L1 data fee (audit 11-13, IW-12). The fee was a flat allowance while the
// calldata's size was the sender's choice: 30 KB of padding cost the relayer many times what it was paid.
//   npx tsx tools/l1fee-check.mts                     the rule
//   BASE_RPC=<a Base RPC url> npx tsx tools/l1fee-check.mts    also Base's own oracle
import { readFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { MAX_DATA, l1Fee, l1Owed } from "../lib/safe/l1fee";

let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);
const A = 200_000_000_000n;
ok(l1Owed(50_000_000_000n, A) === A && l1Owed(null, A) === A, "a normal send, or a chain with no L1 fee: the flat allowance");
ok(l1Owed(390_000_000_000n, A) === A, "a busy day, under twice the allowance: still the allowance");
ok(l1Owed(9_000_000_000_000n, A) === 9_000_000_000_000n, "a padded tx: its real fee");
ok((await l1Fee({ readContract: async () => { throw new Error("down"); } } as any, 8453, "0x00")) === null, "the oracle can't be read: null, the send isn't blocked");
ok((await l1Fee({ readContract: async () => 5n } as any, 1, "0x00")) === null && (await l1Fee({ readContract: async () => 5n } as any, 8453, "0x00")) === 5n, "asked only on OP-stack chains");
const route = readFileSync(new URL("../app/api/safe/relay/route.ts", import.meta.url), "utf8");
ok(/l1Owed\(await l1Fee\(/.test(route) && !/const l1 = chainId === 1 \? 0n : L1_ALLOWANCE;/.test(route), "the relay's paid-enough check uses it");
ok(/MAX_DATA/.test(route), "and it refuses calldata past the cap");
if (process.env.BASE_RPC) {
  const pc = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC) });
  const small = await l1Fee(pc as any, 8453, ("0x" + "ab".repeat(700)) as Hex), big = await l1Fee(pc as any, 8453, ("0x" + "ab".repeat(MAX_DATA)) as Hex);
  console.log(`  Base now: 700 bytes ${small} wei, ${MAX_DATA} bytes ${big} wei, allowance ${A}`);
  ok(small !== null && big !== null && big > small * 10n, "live: Base's oracle answers, and 32 KB costs far more than a normal send");
  ok(l1Owed(small, A) === A, "live: a normal send fits the allowance today");
}
process.exit(bad ? 1 : 0);
