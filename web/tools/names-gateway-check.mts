// The whole way a stranger's wallet looks up alice.inst.eth, on a fork of Ethereum: ENS's Universal Resolver →
// inst.eth's resolver (ENS's OffchainResolver, tools/names-resolver) → our gateway (/api/ens/gw) → the resolver
// checks our signature → the address. Also: a changed answer is refused.
//   anvil --fork-url <ethereum rpc> --port 8546 &
//   NAME_SIGNER_KEY=<a test key> RELAY_KV_URL= RELAY_KV_TOKEN= npx next dev -p 3112 &
//   SIGNER=<that key's address> npx tsx tools/names-gateway-check.mts
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { type Address, type Hex, createPublicClient, createTestClient, createWalletClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, http, namehash, parseAbi, toCoinType, toHex } from "viem";
import { mainnet } from "viem/chains";
import { packetToBytes } from "viem/ens";
import { ENS_REGISTRY, ROOT_ADDRESS, nameChallenge } from "../lib/names";
import { safeAddress, signerAddress } from "../lib/safe/core";

const APP = process.env.APP || "http://localhost:3112";
const RPC = process.env.RPC || "http://127.0.0.1:8546";
const SIGNER = process.env.SIGNER as Address;
if (!SIGNER) throw new Error("SIGNER=<the address of the app's NAME_SIGNER_KEY>");
const UNIVERSAL = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe"; // ENS's Universal Resolver (ENSv2 behind it since 2026-10-27)
let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

const transport = http(RPC);
const pub = createPublicClient({ chain: mainnet, transport });
const test = createTestClient({ chain: mainnet, transport, mode: "anvil" });
const [funded] = await createWalletClient({ chain: mainnet, transport }).getAddresses(); // anvil's own first account
const send = (account: Address) => createWalletClient({ account, chain: mainnet, transport });

// ---- a wallet takes a name, as tools/names-check.mts does
const sk = p256.utils.randomSecretKey();
const pk = p256.getPublicKey(sk, false);
const qx = toHex(pk.slice(1, 33)), qy = toHex(pk.slice(33, 65));
const wallet = safeAddress(signerAddress(qx, qy));
const label = `gw-${Math.random().toString(36).slice(2, 8)}`;
{
  const ts = Math.floor(Date.now() / 1000);
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(nameChallenge(wallet, label, ts).slice(2), "hex").toString("base64url"), origin: APP });
  const authData = new Uint8Array([...sha256(new TextEncoder().encode(new URL(APP).hostname)), 0x05, 0, 0, 0, 1]);
  const sig = p256.sign(sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(clientDataJSON))])), sk, { prehash: false, format: "compact" } as any) as Uint8Array;
  const r = await fetch(`${APP}/api/names`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, address: wallet, ts, qx, qy, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), authenticatorData: toHex(authData), clientDataJSON }),
  });
  ok(r.status === 200, `${label}.inst.eth taken by ${wallet}`);
}

// ---- ENS's resolver, deployed with our gateway and our signer
const dir = new URL("./names-resolver/", import.meta.url).pathname;
const art = `${dir}out/OffchainResolver.sol/OffchainResolver.json`;
if (!fs.existsSync(art)) execSync("forge build", { cwd: dir, stdio: "ignore" });
const { abi, bytecode } = JSON.parse(fs.readFileSync(art, "utf8"));
const url = `${APP}/api/ens/gw/{sender}/{data}.json`;
const made = await pub.waitForTransactionReceipt({ hash: await send(funded).deployContract({ abi, bytecode: bytecode.object, args: [url, [SIGNER]] }) });
const resolver = made.contractAddress!;
console.log("resolver", resolver, "gas", made.gasUsed);
const res = parseAbi(["function supportsInterface(bytes4) view returns (bool)", "function resolveWithProof(bytes response, bytes extraData) view returns (bytes)", "function resolve(bytes name, bytes data) view returns (bytes)"]);
ok(await pub.readContract({ address: resolver, abi: res, functionName: "supportsInterface", args: ["0x9061b923"] }), "it says it answers for names under it (ENSIP-10)");

