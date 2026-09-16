import {
  assetMeta,
  factoryAbi,
  feePolicy,
  instantWalletAbi,
  isDeployed,
  isLocal,
  publicClient,
  requireFactory,
} from "./chain";
import { type Portfolio, assetInfo, portfolio } from "./portfolio";
import { getFirstKey, labelsFor, listDevices, listRequests } from "./store";
import { DEVICE_ONLINE_MS, IN_FLIGHT } from "./types";
import { type Address, type Hex, formatUnits, parseAbiItem } from "viem";
import { chainId } from "~~/utils/chain";
import { ETH_ASSET, ROLE_OWNER, isEth, signerIdOf } from "~~/utils/digests";

/** Everything the UI needs to know about one wallet, read straight from the chain. */

export type LimitInfo = {
  asset: Address; // 0x000…0 = ETH
  symbol: string;
  decimals: number;
  limit: string; // base units per 24h window
  spent: string;
  windowStart: number;
  remaining: string; // base units left in the current window
};

export type SignerInfo = {
  signerId: Address;
  qx: Hex;
  qy: Hex;
  kind: number; // 0 webauthn, 1 raw
  role: number; // 0 spender, 1 owner
  addedAt: number;
  /** Per-asset rolling allowances (spenders only; owners have none and no limit). */
  limits: LimitInfo[];
  label?: string;
  deviceName?: string;
  online?: boolean;
};

export type ActivityItem = {
  id: string;
  type:
    | "sent"
    | "received"
    | "executed"
    | "keyAdded"
    | "keyUpdated"
    | "limitSet"
    | "keyRemoved"
    | "recoverySet"
    | "recoveryStarted";
  txHash: Hex;
  blockNumber: string;
  timestamp: number;
  signerId?: Address;
  asset?: Address;
  symbol?: string;
  decimals?: number;
  to?: Address;
  from?: Address;
  amount?: string;
  fee?: string;
  usd?: number | null; // amount (+fee for sends) at today's price, when known
  calls?: number;
  detail?: string;
};

export async function onchainNonce(wallet: Address): Promise<bigint> {
  if (!(await isDeployed(wallet))) return 0n;
  return publicClient().readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "nonce",
  }) as Promise<bigint>;
}

type RawSigner = { qx: Hex; qy: Hex; kind: number; role: number; addedAt: bigint };
type RawAllowance = { limit: bigint; spent: bigint; windowStart: bigint };

async function limitsOf(wallet: Address, signerId: Address, role: number): Promise<LimitInfo[]> {
  if (role === ROLE_OWNER) return [];
  const pc = publicClient();
  const [assets, list] = (await pc.readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "getLimits",
    args: [signerId],
  })) as [Address[], RawAllowance[]];
  return Promise.all(
    assets.map(async (asset, i) => {
      const [remaining, meta] = await Promise.all([
        pc.readContract({
          address: wallet,
          abi: instantWalletAbi,
          functionName: "remainingAllowance",
          args: [signerId, asset],
        }) as Promise<bigint>,
        assetMeta(asset),
      ]);
      return {
        asset,
        symbol: meta.symbol,
        decimals: meta.decimals,
        limit: list[i].limit.toString(),
        spent: list[i].spent.toString(),
        windowStart: Number(list[i].windowStart),
        remaining: remaining.toString(),
      };
    }),
  );
}

async function decorate(wallet: Address, ids: Address[], raw: RawSigner[]): Promise<SignerInfo[]> {
  const [labels, devices, limits] = await Promise.all([
    labelsFor(wallet),
    listDevices(),
    Promise.all(ids.map((id, i) => limitsOf(wallet, id, Number(raw[i].role)))),
  ]);
  const now = Date.now();
  return ids.map((id, i) => {
    const s = raw[i];
    const dev = devices.find(d => d.signerId.toLowerCase() === id.toLowerCase());
    return {
      signerId: id,
      qx: s.qx,
      qy: s.qy,
      kind: Number(s.kind),
      role: Number(s.role),
      addedAt: Number(s.addedAt),
      limits: limits[i],
      label: labels[id.toLowerCase()] ?? (dev ? dev.name : undefined),
      deviceName: dev?.name,
      online: dev ? now - dev.lastSeen < DEVICE_ONLINE_MS : undefined,
    };
  });
}

