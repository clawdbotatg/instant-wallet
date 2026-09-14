import { instantWalletAbi, isDeployed, isLocal, publicClient, tokenBalance, tokenMeta } from "./chain";
import { labelsFor, listDevices, listRequests } from "./store";
import { DEVICE_ONLINE_MS, IN_FLIGHT } from "./types";
import { type Address, type Hex, erc20Abi, formatUnits, parseAbiItem } from "viem";
import { chainId } from "~~/utils/chain";

/** Everything the UI needs to know about one wallet, read straight from the chain. */

export type SignerInfo = {
  signerId: Address;
  qx: Hex;
  qy: Hex;
  kind: number; // 0 webauthn, 1 raw
  role: number; // 0 spender, 1 owner
  dailyLimit: string;
  spentInWindow: string;
  windowStart: number;
  addedAt: number;
  remainingAllowance: string; // "unlimited" for owners
  label?: string;
  deviceName?: string;
  online?: boolean;
};

export type ActivityItem = {
  id: string;
  type: "sent" | "received" | "executed" | "keyAdded" | "keyUpdated" | "keyRemoved" | "recoverySet" | "recoveryStarted";
  txHash: Hex;
  blockNumber: string;
  timestamp: number;
  signerId?: Address;
  token?: Address;
  to?: Address;
  from?: Address;
  amount?: string;
  fee?: string;
  calls?: number;
  detail?: string;
};

const MAX_UINT = 2n ** 256n - 1n;

export async function onchainNonce(wallet: Address): Promise<bigint> {
  return publicClient().readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "nonce",
  }) as Promise<bigint>;
}

export async function readSigners(wallet: Address): Promise<SignerInfo[]> {
  const pc = publicClient();
  const [ids, list] = (await pc.readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "getSigners",
  })) as [
    Address[],
    {
      qx: Hex;
      qy: Hex;
      kind: number;
      role: number;
      dailyLimit: bigint;
      spentInWindow: bigint;
      windowStart: bigint;
      addedAt: bigint;
    }[],
  ];
  const remaining = await Promise.all(
    ids.map(
      id =>
        pc.readContract({
          address: wallet,
          abi: instantWalletAbi,
          functionName: "remainingAllowance",
          args: [id],
        }) as Promise<bigint>,
    ),
  );
  const [labels, devices] = await Promise.all([labelsFor(wallet), listDevices()]);
  const now = Date.now();
  return ids.map((id, i) => {
    const s = list[i];
    const dev = devices.find(d => d.signerId.toLowerCase() === id.toLowerCase());
    return {
      signerId: id,
      qx: s.qx,
      qy: s.qy,
      kind: Number(s.kind),
      role: Number(s.role),
      dailyLimit: s.dailyLimit.toString(),
      spentInWindow: s.spentInWindow.toString(),
      windowStart: Number(s.windowStart),
      addedAt: Number(s.addedAt),
      remainingAllowance: remaining[i] === MAX_UINT ? "unlimited" : remaining[i].toString(),
      label: labels[id.toLowerCase()] ?? (dev ? dev.name : undefined),
      deviceName: dev?.name,
      online: dev ? now - dev.lastSeen < DEVICE_ONLINE_MS : undefined,
    };
  });
}

export async function readSigner(wallet: Address, signerId: Address) {
  const pc = publicClient();
  const [isSigner, s] = await Promise.all([
    pc.readContract({
      address: wallet,
      abi: instantWalletAbi,
      functionName: "isSigner",
      args: [signerId],
    }) as Promise<boolean>,
    pc.readContract({
      address: wallet,
      abi: instantWalletAbi,
      functionName: "getSigner",
      args: [signerId],
    }) as Promise<{
      qx: Hex;
      qy: Hex;
      kind: number;
      role: number;
      dailyLimit: bigint;
    }>,
  ]);
  if (!isSigner) return undefined;
  return { qx: s.qx, qy: s.qy, kind: Number(s.kind), role: Number(s.role), dailyLimit: s.dailyLimit };
}

export async function readRecovery(wallet: Address) {
  const pc = publicClient();
  const read = (functionName: any) =>
    pc.readContract({ address: wallet, abi: instantWalletAbi, functionName }) as Promise<any>;
  const [recoveryAddress, recoveryDelay, pendingQx, pendingQy, pendingKind, executeAfter] = await Promise.all([
    read("recoveryAddress"),
    read("recoveryDelay"),
    read("pendingQx"),
    read("pendingQy"),
    read("pendingKind"),
    read("recoveryExecuteAfter"),
  ]);
  const pending = Number(executeAfter) > 0;
  return {
    recoveryAddress: recoveryAddress as Address,
    recoveryDelay: Number(recoveryDelay),
    pending: pending
      ? { qx: pendingQx as Hex, qy: pendingQy as Hex, kind: Number(pendingKind), executeAfter: Number(executeAfter) }
      : null,
  };
}

const EV = {
  Transferred: parseAbiItem(
    "event Transferred(address indexed signerId, address indexed token, address indexed to, uint256 amount, uint256 fee, uint256 nonce)",
  ),
  Executed: parseAbiItem(
    "event Executed(address indexed signerId, bytes32 indexed callsHash, uint256 calls, uint256 nonce)",
  ),
  SignerAdded: parseAbiItem(
    "event SignerAdded(address indexed signerId, bytes32 qx, bytes32 qy, uint8 kind, uint8 role, uint128 dailyLimit)",
  ),
  SignerUpdated: parseAbiItem("event SignerUpdated(address indexed signerId, uint8 role, uint128 dailyLimit)"),
  SignerRemoved: parseAbiItem("event SignerRemoved(address indexed signerId)"),
  RecoverySet: parseAbiItem("event RecoverySet(address indexed recoveryAddress, uint64 recoveryDelay)"),
  RecoveryStarted: parseAbiItem(
    "event RecoveryStarted(bytes32 indexed qx, bytes32 indexed qy, uint8 kind, uint64 executeAfter)",
  ),
  Transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
};

