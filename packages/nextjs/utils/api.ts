import type { Address, Hex } from "viem";
import type { WalletRequest } from "~~/services/types";
import type { WalletSnapshot } from "~~/services/wallet";

/** Thin fetch helpers for the app's own routes. */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error || res.statusText || "request failed", res.status);
  return body as T;
}

export const api = {
  wallet: (address: string) =>
    fetch(`/api/wallet?address=${address}`, { cache: "no-store" }).then(r => json<WalletSnapshot>(r)),
  nonce: (address: string) =>
    fetch(`/api/wallet?address=${address}&nonce=1`, { cache: "no-store" }).then(r => json<{ nonce: string }>(r)),
  predict: (qx: Hex, qy: Hex) =>
    fetch(`/api/deploy-wallet?qx=${qx}&qy=${qy}`).then(r =>
      json<{ wallet: Address; signerId: Address; deployed: boolean }>(r),
    ),
  deploy: (body: { qx: Hex; qy: Hex; kind: number; credentialIdHash: Hex }) =>
    fetch("/api/deploy-wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => json<{ wallet: Address; signerId: Address; txHash?: Hex; alreadyDeployed?: boolean }>(r)),
  fund: (wallet: string, amount = "100") =>
    fetch("/api/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, amount }),
    }).then(r => json<{ txHash: Hex; balanceFormatted: string }>(r)),
  facilitate: (body: Record<string, unknown>) =>
    fetch("/api/facilitate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => json<{ txHash: Hex; blockNumber: string }>(r)),
  createRequest: (body: Record<string, unknown>) =>
    fetch("/api/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => json<{ request: WalletRequest }>(r)),
  request: (id: string) =>
    fetch(`/api/requests/${id}`, { cache: "no-store" }).then(r => json<{ request: WalletRequest }>(r)),
  requests: (wallet: string) =>
    fetch(`/api/requests?wallet=${wallet}`, { cache: "no-store" }).then(r => json<{ requests: WalletRequest[] }>(r)),
  reject: (id: string) =>
    fetch(`/api/requests/${id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "browser" }),
    }).then(r => json<{ status: string }>(r)),
  devices: (wallet?: string) =>
    fetch(`/api/device${wallet ? `?wallet=${wallet}` : ""}`, { cache: "no-store" }).then(r =>
      json<{ device: DeviceView | null; devices: DeviceView[]; now: number }>(r),
    ),
  ens: (name: string) =>
    fetch(`/api/ens?name=${encodeURIComponent(name)}`).then(r => json<{ address: Address | null }>(r)),
  ensReverse: (address: string) => fetch(`/api/ens?address=${address}`).then(r => json<{ name: string | null }>(r)),
};

export type DeviceView = {
  name: string;
  qx: Hex;
  qy: Hex;
  signerId: Address;
  chipSerial?: string;
  firmware?: string;
  firstSeen: number;
  lastSeen: number;
  online: boolean;
  paired?: boolean;
  pairedWallet: Address | null;
};

export type { WalletSnapshot, WalletRequest };
