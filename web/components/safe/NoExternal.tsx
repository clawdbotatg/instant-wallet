"use client";

import { useState } from "react";
import { noExt, syncNoExt } from "@/lib/local";
import { chainById } from "@/lib/chains";

/**
 * Settings → No external traffic, on a copy on your own computer (lib/noext.ts): nothing leaves it but calls to
 * your own nodes. Flipping it reloads the page into the new mode.
 */
export function NoExternal({ toast }: { toast: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const on = noExt();
  const flip = async (v: boolean) => {
    setBusy(true);
    const err = await syncNoExt(v);
    setBusy(false);
    if (err) toast(err);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={!!on} disabled={busy} onChange={e => flip(e.target.checked)} />
        No external traffic
      </label>
      {on ? (
        <span className="fine">On. Only {on.chains.map(c => chainById(c)?.name ?? c).join(", ")} (your node). Pictures over Tor. No simulation, no swaps between networks.</span>
      ) : (
        <span className="fine">Only your own nodes. You won&apos;t see networks you don&apos;t run a node for.</span>
      )}
    </div>
  );
}
