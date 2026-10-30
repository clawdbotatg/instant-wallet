/** ETH in dollars, from the browser (Coinbase), once per page. 0: not known. */
let ethPrice = 0;
export async function ethUsd(): Promise<number> {
  if (ethPrice) return ethPrice;
  const j = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot").then(r => r.json()).catch(() => null);
  return (ethPrice = Number(j?.data?.amount) || 0);
}
