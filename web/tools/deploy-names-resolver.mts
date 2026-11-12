// Puts inst.eth's resolver on Ethereum: ENS's OffchainResolver (tools/names-resolver, unchanged), told our gateway's
// URL and the one key whose answers it takes. After this, inst.eth's owner points the name at it (one transaction:
// docs/NAMES.md) and every wallet can look up alice.inst.eth.
//
//   SIGNER=0x… npx tsx tools/deploy-names-resolver.mts         # dry run: the cost, the funder's balance
//   SIGNER=0x… npx tsx tools/deploy-names-resolver.mts --go    # deploy
//
// SIGNER: the address of the app's NAME_SIGNER_KEY (the key itself stays in Vercel). Fixed for good in the contract:
// a new key or a new URL is a new resolver. Paid by the funder (FUNDER_KEY_FILE, default ~/.instant-wallet-funder.key).
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { type Address, type Hex, createPublicClient, createWalletClient, encodeDeployData, formatEther, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const GO = process.argv.includes("--go");
const SIGNER = process.env.SIGNER as Address;
if (!SIGNER || !isAddress(SIGNER)) throw new Error("SIGNER=<the address of NAME_SIGNER_KEY>");
const URL_ = process.env.GATEWAY || "https://instantwallet.io/api/ens/gw/{sender}/{data}.json";
const keyFile = (process.env.FUNDER_KEY_FILE || "~/.instant-wallet-funder.key").replace(/^~/, os.homedir());
const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = process.env.ALCHEMY_API_KEY || env.ALCHEMY_API_KEY;
if (!KEY) throw new Error("ALCHEMY_API_KEY missing (web/.env.local)");
const funder = privateKeyToAccount(fs.readFileSync(keyFile, "utf8").trim() as Hex);
const transport = http(`https://eth-mainnet.g.alchemy.com/v2/${KEY}`);
const pc = createPublicClient({ chain: mainnet, transport });

const dir = new URL("./names-resolver/", import.meta.url).pathname;
execSync("forge build", { cwd: dir, stdio: "ignore" });
const { abi, bytecode } = JSON.parse(fs.readFileSync(`${dir}out/OffchainResolver.sol/OffchainResolver.json`, "utf8"));
const args = [URL_, [SIGNER]] as const;

const [gas, price, bal] = await Promise.all([pc.estimateGas({ account: funder.address, data: encodeDeployData({ abi, bytecode: bytecode.object, args }) }), pc.getGasPrice(), pc.getBalance({ address: funder.address })]);
const cost = (gas * price * 13n) / 10n;
console.log(`gateway ${URL_}\nsigner  ${SIGNER}\nfunder  ${funder.address} has ${formatEther(bal).slice(0, 10)} ETH, needs ~${formatEther(cost).slice(0, 10)} (${gas} gas)`);
if (bal < cost) throw new Error("fund the funder on Ethereum first");
if (!GO) {
  console.log("dry run: --go to deploy");
  process.exit(0);
}
const hash = await createWalletClient({ account: funder, chain: mainnet, transport }).deployContract({ abi, bytecode: bytecode.object, args, gas: (gas * 12n) / 10n });
const rc = await pc.waitForTransactionReceipt({ hash });
console.log(`${rc.status === "success" ? "DEPLOYED" : "FAILED"} ${rc.contractAddress} https://etherscan.io/tx/${hash}`);
