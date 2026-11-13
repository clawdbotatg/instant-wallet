// The raw view (lib/safe/raw.ts, <Raw>): its hashes must be the ones the keys sign. Seconds, no network.
// npx tsx tools/raw-check.mts
import { keccak256, concat } from "viem";
import { txRows, messageRows, typedParts, calldataDigest } from "../lib/safe/raw";
import { batch, safeTxHash } from "../lib/safe/core";
const safe = "0x1111111111111111111111111111111111111111";
const calls = [{ to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", value: 0n, data: "0x095ea7b3000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000f4240" }] as any;
const t = batch(calls, 7n);
const rows = txRows(1, safe, calls, t);
const g = (l: string) => rows.find(r => r.label === l)!.value as `0x${string}`;
console.log(rows.map(r => r.label).join(" | "));
const ok = keccak256(concat(["0x1901", g("Domain hash"), g("Message hash")])) === safeTxHash(1, safe, t) && g("Safe tx hash (EIP-712 digest)") === safeTxHash(1, safe, t);
if (!ok) throw new Error("raw view: the hashes shown are not the Safe tx hash");
console.log("calldata digest", calldataDigest("0x"), calldataDigest(calls[0].data));
console.log(messageRows(1, safe, { hash: "0x" + "ab".repeat(32) as any, raw: "0x68656c6c6f" }).map(r => r.label));