/** Signers of a wallet. Before deployment: the registered first key as the sole owner (if known). */
export async function readSigners(wallet: Address): Promise<SignerInfo[]> {
  if (!(await isDeployed(wallet))) {
    const k = await getFirstKey(wallet);
    if (!k) return [];
    const id = signerIdOf(k.qx, k.qy);
    const [labels, devices] = await Promise.all([labelsFor(wallet), listDevices()]);
    const dev = devices.find(d => d.signerId.toLowerCase() === id.toLowerCase());
    return [
      {
        signerId: id,
        qx: k.qx,
        qy: k.qy,
        kind: k.kind,
        role: ROLE_OWNER,
        addedAt: Math.floor(k.registeredAt / 1000),
        limits: [],
        label: labels[id.toLowerCase()] ?? dev?.name,
        deviceName: dev?.name,
        online: dev ? Date.now() - dev.lastSeen < DEVICE_ONLINE_MS : undefined,
      },
    ];
  }
  const [ids, list] = (await publicClient().readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "getSigners",
  })) as [Address[], RawSigner[]];
  return decorate(wallet, ids, list);
}

export async function readSigner(wallet: Address, signerId: Address) {
  if (!(await isDeployed(wallet))) {
    const k = await getFirstKey(wallet);
    if (!k || signerIdOf(k.qx, k.qy).toLowerCase() !== signerId.toLowerCase()) return undefined;
    return { qx: k.qx, qy: k.qy, kind: k.kind, role: ROLE_OWNER };
  }
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
    }) as Promise<RawSigner>,
  ]);
  if (!isSigner) return undefined;
  return { qx: s.qx, qy: s.qy, kind: Number(s.kind), role: Number(s.role) };
}

/** What a spender may still move of `asset` right now (owners: max uint). */
export async function remainingAllowance(wallet: Address, signerId: Address, asset: Address): Promise<bigint> {
  if (!(await isDeployed(wallet))) {
    const s = await readSigner(wallet, signerId);
    return s?.role === ROLE_OWNER ? 2n ** 256n - 1n : 0n;
  }
  return publicClient().readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "remainingAllowance",
    args: [signerId, asset],
  }) as Promise<bigint>;
}

export async function readRecovery(wallet: Address) {
  const pc = publicClient();
  if (!(await isDeployed(wallet))) {
    // The factory bakes these into the clone at creation.
    const factory = requireFactory();
    const [recoveryAddress, recoveryDelay] = await Promise.all([
      pc.readContract({ address: factory, abi: factoryAbi, functionName: "defaultRecovery" }) as Promise<Address>,
      pc.readContract({ address: factory, abi: factoryAbi, functionName: "defaultRecoveryDelay" }) as Promise<bigint>,
    ]);
    return { recoveryAddress, recoveryDelay: Number(recoveryDelay), pending: null };
  }
  const read = (functionName: string) =>
    (pc.readContract as any)({ address: wallet, abi: instantWalletAbi, functionName }) as Promise<any>;
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
    "event Transferred(address indexed signerId, address indexed asset, address indexed to, uint256 amount, uint256 fee, uint256 nonce)",
  ),
  Executed: parseAbiItem(
    "event Executed(address indexed signerId, bytes32 indexed callsHash, uint256 calls, uint256 nonce)",
  ),
  SignerAdded: parseAbiItem(
    "event SignerAdded(address indexed signerId, bytes32 qx, bytes32 qy, uint8 kind, uint8 role)",
  ),
  SignerUpdated: parseAbiItem("event SignerUpdated(address indexed signerId, uint8 role)"),
  LimitSet: parseAbiItem("event LimitSet(address indexed signerId, address indexed asset, uint128 limit)"),
  SignerRemoved: parseAbiItem("event SignerRemoved(address indexed signerId)"),
  RecoverySet: parseAbiItem("event RecoverySet(address indexed recoveryAddress, uint64 recoveryDelay)"),
  RecoveryStarted: parseAbiItem(
    "event RecoveryStarted(bytes32 indexed qx, bytes32 indexed qy, uint8 kind, uint64 executeAfter)",
  ),
  EtherReceived: parseAbiItem("event EtherReceived(address indexed sender, uint256 amount)"),
  Transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
};

