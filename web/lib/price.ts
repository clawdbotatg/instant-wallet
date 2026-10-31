import { nativeSymbol } from "@/lib/chains";

/** ETH in dollars, from the browser (Coinbase), once per page. 0: not known. */
let ethPrice = 0;
export async function ethUsd(): Promise<number> {
  if (ethPrice) return ethPrice;
  const j = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot").then(r => r.json()).catch(() => null);
  return (ethPrice = Number(j?.data?.amount) || 0);
}

/** Any chain's native coin in dollars (ETH, POL, BNB, …), once per chain per page. 0: not known. */
const native = new Map<number, Promise<number>>();
export function nativeUsd(chainId: number): Promise<number> {
  if (nativeSymbol(chainId) === "ETH") return ethUsd();
  if (!native.has(chainId))
    native.set(chainId, fetch(`/api/price?chain=${chainId}`).then(r => r.json()).then(j => Number(j?.usd) || 0, () => 0));
  return native.get(chainId)!;
}
