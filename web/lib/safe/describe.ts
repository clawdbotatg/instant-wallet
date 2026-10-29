import { type Address, type Hex, decodeFunctionData, formatUnits, getAddress } from "viem";
import { chainById, nativeSymbol } from "../chains";
import { short } from "../format";
import { KEY_ETH, KEY_FEE_USDC, KEY_USDC, MULTISEND_CALL_ONLY, RECOVERY_DAYS } from "./config";
import { type Call, type SafeTx, abi, rolesAddress } from "./core";
import { unpackMultiSend } from "./fee";

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dec = (a: any, data: Hex) => {
  try {
    return decodeFunctionData({ abi: a, data }) as { functionName: string; args: any[] };
  } catch {
    return null;
  }
};

/** The calls a Safe tx makes: a MultiSend batch opened up, or the one. */
export function callsOf(tx: Pick<SafeTx, "to" | "value" | "data" | "operation">): Call[] {
  if (eq(tx.to, MULTISEND_CALL_ONLY) && tx.operation === 1) {
    try {
      return unpackMultiSend(tx.data);
    } catch {
      return [];
    }
  }
  return [{ to: tx.to, value: tx.value, data: tx.data }];
}

/** One call, in words: a coin sent, a limit or signer change, else the contract and function. */
export function describe(chainId: number, safe: Address, c: Call): string {
  const d = c.data;
  const sel = d.slice(0, 10).toLowerCase();
  const sym = nativeSymbol(chainId);
  const usdc = chainById(chainId)?.usdc;
  if (d === "0x") return `Send ${formatUnits(c.value, 18)} ${sym} to ${short(c.to)}`;

  const t = dec(abi.erc20, d);
  if (t?.functionName === "transfer") {
    const [to, amt] = t.args as [Address, bigint];
    return usdc && eq(c.to, usdc) ? `Send ${formatUnits(amt, 6)} USDC to ${short(to)}` : `Send ${amt} of token ${short(c.to)} to ${short(to)}`;
  }

  if (eq(c.to, safe)) {
    const s = dec(abi.safe, d);
    const a = s?.args ?? [];
    switch (s?.functionName) {
      case "addOwnerWithThreshold":
        return `Add signer ${short(a[0])}, need ${a[1]} signatures`;
      case "removeOwner":
        return `Remove signer ${short(a[1])}, need ${a[2]} signatures`;
      case "changeThreshold":
        return `Need ${a[0]} signatures`;
      case "swapOwner":
        return `Swap signer ${short(a[1])} for ${short(a[2])}`;
      case "enableModule":
        return RECOVERY_DAYS[getAddress(a[0])] ? `Turn on ${RECOVERY_DAYS[getAddress(a[0])]}-day recovery` : `Turn on module ${short(a[0])}`;
      case "disableModule":
        return RECOVERY_DAYS[getAddress(a[1])] ? `Turn off ${RECOVERY_DAYS[getAddress(a[1])]}-day recovery` : `Turn off module ${short(a[1])}`;
    }
    return `Change the wallet (${sel})`;
  }

  if (eq(c.to, rolesAddress(safe))) {
    const r = dec(abi.roles, d);
    const a = r?.args ?? [];
    switch (r?.functionName) {
      case "setAllowance":
        if (eq(a[0], KEY_USDC)) return `Daily limit: ${formatUnits(a[1], 6)} USDC`;
        if (eq(a[0], KEY_ETH)) return `Daily limit: ${formatUnits(a[1], 18)} ${sym}`;
        if (eq(a[0], KEY_FEE_USDC)) return `Fee budget: ${formatUnits(a[1], 6)} USDC a day`;
        return `Set an allowance to ${a[1]}`;
      case "scopeFunction":
        return usdc && eq(a[1], usdc) ? "Fees come out of the fee budget, not your daily limit" : `Set a spending rule on ${short(a[1])}`;
      case "assignRoles":
        return a[2]?.[0] ? `Let ${short(a[0])} spend the daily limit` : `Stop ${short(a[0])} spending the daily limit`;
      case "disableModule":
        return `Remove ${short(a[1])} from the daily limit`;
      case "enableModule":
        return `Add ${short(a[0])} to the daily limit`;
    }
    return `Change the daily limit rules (${sel})`;
  }

  if (RECOVERY_DAYS[getAddress(c.to)]) {
    const g = dec(abi.recovery, d);
    const days = RECOVERY_DAYS[getAddress(c.to)];
    if (g?.functionName === "addGuardianWithThreshold") return `Add recovery address ${short(g.args[0])} (${days}-day wait)`;
    if (g?.functionName === "revokeGuardianWithThreshold") return `Remove recovery address ${short(g.args[1])} (${days}-day wait)`;
  }

  return `Call ${short(c.to)} (${sel})${c.value ? ` with ${formatUnits(c.value, 18)} ${sym}` : ""}`;
}
