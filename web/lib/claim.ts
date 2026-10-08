import { type Address, type Hex, encodeFunctionData, getAddress, isHex, parseAbi } from "viem";

/**
 * Claim cards (docs/CLAIM.md): a private key printed as a QR, written to an NFC tag, or sent as a link, holding
 * USDC (and maybe ETH). The link is <origin>/pk#0x<key>, punk wallet's / the Burner Wallet paper wallets' format (no ERC
 * covers claim links); /claim#<key> works too. The key is after the `#`, so it never reaches a server or its logs.
 *
 * The card's key never needs gas: it signs two USDC EIP-3009 transfers (everything to the new wallet, the relay's
 * fee to the relay) and the relay submits both in one Multicall3 call. ETH on a card pays its own gas.
 */

export const usdc3009 = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
]);

export type ClaimAuth = {
  from: Address;
  to: Address;
  value: string; // 6 decimals
  validAfter: string;
  validBefore: string; // unix seconds
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
};

export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const claimUrl = (origin: string, key: Hex) => `${origin}/pk#${key}`;

/** The key in a claim link's fragment (with or without 0x), or null. */
export function claimKey(hash: string): Hex | null {
  const k = hash.replace(/^#/, "").replace(/^0x/i, "").trim();
  return /^[0-9a-f]{64}$/i.test(k) ? (`0x${k.toLowerCase()}` as Hex) : null;
}

/** Is this scanned text a claim link (ours or punk wallet's, on any host)? */
export function isClaimLink(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return /^\/(claim|pk)\/?$/.test(u.pathname) && !!claimKey(u.hash);
  } catch {
    return false;
  }
}

export function authCall(a: ClaimAuth): Hex {
  return encodeFunctionData({
    abi: usdc3009,
    functionName: "transferWithAuthorization",
    args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, a.v, a.r, a.s],
  });
}

export function validAuth(a: any): a is ClaimAuth {
  const h32 = (v: unknown) => typeof v === "string" && isHex(v) && v.length === 66;
  const num = (v: unknown) => typeof v === "string" && /^\d{1,78}$/.test(v);
  return (
    !!a &&
    typeof a.from === "string" &&
    typeof a.to === "string" &&
    num(a.value) &&
    num(a.validAfter) &&
    num(a.validBefore) &&
    h32(a.nonce) &&
    h32(a.r) &&
    h32(a.s) &&
    (a.v === 27 || a.v === 28)
  );
}
