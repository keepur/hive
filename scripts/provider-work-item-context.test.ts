import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("KPR-453: published WorkItemContext accepts old and enriched callers", () => {
  const require = createRequire(import.meta.url);
  const fixture = fileURLToPath(new URL("../test-fixtures/provider-abi/work-item-context.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "Node16",
      "--moduleResolution",
      "Node16",
      "--esModuleInterop",
      "--skipLibCheck",
      fixture,
    ],
    { encoding: "utf8", timeout: 45_000 },
  );
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
