import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, parseAbi } from "viem";
import { chainById, nativeSymbol } from "../chains";
import { short } from "../format";
import { KEY_ETH, KEY_FEE_USDC, KEY_USDC, MODULE_FACTORY, MULTICALL3, MULTISEND_CALL_ONLY, MULTISEND_UNWRAPPER, RECOVERY_DAYS, ROLE_BURNER, ROLES_MASTERCOPY } from "./config";
import { type Call, type SafeTx, abi, rolesAddress } from "./core";
import { unpackMultiSend } from "./fee";
import { UNIVERSAL_ROUTERS } from "clear-signing-safe-kit";

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

/** A line that starts with this is a warning: the page shows it red (the wedgie's red). */
export const WARN = "⚠️ ";
export const RELAY = "0x4cfab32186e65e2a39ec0e882e11380cbf2f8a2f"; // the relayer the fee rule names (wedgie-safe safe_book RELAY)
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const UNISWAP = UNIVERSAL_ROUTERS;
const MAX = 2n ** 160n - 1n; // Permit2's "any amount" is uint160; an ERC-20's is uint256 (anything this big counts)
const guardAbi = parseAbi(["function setGuard(address guard)", "function setFallbackHandler(address handler)"]);
const permit2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const who = (a: string) => (UNISWAP.some(u => eq(u, a)) ? "Uniswap" : eq(a, PERMIT2) ? "Permit2 (Uniswap's approvals)" : short(a));

/** What this call pays the relay (its fee, checked to the byte): the token ("eth" = the coin, else its lowercase
 * address) and amount, or null. */
export function relayFee(chainId: number, c: Call): { token: string; amount: bigint; symbol: string; decimals: number } | null {
  if (c.data === "0x") return eq(c.to, RELAY) ? { token: "eth", amount: c.value, symbol: nativeSymbol(chainId), decimals: 18 } : null;
  const usdc = chainById(chainId)?.usdc;
  const t = usdc && eq(c.to, usdc) ? dec(abi.erc20, c.data) : null;
  return t?.functionName === "transfer" && eq(t.args[0], RELAY) ? { token: usdc!.toLowerCase(), amount: t.args[1], symbol: "USDC", decimals: 6 } : null;
}

/** The calls we can say better than a registry descriptor: the relay's fee (checked to the byte, so a look-alike
 * address can't pass as it), approvals, a Uniswap swap. null: anything else. */
export function ours(chainId: number, c: Call): string | null {
  const usdc = chainById(chainId)?.usdc;
  const coin = (t: string) => (usdc && eq(t, usdc) ? "USDC" : `token ${short(t)}`);
  if (c.data === "0x") return eq(c.to, RELAY) ? `Network fee: ${formatUnits(c.value, 18)} ${nativeSymbol(chainId)}` : null;
  const sel = c.data.slice(0, 10).toLowerCase();
  const t = dec(abi.erc20, c.data);
  if (t?.functionName === "transfer" && eq(t.args[0], RELAY)) return usdc && eq(c.to, usdc) ? `Network fee: ${formatUnits(t.args[1], 6)} USDC` : null;
  if (t?.functionName === "approve") {
    const [sp, amt] = t.args as [Address, bigint];
    if (amt === 0n) return `Stop ${who(sp)} spending your ${coin(c.to)}`;
    return `Let ${who(sp)} spend ${amt >= MAX ? "any amount of" : usdc && eq(c.to, usdc) ? `up to ${formatUnits(amt, 6)}` : "some of"} your ${coin(c.to)}`;
  }
  if (eq(c.to, PERMIT2) && sel === "0x87517c45") {
    const p = dec(permit2, c.data);
    if (!p) return null;
    const [tok, sp, amt] = p.args as [Address, Address, bigint];
    return `Let ${who(sp)} spend ${amt >= MAX ? "any amount of" : usdc && eq(tok, usdc) ? `up to ${formatUnits(amt, 6)}` : "some of"} your ${coin(tok)}`;
  }
  return null;
}

