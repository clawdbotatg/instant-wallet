"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeviceIllustration } from "./DeviceIllustration";
import { CheckIcon, ChipIcon, FaceIdIcon, TouchIdIcon, XIcon } from "./Icons";
import { useWallet } from "./WalletProvider";
import type { Hex } from "viem";
import { useBiometric } from "~~/hooks/useBiometric";
import type { WalletRequest } from "~~/services/types";
import type { LimitInfo, SignerInfo } from "~~/services/wallet";
import { api } from "~~/utils/api";
import { fmtAmount } from "~~/utils/format";
import { type MetaAction, needsOwner, requestBody, signAndFacilitate } from "~~/utils/meta";

export type ConfirmRow = { label: string; value: string; mono?: boolean };

export type ConfirmProps = {
  action: MetaAction;
  title: string;
  subtitle?: string;
  rows?: ConfirmRow[];
  preferred?: "passkey" | "device";
  note?: string;
  onDone: (r: { txHash: Hex; via: "passkey" | "device" }) => void;
  onClose: () => void;
};

/** A spender's allowance on the asset an action moves (undefined = the action moves nothing). */
export function limitFor(s: SignerInfo | undefined, action: MetaAction): LimitInfo | undefined {
  if (!s || action.fn !== "metaTransfer") return undefined;
  return s.limits.find(l => l.asset.toLowerCase() === action.asset.toLowerCase());
}

/**
 * Can this signer sign this action right now? Owners: anything. Spenders: only a transfer of an
 * asset an owner gave them a limit on, within what is left of the rolling 24h window (amount + fee).
 */
export function canSign(s: SignerInfo | undefined, action: MetaAction): boolean {
  if (!s) return false;
  if (s.role === 1) return true;
  if (needsOwner(action) || action.fn !== "metaTransfer") return false;
  const l = limitFor(s, action);
  return !!l && BigInt(l.remaining) >= action.amount + action.fee;
}

/**
 * The confirm step every action goes through. Two exits: the passkey (Face ID / Touch ID) signs
 * the digest right here and the facilitator relays; or the request is queued for the device and
 * we wait for the green button, showing the match code.
 */
