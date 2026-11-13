// Step 0 of docs/PROVEN-BALANCES.md: what one proven balance read costs. With a Colibri client set up as light.ts's
// (same options, a fresh one so the first proof is cold), on real Ethereum and Gnosis: one Multicall3 eth_call (getEthBalance + N × balanceOf, allowFailure), N = 1,
// 20, 50, cold then warm, counting every request it makes (node methods, prover). Nothing is sent.
//   ALCHEMY_API_KEY=… npx tsx tools/proven-measure.mts                 native Colibri (Node's addon)
//   ALCHEMY_API_KEY=… npx tsx --conditions=browser tools/proven-measure.mts   the WASM build, as a browser runs it
//   … tools/proven-measure.mts live      lightBalances() itself on both networks, against plain reads
//   … tools/proven-measure.mts store     lib/safe/proven.ts's page side (see(), its rounds and pace) fed a portfolio
//                                        with a wrong amount, a made-up coin and a Base coin, reading through "your node"
// A laptop only: a phone can't be measured from here.
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

const KEY = process.env.ALCHEMY_API_KEY;
if (!KEY) throw new Error("ALCHEMY_API_KEY not set");
const NODE: Record<number, string> = { 1: `https://eth-mainnet.g.alchemy.com/v2/${KEY}`, 100: `https://gnosis-mainnet.g.alchemy.com/v2/${KEY}` };
const hide = (s: string) => s.replaceAll(KEY, "KEY");
const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address; // vitalik.eth: hundreds of coins
const MC = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

// every request, by where it went: the node (by JSON-RPC method, a batch counted per call), the prover (by path), other
type Tally = { node: Record<string, number>; prover: Record<string, number>; other: Record<string, number> };
let tally: Tally = { node: {}, prover: {}, other: {} };
const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.includes("alchemy.com")) {
    try {
      const j = JSON.parse(String(init?.body));
      for (const x of Array.isArray(j) ? j : [j]) bump(tally.node, x.method);
    } catch {
      bump(tally.node, "?");
    }
  } else if (url.includes("colibri-proof")) bump(tally.prover, new URL(url).pathname.split("/").slice(0, 3).join("/") || "/");
  else bump(tally.other, new URL(url).host);
  return realFetch(input, init);
}) as typeof fetch;

// the page's localStorage, for `store`: the switch on, and Alchemy set as "your own node" (Settings → Your node), so
// lib/safe/proven.ts reads where a page with its own node would (never our /api/rpc, which needs a page origin)
const mem = new Map<string, string>([["iws.proven", "on"], ["iws.rpc", JSON.stringify(NODE)]]);
Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) } });

// Colibri in Node keeps what it learns (the sync committee, contract code) as files in the working directory. A new
// empty one per run: no litter in the repo, and the first proof is really cold (a browser's first visit ever; after
// that a browser keeps them too, in its Cache API / localStorage).
const { mkdtempSync } = await import("node:fs");
process.chdir(mkdtempSync((await import("node:os")).tmpdir() + "/proven-measure-"));

const { lightBalances, PROVER } = await import("../lib/safe/light.ts");
const Colibri = (await import("@corpus-core/colibri-stateless")).default;

const post = (chainId: number, m: string, p: unknown[]) =>
  realFetch(NODE[chainId], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })
    .then(r => r.json())
    .then(j => {
      if (j.error) throw new Error(j.error.message);
      return j.result;
    });

/** The wallet's coins with a balance, from Alchemy (not proven, not counted): the coins a real Home would prove. */
async function coins(chainId: number, n: number): Promise<Address[]> {
  const r = await post(chainId, "alchemy_getTokenBalances", [WALLET, "erc20"]);
  const held = (r.tokenBalances as any[]).filter(t => t.tokenBalance && BigInt(t.tokenBalance) > 0n).map(t => t.contractAddress as Address);
  if (held.length < n) throw new Error(`only ${held.length} coins held on ${chainId}`);
  return held.slice(0, n);
}

const MC_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address) view returns (uint256)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
function multicall(tokens: Address[]): Hex {
  const calls = [
    { target: MC, allowFailure: true, callData: encodeFunctionData({ abi: MC_ABI, functionName: "getEthBalance", args: [WALLET] }) },
    ...tokens.map(t => ({ target: t, allowFailure: true, callData: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [WALLET] }) })),
  ];
  return encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3", args: [calls] });
}
const decode = (out: Hex) => decodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", data: out }).map(r => (r.success && r.returnData.length === 66 ? BigInt(r.returnData) : null));

