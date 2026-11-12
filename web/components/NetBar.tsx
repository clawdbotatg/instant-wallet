"use client";

import { useEffect, useState } from "react";

/**
 * A yellow pill at the top when the internet is the slow part, not us (Austin 11-06: a send's green bar crawled on bad
 * wifi and they blamed the wallet). Watches every fetch (RPC, our API): one still open after SLOW_MS, or one that
 * took that long in the last HOLD_MS, shows "Slow internet". Offline shows "No internet".
 * A call that's slow on our side by design gets longer before it counts (`slowAfter`): a swap quote asks LI.FI
 * (6–15 s), a relayed send or a drop claim waits its turn and then for the network (up to 60 s). The quick reads
 * around them (the chain every few seconds) still say when the internet is slow.
 */
const SLOW_MS = 5000;
const HOLD_MS = 8000;

/** How long this call may take before it means slow internet. */
function slowAfter(input: unknown, init?: RequestInit): number {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : ((input as Request)?.url ?? "");
    const path = new URL(url, location.origin).pathname;
    const post = (init?.method ?? (input as Request)?.method ?? "GET").toUpperCase() === "POST";
    if (path === "/api/swap/quote") return 30_000;
    if (post && (path === "/api/safe/relay" || path === "/api/drop" || path === "/api/drop/admin")) return 75_000;
  } catch {}
  return SLOW_MS;
}

const open = new Map<number, number>(); // id → when it starts to count as slow
let lastSlow = 0;
let patched = false;

function patch() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const real = window.fetch.bind(window);
  let n = 0;
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const id = ++n;
    const late = Date.now() + slowAfter(args[0], args[1]);
    open.set(id, late);
    try {
      return await real(...args);
    } finally {
      open.delete(id);
      if (Date.now() >= late) lastSlow = Date.now();
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
      const stuck = [...open.values()].some(late => now >= late);
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
