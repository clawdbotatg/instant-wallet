"use client";

import { useSyncExternalStore } from "react";
import { onProven, provenOn, setProven } from "@/lib/safe/proven";
import { Net } from "../bits";

/** Settings → Balances: this browser proves Home's balances with its light client (lib/safe/proven.ts). Off by default. */
export function ProvenSetting() {
  const on = useSyncExternalStore(onProven, provenOn, () => false);
  return (
    <label className="row fine" style={{ gap: 8 }}>
      <input type="checkbox" checked={on} onChange={e => setProven(e.target.checked)} />
      <span>
        Prove <Net chainId={1} /> and <Net chainId={100} /> in this browser
      </span>
    </label>
  );
}
