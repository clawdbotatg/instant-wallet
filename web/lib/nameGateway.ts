import "server-only";
import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, encodePacked, getAddress, isAddress, isHex, keccak256, namehash, parseAbi, serializeSignature, zeroAddress } from "viem";
import { sign } from "viem/accounts";
import { CHAINS } from "./chains";
import { NAME_PARENT, ROOT_ADDRESS, ourLabel } from "./names";
import { nameOwner } from "./namesStore";

/**
 * How the rest of the world looks up alice.inst.eth. inst.eth's resolver on Ethereum is ENS's OffchainResolver
 * (ensdomains/offchain-resolver, tools/names-resolver): asked for any name under inst.eth it says "ask this URL"
 * (CCIP-read, EIP-3668), the wallet or app asks us, and the resolver checks our answer was signed by the key it was
 * deployed with (NAME_SIGNER_KEY here) before handing it on. So this key decides where every inst.eth name points:
 * it lives only in the server's environment. Lost or leaked: deploy the resolver again with a new key and point
 * inst.eth at it.
 *
 * We answer: the address, for Ethereum and for every network the wallet is on (the same address on all of them).
 * Not for any other network: a wallet's address there may not be this one.
 */
const RESOLVE = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const ASKS = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
]);
const VALID_S = 300; // how long an answer's signature holds

/** "\x05alice\x04inst\x03eth\x00" → alice.inst.eth */
function dnsName(hex: Hex): string {
  const b = Buffer.from(hex.slice(2), "hex");
  const labels: string[] = [];
  for (let i = 0; i < b.length && b[i]; i += b[i] + 1) labels.push(b.subarray(i + 1, i + 1 + b[i]).toString("utf8"));
  return labels.join(".").toLowerCase();
}

/** Who a name is: inst.eth itself, or the wallet that holds the name under it. */
async function who(name: string): Promise<Address | null> {
  if (name === NAME_PARENT) return ROOT_ADDRESS;
  const label = ourLabel(name);
  return label ? nameOwner(label) : null;
}

// ENSIP-11: an EVM chain's coin type is 0x80000000 | chainId. Ethereum's is 60.
const ours = (coinType: bigint) => coinType === 60n || CHAINS.some(c => coinType === (0x80000000n | BigInt(c.id)));

/** The resolver's question (`resolve(name, data)` calldata) → the answer, ABI-encoded as the asked function returns it. */
async function answer(request: Hex): Promise<Hex> {
  const { args } = decodeFunctionData({ abi: RESOLVE, data: request });
  const name = dnsName(args[0]);
  let ask;
  try {
    ask = decodeFunctionData({ abi: ASKS, data: args[1] });
  } catch {
    return "0x"; // a record we don't keep
  }
  if (ask.args[0] !== namehash(name)) throw new Error("name and node differ");
  if (ask.functionName === "addr" && ask.args.length === 1) return encodeAbiParameters([{ type: "address" }], [(await who(name)) ?? zeroAddress]);
  if (ask.functionName === "addr") return encodeAbiParameters([{ type: "bytes" }], [(ours(ask.args[1]!) && (await who(name))) || "0x"]);
  if (ask.functionName === "text") return encodeAbiParameters([{ type: "string" }], [""]);
  return encodeAbiParameters([{ type: "bytes" }], ["0x"]);
}

/**
 * One CCIP-read call: `sender` is the resolver that sent the wallet here, `request` what it asked. Returns the
 * `data` the wallet takes back to the resolver: (result, expires, signature), signed as SignatureVerifier.sol checks.
 */
export async function gateway(sender: string, request: string): Promise<{ data: Hex } | { error: string; status: number }> {
  const key = process.env.NAME_SIGNER_KEY;
  if (!key || !isHex(key)) return { error: "Names aren't set up yet", status: 503 };
  if (!isAddress(sender) || !isHex(request)) return { error: "bad request", status: 400 };
  // set once the resolver is deployed: we then sign for that resolver only
  const pinned = process.env.NAME_RESOLVER;
  if (pinned && pinned.toLowerCase() !== sender.toLowerCase()) return { error: "not our resolver", status: 400 };
  let result: Hex;
  try {
    result = await answer(request);
  } catch (e: any) {
    return { error: e?.message?.includes("kv") ? "Try again" : "bad request", status: e?.message?.includes("kv") ? 503 : 400 };
  }
  const expires = BigInt(Math.floor(Date.now() / 1000) + VALID_S);
  const hash = keccak256(encodePacked(["bytes2", "address", "uint64", "bytes32", "bytes32"], ["0x1900", getAddress(sender), expires, keccak256(request), keccak256(result)]));
  const sig = serializeSignature(await sign({ hash, privateKey: key }));
  return { data: encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [result, expires, sig]) };
}
