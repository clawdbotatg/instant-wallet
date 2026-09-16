"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Hex } from "viem";
import { PageHeader } from "~~/components/AppShell";
import { type ConfirmRow, ConfirmSheet } from "~~/components/ConfirmSheet";
import { CheckIcon, ChipIcon, FaceIdIcon, TouchIdIcon } from "~~/components/Icons";
import { QrScanner } from "~~/components/QrScanner";
import { useWallet } from "~~/components/WalletProvider";
import { useBiometric } from "~~/hooks/useBiometric";
import { DEFAULT_STABLE, ETH_META } from "~~/utils/chain";
import { type AdminOp, KIND_RAW, ROLE_OWNER, ROLE_SPENDER, ZERO_BYTES32, signerIdOf } from "~~/utils/digests";
import { fmtAmount, shortAddr, toUnits } from "~~/utils/format";
import { type MetaAction, adminAction } from "~~/utils/meta";

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

const DEFAULT_STABLE_LIMIT = "500";
const DEFAULT_ETH_LIMIT = "0.1";

/**
 * Pair a device. When this passkey owns the wallet it is ONE Face ID (docs/PROTOCOL.md section 1):
 * `Execute([addSigner(chip, owner), updateSigner(passkey, spender), setLimit(passkey, USDC, …), setLimit(passkey, ETH, …)])`.
 * When the device (or another owner) already owns the wallet, adding a key is a plain AddSigner it signs.
 */
export default function AddKeyPage() {
  const { address, snapshot, passkey, devices, refresh } = useWallet();
  const router = useRouter();
  const bio = useBiometric();
  const [scanned, setScanned] = useState<{ qx: Hex; qy: Hex; name: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [stableLimit, setStableLimit] = useState(DEFAULT_STABLE_LIMIT);
  const [ethLimit, setEthLimit] = useState(DEFAULT_ETH_LIMIT);
  const [confirm, setConfirm] = useState<{ action: MetaAction; title: string; rows: ConfirmRow[] } | null>(null);
  const [done, setDone] = useState(false);

  const mine = snapshot?.signers.find(s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase());
  const iAmOwner = mine?.role === ROLE_OWNER;
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

  const stableUnits = DEFAULT_STABLE ? (toUnits(stableLimit || "0", DEFAULT_STABLE.decimals) ?? 0n) : 0n;
  const ethUnits = toUnits(ethLimit || "0", ETH_META.decimals) ?? 0n;

  const plan = useMemo(() => {
    if (!scanned) return null;
    const add: AdminOp = {
      op: "addSigner",
      qx: scanned.qx,
      qy: scanned.qy,
      kind: KIND_RAW,
      role: ROLE_OWNER,
      credentialIdHash: ZERO_BYTES32,
    };
    if (!(iAmOwner && mine))
      return {
        ops: [add],
        rows: [
          { label: "Key", value: scanned.name },
          { label: "Role", value: "Owner · no limit" },
        ],
      };
    const ops: AdminOp[] = [add, { op: "updateSigner", signerId: mine.signerId, role: ROLE_SPENDER }];
    const rows: ConfirmRow[] = [
      { label: "Device", value: `${scanned.name} · owner` },
      { label: `This ${bio}`, value: "spender" },
    ];
    if (DEFAULT_STABLE && stableUnits > 0n) {
      ops.push({ op: "setLimit", signerId: mine.signerId, asset: DEFAULT_STABLE.address, limit: stableUnits });
      rows.push({
        label: `${DEFAULT_STABLE.symbol} / day`,
        value: fmtAmount(stableUnits, DEFAULT_STABLE.decimals),
        mono: true,
      });
    }
    if (ethUnits > 0n) {
      ops.push({ op: "setLimit", signerId: mine.signerId, asset: ETH_META.address, limit: ethUnits });
      rows.push({ label: "ETH / day", value: fmtAmount(ethUnits, 18), mono: true });
    }
    return { ops, rows };
  }, [scanned, iAmOwner, mine, stableUnits, ethUnits, bio]);

  const start = () => {
    if (!scanned || !plan) return;
    const labels = { [signerIdOf(scanned.qx, scanned.qy)]: scanned.name };
    const action = adminAction(address, plan.ops, { labels });
    if (action.fn === "metaAddSigner") action.label = scanned.name;
    setConfirm({ action, title: iAmOwner ? `Pair ${scanned.name}` : `Add ${scanned.name} as owner`, rows: plan.rows });
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
            A $35 signer you build yourself. It becomes the key for anything over your {bio} limits.
          </p>
        </div>

        {done ? (
          <div className="card p-6 flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-mint-soft text-mint-dark flex items-center justify-center">
              <CheckIcon size={36} />
            </div>
            <h3 className="text-xl font-bold mt-4">Device paired</h3>
            <p className="text-muted mt-1">
              {scanned?.name} now owns the account.
              {iAmOwner
                ? ` ${bio} keeps ${[
                    DEFAULT_STABLE && stableUnits > 0n
                      ? fmtAmount(stableUnits, DEFAULT_STABLE.decimals, DEFAULT_STABLE.symbol)
                      : null,
                    ethUnits > 0n ? fmtAmount(ethUnits, 18, "ETH") : null,
                  ]
                    .filter(Boolean)
                    .join(" + ")} per day.`
                : ""}
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
                {iAmOwner && (
                  <div className="mt-4 flex flex-col gap-3">
                    <div className="text-sm text-muted">Your {bio} limits after pairing (per rolling 24h)</div>
                    {DEFAULT_STABLE && (
                      <label className="flex items-center gap-2">
                        <span className="w-14 font-semibold">{DEFAULT_STABLE.symbol}</span>
                        <input
                          className="input mono"
                          inputMode="decimal"
                          value={stableLimit}
                          onChange={e => setStableLimit(e.target.value.replace(/[^\d.]/g, ""))}
                        />
                        <span className="text-muted text-sm whitespace-nowrap">/ day</span>
                      </label>
                    )}
                    <label className="flex items-center gap-2">
                      <span className="w-14 font-semibold">ETH</span>
                      <input
                        className="input mono"
                        inputMode="decimal"
                        value={ethLimit}
                        onChange={e => setEthLimit(e.target.value.replace(/[^\d.]/g, ""))}
                      />
                      <span className="text-muted text-sm whitespace-nowrap">/ day</span>
                    </label>
                    <div className="text-xs text-muted">
                      0 = this {bio} may not move that asset. More assets later on the Keys page.
                    </div>
                  </div>
                )}
                <div className="mt-4 text-sm text-muted">
                  {iAmOwner
                    ? `One ${bio}: the device becomes the owner, this passkey becomes a spender with the limits above.`
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
                  [
                    `Confirm with ${bio}`,
                    "One tap: the device owns the account, this passkey keeps a daily allowance.",
                  ],
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
          action={confirm.action}
          title={confirm.title}
          subtitle={iAmOwner ? "One signature, four changes" : undefined}
          rows={confirm.rows}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            setDone(true);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
