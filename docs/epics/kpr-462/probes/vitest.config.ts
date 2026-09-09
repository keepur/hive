import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["docs/epics/kpr-462/probes/kpr-464-http-reproduction.test.ts"],
    environment: "node",
    testTimeout: 10000,
  },
});
