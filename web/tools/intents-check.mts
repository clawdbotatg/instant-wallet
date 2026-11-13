// A batch's headline (lib/safe/intents.ts: Activity, and the sheet when the coins say the rest): it never hides an
// approval that outlives the batch, nor a call it can't name (audit 11-13: [approve(attacker, max), send 0.01] read
// "Send 0.01 USDC"). Seconds, no network.
//   npx tsx tools/intents-check.mts
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { abi, type Call } from "../lib/safe/core";
import { intents } from "../lib/safe/intents";
import { LIFI_DIAMOND } from "../lib/safe/swap";

let bad = 0;
const ok = (c: boolean, m: string, lines?: unknown) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) {
    bad++;
    if (lines) console.log("     ", JSON.stringify(lines));
  }
};

const CHAIN = 8453;
const safe = "0x1111111111111111111111111111111111111111" as const;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const attacker = "0x2222222222222222222222222222222222222222" as const;
const friend = "0x3333333333333333333333333333333333333333" as const;
const unknown = "0x4444444444444444444444444444444444444444" as const;
const MAX = 2n ** 256n - 1n;
const erc = (fn: "transfer" | "approve", to: string, n: bigint): Call => ({ to: usdc, value: 0n, data: encodeFunctionData({ abi: abi.erc20, functionName: fn, args: [to as Hex, n] }) });
const more: Call = { to: usdc, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function increaseAllowance(address spender, uint256 increment)"]), functionName: "increaseAllowance", args: [attacker, MAX] }) };
const foo: Call = { to: unknown, value: 0n, data: "0xc2985578" };
const swap: Call = { to: LIFI_DIAMOND, value: 0n, data: ("0x4666fc80" + "00".repeat(12) + safe.slice(2)) as Hex };
const send = erc("transfer", friend, 10_000n);
const said = (calls: Call[], told: any[] | null = null, brief = true) => intents(CHAIN, safe, calls, told, brief) as { text: string; src: string; warn?: boolean; approve?: boolean }[];
const has = (l: { text: string }[], re: RegExp) => l.some(x => re.test(x.text));

let l = said([erc("approve", attacker, MAX), send]);
ok(has(l, /^Let 0x2222222222222222222222222222222222222222 spend any amount/) && has(l, /^Send 0\.01 USDC/), "approve(attacker, max) + a send: both are said", l);
ok(l.some(x => x.approve), "…and the approval is marked, so the sheet opens its steps", l);

l = said([more, send]);
ok(has(l, /^Unknown call to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/) && l.some(x => x.warn) && has(l, /^Send 0\.01 USDC/), "increaseAllowance + a send: the unknown call is said, as a warning", l);

l = said([foo, send]);
ok(has(l, /^Unknown call to 0x4444444444444444444444444444444444444444/) && l.some(x => x.warn), "an unknown call + a send: the unknown call is said", l);

l = said([foo]);
ok(l.length === 1 && has(l, /^Unknown call to/), "an unknown call alone is said", l);

const SWAP = { what: "Swap", fields: [] };
l = said([erc("approve", LIFI_DIAMOND, 5_000_000n), swap, erc("approve", LIFI_DIAMOND, 0n)], [null, SWAP, null]);
ok(l.length === 1 && l[0].text === "Swap" && !l[0].warn && !l[0].approve, "the app's own swap (approve, swap, approve 0): the swap only", l);

l = said([erc("approve", LIFI_DIAMOND, 5_000_000n), swap], [null, SWAP]);
ok(l.length === 2 && has(l, /^Let .* spend up to 5 USDC/), "an approval left standing after a swap is said", l);

l = said([erc("approve", attacker, MAX), send, erc("approve", attacker, 5n)]);
ok(has(l, /^Let 0x2222222222222222222222222222222222222222 spend/), "an approval set again to more than 0 is said", l);

l = said([send]);
ok(l.length === 1 && /^Send 0\.01 USDC to 0x3333333333333333333333333333333333333333$/.test(l[0].text) && !l[0].warn && !l[0].approve, "a plain send reads as before", l);

l = said([erc("approve", attacker, 0n)]);
ok(l.length === 1 && /^Stop /.test(l[0].text), "a lone revoke reads as before", l);

// the relay's fee is never a line
l = said([send, erc("transfer", "0x4cfab32186e65e2a39ec0e882e11380cbf2f8a2f", 1000n)]);
ok(l.length === 1, "the relay's fee is not a line", l);

// the full list (not brief) keeps every step
l = said([erc("approve", attacker, MAX), foo, send], null, false);
ok(l.length === 3, "the full list has every step", l);

if (bad) {
  console.error(`${bad} failed`);
  process.exit(1);
}
console.log("ok");
