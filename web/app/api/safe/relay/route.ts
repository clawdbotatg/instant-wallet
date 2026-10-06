import { NextRequest, NextResponse } from "next/server";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById } from "@/lib/chains";
import { upstreamRpc } from "@/lib/rpcServer";
import { MULTICALL3, MULTISEND_CALL_ONLY, ROLE_BURNER } from "@/lib/safe/config";
import {
  type SafeTx,
  abi,
  deploySafeCall,
  deploySignerCall,
  execData,
  rolesAddress,
  safeAddress,
  signedRolesCalldata,
  signerAddress,
} from "@/lib/safe/core";
import { GAS_BUDGET, type Quote, type SendKind, feePaid, rolesCalls, unpackMultiSend } from "@/lib/safe/fee";
import { RelayRefused, admit, checkCalls, once, reverted, withChainLock } from "@/lib/safe/relayGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // waits for the receipt (Ethereum ~12 s) so a revert is caught and the wallet refused

/**
 * The relay: it submits a user's signed Safe transaction (or the burner's signed Roles spend) and pays the gas;
 * the user's own batch ends with the relay's fee. It never holds user funds and has no power over any Safe.
 *
 *   GET  /api/safe/relay?chainId=8453&kind=first      → a Quote (fee in USDC and in ETH)
 *   POST /api/safe/relay  { chainId, kind: "exec", safe, tx, signatures, burner?: { x, y } }  (deploys the Safe / signer if missing)
 *   POST /api/safe/relay  { chainId, kind: "roles", safe, call, signer, signature, salt }
 *   → { hash }  (the client waits for the receipt itself)
 */

function relayer() {
  const pk = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("relay not configured");
  return privateKeyToAccount(pk);
}

function clients(chainId: number) {
  const info = chainById(chainId);
  const url = info && upstreamRpc(chainId);
  if (!info || !url) throw new Error("chain not enabled");
  const transport = http(url);
  return {
    info,
    pc: createPublicClient({ chain: info.chain, transport }),
    wc: createWalletClient({ chain: info.chain, transport, account: relayer() }),
  };
}

let price: { v: number; at: number } | null = null;
async function ethUsd(): Promise<number> {
  if (price && Date.now() - price.at < 60_000) return price.v;
  const j = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { cache: "no-store" }).then(r => r.json());
  const v = Number(j?.data?.amount);
  if (!Number.isFinite(v) || v < 100) throw new Error("no ETH price");
  price = { v, at: Date.now() };
  return v;
}

async function quote(chainId: number, kind: SendKind): Promise<Quote> {
  const { pc } = clients(chainId);
  const fees = await pc.estimateFeesPerGas().catch(async () => ({ maxFeePerGas: await pc.getGasPrice() }));
  const gasPrice = (fees.maxFeePerGas ?? 0n) as bigint;
  const usd = await ethUsd();
  const feeEth = (GAS_BUDGET[kind] * gasPrice * 125n) / 100n + (chainId === 1 ? 0n : 2_000_000_000_000n); // + L1 data, roughly
  const feeUsdc = BigInt(Math.ceil((Number(feeEth) / 1e18) * usd * 1e6)) + 10_000n; // + 1 cent
  return {
    chainId,
    relayer: relayer().address,
    kind,
    gasPrice: gasPrice.toString(),
    ethUsd: usd,
    feeEth: feeEth.toString(),
    feeUsdc: feeUsdc.toString(),
    until: Date.now() + 5 * 60_000,
  };
}

