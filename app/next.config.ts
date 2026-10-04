import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine ships TypeScript source (schema, paths, agent store); Next compiles it.
  transpilePackages: ["@eigen/engine"],
  // The studio is usually opened at http://127.0.0.1:4100; without this, dev assets/HMR are blocked for that origin.
  allowedDevOrigins: ["127.0.0.1"],
  // Next 16 allows one `next dev` per output dir (lock in <distDir>/dev/lock). Parallel dev servers (tests, several checkouts) set their own.
  ...(process.env.EIGEN_NEXT_DIST_DIR && { distDir: process.env.EIGEN_NEXT_DIST_DIR }),
};

export default nextConfig;
