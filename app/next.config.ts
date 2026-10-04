import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine ships TypeScript source (schema, paths, agent store); Next compiles it.
  transpilePackages: ["@eigen/engine"],
  // The studio is usually opened at http://127.0.0.1:4100; without this, dev assets/HMR are blocked for that origin.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
