import { Core } from "@walletconnect/core";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import {
  type Hash,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashMessage,
  hashTypedData,
  hexToBytes,
  isHex,
  numberToHex,
} from "viem";
import { factoryAbi } from "./abi";
import { KIND_WEBAUTHN } from "./address";
import { CHAINS, FACTORY, SENDABLE, publicClient } from "./chains";
import { signDigest } from "./passkey";
import type { Account } from "./types";
import { type Call, isDeployed, sendCalls } from "./wallet";

/**
 * Instant Wallet as a WalletConnect wallet (Reown WalletKit). A site shows a wc: QR, the scan button reads it,
 * the site connects. What a site can ask, and what happens:
 *
 *   eth_sendTransaction        one call  → a card → Face ID → one signed batch (metaExecute / user op)
 *   wallet_sendCalls (5792)    N calls   → one card → one Face ID → one atomic batch (approve + swap in one go)
 *   wallet_getCapabilities     answered at once: atomic "supported" on every enabled chain
 *   wallet_getCallsStatus      answered at once from the batch's receipt
 *   personal_sign / eth_signTypedData(_v4)  → a card → Face ID → an ERC-1271 signature (ERC-6492-wrapped
 *                              while the wallet has no code yet, so sites can check it before the first send)
 *   wallet_switchEthereumChain answered at once if we're on that chain
 *
 * eth_sign (blind hash signing) is never offered.
 */

export const PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64"; // SE-2's public id

const METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
  "wallet_getCapabilities",
  "wallet_switchEthereumChain",
];
const EVENTS = ["chainChanged", "accountsChanged"];
/** Chains sites may use: the ones we can actually send on (Base today). */
const WC_CHAINS = CHAINS.filter(c => SENDABLE.has(c.id));

const ERC6492_MAGIC: Hex = "0x6492649264926492649264926492649264926492649264926492649264926492";

export type Kit = Awaited<ReturnType<typeof WalletKit.init>>;
let kit: Promise<Kit> | null = null;

export function getKit(): Promise<Kit> {
  if (!kit) {
    kit = WalletKit.init({
      core: new Core({ projectId: PROJECT_ID }),
      metadata: {
        name: "Instant Wallet",
        description: "Your money, instantly. Face ID is the key.",
        url: window.location.origin,
        icons: [`${window.location.origin}/icons/icon-192.png`],
      },
    });
  }
  return kit;
}

export async function pair(uri: string) {
  const k = await getKit();
  await k.pair({ uri });
}

/** `chainIds`: the chains sites may use (the v3 wallet: the sendable ones; the Safe: every chain it's on). */
export async function approveProposal(p: WalletKitTypes.SessionProposal, account: { address: string }, chainIds = WC_CHAINS.map(c => c.id)) {
  const k = await getKit();
  const chains = chainIds.map(id => `eip155:${id}`);
  const namespaces = buildApprovedNamespaces({
    proposal: p.params,
    supportedNamespaces: {
      eip155: { chains, methods: METHODS, events: EVENTS, accounts: chains.map(c => `${c}:${account.address}`) },
    },
  });
  return k.approveSession({ id: p.id, namespaces });
}

export async function rejectProposal(p: WalletKitTypes.SessionProposal) {
  const k = await getKit();
  await k.rejectSession({ id: p.id, reason: getSdkError("USER_REJECTED") });
}

export async function disconnect(topic: string) {
  const k = await getKit();
  await k.disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
}

// ---------------------------------------------------------------- requests

export type Dapp = { name: string; url: string; icon?: string };

/** A request that needs the user: a batch of calls, or a message to sign. */
export type Pending =
  | { kind: "calls"; id: number; topic: string; chainId: number; dapp: Dapp; calls: Call[]; method: string }
  | { kind: "sign"; id: number; topic: string; chainId: number; dapp: Dapp; hash: Hex; preview: string; method: string };

const chainOf = (eip155: string) => Number(eip155.split(":")[1]);

export function dappOf(k: Kit, topic: string): Dapp {
  const m = k.getActiveSessions()[topic]?.peer.metadata;
  return { name: m?.name || "A site", url: m?.url || "", icon: m?.icons?.[0] };
}

export async function respond(topic: string, id: number, result: unknown) {
  const k = await getKit();
  await k.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", result } });
}

export async function respondError(topic: string, id: number, message = "User rejected", code = 4001) {
  const k = await getKit();
  await k.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", error: { code, message } } });
}

const toCall = (c: { to?: string; value?: string; data?: string }): Call => {
  if (!c.to) throw new Error("Deploying contracts isn't supported");
  return { target: getAddress(c.to), value: c.value ? BigInt(c.value) : 0n, data: (c.data as Hex) || "0x" };
};

/**
 * Sort an incoming request: answer the ones that need nobody (capabilities, status, chain switch) and return
 * `Pending` for the ones that need a Face ID. Throws → the caller answers with an error.
 */
