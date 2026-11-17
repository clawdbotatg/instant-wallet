import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Trace files from this folder only: the repo also holds foundry libs and firmware (v2's Vercel build
  // died tracing the whole monorepo).
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
  // tor-js loads its .wasm from beside its own file (lib/torServer.ts): leave it in node_modules, unbundled
  serverExternalPackages: ["tor-js"],
  // the commit this page was built from (/api/version says which one is live)
  env: { NEXT_PUBLIC_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
  // Vercel sends `Access-Control-Allow-Origin: *` on static pages by default; only our own site may read us
  // (Coinbase Onramp's security requirements).
  async headers() {
    // (/api/safe/queue sets its own: wedgie.dev/safe shares that queue)
    return [
      { source: "/:path((?!api/safe/queue).*)", headers: [{ key: "Access-Control-Allow-Origin", value: "https://instantwallet.io" }] },
      // No site may put the wallet in a frame (audit 11-13): a page could frame /tx/<chain>/<safe>#<tx> with a
      // decoy over Sign, and one Face ID signed it. The wallet frames its apps; nothing frames the wallet.
      { source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }, { key: "X-Frame-Options", value: "DENY" }] },
    ];
  },
  // the Safe build moved from /safe to / (2026-10-06)
  async redirects() {
    return [
      { source: "/safe", destination: "/", permanent: false },
      { source: "/safe/paper", destination: "/paper", permanent: false },
      { source: "/safe/recover", destination: "/recover", permanent: false },
    ];
  },
};

export default config;
