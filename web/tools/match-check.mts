// The same signers on every network (Austin 11-15: 2 of 4 on one network, 2 of 3 on another, and nothing said so).
// matchCalls turns one network's signers into another's: run its calls on a model of the Safe's owner list (the
// linked list, the checks the contract makes) and the end must be the wanted signers. Seconds, no network.
//   npx tsx tools/match-check.mts
import { type Address, decodeFunctionData } from "viem";
import { abi } from "../lib/safe/core";
import { matchCalls, signersDiffer, signersKey, type Signers } from "../lib/safe/match";

let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) bad++;
};
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const SAFE = A(0xffff);
const SENTINEL = A(1);
const lc = (x: string) => x.toLowerCase();

/** The Safe's OwnerManager, as the contract does it (reverts become throws). */
function run(has: Signers, calls: { to: Address; data: `0x${string}` }[]): Signers {
  let owners = [...has.owners];
  let threshold = has.threshold;
  const setT = (t: number) => {
    if (t < 1 || t > owners.length) throw new Error("GS201/GS202");
    threshold = t;
  };
  for (const c of calls) {
    if (lc(c.to) !== lc(SAFE)) continue; // a signer contract being made
    const { functionName, args } = decodeFunctionData({ abi: abi.safe, data: c.data }) as { functionName: string; args: any[] };
    if (functionName === "addOwnerWithThreshold") {
      if (owners.some(o => lc(o) === lc(args[0]))) throw new Error("GS204");
      owners = [args[0], ...owners];
      setT(Number(args[1]));
    } else if (functionName === "removeOwner") {
      const i = owners.findIndex(o => lc(o) === lc(args[1]));
      if (owners.length - 1 < Number(args[2])) throw new Error("GS201");
      if (lc(args[0]) !== lc(i === 0 ? SENTINEL : owners[i - 1])) throw new Error("GS205");
      owners.splice(i, 1);
      setT(Number(args[2]));
    } else if (functionName === "changeThreshold") setT(Number(args[0]));
    else throw new Error(`unexpected ${functionName}`);
  }
  return { owners, threshold };
}

const cases: [string, Signers, Signers][] = [
  ["Austin's: 2 of 3 gets the fourth signer", { owners: [A(4), A(3), A(2), A(1 + 9)], threshold: 2 }, { owners: [A(3), A(2), A(10)], threshold: 2 }],
  ["the other way: 2 of 4 loses one", { owners: [A(3), A(2), A(10)], threshold: 2 }, { owners: [A(4), A(3), A(2), A(10)], threshold: 2 }],
  ["a new network (Face ID alone) gets all of them", { owners: [A(4), A(3), A(2), A(10)], threshold: 2 }, { owners: [A(10)], threshold: 1 }],
  ["3 of 3 down to 1 of 1", { owners: [A(10)], threshold: 1 }, { owners: [A(4), A(3), A(10)], threshold: 3 }],
  ["nobody in common but one", { owners: [A(7), A(8), A(10)], threshold: 3 }, { owners: [A(5), A(6), A(10)], threshold: 2 }],
  ["nobody in common at all", { owners: [A(7), A(8)], threshold: 2 }, { owners: [A(5), A(6)], threshold: 1 }],
  ["the same people, more must sign", { owners: [A(2), A(3)], threshold: 2 }, { owners: [A(3), A(2)], threshold: 1 }],
  ["the first in the list goes", { owners: [A(3), A(2)], threshold: 1 }, { owners: [A(4), A(3), A(2)], threshold: 3 }],
];
for (const [name, want, has] of cases) {
  let end: Signers | null = null;
  let err = "";
  try {
    end = run(has, matchCalls(SAFE, want, has) as any);
  } catch (e: any) {
    err = e.message;
  }
  ok(!!end && signersKey(end) === signersKey(want), `${name}${err ? ` (${err})` : ""}`);
}
ok(matchCalls(SAFE, { owners: [A(2), A(3)], threshold: 2 }, { owners: [A(3), A(2)], threshold: 2 }).length === 0, "already the same: nothing to do");
const made = { to: A(0xfac), value: 0n, data: "0x" as const };
const withDeploy = matchCalls(SAFE, { owners: [A(4), A(10)], threshold: 1 }, { owners: [A(10)], threshold: 1 }, { [lc(A(4))]: made });
ok(withDeploy[0] === made && withDeploy.length === 2, "a passkey signer's contract is made before it is added");
let threw = false;
try {
  matchCalls(SAFE, { owners: [], threshold: 1 }, { owners: [A(10)], threshold: 1 });
} catch {
  threw = true;
}
ok(threw, "no signers to copy: refused");
ok(!signersDiffer([{ owners: [A(2), A(3)], threshold: 2 }, { owners: [A(3), A(2)], threshold: 2 }]), "the same signers in another order match");
ok(signersDiffer([{ owners: [A(2), A(3)], threshold: 2 }, { owners: [A(2), A(3)], threshold: 1 }]), "the same people, a different number needed: differ");
ok(signersDiffer([{ owners: [A(2), A(3)], threshold: 2 }, { owners: [A(2), A(4)], threshold: 2 }]), "the same count, different people: differ");
console.log(bad ? `\n${bad} FAILED` : "\nall pass");
process.exit(bad ? 1 : 0);
