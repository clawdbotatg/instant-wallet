"use client";

import { useState } from "react";

/**
 * ?pair=wedgie: the extension opens this in a small popup (its pair.html frames it, like the side panel) because Chrome can't
 * show the USB picker in a side panel ("No port selected by the user", 10-27). Picking the wedgie here gives the same
 * page, framed by the same extension, the port: the side panel then finds it without asking.
 */
export function PairWedgie() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick() {
    setError(null);
    try {
      await (navigator as any).serial.requestPort({ filters: [{ usbVendorId: 0x2e8a }] });
      setDone(true);
      window.parent.postMessage({ __iwp: "paired" }, "*"); // the extension's popup closes itself
    } catch (e: any) {
      setError(/No port selected/.test(e?.message || "") ? "No wedgie picked. Plug it in and try again." : e?.message || String(e));
    }
  }
  return (
    <div className="stack" style={{ maxWidth: 420, margin: "64px auto", padding: "0 16px", textAlign: "center" }}>
      <h2>{done ? "Wedgie connected" : "Connect your wedgie"}</h2>
      {done ? (
        <p>Tap Approve again in the side panel.</p>
      ) : (
        <>
          <p>Plug it in, tap the button, and pick it in Chrome&apos;s list. Only once.</p>
          <button className="btn btn-green wide" onClick={pick}>
            Connect your wedgie
          </button>
        </>
      )}
      {error && <p className="warn-note">{error}</p>}
    </div>
  );
}