async function fromBlock(): Promise<bigint | "earliest"> {
  if (isLocal) return "earliest";
  const lookback = BigInt(process.env.ACTIVITY_LOOKBACK_BLOCKS || "2000000");
  const head = await publicClient().getBlockNumber();
  return head > lookback ? head - lookback : 0n;
}

/**
 * Wallet events (sends, executes, key changes, recovery) plus incoming transfers of ETH and of every
 * asset the wallet holds today. `held` avoids a second portfolio read when the caller has one.
 */
export async function readActivity(wallet: Address, limit = 50, held?: Portfolio): Promise<ActivityItem[]> {
  const pc = publicClient();
  const from = await fromBlock();
  const pf = held ?? (await portfolio(wallet));
  const tokens = pf.assets.filter(a => !isEth(a.asset)).slice(0, 10);
  const walletLogs = async (event: any) => pc.getLogs({ address: wallet, event, fromBlock: from, toBlock: "latest" });
  const [transferred, executed, added, updated, limited, removed, recSet, recStarted, ethIn] = await Promise.all([
    walletLogs(EV.Transferred),
    walletLogs(EV.Executed),
    walletLogs(EV.SignerAdded),
    walletLogs(EV.SignerUpdated),
    walletLogs(EV.LimitSet),
    walletLogs(EV.SignerRemoved),
    walletLogs(EV.RecoverySet),
    walletLogs(EV.RecoveryStarted),
    walletLogs(EV.EtherReceived),
  ]);
  const tokenIn: any[][] = await Promise.all(
    tokens.map(t =>
      pc
        .getLogs({ address: t.asset, event: EV.Transfer, args: { to: wallet }, fromBlock: from, toBlock: "latest" })
        .then(l => l as any[])
        .catch(() => [] as any[]),
    ),
  );

  const items: Omit<ActivityItem, "timestamp">[] = [];
  const key = (l: any, t: string) => `${l.transactionHash}-${l.logIndex}-${t}`;
  const base = (l: any) => ({ txHash: l.transactionHash as Hex, blockNumber: l.blockNumber.toString() });
  for (const l of transferred as any[]) {
    items.push({
      id: key(l, "sent"),
      type: "sent",
      ...base(l),
      signerId: l.args.signerId,
      asset: l.args.asset,
      to: l.args.to,
      amount: l.args.amount.toString(),
      fee: l.args.fee.toString(),
    });
  }
  for (const l of executed as any[]) {
    items.push({
      id: key(l, "exec"),
      type: "executed",
      ...base(l),
      signerId: l.args.signerId,
      calls: Number(l.args.calls),
    });
  }
  for (const l of added as any[]) {
    items.push({
      id: key(l, "add"),
      type: "keyAdded",
      ...base(l),
      signerId: l.args.signerId,
      detail: `${Number(l.args.kind) === 1 ? "device" : "passkey"} · ${Number(l.args.role) === 1 ? "owner" : "spender"}`,
    });
  }
  for (const l of updated as any[]) {
    items.push({
      id: key(l, "upd"),
      type: "keyUpdated",
      ...base(l),
      signerId: l.args.signerId,
      detail: Number(l.args.role) === 1 ? "owner" : "spender",
    });
  }
  for (const l of limited as any[]) {
    items.push({
      id: key(l, "lim"),
      type: "limitSet",
      ...base(l),
      signerId: l.args.signerId,
      asset: l.args.asset,
      amount: l.args.limit.toString(),
    });
  }
  for (const l of removed as any[]) {
    items.push({ id: key(l, "rm"), type: "keyRemoved", ...base(l), signerId: l.args.signerId });
  }
  for (const l of recSet as any[]) {
    items.push({
      id: key(l, "rs"),
      type: "recoverySet",
      ...base(l),
      to: l.args.recoveryAddress,
      detail: `${Number(l.args.recoveryDelay)}s delay`,
    });
  }
  for (const l of recStarted as any[]) {
    items.push({ id: key(l, "rst"), type: "recoveryStarted", ...base(l) });
  }
  for (const l of ethIn as any[]) {
    items.push({
      id: key(l, "in"),
      type: "received",
      ...base(l),
      asset: ETH_ASSET,
      from: l.args.sender,
      amount: l.args.amount.toString(),
    });
  }
  tokenIn.forEach((logs, i) => {
    for (const l of logs as any[]) {
      if ((l.args.from as string).toLowerCase() === wallet.toLowerCase()) continue;
      items.push({
        id: key(l, "in"),
        type: "received",
        ...base(l),
        asset: tokens[i].asset,
        from: l.args.from,
        amount: l.args.value.toString(),
      });
    }
  });

  items.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.id.localeCompare(a.id));
  const top = items.slice(0, limit);
  const blocks = [...new Set(top.map(i => i.blockNumber))].slice(0, 40);
  const ts = new Map<string, number>();
  const infos = new Map<string, Awaited<ReturnType<typeof assetInfo>>>();
  await Promise.all([
    ...blocks.map(async b => {
      const blk = await pc.getBlock({ blockNumber: BigInt(b) }).catch(() => null);
      if (blk) ts.set(b, Number(blk.timestamp));
    }),
    ...[...new Set(top.map(i => i.asset?.toLowerCase()).filter(Boolean))].map(async a => {
      const held = pf.assets.find(x => x.asset.toLowerCase() === a);
      infos.set(
        a as string,
        held
          ? { address: held.asset, symbol: held.symbol, decimals: held.decimals, price: held.price }
          : await assetInfo(a as Address).catch(() => ({
              address: a as Address,
              symbol: "?",
              decimals: 18,
              price: null,
            })),
      );
    }),
  ]);
  return top.map(i => {
    const info = i.asset ? infos.get(i.asset.toLowerCase()) : undefined;
    const moved = i.amount ? BigInt(i.amount) + (i.type === "sent" ? BigInt(i.fee ?? 0) : 0n) : undefined;
    return {
      ...i,
      timestamp: ts.get(i.blockNumber) ?? 0,
      symbol: info?.symbol,
      decimals: info?.decimals,
      usd:
        info && moved !== undefined && info.price !== null && i.type !== "limitSet"
          ? Number(formatUnits(moved, info.decimals)) * info.price
          : null,
    };
  });
}

export async function walletSnapshot(wallet: Address) {
  const deployed = await isDeployed(wallet);
  const pf = await portfolio(wallet);
  const [signers, nonce, recovery, activity, requests] = await Promise.all([
    readSigners(wallet),
    onchainNonce(wallet),
    readRecovery(wallet).catch(() => null),
    readActivity(wallet, 50, pf).catch(() => [] as ActivityItem[]),
    listRequests(),
  ]);
  const pending = requests
    .filter(r => r.wallet.toLowerCase() === wallet.toLowerCase() && IN_FLIGHT.has(r.status))
    .map(r => r.id);
  return {
    chainId,
    address: wallet,
    deployed,
    portfolio: pf,
    signers,
    nonce: nonce.toString(),
    recovery,
    activity,
    pending,
    fee: feePolicy(),
  };
}

export type WalletSnapshot = Awaited<ReturnType<typeof walletSnapshot>>;