/** One call, in words: a coin sent, a limit or signer change, else the contract and function. */
export function describe(chainId: number, safe: Address, c: Call): string {
  const d = c.data;
  const sel = d.slice(0, 10).toLowerCase();
  const sym = nativeSymbol(chainId);
  const usdc = chainById(chainId)?.usdc;
  const o = ours(chainId, c);
  if (o) return o;
  // the words with amounts come from the server (/api/explain, lib/safe/urWords.ts); this is the fallback
  if (sel === "0x3593564c" || sel === "0x24856bc3") return UNISWAP.some(u => eq(u, c.to)) ? "Swap on Uniswap" : `Swap through ${short(c.to)}`;
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
        if (eq(a[0], rolesAddress(safe))) return "Turn on the daily limit";
        return RECOVERY_DAYS[getAddress(a[0])] ? `Turn on ${RECOVERY_DAYS[getAddress(a[0])]}-day recovery` : `Turn on module ${short(a[0])}`;
      case "disableModule":
        return RECOVERY_DAYS[getAddress(a[1])] ? `Turn off ${RECOVERY_DAYS[getAddress(a[1])]}-day recovery` : `Turn off module ${short(a[1])}`;
    }
    if (sel === "0xe19a9dd9") return `Set a guard (${short(dec(guardAbi, d)?.args[0] ?? "?")})`;
    if (sel === "0xf08a0323") return `Set a fallback handler (${short(dec(guardAbi, d)?.args[0] ?? "?")})`;
    return `${WARN}Change the wallet (${sel})`;
  }

  if (eq(c.to, rolesAddress(safe))) return roles(c, sym, usdc);
  if (eq(c.to, MODULE_FACTORY)) {
    const m = dec(abi.moduleFactory, d);
    const init = encodeFunctionData({ abi: abi.roles, functionName: "setUp", args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])] });
    if (m && eq(m.args[0], ROLES_MASTERCOPY) && eq(m.args[1], init) && m.args[2] === 0n) return "Set up the daily limit";
  }

  if (RECOVERY_DAYS[getAddress(c.to)]) {
    const g = dec(abi.recovery, d);
    const days = RECOVERY_DAYS[getAddress(c.to)];
    if (g?.functionName === "addGuardianWithThreshold") return `Add recovery address ${short(g.args[0])} (${days}-day wait)`;
    if (g?.functionName === "revokeGuardianWithThreshold") return `Remove recovery address ${short(g.args[1])} (${days}-day wait)`;
  }

  return `Call ${short(c.to)} (${sel})${c.value ? ` with ${formatUnits(c.value, 18)} ${sym}` : ""}`;
}

/**
 * Zodiac Roles (the daily limit), in words, with the wedgie's own checks (wedgie-safe safe_read.py _roles/_rule,
 * audit 10-18): only Instant Wallet's role and keys, more than a day's spend at once, rules that aren't ours.
 */