/** As lightBalances does it: the proven header of "latest" (its number and time), then the call pinned to that block
 * (the header is cached by then: no second ask to the prover). */
async function proven(lc: any, data: Hex) {
  const head: any = await lc.request({ method: "eth_getBlockHeader", params: ["latest"] });
  const out = (await lc.request({ method: "eth_call", params: [{ to: MC, data }, head.blockNumber] })) as Hex;
  return { out, head };
}

async function measure() {
  const { Strategy } = await import("@corpus-core/colibri-stateless");
  for (const chainId of [1, 100]) {
    const all = await coins(chainId, 50).catch(async e => {
      console.log(chainId, "coins:", e.message);
      return coins(chainId, 20).catch(() => coins(chainId, 1));
    });
    // configured as light.ts's client() (not exported), without its retry on "too old", so a slow proof shows as one;
    // a new one per network, so its first proof is the page's first (cold)
    const lc = new Colibri({ chainId, rpcs: [NODE[chainId]], prover: [PROVER[chainId]], prover_mode: "hybrid", proofStrategy: Strategy.VerifiedOnly, max_latest_age_seconds: 90 } as any);
    let first = true;
    for (const n of [1, 20, 50].filter(n => n <= all.length)) {
      for (const run of [1, 2, 3]) {
        const data = multicall(all.slice(0, n));
        tally = { node: {}, prover: {}, other: {} };
        const t0 = Date.now();
        let out: Hex | undefined, head: any, err = "";
        try {
          ({ out, head } = await proven(lc, data));
        } catch (e: any) {
          err = hide(String(e?.message || e)).slice(-300);
        }
        const ms = Date.now() - t0;
        let same = "-";
        if (out) same = (await post(chainId, "eth_call", [{ to: MC, data }, head.blockNumber])) === out ? "same" : "DIFFERENT";
        const fails = out ? decode(out).filter(x => x === null).length : 0;
        const age = head ? `${Math.round(t0 / 1000 - Number(head.timestamp))}s` : "-";
        console.log(`${chainId === 1 ? "eth" : "gno"} N=${n} ${first ? "cold" : `warm`} ${ms}ms block ${head ? Number(head.blockNumber) : "-"} age ${age} node ${JSON.stringify(tally.node)} prover ${JSON.stringify(tally.prover)} other ${JSON.stringify(tally.other)} plain=${same} failedEntries=${fails}${err ? ` ERR ${err}` : ""}`);
        first = false;
      }
    }
    // "latest" straight into eth_call (no header first): works, but which block it was for isn't returned
    {
      const data = multicall(all.slice(0, 20));
      tally = { node: {}, prover: {}, other: {} };
      const t0 = Date.now();
      try {
        await lc.request({ method: "eth_call", params: [{ to: MC, data }, "latest"] });
        console.log(`${chainId} N=20 eth_call "latest" ${Date.now() - t0}ms node ${JSON.stringify(tally.node)} prover ${JSON.stringify(tally.prover)}`);
      } catch (e: any) {
        console.log(`${chainId} N=20 eth_call "latest" ERR ${hide(String(e?.message || e)).slice(-300)}`);
      }
    }
    // pinned to the node's own head: the proof needs the block after it (its parentBeaconBlockRoot), so this fails
    {
      const data = multicall(all.slice(0, 1));
      const h = await post(chainId, "eth_blockNumber", []);
      try {
        await lc.request({ method: "eth_call", params: [{ to: MC, data }, h] });
        console.log(`${chainId} pinned to the node's head: ok`);
      } catch (e: any) {
        console.log(`${chainId} pinned to the node's head: ERR ${hide(String(e?.message || e)).slice(-200)}`);
      }
    }
    // a coin with no code, and one that reverts (Multicall3 has no balanceOf): the whole proof, or just that entry?
    {
      const nocode = "0x00000000000000000000000000000000DeaDBeef" as Address;
      const data = multicall([all[0], nocode, MC]);
      try {
        const { out, head } = await proven(lc, data);
        const plain = await post(chainId, "eth_call", [{ to: MC, data }, head.blockNumber]);
        const raw = decodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", data: out });
        console.log(`${chainId} bad coins: proven ok, entries ${JSON.stringify(raw.map(r => [r.success, r.returnData.slice(0, 20)]))} plain=${plain === out ? "same" : "DIFFERENT"}`);
      } catch (e: any) {
        console.log(`${chainId} bad coins: ERR ${hide(String(e?.message || e))}`);
      }
    }
  }
}

