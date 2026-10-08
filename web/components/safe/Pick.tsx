"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { CHAINS, chainById } from "@/lib/chains";
import { amount as fmtAmount, usd } from "@/lib/format";
import type { Signer, SignerOption } from "@/lib/safe/send";
import type { Asset } from "@/lib/types";
import { ChainIcon, TokenIcon } from "../bits";

/** A token you hold, as a select-box row: icon, symbol, and how much (in dollars too). */
export const assetOpt = (a: Asset): Opt => ({
  key: `${a.chainId}:${a.asset.toLowerCase()}`,
  icon: <TokenIcon symbol={a.symbol} asset={a.asset} chainId={a.chainId} logo={a.logo} size={28} />,
  label: a.symbol,
  right: (
    <>
      {fmtAmount(a.formatted)} {a.usd !== null && <span style={{ opacity: 0.75 }}>· {usd(a.usd)}</span>}
    </>
  ),
  search: `${a.symbol} ${a.name} ${chainById(a.chainId)?.name ?? ""}`,
});

/** A network as a select-box row: its logo and name. */
export const chainOpt = (id: number): Opt => ({
  key: String(id),
  icon: <ChainIcon chainId={id} size={24} />,
  label: chainById(id)?.name ?? String(id),
  search: `${chainById(id)?.name ?? ""} ${chainById(id)?.short ?? ""} ${chainById(id)?.native.symbol ?? ""}`,
});

/** Which network: a select box of every enabled one (type to filter once there are more than a handful). */
export function ChainSelect({ value, onChange, disabled }: { value: number; onChange: (chainId: number) => void; disabled?: boolean }) {
  return <Select value={chainOpt(value)} options={CHAINS.map(c => chainOpt(c.id))} onPick={k => onChange(Number(k))} filter={CHAINS.length > 5} disabled={disabled} />;
}

export type Opt = { key: string; icon?: ReactNode; label: ReactNode; right?: ReactNode; search?: string };

/**
 * A select box: closed, it shows the choice; open, you type in its place to filter and a short list floats over
 * the page below it (↑↓ + Enter, Escape or a tap outside closes). `custom`
 * adds a last row that turns into a paste box (a token's contract address); `onCustom` answers an error or null.
 * `search` also sends what's typed to the parent, which adds what it finds (a token search) to `options`.
 */
export function Select({
  value,
  options,
  onPick,
  placeholder = "Choose",
  filter = true,
  custom,
  search,
  disabled,
}: {
  value: Opt | null;
  options: Opt[];
  onPick: (key: string) => void;
  placeholder?: string;
  filter?: boolean;
  custom?: { label: string; placeholder: string; onCustom: (address: string) => Promise<string | null> };
  search?: { onQuery: (q: string) => void; busy: boolean; placeholder: string };
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const f = q.trim().toLowerCase();
  const shown = f ? options.filter(o => (o.search ?? "").toLowerCase().includes(f)) : options;
  const close = () => {
    search?.onQuery("");
    setOpen(false);
    setPasting(false);
    setErr(null);
  };
  const pick = (k: string) => {
    onPick(k);
    close();
  };
  const [hi, setHi] = useState(0);
  useEffect(() => setHi(0), [f]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && close();
    document.addEventListener("pointerdown", out);
    return () => document.removeEventListener("pointerdown", out);
  }, [open]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // the select closes, not the sheet
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi(i => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && shown[hi]) pick(shown[hi].key);
  };

  if (!open)
    return (
      <button
        className="pill select"
        disabled={disabled}
        onClick={() => {
          setQ("");
          setOpen(true);
        }}
      >
        <span className="row">
          {value?.icon}
          {value ? <b>{value.label}</b> : <span className="fine">{placeholder}</span>}
        </span>
        <span className="fine row" style={{ gap: 6 }}>
          {value?.right} ▾
        </span>
      </button>
    );

  return (
    <div ref={box} className="stack" style={{ gap: 6, position: "relative" }}>
      {pasting ? (
        <div className="input" style={{ minHeight: 50 }}>
          <input
            key="paste"
            autoFocus
            value={pasted}
            placeholder={custom?.placeholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ fontSize: 15, padding: "10px 0" }}
            onChange={async e => {
              const v = e.target.value.trim();
              setPasted(v);
              setErr(null);
              if (!isAddress(v) || !custom) return;
              const bad = await custom.onCustom(v);
              if (bad) setErr(bad);
              else close();
            }}
          />
          <button className="pill" aria-label="Close" onClick={close}>
            ▴
          </button>
        </div>
      ) : filter ? (
        <div className="input" style={{ minHeight: 50 }}>
          <input key="filter" autoFocus value={q} onChange={e => (setQ(e.target.value), search?.onQuery(e.target.value.trim()))} onKeyDown={keys} placeholder={search?.placeholder ?? "Type to filter"} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ fontSize: 16, padding: "10px 0" }} />
          <button className="pill" aria-label="Close" onClick={close}>
            ▴
          </button>
        </div>
      ) : null}
      {err && <span className="err">{err}</span>}
      {!pasting && (
        <div className="picker drop" style={filter ? undefined : { top: 0 }}>
          {shown.length === 0 && !search?.busy && <p className="fine center">Nothing matches “{q}”</p>}
          {shown.map((o, i) => (
            <button
              key={o.key}
              className={`pill ${o.key === value?.key ? "on" : ""}`}
              style={{ justifyContent: "space-between", height: 46, outline: i === hi && f ? "2px solid var(--ink)" : undefined }}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o.key)}
            >
              <span className="row">
                {o.icon} <b>{o.label}</b>
              </span>
              <span>{o.right}</span>
            </button>
          ))}
          {search?.busy && f && <p className="fine center">Searching…</p>}
          {custom && (
            <button
              className="pill"
              style={{ height: 46 }}
              onClick={() => {
                setPasted("");
                setPasting(true);
              }}
            >
              <b>{custom.label}</b>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const KEY_NAME: Record<Signer, string> = { burner: "Instant", hot: "Hot wallet", wedgie: "Wedgie" };
export const signedByLabel = (s: Signer[]) => s.map(k => KEY_NAME[k]).join(" + ");

/** Which keys sign, when there's more than one way: "Instant + Wedgie 3/3", "Hot wallet + Wedgie 3/3", … */
export function SignerChoice({ options, value, onChange, disabled }: { options: SignerOption[]; value: Signer[]; onChange: (s: Signer[]) => void; disabled?: boolean }) {
  const same = (a: Signer[], b: Signer[]) => a.length === b.length && a.every(k => b.includes(k));
  const later = options.find(o => same(o.signers, value))?.later;
  if (options.length < 2)
    return (
      <span className="stack" style={{ gap: 2, justifyItems: "end" }}>
        <span>{signedByLabel(value)}</span>
        {later && <span className="fine">{later}</span>}
      </span>
    );
  const off = options.filter(o => !o.ready);
  return (
    <span className="stack signers" style={{ gap: 6, justifyItems: "end" }}>
      <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {options.map(o => (
          <button
            key={o.signers.join("+")}
            className={`pill ${same(o.signers, value) ? "on" : ""}`}
            disabled={disabled || !o.ready}
            onClick={() => onChange(o.signers)}
          >
            {signedByLabel(o.signers)} <span className="fine">{o.signers.length}/{o.of}</span>
          </button>
        ))}
      </span>
      {later && <span className="fine">{later}</span>}
      {off.map(o => (
        <span key={o.signers.join("+")} className="fine">
          {signedByLabel(o.signers)}: {o.why}
        </span>
      ))}
    </span>
  );
}
