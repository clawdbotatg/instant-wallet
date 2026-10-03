import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Trace files from this folder only: the repo also holds foundry libs and firmware (v2's Vercel build
  // died tracing the whole monorepo).
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
};

export default config;
