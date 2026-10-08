// Tops up the relay's gas on every network from one wallet on Base: ETH on Base goes straight over, every other
// network gets its native coin through LI.FI (bridged and swapped, paid to the relay). Only networks below the
// target are topped up, so it's safe to run again any time.
//
//   npx tsx tools/fund-relay.mts            # dry run: balances and what it would send
//   npx tsx tools/fund-relay.mts --go       # send
//   TARGET_USD=5 FUNDER_KEY_FILE=~/.instant-wallet-funder.key RELAYER=0x… (default: the live relay's)
//
// The funder is a plain key in a file outside the repo (never commit it). Fund it with ETH on Base.
import fs from "node:fs";
import os from "node:os";
import { type Address, type Hex, createPublicClient, createWalletClient, formatEther, http, parseEther, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, knownChain } from "../lib/chains";

const GO = process.argv.includes("--go");
const TARGET = Number(process.env.TARGET_USD || 5);
const MIN_TOPUP = 1; // dollars: don't bridge pocket change
const keyFile = (process.env.FUNDER_KEY_FILE || "~/.instant-wallet-funder.key").replace(/^~/, os.homedir());
// what was sent when: a bridge can take ~20 min (Arc), so a network sent to in the last 30 min is skipped, not sent twice
const logFile = `${keyFile}.sent.json`;
const sent: Record<string, number> = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : {};
const IN_FLIGHT_MS = 30 * 60_000;
const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = process.env.ALCHEMY_API_KEY || env.ALCHEMY_API_KEY;
if (!KEY) throw new Error("ALCHEMY_API_KEY missing (web/.env.local)");
const rpc = (id: number) => `https://${knownChain(id)!.alchemy}.g.alchemy.com/v2/${KEY}`;

// LI.FI names a few native coins by their token contract instead of 0x0
const NATIVE_TOKEN: Record<number, Address> = { 42220: "0x471EcE3750Da237f93B8E339c536989b8978a438" };

const funder = privateKeyToAccount(fs.readFileSync(keyFile, "utf8").trim() as Hex);
const relayer: Address =
  (process.env.RELAYER as Address) ||
  (await fetch("https://instant-wallet-b2jn.vercel.app/api/safe/relay?chainId=8453&kind=exec").then(r => r.json())).relayer;

const syms = [...new Set(CHAINS.map(c => c.native.symbol.toUpperCase()))];
const px = new Map<string, number>();
for (const d of (await fetch(`https://api.g.alchemy.com/prices/v1/${KEY}/tokens/by-symbol?${syms.map(s => `symbols=${s}`).join("&")}`).then(r => r.json())).data ?? [])
  px.set(String(d.symbol).toUpperCase(), Number(d.prices?.find((p: any) => p.currency === "usd")?.value));

const base = knownChain(8453)!;
const basePc = createPublicClient({ chain: base.chain, transport: http(rpc(8453)) });
const wc = createWalletClient({ chain: base.chain, transport: http(rpc(8453)), account: funder });
const ethUsd = px.get("ETH")!;
console.log(`funder ${funder.address}: ${formatEther(await basePc.getBalance({ address: funder.address }))} ETH on Base`);
console.log(`relay  ${relayer}, target $${TARGET} per network${GO ? "" : " (dry run: --go to send)"}\n`);

for (const c of CHAINS) {
  if (!c.alchemy) continue;
  const bal = await createPublicClient({ chain: c.chain, transport: http(rpc(c.id)) }).getBalance({ address: relayer });
  const price = c.nativeIsUsdc ? 1 : px.get(c.native.symbol.toUpperCase()) ?? 0;
  const have = Number(formatEther(bal)) * price;
  const need = TARGET - have;
  const line = `${c.name.padEnd(10)} ${formatEther(bal).slice(0, 10).padEnd(10)} ${c.native.symbol.padEnd(5)} $${have.toFixed(2)}`;
  if (need < MIN_TOPUP) {
    console.log(`${line}  ok`);
    continue;
  }
  if (Date.now() - (sent[c.id] ?? 0) < IN_FLIGHT_MS) {
    console.log(`${line}  on its way (sent ${Math.round((Date.now() - sent[c.id]) / 60_000)} min ago)`);
    continue;
  }
  const wei = parseEther((need / ethUsd).toFixed(18));
  if (!GO) {
    console.log(`${line}  would send ${formatEther(wei).slice(0, 8)} ETH (~$${need.toFixed(2)})`);
    continue;
  }
  try {
    let hash: Hex;
    let via = "direct";
    if (c.id === 8453) hash = await wc.sendTransaction({ to: relayer, value: wei });
    else {
      const q = new URL("https://li.quest/v1/quote");
      for (const [k, v] of Object.entries({
        fromChain: 8453,
        toChain: c.id,
        fromToken: zeroAddress,
        toToken: NATIVE_TOKEN[c.id] ?? zeroAddress,
        fromAmount: wei.toString(),
        fromAddress: funder.address,
        toAddress: relayer,
        integrator: "instant-wallet",
      }))
        q.searchParams.set(k, String(v));
      const j = await fetch(q).then(r => r.json());
      const t = j.transactionRequest;
      if (!t) throw new Error(j.message || "no route");
      if (j.action?.toAddress?.toLowerCase() !== relayer.toLowerCase()) throw new Error("LI.FI changed the receiver");
      // some bridges (Squid, to Celo) add their own fee on top of the amount: allow up to 5%
      if (BigInt(t.value) < wei || BigInt(t.value) > (wei * 105n) / 100n) throw new Error("LI.FI's ETH value doesn't match");
      via = j.toolDetails?.name || j.tool;
      hash = await wc.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value), gas: t.gasLimit ? BigInt(t.gasLimit) : undefined });
    }
    const rc = await basePc.waitForTransactionReceipt({ hash });
    if (rc.status === "success") fs.writeFileSync(logFile, JSON.stringify({ ...sent, [c.id]: (sent[c.id] = Date.now()) }));
    console.log(`${line}  sent ~$${need.toFixed(2)} via ${via}: ${rc.status} ${base.explorer}/tx/${hash}`);
  } catch (e: any) {
    console.log(`${line}  FAILED: ${e?.shortMessage || e?.message || e}`);
  }
}
