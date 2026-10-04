import { type Address, type Hex, concat, encodeAbiParameters, keccak256, numberToHex, pad, toHex } from "viem";

/**
 * ERC-4337 (EntryPoint v0.8) user operations for InstantWallet v3.1, shared by the browser (lib/wallet.ts) and the
 * self-hosted bundler (app/api/bundler). Digests mirror InstantWallet.hashUserOp / hashPair / hashMessage.
 * Gas is paid in USDC by Circle Paymaster; a wallet's first op carries a USDC permit to it under the same signature.
 */

export const ENTRY_POINT: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const CIRCLE_PAYMASTER: Address = "0x0578cFB241215b77442a541325d6A4E6dFE700Ec";
/** The wallet tops its paymaster allowance up to 1 USDC after each op; below half that, the next op adds a permit. */
export const GAS_ALLOWANCE = 1_000_000n;
/** FiatToken's `allowed` mapping slot (for estimating a first op as if the permit already happened). */
export const USDC_ALLOWANCE_SLOT = 10n;

export const EXECUTE_USER_OP_SELECTOR = keccak256(
  toHex("executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)"),
).slice(0, 10) as Hex;

export type Call = { target: Address; value: bigint; data: Hex };

export type Gas = {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
};

/** The JSON-RPC (unpacked) form bundlers take. Quantities are hex strings. */
export type RpcUserOp = {
  sender: Address;
  nonce: Hex;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster?: Address;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
  paymasterData?: Hex;
  signature: Hex;
};

export type PackedUserOp = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

const u128 = (v: bigint) => pad(numberToHex(v), { size: 16 });
const enc = (types: string[], vals: unknown[]) => keccak256(encodeAbiParameters(types.map(type => ({ type })), vals));
const tk = (s: string) => keccak256(toHex(s));

export const executeCallData = (calls: Call[]): Hex =>
  concat([
    EXECUTE_USER_OP_SELECTOR,
    encodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
      [calls],
    ),
  ]);

export function pack(op: RpcUserOp): PackedUserOp {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x",
    callData: op.callData,
    accountGasLimits: concat([u128(BigInt(op.verificationGasLimit)), u128(BigInt(op.callGasLimit))]),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: concat([u128(BigInt(op.maxPriorityFeePerGas)), u128(BigInt(op.maxFeePerGas))]),
    paymasterAndData: op.paymaster
      ? concat([op.paymaster, u128(BigInt(op.paymasterVerificationGasLimit ?? "0x0")), u128(BigInt(op.paymasterPostOpGasLimit ?? "0x0")), op.paymasterData ?? "0x"])
      : "0x",
    signature: op.signature,
  };
}

function typed(chainId: number, wallet: Address, structHash: Hex): Hex {
  const domain = enc(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [tk("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), tk("InstantWallet"), tk("3"), BigInt(chainId), wallet],
  );
  return keccak256(concat(["0x1901", domain, structHash]));
}

export type Unsigned = {
  chainId: number;
  wallet: Address;
  signerId: Address;
  nonce: bigint;
  factory?: { address: Address; data: Hex };
  callData: Hex;
  /** USDC permit to the paymaster riding under the same signature (a wallet's first op). */
  permit?: { usdc: Address; usdcDomain: Hex; usdcNonce: bigint; amount: bigint };
  validUntil: bigint;
};

/** What the key signs, and how to turn its signature into the op. */
export function prepare(u: Unsigned, g: Gas) {
  const pmHead = concat([
    CIRCLE_PAYMASTER,
    u128(g.paymasterVerificationGasLimit),
    u128(g.paymasterPostOpGasLimit),
    "0x00",
    ...(u.permit ? [u.permit.usdc, pad(numberToHex(u.permit.amount))] : []),
  ]) as Hex;
  const cut = BigInt((pmHead.length - 2) / 2);
  const initCode = u.factory ? concat([u.factory.address, u.factory.data]) : "0x";
  const opHash = enc(
    ["uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32", "uint256"],
    [
      u.nonce,
      keccak256(initCode),
      keccak256(u.callData),
      concat([u128(g.verificationGasLimit), u128(g.callGasLimit)]),
      g.preVerificationGas,
      concat([u128(g.maxPriorityFeePerGas), u128(g.maxFeePerGas)]),
      keccak256(pmHead),
      cut,
    ],
  );
  const opDigest = typed(u.chainId, u.wallet, enc(["bytes32", "bytes32", "uint48"], [tk("UserOp(bytes32 opHash,uint48 validUntil)"), opHash, u.validUntil]));
  let pairWith: Hex = pad("0x0");
  let digest = opDigest;
  if (u.permit) {
    const permit = keccak256(
      concat([
        "0x1901",
        u.permit.usdcDomain,
        enc(
          ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
          [tk("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), u.wallet, CIRCLE_PAYMASTER, u.permit.amount, u.permit.usdcNonce, 2n ** 256n - 1n],
        ),
      ]),
    );
    pairWith = typed(u.chainId, u.wallet, enc(["bytes32", "bytes32"], [tk("InstantWalletMessage(bytes32 hash)"), permit]));
    digest = typed(u.chainId, u.wallet, enc(["bytes32", "bytes32", "bytes32"], [tk("Pair(bytes32 a,bytes32 b)"), opDigest, pairWith]));
  }
  const pmData = (keySig: Hex): Hex =>
    u.permit
      ? concat(["0x00", u.permit.usdc, pad(numberToHex(u.permit.amount)), u.signerId, tk("Pair(bytes32 a,bytes32 b)"), opDigest, keySig])
      : "0x00";
  const op = (keySig: Hex): RpcUserOp => ({
    sender: u.wallet,
    nonce: numberToHex(u.nonce),
    ...(u.factory ? { factory: u.factory.address, factoryData: u.factory.data } : {}),
    callData: u.callData,
    callGasLimit: numberToHex(g.callGasLimit),
    verificationGasLimit: numberToHex(g.verificationGasLimit),
    preVerificationGas: numberToHex(g.preVerificationGas),
    maxFeePerGas: numberToHex(g.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(g.maxPriorityFeePerGas),
    paymaster: CIRCLE_PAYMASTER,
    paymasterVerificationGasLimit: numberToHex(g.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: numberToHex(g.paymasterPostOpGasLimit),
    paymasterData: pmData(keySig),
    signature: concat([pad(numberToHex(u.validUntil), { size: 6 }), pad(numberToHex(cut), { size: 2 }), pairWith, keySig]),
  });
  return { digest, op };
}

/** Upper bound of what an op can cost, in wei (what the paymaster prefunds in USDC before refunding the rest). */
export const maxCost = (g: Gas) =>
  (g.verificationGasLimit + g.callGasLimit + g.preVerificationGas + g.paymasterVerificationGasLimit + g.paymasterPostOpGasLimit) * g.maxFeePerGas;
