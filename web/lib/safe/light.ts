import { type Address, type Hex, concat, decodeFunctionResult, encodeFunctionData, pad, parseAbi, toEventSelector, zeroAddress } from "viem";
import type { SafeTxLike, SimAnswer } from "clear-signing-safe-kit";

/**
 * The simulation, run in this browser by a light client (Colibri, corpus-core/colibri-stateless): the Safe tx runs in
 * its EVM on state the node PROVED (Merkle proofs against a block header the beacon chain's sync committee signed),
 * so the node can refuse to answer but can't lie about what the tx moves. Ethereum and Gnosis only: no other chain
 * of ours has a light client. Settings → your node → "Check it in this browser".
 * Base: Helios (a16z) has an OP Stack light client, tried 11-13 and parked. Its public Base server
 * (base.operationsolarstorm.org) answered 502, and our own build of its server joined 19 Base peers but got no signed
 * block in 6 minutes. Speed would be fine: the proofs for one Safe tx on Base took 0.7 to 1.2 s from Alchemy.
 * It also trusts Base's sequencer key, not Ethereum's validators.
 *
 * Reads go where the wallet's reads go (your node, else our proxy); block header proofs come from a Colibri prover
 * (theirs, or yours). VerifiedOnly: an answer that fails its proof throws, it never falls back to the plain answer.
 */
export const LIGHT_CHAINS = [1, 100];
export const PROVER: Record<number, string> = { 1: "https://mainnet.colibri-proof.tech", 100: "https://gnosis.colibri-proof.tech" };
// the wrapped native coin: wrapping says Deposit / Withdrawal, not Transfer
export const WRAPPED: Record<number, string> = { 1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 100: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d" };
// ETH moving logs a Transfer from this address on Ethereum (EIP-7708); we read the Safe's balance change instead (Gnosis has no such log)
const SYSTEM = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const DEPOSIT = toEventSelector("Deposit(address,uint256)");
const WITHDRAWAL = toEventSelector("Withdrawal(address,uint256)");

const SAFE = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);
const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

type Lc = { request(a: { method: string; params: unknown[] }): Promise<any> };
const made = new Map<string, Promise<Lc>>();
/** One light client per chain, node and prover, for the page's life (it keeps the sync committee it has checked). */
function client(chainId: number, rpc: string, prover: string, wasm?: string): Promise<Lc> {
  const k = `${chainId}|${rpc}|${prover}`;
  let c = made.get(k);
  if (!c) {
    c = import("@corpus-core/colibri-stateless").then(m => {
      if (wasm) m.set_wasm_url(wasm);
      // "latest" may be 90 s old (measured 11-11: proofs run 14 to 38 s old) (the default, 1 minute, failed on a phone when the prover ran behind: "proof for
      // latest too old"). A proof that is still too old is asked for again, twice, a block apart.
      const lc = new m.default({ chainId, rpcs: [rpc], prover: [prover], prover_mode: "hybrid", proofStrategy: m.Strategy.VerifiedOnly, max_latest_age_seconds: 90 }) as unknown as Lc;
      const request = async (a: { method: string; params: unknown[] }, left = 2): Promise<any> => {
        try {
          return await lc.request(a);
        } catch (e: any) {
          if (!left || !/too old/i.test(String(e?.message || e))) throw e;
          await new Promise(r => setTimeout(r, 4000));
          return request(a, left - 1);
        }
      };
      return { request } as Lc;
    });
    made.set(k, c);
    c.catch(() => made.delete(k));
  }
  return c;
}

/** Start it ahead of the first transaction: loading it and checking the sync committee takes a few seconds, once. */
export function lightWarm(chainId: number, rpc: string, prover?: string, wasm?: string) {
  client(chainId, rpc, prover || PROVER[chainId], wasm)
    .then(lc => lc.request({ method: "eth_blockNumber", params: [] }))
    .catch(() => {});
}

const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11"; // Multicall3, same address on Ethereum and Gnosis
const MC = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
// Coins per proven call. Measured 11-13 on a laptop (tools/proven-measure.mts, vitalik.eth): 50 coins in one call took
// 0.2 s on Ethereum and 0.4 to 0.7 s on Gnosis, warm. The cost is per coin, not per call: one eth_createAccessList
// plus about one eth_getProof per coin (56 for 50 on Ethereum, 66 on Gnosis), so smaller calls save nothing. Not
// measured on a phone.
export const LIGHT_CHUNK = 50;

export type LightBalances = { block: number; time: number; balances: Record<string, bigint | null> };

/**
 * The wallet's balances, proven: one Multicall3 eth_call per LIGHT_CHUNK coins (balanceOf each, getEthBalance for the
 * native coin, `zeroAddress` in `coins`), all at one block. The block is the proven header of "latest" (its number and
 * time are what the proof is for), the call pinned to it: the node's own head can't be proven yet (its proof needs the
 * block after it). A coin whose call fails (no code, reverts, an answer that isn't one number) is null; the others are
 * still proven. A proof that fails throws: never an unproven number.
 */
