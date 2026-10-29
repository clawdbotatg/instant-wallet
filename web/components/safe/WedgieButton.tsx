"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type ChainState, type SafeAccount, wedgieHome } from "@/lib/safe/state";
import {
  type Latest,
  OldFirmware,
  type Peek,
  Wedgie,
  behind,
  installSafeApp,
  latestWedgie,
  onWedgieActivity,
  watchDriveConnect,
  type WedgieActivity,
  openDrivePanel,
  wedgieArmed,
  wedgieDrive,
  wedgieSerial,
  wedgieSupported,
  WEDGIE_TAKEN,
} from "@/lib/safe/wedgie";
import { Blockie } from "../bits";

/** The wedgie, drawn after the device render (design/brand/device-mark.png): white shell, a bill and a card behind, knob, screen, four buttons. */
export function WedgieIcon({ size = 44, sad = false }: { size?: number; sad?: boolean }) {
  return (
    <svg width={size} height={(size * 52) / 64} viewBox="0 0 64 52" aria-hidden>
      <rect x="9" y="3" width="30" height="20" rx="2.5" fill="#3fbf5a" transform="rotate(-12 24 13)" />
      <circle cx="24" cy="13" r="4.5" fill="#2a9d44" transform="rotate(-12 24 13)" />
      <rect x="38" y="5" width="18" height="20" rx="2.5" fill="#e3312c" transform="rotate(8 47 15)" />
      <rect x="45" y="9" width="6" height="4" rx="1" fill="#f6a3a0" transform="rotate(8 47 15)" />
      <rect x="2" y="15" width="60" height="35" rx="8" fill="#55575a" />
      <rect x="2" y="14" width="60" height="33" rx="8" fill="#fbfbf9" stroke="#d6d6d1" strokeWidth="1" />
      <rect x="22" y="19" width="21" height="23" rx="2.5" fill="#1d1f1d" />
      {sad ? (
        // overworked: tired eyes, a frown, a drop of sweat
        <>
          <path d="M25.5 27.5 l4 -1.5 M39.5 27.5 l-4 -1.5" stroke="#e8e8e4" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="28" cy="30" r="1.4" fill="#e8e8e4" />
          <circle cx="37" cy="30" r="1.4" fill="#e8e8e4" />
          <path d="M27.5 38.5 q5 -4.5 10 0" fill="none" stroke="#e3312c" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M60 6 q3 5 0 7 q-3 -2 0 -7z" fill="#5db7f0" />
        </>
      ) : (
        <>
          <polyline points="25,37 29,32 32,35 36,28 40,25" fill="none" stroke="#3fd768" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          <rect x="25" y="22" width="10" height="2.4" rx="1" fill="#e8e8e4" />
        </>
      )}
      <circle cx="12" cy="30.5" r="5.5" fill="#6d6e70" />
      <circle cx="12" cy="30.5" r="3.6" fill="#818285" />
      {["#2fc552", "#8a8b8d", "#8a8b8d", "#e3312c"].map((c, i) => (
        <rect key={i} x="48" y={19 + i * 6} width="8" height="4.4" rx="1.2" fill={c} />
      ))}
    </svg>
  );
}

/** An error line; "the wedgie is busy in another tab" gets the sad wedgie. */
export function ErrorLine({ text }: { text: string }) {
  if (!text.includes(WEDGIE_TAKEN)) return <p className="err">{text}</p>;
  return (
    <div className="row" style={{ gap: 14 }}>
      <WedgieIcon size={64} sad />
      <div className="grow">
        <b>Wedgie busy</b>
        <div className="fine">It&apos;s open in another tab. Close that tab, then try again.</div>
      </div>
    </div>
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

/** A bar that creeps on time (never looks stuck), for a wait of about `ms`. */
function Creep({ ms = 6000 }: { ms?: number }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const t = window.setInterval(() => setP(0.95 * (1 - Math.exp(-(Date.now() - t0) / ms))), 300);
    return () => clearInterval(t);
  }, [ms]);
  return (
    <div className="progress">
      <div style={{ width: `${Math.max(4, p * 100)}%`, transitionDuration: "300ms" }} />
    </div>
  );
}

