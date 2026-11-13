export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 0.01 && v > 0 ? 4 : 2 });
}

/** A day and a time, the same wherever a deadline shows: "Nov 12, 3:04 PM" (Activity's day, plus the time). */
export const when = (at: string | number | Date) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Rough dollars, short: "$1.2K". */
export const compactUsd = (v: number) => "$" + v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });

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
  return feeWords(token === "usdc" ? dollars : Number(BigInt(fee.feeEth)) / 1e18, token === "usdc" ? "USDC" : coin, dollars);
}

/** A fee, the same wherever one shows: the coin, then dollars: "0.03 USDC ($0.03)", "0.00004 ETH ($0.15)". */
export function feeWords(n: number, symbol: string, dollars?: number | null): string {
  const coin = symbol === "USDC" && n >= 0.01 ? n.toFixed(2) : amount(String(n));
  return `${coin} ${symbol}${dollars === null || dollars === undefined ? "" : ` (${usd(dollars)})`}`;
}

/**
 * What an address box keeps: the one address in the text, whatever is around it ("0x12…ef." · "to: 0x12…ef)" ·
 * spaces). No address, two different ones, or a longer hex (a tx hash): the text as typed. A name is never cut:
 * a label that is an address (0x12…ef.eth, 0x12…ef.atg.eth) stays whole.
 */
export function addressIn(text: string): string {
  const found = new Set<string>();
  let one = "";
  for (const m of text.matchAll(/(?:^|[^0-9a-z])(0x[0-9a-f]{40})(?![0-9a-z]|[-_0-9a-z]*\.[0-9a-z])/gi)) {
    one = "0x" + m[1].slice(2);
    found.add(one.toLowerCase());
  }
  return found.size === 1 ? one : text;
}

/** The same for a box that takes a name too: "atg.eth." and "(atg.eth)" are atg.eth. Use it on read, not on each key. */
export const nameIn = (text: string) => addressIn(text).replace(/^[\s.,;:!?"'`()<>[\]{}]+|[\s.,;:!?"'`()<>[\]{}]+$/g, "");
