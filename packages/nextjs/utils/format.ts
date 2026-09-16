import { formatUnits, parseUnits } from "viem";

export function shortAddr(a?: string | null, head = 6, tail = 4): string {
  if (!a) return "";
  return a.length > head + tail + 2 ? `${a.slice(0, head)}…${tail ? a.slice(-tail) : ""}` : a;
}

/** "2,847.13" from base units. */
export function money(units: bigint | string | number, decimals = 6, fractionDigits = 2): string {
  const v = typeof units === "bigint" ? units : BigInt(units || 0);
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

export function usd(units: bigint | string | number, decimals = 6): string {
  return `$${money(units, decimals)}`;
}

/** Split "2,847.13" into ["2,847", "13"] for the big/small rendering. */
export function moneyParts(units: bigint | string | number, decimals = 6): [string, string] {
  const [i, f] = money(units, decimals).split(".");
  return [i, f ?? "00"];
}

export function toUnits(amount: string, decimals = 6): bigint | null {
  try {
    const clean = amount.trim().replace(/[$,]/g, "");
    if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") return null;
    return parseUnits(clean, decimals);
  } catch {
    return null;
  }
}

export function timeAgo(tsSeconds: number): string {
  if (!tsSeconds) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(tsSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dateShort(tsSeconds: number): string {
  if (!tsSeconds) return "";
  return new Date(tsSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function durationLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * Asset amount from base units: "2,847.13 USDC", "0.0500 ETH". Stable-looking assets (6 decimals)
 * show 2 places, everything else up to `maxFrac` significant places with trailing zeros trimmed.
 */
export function fmtAmount(
  units: bigint | string | number,
  decimals: number,
  symbol?: string,
  maxFrac?: number,
): string {
  const v = typeof units === "bigint" ? units : BigInt(units || 0);
  const s = formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  const frac = maxFrac ?? (decimals <= 6 ? 2 : 6);
  let out: string;
  if (decimals <= 6) {
    out = `${Number(i).toLocaleString("en-US")}.${(f + "00").slice(0, 2)}`;
  } else {
    const n = Number(s);
    out =
      n === 0
        ? "0"
        : n < 1
          ? n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: Math.max(frac, 8) })
          : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  return symbol ? `${out} ${symbol}` : out;
}

/** "$1,234.56" from a float; null/NaN -> "—". */
export function fmtUsd(v: number | null | undefined, fractionDigits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}

/** Split a USD float into ["1,234", "56"]. */
export function usdParts(v: number | null | undefined): [string, string] {
  const [i, f] = fmtUsd(v ?? 0)
    .slice(1)
    .split(".");
  return [i, f ?? "00"];
}

/** USD value of `units` of an asset priced at `price` (null when unpriced). */
export function usdValue(units: bigint | string, decimals: number, price: number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  return Number(formatUnits(typeof units === "bigint" ? units : BigInt(units || 0), decimals)) * price;
}
