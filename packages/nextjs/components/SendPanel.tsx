"use client";

import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./AppShell";
import { type ConfirmRow, ConfirmSheet, canSign, limitFor } from "./ConfirmSheet";
import { ChipIcon, FaceIdIcon, ScanIcon, TouchIdIcon } from "./Icons";
import { useWallet } from "./WalletProvider";
import { type Address, isAddress } from "viem";
import { useBiometric } from "~~/hooks/useBiometric";
import type { PortfolioAsset } from "~~/services/portfolio";
import { api } from "~~/utils/api";
import { DEFAULT_STABLE, ETH_META, chainLabel } from "~~/utils/chain";
import { ETH_ASSET } from "~~/utils/digests";
import { fmtAmount, fmtUsd, shortAddr, toUnits, usdValue } from "~~/utils/format";
import { type MetaAction, feeFor } from "~~/utils/meta";

const QUICK_STABLE = ["20", "45", "100"];
const QUICK_ETH = ["0.01", "0.05", "0.1"];

const isStable = (a: PortfolioAsset) => a.price === 1 || /^(USDC|USDT|DAI|USDBC|USDS)$/i.test(a.symbol);

/** A zero-balance row for an asset the wallet does not hold yet (ETH always shows). */
function emptyRow(m: { address: Address; symbol: string; decimals: number; name: string }): PortfolioAsset {
  return {
    asset: m.address,
    symbol: m.symbol,
    name: m.name,
    decimals: m.decimals,
    balance: "0",
    balanceFormatted: "0",
    price: m.symbol === "USDC" ? 1 : null,
    usd: null,
  };
}

/**
 * The send form: pick an asset the wallet holds, type an amount in that asset, pick a recipient
 * (address or ENS). `variant="page"` is the phone layout with the keypad; `variant="panel"` is the
 * desktop right-column card with a plain input. Both end in the same ConfirmSheet.
 */