export async function lightBalances(o: { chainId: number; wallet: Address; coins: Address[]; rpc: string; prover?: string; wasm?: string }): Promise<LightBalances> {
  const lc = await client(o.chainId, o.rpc, o.prover || PROVER[o.chainId], o.wasm);
  const head = await lc.request({ method: "eth_getBlockHeader", params: ["latest"] });
  const block = head?.blockNumber as Hex;
  if (!block) throw new Error("no block header");
  const coins = [...new Set(o.coins.map(c => c.toLowerCase() as Address))];
  const balances: Record<string, bigint | null> = {};
  for (let i = 0; i < coins.length; i += LIGHT_CHUNK) {
    const part = coins.slice(i, i + LIGHT_CHUNK);
    const calls = part.map(c =>
      c === zeroAddress
        ? { target: MULTICALL as Address, allowFailure: true, callData: encodeFunctionData({ abi: MC, functionName: "getEthBalance", args: [o.wallet] }) }
        : { target: c, allowFailure: true, callData: encodeFunctionData({ abi: MC, functionName: "balanceOf", args: [o.wallet] }) },
    );
    const out = (await lc.request({ method: "eth_call", params: [{ to: MULTICALL, data: encodeFunctionData({ abi: MC, functionName: "aggregate3", args: [calls] }) }, block] })) as Hex;
    const res = decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: out });
    if (res.length !== part.length) throw new Error("multicall answered the wrong count");
    // an address with no code "succeeds" with no bytes: that's no balance, not 0
    part.forEach((c, j) => (balances[c] = res[j].success && res[j].returnData.length === 66 ? BigInt(res[j].returnData) : null));
  }
  return { block: Number(block), time: Number(head.timestamp), balances };
}

export type LightAnswer = Pick<SimAnswer, "ok" | "block" | "changes">;

/**
 * Run a Safe tx as the Safe would: execTransaction, sent by one of its owners (an owner who sends it needs no
 * signature; a Safe that wants more than one is run as if it wanted one). So a batch (a delegatecall) runs whole,
 * with the Safe's own code, guard and all. Throws when the light client can't prove an answer.
 */
export async function lightRun(o: { chainId: number; safe: Address; tx: SafeTxLike; rpc: string; prover?: string; wasm?: string }): Promise<LightAnswer> {
  const lc = await client(o.chainId, o.rpc, o.prover || PROVER[o.chainId], o.wasm);
  const safe = o.safe.toLowerCase() as Address;
  const call = (to: string, data: Hex) => lc.request({ method: "eth_call", params: [{ to, data }, "latest"] }) as Promise<Hex>;
  const [ownersHex, thresholdHex] = await Promise.all([call(safe, encodeFunctionData({ abi: SAFE, functionName: "getOwners" })), call(safe, encodeFunctionData({ abi: SAFE, functionName: "getThreshold" }))]);
  const owner = decodeFunctionResult({ abi: SAFE, functionName: "getOwners", data: ownersHex })[0];
  if (!owner) throw new Error("no wallet there yet");
  const threshold = decodeFunctionResult({ abi: SAFE, functionName: "getThreshold", data: thresholdHex });
  // "approved by whoever sends it": r = the owner, v = 1
  const sig = concat([pad(owner), pad("0x", { size: 32 }), "0x01"]);
  const data = encodeFunctionData({ abi: SAFE, functionName: "execTransaction", args: [o.tx.to as Address, o.tx.value, o.tx.data, o.tx.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, sig] });
  // the threshold is the Safe's storage slot 4
  const over = threshold > 1n ? [{ [safe]: { stateDiff: { [pad("0x04")]: pad("0x01") } } }] : [];
  const r = await lc.request({ method: "colibri_simulateTransaction", params: [{ from: owner, to: safe, data }, "latest", ...over] });
  const block = Number(r.blockNumber ?? (await lc.request({ method: "eth_blockNumber", params: [] })));
  if (r.status !== "0x1") return { ok: "reverts", block, changes: [] };

  const net = new Map<string, bigint>();
  const add = (t: string, n: bigint) => net.set(t, (net.get(t) ?? 0n) + n);
  const me = pad(safe).toLowerCase();
  for (const l of r.logs ?? []) {
    const { address, topics, data: d } = l.raw ?? l;
    const t = String(address).toLowerCase();
    const tp: string[] = (topics ?? []).map((x: string) => x.toLowerCase());
    if (!d || d === "0x" || t === SYSTEM) continue;
    if (tp[0] === TRANSFER && tp.length === 3) {
      if (tp[1] === me) add(t, -BigInt(d));
      if (tp[2] === me) add(t, BigInt(d));
    } else if (t === WRAPPED[o.chainId] && tp[1] === me) {
      if (tp[0] === DEPOSIT) add(t, BigInt(d));
      if (tp[0] === WITHDRAWAL) add(t, -BigInt(d));
    }
  }
  const bal = (r.stateChanges ?? []).find((s: any) => String(s.address).toLowerCase() === safe)?.balance;
  if (bal) add("eth", BigInt(bal.newValue) - BigInt(bal.previousValue));

  const changes = await Promise.all(
    [...net].filter(([, n]) => n !== 0n).map(async ([token, n]) => {
      if (token === "eth") return { token, symbol: "", decimals: 18, amount: n.toString(), usd: "" };
      // a token that doesn't say: "?" and its raw number, as clear-sim
      const [s, dec] = await Promise.all([
        call(token, encodeFunctionData({ abi: ERC20, functionName: "symbol" })).then(x => decodeFunctionResult({ abi: ERC20, functionName: "symbol", data: x })).catch(() => "?"),
        call(token, encodeFunctionData({ abi: ERC20, functionName: "decimals" })).then(x => decodeFunctionResult({ abi: ERC20, functionName: "decimals", data: x })).catch(() => -1),
      ]);
      return { token, symbol: s, decimals: Number(dec), amount: n.toString(), usd: "" };
    }),
  );
  return { ok: "ok", block, changes };
}
