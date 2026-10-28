import { type Address, type Hex, concat, createWalletClient, http, pad, parseAbi, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, publicClient, rpcPath } from "./chains";
import { waitFor } from "./safe/send";

/**
 * The old Burner Wallet's optional Safes (xdai.io, PLAN-xdai.md): Gnosis Safe 1.0.0 on Gnosis, made by its ProxyFactory
 * 0x3BD7460A7B35D371d621119E2f3c1c5845b874c4 (all 52 of its creations, 41 still Safes, read from its logs 10-27).
 * Every one has threshold 1, so an owner's old key alone can send what's inside.
 */
const OLD_SAFES: Address[] = [
  "0x0b76ce70bb6d9737aded8cdf1c408f28de89e07f",
  "0x0ebdb70cb72e73d038bfb82e79852724b7db3cd3",
  "0x0fdba0cb511749176bbf94db9392370d718f5336",
  "0x16e5a313dd3c24ea51bcd590d0c502392c7480ad",
  "0x22b9f7ac20bd1dc09a27bea5666d4649ac5f4bc6",
  "0x25a96f49c62671c38b72ac20b4a5616c0bb451b6",
  "0x28beaf54d66855bcb5df42884ea8c938304ae545",
  "0x2fbbcc7305b2c8b817db6bacb21d0e49240808b2",
  "0x3ab64a27c8e4fdf3b58ff1d22413b5e340925c4e",
  "0x3b9e44c412e0a3bcb5af0ae4e59b6813fdbe8063",
  "0x3d27268379b9611b486eab0b572bfa6c70ca79ce",
  "0x42e95c34020601fb31b93dc24eb4d16a3c1cd550",
  "0x48c4e22af108c5188648cc5a806e010a8c052303",
  "0x4a91bda56a2972bfb0709292a72a4b34b0e5656d",
  "0x519f10c6e330704ed2e756dc7e8e5c636bb7ef0d",
  "0x52b94ddf6b820404d559e4b61c7cd5192aafda2d",
  "0x5b77de92464c6d7798c0fb703836e3f7ff5a70c7",
  "0x5c27de377f33234e3df14162fd3fd02e230a1107",
  "0x5cb82962b87e674888ebaa7570b10bc71ddba137",
  "0x60dffb30adb934a2d10af16942fa8e8a7043d654",
  "0x6e3afd4cca29b31715b7ffd393b0d1c4c49c2c56",
  "0x7278dd485006600022eb6cc93703444a6bb9be47",
  "0x77bf5eabefb6966f728bfac1cfc4c3cc4941ba77",
  "0x850be79d87387cb520a6ea08f40c631b33f06b71",
  "0x88edd437820075ab34a4c49d172d15e9cc3b4bd0",
  "0x8a9d252490f2f29808ec82115ba8d6477ad0a613",
  "0x91ce5af73f8ba7a3de6bc87662528629ab353d11",
  "0x98bdf7e88c9f5abe8bd27ad2542572d47161eebb",
  "0x9d6dbc28d1e580551d9ee51c781c1d8ec4ad5b46",
  "0xa5d9597494c2982d16e24b0214115a594383f0da",
  "0xa8b3336fae3cb7c2a5a4080f0bc10c6b4990fdd2",
  "0xb8072110703007af0ba68d9616f78aea78539a3f",
  "0xb9da2133fc2a2559c207e1f8fbcb8ab4070ad9ff",
  "0xba3d58791c8bc1503f95e20c3edd1d9204a426f3",
  "0xbc270e5d7ab8e624197e3d771920b6980f7c03f4",
  "0xbcdfd87910f9a64615d97c27fd382824e865bdd5",
  "0xc0a71c626f83aa516c79b0d1b19a57a69f6c527b",
  "0xc2b3b83b1908defc05558f91bb0974938895c312",
  "0xd7bf424cd7b7e9cfc14d4d136fe120c94bbd0af6",
  "0xdf65919a1768e81dbfb76f2be0abc2092ed7b556",
  "0xedc097ce60e6dcf20891a9254d1d53860528b8e5"
];

const safeAbi = parseAbi([
  "function isOwner(address owner) view returns (bool)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
]);

export type OldSafe = { address: Address; wei: bigint };

/** The old Safes this key owns that still hold xDAI. */
export async function findOldSafes(owner: Address): Promise<OldSafe[]> {
  const pc = publicClient(100);
  const own = await pc.multicall({ contracts: OLD_SAFES.map(address => ({ address, abi: safeAbi, functionName: "isOwner", args: [owner] }) as const) });
  const mine = OLD_SAFES.filter((_, i) => own[i].result === true);
  const bals = await Promise.all(mine.map(a => pc.getBalance({ address: a })));
  return mine.map((address, i) => ({ address, wei: bals[i] })).filter(s => s.wei > 0n);
}

/**
 * All of a Safe's xDAI to `to`. The owner sends the Safe's transaction itself, so its signature is the "sent by an
 * owner" kind (Safe 1.0.0: v = 1, r = the owner): nothing to sign. The old key pays the gas.
 */
export async function sweepOldSafe(key: Hex, safe: Address, to: Address): Promise<bigint> {
  const owner = privateKeyToAccount(key);
  const pc = publicClient(100);
  const wc = createWalletClient({ account: owner, chain: CHAINS.find(c => c.id === 100)!.chain, transport: http(rpcPath(100)) });
  const wei = await pc.getBalance({ address: safe });
  if (wei === 0n) return 0n;
  const sig = concat([pad(owner.address), pad("0x0"), "0x01"]);
  const hash = await wc.writeContract({
    address: safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [to, wei, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress, sig],
    chain: CHAINS.find(c => c.id === 100)!.chain,
  });
  await waitFor(100, hash);
  return wei;
}
