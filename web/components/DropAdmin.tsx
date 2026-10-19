"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address, formatUnits, toHex } from "viem";
import { chainById, explorerTx } from "@/lib/chains";
import { cardsPdf } from "@/lib/claimBatch";
import { type DropInfo, dropAmount, dropSig, dropUrl } from "@/lib/dropClient";
import { short } from "@/lib/format";
import { type SafeAccount, loadAccount } from "@/lib/safe/state";
import { Qr, TimedBar, copy, useToast } from "./bits";
import { friendly } from "./Welcome";

type Drop = {
  id: string;
  name: string;
  chainId: number;
  token: "usdc" | "eth";
  amount: string;
  usd?: boolean;
  kind: "cards" | "crowd";
  cap: number;
  code?: string;
  closesAt?: number;
  paused?: boolean;
  ended?: boolean;
  createdAt: number;
  claimed?: number;
};
type Detail = {
  drop: Drop;
  claimed: number;
  pot: { address: Address; usdc: string; eth: string; feeUsdc: string; gasEth: string; ethUsd: number; each: string };
  codes: { code: string; used: boolean }[];
  claims: { code: string; wallet: Address; tx: string; at: number }[];
};

const SESSION = "iw.dropAdmin";
const dec = (t: Drop["token"]) => (t === "usdc" ? 6 : 18);
const amt = (d: Drop) => dropAmount({ ...d, decimals: d.usd ? 6 : dec(d.token) });
/** "$5" for a USDC drop or a dollar-priced ETH drop. */
const dollars = (d: Drop) => (d.token === "usdc" || d.usd ? `$${formatUnits(BigInt(d.amount), 6)}` : amt(d));

async function api(op: string, body: object = {}) {
  let token: string | undefined;
  try {
    token = JSON.parse(localStorage.getItem(SESSION) || "null")?.token;
  } catch {}
  const r = await fetch("/api/drop/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    try {
      localStorage.removeItem(SESSION);
    } catch {}
  }
  if (!r.ok) throw Object.assign(new Error(j.error || `error ${r.status}`), { status: r.status });
  return j;
}

function status(d: Drop, claimed: number) {
  if (d.ended) return "ended";
  if (d.paused) return "paused";
  if (d.closesAt && Date.now() > d.closesAt) return "closed";
  if (claimed >= d.cap) return d.kind === "cards" ? "all claimed" : "full";
  return "live";
}

