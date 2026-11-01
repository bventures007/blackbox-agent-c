import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.js";

export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/backend/unit/**/*.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 30_000 },
});
