import type { Address, Hex } from "viem";

export type RequestStatus = "pending" | "signed" | "relaying" | "confirmed" | "failed" | "rejected" | "expired";
export type RequestKind =
  | "transfer"
  | "execute"
  | "addSigner"
  | "updateSigner"
  | "removeSigner"
  | "setRecovery"
  | "cancelRecovery";

/** Envelope shared by every request kind (docs/PROTOCOL.md section 5). */
export type RequestBase = {
  id: string;
  kind: RequestKind;
  chainId: number;
  wallet: Address;
  signerId: Address;
  nonce: string;
  deadline: number; // unix seconds
  digest: Hex;
  matchCode: string;
  status: RequestStatus;
  txHash?: Hex;
  error?: string;
  createdAt: number;
  updatedAt: number;
  signature?: { r: Hex; s: Hex };
  signedAt?: number;
  relayer?: Address;
  blockNumber?: string;
  note?: string; // display-only: what the user asked for (e.g. chat proposal)
};

export type TransferRequest = RequestBase & {
  kind: "transfer";
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  to: Address;
  toName?: string;
  amount: string;
  amountFormatted: string;
  fee: string;
};

export type CallJSON = { target: Address; value: string; data: Hex };
export type ExecuteRequest = RequestBase & { kind: "execute"; calls: CallJSON[]; callsHash: Hex };

export type AddSignerRequest = RequestBase & {
  kind: "addSigner";
  qx: Hex;
  qy: Hex;
  signerKind: number;
  role: number;
  dailyLimit: string;
  credentialIdHash: Hex;
  label?: string;
};

export type UpdateSignerRequest = RequestBase & {
  kind: "updateSigner";
  targetSignerId: Address;
  role: number;
  dailyLimit: string;
};
export type RemoveSignerRequest = RequestBase & { kind: "removeSigner"; targetSignerId: Address };
export type SetRecoveryRequest = RequestBase & { kind: "setRecovery"; recoveryAddress: Address; recoveryDelay: number };
export type CancelRecoveryRequest = RequestBase & { kind: "cancelRecovery" };

export type WalletRequest =
  | TransferRequest
  | ExecuteRequest
  | AddSignerRequest
  | UpdateSignerRequest
  | RemoveSignerRequest
  | SetRecoveryRequest
  | CancelRecoveryRequest;

export type DeviceInfo = {
  name: string;
  qx: Hex;
  qy: Hex;
  signerId: Address;
  chipSerial?: string;
  firmware?: string;
  firstSeen: number;
  lastSeen: number;
};

export type Store = {
  requests: WalletRequest[];
  /** last announce per signerId */
  devices: Record<string, DeviceInfo>;
  /** signerId -> wallet the key is (or was last seen) paired with */
  pairings: Record<string, Address>;
  /** wallet -> signerId -> human label ("iPhone · Face ID") */
  labels: Record<string, Record<string, string>>;
};

export const IN_FLIGHT: ReadonlySet<RequestStatus> = new Set(["pending", "signed", "relaying"]);
export const DEVICE_ONLINE_MS = 90_000;
