/**
 * What a DexScreener pair really holds, in dollars. Its own `liquidity.usd` prices the token side at the pool's own
 * price, so a broken pool looks deep: 0.0048 wstETH and a speck of WETH read as $641,726 once six trades had set
 * wstETH at $133M there. The quote side (WETH, USDC: money priced elsewhere) can't be faked that way, so a pool is
 * worth at most twice its quote side.
 */
export function poolUsd(p: any): number {
  const all = Number(p?.liquidity?.usd) || 0;
  const quoteUsd = (Number(p?.liquidity?.quote) || 0) * ((Number(p?.priceUsd) || 0) / (Number(p?.priceNative) || Infinity));
  return Math.min(all, quoteUsd * 2);
}
