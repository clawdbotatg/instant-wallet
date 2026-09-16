"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ActivityList } from "~~/components/ActivityList";
import { BalanceCard } from "~~/components/BalanceCard";
import {
  ChevronIcon,
  ChipIcon,
  FaceIdIcon,
  ReceiveIcon,
  SendIcon,
  SettingsIcon,
  SignerIcon,
} from "~~/components/Icons";
import { LogoLockup } from "~~/components/Logo";
import { SendPanel } from "~~/components/SendPanel";
import { useWallet } from "~~/components/WalletProvider";
import type { SignerInfo } from "~~/services/wallet";
import { labelFor } from "~~/utils/accounts";
import { api } from "~~/utils/api";
import { chainLabel, isLocal } from "~~/utils/chain";
import { fmtAmount, fmtUsd, greeting } from "~~/utils/format";
import { readName } from "~~/utils/settings";

/** "500 USDC + 0.1 ETH per day" for a spender, "no limit" for an owner. */
function limitsLine(s: SignerInfo): string {
  if (s.role === 1) return "no limit · adds and removes keys";
  if (!s.limits.length) return "spender · no limits yet";
  return `${s.limits.map(l => fmtAmount(l.limit, l.decimals, l.symbol)).join(" + ")} / day`;
}

export default function Home() {
  const { address, snapshot, loading, error, passkey, devices, refresh } = useWallet();
  const [name, setName] = useState("");
  const [hello, setHello] = useState("Hello");
  useEffect(() => {
    setName(readName());
    setHello(greeting());
  }, []);
  const signers = snapshot?.signers ?? [];
  const assets = snapshot?.portfolio.assets ?? [];
  const device = signers.find(s => s.kind === 1);
  const deviceOnline = devices.some(
    d => d.online && signers.some(s => s.signerId.toLowerCase() === d.signerId.toLowerCase()),
  );
  const mine = signers.find(s => passkey && s.signerId.toLowerCase() === passkey.signerId.toLowerCase());

  const keysLine = mine
    ? mine.role === 1
      ? device
        ? "Face ID and your device both own this account"
        : "Face ID owns this account · add a device for anything big"
      : `Face ID up to ${mine.limits.length ? mine.limits.map(l => fmtAmount(l.limit, l.decimals, l.symbol)).join(" + ") : "nothing"} per day · ${device ? "device for the rest" : "no device paired"}`
    : passkey
      ? "This passkey is not a signer here"
      : "No passkey on this browser · view only";

  return (
    <div className="max-w-[1180px] mx-auto">
      {/* mobile header */}
      <div className="lg:hidden flex items-center justify-between px-5 pt-5 pb-4">
        <LogoLockup />
        <Link
          href="/settings"
          className="w-11 h-11 rounded-full bg-white shadow-soft flex items-center justify-center"
          aria-label="Settings"
        >
          <SettingsIcon size={20} />
        </Link>
      </div>
      {/* desktop header */}
      <div className="hidden lg:flex items-center justify-between px-8 pt-8 pb-5">
        <h1 className="text-[2rem] font-bold">
          {hello}
          {name ? `, ${name}` : ""}
        </h1>
        <span className="chip bg-white text-ink shadow-soft">
          <span
            className={`w-2 h-2 rounded-full ${device ? (deviceOnline ? "bg-mint" : "bg-[#c9ccc9]") : "bg-mint"}`}
          />
          {device ? `Device ${deviceOnline ? "online" : "offline"} · ${chainLabel}` : chainLabel}
        </span>
      </div>

      <div className="lg:grid lg:grid-cols-[1fr_370px] lg:gap-6 lg:px-8">
        <div className="px-5 lg:px-0 flex flex-col gap-4">
          {error && !snapshot && <div className="rounded-2xl bg-coral-soft text-coral px-4 py-3 text-sm">{error}</div>}
          <BalanceCard
            totalUsd={snapshot?.portfolio.totalUsd ?? null}
            assetCount={assets.filter(a => BigInt(a.balance) > 0n).length}
            unpriced={assets.filter(a => a.usd === null && BigInt(a.balance) > 0n).map(a => a.symbol)}
            activity={snapshot?.activity ?? []}
          />

          {snapshot && !snapshot.deployed && (
            <div className="card p-4 flex items-center gap-3">
              <div className="icon-tile tile-mint">
                <ReceiveIcon size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold">Ready to receive</div>
                <p className="text-muted text-sm">
                  This address is yours on every chain. The contract appears on chain with your first send.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:hidden">
            <Link href={`/w/${address}/send`} className="btn btn-mint text-[1.05rem]">
              <SendIcon size={20} /> Send
            </Link>
            <Link href={`/w/${address}/receive`} className="btn btn-white text-[1.05rem]">
              <ReceiveIcon size={20} /> Receive
            </Link>
          </div>

          <div className="card p-5">
            <h3 className="font-bold text-[1.05rem] mb-1">Assets</h3>
            <div className="divide-y divide-line">
              {assets.map(a => (
                <Link
                  key={a.asset}
                  href={`/w/${address}/send?asset=${a.asset}`}
                  className="flex items-center gap-3 py-3"
                >
                  <div className="icon-tile tile-gray mono text-xs font-bold overflow-hidden">
                    {a.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.logo} alt="" className="w-full h-full object-cover" />
                    ) : (
                      a.symbol.slice(0, 3)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{a.symbol}</div>
                    <div className="text-muted text-sm truncate">{a.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="mono font-semibold">{fmtAmount(a.balance, a.decimals)}</div>
                    <div className="text-muted text-xs">{a.usd === null ? "no price" : fmtUsd(a.usd)}</div>
                  </div>
                </Link>
              ))}
              {assets.length === 0 && (
                <div className="text-muted text-sm py-3">{loading ? "Loading…" : "Nothing yet."}</div>
              )}
            </div>
          </div>

          <Link href={`/w/${address}/keys`} className="card p-4 flex items-center gap-3 lg:hidden">
            <div className="flex -space-x-1">
              <div className="icon-tile tile-mint">
                <FaceIdIcon size={22} />
              </div>
              <div className="icon-tile tile-gray">
                <ChipIcon size={22} />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold">{device ? "Face ID + your device" : "Face ID"}</div>
              <div className="text-muted text-sm">{keysLine}</div>
            </div>
            <ChevronIcon size={18} className="text-muted" />
          </Link>

          {isLocal && (
            <div className="flex gap-4 px-1 text-xs text-muted">
              <button className="text-left" onClick={() => api.fund(address, "100").then(refresh)}>
                Local chain: mint 100 test USDC
              </button>
              <button className="text-left" onClick={() => api.fund(address, "0.5", "ETH").then(refresh)}>
                send 0.5 test ETH
              </button>
            </div>
          )}

          <ActivityList items={snapshot?.activity ?? []} limit={4} showAll />
          {loading && !snapshot && <div className="text-center text-muted text-sm">Loading…</div>}
        </div>

        <div className="hidden lg:flex flex-col gap-6">
          <SendPanel variant="panel" />
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[1.05rem]">Keys</h3>
              <Link href={`/w/${address}/keys`} className="text-mint-dark font-semibold text-sm">
                Manage
              </Link>
            </div>
            <div className="divide-y divide-line">
              {signers.map(s => {
                const label =
                  labelFor(address, s.signerId) ?? s.label ?? (s.kind === 1 ? "Instant Wallet device" : "Passkey");
                return (
                  <div key={s.signerId} className="flex items-center gap-3 py-3">
                    <div className={`icon-tile ${s.kind === 1 ? "tile-gray" : "tile-mint"}`}>
                      <SignerIcon kind={s.kind} label={label} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{label}</div>
                      <div className="text-muted text-sm">{limitsLine(s)}</div>
                    </div>
                  </div>
                );
              })}
              {signers.length === 0 && <div className="text-muted text-sm py-3">No keys yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
