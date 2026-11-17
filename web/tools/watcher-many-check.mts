// The recovery watcher with 1500 junk wallets (audit 11-13, IW-3): every part reads, none fails.
//   anvil --fork-url <base rpc> --port 8545 &  then  NEXT_PUBLIC_CHAINS=8453 BASE_RPC_URL=http://127.0.0.1:8545 npx tsx --conditions=react-server tools/watcher-many-check.mts
import { running } from "../lib/alerts";
import { privateKeyToAddress, generatePrivateKey } from "viem/accounts";
const list = Array.from({ length: 1500 }, () => privateKeyToAddress(generatePrivateKey()));
const failed: string[] = [];
const t = Date.now();
const r = await running(list, failed);
console.log(failed.length ? "FAIL" : "PASS", `1500 junk wallets: ${r.length} found, ${failed.length} failed, ${Date.now() - t} ms`, failed.slice(0, 2));
process.exit(failed.length ? 1 : 0);
