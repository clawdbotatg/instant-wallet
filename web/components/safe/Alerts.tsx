"use client";

import { useCallback, useEffect, useState } from "react";
import { assertChallenge, bio } from "@/lib/passkey";
import type { SafeAccount } from "@/lib/safe/state";
import { toWebAuthnSig } from "@/lib/safe/sign";
import { keccak256, toBytes } from "viem";
import { friendly } from "../Welcome";

type Info = { channels: { email: boolean; telegram: boolean; push: boolean }; contacts: { email: string | null; telegram: boolean; push: string[] } };

/** Same bytes as changeDigest in lib/alerts.ts. */
const digest = (wallet: string, change: string, ts: number) => keccak256(toBytes(`Instant Wallet alerts\n${wallet.toLowerCase()}\n${change}\n${ts}`));

/** Face ID over the change, then send it. Call straight from a tap: the passkey prompt must start from one. */
async function change(a: SafeAccount, ch: object) {
  const c = JSON.stringify(ch);
  const ts = Date.now();
  const h = digest(a.address, c, ts);
  const s = await assertChallenge(a.credentialId, h);
  const w = toWebAuthnSig(s.authenticatorData, s.clientDataJSON, s.r, s.s, h);
  const r = await fetch("/api/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: a.address, change: c, sig: { qx: a.qx, qy: a.qy, authenticatorData: w.authenticatorData, clientDataFields: w.clientDataFields, r: s.r, s: s.s, ts } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  if (j.errors?.length) throw new Error(`Saved, but the test message failed: ${j.errors[0]}`);
  return j as { link?: string };
}

const pushable = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));

/**
 * Recovery alerts with the app closed (lib/alerts.ts): an email, Telegram, notifications on this device. Every
 * change is one Face ID; taking one away tells the others.
 */
export function Alerts({ account, toast }: { account: SafeAccount; toast: (m: string) => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ what: string; msg: string } | null>(null);
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [sub, setSub] = useState<PushSubscription | null>(null); // this device's, once allowed (step 1 of 2)
  const [here, setHere] = useState(false); // this device already gets them

  const load = useCallback(async () => {
    const j = (await fetch(`/api/alerts?wallet=${account.address}`).then(r => r.json()).catch(() => null)) as Info | null;
    if (!j?.channels) return;
    setInfo(j);
    if (pushable()) {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const s = await reg?.pushManager.getSubscription();
      setHere(!!s && j.contacts.push.includes(s.endpoint.slice(-12)));
    }
  }, [account.address]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(what: string, ch: object, done?: string) {
    setBusy(what);
    setError(null);
    try {
      const j = await change(account, ch);
      if (j.link) setTgLink(j.link);
      if (done) toast(done);
      return true;
    } catch (e) {
      setError({ what, msg: friendly(e) });
      return false;
    } finally {
      await load();
      setBusy(null);
    }
  }

  // notifications: allow + subscribe first (its own tap), then Face ID on the next
  async function allow() {
    setBusy("push");
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's settings.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const s = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(process.env.NEXT_PUBLIC_VAPID_KEY!) }));
      setSub(s);
    } catch (e) {
      setError({ what: "push", msg: friendly(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!info) return <p className="fine">Loading…</p>;
  const c = info.contacts;
  const err = (what: string) => error?.what === what && <p className="err">{error.msg}</p>;
  const none = !c.email && !c.telegram && !c.push.length;

  return (
    <>
      <p className="fine">
        {none ? "Nothing yet. " : ""}If anyone starts a recovery on this wallet, you hear about it here, even with the app closed. You have at least 7 days to cancel.
      </p>

      {info.channels.email && (
        <div className="stack" style={{ gap: 8 }}>
          {c.email ? (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>📧 {c.email}</span>
              <button className="pill" disabled={!!busy} onClick={() => run("email", { op: "email-off" }, "Email alerts off")}>
                {busy === "email" ? "…" : "Remove"}
              </button>
            </div>
          ) : (
            <div className="row">
              <div className="input grow">
                <input type="email" inputMode="email" autoCapitalize="none" placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value.trim())} />
              </div>
              <button className="btn btn-green" disabled={!!busy || !/^\S+@\S+\.\S+$/.test(email)} onClick={async () => (await run("email", { op: "email", email }, "Check your email")) && setEmail("")}>
                {busy === "email" ? "…" : "Save"}
              </button>
            </div>
          )}
          {err("email")}
        </div>
      )}

      {info.channels.telegram && (
        <div className="stack" style={{ gap: 8 }}>
          {c.telegram ? (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>✈️ Telegram</span>
              <button className="pill" disabled={!!busy} onClick={() => run("tg", { op: "telegram-off" }, "Telegram alerts off")}>
                {busy === "tg" ? "…" : "Remove"}
              </button>
            </div>
          ) : tgLink ? (
            <a className="btn btn-green wide" href={tgLink} target="_blank" rel="noreferrer" onClick={() => setTimeout(load, 8000)}>
              Open Telegram and tap Start
            </a>
          ) : (
            <button className="btn wide" disabled={!!busy} onClick={() => run("tg", { op: "telegram" })}>
              {busy === "tg" ? "…" : "✈️ Telegram"}
            </button>
          )}
          {err("tg")}
        </div>
      )}

      {info.channels.push && pushable() && (
        <div className="stack" style={{ gap: 8 }}>
          {here ? (
            <span>🔔 This device gets notifications</span>
          ) : sub ? (
            <button className="btn btn-green wide" disabled={!!busy} onClick={async () => (await run("push", { op: "push", sub: sub.toJSON() }, "Notifications on")) && setSub(null)}>
              {busy === "push" ? "…" : `Confirm with ${bio()}`}
            </button>
          ) : (
            <button className="btn wide" disabled={!!busy} onClick={allow}>
              {busy === "push" ? "…" : "🔔 Notifications on this device"}
            </button>
          )}
          {err("push")}
        </div>
      )}

      {!none && (
        <button className="pill" disabled={!!busy} onClick={() => run("test", { op: "test" }, "Test sent")}>
          {busy === "test" ? "Sending…" : "Send a test"}
        </button>
      )}
      {err("test")}
    </>
  );
}
