"use client";

import { useEffect } from "react";
import { cancelPending, getPending } from "@/lib/safe/pending";
import { shareTx, sigHex } from "@/lib/safe/share";
import type { ChainState, SafeAccount } from "@/lib/safe/state";

/**
 * Transactions parked for the wedgie before there was a queue (a phone signed, a computer finished): each moves into
 * the queue once, so home has one waiting list (Waiting.tsx). Nothing new parks (lib/safe/send.ts finishOwners).
 */
export function PendingCards({ account, states, onDone }: { account: SafeAccount; states: ChainState[]; onDone: () => void }) {
  const key = states.filter(s => s.hasWedgie).map(s => s.chainId).join();
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(
      key.split(",").map(async c => {
        const p = await getPending(Number(c), account.address).catch(() => null);
        if (!p) return false;
        const got = await shareTx({ chainId: p.chainId, safe: p.safe, tx: p.tx, hash: p.hash, sigs: p.sigs.map(s => ({ owner: s.signer, signature: sigHex(s) })), label: p.label });
        if (!got.queue && !got.safe) return false; // try again next time
        await cancelPending(p);
        return true;
      }),
    )
      .then(moved => live && moved.some(Boolean) && onDone())
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, account.address]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
