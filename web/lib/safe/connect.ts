import { type Address, type Hex, concat, encodeAbiParameters, encodeFunctionData } from "viem";
import { publicClient } from "../chains";
import { RECOVERY_MODULES, MULTICALL3 } from "./config";
import { type Call, type Sig, abi, deploySafeCall, deploySignerCall, encodeSignatures, rolesAddress, safeMessageHash } from "./core";
import { hotSignMessage } from "./hot";
import { type Signer, type Stage } from "./send";
import { passkeySign } from "./sign";
import { type ChainState, type SafeAccount, hotOf, wedgieSigners } from "./state";
import { Wedgie, wedgieSupported } from "./wedgie";

/**
 * The Safe wallet as a WalletConnect wallet (the connection itself is lib/walletconnect.ts, shared with v3):
 *   calls    → one owner-signed Safe batch (+ the relay's fee), the same keys as a big send
 *   messages → an ERC-1271 signature the Safe's fallback handler checks (Face ID, + the hot wallet when the wallet
 *              needs two keys); ERC-6492-wrapped while the Safe (or this phone's signer) isn't on that chain yet.
 *              The wedgie signs a text message (personal_sign: it shows the text, works out the hash itself);
 *              typed data it can't show yet, so it won't sign that.
 */

/** A site's calls as Safe calls. Never into the wallet's own guts: its owners, guard, modules, budget, recovery. */
export function siteCalls(safe: Address, calls: { target: Address; value: bigint; data: Hex }[]): Call[] {
  const own = [safe, rolesAddress(safe), ...RECOVERY_MODULES].map(a => a.toLowerCase());
  return calls.map(c => {
    if (own.includes(c.target.toLowerCase())) throw new Error("A site can't change your wallet's keys or settings.");
    return { to: c.target, value: c.value, data: c.data };
  });
}

/** The site's calls' own gas (each estimated from the wallet, +30%); a call that can't be estimated alone counts 300k. */
export async function siteGas(chainId: number, safe: Address, calls: Call[]): Promise<bigint> {
  const pc = publicClient(chainId);
  const each = await Promise.all(
    calls.map(c => pc.estimateGas({ account: safe, to: c.to, value: c.value, data: c.data }).catch(() => 300_000n)),
  );
  return (each.reduce((t, g) => t + g, 0n) * 13n) / 10n;
}

/** Sign `hash` (what the site asked: EIP-191 or EIP-712) for the Safe. `raw`: a personal_sign's bytes, which the
 * wedgie needs to show the text (typed data has none: the wedgie won't sign it). */
export async function signForSite(
  a: SafeAccount,
  st: ChainState,
  signers: Signer[],
  hash: Hex,
  onStage?: (s: Stage) => void,
  raw?: Hex,
  wedgie?: Wedgie | null,             // connected already, on the tap (the caller closes it)
): Promise<Hex> {
  const chainId = st.chainId;
  const h = safeMessageHash(chainId, a.address, hash);
  const sigs: Sig[] = [];
  if (signers.includes("wedgie")) {
    if (!raw) throw new Error("The wedgie can't show this kind of message (typed data) yet, so it won't sign it.");
    if (!wedgieSupported()) throw new Error("With the wedgie, connect the site on your computer or in the Instant Wallet app.");
  }
  let w: Wedgie | null = null;
  try {
    for (const s of [...signers].sort((x, y) => (x === "burner" ? -1 : y === "burner" ? 1 : 0))) {
      if (s === "burner") {
        onStage?.("signing");
        sigs.push(await passkeySign(a.credentialId, a.burnerSigner, h));
      } else if (s === "hot") {
        const hot = hotOf(a, st);
        if (!hot) throw new Error("No hot wallet on this wallet yet.");
        onStage?.("signing-hot");
        sigs.push(await hotSignMessage(chainId, a.address, hash, hot));
      } else {
        const ww = wedgie ?? (w = await Wedgie.connect());
        const key = a.wedgie ?? (await ww.key());
        onStage?.("signing-wedgie");
        sigs.push(...(await ww.signMessage(chainId, a.address, raw!, h, wedgieSigners(key))));
      }
    }
  } finally {
    await w?.close();
  }
  const sig = encodeSignatures(sigs);
  // the Safe and this phone's passkey signer must exist for a site to check it: deploy them inside the signature
  const pc = publicClient(chainId);
  const pre: Call[] = [];
  if (signers.includes("burner")) {
    const code = await pc.getCode({ address: a.burnerSigner }).catch(() => undefined);
    if (!code || code === "0x") pre.push(deploySignerCall(a.qx, a.qy));
  }
  if (!st.deployed && !a.recovered) pre.push(deploySafeCall(a.burnerSigner));
  if (!pre.length) return sig;
  const deploy = encodeFunctionData({
    abi: abi.multicall3,
    functionName: "aggregate3",
    args: [pre.map(c => ({ target: c.to, allowFailure: true, callData: c.data }))],
  });
  return concat([
    encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [MULTICALL3, deploy, sig]),
    "0x6492649264926492649264926492649264926492649264926492649264926492",
  ]);
}