export async function GET(req: NextRequest) {
  try {
    const chainId = Number(req.nextUrl.searchParams.get("chainId"));
    const kind = (req.nextUrl.searchParams.get("kind") || "exec") as SendKind;
    if (!(kind in GAS_BUDGET)) return NextResponse.json({ error: "bad kind" }, { status: 400 });
    return NextResponse.json(await quote(chainId, kind));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}

const hex = (v: unknown): v is Hex => typeof v === "string" && isHex(v);

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  try {
    const chainId = Number(body.chainId);
    const { info, pc, wc } = clients(chainId);
    const me = wc.account.address;
    if (!isAddress(body.safe)) throw new Error("safe?");
    const safe = getAddress(body.safe);
    let to: Address;
    let data: Hex;
    let paid: { usdc: bigint; eth: bigint };
    let kind: SendKind;

    if (body.kind === "exec") {
      const t = body.tx;
      if (!t || !isAddress(t.to) || !hex(t.data) || !hex(body.signatures)) throw new Error("tx?");
      const tx: SafeTx = { to: getAddress(t.to), value: BigInt(t.value), data: t.data, operation: Number(t.operation) as 0 | 1, nonce: BigInt(t.nonce) };
      if (tx.to !== MULTISEND_CALL_ONLY || tx.operation !== 1 || tx.value !== 0n) throw new Error("only Instant Wallet batches");
      const inner = unpackMultiSend(tx.data);
      checkCalls(safe, inner);
      paid = feePaid(inner, me, info.usdc);
      const exec = execData(tx, body.signatures);
      // the burner's signer contract must exist before Safe checks its signature: deploy it in the same transaction
      // (a new phone after a recovery, or the very first send)
      const k = body.burner ?? body.deploy;
      const pre: { to: Address; data: Hex }[] = [];
      if (k && hex(k.x) && hex(k.y)) {
        const sc = await pc.getCode({ address: signerAddress(k.x, k.y) });
        if (!sc || sc === "0x") pre.push(deploySignerCall(k.x, k.y));
      }
      const code = await pc.getCode({ address: safe });
      if (!code || code === "0x") {
        // first send on this chain: deploy the Safe from the first setup (the burner's own address), then run the tx
        if (!k || !hex(k.x) || !hex(k.y)) throw new Error("this wallet isn't deployed here yet: send its key");
        const signer = signerAddress(k.x, k.y);
        if (safeAddress(signer) !== safe) throw new Error("that key doesn't make this address");
        pre.push(deploySafeCall(signer));
      }
      if (pre.length) {
        const calls = [...pre, { to: safe, data: exec }];
        to = MULTICALL3;
        data = encodeFunctionData({
          abi: abi.multicall3,
          functionName: "aggregate3",
          args: [calls.map(c => ({ target: c.to, allowFailure: false, callData: c.data }))],
        });
        kind = "first";
      } else {
        to = safe;
        data = exec;
        kind = body.wedgie ? "exec-wedgie" : "exec";
      }
    } else if (body.kind === "roles") {
      if (!hex(body.call) || !hex(body.signature) || !hex(body.salt) || !isAddress(body.signer)) throw new Error("role call?");
      const inner = rolesCalls(body.call, ROLE_BURNER);
      checkCalls(safe, inner);
      paid = feePaid(inner, me, info.usdc);
      to = rolesAddress(safe);
      data = signedRolesCalldata(body.call, getAddress(body.signer), body.signature, body.salt);
      kind = "roles";
    } else throw new Error("kind?");

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
    await admit(ip, safe);

    // the fee must cover this send at today's gas price, with the same margins as the quote (+ L1 data on L2s)
    const q = await quote(chainId, kind);
    // a load-balanced RPC can be a block behind the client's last read (a deposit, the previous send): retry once
    const estimate = () => pc.estimateGas({ account: me, to, data });
    const gas = await estimate()
      .catch(() => new Promise(r => setTimeout(r, 3000)).then(estimate))
      .catch((e: any) => {
        throw new Error(`it would fail on chain: ${e?.shortMessage || e?.message || e}`);
      });
    const l1 = chainId === 1 ? 0n : 2_000_000_000_000n;
    const costEth = (gas * BigInt(q.gasPrice) * 11n) / 10n + l1;
    const costUsdc = BigInt(Math.ceil((Number(costEth) / 1e18) * q.ethUsd * 1e6));
    if (paid.eth < costEth && paid.usdc < costUsdc)
      return NextResponse.json({ error: "fee too low", need: { feeEth: q.feeEth, feeUsdc: q.feeUsdc } }, { status: 402 });

    // one submission per signed tx: a reverted Safe tx keeps its nonce, so the same body could be replayed forever
    if (!(await once(`tx:${chainId}:${keccak256(data)}`, 3600))) throw new RelayRefused("Already sent.", 409);
    const hash = await withChainLock(chainId, () => wc.sendTransaction({ to, data, gas: (gas * 13n) / 10n, chain: info.chain }));
    const rc = await pc.waitForTransactionReceipt({ hash, timeout: 45_000 }).catch(() => null);
    if (rc && rc.status !== "success") {
      await reverted(safe);
      return NextResponse.json({ error: "it failed on chain", hash }, { status: 400 });
    }
    return NextResponse.json({ hash });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: e instanceof RelayRefused ? e.status : 400 });
  }
}
