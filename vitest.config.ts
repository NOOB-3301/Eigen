import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { EIGEN_LOG_LEVEL: "silent" },
    testTimeout: 10_000,
  },
});
