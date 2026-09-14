"use client";

import { useEffect, useState } from "react";
import { ActivityList } from "~~/components/ActivityList";
import { PageHeader } from "~~/components/AppShell";
import { useWallet } from "~~/components/WalletProvider";
import type { WalletRequest } from "~~/services/types";
import { api } from "~~/utils/api";
import { timeAgo, usd } from "~~/utils/format";

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
  const decimals = snapshot?.token.decimals ?? 6;
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
                    <div className="font-semibold">
                      {r.kind === "transfer"
                        ? `Send ${usd(r.amount, decimals)} to ${r.toName ?? r.to.slice(0, 10) + "…"}`
                        : r.kind}
                    </div>
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
