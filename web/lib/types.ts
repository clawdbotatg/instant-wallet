import type { Address, Hex } from "viem";

export type Asset = {
  chainId: number;
  asset: Address; // 0x000…0 = ETH
  symbol: string;
  name: string;
  decimals: number;
  balance: string; // base units
  formatted: string;
  price: number | null;
  usd: number | null;
  logo?: string;
};

export type Portfolio = { totalUsd: number | null; assets: Asset[]; late?: number[] }; // late: chains that didn't answer in time (left out)

/** A new read, with the rows of its late chains kept from the last one (so a slow chain doesn't blink out of the total). */
export function keepLate(next: Portfolio, prev: Portfolio | null): Portfolio {
  if (!next.late?.length || !prev) return next;
  const kept = prev.assets.filter(a => next.late!.includes(a.chainId));
  const assets = [...next.assets, ...kept].sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1));
  return { totalUsd: (next.totalUsd ?? 0) + kept.reduce((t, a) => t + (a.usd ?? 0), 0), assets, late: next.late };
}

/** This device's wallet: the passkey and the address it owns (same on every chain). */
export type Account = {
  credentialId: string; // base64url
  credentialIdHash: Hex;
  qx: Hex;
  qy: Hex;
  signerId: Address;
  address: Address;
};

export type Nft = {
  chainId: number;
  contract: Address;
  tokenId: string;
  type: string; // ERC721 | ERC1155
  balance: string;
  name: string;
  collection: string;
  thumb: string;
  image: string;
};

/** A DeFi position (Zerion): one pool / vault / stake, its tokens summed. */
export type Position = {
  id: string;
  chainId: number;
  name: string; // "Venice sVVV Pool"
  protocol: string;
  type: string; // deposit | staked | reward | loan, the biggest part's
  usd: number; // loans count against it
  tokens: string[];
  receipts?: string[]; // tokens the wallet holds for this position on its chain (aBasUSDC), lowercase addresses
  icon?: string;
  url?: string;
};
