import { type Address, type Hash, type Hex } from "viem";
import { type SafeTx, type Sig } from "./core";

/**
 * Old: a big move parked for the wedgie (before the queue). PendingCard.tsx moves any left into the queue.
 * A big move waiting for the wedgie. The wedgie only plugs into a computer, so a phone signs its part, parks the
 * transaction here (the server checks that signature on chain first), and the computer finishes it: the wedgie
 * signs, the relay sends. One per wallet per chain; it's dropped once the Safe's nonce moves past it.
 */
export type Pending = {
  chainId: number;
  safe: Address;
  tx: SafeTx;
  hash: Hex; // the safeTxHash every key signs
  sigs: Sig[]; // what's signed so far
  burner: { x: Hex; y: Hex };
  label?: string; // "Send 0.5 ETH to alice.eth"
  at: number;
};

const revive = (p: any): Pending => ({ ...p, tx: { ...p.tx, value: BigInt(p.tx.value), nonce: BigInt(p.tx.nonce) } });

export async function getPending(chainId: number, safe: Address): Promise<Pending | null> {
  const r = await fetch(`/api/safe/pending?chainId=${chainId}&safe=${safe}`, { cache: "no-store" });
  const j = await r.json().catch(() => null);
  return j?.pending ? revive(j.pending) : null;
}

export async function cancelPending(p: Pending) {
  await fetch(`/api/safe/pending?chainId=${p.chainId}&safe=${p.safe}&hash=${p.hash}`, { method: "DELETE" });
}

export type { Hash };
