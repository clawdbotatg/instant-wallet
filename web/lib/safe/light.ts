import { type Address, type Hex, concat, decodeFunctionResult, encodeFunctionData, pad, parseAbi, toEventSelector, zeroAddress } from "viem";
import type { SafeTxLike, SimAnswer } from "clear-signing-safe-kit";

/**
 * The simulation, run in this browser by a light client (Colibri, corpus-core/colibri-stateless): the Safe tx runs in
 * its EVM on state the node PROVED (Merkle proofs against a block header the beacon chain's sync committee signed),
 * so the node can refuse to answer but can't lie about what the tx moves. Ethereum and Gnosis only: no other chain
 * of ours has a light client. Settings → your node → "Check it in this browser".
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
      // "latest" may be 2 minutes old (the default, 1 minute, failed on a phone when the prover ran behind: "proof for
      // latest too old"). A proof that is still too old is asked for again, twice, a block apart.
      const lc = new m.default({ chainId, rpcs: [rpc], prover: [prover], prover_mode: "hybrid", proofStrategy: m.Strategy.VerifiedOnly, max_latest_age_seconds: 120 }) as unknown as Lc;
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
