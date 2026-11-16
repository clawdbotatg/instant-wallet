import { type Address, encodeFunctionData } from "viem";
import { type Call, abi, selfCall } from "./core";

/** The signers that matter for "the same on every network": who, and how many must sign. */
export type Signers = { owners: Address[]; threshold: number };

const lc = (x: string) => x.toLowerCase();
const SENTINEL = "0x0000000000000000000000000000000000000001";

/** A network's signers as one string. Two networks match when these do. */
export const signersKey = (s: Signers) => `${s.threshold}:${s.owners.map(lc).sort().join()}`;

/** True when the networks don't all have the same signers. */
export const signersDiffer = (list: Signers[]) => new Set(list.map(signersKey)).size > 1;

/**
 * The calls that turn `has` (a network's signers now) into `want` (another network's): add the missing ones, remove
 * the extra ones, then set how many must sign. `deploy`: for a signer that is a passkey contract (lowercase address),
 * the call that makes it on this network, put before its add.
 */
export function matchCalls(safe: Address, want: Signers, has: Signers, deploy: Record<string, Call> = {}): Call[] {
  if (!want.owners.length) throw new Error("A wallet needs at least one signer.");
  if (want.threshold < 1 || want.threshold > want.owners.length) throw new Error("Couldn't read the signers. Try again.");
  const call = (functionName: "addOwnerWithThreshold" | "removeOwner" | "changeThreshold", args: readonly unknown[]) =>
    selfCall(safe, encodeFunctionData({ abi: abi.safe, functionName, args } as any));
  const calls: Call[] = [];
  let owners = [...has.owners];
  let thr = has.threshold;
  for (const o of want.owners.filter(o => !has.owners.some(x => lc(x) === lc(o)))) {
    if (deploy[lc(o)]) calls.push(deploy[lc(o)]);
    calls.push(call("addOwnerWithThreshold", [o, BigInt(thr)]));
    owners = [o, ...owners]; // the Safe puts a new owner first
  }
  for (const o of has.owners.filter(o => !want.owners.some(x => lc(x) === lc(o)))) {
    const i = owners.findIndex(x => lc(x) === lc(o));
    // getOwners is the Safe's linked list in order: the one before it, or the sentinel for the first
    const prev = i === 0 ? SENTINEL : owners[i - 1];
    thr = Math.min(thr, owners.length - 1);
    calls.push(call("removeOwner", [prev, owners[i], BigInt(thr)]));
    owners.splice(i, 1);
  }
  if (want.threshold !== thr) calls.push(call("changeThreshold", [BigInt(want.threshold)]));
  return calls;
}
