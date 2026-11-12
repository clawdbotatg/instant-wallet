import { nativeSymbol } from "@/lib/chains";

/** ETH in dollars, from our price server (it asked Coinbase from the browser: one more host that saw every review
 * screen), once per page. 0: not known. */
let ethPrice = 0;
export async function ethUsd(): Promise<number> {
  if (ethPrice) return ethPrice;
  const j = await fetch("/api/price?chain=1").then(r => r.json()).catch(() => null);
  return (ethPrice = Number(j?.usd) || 0);
}

/** Any chain's native coin in dollars (ETH, POL, BNB, …), once per chain per page. 0: not known. */
const native = new Map<number, Promise<number>>();
export function nativeUsd(chainId: number): Promise<number> {
  if (nativeSymbol(chainId) === "ETH") return ethUsd();
  if (!native.has(chainId))
    native.set(chainId, fetch(`/api/price?chain=${chainId}`).then(r => r.json()).then(j => Number(j?.usd) || 0, () => 0));
  return native.get(chainId)!;
}

/** Tokens in dollars, by address (lowercase), from our price server. A token with no price is left out. */
export async function tokensUsd(chainId: number, tokens: string[]): Promise<Record<string, number>> {
  if (!tokens.length) return {};
  const j = await fetch(`/api/price?chain=${chainId}&tokens=${tokens.join(",")}`).then(r => r.json()).catch(() => null);
  return j?.usd ?? {};
}
