"use client";

import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./AppShell";
import { type ConfirmRow, ConfirmSheet, canSign } from "./ConfirmSheet";
import { ChipIcon, FaceIdIcon, ScanIcon, TouchIdIcon } from "./Icons";
import { useWallet } from "./WalletProvider";
import { type Address, isAddress } from "viem";
import { useBiometric } from "~~/hooks/useBiometric";
import { api } from "~~/utils/api";
import { chainLabel } from "~~/utils/chain";
import { moneyParts, shortAddr, toUnits, usd } from "~~/utils/format";
import type { MetaAction } from "~~/utils/meta";

const QUICK = ["20", "45", "100"];

/** 0.02 USDC — the same default as the server's facilitatorFee(). */
export function defaultFee(decimals: number): bigint {
  return 2n * 10n ** BigInt(Math.max(0, decimals - 2));
}

/**
 * The send form. `variant="page"` is the phone layout with the keypad; `variant="panel"` is the
 * desktop right-column card with a plain input. Both end in the same ConfirmSheet.
 */
export function SendPanel({
  variant = "page",
  initialTo = "",
  initialAmount = "",
  onSent,
}: {
  variant?: "page" | "panel";
  initialTo?: string;
  initialAmount?: string;
  onSent?: () => void;
}) {
  const { snapshot, passkey, refresh } = useWallet();
  const decimals = snapshot?.token.decimals ?? 6;
  const symbol = snapshot?.token.symbol ?? "USDC";
  const balance = BigInt(snapshot?.balance ?? 0);
  const fee = defaultFee(decimals);
  const bio = useBiometric();

  const [amount, setAmount] = useState(initialAmount);
  const [to, setTo] = useState(initialTo);
  const [resolved, setResolved] = useState<{ address: Address; name?: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [confirm, setConfirm] = useState<{
    action: MetaAction;
    rows: ConfirmRow[];
    title: string;
    preferred?: "device";
  } | null>(null);
  const [scan, setScan] = useState(false);

  // resolve recipient (address or ENS)
  useEffect(() => {
    const v = to.trim();
    if (!v) return setResolved(null);
    if (isAddress(v)) return setResolved({ address: v as Address });
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) {
      setResolving(true);
      const t = setTimeout(async () => {
        try {
          const r = await api.ens(v);
          setResolved(r.address ? { address: r.address, name: v } : null);
        } catch {
          setResolved(null);
        } finally {
          setResolving(false);
        }
      }, 400);
      return () => clearTimeout(t);
    }
    setResolved(null);
  }, [to]);

  const units = toUnits(amount || "0", decimals) ?? 0n;
  const total = units + fee;
  const enough = units > 0n && total <= balance;
  const passkeySigner = snapshot?.signers.find(
    s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase(),
  );
  const action: MetaAction | null = useMemo(
    () =>
      resolved && snapshot
        ? {
            fn: "metaTransfer",
            token: snapshot.token.address,
            to: resolved.address,
            amount: units,
            fee,
            toName: resolved.name,
          }
        : null,
    [resolved, snapshot, units, fee],
  );
  const passkeyOk = !!action && !!passkey && canSign(passkeySigner, action, snapshot?.token.address);
  const deviceOk =
    !!action && (snapshot?.signers ?? []).some(s => s.kind === 1 && canSign(s, action, snapshot?.token.address));
  const limit = passkeySigner && passkeySigner.role !== 1 ? usd(passkeySigner.dailyLimit, decimals) : null;

  let hint: { tone: "mint" | "amber" | "coral"; text: string } | null = null;
  if (units > 0n && !enough)
    hint = {
      tone: "coral",
      text: `Not enough ${symbol}. Balance ${usd(balance, decimals)}, fee ${usd(fee, decimals)}.`,
    };
  else if (units > 0n && passkeyOk)
    hint = { tone: "mint", text: limit ? `Under your ${limit} daily limit · ${bio} is enough` : `${bio} is enough` };
  else if (units > 0n && !passkeyOk && deviceOk)
    hint = {
      tone: "amber",
      text: limit
        ? `Over your ${limit} ${bio} limit · the green button on your device signs this`
        : "Your device signs this",
    };
  else if (units > 0n && !passkeyOk && !deviceOk && snapshot)
    hint = {
      tone: "coral",
      text: limit ? `Over your ${limit} ${bio} limit and no device is paired` : "No key can sign this",
    };

  const ready = !!action && enough && (passkeyOk || deviceOk);
  const label = passkeyOk ? `Send with ${bio}` : "Confirm on device";

  const open = (preferred?: "device") => {
    if (!action || !resolved) return;
    const name = resolved.name ?? shortAddr(resolved.address);
    setConfirm({
      action,
      title: `Send ${usd(units, decimals)} to ${name}`,
      rows: [
        { label: "Amount", value: usd(units, decimals), mono: true },
        { label: "To", value: name },
        { label: "Fee", value: usd(fee, decimals), mono: true },
      ],
      preferred,
    });
  };

  const press = (k: string) => {
    setAmount(a => {
      if (k === "⌫") return a.slice(0, -1);
      if (k === ".") return a.includes(".") ? a : (a || "0") + ".";
      const next = a === "0" ? k : a + k;
      const [, f] = next.split(".");
      if (f && f.length > 2) return a;
      if (next.replace(".", "").length > 10) return a;
      return next;
    });
  };
  const setMax = () => setAmount(balance > fee ? (Number(balance - fee) / 10 ** decimals).toFixed(2) : "0");
  const [, frac] = moneyParts(units, decimals);

  const amountBlock =
    variant === "page" ? (
      <div className="rounded-[24px] bg-ink-2 text-white p-5">
        <div className="text-[13px] text-[#a3a6a3]">Amount</div>
        <div className="mono font-bold text-[2.8rem] leading-none mt-1">
          ${amount ? amount.split(".")[0] || "0" : "0"}
          <span className="text-[1.5rem] text-[#a3a6a3]">
            .{amount.includes(".") ? (amount.split(".")[1] + "00").slice(0, 2) : frac}
          </span>
        </div>
        <div className="text-[13px] text-[#a3a6a3] mt-2">
          {symbol} on {chainLabel} · fee {usd(fee, decimals)}
        </div>
      </div>
    ) : (
      <label className="block rounded-2xl bg-paper border border-line px-4 py-3 focus-within:border-ink">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-1 mono font-bold text-[1.9rem]">
            <span>$</span>
            <input
              value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0"
              inputMode="decimal"
              className="bg-transparent outline-none w-full min-w-0"
            />
          </div>
          <div className="text-muted text-sm whitespace-nowrap">
            {symbol} · fee {usd(fee, decimals)}
          </div>
        </div>
      </label>
    );

  return (
    <div className={variant === "panel" ? "card p-5" : "px-5"}>
      {variant === "panel" && <h3 className="font-bold text-[1.05rem] mb-4">Send</h3>}
      {variant === "panel" && <div className="text-muted text-sm mb-1.5">To</div>}
      {variant === "page" && amountBlock}
      <div
        className={`${variant === "page" ? "mt-3 card" : "rounded-2xl bg-paper border border-line focus-within:border-ink"} flex items-center gap-3 px-4 py-3`}
      >
        <Avatar seed={resolved?.address ?? "0x000000"} size={36} />
        <div className="min-w-0 flex-1">
          <input
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="Address or ENS name"
            spellCheck={false}
            autoCapitalize="none"
            className="w-full bg-transparent outline-none font-semibold"
          />
          <div className="mono text-xs text-muted truncate">
            {resolving
              ? "resolving…"
              : resolved
                ? resolved.name
                  ? shortAddr(resolved.address, 8, 6)
                  : "address"
                : to
                  ? "not found"
                  : "0x… or name.eth"}
          </div>
        </div>
        {variant === "page" && (
          <button className="text-ink" onClick={() => setScan(true)} aria-label="Scan QR">
            <ScanIcon size={22} />
          </button>
        )}
      </div>
      {variant === "panel" && <div className="text-muted text-sm mt-4 mb-1.5">Amount</div>}
      {variant === "panel" && amountBlock}

      <div className="mt-3 grid grid-cols-4 gap-2">
        {QUICK.map(q => (
          <button
            key={q}
            className={`h-11 rounded-full font-semibold text-sm ${amount === q ? "bg-ink text-white" : "bg-white shadow-soft"}`}
            onClick={() => setAmount(q)}
          >
            ${q}
          </button>
        ))}
        <button className="h-11 rounded-full font-semibold text-sm bg-white shadow-soft" onClick={setMax}>
          Max
        </button>
      </div>

      {variant === "page" && (
        <div className="mt-3 grid grid-cols-3 gap-2 lg:hidden">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map(k => (
            <button key={k} className="keypad-key" onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>
      )}
      {variant === "page" && (
        <div className="hidden lg:block mt-3">
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="Amount"
            inputMode="decimal"
            className="input mono"
          />
        </div>
      )}

      {hint && (
        <div
          className={`mt-3 rounded-2xl px-4 py-2.5 text-sm font-semibold flex items-center gap-2 ${
            hint.tone === "mint"
              ? "bg-mint-soft text-mint-dark"
              : hint.tone === "amber"
                ? "bg-amber-soft text-amber-ink border border-amber-line"
                : "bg-coral-soft text-coral"
          }`}
        >
          {hint.tone === "mint" ? (
            bio === "Touch ID" ? (
              <TouchIdIcon size={16} />
            ) : (
              <FaceIdIcon size={16} />
            )
          ) : (
            <ChipIcon size={16} />
          )}
          {hint.text}
        </div>
      )}

      <button
        className={`btn w-full mt-3 ${passkeyOk ? "btn-primary" : "btn-primary"}`}
        disabled={!ready}
        onClick={() => open()}
      >
        {passkeyOk ? bio === "Touch ID" ? <TouchIdIcon size={20} /> : <FaceIdIcon size={20} /> : <ChipIcon size={20} />}
        {label}
      </button>
      {passkeyOk && deviceOk && (
        <button className="w-full mt-2 text-sm font-semibold text-muted py-2" onClick={() => open("device")}>
          Sign on the device instead
        </button>
      )}

      {confirm && (
        <ConfirmSheet
          action={confirm.action}
          title={confirm.title}
          rows={confirm.rows}
          preferred={confirm.preferred}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            setAmount("");
            setTo("");
            void refresh();
            onSent?.();
          }}
        />
      )}
      {scan && (
        <ScanSheet
          onClose={() => setScan(false)}
          onResult={text => {
            const m = text.match(/0x[0-9a-fA-F]{40}/);
            if (m) setTo(m[0]);
            else if (/\.[a-z]{2,}$/i.test(text.trim())) setTo(text.trim());
            setScan(false);
          }}
        />
      )}
    </div>
  );
}

function ScanSheet({ onClose, onResult }: { onClose: () => void; onResult: (text: string) => void }) {
  // lazy so the html5-qrcode bundle only loads when the scanner opens
  const [Scanner, setScanner] = useState<null | React.ComponentType<{ onResult: (t: string) => void }>>(null);
  useEffect(() => {
    import("./QrScanner").then(m => setScanner(() => m.QrScanner));
  }, []);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet">
        <h3 className="font-bold text-lg mb-3">Scan an address</h3>
        {Scanner ? <Scanner onResult={onResult} /> : <div className="text-muted text-sm">Loading camera…</div>}
        <button className="btn btn-white w-full mt-4" onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  );
}