export async function triage(e: WalletKitTypes.SessionRequest, chainIds = WC_CHAINS.map(c => c.id)): Promise<Pending | null> {
  const k = await getKit();
  const wcChain = (id: number) => chainIds.includes(id);
  const { topic, id } = e;
  const { method, params } = e.params.request;
  const chainId = chainOf(e.params.chainId);
  const dapp = dappOf(k, topic);
  const p = params as any[];

  switch (method) {
    case "wallet_getCapabilities": {
      const caps: Record<string, unknown> = {};
      for (const id of chainIds) caps[numberToHex(id)] = { atomic: { status: "supported" }, atomicBatch: { supported: true } };
      await respond(topic, id, caps);
      return null;
    }
    case "wallet_getCallsStatus": {
      await respond(topic, id, await callsStatus(String(p[0])));
      return null;
    }
    case "wallet_showCallsStatus":
      await respond(topic, id, null);
      return null;
    case "wallet_switchEthereumChain": {
      const want = Number(p[0]?.chainId);
      if (!wcChain(want)) throw Object.assign(new Error("Chain not supported"), { code: 4902 });
      await respond(topic, id, null);
      await k.emitSessionEvent({ topic, event: { name: "chainChanged", data: want }, chainId: `eip155:${want}` });
      return null;
    }
    case "eth_sendTransaction":
      return { kind: "calls", id, topic, chainId, dapp, calls: [toCall(p[0])], method };
    case "wallet_sendCalls": {
      const req = p[0] as { chainId?: string; calls: { to?: string; value?: string; data?: string }[] };
      const cid = req.chainId ? Number(req.chainId) : chainId;
      if (!wcChain(cid)) throw Object.assign(new Error("Chain not supported"), { code: 4902 });
      return { kind: "calls", id, topic, chainId: cid, dapp, calls: req.calls.map(toCall), method };
    }
    case "personal_sign": {
      // [message, address]; some sites send [address, message]
      const msg = (isHex(p[0]) && p[0].length === 42 ? p[1] : p[0]) as Hex | string;
      const text = isHex(msg) ? tryUtf8(msg) : msg;
      const hash = hashMessage(isHex(msg) ? { raw: msg } : msg);
      return { kind: "sign", id, topic, chainId, dapp, hash, preview: text ?? String(msg), method };
    }
    case "eth_signTypedData":
    case "eth_signTypedData_v4": {
      const raw = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1];
      const { EIP712Domain: _, ...types } = raw.types ?? {};
      const hash = hashTypedData({ domain: raw.domain, types, primaryType: raw.primaryType, message: raw.message });
      return { kind: "sign", id, topic, chainId, dapp, hash, preview: typedPreview(raw), method };
    }
    default:
      throw Object.assign(new Error(`${method} is not supported`), { code: 4200 });
  }
}

function tryUtf8(h: Hex): string | null {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(h));
    return /[\x00-\x08\x0e-\x1f]/.test(s) ? null : s;
  } catch {
    return null;
  }
}

function typedPreview(t: any): string {
  const lines = [`${t.domain?.name ?? "Unknown app"} · ${t.primaryType}`];
  for (const [k, v] of Object.entries(t.message ?? {})) lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- doing it

/** Approve: run the batch (one Face ID) or sign the message, and answer the site. */
export async function approve(pending: Pending, account: Account, onStage?: (s: string) => void): Promise<void> {
  if (pending.kind === "calls") {
    const hash = await sendCalls(pending.chainId, account, pending.calls, { onStage: onStage as any });
    remember(hash, pending.chainId);
    await respond(pending.topic, pending.id, pending.method === "wallet_sendCalls" ? { id: hash } : hash);
    return;
  }
  onStage?.("signing");
  await respond(pending.topic, pending.id, await sign1271(pending.chainId, account, pending.hash));
}

/** ERC-1271 signature over `hash`: signerId ‖ passkey signature of the wallet-scoped digest; 6492 if undeployed. */
export async function sign1271(chainId: number, account: Account, hash: Hex): Promise<Hex> {
  const digest = hashTypedData({
    domain: { name: "InstantWallet", version: "3", chainId, verifyingContract: account.address },
    types: { InstantWalletMessage: [{ name: "hash", type: "bytes32" }] },
    primaryType: "InstantWalletMessage",
    message: { hash },
  });
  const { signature } = await signDigest(account.credentialId, digest);
  const sig = concat([account.signerId, signature]);
  if (await isDeployed(chainId, account.address)) return sig;
  if (!FACTORY) return sig;
  const deploy = encodeFunctionData({
    abi: factoryAbi,
    functionName: "createWallet",
    args: [account.qx, account.qy, KIND_WEBAUTHN, account.credentialIdHash],
  });
  return concat([encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [FACTORY, deploy, sig]), ERC6492_MAGIC]);
}

// ---------------------------------------------------------------- EIP-5792 status

const STATUS_KEY = "iw3.wc.calls";
export function remember(hash: Hash, chainId: number) {
  try {
    const m = JSON.parse(localStorage.getItem(STATUS_KEY) || "{}");
    m[hash] = chainId;
    localStorage.setItem(STATUS_KEY, JSON.stringify(m));
  } catch {}
}

async function callsStatus(id: string) {
  let chainId = WC_CHAINS[0]?.id ?? CHAINS[0].id;
  try {
    chainId = JSON.parse(localStorage.getItem(STATUS_KEY) || "{}")[id] ?? chainId;
  } catch {}
  const receipt = await publicClient(chainId)
    .getTransactionReceipt({ hash: id as Hash })
    .catch(() => null);
  return {
    version: "2.0.0",
    id,
    chainId: numberToHex(chainId),
    atomic: true,
    status: !receipt ? 100 : receipt.status === "success" ? 200 : 500,
    receipts: receipt
      ? [
          {
            logs: receipt.logs.map(l => ({ address: l.address, data: l.data, topics: l.topics })),
            status: receipt.status === "success" ? "0x1" : "0x0",
            blockHash: receipt.blockHash,
            blockNumber: numberToHex(receipt.blockNumber),
            gasUsed: numberToHex(receipt.gasUsed),
            transactionHash: receipt.transactionHash,
          },
        ]
      : [],
  };
}

/** Open the WalletConnect sheet from anywhere (the scan button, a /wc?uri= link), optionally pairing a uri. */
export function openWalletConnect(uri?: string) {
  window.dispatchEvent(new CustomEvent("iw:walletconnect", { detail: uri }));
}
