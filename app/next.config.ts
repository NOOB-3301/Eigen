import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine ships TypeScript source (schema, paths, agent store); Next compiles it.
  transpilePackages: ["@eigen/engine"],
};

export default nextConfig;
