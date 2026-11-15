/** Exactly 32 bytes of hex. A passkey's r, s, qx and qy are each this and nothing else. */
export const word32 = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * A P-256 key and signature as four 32-byte words. Anything else is refused before it is checked or remembered
 * (audit 11-13): the server glued r and s together, so the same 64 bytes cut at another place (r of 31 bytes, s of
 * 33) checked out again under a new "already used" key, and a used signature could be used again.
 */
export const keyAndSig = (o: { qx?: unknown; qy?: unknown; r?: unknown; s?: unknown } | null | undefined): boolean =>
  !!o && word32(o.qx) && word32(o.qy) && word32(o.r) && word32(o.s);
