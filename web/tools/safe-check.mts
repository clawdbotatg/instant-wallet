// Checks lib/safe/core.ts against the chain: the TS address math must match what the deployed factories compute.
// npx tsx tools/safe-check.ts <rpc>
import { createPublicClient, http, keccak256, toBytes, type Hex } from "viem";
import { p256 } from "@noble/curves/nist.js";
import { abi, initializer, rolesAddress, safeAddress, signerAddress } from "../lib/safe/core";
import { PASSKEY_FACTORY, SAFE_FACTORY, SAFE_L2, SALT_NONCE, VERIFIERS, VERIFIERS_SLOT2 } from "../lib/safe/config";

const rpc = process.argv[2];
const pc = createPublicClient({ transport: http(rpc) });
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const pk = BigInt(keccak256(toBytes("burner"))) % N;
const pub = p256.getPublicKey(toBytes(`0x${pk.toString(16).padStart(64, "0")}` as Hex), false);
const x = BigInt("0x" + Buffer.from(pub.slice(1, 33)).toString("hex"));
const y = BigInt("0x" + Buffer.from(pub.slice(33)).toString("hex"));
let bad = 0;
const eq = (name: string, a: string, b: string) => {
  const ok = a.toLowerCase() === b.toLowerCase();
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${name} ${a} ${ok ? "" : "!= " + b}`);
};
for (const v of [VERIFIERS, VERIFIERS_SLOT2]) {
  const onchain = await pc.readContract({ address: PASSKEY_FACTORY, abi: abi.signerFactory, functionName: "getSigner", args: [x, y, v] });
  eq(`signer(verifiers=${v.toString(16)})`, signerAddress(x, y, v), onchain);
}
const burnerSigner = signerAddress(x, y);
// simulate the factory deploying it: the returned address must equal our prediction
const { result } = await pc.simulateContract({
  address: SAFE_FACTORY,
  abi: abi.factory,
  functionName: "createProxyWithNonce",
  args: [SAFE_L2, initializer(burnerSigner), SALT_NONCE],
  account: "0x000000000000000000000000000000000000dEaD",
});
eq("safe", safeAddress(burnerSigner), result);
console.log("roles (CREATE2 only; checked on the fork e2e)", rolesAddress(safeAddress(burnerSigner)));
process.exit(bad ? 1 : 0);