/** A bar stuck to the bottom of the screen while the wedgie works: what it's doing, a bar that creeps between
 * real steps (never looks stuck), and "press the green button" when it waits for the person. */
export function WedgieProgress() {
  const [a, setA] = useState<WedgieActivity>(null);
  const [p, setP] = useState(0);
  useEffect(() => watchDriveConnect(), []);
  useEffect(() => onWedgieActivity(next => {
    setA(next);
    setP(q => (next ? Math.min(1, Math.max(q, next.p ?? 0)) : 0));
  }), []);
  useEffect(() => {
    if (!a) return;
    const t = window.setInterval(() => setP(q => Math.min(q + (0.01 + Math.random() * 0.01) * (1 - q), 0.98)), 500);
    return () => clearInterval(t);
  }, [a]);
  if (!a) return null;
  return (
    <div className={`wedgie-progress ${a.press ? "press" : ""}`} role="status">
      <WedgieIcon size={40} />
      <div className="grow stack" style={{ gap: 8 }}>
        <b>{a.what}</b>
        <div className="progress">
          <div style={{ width: `${Math.max(4, p * 100)}%`, transitionDuration: "500ms" }} />
        </div>
      </div>
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "off";
// install: the main button puts the Safe signer on it (wrong app, not answering, or an older Safe signer)
// update: it's behind wedgie.dev (firmware: update at wedgie.dev; app: the install button updates it here)
// drive (iPhone app): find = pick the WEDGIE drive in the app's panel
type Status = { tone: Tone; title: string; detail: string; key?: { x: `0x${string}`; y: `0x${string}` }; install?: boolean; get?: boolean; update?: "firmware" | "app"; drive?: "find" };

const same = (a?: { x: string; y: string }, b?: { x: string; y: string }) =>
  !!a && !!b && a.x.toLowerCase() === b.x.toLowerCase() && a.y.toLowerCase() === b.y.toLowerCase();

function statusOf(peek: Peek | null, account: SafeAccount, states: ChainState[], latest: Latest | null): Status {
  const st = baseStatus(peek, account, states);
  if (peek?.kind !== "hello" || st.tone === "bad" || st.install) return st;
  const b = behind(peek.hello, latest);
  const tone = st.tone === "ok" ? "warn" : st.tone;
  if (b.firmware) return { ...st, tone, update: "firmware" };
  if (b.app) return { ...st, tone, update: "app", install: true };
  return st;
}

function baseStatus(peek: Peek | null, account: SafeAccount, states: ChainState[]): Status {
  const onWallet = states.some(s => s.hasWedgie);
  if (!wedgieSupported())
    return {
      tone: "off",
      title: "Wedgie: computer only",
      detail: "A wedgie plugs into Chrome or Edge on a computer over USB, or into an iPhone with the Instant Wallet app. Open this wallet there to use it.",
    };
  if (peek?.kind === "phone") {
    if (peek.state === "readonly") // the app connects it by itself (the bottom bar shows it)
      return { tone: "warn", title: peek.press ? "Press the green button on your wedgie" : "Connecting your wedgie", detail: "" };
    if (peek.state === "away") return { tone: "off", title: "No wedgie plugged in", detail: "Plug your wedgie into this iPhone. It shows up here by itself." };
    return !onWallet && !account.wedgie
      ? { tone: "off", title: "No wedgie yet", detail: "A wedgie is a small signing device. Add one and big moves need it.", get: true, drive: "find" }
      : { tone: "off", title: "Connect your wedgie", detail: "Plug it into this iPhone and tap Find my wedgie. You only do this once.", drive: "find" };
  }
  if (!peek || peek.kind === "none")
    return !onWallet && !account.wedgie && !wedgieArmed()
      ? { tone: "off", title: "No wedgie yet", detail: "A wedgie is a small signing device. Add one and big moves need it.", get: true }
      : {
          tone: "off",
          title: "No wedgie plugged in",
          detail: wedgieArmed()
            ? "Plug your wedgie into this computer. It shows up here by itself."
            : "Plug your wedgie into this computer and tap Find my wedgie (once per browser).",
        };
  if (peek.kind === "busy") return { tone: "ok", title: "Wedgie connected", detail: "" };
  if (peek.kind === "taken") return { tone: "bad", title: "Wedgie busy", detail: "It's open in another tab (wedgie.dev, or Instant Wallet in another window). Close that tab, then check again." };
  if (peek.kind === "silent" && wedgieDrive()) // the drive is up but no answer yet: it keeps asking (no install advice)
    return { tone: "warn", title: "Waiting for your wedgie to answer", detail: "" };
  if (peek.kind === "silent")
    return { tone: "bad", title: "Wedgie isn't answering", detail: "Unplug it, hold X while you plug it back in (that skips its app), then install the Safe signer.", install: true };
  const h = peek.hello;
  if (!("safe" in h))
    return {
      tone: "bad",
      title: "Wrong app on the wedgie",
      detail: `It's running ${h.running ? `“${h.running}”` : "no app"}. This wallet needs the Safe signer.`,
      install: true,
    };
  if (!h.safe) return { tone: "warn", title: "Wedgie has no key yet", detail: "Press A on its screen to make its Safe key. It never leaves the chip." };
  const mine = account.wedgie;
  if (mine && !same(mine, h.safe))
    return { tone: "bad", title: "A different wedgie", detail: "This wedgie's key isn't the one on this wallet. Plug in the one you added.", key: h.safe };
  if (!mine && !onWallet)
    return { tone: "warn", title: "Wedgie ready", detail: "It isn't a signer on this wallet yet.", key: h.safe };
  if (!mine && onWallet)
    return { tone: "ok", title: "Wedgie connected", detail: "", key: h.safe };
  return { tone: "ok", title: "Wedgie connected", detail: "", key: h.safe };
}

/**
 * The wedgie, inside settings' signers (Austin 10-28: no wedgie button on the home screen): is it plugged in, the
 * right app and key, up to date; find / install / update. `add`: the button that adds it as a signer, shown once a
 * wedgie that isn't on this wallet is plugged in and ready.
 */
export function WedgiePanel({ account, states, add }: { account: SafeAccount; states: ChainState[]; add?: ReactNode }) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const open = true; // mounted = shown
  const [checking, setChecking] = useState(false);
  const [armed, setArmed] = useState(false);
  const [installing, setInstalling] = useState<{ what: string; p?: number } | null>(null);
  const [installErr, setInstallErr] = useState<{ msg: string; old?: boolean } | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null);

  async function install() {
    setInstallErr(null);
    setInstalling({ what: "Connecting…" });
    try {
      await installSafeApp((what, p) => setInstalling({ what, p }));
      setArmed(true);
      // it restarts into the new app: look again once it's back
      await new Promise(r => setTimeout(r, 4000));
      await check();
    } catch (e: any) {
      setInstallErr({ msg: e?.message || String(e), old: e instanceof OldFirmware });
    } finally {
      setInstalling(null);
    }
  }

  const check = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const p = await Wedgie.peek(fresh);
      if (p.kind !== "busy") setPeek(p); // busy: keep what we last saw
      if (p.kind === "hello") setLatest(await latestWedgie());
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
    if (!armed && !wedgieDrive()) return;
    // a wedgie's serial port drops and comes back once after plug-in: wait it out before asking (the iPhone
    // app's drive has no such drop: look at once)
    let t: number | undefined;
    const off = Wedgie.watch(() => {
      clearTimeout(t);
      t = window.setTimeout(check, wedgieDrive() ? 0 : 1500);
    });
    return () => {
      clearTimeout(t);
      off();
    };
  }, [armed, check]);

  // on the phone, a wedgie that didn't answer is asked again every 3 s while this sheet is open
  useEffect(() => {
    if (!open || !wedgieDrive() || peek?.kind !== "silent") return;
    const t = window.setTimeout(() => check(true), 3000);
    return () => clearTimeout(t);
  }, [open, peek, check]);

  const st = statusOf(peek, account, states, latest);
  const plugged = peek?.kind === "hello" || peek?.kind === "busy";
  const hello = peek?.kind === "hello" ? peek.hello : null;
  const onWallet = states.some(s => s.hasWedgie);

  return (
    <div className="stack" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            <b className="row" style={{ gap: 10 }}>
              <span className={`dot ${st.tone}`} />
              {checking && !peek ? "Looking for your wedgie…" : st.title}
            </b>
            {st.detail && <p className="fine">{st.detail}</p>}
            {wedgieDrive() && peek?.kind === "silent" && <Creep />}
            {st.update === "firmware" && hello && latest && (
              <p className="warn-note">
                Its firmware is {hello.version}. wedgie.dev has {latest.version}. Update it there, then come back.
              </p>
            )}
            {st.update === "app" && <p className="warn-note">wedgie.dev has a newer Safe signer. Update it here (your key stays).</p>}
            {!plugged && !onWallet && !account.wedgie && !st.get && (
              <p className="fine">
                Don&apos;t have one?{" "}
                <a href="https://wedgie.dev" target="_blank" rel="noreferrer">
                  Get one at wedgie.dev
                </a>
              </p>
            )}
          </div>

          {st.key && st.tone !== "ok" && (
            <p className="fine">
              On its screen: <b className="mono">{`${wedgieHome(st.key).slice(0, 6)}…${wedgieHome(st.key).slice(-4)}`}</b>
            </p>
          )}

          <div className="stack">
            {installing && (
              <div className="stack" style={{ gap: 8 }}>
                <p className="fine">{installing.what}</p>
                <div className="progress">
                  <div style={{ width: `${Math.max(3, (installing.p ?? 0) * 100)}%`, transitionDuration: "300ms" }} />
                </div>
              </div>
            )}
            {installErr && (
              <p className="err">
                {installErr.msg}{" "}
                {installErr.old && (
                  <a href="https://wedgie.dev/connect" target="_blank" rel="noreferrer">
                    Open wedgie.dev
                  </a>
                )}
              </p>
            )}
            {st.update === "firmware" && (
              <a className="btn btn-green wide" href="https://wedgie.dev/connect" target="_blank" rel="noreferrer">
                Update firmware at wedgie.dev
              </a>
            )}
            {st.install && wedgieDrive() && <p className="fine">Install the Safe signer from Chrome or Edge on a computer.</p>}
            {st.drive === "find" && (
              <button className={`btn wide ${st.get ? "" : "btn-green"}`} onClick={() => openDrivePanel()}>
                Find my wedgie
              </button>
            )}
            {st.install && wedgieSerial() && !installing && (
              <button className="btn btn-green wide" onClick={install}>
                {st.update === "app" ? "Update Safe signer" : "Install Safe signer on wedgie"}
              </button>
            )}
            {st.get && (
              <a className="btn btn-green wide" href="https://wedgie.dev" target="_blank" rel="noreferrer">
                Get one at wedgie.dev
              </a>
            )}
            {wedgieSerial() && !plugged && !st.install && (
              <button
                className={`btn wide ${st.get ? "" : "btn-green"}`}
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
            {st.tone === "warn" && st.key && !onWallet && add}
            {st.tone === "bad" && ((wedgieSerial() && armed) || (wedgieDrive() && plugged)) && !installing && (
              <button className="btn wide" onClick={() => check(true)} disabled={checking}>
                {checking ? "Checking…" : "Check again"}
              </button>
            )}
            {wedgieDrive() && !st.drive && st.tone !== "ok" && (
              <button className="pill" style={{ justifySelf: "center" }} onClick={() => openDrivePanel()}>
                Wedgie connection
              </button>
            )}
            {wedgieSerial() && armed && st.tone === "bad" && (
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
    </div>
  );
}
