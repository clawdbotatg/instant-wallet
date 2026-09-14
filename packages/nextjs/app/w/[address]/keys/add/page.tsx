"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Hex } from "viem";
import { PageHeader } from "~~/components/AppShell";
import { ConfirmSheet } from "~~/components/ConfirmSheet";
import { CheckIcon, ChipIcon, FaceIdIcon, TouchIdIcon } from "~~/components/Icons";
import { QrScanner } from "~~/components/QrScanner";
import { useWallet } from "~~/components/WalletProvider";
import { useBiometric } from "~~/hooks/useBiometric";
import { ZERO_BYTES32, signerIdOf } from "~~/utils/digests";
import { shortAddr, usd } from "~~/utils/format";
import type { MetaAction } from "~~/utils/meta";

/** Parse the device's pairing QR: `iw1:<qx hex>:<qy hex>:<name>` */
function parsePairing(text: string): { qx: Hex; qy: Hex; name: string } | null {
  const m = text.trim().match(/^iw1:(?:0x)?([0-9a-fA-F]{64}):(?:0x)?([0-9a-fA-F]{64}):(.*)$/s);
  if (!m) return null;
  return {
    qx: `0x${m[1].toLowerCase()}`,
    qy: `0x${m[2].toLowerCase()}`,
    name: m[3].trim().slice(0, 64) || "Instant Wallet device",
  };
}

const DEFAULT_LIMIT_USD = "500";

