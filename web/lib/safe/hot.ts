import { type Address, type Hex, getAddress } from "viem";
import { type SafeTx, type Sig, ecdsaSig, safeTxTypedData } from "./core";

/**
 * The hot wallet: MetaMask, Rainbow, any browser wallet (EIP-1193 `window.ethereum`). It only ever signs Safe
 * transactions as typed data; it never needs gas here (the relay sends).
 */
const eth = () => (typeof window === "undefined" ? undefined : (window as any).ethereum);
export const hotAvailable = () => !!eth();

export async function connectHot(): Promise<Address> {
  if (!eth()) throw new Error("No browser wallet here. Open this page in a browser with a wallet extension, or in your wallet app's browser.");
  const [a] = await eth().request({ method: "eth_requestAccounts" });
  return getAddress(a);
}

export async function hotSign(chainId: number, safe: Address, t: SafeTx, expect: Address): Promise<Sig> {
  const who = await connectHot();
  if (who.toLowerCase() !== expect.toLowerCase()) throw new Error(`Switch your wallet to ${expect} (it's on ${who}).`);
  // MetaMask refuses typed data for a chain other than the one it's on
  const want = "0x" + chainId.toString(16);
  const on = await eth().request({ method: "eth_chainId" }).catch(() => want);
  if (on !== want) await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  const typed = safeTxTypedData(chainId, safe, t);
  const sig = (await eth().request({ method: "eth_signTypedData_v4", params: [who, JSON.stringify(typed)] })) as Hex;
  return ecdsaSig(who, sig);
}
