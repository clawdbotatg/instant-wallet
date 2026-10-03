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

export type Portfolio = { totalUsd: number | null; assets: Asset[] };

/** This device's wallet: the passkey and the address it owns (same on every chain). */
export type Account = {
  credentialId: string; // base64url
  credentialIdHash: Hex;
  qx: Hex;
  qy: Hex;
  signerId: Address;
  address: Address;
};
