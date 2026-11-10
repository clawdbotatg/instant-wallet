import "server-only";
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
