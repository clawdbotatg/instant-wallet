"use client";

import { useEffect, useState } from "react";
import { SIM_DEFAULT, setSimUrl, simUrl } from "@/lib/safe/sim";

/** Settings → Simulator: which clear-sim works out what a transaction moves (lib/safe/sim.ts). Yours, if you run one. */
export function SimSetting({ toast }: { toast: (m: string) => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(simUrl() === SIM_DEFAULT ? "" : simUrl()), []);
  const save = async () => {
    const u = url.trim().replace(/\/$/, "");
    if (u) {
      // it must answer as a clear-sim (its key), or it isn't kept
      const k = await fetch(u, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json())
        .catch(() => null);
      if (k?.name !== "clear-sim" || !k?.x) return toast("That isn't a clear-sim");
    }
    setSimUrl(u || null);
    toast(u ? "Using your simulator" : "Using sim.wedgie.dev");
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="fine">
        Works out what a transaction sends and gets before you sign. Run{" "}
        <a href="https://github.com/clawdbotatg/clear-sim" target="_blank" rel="noopener noreferrer">
          your own
        </a>{" "}
        and put its address here.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input className="grow" value={url} onChange={e => setUrl(e.target.value)} placeholder={SIM_DEFAULT} inputMode="url" autoCapitalize="off" autoCorrect="off" />
        <button className="btn btn-sm" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