async function live() {
  for (const chainId of [1, 100]) {
    const tokens = await coins(chainId, 20).catch(() => coins(chainId, 1));
    const list = ["0x0000000000000000000000000000000000000000" as Address, ...tokens, "0x00000000000000000000000000000000DeaDBeef" as Address];
    tally = { node: {}, prover: {}, other: {} };
    const t0 = Date.now();
    try {
      const r = await lightBalances({ chainId, wallet: WALLET, coins: list, rpc: NODE[chainId] });
      const ms = Date.now() - t0;
      const bn = "0x" + BigInt(r.block).toString(16);
      let bad = 0;
      for (const c of list) {
        const want =
          c === list[0]
            ? BigInt(await post(chainId, "eth_getBalance", [WALLET, bn]))
            : await post(chainId, "eth_call", [{ to: c, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [WALLET] }) }, bn]).then(x => (x.length === 66 ? BigInt(x) : null)).catch(() => null);
        const got = r.balances[c.toLowerCase()];
        if (got !== want) bad++, console.log("  MISMATCH", c, got, want);
      }
      console.log(`${chainId} lightBalances ${list.length} coins ${ms}ms block ${r.block} age ${Math.round(Date.now() / 1000 - r.time)}s, ${list.length - bad}/${list.length} equal plain reads at that block, nulls ${Object.values(r.balances).filter(x => x === null).length} node ${JSON.stringify(tally.node)} prover ${JSON.stringify(tally.prover)}`);
      if (bad) process.exitCode = 1;
    } catch (e: any) {
      console.log(`${chainId} lightBalances ERR ${hide(String(e?.message || e))}`);
      process.exitCode = 1;
    }
  }
}

async function store() {
  const { see, provenTable, onProven, stateOf, setSettleForTest } = await import("../lib/safe/proven.ts");
  // 20 s, not SETTLE_MS's 2 minutes, so the run takes under a minute; the rule is the same (tools/proven-check.mts tests 2 min)
  setSettleForTest(20_000);
  const USDC: Record<number, Address> = { 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 100: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0" };
  const FAKE = "0x00000000000000000000000000000000DeaDBeef" as Address;
  const rows: { chainId: number; asset: string; balance: string; usd: number | null; why: string }[] = [];
  for (const chainId of [1, 100]) {
    rows.push({ chainId, asset: "0x0000000000000000000000000000000000000000", balance: String(BigInt(await post(chainId, "eth_getBalance", [WALLET, "latest"]))), usd: 1000, why: "honest" });
    for (const t of await coins(chainId, 8)) {
      const b = await post(chainId, "eth_call", [{ to: t, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [WALLET] }) }, "latest"]);
      if (t.toLowerCase() !== USDC[chainId].toLowerCase()) rows.push({ chainId, asset: t, balance: String(BigInt(b)), usd: 10, why: "honest" });
    }
    const u = BigInt(await post(chainId, "eth_call", [{ to: USDC[chainId], data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [WALLET] }) }, "latest"]));
    rows.push({ chainId, asset: USDC[chainId], balance: String(u * 2n + 1n), usd: 500, why: "wrong amount" });
    rows.push({ chainId, asset: FAKE, balance: "1000000000000000000000", usd: 5000, why: "made up" });
  }
  rows.push({ chainId: 8453, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", balance: "1", usd: 1, why: "Base: no light client" });
  const want = (why: string) => (why === "honest" ? "checked" : why === "Base: no light client" ? "cant" : "wrong");
  const done = () => rows.every(r => stateOf(provenTable(), r).startsWith(want(r.why).slice(0, 4)));
  tally = { node: {}, prover: {}, other: {} };
  const t0 = Date.now();
  let rounds = 0;
  onProven(() => rounds++);
  // Home's read every 3 s, the same numbers each time: a read after a disagreeing proof is what makes a strike
  while (!done() && Date.now() - t0 < 240_000) {
    see(WALLET, rows);
    await new Promise(r => setTimeout(r, 3_000));
  }
  for (const r of rows) console.log(`  ${r.chainId} ${r.asset.slice(0, 10)} ${r.why.padEnd(22)} ${stateOf(provenTable(), r)}`);
  console.log(`store: ${done() ? "all as expected" : "NOT as expected"} after ${Date.now() - t0} ms, ${rounds} table changes, node ${JSON.stringify(tally.node)} prover ${JSON.stringify(tally.prover)}`);
  if (!done()) process.exitCode = 1;
}

console.log("Colibri runtime:", (await (await import("@corpus-core/colibri-stateless")).getRuntime()).kind);
if (process.argv[2] === "live") await live();
else if (process.argv[2] === "store") await store();
else await measure();
process.exit(process.exitCode ?? 0);
