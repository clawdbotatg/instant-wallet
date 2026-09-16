"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { type Address, isAddress } from "viem";
import { PageHeader } from "~~/components/AppShell";
import { type ConfirmRow, ConfirmSheet } from "~~/components/ConfirmSheet";
import { ChevronIcon, LockIcon, PlusIcon, ShieldIcon, SignerIcon, WalletIcon, XIcon } from "~~/components/Icons";
import { useWallet } from "~~/components/WalletProvider";
import { useBiometric } from "~~/hooks/useBiometric";
import type { SignerInfo } from "~~/services/wallet";
import { labelFor } from "~~/utils/accounts";
import { KNOWN_ASSETS } from "~~/utils/chain";
import { type AdminOp, ROLE_OWNER, ROLE_SPENDER } from "~~/utils/digests";
import { dateShort, durationLabel, fmtAmount, shortAddr, toUnits } from "~~/utils/format";
import { type MetaAction, adminAction } from "~~/utils/meta";

type Pending = { action: MetaAction; title: string; rows: ConfirmRow[] };
type AssetOpt = { address: Address; symbol: string; decimals: number };
/** A staged limit change for one signer: asset -> new limit (0 = remove). */
type Staged = Record<string, { asset: AssetOpt; limit: bigint }>;

/**
 * Keys & limits. Every signer with its role; spenders list their per-asset 24h allowances
 * (limit, remaining). Owners stage limit changes per key and save them in one signature: a single
 * change is a plain SetLimit, several become one Execute of self-calls. Roles and removals confirm
 * at once. Recovery is unchanged.
 */