async function fromBlock(): Promise<bigint | "earliest"> {
  if (isLocal) return "earliest";
  const lookback = BigInt(process.env.ACTIVITY_LOOKBACK_BLOCKS || "2000000");
  const head = await publicClient().getBlockNumber();
  return head > lookback ? head - lookback : 0n;
}

export async function readActivity(wallet: Address, limit = 50): Promise<ActivityItem[]> {
  const pc = publicClient();
  const from = await fromBlock();
  const token = (await tokenMeta()).address;
  const walletLogs = async (event: any) => pc.getLogs({ address: wallet, event, fromBlock: from, toBlock: "latest" });
  const [transferred, executed, added, updated, removed, recSet, recStarted, incoming] = await Promise.all([
    walletLogs(EV.Transferred),
    walletLogs(EV.Executed),
    walletLogs(EV.SignerAdded),
    walletLogs(EV.SignerUpdated),
    walletLogs(EV.SignerRemoved),
    walletLogs(EV.RecoverySet),
    walletLogs(EV.RecoveryStarted),
    pc.getLogs({ address: token, event: EV.Transfer, args: { to: wallet }, fromBlock: from, toBlock: "latest" }),
  ]);

  const items: Omit<ActivityItem, "timestamp">[] = [];
  const key = (l: any, t: string) => `${l.transactionHash}-${l.logIndex}-${t}`;
  for (const l of transferred as any[]) {
    items.push({
      id: key(l, "sent"),
      type: "sent",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      signerId: l.args.signerId,
      token: l.args.token,
      to: l.args.to,
      amount: l.args.amount.toString(),
      fee: l.args.fee.toString(),
    });
  }
  for (const l of executed as any[]) {
    items.push({
      id: key(l, "exec"),
      type: "executed",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      signerId: l.args.signerId,
      calls: Number(l.args.calls),
    });
  }
  for (const l of added as any[]) {
    items.push({
      id: key(l, "add"),
      type: "keyAdded",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      signerId: l.args.signerId,
      detail: `${Number(l.args.kind) === 1 ? "device" : "passkey"} · ${Number(l.args.role) === 1 ? "owner" : "spender"}`,
    });
  }
  for (const l of updated as any[]) {
    items.push({
      id: key(l, "upd"),
      type: "keyUpdated",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      signerId: l.args.signerId,
      detail: Number(l.args.role) === 1 ? "owner" : `spender · limit ${l.args.dailyLimit.toString()}`,
      amount: l.args.dailyLimit.toString(),
    });
  }
  for (const l of removed as any[]) {
    items.push({
      id: key(l, "rm"),
      type: "keyRemoved",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      signerId: l.args.signerId,
    });
  }
  for (const l of recSet as any[]) {
    items.push({
      id: key(l, "rs"),
      type: "recoverySet",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      to: l.args.recoveryAddress,
      detail: `${Number(l.args.recoveryDelay)}s delay`,
    });
  }
  for (const l of recStarted as any[]) {
    items.push({
      id: key(l, "rst"),
      type: "recoveryStarted",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
    });
  }
  // Incoming token transfers that were not the wallet paying itself
  for (const l of incoming as any[]) {
    if ((l.args.from as string).toLowerCase() === wallet.toLowerCase()) continue;
    items.push({
      id: key(l, "in"),
      type: "received",
      txHash: l.transactionHash,
      blockNumber: l.blockNumber.toString(),
      token,
      from: l.args.from,
      amount: l.args.value.toString(),
    });
  }

  items.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.id.localeCompare(a.id));
  const top = items.slice(0, limit);
  const blocks = [...new Set(top.map(i => i.blockNumber))].slice(0, 40);
  const ts = new Map<string, number>();
  await Promise.all(
    blocks.map(async b => {
      const blk = await pc.getBlock({ blockNumber: BigInt(b) }).catch(() => null);
      if (blk) ts.set(b, Number(blk.timestamp));
    }),
  );
  return top.map(i => ({ ...i, timestamp: ts.get(i.blockNumber) ?? 0 }));
}

export async function walletSnapshot(wallet: Address) {
  const deployed = await isDeployed(wallet);
  const token = await tokenMeta();
  if (!deployed) {
    const balance = await tokenBalance(wallet);
    return {
      chainId,
      address: wallet,
      deployed: false,
      token,
      balance: balance.toString(),
      balanceFormatted: formatUnits(balance, token.decimals),
      signers: [] as SignerInfo[],
      nonce: "0",
      recovery: null,
      activity: [] as ActivityItem[],
      pending: [] as string[],
    };
  }
  const [balance, signers, nonce, recovery, activity] = await Promise.all([
    tokenBalance(wallet),
    readSigners(wallet),
    onchainNonce(wallet),
    readRecovery(wallet),
    readActivity(wallet).catch(() => [] as ActivityItem[]),
  ]);
  const pending = (await listRequests())
    .filter(r => r.wallet.toLowerCase() === wallet.toLowerCase() && IN_FLIGHT.has(r.status))
    .map(r => r.id);
  return {
    chainId,
    address: wallet,
    deployed: true,
    token,
    balance: balance.toString(),
    balanceFormatted: formatUnits(balance, token.decimals),
    signers,
    nonce: nonce.toString(),
    recovery,
    activity,
    pending,
  };
}

export type WalletSnapshot = Awaited<ReturnType<typeof walletSnapshot>>;

export async function erc20Meta(token: Address) {
  const pc = publicClient();
  const [symbol, decimals] = await Promise.all([
    pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address: token, symbol, decimals };
}
