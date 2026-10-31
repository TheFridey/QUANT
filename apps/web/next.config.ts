import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4318",
  },
  // UI item 13: former research sub-pages are tabs of /terminal/research; keep their links working.
  async redirects() {
    return ["operations", "forge", "genome", "integrity", "confidence", "memory"].map((tab) => ({
      source: `/terminal/${tab}`,
      destination: `/terminal/research?tab=${tab}`,
      permanent: false,
    }));
  },
};

export default nextConfig;
