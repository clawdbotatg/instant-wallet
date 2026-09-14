"use client";

import Link from "next/link";
import { ArrowDownLeftIcon, ArrowUpRightIcon, KeyIcon, ShieldIcon, SparkIcon } from "./Icons";
import { useWallet } from "./WalletProvider";
import type { ActivityItem, SignerInfo } from "~~/services/wallet";
import { labelFor } from "~~/utils/accounts";
import { explorerTxUrl, hasExplorer } from "~~/utils/chain";
import { shortAddr, timeAgo, usd } from "~~/utils/format";

export function signerLabel(wallet: string, signers: SignerInfo[], signerId?: string): string {
  if (!signerId) return "";
  const local = labelFor(wallet, signerId);
  if (local) return local;
  const s = signers.find(x => x.signerId.toLowerCase() === signerId.toLowerCase());
  if (s?.label) return s.label;
  if (s?.kind === 1) return "the device";
  if (s) return "a passkey";
  return shortAddr(signerId);
}

function describe(item: ActivityItem, wallet: string, signers: SignerInfo[], decimals: number) {
  const by = signerLabel(wallet, signers, item.signerId);
  const when = timeAgo(item.timestamp);
  switch (item.type) {
    case "received":
      return {
        title: `Received ${usd(item.amount ?? 0, decimals)}`,
        sub: `from ${shortAddr(item.from)} · ${when}`,
        amt: `+${usd(item.amount ?? 0, decimals)}`,
        tone: "mint" as const,
        Icon: ArrowDownLeftIcon,
      };
    case "sent":
      return {
        title: `Sent ${usd(item.amount ?? 0, decimals)} to ${shortAddr(item.to)}`,
        sub: `signed with ${by} · ${when}`,
        amt: `−${usd(BigInt(item.amount ?? 0) + BigInt(item.fee ?? 0), decimals)}`,
        tone: "gray" as const,
        Icon: ArrowUpRightIcon,
      };
    case "executed":
      return {
        title: `Executed ${item.calls} call${item.calls === 1 ? "" : "s"}`,
        sub: `signed with ${by} · ${when}`,
        amt: "",
        tone: "gray" as const,
        Icon: SparkIcon,
      };
    case "keyAdded":
      return {
        title: `Added key: ${by}`,
        sub: `${item.detail} · ${when}`,
        amt: "",
        tone: "gray" as const,
        Icon: KeyIcon,
      };
    case "keyUpdated":
      return {
        title: `Updated key: ${by}`,
        sub: `${item.detail?.startsWith("owner") ? "owner" : `spender · ${usd(item.amount ?? 0, decimals)}/day`} · ${when}`,
        amt: "",
        tone: "gray" as const,
        Icon: KeyIcon,
      };
    case "keyRemoved":
      return {
        title: `Removed key ${shortAddr(item.signerId)}`,
        sub: when,
        amt: "",
        tone: "gray" as const,
        Icon: KeyIcon,
      };
    case "recoverySet":
      return {
        title: `Recovery address set`,
        sub: `${shortAddr(item.to)} · ${item.detail} · ${when}`,
        amt: "",
        tone: "gray" as const,
        Icon: ShieldIcon,
      };
    case "recoveryStarted":
      return { title: `Recovery started`, sub: when, amt: "", tone: "gray" as const, Icon: ShieldIcon };
  }
}

export function ActivityList({ items, limit, showAll }: { items: ActivityItem[]; limit?: number; showAll?: boolean }) {
  const { address, snapshot } = useWallet();
  const signers = snapshot?.signers ?? [];
  const decimals = snapshot?.token.decimals ?? 6;
  const list = limit ? items.slice(0, limit) : items;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-[1.05rem]">Activity</h3>
        {showAll && items.length > (limit ?? 0) && (
          <Link href={`/w/${address}/activity`} className="text-mint-dark font-semibold text-sm">
            See all
          </Link>
        )}
      </div>
      {list.length === 0 ? (
        <div className="text-muted text-sm py-6 text-center">
          Nothing yet. Receive some {snapshot?.token.symbol ?? "USDC"} to get started.
        </div>
      ) : (
        <div>
          {list.map((item, i) => {
            const d = describe(item, address, signers, decimals);
            const Icon = d.Icon;
            const row = (
              <div className="flex items-center gap-3 py-3">
                <div className={`icon-tile ${d.tone === "mint" ? "tile-mint" : "tile-gray"}`}>
                  <Icon size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{d.title}</div>
                  <div className="text-muted text-sm truncate">{d.sub}</div>
                </div>
                {d.amt && (
                  <div className="text-right">
                    <div className="mono font-semibold">{d.amt}</div>
                    <div className="text-muted text-xs">confirmed</div>
                  </div>
                )}
              </div>
            );
            return (
              <div key={item.id} className={i ? "border-t border-line" : ""}>
                {hasExplorer ? (
                  <a href={explorerTxUrl(item.txHash)} target="_blank" rel="noreferrer">
                    {row}
                  </a>
                ) : (
                  row
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
