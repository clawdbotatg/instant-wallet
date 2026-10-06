import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  hashTypedData,
  keccak256,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
} from "viem";
import {
  DAO,
  FALLBACK_HANDLER,
  KEY_ETH,
  KEY_USDC,
  MODULE_FACTORY,
  MULTICALL3,
  MULTISEND_CALL_ONLY,
  MULTISEND_SETUP,
  MULTISEND_UNWRAPPER,
  PASSKEY_FACTORY,
  PASSKEY_SINGLETON,
  RECOVERY_7D,
  ROLES_MASTERCOPY,
  ROLE_BURNER,
  SAFE_FACTORY,
  SAFE_L2,
  SAFE_PROXY_CODE,
  SALT_NONCE,
  SIGNER_PROXY_CODE,
  VERIFIERS,
} from "./config";

/**
 * Pure Safe plumbing: addresses (no RPC), the first setup, batches, the EIP-712 hash, signature bytes.
 * Mirrors packages/foundry/test/safe/SafeBase.sol line for line; tools/safe-check.mjs checks the two agree.
 */

export const abi = {
  safe: parseAbi([
    "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
    "function nonce() view returns (uint256)",
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function isModuleEnabled(address) view returns (bool)",
    "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
    "function enableModule(address module)",
    "function disableModule(address prevModule, address module)",
    "function addOwnerWithThreshold(address owner, uint256 threshold)",
    "function removeOwner(address prevOwner, address owner, uint256 threshold)",
    "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
    "function changeThreshold(uint256 threshold)",
    "function approveHash(bytes32 hash)",
  ]),
  factory: parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)"]),
  signerFactory: parseAbi([
    "function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address)",
    "function getSigner(uint256 x, uint256 y, uint176 verifiers) view returns (address)",
  ]),
  recovery: parseAbi([
    "function addGuardianWithThreshold(address guardian, uint256 threshold)",
    "function revokeGuardianWithThreshold(address prevGuardian, address guardian, uint256 threshold)",
    "function getGuardians(address wallet) view returns (address[])",
    "function threshold(address wallet) view returns (uint256)",
    "function nonce(address wallet) view returns (uint256)",
    "function confirmRecovery(address wallet, address[] newOwners, uint256 newThreshold, bool execute)",
    "function finalizeRecovery(address wallet)",
    "function cancelRecovery()",
    "function getRecoveryRequest(address wallet) view returns ((uint256 guardiansApprovalCount, uint256 newThreshold, uint64 executeAfter, address[] newOwners))",
  ]),
  multiSend: parseAbi(["function multiSend(bytes transactions) payable"]),
  multicall3: parseAbi([
    "struct Call3 { address target; bool allowFailure; bytes callData; }",
    "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
    "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])",
    "function aggregate3Value(Call3Value[] calls) payable returns ((bool success, bytes returnData)[])",
  ]),
  erc20: parseAbi([
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ]),
  moduleFactory: parseAbi(["function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address)"]),
  roles: parseAbi([
    "struct ConditionFlat { uint8 parent; uint8 paramType; uint8 operator; bytes compValue; }",
    "function setUp(bytes initParams)",
    "function enableModule(address module)",
    "function disableModule(address prevModule, address module)",
    "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
    "function scopeTarget(bytes32 roleKey, address targetAddress)",
    "function revokeTarget(bytes32 roleKey, address targetAddress)",
    "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, ConditionFlat[] conditions, uint8 options)",
    "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
    "function setTransactionUnwrapper(address to, bytes4 selector, address adapter)",
    "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)",
    "function moduleTxHash(bytes data, bytes32 salt) view returns (bytes32)",
    "function allowances(bytes32 key) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)",
    "function isModuleEnabled(address module) view returns (bool)",
    "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  ]),
} as const;

export type Op = 0 | 1;
export type Call = { to: Address; value: bigint; data: Hex };
export type SafeTx = { to: Address; value: bigint; data: Hex; operation: Op; nonce: bigint };

// ---------------------------------------------------------------- addresses

/** The Safe passkey signer contract for a P-256 key + verifier setting: CREATE2, no RPC. */
export function signerAddress(x: Hex | bigint, y: Hex | bigint, verifiers: bigint = VERIFIERS): Address {
  const init = concat([
    SIGNER_PROXY_CODE,
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [PASSKEY_SINGLETON, BigInt(x), BigInt(y), verifiers],
    ),
  ]);
  return getContractAddress({ opcode: "CREATE2", from: PASSKEY_FACTORY, salt: pad("0x00", { size: 32 }), bytecode: init });
}

export function multiSendData(calls: Call[]): Hex {
  const packed = concat(
    calls.map(c => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value, BigInt((c.data.length - 2) / 2), c.data])),
  );
  return encodeFunctionData({ abi: abi.multiSend, functionName: "multiSend", args: [packed] });
}

