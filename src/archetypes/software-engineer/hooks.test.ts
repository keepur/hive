import { describe, it, expect } from "vitest";
import { preToolUseHooks } from "./hooks.js";
import type { SoftwareEngineerConfig } from "./config.js";
import type { AgentConfig } from "../../types/agent-config.js";

const cfg: SoftwareEngineerConfig = {
  workshop: "/Users/mokie/dev",
  workspaces: [{ name: "dodi_v2", path: "/Users/mokie/dev/dodi_v2", tracker: { type: "linear", project: "DOD" } }],
};

const agentConfig = { id: "vp-engineering", name: "Jasper" } as AgentConfig;

function makeCtx(overrides?: Partial<SoftwareEngineerConfig>) {
  return {
    agentConfig,
    archetypeConfig: { ...cfg, ...overrides },
  };
}

async function runHook(toolName: string, filePath: string, archetypeConfig?: SoftwareEngineerConfig) {
  const matchers = preToolUseHooks(makeCtx(archetypeConfig));
  if (matchers.length === 0) return { continue: true };
  const hook = matchers[0].hooks[0];
  return hook({ tool_name: toolName, tool_input: { file_path: filePath } } as any, "", {} as any);
}

describe("preToolUseHooks", () => {
  it("returns empty array when no workspaces configured", () => {
    const matchers = preToolUseHooks(makeCtx({ workspaces: [] }));
    expect(matchers).toEqual([]);
  });

  // ── Blocked tools inside workspace ─────────────────────────────────

  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    it(`denies ${tool} on a file inside a workspace`, async () => {
      const result = await runHook(tool, "/Users/mokie/dev/dodi_v2/src/index.ts");
      expect(result).toHaveProperty("hookSpecificOutput");
      const output = (result as any).hookSpecificOutput;
      expect(output.permissionDecision).toBe("deny");
      expect(output.permissionDecisionReason).toContain("dodi_v2");
      expect(output.permissionDecisionReason).toContain("code_task");
    });
  }

  // ── Allowed tools ──────────────────────────────────────────────────

  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    it(`allows ${tool} on a file in workshop but outside workspaces`, async () => {
      const result = await runHook(tool, "/Users/mokie/dev/scratch.ts");
      expect(result).toEqual({ continue: true });
    });
  }

  it("allows non-blocked tools (Read) inside workspace", async () => {
    const result = await runHook("Read", "/Users/mokie/dev/dodi_v2/src/index.ts");
    expect(result).toEqual({ continue: true });
  });

  it("allows Bash (not hooked)", async () => {
    const result = await runHook("Bash", "/Users/mokie/dev/dodi_v2");
    expect(result).toEqual({ continue: true });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it("allows tools on files outside workshop entirely", async () => {
    const result = await runHook("Edit", "/tmp/scratch.ts");
    expect(result).toEqual({ continue: true });
  });

  it("denies Edit on workspace root path itself", async () => {
    const result = await runHook("Edit", "/Users/mokie/dev/dodi_v2");
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
  });

  it("handles missing file_path gracefully (allows)", async () => {
    const matchers = preToolUseHooks(makeCtx());
    const hook = matchers[0].hooks[0];
    const result = await hook({ tool_name: "Edit", tool_input: {} } as any, "", {} as any);
    expect(result).toEqual({ continue: true });
  });

  // ── NotebookEdit with notebook_path ────────────────────────────────

  it("extracts notebook_path for NotebookEdit", async () => {
    const matchers = preToolUseHooks(makeCtx());
    const hook = matchers[0].hooks[0];
    const result = await hook(
      { tool_name: "NotebookEdit", tool_input: { notebook_path: "/Users/mokie/dev/dodi_v2/nb.ipynb" } } as any,
      "",
      {} as any,
    );
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
  });

  // ── Fail-closed on internal error ──────────────────────────────────

  it("denies on internal error (fail-closed)", async () => {
    // Craft a config that will make findWorkspace throw
    const badCfg: SoftwareEngineerConfig = {
      workshop: "/Users/mokie/dev",
      workspaces: [
        // @ts-expect-error — intentionally bad: path is a number to cause a throw
        { name: "bad", path: 12345, tracker: { type: "linear", project: "X" } },
      ],
    };
    const matchers = preToolUseHooks({ agentConfig, archetypeConfig: badCfg });
    const hook = matchers[0].hooks[0];
    const result = await hook(
      { tool_name: "Edit", tool_input: { file_path: "/Users/mokie/dev/anything.ts" } } as any,
      "",
      {} as any,
    );
    const output = (result as any).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("internal error");
  });
});
