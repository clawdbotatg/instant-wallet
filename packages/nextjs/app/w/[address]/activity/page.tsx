"use client";

import { useEffect, useState } from "react";
import { ActivityList } from "~~/components/ActivityList";
import { PageHeader } from "~~/components/AppShell";
import { useWallet } from "~~/components/WalletProvider";
import type { WalletRequest } from "~~/services/types";
import { api } from "~~/utils/api";
import { fmtAmount, shortAddr, timeAgo } from "~~/utils/format";

/** One line per queued request, by kind (docs/PROTOCOL.md section 5 shapes). */
function describeRequest(r: WalletRequest): string {
  switch (r.kind) {
    case "transfer":
      return `Send ${fmtAmount(r.amount, r.assetDecimals ?? 18, r.assetSymbol)} to ${r.toName ?? shortAddr(r.to)}`;
    case "execute":
      return `Execute ${r.calls.length} call${r.calls.length === 1 ? "" : "s"}`;
    case "addSigner":
      return `Add key ${r.label ?? shortAddr(r.qx, 8, 0)} as ${r.role === 1 ? "owner" : "spender"}`;
    case "updateSigner":
      return `Make ${r.label ?? shortAddr(r.targetSignerId)} ${r.role === 1 ? "an owner" : "a spender"}`;
    case "setLimit":
      return BigInt(r.limit) === 0n
        ? `Remove ${r.assetSymbol} limit for ${r.label ?? shortAddr(r.targetSignerId)}`
        : `Limit ${r.label ?? shortAddr(r.targetSignerId)} to ${fmtAmount(r.limit, r.assetDecimals, r.assetSymbol)}/day`;
    case "removeSigner":
      return `Remove key ${r.label ?? shortAddr(r.targetSignerId)}`;
    case "setRecovery":
      return `Set recovery to ${shortAddr(r.recoveryAddress)}`;
    case "cancelRecovery":
      return "Cancel recovery";
    default:
      return (r as any).kind;
  }
}

export default function ActivityPage() {
  const { address, snapshot } = useWallet();
  const [requests, setRequests] = useState<WalletRequest[]>([]);
  useEffect(() => {
    const load = () =>
      api
        .requests(address)
        .then(r => setRequests(r.requests))
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [address]);
  const queue = requests.filter(r => r.status !== "confirmed").slice(0, 10);
  return (
    <div className="max-w-2xl mx-auto lg:pt-8">
      <PageHeader title="Activity" back={`/w/${address}`} desktop />
      <div className="px-5 flex flex-col gap-4">
        {queue.length > 0 && (
          <div className="card p-5">
            <h3 className="font-bold text-[1.05rem] mb-2">Device queue</h3>
            <div className="divide-y divide-line">
              {queue.map(r => (
                <div key={r.id} className="py-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{describeRequest(r)}</div>
                    <div className="text-muted text-sm break-words">
                      {timeAgo(Math.floor(r.createdAt / 1000))} · match code <span className="mono">{r.matchCode}</span>
                      {r.error ? ` · ${r.error.length > 140 ? r.error.slice(0, 140) + "…" : r.error}` : ""}
                    </div>
                  </div>
                  <span
                    className={`chip ${r.status === "pending" ? "chip-amber" : r.status === "failed" || r.status === "rejected" || r.status === "expired" ? "bg-coral-soft text-coral" : ""}`}
                  >
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <ActivityList items={snapshot?.activity ?? []} />
      </div>
    </div>
  );
}