/**
 * The first setup, fixed into the address forever (docs/PLAN.md "Decide before the first user"): the burner's
 * signer is the only owner; Candide's 7-day recovery is on with the DAO as guardian. Inner `to = 0` = the Safe.
 */
export function initializer(burnerSigner: Address): Hex {
  const setupCalls = multiSendData([
    { to: zeroAddress, value: 0n, data: encodeFunctionData({ abi: abi.safe, functionName: "enableModule", args: [RECOVERY_7D] }) },
    { to: RECOVERY_7D, value: 0n, data: encodeFunctionData({ abi: abi.recovery, functionName: "addGuardianWithThreshold", args: [DAO, 1n] }) },
  ]);
  return encodeFunctionData({
    abi: abi.safe,
    functionName: "setup",
    args: [[burnerSigner], 1n, MULTISEND_SETUP, setupCalls, FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
  });
}

export function safeAddress(burnerSigner: Address): Address {
  const init = initializer(burnerSigner);
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(init), SALT_NONCE]));
  const bytecode = concat([SAFE_PROXY_CODE, pad(SAFE_L2, { size: 32 })]);
  return getContractAddress({ opcode: "CREATE2", from: SAFE_FACTORY, salt, bytecode });
}

export function deploySafeCall(burnerSigner: Address): Call {
  return {
    to: SAFE_FACTORY,
    value: 0n,
    data: encodeFunctionData({ abi: abi.factory, functionName: "createProxyWithNonce", args: [SAFE_L2, initializer(burnerSigner), SALT_NONCE] }),
  };
}

export function deploySignerCall(x: Hex | bigint, y: Hex | bigint, verifiers: bigint = VERIFIERS): Call {
  return {
    to: PASSKEY_FACTORY,
    value: 0n,
    data: encodeFunctionData({ abi: abi.signerFactory, functionName: "createSigner", args: [BigInt(x), BigInt(y), verifiers] }),
  };
}

// ---------------------------------------------------------------- transactions

export const transfer = (token: Address, to: Address, amount: bigint): Call =>
  token === zeroAddress
    ? { to, value: amount, data: "0x" }
    : { to: token, value: 0n, data: encodeFunctionData({ abi: abi.erc20, functionName: "transfer", args: [to, amount] }) };

/** A call from the Safe to itself (owners, modules): MultiSendCallOnly 1.4.1 needs the Safe's own address. */
export const selfCall = (safe: Address, data: Hex): Call => ({ to: safe, value: 0n, data });

/** Every Safe tx we build is a MultiSendCallOnly batch (delegatecall), even for one call: one shape to check. */
export function batch(calls: Call[], nonce: bigint): SafeTx {
  return { to: MULTISEND_CALL_ONLY, value: 0n, data: multiSendData(calls), operation: 1, nonce };
}

export function safeTxHash(chainId: number, safe: Address, t: SafeTx): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: {
      to: t.to,
      value: t.value,
      data: t.data,
      operation: t.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: t.nonce,
    },
  });
}

/** The typed data a hot wallet (MetaMask) signs for a Safe tx: eth_signTypedData_v4. */
export function safeTxTypedData(chainId: number, safe: Address, t: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: {
      to: t.to,
      value: t.value.toString(),
      data: t.data,
      operation: t.operation,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: t.nonce.toString(),
    },
  };
}

export function execData(t: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: abi.safe,
    functionName: "execTransaction",
    args: [t.to, t.value, t.data, t.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
  });
}

// ---------------------------------------------------------------- signatures

export type WebAuthnSig = { authenticatorData: Hex; clientDataFields: string; r: bigint; s: bigint };

/** How Safe's passkey signer reads a signature: abi.encode(bytes authenticatorData, string clientDataFields, uint256 r, uint256 s). */
export function encodeWebAuthn(w: WebAuthnSig): Hex {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [w.authenticatorData, w.clientDataFields, w.r, w.s],
  );
}

export type Sig = { signer: Address; data: Hex; kind: "contract" | "ecdsa" | "approved" };

