// SPHINCS- C11 helper for the forge tests (packages/foundry/test/safe/PQHybrid.fork.t.sol, via vm.ffi):
//   node tools/pq-sign.mts pub  <material32>          -> abi.encode(bytes32 pkSeed, bytes32 pkRoot)
//   node tools/pq-sign.mts sign <material32> <msg32>  -> abi.encode(bytes32 pkSeed, bytes32 pkRoot, bytes sig)
//   node tools/pq-sign.mts msg <chainId> <signer> <index> <safeTxHash> <next> -> the app's pqMessage (bytes32)
// <material32> stands in for a passkey PRF output.
import { encodeAbiParameters, hexToBytes, toHex, type Hex } from "viem";
import { pqMessage } from "../lib/safe/pq/message.ts";
import { C11, keygen, sign } from "../lib/safe/pq/sphincs.ts";

const args = process.argv.slice(2);
const [cmd, material, msg] = args as [string, Hex, Hex | undefined];
if (cmd === "msg") {
  const [, chainId, signer, index, h, next] = args as [string, string, Hex, string, Hex, Hex];
  process.stdout.write(pqMessage(Number(chainId), signer, BigInt(index), h, next));
  process.exit(0);
}
const k = keygen(C11, hexToBytes(material));
if (cmd === "pub") {
  process.stdout.write(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [toHex(k.pkSeed), toHex(k.pkRoot)]));
} else if (cmd === "sign" && msg) {
  const sig = sign(C11, k, hexToBytes(msg));
  process.stdout.write(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }], [toHex(k.pkSeed), toHex(k.pkRoot), toHex(sig)]),
  );
} else {
  console.error("usage: pq-sign.mts pub <material> | sign <material> <msg>");
  process.exit(1);
}
