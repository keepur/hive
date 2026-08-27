import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// KPR-407 (Ruling 1d): the strings guard scans pkg/types/**/*.d.ts as well as
// pkg/*.min.js. Exercised end-to-end by running the real script against a
// fixture cwd — the script reads "pkg" relative to cwd.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-bundle-strings.mjs");

/** Run the guard in `cwd`; returns exit status and combined output. */
function runGuard(cwd: string): { status: number; output: string } {
  try {
    const stdout = execFileSync("node", [SCRIPT], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeFixture(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

describe("check-bundle-strings", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "check-bundle-strings-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes on a clean pkg/ with bundles and declarations", () => {
    writeFixture(tmp, {
      "pkg/server.min.js": "console.log('clean');\n",
      "pkg/mcp/task.min.js": "console.log('clean');\n",
      "pkg/types/agents/provider-adapters/provider-abi.d.ts": "export declare const LANE_B_PROVIDER_ABI_VERSION = 1;\n",
      "pkg/types/agents/provider-adapters/types.d.ts": "export interface AgentProviderAdapter {}\n",
    });

    const { status, output } = runGuard(tmp);

    expect(status).toBe(0);
    expect(output).toContain("2 bundle file(s) + 2 declaration file(s) clean");
  });

  it("fails when a shipped declaration carries a forbidden string", () => {
    writeFixture(tmp, {
      "pkg/server.min.js": "console.log('clean');\n",
      "pkg/types/agents/provider-adapters/provider-abi.d.ts": "export declare const LANE_B_PROVIDER_ABI_VERSION = 1;\n",
      // tsc preserves JSDoc into declarations — this is the leak class KPR-407 closed.
      "pkg/types/types/agent-definition.d.ts":
        "/** e.g. `metadata.dodiOpsMode` */\nexport interface AgentDefinition {}\n",
    });

    const { status, output } = runGuard(tmp);

    expect(status).toBe(1);
    expect(output).toContain("pkg/types/types/agent-definition.d.ts");
    expect(output).toContain('occurrence(s) of "dodi"');
  });

  it("still fails on a forbidden string in a minified bundle", () => {
    writeFixture(tmp, {
      "pkg/server.min.js": 'console.log("hubspot");\n',
      "pkg/types/agents/provider-adapters/provider-abi.d.ts": "export declare const LANE_B_PROVIDER_ABI_VERSION = 1;\n",
    });

    const { status, output } = runGuard(tmp);

    expect(status).toBe(1);
    expect(output).toContain('occurrence(s) of "hubspot"');
  });
});
