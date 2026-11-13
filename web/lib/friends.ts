import type { Address, Hex } from "viem";
import { assertChallenge } from "./passkey";
import { friendChallenge, signerAddress } from "./safe/core";

/**
 * Tell this wallet's other devices that a signer is a person, not a wedgie (app/api/safe/signers): one Face ID.
 * On chain the two look the same, so without this another device draws an invited signer as a wedgie. Throws with why not.
 */
export async function publishFriend(account: { credentialId: string; address: Address; qx: Hex; qy: Hex }, k: { x: Hex; y: Hex }, name?: string): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const n = (name ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40); // as the server cleans it: both sign the same words
  const a = await assertChallenge(account.credentialId, friendChallenge(account.address, signerAddress(k.x, k.y), n, ts));
  const hex = (u: Uint8Array) => "0x" + Array.from(u, b => b.toString(16).padStart(2, "0")).join("");
  const r = await fetch("/api/safe/signers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address, x: k.x, y: k.y, name: n, ts, qx: account.qx, qy: account.qy, r: a.r, s: a.s, authenticatorData: hex(a.authenticatorData), clientDataJSON: new TextDecoder().decode(a.clientDataJSON) }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "Couldn't save that. Try again.");
}
