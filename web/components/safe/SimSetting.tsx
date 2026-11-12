"use client";

import { useEffect, useState } from "react";
import { TimedBar } from "../bits";
import { SIM_DEFAULT, setSimUrl, setWedgieSim, simUrl, wedgieSim } from "@/lib/safe/sim";

/** Settings → Simulator: which clear-sim works out what a transaction moves (lib/safe/sim.ts). Yours, if you run one. */
export function SimSetting({ toast }: { toast: (m: string) => void }) {
  const [url, setUrl] = useState("");
  const [onWedgie, setOnWedgie] = useState(true);
  const [checking, setChecking] = useState(false);
  useEffect(() => (setUrl(simUrl() === SIM_DEFAULT ? "" : simUrl()), setOnWedgie(wedgieSim())), []);
  const save = async () => {
    const u = url.trim().replace(/\/$/, "");
    if (u) {
      // it must answer as a clear-sim (its key), or it isn't kept
      setChecking(true);
      const k = await fetch(u, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json())
        .catch(() => null)
        .finally(() => setChecking(false));
      if (k?.name !== "clear-sim" || !k?.x) return toast("That isn't a clear-sim");
    }
    setSimUrl(u || null);
    toast(u ? "Using your simulator" : "Using sim.wedgie.dev");
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <input className="grow" value={url} onChange={e => setUrl(e.target.value)} placeholder={SIM_DEFAULT} inputMode="url" autoCapitalize="off" autoCorrect="off" />
        <button className="btn btn-sm" onClick={save} disabled={checking}>
          Save
        </button>
      </div>
      {checking && <TimedBar ms={8000} />}
      <label className="row fine" style={{ gap: 8 }}>
        <input type="checkbox" checked={onWedgie} onChange={e => (setWedgieSim(e.target.checked), setOnWedgie(e.target.checked))} />
        Simulate on the wedgie
      </label>
    </div>
  );
}
