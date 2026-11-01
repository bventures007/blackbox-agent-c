import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.js";

export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/backend/integration/**/*.test.ts"], environment: "node", testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: true, maxWorkers: 3 },
});
