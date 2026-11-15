import "server-only";
import { createHash } from "node:crypto";
import { kv } from "./kv";

export const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";

/**
 * True when this IP has asked for `name` more than `max` times in `sec` seconds. For routes anyone can call that
 * cost us money or storage. The limits sit far above what a person does (a room on one Wi-Fi shares an IP).
 * If the store is down, nobody is limited: the route keeps working.
 */
export async function tooMany(req: Request, name: string, max: number, sec: number): Promise<boolean> {
  const k = `iws:lim:${name}:${ipOf(req)}`;
  try {
    await kv(["SET", k, 0, "EX", sec, "NX"]); // the life first, then the count: a counter is never left without a life
    return Number(await kv(["INCR", k])) > max;
  } catch {
    return false;
  }
}

/**
 * The same count, by a key of our choosing instead of the caller's IP (an email address: however many callers ask,
 * one address gets only so much mail). The key is kept as its hash, never as it is.
 */
export async function tooManyOf(name: string, key: string, max: number, sec: number): Promise<boolean> {
  const k = `iws:lim:${name}:${createHash("sha256").update(key.trim().toLowerCase()).digest("hex").slice(0, 32)}`;
  try {
    await kv(["SET", k, 0, "EX", sec, "NX"]);
    return Number(await kv(["INCR", k])) > max;
  } catch {
    return false;
  }
}
