"use client";

import { mountain, setMode } from "@/lib/mode";

/**
 * Settings → Mode (lib/mode.ts, docs/MODES.md): mountain man (check everything, the default on a copy on your own
 * computer) or finance bro (smooth, the default on our site). It only sets defaults: flipping it reloads the page
 * into them, and a switch flipped by hand stays.
 */
export function ModeSetting() {
  const on = mountain();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={on} onChange={e => (setMode(e.target.checked ? "mountain" : "bro"), location.reload())} />
        Mountain man mode
      </label>
      <span className="fine">{on ? "On. This browser checks what the node says. Slower." : "This browser checks what the node says. Slower."}</span>
    </div>
  );
}
