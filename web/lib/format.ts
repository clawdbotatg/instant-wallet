export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 1 && v > 0 ? 4 : 2 });
}

export function amount(formatted: string, max = 6): string {
  const n = Number(formatted);
  if (!Number.isFinite(n)) return formatted;
  if (n === 0) return "0";
  if (n < 10 ** -max) return `<${(10 ** -max).toFixed(max)}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : max });
}

/** A relay fee in words, dollars beside the coin: "0.00004 ETH ($0.15)" or "0.03 USDC". The quote's feeUsdc is the
 * same fee in dollars (the relay prices it), so no other price is needed. */
export function feeText(fee: { feeUsdc: string | bigint; feeEth: string | bigint }, token: "usdc" | "eth", coin: string): string {
  const dollars = Number(BigInt(fee.feeUsdc)) / 1e6;
  if (token === "usdc") return `${amount(String(dollars))} USDC`;
  return `${amount(String(Number(BigInt(fee.feeEth)) / 1e18))} ${coin} (${usd(dollars)})`;
}
