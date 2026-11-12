import type { Address, Hex } from "viem";
import { nameChallenge } from "./names";
import { assertChallenge } from "./passkey";

/** Take `label`.inst.eth for this wallet (or switch back to one it holds): one Face ID, then app/api/names. Throws with why not. */
export async function claimName(account: { credentialId: string; address: Address; qx: Hex; qy: Hex }, label: string): Promise<{ name: string; names: string[] }> {
  const ts = Math.floor(Date.now() / 1000);
  const a = await assertChallenge(account.credentialId, nameChallenge(account.address, label, ts));
  const hex = (u: Uint8Array) => "0x" + Array.from(u, b => b.toString(16).padStart(2, "0")).join("");
  const r = await fetch("/api/names", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, address: account.address, ts, qx: account.qx, qy: account.qy, r: a.r, s: a.s, authenticatorData: hex(a.authenticatorData), clientDataJSON: new TextDecoder().decode(a.clientDataJSON) }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.name) throw new Error(j?.error || "Couldn't save the name. Try again.");
  return j;
}
