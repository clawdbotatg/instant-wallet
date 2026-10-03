import { type Hex, createWalletClient, http, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainById, rpcPath } from "./chains";
import { loadGasKey, saveGasKey } from "./store";

/**
 * The gas key: a plain secp256k1 key that submits this wallet's signed calls and pays their gas. It holds a
 * little ETH and nothing else; it can't move the wallet's money (every call carries a passkey or wedgie
 * signature). Derived from the passkey's PRF output where the platform gives one (same key on every device
 * the passkey syncs to), otherwise random and kept in this browser. Once set it is never replaced.
 */

export function gasKeyFromPrf(prf: Uint8Array): Hex {
  return keccak256(new Uint8Array([...new TextEncoder().encode("instant-wallet/gas/"), ...prf]));
}

/** Remember a gas key for this wallet (PRF-derived wins only if none is stored yet). */
export function ensureGasKey(wallet: string, prf?: Uint8Array): Hex {
  const have = loadGasKey(wallet);
  if (have) return have;
  const pk = prf ? gasKeyFromPrf(prf) : generatePrivateKey();
  saveGasKey(wallet, pk);
  return pk;
}

export function gasAccount(wallet: string) {
  return privateKeyToAccount(ensureGasKey(wallet));
}

export function gasClient(wallet: string, chainId: number) {
  const info = chainById(chainId);
  if (!info) throw new Error(`chain ${chainId} not enabled`);
  return createWalletClient({ account: gasAccount(wallet), chain: info.chain, transport: http(rpcPath(chainId)) });
}
