import { NextRequest, NextResponse } from "next/server";
import { isLocalHost } from "@/lib/local";

/**
 * Settings → No external traffic (lib/noext.ts), on a copy on your own computer: the page may talk to this copy only
 * (it reads your node through it). Pictures from elsewhere come through /api/local/img (over Tor). The browser
 * enforces it, so a link or a script we missed can't reach out either.
 */
// your own copy of the apps (run-local.sh: https://local.instantwallet.io:4174), the one other address the page may
// frame and read a manifest from. Only a local name: an apps address anywhere else stays blocked.
const APPS = (() => {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_APPS_URL || "");
    return isLocalHost(u.hostname) ? ` ${u.origin}` : "";
  } catch {
    return "";
  }
})();
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${APPS}`,
  "worker-src 'self' blob:",
  `frame-src 'self'${APPS}`,
  "form-action 'self'",
].join("; ");

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (req.cookies.get("iw_noext")?.value === "1" && isLocalHost((req.headers.get("host") || "").split(":")[0])) res.headers.set("Content-Security-Policy", CSP);
  return res;
}

// runs only for a browser with the cookie (set by this copy's /api/local/noext): never on our site's requests
export const config = { matcher: [{ source: "/((?!_next/static|_next/image).*)", has: [{ type: "cookie", key: "iw_noext", value: "1" }] }] };