export default function KeysPage() {
  const { address, snapshot, passkey, refresh } = useWallet();
  const signers = useMemo(() => snapshot?.signers ?? [], [snapshot]);
  const mine = signers.find(s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase());
  const iAmOwner = mine?.role === ROLE_OWNER;
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const [adding, setAdding] = useState<{ signerId: string; asset: string; amount: string } | null>(null);
  const [recoveryForm, setRecoveryForm] = useState<{ address: string; delayHours: string } | null>(null);
  const bio = useBiometric();

  // Assets an owner can set a limit on: what the wallet holds + the chain's defaults (ETH, USDC).
  const assetOpts = useMemo<AssetOpt[]>(() => {
    const out: AssetOpt[] = KNOWN_ASSETS.map(a => ({ address: a.address, symbol: a.symbol, decimals: a.decimals }));
    for (const a of snapshot?.portfolio.assets ?? [])
      if (!out.some(o => o.address.toLowerCase() === a.asset.toLowerCase()))
        out.push({ address: a.asset, symbol: a.symbol, decimals: a.decimals });
    return out;
  }, [snapshot]);

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

  const stage = (s: SignerInfo, asset: AssetOpt, limit: bigint) =>
    setStaged(st => ({
      ...st,
      [s.signerId]: { ...(st[s.signerId] ?? {}), [asset.address.toLowerCase()]: { asset, limit } },
    }));
  const unstage = (s: SignerInfo, asset: string) =>
    setStaged(st => {
      const next = { ...(st[s.signerId] ?? {}) };
      delete next[asset.toLowerCase()];
      return { ...st, [s.signerId]: next };
    });
  const stagedFor = (s: SignerInfo) => Object.values(staged[s.signerId] ?? {});

  const saveLimits = (s: SignerInfo) => {
    const changes = stagedFor(s);
    if (!changes.length) return;
    const ops: AdminOp[] = changes.map(c => ({
      op: "setLimit",
      signerId: s.signerId,
      asset: c.asset.address,
      limit: c.limit,
    }));
    const one = changes.length === 1 ? changes[0] : undefined;
    setPending({
      action: adminAction(address, ops, {
        assetSymbol: one?.asset.symbol,
        assetDecimals: one?.asset.decimals,
        labels: { [s.signerId]: nameOf(s) },
      }),
      title: one
        ? one.limit === 0n
          ? `Remove ${nameOf(s)}'s ${one.asset.symbol} limit`
          : `Limit ${nameOf(s)} to ${fmtAmount(one.limit, one.asset.decimals, one.asset.symbol)}/day`
        : `Update ${changes.length} limits for ${nameOf(s)}`,
      rows: [
        { label: "Key", value: nameOf(s) },
        ...changes.map(c => ({
          label: c.asset.symbol,
          value: c.limit === 0n ? "removed" : `${fmtAmount(c.limit, c.asset.decimals)} / day`,
          mono: true,
        })),
      ],
    });
  };
  const setRole = (s: SignerInfo, role: number) =>
    setPending({
      action: { fn: "metaUpdateSigner", targetSignerId: s.signerId, role, label: nameOf(s) },
      title: role === ROLE_OWNER ? `Make ${nameOf(s)} an owner` : `Make ${nameOf(s)} a spender`,
      rows: [
        { label: "Key", value: nameOf(s) },
        { label: "Role", value: role === ROLE_OWNER ? "Owner · no limit" : "Spender · per-asset limits" },
      ],
    });
  const remove = (s: SignerInfo) =>
    setPending({
      action: { fn: "metaRemoveSigner", targetSignerId: s.signerId, label: nameOf(s) },
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

  const owners = useMemo(() => signers.filter(s => s.role === ROLE_OWNER).length, [signers]);

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
              const st = staged[s.signerId] ?? {};
              const changes = stagedFor(s);
              // current limits merged with staged edits (staged wins; staged 0 = removal)
              const rows = [
                ...s.limits.map(l => ({
                  asset: l.asset,
                  symbol: l.symbol,
                  decimals: l.decimals,
                  limit: st[l.asset.toLowerCase()]?.limit ?? BigInt(l.limit),
                  remaining: BigInt(l.remaining),
                  stagedChange: st[l.asset.toLowerCase()] !== undefined,
                })),
                ...changes
                  .filter(c => !s.limits.some(l => l.asset.toLowerCase() === c.asset.address.toLowerCase()))
                  .map(c => ({
                    asset: c.asset.address,
                    symbol: c.asset.symbol,
                    decimals: c.asset.decimals,
                    limit: c.limit,
                    remaining: c.limit,
                    stagedChange: true,
                  })),
              ];
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
                    <span className={`chip ${s.role === ROLE_OWNER ? "chip-dark" : ""}`}>
                      {s.role === ROLE_OWNER
                        ? "Owner"
                        : `Spender · ${s.limits.length} limit${s.limits.length === 1 ? "" : "s"}`}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-3 pl-[56px] text-sm flex flex-col gap-2">
                      <div className="mono text-xs text-muted break-all">{s.signerId}</div>
                      {s.role !== ROLE_OWNER && (
                        <div className="rounded-2xl bg-paper divide-y divide-line">
                          {rows.length === 0 && (
                            <div className="px-3 py-2.5 text-muted">
                              No limits yet: this key cannot move anything until an owner sets one.
                            </div>
                          )}
                          {rows.map(r => (
                            <div key={r.asset} className="flex items-center gap-2 px-3 py-2.5">
                              <div className="min-w-0 flex-1">
                                <div className={`font-semibold ${r.limit === 0n ? "line-through text-muted" : ""}`}>
                                  {fmtAmount(r.limit, r.decimals, r.symbol)} / day
                                  {r.stagedChange && <span className="ml-2 chip chip-amber">unsaved</span>}
                                </div>
                                {!r.stagedChange && (
                                  <div className="text-muted text-xs">
                                    {fmtAmount(r.remaining, r.decimals, r.symbol)} left in this window
                                  </div>
                                )}
                              </div>
                              {iAmOwner && (
                                <>
                                  <button
                                    className="btn btn-white btn-xs"
                                    onClick={() =>
                                      setAdding({
                                        signerId: s.signerId,
                                        asset: r.asset,
                                        amount: fmtAmount(r.limit, r.decimals, undefined, r.decimals).replace(/,/g, ""),
                                      })
                                    }
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="w-8 h-8 rounded-full hover:bg-white flex items-center justify-center text-coral"
                                    aria-label="Remove limit"
                                    onClick={() =>
                                      r.stagedChange &&
                                      !s.limits.some(l => l.asset.toLowerCase() === r.asset.toLowerCase())
                                        ? unstage(s, r.asset)
                                        : stage(s, { address: r.asset, symbol: r.symbol, decimals: r.decimals }, 0n)
                                    }
                                  >
                                    <XIcon size={14} />
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {s.role !== ROLE_OWNER && iAmOwner && adding?.signerId === s.signerId && (
                        <div className="rounded-2xl border border-line p-3 flex flex-col gap-2">
                          <div className="flex gap-2">
                            <select
                              className="input flex-1"
                              value={adding.asset}
                              onChange={e => setAdding({ ...adding, asset: e.target.value })}
                            >
                              {assetOpts.map(a => (
                                <option key={a.address} value={a.address}>
                                  {a.symbol}
                                </option>
                              ))}
                            </select>
                            <input
                              className="input mono w-32"
                              inputMode="decimal"
                              placeholder="per day"
                              value={adding.amount}
                              onChange={e => setAdding({ ...adding, amount: e.target.value.replace(/[^\d.]/g, "") })}
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              className="btn btn-primary btn-xs"
                              onClick={() => {
                                const a = assetOpts.find(o => o.address.toLowerCase() === adding.asset.toLowerCase());
                                const u = a ? toUnits(adding.amount || "0", a.decimals) : null;
                                if (!a || u === null) return;
                                stage(s, a, u);
                                setAdding(null);
                              }}
                            >
                              Stage
                            </button>
                            <button className="btn btn-white btn-xs" onClick={() => setAdding(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      {iAmOwner && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {s.role !== ROLE_OWNER && (
                            <button
                              className="btn btn-white btn-xs"
                              onClick={() =>
                                setAdding({ signerId: s.signerId, asset: assetOpts[0]?.address ?? "", amount: "" })
                              }
                            >
                              <PlusIcon size={14} /> Add limit
                            </button>
                          )}
                          {changes.length > 0 && (
                            <button className="btn btn-primary btn-xs" onClick={() => saveLimits(s)}>
                              Save {changes.length === 1 ? "limit" : `${changes.length} limits`} with {bio}
                            </button>
                          )}
                          {s.role !== ROLE_OWNER ? (
                            <button className="btn btn-white btn-xs" onClick={() => setRole(s, ROLE_OWNER)}>
                              Make owner
                            </button>
                          ) : (
                            <button
                              className="btn btn-white btn-xs"
                              onClick={() => setRole(s, ROLE_SPENDER)}
                              disabled={owners <= 1}
                            >
                              Make spender
                            </button>
                          )}
                          <button
                            className="btn btn-white btn-xs text-coral"
                            onClick={() => remove(s)}
                            disabled={s.role === ROLE_OWNER && owners <= 1}
                          >
                            Remove key
                          </button>
                        </div>
                      )}
                      {!iAmOwner && mine && (
                        <div className="text-xs text-muted">Only an owner key can change keys and limits.</div>
                      )}
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

        {mine && mine.role !== ROLE_OWNER && (
          <div className="card p-5">
            <h3 className="font-bold text-[1.05rem]">Your {bio} limits</h3>
            {mine.limits.length ? (
              <div className="mt-2 divide-y divide-line">
                {mine.limits.map(l => (
                  <div key={l.asset} className="flex items-center justify-between py-2">
                    <span className="font-semibold">{l.symbol}</span>
                    <span className="mono text-sm">
                      {fmtAmount(l.remaining, l.decimals)} of {fmtAmount(l.limit, l.decimals)} left
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted text-sm mt-1">None yet. The device (owner) sets what {bio} may move per day.</p>
            )}
            <p className="text-muted text-sm mt-2">Above a limit, your device signs. Only an owner can raise it.</p>
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
            setStaged({});
            setRecoveryForm(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
