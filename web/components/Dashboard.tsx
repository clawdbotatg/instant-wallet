"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Totals } from "@/lib/dash";
import { TimedBar } from "./bits";

const SESSION = "iw.dash";
const saved = () => {
  try {
    return localStorage.getItem(SESSION) || undefined;
  } catch {
    return undefined;
  }
};

/** The password screen. */
function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/dash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `error ${r.status}`);
      localStorage.setItem(SESSION, j.token);
      onDone();
    } catch (e: any) {
      setError(e?.message || "Couldn't log in. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app">
      <form className="welcome" onSubmit={go}>
        <h1>Dashboard</h1>
        <p className="fine">Totals over every Instant Wallet.</p>
        <div className="input">
          <input type="password" placeholder="Password" autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <button className="btn btn-green wide" disabled={busy || !password}>
          {busy ? "…" : "Log in"}
        </button>
        {error && <p className="err">{error}</p>}
      </form>
    </div>
  );
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 })}`;
const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const stat = (label: string, value: string | number) => (
  <div key={label} className="stack center" style={{ gap: 2, padding: "12px 8px", borderRadius: 14, background: "var(--chip, rgba(127,127,127,.12))" }}>
    <span className="fine">{label}</span>
    <b style={{ fontSize: 22 }}>{value}</b>
  </div>
);

/** One bar per day, the last 30. */
function Bars({ title, days }: { title: string; days: { date: string; n: number }[] }) {
  const max = Math.max(1, ...days.map(d => d.n));
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{title}</b>
        <span className="fine">30 days · most {max}</span>
      </div>
      <div className="row" style={{ gap: 2, alignItems: "flex-end", height: 80 }}>
        {days.map(d => (
          <div key={d.date} title={`${d.date}: ${d.n}`} style={{ flex: 1, height: `${Math.max(2, (d.n / max) * 100)}%`, borderRadius: 3, background: d.n ? "var(--green-fill)" : "rgba(127,127,127,.25)" }} />
        ))}
      </div>
    </div>
  );
}

/** The total over time, once there are two readings. */
function Line({ points }: { points: [number, number][] }) {
  if (points.length < 2) return null;
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${(((x - x0) / (x1 - x0 || 1)) * 300).toFixed(1)},${(76 - ((y - y0) / (y1 - y0 || 1)) * 72).toFixed(1)}`).join(" ");
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>Total over time</b>
        <span className="fine">{usd(y0)} to {usd(y1)}</span>
      </div>
      <svg viewBox="0 0 300 80" preserveAspectRatio="none" style={{ width: "100%", height: 80 }}>
        <path d={d} fill="none" stroke="#2bb14c" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const rows = (title: string, list: { name: string; usd: number; note?: string }[]) =>
  list.length > 0 && (
    <div className="card stack" style={{ gap: 8 }}>
      <b>{title}</b>
      {list.map(r => (
        <div key={r.name} className="row" style={{ justifyContent: "space-between" }}>
          <span>
            {r.name}
            {r.note && <span className="fine"> · {r.note}</span>}
          </span>
          <b>{usd(r.usd)}</b>
        </div>
      ))}
    </div>
  );

/** /dashboard: totals over every Instant Wallet. Behind a password; no addresses reach this page (lib/dash.ts). */
export function Dashboard() {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined);
  const [t, setT] = useState<Totals | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const again = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    clearTimeout(again.current);
    const token = saved();
    if (!token) return setAuthed(false);
    setAuthed(true);
    try {
      const r = await fetch("/api/dash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) {
        try {
          localStorage.removeItem(SESSION);
        } catch {}
        return setAuthed(false);
      }
      if (!r.ok) throw new Error(j.error || `error ${r.status}`);
      setError(null);
      if (j.totals) setT(j.totals);
      // a chain still being read from its start: the next run reads on
      const more = j.refreshing || j.totals?.behind?.length > 0;
      setRefreshing(!!more);
      again.current = setTimeout(load, more ? 20_000 : 5 * 60_000);
    } catch (e: any) {
      setError(e?.message || "Couldn't read the totals. Try again.");
      again.current = setTimeout(load, 30_000);
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearTimeout(again.current);
  }, [load]);

  if (authed === undefined) return null;
  if (!authed) return <Login onDone={load} />;

  return (
    <div className="app">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Dashboard</h1>
        {t && <span className="fine">{ago(t.at)}</span>}
      </div>
      {error && <p className="err">{error}</p>}
      {!t && !error && (
        <>
          <p className="fine center">Reading every chain…</p>
          <TimedBar ms={40_000} />
        </>
      )}
      {t && (
        <>
          <div className="card stack center" style={{ gap: 4 }}>
            <span className="fine">In all wallets</span>
            <b style={{ fontSize: "clamp(40px, 12vw, 56px)", lineHeight: 1.1 }}>{usd(t.totalUsd)}</b>
          </div>
          {refreshing && <TimedBar key={t.at} ms={20_000} />}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {stat("Wallets", t.wallets)}
            {stat("Holding $1+", t.funded)}
            {stat("New, 7 days", t.new7)}
            {stat("Active, 7 days", t.active7)}
            {stat("Active, 30 days", t.active30)}
            {stat("New, 30 days", t.new30)}
            {stat("Tx, 7 days", t.tx7)}
            {stat("Tx, 30 days", t.tx30)}
          </div>
          <Line points={t.usd} />
          <Bars title="Transactions a day" days={t.days.map(d => ({ date: d.date, n: d.tx }))} />
          <Bars title="New wallets a day" days={t.days.map(d => ({ date: d.date, n: d.new }))} />
          {rows("By chain", t.chains.map(c => ({ name: c.name, usd: c.usd, note: `${c.wallets} ${c.wallets === 1 ? "wallet" : "wallets"}${c.stale ? ", not read this time" : ""}` })))}
          {rows("By coin", t.coins.map(c => ({ name: c.symbol, usd: c.usd })))}
          {t.behind.length > 0 && <p className="fine">Still reading from the start: {t.behind.join(", ")}. The numbers grow until it&apos;s done.</p>}
          {t.unread.length > 0 && <p className="err">Couldn&apos;t read this time: {t.unread.join(", ")}.</p>}
          {t.noPrice.length > 0 && <p className="fine">No price, not counted: {t.noPrice.join(", ")}.</p>}
          <p className="fine">
            Read from the chains, nothing tracked in the app. A wallet counts once it has sent its first transaction. Money counts the coin and the
            well-known tokens on each chain; other tokens and lending or staking positions are left out.
          </p>
        </>
      )}
    </div>
  );
}
