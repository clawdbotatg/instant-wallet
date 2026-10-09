"use client";

import { useCallback, useEffect, useState } from "react";
import { type ChainState, type SafeAccount, wedgieSigners } from "@/lib/safe/state";
import { type Peek, Wedgie, wedgieArmed, wedgieSupported } from "@/lib/safe/wedgie";
import { Blockie, Sheet } from "../bits";

/** The wedgie, drawn after the device render (design/brand/device-mark.png): white shell, a bill and a card behind, knob, screen, four buttons. */
export function WedgieIcon({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 52) / 64} viewBox="0 0 64 52" aria-hidden>
      <rect x="9" y="3" width="30" height="20" rx="2.5" fill="#3fbf5a" transform="rotate(-12 24 13)" />
      <circle cx="24" cy="13" r="4.5" fill="#2a9d44" transform="rotate(-12 24 13)" />
      <rect x="38" y="5" width="18" height="20" rx="2.5" fill="#e3312c" transform="rotate(8 47 15)" />
      <rect x="45" y="9" width="6" height="4" rx="1" fill="#f6a3a0" transform="rotate(8 47 15)" />
      <rect x="2" y="15" width="60" height="35" rx="8" fill="#55575a" />
      <rect x="2" y="14" width="60" height="33" rx="8" fill="#fbfbf9" stroke="#d6d6d1" strokeWidth="1" />
      <rect x="22" y="19" width="21" height="23" rx="2.5" fill="#1d1f1d" />
      <polyline points="25,37 29,32 32,35 36,28 40,25" fill="none" stroke="#3fd768" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <rect x="25" y="22" width="10" height="2.4" rx="1" fill="#e8e8e4" />
      <circle cx="12" cy="30.5" r="5.5" fill="#6d6e70" />
      <circle cx="12" cy="30.5" r="3.6" fill="#818285" />
      {["#2fc552", "#8a8b8d", "#8a8b8d", "#e3312c"].map((c, i) => (
        <rect key={i} x="48" y={19 + i * 6} width="8" height="4.4" rx="1.2" fill={c} />
      ))}
    </svg>
  );
}