// ---- inst.eth's owner points it at the resolver: the one transaction Austin signs
const reg = parseAbi(["function findTokenId(string label) view returns (uint256)", "function ownerOf(uint256 id) view returns (address)", "function setResolver(uint256 id, address resolver)", "function getResolver(string label) view returns (address)"]);
const id = await pub.readContract({ address: ENS_REGISTRY, abi: reg, functionName: "findTokenId", args: ["inst"] });
const owner = await pub.readContract({ address: ENS_REGISTRY, abi: reg, functionName: "ownerOf", args: [id] });
console.log("inst.eth owner", owner);
ok((await pub.getEnsAddress({ name: "inst.eth", universalResolverAddress: UNIVERSAL }))?.toLowerCase() === ROOT_ADDRESS.toLowerCase(), "before: inst.eth is the address we keep answering for it");
await test.impersonateAccount({ address: owner });
await test.setBalance({ address: owner, value: 10n ** 18n });
const set = await pub.waitForTransactionReceipt({ hash: await send(owner).writeContract({ address: ENS_REGISTRY, abi: reg, functionName: "setResolver", args: [id, resolver] }) });
ok(set.status === "success" && (await pub.readContract({ address: ENS_REGISTRY, abi: reg, functionName: "getResolver", args: ["inst"] })).toLowerCase() === resolver.toLowerCase(), `the owner set the resolver (gas ${set.gasUsed})`);

// ---- and now anyone's wallet can look the name up
const look = (name: string, coinType?: bigint) => pub.getEnsAddress({ name, coinType, universalResolverAddress: UNIVERSAL }).catch(e => `error: ${e.shortMessage || e.message}`);
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
let a = await look(`${label}.inst.eth`);
ok(same(a, wallet), `${label}.inst.eth → ${a}`);
a = await look(`${label}.inst.eth`, toCoinType(8453));
ok(same(a, wallet), `on Base → ${a}`);
a = await look(`${label}.inst.eth`, toCoinType(324));
ok(a === null, `on a network the wallet isn't on (zkSync) → ${a}`);
a = await look(`${label}.inst.eth`, 501n);
ok(a === null, `Solana, not yet → ${a}`);
a = await look("inst.eth");
ok(same(a, ROOT_ADDRESS), `inst.eth itself → ${a}`);
a = await look(`nobody-${label}.inst.eth`);
ok(a === null, `a name nobody holds → ${a}`);
a = await look(`sub.${label}.inst.eth`);
ok(a === null, `a name under a name → ${a}`);
const t = await pub.getEnsText({ name: `${label}.inst.eth`, key: "url", universalResolverAddress: UNIVERSAL }).catch(e => `error: ${e.shortMessage}`);
ok(t === null, `a text record → ${t}`);

// ---- an answer that was changed on the way is refused by the resolver
const name = toHex(packetToBytes(`${label}.inst.eth`));
const request = encodeFunctionData({ abi: res, functionName: "resolve", args: [name, encodeFunctionData({ abi: parseAbi(["function addr(bytes32) view returns (address)"]), functionName: "addr", args: [namehash(`${label}.inst.eth`)] })] });
const { data } = (await fetch(`${APP}/api/ens/gw/${resolver}/${request}.json`).then(r => r.json())) as { data: Hex };
const extra = encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [request, resolver]);
const proof = (response: Hex) => pub.readContract({ address: resolver, abi: res, functionName: "resolveWithProof", args: [response, extra] }).then(() => "taken", () => "refused");
ok((await proof(data)) === "taken", "our signed answer is taken");
const [result, expires, sig] = decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], data);
const thief = encodeAbiParameters([{ type: "address" }], ["0x000000000000000000000000000000000000dEaD"]);
ok((await proof(encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [thief, expires, sig]))) === "refused", "the same signature over another address is refused");
ok((await proof(encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [result, expires + 3600n, sig]))) === "refused", "and with a later expiry");
const other = await fetch(`${APP}/api/ens/gw/0x000000000000000000000000000000000000dEaD/${request}.json`).then(r => r.json());
ok(!other.data || (await proof(other.data)) === "refused", "an answer signed for another resolver is refused by ours");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
