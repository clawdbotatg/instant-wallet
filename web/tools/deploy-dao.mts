// Puts the recovery DAO (dao.buidlguidl.eth, a Safe 1.3.0) on every network that doesn't have it yet, at the same
// address with the same 8 owners / 4 to sign: replays its Ethereum creation (same factory, singleton, setup, salt).
// Every new wallet names the DAO as its recovery address, so it has to exist wherever the wallet does.
//
//   npx tsx tools/deploy-dao.mts         # dry run: where it is, where it's missing, the funder's gas there
//   npx tsx tools/deploy-dao.mts --go    # create it where it's missing
//
// Paid by the funder (FUNDER_KEY_FILE, default ~/.instant-wallet-funder.key, the same one fund-relay uses).
// Out of gas somewhere: RELAYER=<funder address> TARGET_USD=1 npx tsx tools/fund-relay.mts --go
import fs from "node:fs";
import os from "node:os";
import { type Address, type Hex, createPublicClient, createWalletClient, formatEther, getContractAddress, http, keccak256, concat, encodePacked, pad, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS } from "../lib/chains";
import { DAO } from "../lib/safe/config";

const GO = process.argv.includes("--go");
const keyFile = (process.env.FUNDER_KEY_FILE || "~/.instant-wallet-funder.key").replace(/^~/, os.homedir());
const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = process.env.ALCHEMY_API_KEY || env.ALCHEMY_API_KEY;
if (!KEY) throw new Error("ALCHEMY_API_KEY missing (web/.env.local)");
const funder = privateKeyToAccount(fs.readFileSync(keyFile, "utf8").trim() as Hex);

// how it was made on Ethereum (2025-01-09): Safe's own service has the factory, singleton, setup data and salt
const made = await fetch(`https://safe-transaction-mainnet.safe.global/api/v1/safes/${DAO}/creation/`, { redirect: "follow" }).then(r => r.json());
const factory = made.factoryAddress as Address;
const singleton = made.masterCopy as Address;
const setup = made.setupData as Hex;
const saltNonce = BigInt(made.saltNonce);
const abi = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "function proxyCreationCode() view returns (bytes)",
]);

const eth = CHAINS.find(c => c.id === 1)!;
const ethPc = createPublicClient({ chain: eth.chain, transport: http(`https://${eth.alchemy}.g.alchemy.com/v2/${KEY}`) });
const proxyCode = await ethPc.readContract({ address: factory, abi, functionName: "proxyCreationCode" });
const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(setup), saltNonce]));
const predicted = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: concat([proxyCode, pad(singleton, { size: 32 })]) });
if (predicted.toLowerCase() !== DAO.toLowerCase()) throw new Error(`replay would land at ${predicted}, not ${DAO}: stop`);
console.log(`DAO ${DAO} (replay checks out), funder ${funder.address}${GO ? "" : " (dry run: --go to create)"}\n`);

for (const c of CHAINS) {
  if (!c.alchemy) continue;
  const pc = createPublicClient({ chain: c.chain, transport: http(`https://${c.alchemy}.g.alchemy.com/v2/${KEY}`) });
  const name = c.name.padEnd(10);
  try {
    if (((await pc.getCode({ address: DAO }))?.length ?? 0) > 2) {
      console.log(`${name} there`);
      continue;
    }
    const [f, s] = await Promise.all([pc.getCode({ address: factory }), pc.getCode({ address: singleton })]);
    if (!f || f === "0x" || !s || s === "0x") {
      console.log(`${name} MISSING, and Safe 1.3.0 isn't on this network: can't replay`);
      continue;
    }
    const bal = await pc.getBalance({ address: funder.address });
    const gas = await pc.estimateContractGas({ address: factory, abi, functionName: "createProxyWithNonce", args: [singleton, setup, saltNonce], account: funder.address }).catch(() => 400_000n);
    const cost = (gas * (await pc.getGasPrice()) * 12n) / 10n;
    const money = `funder has ${formatEther(bal).slice(0, 10)} ${c.native.symbol}, needs ~${formatEther(cost).slice(0, 10)}`;
    if (bal < cost) {
      console.log(`${name} MISSING, ${money}: fund it first`);
      continue;
    }
    if (!GO) {
      console.log(`${name} MISSING, would create (${money})`);
      continue;
    }
    const wc = createWalletClient({ chain: c.chain, transport: http(`https://${c.alchemy}.g.alchemy.com/v2/${KEY}`), account: funder });
    const hash = await wc.writeContract({ address: factory, abi, functionName: "createProxyWithNonce", args: [singleton, setup, saltNonce], gas: (gas * 13n) / 10n });
    const rc = await pc.waitForTransactionReceipt({ hash });
    const ok = rc.status === "success" && ((await pc.getCode({ address: DAO }))?.length ?? 0) > 2;
    console.log(`${name} ${ok ? "CREATED" : "FAILED"} ${c.explorer ? `${c.explorer}/tx/${hash}` : hash}`);
  } catch (e: any) {
    console.log(`${name} ERROR ${e?.shortMessage || e?.message || e}`);
  }
}
