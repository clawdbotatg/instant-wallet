"use client";

import { useEffect, useState } from "react";

/**
 * A yellow pill at the top when the internet is the slow part, not us (Austin 11-06: a send's green bar crawled on bad
 * wifi and they blamed the wallet). Watches every fetch (RPC, our API): one still open after SLOW_MS, or one that
 * took that long in the last HOLD_MS, shows "Slow internet". Offline shows "No internet".
 */
const SLOW_MS = 5000;
const HOLD_MS = 8000;

const open = new Map<number, number>(); // id → start
let lastSlow = 0;
let patched = false;

function patch() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const real = window.fetch.bind(window);
  let n = 0;
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const id = ++n;
    const t0 = Date.now();
    open.set(id, t0);
    try {
      return await real(...args);
    } finally {
      open.delete(id);
      if (Date.now() - t0 >= SLOW_MS) lastSlow = Date.now();
    }
  }) as typeof fetch;
}

export function NetBar() {
  const [state, setState] = useState<"ok" | "slow" | "offline">("ok");
  useEffect(() => {
    patch();
    const tick = () => {
      const now = Date.now();
      if (typeof navigator !== "undefined" && navigator.onLine === false) return setState("offline");
      const stuck = [...open.values()].some(t => now - t >= SLOW_MS);
      setState(stuck || now - lastSlow < HOLD_MS ? "slow" : "ok");
    };
    const i = setInterval(tick, 1000);
    addEventListener("online", tick);
    addEventListener("offline", tick);
    return () => {
      clearInterval(i);
      removeEventListener("online", tick);
      removeEventListener("offline", tick);
    };
  }, []);
  if (state === "ok") return null;
  return (
    <div className="netbar" role="status">
      {state === "offline" ? "No internet" : "Slow internet…"}
    </div>
  );
}
