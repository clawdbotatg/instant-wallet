import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Trace files from this folder only: the repo also holds foundry libs and firmware (v2's Vercel build
  // died tracing the whole monorepo).
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
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
