import { type Address, getAddress, isAddress } from "viem";
import { ETH, chainByShort } from "./chains";

/**
 * What a scanned QR, a pasted string or a link means, in punk wallet's order:
 *   wc:…                                WalletConnect pairing
 *   ethereum:0x…[@chain][/transfer?address=…&uint256=…][?value=…]   EIP-681
 *   https://<anything>/<path>           the path, parsed as below (so punkwallet.io and our links work)
 *   [net:]0xADDR[;amount]               our / punk wallet's link format (amount in the chain's native token)
 *   0xADDR · name.eth                   a recipient
 */
export type Parsed =
  | { kind: "wc"; uri: string }
  | {
      kind: "pay";
      to: string; // 0x address or ENS name
      chainId?: number;
      asset?: Address; // ETH = 0x0
      amount?: string; // human units, when the asset's decimals are known (ETH)
      amountBase?: bigint; // base units (EIP-681 uint256 for tokens)
    }
  | { kind: "unknown"; text: string };

const ENS = /^[^\s/:;]+\.[a-z]{2,}$/i;

function bigFrom(v: string): bigint | undefined {
  try {
    if (/^\d+$/.test(v)) return BigInt(v);
    const m = v.match(/^(\d+(?:\.\d+)?)e(\d+)$/i); // 1.5e18
    if (m) {
      const [int, frac = ""] = m[1].split(".");
      const exp = Number(m[2]) - frac.length;
      return exp >= 0 ? BigInt(int + frac) * 10n ** BigInt(exp) : undefined;
    }
  } catch {}
  return undefined;
}

function eip681(s: string): Parsed {
  // ethereum:[pay-]<target>[@chainId][/function][?params]
  const m = s.match(/^ethereum:(?:pay-)?([^@/?]+)(?:@(\d+))?(?:\/([^?]+))?(?:\?(.*))?$/i);
  if (!m) return { kind: "unknown", text: s };
  const [, target, chain, fn, query] = m;
  const q = new URLSearchParams(query || "");
  const chainId = chain ? Number(chain) : undefined;
  if (fn === "transfer") {
    const to = q.get("address") || "";
    const amt = q.get("uint256");
    if (!isAddress(target)) return { kind: "unknown", text: s };
    return { kind: "pay", to, chainId, asset: getAddress(target), amountBase: amt ? bigFrom(amt) : undefined };
  }
  const value = q.get("value");
  return { kind: "pay", to: target, chainId, asset: ETH, amountBase: value ? bigFrom(value) : undefined };
}

function pathForm(s: string): Parsed {
  let rest = s.replace(/^\/+/, "");
  let chainId: number | undefined;
  const net = rest.match(/^([a-z0-9-]+):(.*)$/i);
  if (net && !/^0x/i.test(net[1])) {
    chainId = chainByShort(net[1])?.id;
    rest = net[2];
  }
  const [to, amount] = rest.split(";");
  if (!isAddress(to) && !ENS.test(to)) return { kind: "unknown", text: s };
  return { kind: "pay", to: isAddress(to) ? getAddress(to) : to, chainId, asset: amount ? ETH : undefined, amount: amount || undefined };
}

export function parse(input: string): Parsed {
  const s = input.trim();
  if (/^wc:/i.test(s)) return { kind: "wc", uri: s };
  if (/^ethereum:/i.test(s)) return eip681(s);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const wc = u.searchParams.get("uri");
      if (wc && /^wc:/i.test(wc)) return { kind: "wc", uri: wc };
      const path = decodeURIComponent(u.pathname + u.hash.replace(/^#/, ""));
      if (/^\/?ethereum:/i.test(path)) return eip681(path.replace(/^\//, ""));
      return pathForm(path);
    } catch {
      return { kind: "unknown", text: s };
    }
  }
  if (/^[a-z0-9-]+:0x/i.test(s) || /;/.test(s)) return pathForm(s);
  if (isAddress(s)) return { kind: "pay", to: getAddress(s) };
  if (ENS.test(s)) return { kind: "pay", to: s.toLowerCase() };
  return { kind: "unknown", text: s };
}

/**
 * An EIP-681 payment request, what MetaMask, Rainbow, Coinbase Wallet and our own scanner read:
 *   ethereum:<to>@<chainId>?value=<wei>                                   ETH
 *   ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<base units>  a token
 */
export function requestUri(to: Address, chainId: number, asset: Address | "eth", base: bigint): string {
  return asset === "eth"
    ? `ethereum:${to}@${chainId}?value=${base}`
    : `ethereum:${asset}@${chainId}/transfer?address=${to}&uint256=${base}`;
}