/** Safe's signature bytes: owners ascending; contract signatures as (r = signer, s = offset, v = 0) + payloads. */
export function encodeSignatures(sigs: Sig[]): Hex {
  const sorted = [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const headLen = sorted.length * 65;
  const head: Hex[] = [];
  const tail: Hex[] = [];
  let tailLen = 0;
  for (const s of sorted) {
    if (s.kind === "ecdsa") head.push(s.data);
    else if (s.kind === "approved") head.push(concat([pad(s.signer, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]));
    else {
      head.push(concat([pad(s.signer, { size: 32 }), toHex(headLen + tailLen, { size: 32 }), "0x00"]));
      const len = (s.data.length - 2) / 2;
      tail.push(concat([toHex(len, { size: 32 }), s.data]));
      tailLen += 32 + len;
    }
  }
  return concat([...head, ...tail]);
}

/** A MetaMask eth_signTypedData_v4 signature is already what Safe wants for an EOA (v = 27/28). */
export const ecdsaSig = (signer: Address, sig: Hex): Sig => ({ signer, data: sig, kind: "ecdsa" });

// ---------------------------------------------------------------- the burner's budget (Zodiac Roles)

export function rolesAddress(safe: Address): Address {
  const init = encodeFunctionData({
    abi: abi.roles,
    functionName: "setUp",
    args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])],
  });
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(init), 0n]));
  const bytecode = concat(["0x602d8060093d393df3363d3d373d3d3d363d73", ROLES_MASTERCOPY, "0x5af43d82803e903d91602b57fd5bf3"]);
  return getContractAddress({ opcode: "CREATE2", from: MODULE_FACTORY, salt, bytecode });
}

const OP = { Pass: 0, Matches: 5, WithinAllowance: 28, EtherWithinAllowance: 29 } as const;
const PT = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5 } as const;
const enc32 = (h: Hex) => encodeAbiParameters([{ type: "bytes32" }], [h]);

export type Budget = { usdc: bigint; eth: bigint };
export const DEFAULT_BUDGET: Budget = { usdc: 100_000_000n, eth: 40_000_000_000_000_000n }; // 100 USDC + 0.04 ETH a day

/**
 * The burner's daily budget, set up with the first second key (hot wallet or wedgie, either order), while the burner is
 * still the only owner: deploy Roles, give the burner its budget (USDC transfers + ETH through Multicall3).
 */
export function budgetCalls(
  safe: Address,
  usdc: Address,
  burnerSigner: Address,
  budget: Budget,
  now: bigint,
  have: { rolesDeployed?: boolean; rolesEnabled?: boolean } = {},
): Call[] {
  const roles = rolesAddress(safe);
  const r = (functionName: any, args: any): Call => ({ to: roles, value: 0n, data: encodeFunctionData({ abi: abi.roles, functionName, args } as any) });
  const init = encodeFunctionData({
    abi: abi.roles,
    functionName: "setUp",
    args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])],
  });
  const usdcConditions = [
    { parent: 0, paramType: PT.Calldata, operator: OP.Matches, compValue: "0x" as Hex },
    { parent: 0, paramType: PT.Static, operator: OP.Pass, compValue: "0x" as Hex },
    { parent: 0, paramType: PT.Static, operator: OP.WithinAllowance, compValue: enc32(KEY_USDC) },
  ];
  const ethConditions = [
    { parent: 0, paramType: PT.Calldata, operator: OP.Matches, compValue: "0x" as Hex },
    { parent: 0, paramType: PT.Array, operator: OP.Pass, compValue: "0x" as Hex },
    { parent: 0, paramType: PT.None, operator: OP.EtherWithinAllowance, compValue: enc32(KEY_ETH) },
    { parent: 1, paramType: PT.Tuple, operator: OP.Pass, compValue: "0x" as Hex },
    { parent: 3, paramType: PT.Static, operator: OP.Pass, compValue: "0x" as Hex },
    { parent: 3, paramType: PT.Static, operator: OP.Pass, compValue: "0x" as Hex },
    { parent: 3, paramType: PT.Static, operator: OP.Pass, compValue: "0x" as Hex },
    { parent: 3, paramType: PT.Dynamic, operator: OP.Pass, compValue: "0x" as Hex },
  ];
  const day = 86_400n;
  return [
    // a recovered wallet already has Roles (its old burner was removed from it): don't deploy or enable it twice
    ...(have.rolesDeployed
      ? []
      : [{ to: MODULE_FACTORY, value: 0n, data: encodeFunctionData({ abi: abi.moduleFactory, functionName: "deployModule", args: [ROLES_MASTERCOPY, init, 0n] }) }]),
    ...(have.rolesEnabled ? [] : [selfCall(safe, encodeFunctionData({ abi: abi.safe, functionName: "enableModule", args: [roles] }))]),
    r("enableModule", [burnerSigner]),
    r("assignRoles", [burnerSigner, [ROLE_BURNER], [true]]),
    r("setTransactionUnwrapper", [MULTISEND_CALL_ONLY, "0x8d80ff0a", MULTISEND_UNWRAPPER]),
    r("scopeTarget", [ROLE_BURNER, usdc]),
    r("scopeFunction", [ROLE_BURNER, usdc, "0xa9059cbb", usdcConditions, 0]),
    r("setAllowance", [KEY_USDC, budget.usdc, budget.usdc, budget.usdc, day, now]),
    r("scopeTarget", [ROLE_BURNER, MULTICALL3]),
    r("scopeFunction", [ROLE_BURNER, MULTICALL3, "0x174dea71", ethConditions, 1]),
    r("setAllowance", [KEY_ETH, budget.eth, budget.eth, budget.eth, day, now]),
  ];
}