export function SendPanel({
  variant = "page",
  initialTo = "",
  initialAmount = "",
  initialAsset,
  onSent,
}: {
  variant?: "page" | "panel";
  initialTo?: string;
  initialAmount?: string;
  initialAsset?: string;
  onSent?: () => void;
}) {
  const { snapshot, passkey, refresh } = useWallet();
  const bio = useBiometric();

  // ETH first, then held tokens; a zero row for the chain's stablecoin so the picker never feels empty.
  const assets = useMemo<PortfolioAsset[]>(() => {
    const held = snapshot?.portfolio.assets ?? [];
    const out = [...held];
    if (!out.some(a => a.asset === ETH_ASSET)) out.unshift(emptyRow(ETH_META));
    const stable = DEFAULT_STABLE;
    if (stable && !out.some(a => a.asset.toLowerCase() === stable.address.toLowerCase())) out.push(emptyRow(stable));
    return out;
  }, [snapshot]);

  const [assetAddr, setAssetAddr] = useState<string | null>(initialAsset ?? null);
  const asset = useMemo(() => {
    const pick = assetAddr && assets.find(a => a.asset.toLowerCase() === assetAddr.toLowerCase());
    if (pick) return pick;
    // default: the stablecoin if held, else the most valuable holding, else ETH
    return (
      assets.find(a => isStable(a) && BigInt(a.balance) > 0n) ?? assets.find(a => BigInt(a.balance) > 0n) ?? assets[0]
    );
  }, [assets, assetAddr]);
  const decimals = asset?.decimals ?? 18;
  const symbol = asset?.symbol ?? "ETH";
  const balance = BigInt(asset?.balance ?? 0);

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
  const fee = asset ? feeFor(snapshot?.fee, asset.asset, units, DEFAULT_STABLE?.address) : 0n;
  const total = units + fee;
  const enough = units > 0n && total <= balance;
  const passkeySigner = snapshot?.signers.find(
    s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase(),
  );
  const action: MetaAction | null = useMemo(
    () =>
      resolved && asset
        ? {
            fn: "metaTransfer",
            asset: asset.asset,
            to: resolved.address,
            amount: units,
            fee,
            toName: resolved.name,
            assetSymbol: asset.symbol,
            assetDecimals: asset.decimals,
          }
        : null,
    [resolved, asset, units, fee],
  );
  const passkeyOk = !!action && !!passkey && canSign(passkeySigner, action);
  const deviceOk = !!action && (snapshot?.signers ?? []).some(s => s.kind === 1 && canSign(s, action));
  const myLimit = action ? limitFor(passkeySigner, action) : undefined;
  const isSpender = !!passkeySigner && passkeySigner.role !== 1;
  const amt = (u: bigint) => fmtAmount(u, decimals, symbol);
  const usdOf = (u: bigint) => usdValue(u, decimals, asset?.price ?? null);

  let hint: { tone: "mint" | "amber" | "coral"; text: string } | null = null;
  if (units > 0n && !enough)
    hint = {
      tone: "coral",
      text: `Not enough ${symbol}. Balance ${amt(balance)}${fee > 0n ? `, fee ${amt(fee)}` : ""}.`,
    };
  else if (units > 0n && passkeyOk)
    hint = {
      tone: "mint",
      text: myLimit
        ? `${amt(BigInt(myLimit.remaining))} of ${symbol} left today · ${bio} is enough`
        : `${bio} is enough`,
    };
  else if (units > 0n && !passkeyOk && deviceOk)
    hint = {
      tone: "amber",
      text: isSpender
        ? myLimit
          ? `Over what is left of your ${symbol} ${bio} limit (${amt(BigInt(myLimit.remaining))}) · the green button on your device signs this`
          : `Your ${bio} has no ${symbol} limit · the green button on your device signs this`
        : "Your device signs this",
    };
  else if (units > 0n && !passkeyOk && !deviceOk && snapshot)
    hint = {
      tone: "coral",
      text: isSpender
        ? myLimit
          ? `Over your ${symbol} ${bio} limit and no device is paired`
          : `Your ${bio} has no ${symbol} limit and no device is paired`
        : "No key can sign this",
    };

  const ready = !!action && enough && (passkeyOk || deviceOk);
  const label = passkeyOk ? `Send with ${bio}` : "Confirm on device";

  const open = (preferred?: "device") => {
    if (!action || !resolved) return;
    const name = resolved.name ?? shortAddr(resolved.address);
    const rows: ConfirmRow[] = [
      { label: "Amount", value: amt(units), mono: true },
      { label: "To", value: name },
    ];
    const u = usdOf(units);
    if (u !== null) rows.push({ label: "Value", value: `≈ ${fmtUsd(u)}`, mono: true });
    if (fee > 0n) rows.push({ label: "Fee", value: amt(fee), mono: true });
    setConfirm({ action, title: `Send ${amt(units)} to ${name}`, rows, preferred });
  };

  const maxFrac = decimals <= 6 ? 2 : 6;
  const press = (k: string) => {
    setAmount(a => {
      if (k === "⌫") return a.slice(0, -1);
      if (k === ".") return a.includes(".") ? a : (a || "0") + ".";
      const next = a === "0" ? k : a + k;
      const [, f] = next.split(".");
      if (f && f.length > maxFrac) return a;
      if (next.replace(".", "").length > 12) return a;
      return next;
    });
  };
  const setMax = () => {
    const m = balance > fee ? balance - fee : 0n;
    setAmount(m === 0n ? "0" : fmtAmount(m, decimals, undefined, maxFrac).replace(/,/g, ""));
  };
  const quick = asset && isStable(asset) ? QUICK_STABLE : QUICK_ETH;
  const approx = usdOf(units);

  const assetPicker = (
    <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
      {assets.map(a => {
        const on = asset?.asset.toLowerCase() === a.asset.toLowerCase();
        return (
          <button
            key={a.asset}
            onClick={() => {
              setAssetAddr(a.asset);
              setAmount("");
            }}
            className={`flex-none rounded-full px-3.5 h-10 text-sm font-semibold flex items-center gap-2 ${on ? "bg-ink text-white" : "bg-white shadow-soft"}`}
          >
            <span>{a.symbol}</span>
            <span className={`mono text-xs ${on ? "text-[#c9ccc9]" : "text-muted"}`}>
              {fmtAmount(a.balance, a.decimals, undefined, a.decimals <= 6 ? 2 : 4)}
            </span>
          </button>
        );
      })}
    </div>
  );

  const amountBlock =
    variant === "page" ? (
      <div className="rounded-[24px] bg-ink-2 text-white p-5">
        <div className="text-[13px] text-[#a3a6a3]">Amount</div>
        <div className="mono font-bold text-[2.8rem] leading-none mt-1 flex items-baseline gap-2 min-w-0">
          <span className="truncate">{amount || "0"}</span>
          <span className="text-[1.3rem] text-[#a3a6a3]">{symbol}</span>
        </div>
        <div className="text-[13px] text-[#a3a6a3] mt-2">
          {approx !== null ? `≈ ${fmtUsd(approx)} · ` : ""}
          {chainLabel}
          {fee > 0n ? ` · fee ${amt(fee)}` : ""}
        </div>
      </div>
    ) : (
      <label className="block rounded-2xl bg-paper border border-line px-4 py-3 focus-within:border-ink">
        <div className="flex items-center justify-between gap-2">
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0"
            inputMode="decimal"
            className="bg-transparent outline-none w-full min-w-0 mono font-bold text-[1.9rem]"
          />
          <div className="text-muted text-sm whitespace-nowrap text-right">
            <div className="font-semibold text-ink">{symbol}</div>
            {approx !== null && <div>≈ {fmtUsd(approx)}</div>}
          </div>
        </div>
      </label>
    );

  return (
    <div className={variant === "panel" ? "card p-5" : "px-5"}>
      {variant === "panel" && <h3 className="font-bold text-[1.05rem] mb-4">Send</h3>}
      {variant === "panel" && <div className="text-muted text-sm mb-1.5">Asset</div>}
      {assetPicker}
      {variant === "page" && <div className="mt-3">{amountBlock}</div>}
      {variant === "panel" && <div className="text-muted text-sm mt-3 mb-1.5">To</div>}
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
        {quick.map(q => (
          <button
            key={q}
            className={`h-11 rounded-full font-semibold text-sm ${amount === q ? "bg-ink text-white" : "bg-white shadow-soft"}`}
            onClick={() => setAmount(q)}
          >
            {q}
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
            placeholder={`Amount in ${symbol}`}
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

      <button className="btn btn-primary w-full mt-3" disabled={!ready} onClick={() => open()}>
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
