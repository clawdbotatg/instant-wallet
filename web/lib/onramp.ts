import { type Address, type Hex, keccak256, toBytes } from "viem";

/** What the passkey signs to ask /api/onramp for a Coinbase Pay link: this wallet, this asset, now. */
export const onrampChallenge = (address: Address, asset: "USDC" | "ETH", ts: number): Hex =>
  keccak256(toBytes(`instant-wallet onramp ${address.toLowerCase()} ${asset} ${ts}`));
