import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Trace files from this folder only: the repo also holds foundry libs and firmware (v2's Vercel build
  // died tracing the whole monorepo).
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
  // Vercel sends `Access-Control-Allow-Origin: *` on static pages by default; only our own site may read us
  // (Coinbase Onramp's security requirements).
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "https://instantwallet.io" }] }];
  },
  // the Safe build moved from /safe to / (2026-10-06); the v3 wallet is at /v3
  async redirects() {
    return [
      { source: "/safe", destination: "/", permanent: false },
      { source: "/safe/paper", destination: "/paper", permanent: false },
      { source: "/safe/recover", destination: "/recover", permanent: false },
    ];
  },
};

export default config;