/** A burner spend through Roles: the calldata the burner signs (plus a salt), and what the relay submits. */
export function rolesSpendCall(calls: Call[]): Hex {
  const eth = calls.filter(c => c.data === "0x");
  if (eth.length && eth.length !== calls.length) throw new Error("send ETH and tokens separately");
  if (eth.length) {
    const total = eth.reduce((t, c) => t + c.value, 0n);
    const inner = encodeFunctionData({
      abi: abi.multicall3,
      functionName: "aggregate3Value",
      args: [eth.map(c => ({ target: c.to, allowFailure: false, value: c.value, callData: "0x" as Hex }))],
    });
    return encodeFunctionData({ abi: abi.roles, functionName: "execTransactionWithRole", args: [MULTICALL3, total, inner, 0, ROLE_BURNER, true] });
  }
  return encodeFunctionData({
    abi: abi.roles,
    functionName: "execTransactionWithRole",
    args: [MULTISEND_CALL_ONLY, 0n, multiSendData(calls), 1, ROLE_BURNER, true],
  });
}

/** Zodiac's EIP-712 module-tx hash (SignatureChecker.moduleTxHash): the burner's WebAuthn challenge. */
export function moduleTxHash(chainId: number, roles: Address, data: Hex, salt: Hex): Hex {
  const DOMAIN = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218";
  const MODULE_TX = "0x2939aeeda3ca260200c9f7b436b19e13207547ccc65cfedc857751c5ea6d91d4";
  const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [DOMAIN, BigInt(chainId), roles]));
  const struct = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [MODULE_TX, keccak256(data), salt]));
  return keccak256(concat(["0x1901", domain, struct]));
}

/** call ‖ signature ‖ salt ‖ r = signer ‖ s = where the signature starts ‖ v = 0 (zodiac SignatureChecker). */
export function signedRolesCalldata(call: Hex, signer: Address, signature: Hex, salt: Hex): Hex {
  const start = (call.length - 2) / 2;
  return concat([call, signature, salt, pad(signer, { size: 32 }), toHex(start, { size: 32 }), "0x00"]);
}

// ---------------------------------------------------------------- recovery

/**
 * Make `next` the only recovery address. Candide keeps guardians in a linked list (newest first, as getGuardians
 * returns them); each revoke names the guardian before it in the list as it stands at that moment.
 */
export function setGuardianCalls(current: Address[], next: Address): Call[] {
  const calls: Call[] = [];
  const list = [...current];
  if (!list.some(a => a.toLowerCase() === next.toLowerCase())) {
    calls.push({ to: RECOVERY_7D, value: 0n, data: encodeFunctionData({ abi: abi.recovery, functionName: "addGuardianWithThreshold", args: [next, 1n] }) });
    list.unshift(next);
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].toLowerCase() === next.toLowerCase()) continue;
    const prev = i === 0 ? SENTINEL : list[i - 1];
    calls.push({ to: RECOVERY_7D, value: 0n, data: encodeFunctionData({ abi: abi.recovery, functionName: "revokeGuardianWithThreshold", args: [prev, list[i], 1n] }) });
    list.splice(i, 1);
  }
  return calls;
}

/** After a recovery: take every other key out of the burner's budget (Roles stays, ready for this phone). */
export function dropOtherBudgetsCalls(safe: Address, members: Address[], keep: Address): Call[] {
  const roles = rolesAddress(safe);
  const calls: Call[] = [];
  const list = [...members];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].toLowerCase() === keep.toLowerCase()) continue;
    const prev = i === 0 ? SENTINEL : list[i - 1];
    calls.push({ to: roles, value: 0n, data: encodeFunctionData({ abi: abi.roles, functionName: "assignRoles", args: [list[i], [ROLE_BURNER], [false]] }) });
    calls.push({ to: roles, value: 0n, data: encodeFunctionData({ abi: abi.roles, functionName: "disableModule", args: [prev, list[i]] }) });
    list.splice(i, 1);
  }
  return calls;
}

export const SENTINEL: Address = "0x0000000000000000000000000000000000000001";

export function prevOwner(owners: Address[], owner: Address): Address {
  const i = owners.findIndex(o => o.toLowerCase() === owner.toLowerCase());
  if (i < 0) throw new Error("not an owner");
  return i === 0 ? SENTINEL : owners[i - 1];
}
