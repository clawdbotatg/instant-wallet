"use client";

import { useMemo, useState } from "react";
import type { ActivityItem } from "~~/services/wallet";
import { chainLabel } from "~~/utils/chain";
import { moneyParts, usd } from "~~/utils/format";

const RANGES = ["1D", "1W", "1M", "1Y", "All"] as const;
const RANGE_SECONDS: Record<(typeof RANGES)[number], number> = {
  "1D": 86400,
  "1W": 7 * 86400,
  "1M": 30 * 86400,
  "1Y": 365 * 86400,
  All: Infinity,
};

/** Balance history reconstructed from activity: walk back from the current balance. */
function series(balance: bigint, activity: ActivityItem[], windowS: number): { t: number; v: bigint }[] {
  const now = Math.floor(Date.now() / 1000);
  const sorted = [...activity].filter(a => a.timestamp > 0).sort((a, b) => b.timestamp - a.timestamp);
  const pts: { t: number; v: bigint }[] = [{ t: now, v: balance }];
  let v = balance;
  for (const a of sorted) {
    if (a.type === "sent") v += BigInt(a.amount ?? 0) + BigInt(a.fee ?? 0);
    else if (a.type === "received") v -= BigInt(a.amount ?? 0);
    else continue;
    pts.push({ t: a.timestamp, v });
  }
  const cutoff = windowS === Infinity ? 0 : now - windowS;
  const inWindow = pts.filter(p => p.t >= cutoff);
  const older = pts.find(p => p.t < cutoff);
  if (older) inWindow.push({ t: cutoff, v: older.v });
  else if (inWindow.length === pts.length && pts.length)
    inWindow.push({
      t: Math.min(cutoff || pts[pts.length - 1].t - 3600, pts[pts.length - 1].t - 3600),
      v: pts[pts.length - 1].v,
    });
  return inWindow.sort((a, b) => a.t - b.t);
}

function Chart({
  points,
  height = 120,
  width = 600,
}: {
  points: { t: number; v: bigint }[];
  height?: number;
  width?: number;
}) {
  if (points.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-full">
        <line x1="0" y1={height * 0.55} x2={width} y2={height * 0.55} stroke="#22c452" strokeWidth="2.5" />
      </svg>
    );
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t || t0 + 1;
  const vs = points.map(p => Number(p.v));
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || Math.max(1, max * 0.1);
  const pad = 10;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * width;
  const y = (v: number) => height - pad - ((v - (min - span * 0.15)) / (span * 1.4)) * (height - pad * 2);
  // step-ish path: balances change instantly, but a gentle line reads better
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(Number(p.v)).toFixed(1)}`).join(" ");
  const area = `${d} L${width},${height} L0,${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-full">
      <defs>
        <linearGradient id="bal-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c452" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#22c452" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#bal-fill)" />
      <path
        d={d}
        fill="none"
        stroke="#22c452"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function BalanceCard({
  balance,
  decimals,
  symbol,
  activity,
  compact = false,
}: {
  balance: bigint;
  decimals: number;
  symbol: string;
  activity: ActivityItem[];
  compact?: boolean;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("1M");
  const pts = useMemo(() => series(balance, activity, RANGE_SECONDS[range]), [balance, activity, range]);
  const todayDelta = useMemo(() => {
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    let d = 0n;
    for (const a of activity) {
      if (a.timestamp < cutoff) continue;
      if (a.type === "received") d += BigInt(a.amount ?? 0);
      if (a.type === "sent") d -= BigInt(a.amount ?? 0) + BigInt(a.fee ?? 0);
    }
    return d;
  }, [activity]);
  const [int, frac] = moneyParts(balance, decimals);
  const up = todayDelta >= 0n;

  return (
    <div
      className={`relative overflow-hidden rounded-[24px] bg-ink-2 text-white ${compact ? "h-[220px]" : "h-[240px] lg:h-[290px]"}`}
    >
      <div className="absolute inset-x-0 bottom-0 h-[52%]">
        <Chart points={pts} />
      </div>
      <div className="relative p-5 lg:p-7">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[13px] text-[#a3a6a3]">Total balance</div>
            <div className="mono font-bold leading-none mt-1 text-[2.55rem] lg:text-[3.6rem] tracking-tight">
              ${int}
              <span className="text-[1.5rem] lg:text-[2.2rem]">.{frac}</span>
            </div>
            <div
              className={`mt-2 text-[13px] font-semibold flex items-center gap-1 ${up ? "text-mint" : "text-coral"}`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {up ? <path d="M7 17 17 7M8 7h9v9" /> : <path d="M17 7 7 17M16 17H7V8" />}
              </svg>
              {up ? "+" : "−"}
              {usd(todayDelta < 0n ? -todayDelta : todayDelta, decimals)} today · {symbol} on {chainLabel}
            </div>
          </div>
          {compact ? (
            <span className="chip chip-dark bg-[#2a2b2a] text-white">
              <span className="w-2 h-2 rounded-full bg-mint" />
              {chainLabel} · {symbol}
            </span>
          ) : (
            <div className="hidden lg:flex gap-1.5">
              {RANGES.map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`h-8 px-3 rounded-full text-xs font-bold ${range === r ? "bg-white text-ink" : "bg-[#2a2b2a] text-[#c9ccc9]"}`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          {!compact && (
            <span className="lg:hidden chip chip-dark bg-[#2a2b2a] text-white">
              <span className="w-2 h-2 rounded-full bg-mint" />
              {chainLabel} · {symbol}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
