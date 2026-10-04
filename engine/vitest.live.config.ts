import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["live/**/*.test.ts"], testTimeout: 240_000, hookTimeout: 60_000, fileParallelism: false },
});
