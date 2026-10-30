import { type Address, keccak256, toBytes } from "viem";
import { base64urlToBytes, bytesToBase64url } from "./webauthn";

/**
 * The wallet's name, synced to every device its passkey syncs to (app/api/name). Only those devices know the
 * credential id, so the id we store under and the AES key both come from it: the server sees neither the name nor
 * which wallet it belongs to. This is how a rename in desktop Chrome reaches the phone, whose browser can then
 * rename the passkey in Apple Passwords (Chrome can't).
 *
 * A cleared name is stored as null, so clearing it reaches the other devices too.
 */
type Named = { n: string | null };

async function ids(credentialId: string, address: Address) {
  const id = keccak256(toBytes(`instant-wallet name id\n${credentialId}\n${address.toLowerCase()}`));
  const raw = await crypto.subtle.digest("SHA-256", toBytes(`instant-wallet name key\n${credentialId}`) as BufferSource);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id, key };
}

/** The name the other devices saved: a string, null (cleared), or undefined (none saved, or offline). */
export async function pullWalletName(credentialId: string, address: Address): Promise<string | null | undefined> {
  try {
    const { id, key } = await ids(credentialId, address);
    const j = await fetch(`/api/name?id=${id}`, { cache: "no-store" }).then(r => r.json());
    if (typeof j?.box !== "string") return undefined;
    const box = base64urlToBytes(j.box);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.slice(0, 12) as BufferSource }, key, box.slice(12) as BufferSource);
    const v = JSON.parse(new TextDecoder().decode(plain)) as Named;
    return typeof v.n === "string" ? v.n : null;
  } catch {
    return undefined;
  }
}

export async function pushWalletName(credentialId: string, address: Address, name: string | null): Promise<void> {
  try {
    const { id, key } = await ids(credentialId, address);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toBytes(JSON.stringify({ n: name } satisfies Named)) as BufferSource));
    const box = new Uint8Array(12 + ct.length);
    box.set(iv, 0);
    box.set(ct, 12);
    await fetch("/api/name", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, box: bytesToBase64url(box) }) });
  } catch {}
}
