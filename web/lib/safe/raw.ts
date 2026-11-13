import { type Address, type Hex, concat, getTypesForEIP712Domain, hashDomain, hashStruct, keccak256, numberToHex, size } from "viem";
import { type Call, type SafeTx, safeMessageHash, safeTxHash, safeTxTypedData } from "./core";

/**
 * The raw view under every signing screen (ERC-8213): the exact bytes and hashes, for anyone who wants to check
 * them against another tool or the wedgie. Shown only on a tap (<Raw>): the screen itself stays plain words.
 */
export type RawRow = { label: string; value: string };

/** ERC-8213's calldata digest: keccak256(uint256(length) ‖ calldata). */
export const calldataDigest = (data: Hex): Hex => keccak256(concat([numberToHex(size(data), { size: 32 }), data]));

/** The parts of an EIP-712 digest: keccak256(0x1901 ‖ domain hash ‖ message hash). */
export function typedParts(t: { domain?: any; types?: Record<string, any>; primaryType: string; message: any }): { domain: Hex; message: Hex } {
  const { EIP712Domain: _, ...types } = t.types ?? {};
  const domain = t.domain ?? {};
  return {
    domain: hashDomain({ domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }), ...types } }),
    message: hashStruct({ data: t.message, primaryType: t.primaryType, types }),
  };
}

/** A Safe tx's rows. `t` with its nonce: the hashes the keys sign too. Without (a sheet before the tap): the bytes. */
export function txRows(chainId: number, safe: Address, calls: Call[], t?: (Omit<SafeTx, "nonce"> & { nonce?: bigint }) | null): RawRow[] {
  const rows: RawRow[] = [];
  if (t && t.nonce !== undefined) {
    const full = t as SafeTx;
    const parts = typedParts(safeTxTypedData(chainId, safe, full));
    rows.push(
      { label: "Safe tx hash (EIP-712 digest)", value: safeTxHash(chainId, safe, full) },
      { label: "Domain hash", value: parts.domain },
      { label: "Message hash", value: parts.message },
    );
  }
  if (t) {
    rows.push(
      { label: "To", value: t.to },
      { label: "Value", value: t.value.toString() },
      { label: "Operation", value: t.operation === 1 ? "1 (delegatecall)" : "0 (call)" },
    );
    if (t.nonce !== undefined) rows.push({ label: "Nonce", value: t.nonce.toString() });
    rows.push({ label: "Data", value: t.data }, { label: "Calldata digest", value: calldataDigest(t.data) });
  }
  // each call inside the batch, as the site or the sheet made it
  calls.forEach((c, i) => {
    const n = calls.length > 1 || t ? `Call ${i + 1} ` : "";
    rows.push({ label: `${n}to`.trim(), value: c.to });
    if (c.value) rows.push({ label: `${n}value`.trim(), value: c.value.toString() });
    if (c.data !== "0x") rows.push({ label: `${n}data`.trim(), value: c.data }, { label: `${n}calldata digest`.trim(), value: calldataDigest(c.data) });
  });
  return rows.map(r => ({ ...r, label: r.label[0].toUpperCase() + r.label.slice(1) }));
}

/** A message's rows: what the site asked to be signed, then the Safe message hash the keys sign for it. */
export function messageRows(chainId: number, safe: Address, m: { hash: Hex; raw?: Hex; parts?: { domain: Hex; message: Hex } }): RawRow[] {
  const rows: RawRow[] = [];
  if (m.parts) rows.push({ label: "EIP-712 digest", value: m.hash }, { label: "Domain hash", value: m.parts.domain }, { label: "Message hash", value: m.parts.message });
  else {
    if (m.raw) rows.push({ label: "Message", value: m.raw });
    rows.push({ label: "Message hash (EIP-191)", value: m.hash });
  }
  rows.push({ label: "Safe message hash", value: safeMessageHash(chainId, safe, m.hash) });
  return rows;
}
