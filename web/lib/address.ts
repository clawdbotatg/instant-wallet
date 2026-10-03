import { type Address, type Hex, concat, encodeAbiParameters, getAddress, getContractAddress, keccak256, toHex } from "viem";
import { FACTORY } from "./chains";

/**
 * A wallet's address, computed locally (no RPC): Factory.getAddress = CREATE2(factory, salt, ERC-1967 clone
 * init code of the v3 implementation), salt = keccak256(abi.encode(qx, qy, kind, credentialIdHash)).
 * The init code is OpenZeppelin ERC1967Clones' (packages/foundry/lib/openzeppelin-contracts).
 */

const i = process.env.NEXT_PUBLIC_IMPLEMENTATION_ADDRESS;
export const IMPLEMENTATION: Address | undefined = i && /^0x[0-9a-fA-F]{40}$/.test(i) ? (i as Address) : undefined;

export const KIND_WEBAUTHN = 0;
export const KIND_RAW = 1;

const UPGRADED_TOPIC = keccak256(toHex("Upgraded(address)"));
const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function cloneInitCode(implementation: Address): Hex {
  return concat([
    "0x603a5f8160475f3973",
    implementation,
    "0x807f",
    UPGRADED_TOPIC,
    "0x5f5fa260095155f3365f5f375f5f365f7f",
    IMPL_SLOT,
    "0x545af43d5f5f3e6036573d5ffd5b3d5ff3",
  ]);
}

export function walletSalt(qx: Hex, qy: Hex, kind: number, credentialIdHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }],
      [qx, qy, kind, credentialIdHash],
    ),
  );
}

export function walletAddress(qx: Hex, qy: Hex, kind: number, credentialIdHash: Hex): Address {
  if (!FACTORY || !IMPLEMENTATION) throw new Error("NEXT_PUBLIC_FACTORY_ADDRESS / NEXT_PUBLIC_IMPLEMENTATION_ADDRESS not set");
  return getContractAddress({
    opcode: "CREATE2",
    from: FACTORY,
    salt: walletSalt(qx, qy, kind, credentialIdHash),
    bytecode: cloneInitCode(IMPLEMENTATION),
  });
}

export function signerIdOf(qx: Hex, qy: Hex): Address {
  return getAddress(`0x${keccak256(concat([qx, qy])).slice(26)}`);
}
