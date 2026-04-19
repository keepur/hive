import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 10_000,
  },
});