export function ConfirmSheet(props: ConfirmProps) {
  const { action, title, subtitle, rows = [], preferred, note, onDone, onClose } = props;
  const { address, snapshot, passkey, devices, refresh } = useWallet();
  const signers = useMemo(() => snapshot?.signers ?? [], [snapshot]);
  const bio = useBiometric();

  const passkeySigner = useMemo(
    () => signers.find(s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase()),
    [signers, passkey],
  );
  const passkeyOk = !!passkey && canSign(passkeySigner, action);
  const deviceSigners = useMemo(() => signers.filter(s => s.kind === 1 && canSign(s, action)), [signers, action]);
  const overLimit = !!passkeySigner && !passkeyOk && passkeySigner.role !== 1 && !needsOwner(action);
  const myLimit = limitFor(passkeySigner, action);
  const limitLabel =
    action.fn === "metaTransfer"
      ? myLimit
        ? `${fmtAmount(myLimit.limit, myLimit.decimals, myLimit.symbol)}/day`
        : `no ${action.assetSymbol ?? "asset"}`
      : undefined;

  const initial: "passkey" | "device" | "none" =
    preferred === "device" && deviceSigners.length
      ? "device"
      : passkeyOk
        ? "passkey"
        : deviceSigners.length
          ? "device"
          : "none";
  const [mode, setMode] = useState<"passkey" | "device" | "none" | "done">(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);

  const signWithPasskey = async () => {
    if (!passkey) return;
    setBusy(true);
    setError(null);
    try {
      const { txHash } = await signAndFacilitate(address, passkey, action);
      setTxHash(txHash);
      setMode("done");
      void refresh();
      setTimeout(() => onDone({ txHash, via: "passkey" }), 900);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={busy ? undefined : onClose} />
      <div className="sheet" role="dialog" aria-modal>
        <div className="lg:hidden mx-auto w-10 h-1.5 rounded-full bg-line mb-3" />
        <div className="hidden lg:flex justify-end -mt-2 -mr-2">
          <button
            className="w-9 h-9 rounded-full hover:bg-paper flex items-center justify-center"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        {mode === "done" && (
          <div className="flex flex-col items-center text-center py-6">
            <div className="w-20 h-20 rounded-full bg-mint-soft text-mint-dark flex items-center justify-center">
              <CheckIcon size={36} />
            </div>
            <h2 className="text-2xl font-bold mt-5">Done</h2>
            <p className="text-muted mt-1">{title}</p>
            {txHash && <div className="mono text-xs text-muted mt-3 break-all">{txHash}</div>}
          </div>
        )}

        {mode === "passkey" && (
          <div className="flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-mint-soft text-mint-dark flex items-center justify-center">
              {bio === "Touch ID" ? <TouchIdIcon size={36} /> : <FaceIdIcon size={36} />}
            </div>
            <h2 className="text-[1.45rem] font-bold mt-5">{title}</h2>
            <p className="text-muted mt-1">
              {subtitle ?? `Look at your ${bio === "Touch ID" ? "keyboard" : "phone"} to confirm`}
            </p>
            {rows.length > 0 && (
              <div className="w-full mt-5 rounded-2xl bg-paper divide-y divide-line text-left">
                {rows.map(r => (
                  <div key={r.label} className="flex items-center justify-between px-4 py-3">
                    <span className="text-muted">{r.label}</span>
                    <span className={`font-semibold ${r.mono ? "mono" : ""}`}>{r.value}</span>
                  </div>
                ))}
              </div>
            )}
            {snapshot && !snapshot.deployed && (
              <div className="w-full mt-3 text-xs text-muted">
                First action: the facilitator creates the wallet on chain in the same breath.
              </div>
            )}
            {error && (
              <div className="w-full mt-4 rounded-2xl bg-coral-soft text-coral px-4 py-3 text-sm text-left">
                {error}
              </div>
            )}
            <button className="btn btn-primary w-full mt-6" onClick={signWithPasskey} disabled={busy}>
              {bio === "Touch ID" ? <TouchIdIcon size={20} /> : <FaceIdIcon size={20} />}
              {busy ? "Waiting…" : `Confirm with ${bio}`}
            </button>
            {deviceSigners.length > 0 && (
              <button className="mt-3 text-sm font-semibold text-muted" onClick={() => setMode("device")}>
                Use the device instead
              </button>
            )}
            <button className="btn btn-white w-full mt-3" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        )}

        {mode === "device" && (
          <DeviceWait
            action={action}
            signer={deviceSigners[0]}
            rows={rows}
            overLimit={overLimit}
            limitLabel={limitLabel}
            online={devices.some(
              d => d.online && d.signerId.toLowerCase() === deviceSigners[0]?.signerId.toLowerCase(),
            )}
            note={note}
            onCancel={onClose}
            onDone={r => {
              setTxHash(r.txHash);
              setMode("done");
              void refresh();
              setTimeout(() => onDone({ txHash: r.txHash, via: "device" }), 900);
            }}
          />
        )}

        {mode === "none" && (
          <div className="flex flex-col items-center text-center py-4">
            <div className="w-20 h-20 rounded-full bg-coral-soft text-coral flex items-center justify-center">
              <XIcon size={32} />
            </div>
            <h2 className="text-xl font-bold mt-5">No key can sign this</h2>
            <p className="text-muted mt-2 max-w-sm">
              {overLimit && passkeySigner
                ? myLimit
                  ? `This is over what is left of your ${limitLabel} ${bio} limit and no device is paired to sign the rest.`
                  : `Your ${bio} has no limit on this asset (an owner sets one on the Keys page) and no device is paired.`
                : passkey
                  ? needsOwner(action)
                    ? "Only an owner key can do this. Your passkey is a spender; the device owns the account."
                    : "Your passkey is not a signer of this wallet."
                  : "Sign in with a passkey that belongs to this wallet, or pair your device."}
            </p>
            <button className="btn btn-white w-full mt-6" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function DeviceWait({
  action,
  signer,
  rows,
  overLimit,
  limitLabel,
  online,
  note,
  onCancel,
  onDone,
}: {
  action: MetaAction;
  signer: SignerInfo | undefined;
  rows: ConfirmRow[];
  overLimit: boolean;
  limitLabel?: string;
  online: boolean;
  note?: string;
  onCancel: () => void;
  onDone: (r: { txHash: Hex }) => void;
}) {
  const { address } = useWallet();
  const bio = useBiometric();
  const [request, setRequest] = useState<WalletRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const created = useRef(false);

  const create = useCallback(async () => {
    if (!signer) return;
    setError(null);
    try {
      const { request } = await api.createRequest(requestBody(action, address, signer.signerId, note));
      setRequest(request);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [action, address, signer, note]);

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    void create();
  }, [create]);

  useEffect(() => {
    if (!request) return;
    if (["confirmed", "failed", "rejected", "expired"].includes(request.status)) return;
    const t = setInterval(async () => {
      try {
        const { request: r } = await api.request(request.id);
        setRequest(r);
        if (r.status === "confirmed" && r.txHash) onDone({ txHash: r.txHash });
      } catch {
        // keep polling
      }
    }, 2000);
    return () => clearInterval(t);
  }, [request, onDone]);

  const cancel = async () => {
    if (request && request.status === "pending") await api.reject(request.id).catch(() => {});
    onCancel();
  };

  const terminal = request && ["failed", "rejected", "expired"].includes(request.status);
  const statusLine = !request
    ? error
      ? error
      : "Queuing the request…"
    : request.status === "pending"
      ? `Waiting for the green button… device is ${online ? "online" : "offline"}`
      : request.status === "signed" || request.status === "relaying"
        ? "Signed. Sending to the chain…"
        : request.status === "confirmed"
          ? "Confirmed"
          : `${request.status}${request.error ? ` · ${request.error}` : ""}`;

  return (
    <div className="flex flex-col items-center text-center">
      {overLimit && limitLabel && (
        <span className="chip chip-amber mb-3">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5Z" />
            <path d="m9.5 12 1.8 1.8 3.5-3.6" />
          </svg>
          Over your {limitLabel} {bio} limit
        </span>
      )}
      <h2 className="text-[1.5rem] font-bold">Confirm on your device</h2>
      <p className="text-muted mt-1 max-w-sm">
        Press the green button on your Instant Wallet. Check the amount, the name and the code match.
      </p>
      <div className="my-5">
        <DeviceIllustration
          screen={action.fn === "metaAddSigner" ? "addKey" : "sign"}
          width={280}
          amount={rows.find(r => r.label === "Amount")?.value}
          to={rows.find(r => r.label === "To")?.value}
        />
      </div>
      <div className="w-full rounded-2xl bg-paper divide-y divide-line text-left lg:bg-transparent lg:divide-y-0 lg:grid lg:grid-cols-2 lg:gap-3">
        {rows.map(r => (
          <div
            key={r.label}
            className="flex items-center justify-between px-4 py-3 lg:block lg:rounded-2xl lg:bg-paper"
          >
            <span className="text-muted text-sm">{r.label}</span>
            <span className={`font-semibold lg:block lg:mt-1 lg:text-lg ${r.mono ? "mono" : ""}`}>{r.value}</span>
          </div>
        ))}
        <div className="flex items-center justify-between px-4 py-3 lg:block lg:rounded-2xl lg:bg-amber-soft lg:border lg:border-amber-line">
          <span className="text-muted text-sm lg:text-amber-ink">Match code</span>
          <span className="mono font-semibold rounded-xl bg-amber-soft border border-amber-line px-3 py-1.5 text-amber-ink lg:border-0 lg:bg-transparent lg:px-0 lg:block lg:mt-1 lg:text-lg">
            {request ? request.matchCode : "…"}
          </span>
        </div>
      </div>
      <div className={`mt-4 flex items-center gap-2 text-sm ${terminal ? "text-coral" : "text-muted"}`}>
        {!terminal && <span className={`w-2.5 h-2.5 rounded-full ${online ? "bg-mint pulse-dot" : "bg-[#c9ccc9]"}`} />}
        {statusLine}
      </div>
      <div className="w-full mt-5 flex flex-col gap-2 lg:flex-row-reverse lg:justify-between">
        {terminal || (error && !request) ? (
          <button
            className="btn btn-primary w-full lg:w-auto"
            onClick={() => {
              setRequest(null);
              created.current = false;
              setTimeout(() => {
                created.current = true;
                void create();
              }, 0);
            }}
          >
            Try again
          </button>
        ) : null}
        <button className="btn btn-danger-text w-full lg:w-auto" onClick={cancel}>
          Cancel
        </button>
      </div>
      {signer && (
        <div className="mt-3 text-xs text-muted flex items-center gap-1">
          <ChipIcon size={14} /> {signer.label ?? "Instant Wallet device"}
        </div>
      )}
    </div>
  );
}