export default function AddKeyPage() {
  const { address, snapshot, passkey, devices, refresh } = useWallet();
  const router = useRouter();
  const decimals = snapshot?.token.decimals ?? 6;
  const bio = useBiometric();
  const [scanned, setScanned] = useState<{ qx: Hex; qy: Hex; name: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0); // 0 idle, 1 addSigner, 2 updateSigner(self), 3 done
  const [limit, setLimit] = useState(DEFAULT_LIMIT_USD);
  const [confirm, setConfirm] = useState<MetaAction | null>(null);
  const [done, setDone] = useState<string[]>([]);

  const mine = snapshot?.signers.find(s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase());
  const alreadySigner =
    scanned &&
    snapshot?.signers.some(s => s.signerId.toLowerCase() === signerIdOf(scanned.qx, scanned.qy).toLowerCase());
  const onScan = useCallback((text: string) => {
    const p = parsePairing(text);
    if (p) {
      setScanned(p);
      setShowScanner(false);
    }
  }, []);
  useEffect(() => {
    const p = parsePairing(pasted);
    if (p) setScanned(p);
  }, [pasted]);

  const limitUnits = BigInt(Math.round(Number(limit || "0") * 10 ** decimals));

  const start = () => {
    if (!scanned) return;
    setStage(1);
    setConfirm({
      fn: "metaAddSigner",
      qx: scanned.qx,
      qy: scanned.qy,
      kind: 1,
      role: 1,
      dailyLimit: 0n,
      credentialIdHash: ZERO_BYTES32,
      label: scanned.name,
    });
  };
  const afterStep = () => {
    if (stage === 1) {
      setDone(d => [...d, "added"]);
      if (mine && mine.role === 1) {
        // Step 2 of pairing: this passkey steps down to a spender with a daily limit (second tap).
        setStage(2);
        setConfirm({ fn: "metaUpdateSigner", targetSignerId: mine.signerId, role: 0, dailyLimit: limitUnits });
        return;
      }
      setStage(3);
      setConfirm(null);
      return;
    }
    if (stage === 2) {
      setDone(d => [...d, "limited"]);
      setStage(3);
      setConfirm(null);
      void refresh();
    }
  };

  const onlineDevices = devices.filter(
    d => !snapshot?.signers.some(s => s.signerId.toLowerCase() === d.signerId.toLowerCase()),
  );

  return (
    <div className="max-w-md mx-auto lg:max-w-lg lg:pt-8">
      <PageHeader title="Add a key" back={`/w/${address}/keys`} desktop />
      <div className="px-5 flex flex-col gap-4">
        <div>
          <h2 className="text-[1.6rem] font-bold">Add your device</h2>
          <p className="text-muted mt-1">
            A $35 signer you build yourself. It becomes the key for anything over your {bio} limit.
          </p>
        </div>

        {stage === 3 ? (
          <div className="card p-6 flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-mint-soft text-mint-dark flex items-center justify-center">
              <CheckIcon size={36} />
            </div>
            <h3 className="text-xl font-bold mt-4">Device paired</h3>
            <p className="text-muted mt-1">
              {scanned?.name} now owns the account.
              {done.includes("limited") ? ` ${bio} keeps a ${usd(limitUnits, decimals)}/day allowance.` : ""}
            </p>
            <button className="btn btn-primary w-full mt-5" onClick={() => router.push(`/w/${address}/keys`)}>
              Back to keys
            </button>
          </div>
        ) : scanned ? (
          <div className="card p-5">
            <div className="flex items-center gap-3">
              <div className="icon-tile tile-gray">
                <ChipIcon size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold truncate">{scanned.name}</div>
                <div className="mono text-xs text-muted">{shortAddr(signerIdOf(scanned.qx, scanned.qy), 10, 6)}</div>
              </div>
              <button className="text-sm font-semibold text-muted" onClick={() => setScanned(null)}>
                Change
              </button>
            </div>
            {alreadySigner ? (
              <div className="mt-4 rounded-2xl bg-mint-soft text-mint-dark px-4 py-3 text-sm font-semibold">
                This device is already a key on this wallet.
              </div>
            ) : (
              <>
                {mine?.role === 1 && (
                  <div className="mt-4">
                    <div className="text-sm text-muted mb-1">Your {bio} daily limit after pairing</div>
                    <div className="flex items-center gap-2">
                      <span className="mono text-xl font-bold">$</span>
                      <input
                        className="input mono"
                        inputMode="decimal"
                        value={limit}
                        onChange={e => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
                      />
                      <span className="text-muted text-sm whitespace-nowrap">/ day</span>
                    </div>
                  </div>
                )}
                <div className="mt-4 text-sm text-muted">
                  {mine?.role === 1
                    ? `Two ${bio} taps: add the device as owner, then limit this passkey to ${usd(limitUnits, decimals)}/day.`
                    : "An owner key confirms this (the device that already owns the account, or an owner passkey)."}
                </div>
                <button className="btn btn-primary w-full mt-4" onClick={start}>
                  {bio === "Touch ID" ? <TouchIdIcon size={20} /> : <FaceIdIcon size={20} />}
                  Confirm with {bio}
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="rounded-[24px] bg-ink-2 p-3">
              {showScanner ? (
                <QrScanner onResult={onScan} caption="Point at the device screen" />
              ) : (
                <button
                  className="w-full aspect-[4/3] rounded-[20px] border-[3px] border-mint flex flex-col items-center justify-center text-white gap-2"
                  onClick={() => setShowScanner(true)}
                >
                  <ChipIcon size={40} />
                  <span className="font-semibold">Tap to open the camera</span>
                  <span className="text-sm text-[#a3a6a3]">Point at the device screen</span>
                </button>
              )}
            </div>
            <div className="card p-5">
              <ol className="flex flex-col gap-4">
                {[
                  ["Turn on your device", "Hold the green button. It shows a code on screen."],
                  [
                    "Scan it with this phone",
                    "That tells your account the device's public key. Nothing leaves the chip.",
                  ],
                  [`Confirm with ${bio}`, "Your account adds the device as a signer. Same address, one more key."],
                ].map(([t, d], i) => (
                  <li key={t} className="flex gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex-none flex items-center justify-center font-bold text-sm ${i === 0 ? "bg-mint text-white" : "bg-paper"}`}
                    >
                      {i === 0 ? <CheckIcon size={16} /> : i + 1}
                    </div>
                    <div>
                      <div className="font-semibold">{t}</div>
                      <div className="text-muted text-sm">{d}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            {onlineDevices.length > 0 && (
              <div className="card p-5">
                <div className="font-bold mb-2">Devices on your network</div>
                {onlineDevices.map(d => (
                  <button
                    key={d.signerId}
                    className="w-full flex items-center gap-3 py-2 text-left"
                    onClick={() => setScanned({ qx: d.qx, qy: d.qy, name: d.name })}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${d.online ? "bg-mint" : "bg-[#c9ccc9]"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{d.name}</div>
                      <div className="mono text-xs text-muted">{shortAddr(d.signerId, 10, 6)}</div>
                    </div>
                    <span className="text-mint-dark font-semibold text-sm">Add</span>
                  </button>
                ))}
              </div>
            )}
            <label className="block">
              <div className="text-sm text-muted mb-1">Or paste the pairing code</div>
              <textarea
                className="input mono text-xs"
                rows={3}
                placeholder="iw1:<qx>:<qy>:<name>"
                value={pasted}
                onChange={e => setPasted(e.target.value)}
              />
            </label>
          </>
        )}
      </div>

      {confirm && (
        <ConfirmSheet
          action={confirm}
          title={stage === 1 ? `Add ${scanned?.name} as owner` : `Limit ${bio} to ${usd(limitUnits, decimals)}/day`}
          subtitle={stage === 1 ? "Step 1 of 2" : "Step 2 of 2"}
          rows={
            stage === 1
              ? [
                  { label: "Key", value: scanned?.name ?? "device" },
                  { label: "Role", value: "Owner · no limit" },
                ]
              : [
                  { label: "Key", value: `This ${bio}` },
                  { label: "Daily limit", value: usd(limitUnits, decimals), mono: true },
                ]
          }
          onClose={() => {
            setConfirm(null);
            if (stage === 1) setStage(0);
            else setStage(3);
          }}
          onDone={afterStep}
        />
      )}
    </div>
  );
}
