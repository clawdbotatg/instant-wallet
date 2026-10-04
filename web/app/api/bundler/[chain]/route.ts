import { NextRequest, NextResponse } from "next/server";
import { type Hex, createPublicClient, createWalletClient, http, numberToHex, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById } from "@/lib/chains";
import { upstreamRpc } from "@/lib/rpcServer";
import { ENTRY_POINT, type RpcUserOp, pack } from "@/lib/userop";

export const dynamic = "force-dynamic";

/**
 * ERC-4337 bundler for the enabled chains. By default a passthrough to `BUNDLER_URL_<chainId>` (else Pimlico's
 * public endpoint), so a bundler key would stay on the server. With `BUNDLER_URL_<chainId>=self` this route IS the
 * bundler: `BUNDLER_PRIVATE_KEY` (a little ETH) calls EntryPoint.handleOps itself and the EntryPoint pays it back
 * from the paymaster's deposit. That's the fallback if public bundlers go away, and what the fork e2e uses.
 */

const METHODS = new Set([
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "eth_supportedEntryPoints",
  "pimlico_getUserOperationGasPrice",
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ chain: string }> }) {
  const chainId = Number((await params).chain);
  if (!chainById(chainId)) return NextResponse.json({ error: "chain not enabled" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || !METHODS.has(body.method)) return NextResponse.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not allowed" } });
  const upstream = process.env[`BUNDLER_URL_${chainId}`] || `https://public.pimlico.io/v2/${chainId}/rpc`;
  if (upstream === "self") {
    try {
      return NextResponse.json({ jsonrpc: "2.0", id: body.id, result: await self(chainId, body.method, body.params ?? []) });
    } catch (e: any) {
      const d = e?.walk?.((x: any) => x?.data?.errorName)?.data;
      const reason = d ? `${d.errorName}(${(d.args ?? []).map(String).join(", ")})` : e?.shortMessage || e?.message || String(e);
      return NextResponse.json({ jsonrpc: "2.0", id: body.id, error: { code: -32500, message: reason } });
    }
  }
  const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}

const epAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "function getUserOpHash(PackedUserOperation op) view returns (bytes32)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);
const opEvent = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

/** A minimal bundler: one op per handleOps, simulated by the EntryPoint call itself. */
async function self(chainId: number, method: string, params: any[]): Promise<unknown> {
  const chain = chainById(chainId)!.chain;
  const pc = createPublicClient({ chain, transport: http(upstreamRpc(chainId)) });
  if (method === "eth_supportedEntryPoints") return [ENTRY_POINT];
  if (method === "pimlico_getUserOperationGasPrice") {
    // Base-like: a tiny tip over twice the base fee (a node's default tip, e.g. anvil's 1 gwei, is 1000x too much)
    const baseFee = (await pc.getBlock()).baseFeePerGas ?? 0n;
    const tip = 1_000_000n;
    const tier = { maxFeePerGas: numberToHex(baseFee * 2n + tip), maxPriorityFeePerGas: numberToHex(tip) };
    return { slow: tier, standard: tier, fast: tier };
  }
  if (method === "eth_estimateUserOperationGas") {
    // generous fixed limits; unused verification gas isn't charged
    return { preVerificationGas: "0x15f90", verificationGasLimit: "0x7a120", callGasLimit: "0x30d40", paymasterVerificationGasLimit: "0x493e0", paymasterPostOpGasLimit: "0x9c40" };
  }
  if (method === "eth_sendUserOperation") {
    const key = process.env.BUNDLER_PRIVATE_KEY as Hex | undefined;
    if (!key) throw new Error("BUNDLER_PRIVATE_KEY not set");
    const account = privateKeyToAccount(key);
    const op = pack(params[0] as RpcUserOp);
    const wc = createWalletClient({ account, chain, transport: http(upstreamRpc(chainId)) });
    const hash = await pc.readContract({ address: ENTRY_POINT, abi: epAbi, functionName: "getUserOpHash", args: [op] });
    const { request } = await pc.simulateContract({ account, address: ENTRY_POINT, abi: epAbi, functionName: "handleOps", args: [[op], account.address] });
    await pc.waitForTransactionReceipt({ hash: await wc.writeContract(request) });
    return hash;
  }
  if (method === "eth_getUserOperationReceipt") {
    const logs = await pc.getLogs({ address: ENTRY_POINT, event: opEvent, args: { userOpHash: params[0] }, fromBlock: (await pc.getBlockNumber()) - 500n });
    const l = logs[0];
    if (!l) return null;
    return {
      userOpHash: params[0],
      success: l.args.success,
      actualGasCost: numberToHex(l.args.actualGasCost!),
      actualGasUsed: numberToHex(l.args.actualGasUsed!),
      receipt: { transactionHash: l.transactionHash },
    };
  }
  throw new Error(`${method} not supported by the self bundler`);
}
