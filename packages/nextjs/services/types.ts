import type { Address, Hex } from "viem";

export type RequestStatus = "pending" | "signed" | "relaying" | "confirmed" | "failed" | "rejected" | "expired";
export type RequestKind =
  | "transfer"
  | "execute"
  | "addSigner"
  | "updateSigner"
  | "setLimit"
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

/** asset = 0x000…0 is ETH; symbol/decimals are display hints, the device hashes only the raw fields. */
export type TransferRequest = RequestBase & {
  kind: "transfer";
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
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
  credentialIdHash: Hex;
  label?: string;
};

/** `label` = the app's name for targetSignerId when it knows one (display hint for the device). */
export type UpdateSignerRequest = RequestBase & {
  kind: "updateSigner";
  targetSignerId: Address;
  label?: string;
  role: number;
};
export type SetLimitRequest = RequestBase & {
  kind: "setLimit";
  targetSignerId: Address;
  label?: string;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  limit: string;
};
export type RemoveSignerRequest = RequestBase & { kind: "removeSigner"; targetSignerId: Address; label?: string };
export type SetRecoveryRequest = RequestBase & { kind: "setRecovery"; recoveryAddress: Address; recoveryDelay: number };
export type CancelRecoveryRequest = RequestBase & { kind: "cancelRecovery" };

export type WalletRequest =
  | TransferRequest
  | ExecuteRequest
  | AddSignerRequest
  | UpdateSignerRequest
  | SetLimitRequest
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

/** The first key of a wallet (what Factory.createWallet needs); registered when the passkey is created. */
export type FirstKey = { qx: Hex; qy: Hex; kind: number; credentialIdHash: Hex; registeredAt: number };

export type Store = {
  requests: WalletRequest[];
  /** last announce per signerId */
  devices: Record<string, DeviceInfo>;
  /** signerId -> wallet the key is (or was last seen) paired with */
  pairings: Record<string, Address>;
  /** wallet -> signerId -> human label ("iPhone · Face ID") */
  labels: Record<string, Record<string, string>>;
  /** wallet (lowercase) -> first key, for counterfactual wallets */
  keys: Record<string, FirstKey>;
};

export const IN_FLIGHT: ReadonlySet<RequestStatus> = new Set(["pending", "signed", "relaying"]);
export const DEVICE_ONLINE_MS = 90_000;