function roles(c: Call, sym: string, usdc?: Address): string {
  const r = dec(abi.roles, c.data);
  const a = r?.args ?? [];
  const what = (t: Address) => (usdc && eq(t, usdc) ? "USDC" : eq(t, MULTICALL3) ? `${sym} sends` : short(t));
  const ours = (role: Hex) => eq(role, ROLE_BURNER);
  switch (r?.functionName) {
    case "setAllowance": {
      const [key, bal, most, refill, per] = a as [Hex, bigint, bigint, bigint, bigint];
      const lim = eq(key, KEY_USDC) ? ["Daily limit", 6, "USDC"] : eq(key, KEY_ETH) ? ["Daily limit", 18, sym] : eq(key, KEY_FEE_USDC) ? ["Fee limit", 6, "USDC"] : null;
      if (!lim) return `${WARN}A limit of ${refill}: of what? Can't tell`;
      const [name, d, s] = lim as [string, number, string];
      const amt = (n: bigint) => `${formatUnits(n, d)} ${s}`;
      if (bal > refill || most !== refill) return `${WARN}${name}: ${amt(bal > most ? bal : most)} can go at once, then ${amt(refill)}`;
      return per === 86_400n ? `${name}: ${amt(refill)} a day` : `${WARN}${name}: ${amt(refill)} every ${per}s`;
    }
    case "assignRoles": {
      const [mod, keys, on] = a as [Address, Hex[], boolean[]];
      if (keys.length !== 1 || on.length !== 1 || !ours(keys[0])) return `${WARN}Changes roles: can't read it`;
      return on[0] ? `Let ${short(mod)} spend the daily limit` : `${WARN}Stop ${short(mod)} spending the daily limit`;
    }
    case "enableModule":
      return `Turn on the daily limit for ${short(a[0])}`;
    case "disableModule":
      return `${WARN}Turn off the daily limit for ${short(a[1])}`;
    case "scopeTarget":
      if (!ours(a[0])) return `${WARN}Another role: can't read it`;
      return usdc && eq(a[1], usdc)  || eq(a[1], MULTICALL3) ? `Daily limit can spend ${what(a[1])}` : `${WARN}Daily limit can spend ${what(a[1])}`;
    case "revokeTarget":
      if (!ours(a[0])) return `${WARN}Another role: can't read it`;
      return `${WARN}Daily limit can't spend ${what(a[1])}`;
    case "scopeFunction":
      if (!ours(a[0])) return `${WARN}Another role: can't read it`;
      return rule(a as any, usdc, sym) ?? `${WARN}A daily-limit rule for ${what(a[1])}: can't read it`;
    case "setTransactionUnwrapper":
      return eq(a[0], MULTISEND_CALL_ONLY) && eq(a[1], "0x8d80ff0a") && eq(a[2], MULTISEND_UNWRAPPER)
        ? "Daily limit works in batches"
        : `${WARN}Daily limit reads batches with ${short(a[2])}`;
  }
  return `${WARN}Changes the daily limit: can't read it`;
}

type Cond = { parent: number; paramType: number; operator: number; compValue: Hex };
/** The rules Instant Wallet sets for the daily limit's USDC and ETH (core.ts budgetCalls/feeAllowanceCalls), or null. */
function rule([, target, sel, conds, opt]: [Hex, Address, Hex, readonly Cond[], number], usdc: Address | undefined, sym: string): string | null {
  // ExecutionOptions: 0 none, 1 send ETH; 2/3 delegatecall would let the key run any code as the Safe
  if (opt !== (eq(target, MULTICALL3) ? 1 : 0)) return null;
  const c = conds.map(x => [x.parent, x.paramType, x.operator, x.compValue === "0x" ? "" : x.compValue.slice(2).toLowerCase()].join());
  const k = (h: Hex) => h.slice(2).toLowerCase();
  const is = (want: (string | number)[][]) => c.length === want.length && want.every((w, i) => w.join() === c[i]);
  if (eq(sel, "0xa9059cbb")) {
    if (!usdc || !eq(target, usdc)) return null;
    if (is([[0, 5, 5, ""], [0, 1, 0, ""], [0, 1, 28, k(KEY_USDC)]])) return "Daily limit: USDC to anyone";
    const fee = conds[3];
    if (
      c.length === 7 &&
      is([[0, 0, 2, ""], [0, 5, 5, ""], [0, 5, 5, ""], [1, 1, 16, k(fee.compValue)], [1, 1, 28, k(KEY_FEE_USDC)], [2, 1, 0, ""], [2, 1, 28, k(KEY_USDC)]]) &&
      fee.compValue.length === 66
    ) {
      const to = `0x${fee.compValue.slice(26)}`;
      return eq(to, RELAY) ? "Fees get their own limit" : `${WARN}Fees to ${short(to as Address)} get their own limit`;
    }
    return null;
  }
  if (eq(target, MULTICALL3) && eq(sel, "0x174dea71") && is([[0, 5, 5, ""], [0, 4, 0, ""], [0, 0, 29, k(KEY_ETH)], [1, 3, 0, ""], [3, 1, 0, ""], [3, 1, 0, ""], [3, 1, 0, ""], [3, 2, 0, ""]]))
    return `Daily limit: ${sym} to anyone`;
  return null;
}
