"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { type Address, isAddress } from "viem";
import { PageHeader } from "~~/components/AppShell";
import { type ConfirmRow, ConfirmSheet } from "~~/components/ConfirmSheet";
import { ChevronIcon, LockIcon, PlusIcon, ShieldIcon, SignerIcon, WalletIcon } from "~~/components/Icons";
import { useWallet } from "~~/components/WalletProvider";
import { useBiometric } from "~~/hooks/useBiometric";
import type { SignerInfo } from "~~/services/wallet";
import { labelFor } from "~~/utils/accounts";
import { dateShort, durationLabel, shortAddr, toUnits, usd } from "~~/utils/format";
import type { MetaAction } from "~~/utils/meta";

type Pending = { action: MetaAction; title: string; rows: ConfirmRow[] };

export default function KeysPage() {
  const { address, snapshot, passkey, refresh } = useWallet();
  const decimals = snapshot?.token.decimals ?? 6;
  const signers = useMemo(() => snapshot?.signers ?? [], [snapshot]);
  const mine = signers.find(s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase());
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [limitInput, setLimitInput] = useState<string | null>(null);
  const [recoveryForm, setRecoveryForm] = useState<{ address: string; delayHours: string } | null>(null);
  const bio = useBiometric();

  const nameOf = (s: SignerInfo) =>
    labelFor(address, s.signerId) ?? s.label ?? (s.kind === 1 ? "Instant Wallet device" : "Passkey");
  const subOf = (s: SignerInfo) => {
    const own = passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase();
    const parts = [
      own ? "this browser" : s.kind === 1 ? `chip ${shortAddr(s.signerId, 7, 0)}` : null,
      s.addedAt ? `added ${dateShort(s.addedAt)}` : null,
    ];
    if (s.kind === 1 && s.online !== undefined) parts.push(s.online ? "online" : "offline");
    return parts.filter(Boolean).join(" · ");
  };

  const myLimit = mine && mine.role !== 1 ? Number(mine.dailyLimit) / 10 ** decimals : null;
  const sliderVal = limitInput ?? (myLimit !== null ? String(myLimit) : "500");

  const setLimit = (s: SignerInfo, value: string) => {
    const units = toUnits(value, decimals);
    if (units === null) return;
    setPending({
      action: { fn: "metaUpdateSigner", targetSignerId: s.signerId, role: 0, dailyLimit: units },
      title: `Set ${nameOf(s)} limit to ${usd(units, decimals)}/day`,
      rows: [
        { label: "Key", value: nameOf(s) },
        { label: "Daily limit", value: usd(units, decimals), mono: true },
      ],
    });
  };
  const setRole = (s: SignerInfo, role: number) =>
    setPending({
      action: {
        fn: "metaUpdateSigner",
        targetSignerId: s.signerId,
        role,
        dailyLimit: role === 1 ? 0n : BigInt(s.dailyLimit),
      },
      title: role === 1 ? `Make ${nameOf(s)} an owner` : `Make ${nameOf(s)} a spender`,
      rows: [
        { label: "Key", value: nameOf(s) },
        { label: "Role", value: role === 1 ? "Owner · no limit" : `Spender · ${usd(s.dailyLimit, decimals)}/day` },
      ],
    });
  const remove = (s: SignerInfo) =>
    setPending({
      action: { fn: "metaRemoveSigner", targetSignerId: s.signerId },
      title: `Remove ${nameOf(s)}`,
      rows: [
        { label: "Key", value: nameOf(s) },
        { label: "Id", value: shortAddr(s.signerId, 8, 6), mono: true },
      ],
    });
  const setRecovery = () => {
    if (!recoveryForm || !isAddress(recoveryForm.address)) return;
    const delay = BigInt(Math.max(1, Math.round(Number(recoveryForm.delayHours) || 24)) * 3600);
    setPending({
      action: { fn: "metaSetRecovery", recoveryAddress: recoveryForm.address as Address, recoveryDelay: delay },
      title: "Set recovery address",
      rows: [
        { label: "Address", value: shortAddr(recoveryForm.address, 8, 6), mono: true },
        { label: "Delay", value: durationLabel(Number(delay)) },
      ],
    });
  };
  const cancelRecovery = () =>
    setPending({ action: { fn: "metaCancelRecovery" }, title: "Cancel the pending recovery", rows: [] });

  const owners = useMemo(() => signers.filter(s => s.role === 1).length, [signers]);

  return (
    <div className="max-w-md mx-auto lg:max-w-2xl lg:pt-8">
      <PageHeader title="Keys & limits" back={`/w/${address}`} desktop />
      <div className="px-5 flex flex-col gap-4">
        <div className="card p-5">
          <h3 className="font-bold text-[1.05rem] mb-1">Your keys</h3>
          <div className="divide-y divide-line">
            {signers.map(s => {
              const isOpen = open === s.signerId;
              const own = passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase();
              return (
                <div key={s.signerId} className="py-1">
                  <button
                    className="w-full flex items-center gap-3 py-3 text-left"
                    onClick={() => setOpen(isOpen ? null : s.signerId)}
                  >
                    <div className={`icon-tile ${s.kind === 1 ? "tile-gray" : "tile-mint"}`}>
                      <SignerIcon kind={s.kind} label={nameOf(s)} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{nameOf(s)}</div>
                      <div className="text-muted text-sm truncate">{subOf(s)}</div>
                    </div>
                    <span className={`chip ${s.role === 1 ? "chip-dark" : ""}`}>
                      {s.role === 1 ? "No limit" : `${usd(s.dailyLimit, decimals)} / day`}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-3 pl-[56px] text-sm flex flex-col gap-2">
                      <div className="mono text-xs text-muted break-all">{s.signerId}</div>
                      {s.role !== 1 && (
                        <div className="text-muted">
                          Remaining today:{" "}
                          <span className="font-semibold text-ink">
                            {s.remainingAllowance === "unlimited" ? "unlimited" : usd(s.remainingAllowance, decimals)}
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2 mt-1">
                        {s.role !== 1 && (
                          <button
                            className="btn btn-white btn-xs"
                            onClick={() =>
                              setLimit(
                                s,
                                prompt("Daily limit in USD", String(Number(s.dailyLimit) / 10 ** decimals)) ?? "",
                              )
                            }
                          >
                            Set limit
                          </button>
                        )}
                        {s.role !== 1 ? (
                          <button className="btn btn-white btn-xs" onClick={() => setRole(s, 1)}>
                            Make owner
                          </button>
                        ) : (
                          <button className="btn btn-white btn-xs" onClick={() => setRole(s, 0)} disabled={owners <= 1}>
                            Make spender
                          </button>
                        )}
                        <button
                          className="btn btn-white btn-xs text-coral"
                          onClick={() => remove(s)}
                          disabled={s.role === 1 && owners <= 1}
                        >
                          Remove key
                        </button>
                      </div>
                      {own && <div className="text-xs text-muted">This is the passkey on this browser.</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Link href={`/w/${address}/keys/add`} className="flex items-center gap-2 pt-3 font-semibold text-mint-dark">
            <PlusIcon size={20} /> Add a key
          </Link>
        </div>

        {mine && mine.role !== 1 && (
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-[1.05rem]">{bio} daily limit</h3>
              <span className="mono font-semibold text-lg">${Number(sliderVal).toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(2000, myLimit ?? 0)}
              step={10}
              value={Number(sliderVal)}
              onChange={e => setLimitInput(e.target.value)}
              className="w-full mt-3 accent-mint"
            />
            <p className="text-muted text-sm mt-2">Above this, your device signs. Raising it asks the device too.</p>
            {limitInput !== null && Number(limitInput) !== myLimit && (
              <button className="btn btn-primary btn-sm mt-3" onClick={() => setLimit(mine, limitInput)}>
                Save ${Number(limitInput).toLocaleString()} / day
              </button>
            )}
          </div>
        )}

        <div className="card p-5">
          <h3 className="font-bold text-[1.05rem] mb-1">If something goes wrong</h3>
          <div className="divide-y divide-line">
            <div className="flex items-center gap-3 py-3">
              <div className="icon-tile tile-mint">
                <ShieldIcon size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Lost this phone?</div>
                <div className="text-muted text-sm">
                  {signers.some(s => s.kind === 1)
                    ? "Green button on the device adds a new one"
                    : "Pair a device so it can add a new phone"}
                </div>
              </div>
            </div>
            <button
              className="w-full flex items-center gap-3 py-3 text-left"
              onClick={() =>
                setRecoveryForm(
                  recoveryForm
                    ? null
                    : {
                        address: snapshot?.recovery?.recoveryAddress ?? "",
                        delayHours: String((snapshot?.recovery?.recoveryDelay ?? 86400) / 3600),
                      },
                )
              }
            >
              <div className="icon-tile tile-gray">
                <WalletIcon size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Recovery address</div>
                <div className="text-muted text-sm truncate">
                  {snapshot?.recovery
                    ? `${shortAddr(snapshot.recovery.recoveryAddress, 6, 4)} · ${durationLabel(snapshot.recovery.recoveryDelay)} delay`
                    : "—"}
                </div>
              </div>
              <ChevronIcon size={18} className="text-muted" />
            </button>
            {recoveryForm && (
              <div className="py-3 pl-[56px] flex flex-col gap-2">
                <input
                  className="input mono text-sm"
                  placeholder="0x… (an EOA you control, or leave the guardian)"
                  value={recoveryForm.address}
                  onChange={e => setRecoveryForm({ ...recoveryForm, address: e.target.value.trim() })}
                />
                <div className="flex items-center gap-2">
                  <input
                    className="input w-28"
                    inputMode="numeric"
                    value={recoveryForm.delayHours}
                    onChange={e => setRecoveryForm({ ...recoveryForm, delayHours: e.target.value })}
                  />
                  <span className="text-muted text-sm">hours delay (min 1)</span>
                </div>
                <button
                  className="btn btn-primary btn-sm self-start"
                  onClick={setRecovery}
                  disabled={!isAddress(recoveryForm.address)}
                >
                  Save recovery
                </button>
              </div>
            )}
            {snapshot?.recovery?.pending && (
              <div className="flex items-center gap-3 py-3">
                <div className="icon-tile bg-coral-soft text-coral">
                  <LockIcon size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-coral">Recovery in progress</div>
                  <div className="text-muted text-sm">
                    A new owner key lands {dateShort(snapshot.recovery.pending.executeAfter)} unless an owner acts
                  </div>
                </div>
                <button className="btn btn-white btn-xs text-coral" onClick={cancelRecovery}>
                  Cancel it
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {pending && (
        <ConfirmSheet
          action={pending.action}
          title={pending.title}
          rows={pending.rows}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            setLimitInput(null);
            setRecoveryForm(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