/** /drops: make drops, fill their pots, print cards or show a crowd QR, take back what's left (lib/drops.ts). */
export function DropAdmin() {
  const [account, setAccount] = useState<SafeAccount | null | undefined>(undefined);
  const [authed, setAuthed] = useState(false);
  const [drops, setDrops] = useState<Drop[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useToast();

  const load = useCallback(async () => {
    try {
      const j = await api("list");
      setDrops(j.drops);
      setAuthed(true);
    } catch (e: any) {
      if (e.status === 401) setAuthed(false);
      else setError(friendly(e));
    }
  }, []);

  useEffect(() => {
    setAccount(loadAccount());
    try {
      if (localStorage.getItem(SESSION)) load();
    } catch {}
  }, [load]);

  async function login() {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const sig = await dropSig(account, "login");
      const j = await api("login", { wallet: account.address, sig });
      localStorage.setItem(SESSION, JSON.stringify({ token: j.token, wallet: j.wallet }));
      await load();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  async function walletLogin() {
    const eth = (window as any).ethereum;
    if (!eth) return setError("No wallet in this browser. Open this page in your wallet's browser, or on a computer with MetaMask or Rabby.");
    setBusy(true);
    setError(null);
    try {
      const [wallet] = await eth.request({ method: "eth_requestAccounts" });
      const { message } = await api("challenge");
      const signature = await eth.request({ method: "personal_sign", params: [toHex(message), wallet] });
      const j = await api("login", { wallet, message, signature });
      localStorage.setItem(SESSION, JSON.stringify({ token: j.token, wallet: j.wallet }));
      await load();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  if (account === undefined) return null;

  if (!authed)
    return (
      <div className="app">
        <div className="welcome">
          <h1>Drops</h1>
          <p className="fine">A pot of money and codes for it: cards to print, or one QR for a crowd. Each code pays into a new Instant Wallet.</p>
          {account ? (
            <button className="btn btn-green wide" onClick={login} disabled={busy}>
              {busy ? "…" : "Log in with Face ID"}
            </button>
          ) : (
            <>
              <p>Make your Instant Wallet first, on this device.</p>
              <a className="btn btn-green wide" href="/">Open Instant Wallet</a>
            </>
          )}
          <button className="btn wide" onClick={walletLogin} disabled={busy}>
            Log in with a wallet
          </button>
          {error && <p className="err">{error}</p>}
        </div>
      </div>
    );

  return (
    <div className="app">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Drops</h1>
        <button className={`btn ${making ? "" : "btn-green"}`} onClick={() => setMaking(!making)}>
          {making ? "Cancel" : "New drop"}
        </button>
      </div>
      {making && (
        <NewDrop
          onMade={d => {
            setMaking(false);
            setOpen(d.id);
            load();
          }}
        />
      )}
      {error && <p className="err">{error}</p>}
      {drops === null && <p className="fine center">…</p>}
      {drops?.length === 0 && !making && <p className="fine center">No drops yet. Tap New drop.</p>}
      {drops?.map(d =>
        open === d.id ? (
          <DropCard key={d.id} id={d.id} toast={setToast} onClose={() => (setOpen(null), load())} />
        ) : (
          <button key={d.id} className="card row" style={{ justifyContent: "space-between", gap: 8, textAlign: "left", border: 0, cursor: "pointer", font: "inherit", color: "inherit" }} onClick={() => setOpen(d.id)}>
            <span className="stack" style={{ gap: 2 }}>
              <b>{d.name}</b>
              <span className="fine">
                {d.kind === "cards" ? `${d.cap} cards` : `crowd · ${d.code}`} × {amt(d)} · {chainById(d.chainId)?.name}
              </span>
            </span>
            <span className="fine" style={{ textAlign: "right" }}>
              {d.claimed}/{d.cap}
              <br />
              {status(d, d.claimed ?? 0)}
            </span>
          </button>
        ),
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function NewDrop({ onMade }: { onMade: (d: Drop) => void }) {
  const [kind, setKind] = useState<Drop["kind"]>("crowd");
  const [name, setName] = useState("");
  const [chainId, setChainId] = useState(8453);
  const [token, setToken] = useState<Drop["token"]>("usdc");
  const [amount, setAmount] = useState("5");
  const [count, setCount] = useState("40");
  const [code, setCode] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const j = await api("create", { drop: { name, chainId, token, amount, kind, count: Number(count), code: kind === "crowd" ? code : undefined, minutes: kind === "crowd" ? Number(minutes) || 0 : 0 } });
      onMade(j.drop);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, el: React.ReactNode) => (
    <label className="stack" style={{ gap: 4 }}>
      <span className="fine">{label}</span>
      {el}
    </label>
  );
  const seg = <T extends string | number>(v: T, set: (x: T) => void, opts: [T, string][]) => (
    <div className="row" style={{ gap: 8 }}>
      {opts.map(([o, l]) => (
        <button key={String(o)} className={`pill ${v === o ? "on" : ""}`} onClick={() => set(o)}>
          {l}
        </button>
      ))}
    </div>
  );

  return (
    <div className="card stack">
      {seg(kind, setKind, [
        ["crowd", "Crowd code"],
        ["cards", "Cards"],
      ])}
      {field("Name (only you see it)", <div className="input"><input value={name} placeholder={kind === "crowd" ? "ETHDenver talk" : "Business cards"} onChange={e => setName(e.target.value)} /></div>)}
      {seg(chainId, setChainId, [
        [8453, "Base"],
        [1, "Ethereum"],
      ])}
      {seg(token, setToken, [
        ["usdc", "USDC"],
        ["eth", "ETH"],
      ])}
      {field(`Dollars per claim${token === "eth" ? " (paid in ETH at the price then)" : ""}`, <div className="input"><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(",", "."))} /></div>)}
      {field(kind === "cards" ? "How many cards" : "Most claims (the cap)", <div className="input"><input inputMode="numeric" value={count} onChange={e => setCount(e.target.value.replace(/\D/g, ""))} /></div>)}
      {kind === "crowd" && (
        <>
          {field("Code (blank = random). People can type it too.", <div className="input"><input value={code} placeholder="GWEI" autoCapitalize="characters" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))} /></div>)}
          {field("Open for (minutes, blank = until you end it)", <div className="input"><input inputMode="numeric" value={minutes} onChange={e => setMinutes(e.target.value.replace(/\D/g, ""))} /></div>)}
        </>
      )}
      <p className="fine">
        You&apos;ll fill it with about ${Number(amount) * Number(count) || 0}{token === "eth" ? " of ETH" : " USDC"} plus fees{chainId === 1 ? " (Ethereum fees are higher)" : ""}.
      </p>
      <button className="btn btn-green wide" onClick={make} disabled={busy}>
        {busy ? "…" : "Make it"}
      </button>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

function DropCard({ id, toast, onClose }: { id: string; toast: (m: string) => void; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api("get", { id }).then(setD).catch(e => setError(friendly(e))), [id]);
  useEffect(() => {
    load();
    const t = setInterval(() => document.hidden || load(), 8_000); // shows the money arriving and the claims
    return () => clearInterval(t);
  }, [load]);

  if (!d) return <div className="card fine center">{error ?? "…"}</div>;
  const { drop } = d;
  const each = BigInt(d.pot.each); // per claim, in the token (ETH: at today's price)
  const per = drop.token === "usdc" ? each + BigInt(d.pot.feeUsdc) : each + BigInt(d.pot.gasEth);
  const have = drop.token === "usdc" ? BigInt(d.pot.usdc) : BigInt(d.pot.eth);
  const left = drop.cap - d.claimed;
  const enough = per > 0n && each > 0n ? Number(have / per) : 0;
  const need = BigInt(Math.max(0, left - enough)) * per;
  const net = chainById(drop.chainId)?.name;
  const origin = window.location.origin;
  const st = status(drop, d.claimed);

  async function act(what: string, op: string, body: object = {}) {
    setBusy(what);
    setError(null);
    try {
      const j = await api(op, { id, ...body });
      if (op === "takeback") toast("Sent to your wallet");
      await load();
      return j;
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function pdf() {
    const unused = d!.codes.filter(c => !c.used);
    if (!unused.length) return toast("Every card is claimed");
    await cardsPdf(unused.map(c => ({ url: dropUrl(origin, c.code), amount: dollars(drop) })));
  }

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <b>{drop.name}</b>
        <button className="pill" onClick={onClose}>Close</button>
      </div>
      <p className="fine">
        {drop.kind === "cards" ? `${drop.cap} cards` : `Crowd code ${drop.code}, cap ${drop.cap}`} × {amt(drop)} on {net} · <b>{st}</b> · {d.claimed} claimed
        {drop.closesAt && !drop.ended ? ` · ${Date.now() < drop.closesAt ? "closes" : "closed"} ${new Date(drop.closesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
      </p>

      <b>The pot</b>
      <p className="fine">
        Has {formatUnits(BigInt(d.pot.usdc), 6)} USDC + {Number(formatUnits(BigInt(d.pot.eth), 18)).toFixed(5)} ETH on {net}. Enough for {Math.min(enough, left)} of the {left} claims left
        {need > 0n ? `. Send ${drop.token === "eth" ? `${Number(formatUnits(need, 18)).toFixed(5)} ETH (~$${(Number(formatUnits(need, 18)) * d.pot.ethUsd).toFixed(2)})` : `${formatUnits(need, 6)} USDC`} more on ${net} to cover them all.` : "."}
        {drop.token === "eth" && d.pot.ethUsd ? ` ETH is $${d.pot.ethUsd.toFixed(0)} now (Uniswap); each claim gets ${dollars(drop)} of ETH at the price when they claim.` : ""}
        {drop.token === "usdc" ? ` Each claim costs the pot ${formatUnits(BigInt(d.pot.feeUsdc), 6)} USDC in fees today.` : ""}
      </p>
      <div onClick={async () => (await copy(d.pot.address)) && toast("Address copied")} style={{ cursor: "pointer", maxWidth: 220, margin: "0 auto", width: "100%" }}>
        <Qr value={d.pot.address} center={d.pot.address} />
      </div>
      <button className="pill" style={{ alignSelf: "center" }} onClick={async () => (await copy(d.pot.address)) && toast("Address copied")}>
        <span className="mono">{short(d.pot.address)}</span> Copy
      </button>

      {drop.kind === "crowd" && drop.code && (
        <>
          <b>The code</b>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-green" onClick={() => setPresent(true)}>Present</button>
            <button className="pill" onClick={async () => (await copy(dropUrl(origin, drop.code!))) && toast("Link copied")}>Copy link</button>
            <button className="pill" onClick={() => act("time", "set", { minutes: 30 })} disabled={!!busy}>Open 30 min from now</button>
            <button className="pill" onClick={() => act("time", "set", { minutes: 0 })} disabled={!!busy}>No time limit</button>
          </div>
        </>
      )}

      {drop.kind === "cards" && (
        <>
          <b>The cards</b>
          <p className="fine">The PDF has every unclaimed card, 10 to a page (Avery 8371 business-card sheets, or plain paper and scissors). The links file is for a print shop.</p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-green" onClick={pdf}>Download PDF</button>
            <button
              className="pill"
              onClick={() => {
                const csv = "code,link,claimed\n" + d.codes.map(c => `${c.code},${dropUrl(origin, c.code)},${c.used ? "yes" : "no"}`).join("\n");
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                a.download = `${drop.name.replace(/[^\w-]+/g, "-")}-codes.csv`;
                a.click();
              }}
            >
              Links file (CSV)
            </button>
          </div>
          <details>
            <summary className="fine">Codes</summary>
            {d.codes.map(c => (
              <div key={c.code} className="row mono fine" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <span>{c.code}</span>
                <span>{c.used ? "claimed" : "ready"}</span>
              </div>
            ))}
          </details>
        </>
      )}

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {!drop.ended && (
          <button className="pill" onClick={() => act("pause", "set", { paused: !drop.paused })} disabled={!!busy}>
            {drop.paused ? "Resume" : "Pause"}
          </button>
        )}
        {!drop.ended && (
          <button className="pill" onClick={() => confirm("End this drop? Every code stops working. You can still take back what's left.") && act("end", "set", { ended: true })} disabled={!!busy}>
            End
          </button>
        )}
        <button className="pill" onClick={() => confirm(`Send everything left in the pot to your wallet?${st === "live" ? " The drop is still live: claims after this will find it empty." : ""}`) && act("takeback", "takeback")} disabled={!!busy}>
          {busy === "takeback" ? "Sending…" : "Take back"}
        </button>
      </div>
      {busy === "takeback" && <TimedBar ms={drop.chainId === 1 ? 30_000 : 8_000} />}
      {error && <p className="err">{error}</p>}

      {d.claims.length > 0 && (
        <details>
          <summary className="fine">{d.claims.length} claims</summary>
          {[...d.claims].reverse().map(c => (
            <div key={c.tx} className="row fine" style={{ justifyContent: "space-between", padding: "4px 0", gap: 8 }}>
              <span className="mono">{short(c.wallet)}</span>
              <span>{new Date(c.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <a href={explorerTx(drop.chainId, c.tx)} target="_blank" rel="noreferrer">tx</a>
            </div>
          ))}
        </details>
      )}

      {present && drop.code && <Present drop={drop} onClose={() => setPresent(false)} />}
    </div>
  );
}

/** Full screen for a slide: the QR, the code to type, and the count going up. */
function Present({ drop, onClose }: { drop: Drop; onClose: () => void }) {
  const [info, setInfo] = useState<DropInfo | null>(null);
  useEffect(() => {
    const get = () => fetch(`/api/drop?code=${drop.code}`).then(r => r.json()).then(setInfo).catch(() => {});
    get();
    const t = setInterval(get, 3_000);
    return () => clearInterval(t);
  }, [drop.code]);
  const host = window.location.host.replace(/^www\./, "");
  const shown = dollars(drop);
  return (
    <div className="present" onClick={onClose}>
      <div className="present-in">
        <div className="present-title">Scan for {shown}</div>
        <div className="present-qr">
          <Qr value={dropUrl(window.location.origin, drop.code!)} />
        </div>
        <div className="present-code">
          or go to <b>{host}/d</b> and type <b className="mono">{drop.code}</b>
        </div>
        <div className="present-count">{info ? (info.closed ? info.closed : `${info.claimed} of ${info.cap} claimed`) : "…"}</div>
      </div>
    </div>
  );
}