/** The transaction's picture: the wedgie draws the same blockie of the Safe tx hash on its first page. */
export function TxPicture({ hash }: { hash: string }) {
  return (
    <div className="row" style={{ justifyContent: "center", gap: 12 }}>
      <Blockie address={hash} size={48} />
      <span className="fine" style={{ textAlign: "left" }}>
        The wedgie shows this picture.
        <br />
        <span className="mono">tx {hash.slice(0, 6)}..{hash.slice(-4)}</span>
      </span>
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "off";
type Status = { tone: Tone; title: string; detail: string; key?: { x: `0x${string}`; y: `0x${string}` } };

const same = (a?: { x: string; y: string }, b?: { x: string; y: string }) =>
  !!a && !!b && a.x.toLowerCase() === b.x.toLowerCase() && a.y.toLowerCase() === b.y.toLowerCase();

function statusOf(peek: Peek | null, account: SafeAccount, states: ChainState[]): Status {
  const onWallet = states.some(s => s.hasWedgie);
  if (!wedgieSupported())
    return {
      tone: "off",
      title: "Wedgie: computer only",
      detail: "A wedgie plugs into Chrome or Edge on a computer over USB. Open this wallet there to use it.",
    };
  if (!peek || peek.kind === "none")
    return {
      tone: "off",
      title: "No wedgie plugged in",
      detail: wedgieArmed()
        ? "Plug your wedgie into this computer. It shows up here by itself."
        : "Plug your wedgie into this computer and tap Find my wedgie (once per browser).",
    };
  if (peek.kind === "busy") return { tone: "ok", title: "Wedgie connected", detail: "It's signing a transaction now." };
  if (peek.kind === "silent")
    return { tone: "bad", title: "Wedgie isn't answering", detail: `${peek.error} If it just booted, give it a second and check again; otherwise update its firmware at wedgie.dev.` };
  const h = peek.hello;
  if (!("safe" in h))
    return {
      tone: "bad",
      title: "Wrong app on the wedgie",
      detail: `It's running ${h.running ? `“${h.running}”` : "no app"}. Install the Safe signer app at wedgie.dev.`,
    };
  if (!h.safe) return { tone: "warn", title: "Wedgie has no key yet", detail: "Press A on its screen to make its Safe key. It never leaves the chip." };
  const mine = account.wedgie;
  if (mine && !same(mine, h.safe))
    return { tone: "bad", title: "A different wedgie", detail: "This wedgie's key isn't the one on this wallet. Plug in the one you added.", key: h.safe };
  if (!mine && !onWallet)
    return { tone: "warn", title: "Wedgie ready", detail: "It isn't on this wallet yet. Add it and it counts twice: big moves need it + one more key.", key: h.safe };
  if (!mine && onWallet)
    return { tone: "ok", title: "Wedgie connected", detail: "This wallet has a wedgie (added on another device). Sign with this one and the wallet checks it.", key: h.safe };
  return { tone: "ok", title: "Wedgie connected", detail: "This is your wallet's wedgie. It signs big moves with one A press.", key: h.safe };
}

/** Bottom left: the wedgie. Solid when the wallet's wedgie is plugged in and ready; faded when there's none; a blip when something's off. */
export function WedgieButton({ account, states, onKeys }: { account: SafeAccount; states: ChainState[]; onKeys: () => void }) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [armed, setArmed] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const p = await Wedgie.peek();
      if (p.kind !== "busy") setPeek(p); // busy: keep what we last saw
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    setArmed(wedgieArmed());
    check();
    const onFocus = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  useEffect(() => {
    if (!armed) return;
    // a wedgie's port drops and comes back once after plug-in: wait it out before asking
    let t: number | undefined;
    const off = Wedgie.watch(() => {
      clearTimeout(t);
      t = window.setTimeout(check, 1500);
    });
    return () => {
      clearTimeout(t);
      off();
    };
  }, [armed, check]);

  const st = statusOf(peek, account, states);
  const plugged = peek?.kind === "hello" || peek?.kind === "busy";
  const hello = peek?.kind === "hello" ? peek.hello : null;
  const onWallet = states.some(s => s.hasWedgie);
  const chains = states.filter(s => s.hasWedgie).length;

  return (
    <>
      <button
        className={`fab fab-wedgie ${st.tone}`}
        aria-label={st.title}
        title={st.title}
        onClick={() => {
          setOpen(true);
          check();
        }}
      >
        <WedgieIcon size={50} />
        {st.tone !== "ok" && st.tone !== "off" && <span className="blip">!</span>}
      </button>

      {open && (
        <Sheet onClose={() => setOpen(false)}>
          <div className="wedgie-hero">
            <WedgieIcon size={150} />
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <h2 className="row" style={{ gap: 10 }}>
              <span className={`dot ${st.tone}`} />
              {checking && !peek ? "Looking for your wedgie…" : st.title}
            </h2>
            <p className="fine">{st.detail}</p>
            {!plugged && !onWallet && !account.wedgie && (
              <p className="fine">
                Don&apos;t have one?{" "}
                <a href="https://wedgie.dev" target="_blank" rel="noreferrer">
                  Get one at wedgie.dev
                </a>
              </p>
            )}
          </div>

          {(hello || onWallet || account.wedgie) && (
            <div className="card kv">
              {hello?.short && (
                <div>
                  <span>Device</span>
                  <b className="mono">{hello.short}</b>
                </div>
              )}
              {hello?.version && (
                <div>
                  <span>Firmware</span>
                  <b>{hello.version}</b>
                </div>
              )}
              {hello && (
                <div>
                  <span>App</span>
                  <b>{"safe" in hello ? "Safe signer" : hello.running || "none"}</b>
                </div>
              )}
              {st.key && (
                <div>
                  <span>Signs as</span>
                  <b className="mono">{wedgieSigners(st.key)[0].slice(0, 10)}…</b>
                </div>
              )}
              <div>
                <span>On this wallet</span>
                <b>{onWallet ? `yes, on ${chains} chain${chains === 1 ? "" : "s"}` : account.wedgie ? "yes" : "not yet"}</b>
              </div>
            </div>
          )}

          <div className="stack">
            {wedgieSupported() && !plugged && (
              <button
                className="btn btn-green wide"
                onClick={async () => {
                  if (await Wedgie.pick()) {
                    setArmed(true);
                    check();
                  }
                }}
              >
                Find my wedgie
              </button>
            )}
            {st.tone === "warn" && st.key && !onWallet && (
              <button
                className="btn btn-green wide"
                onClick={() => {
                  setOpen(false);
                  onKeys();
                }}
              >
                Add it to this wallet
              </button>
            )}
            {wedgieSupported() && armed && (
              <button className="btn wide" onClick={check} disabled={checking}>
                {checking ? "Checking…" : "Check again"}
              </button>
            )}
            {wedgieSupported() && armed && (
              <button
                className="pill"
                style={{ justifySelf: "center" }}
                onClick={async () => {
                  await Wedgie.forget();
                  setPeek({ kind: "none" });
                }}
              >
                Forget this wedgie in this browser
              </button>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
