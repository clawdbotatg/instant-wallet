// Your own relay, for running the wallet on your own computer (README: "Run it fully local").
// Makes a relay key once and saves it in web/.env.local (gitignored; the key is never printed), then shows its address
// and its ETH on a few networks. Send it a little ETH on the networks you use: it pays the gas, and each send's fee
// comes back to it.
//   npm run relay-key
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, formatEther, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const get = name => env.match(new RegExp(`^${name}=["']?([^"'\\n]+)`, "m"))?.[1];

let key = get("RELAYER_PRIVATE_KEY");
if (!key) {
  key = generatePrivateKey();
  appendFileSync(envPath, `${env && !env.endsWith("\n") ? "\n" : ""}RELAYER_PRIVATE_KEY=${key}\n`);
  console.log("Made a relay key and saved it in web/.env.local. Restart the app (npx next start) to use it.\n");
}
const address = privateKeyToAccount(key).address;
console.log(`Your relay: ${address}`);
console.log("Send it a little ETH on each network you use. Base: $1 is plenty. Ethereum: about $5.\n");

const alchemy = get("ALCHEMY_API_KEY");
if (!alchemy) process.exit(0);
const nets = [["Ethereum", "eth-mainnet"], ["Base", "base-mainnet"], ["Arbitrum", "arb-mainnet"], ["Optimism", "opt-mainnet"]];
for (const [name, host] of nets) {
  const pc = createPublicClient({ transport: http(`https://${host}.g.alchemy.com/v2/${alchemy}`) });
  const bal = await pc.getBalance({ address }).then(formatEther, () => "?");
  console.log(`  ${name.padEnd(9)} ${bal} ETH`);
}
