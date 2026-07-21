import { describe, expect, it } from "vitest";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import "../../archetypes/index.js"; // side-effect: registers software-engineer
import { getArchetype } from "../../archetypes/registry.js";
import type { ArchetypeDefinition } from "../../archetypes/registry.js";
import type { AgentConfig } from "../../types/agent-config.js";
import { buildArchetypeGuardrailGate } from "./archetype-gate.js";
import { buildDefaultGuardrailGate } from "./turn-assembly.js";

/**
 * KPR-348 Task 3 (Chunk 3): T2 — gate port parity. Proves the archetype
 * guardrail gate is a faithful port of buildHooks' PreToolUse evaluation:
 * same deny reasons (tool names are Claude-lane-identical, so the policy
 * transfers unmodified), first-deny-wins, throw-is-deny containment,
 * deny-all on assembly-time throw, archetype-less allow-all.
 */

// software-engineer archetypeConfig — copied from hooks.test.ts fixture shape
// (workshop root + one workspace under it). Pure path logic — no real dirs.
const WORKSHOP = "/Users/mokie/dev";
const WORKSPACE_PATH = "/Users/mokie/dev/dodi_v2";
const seConfig = {
  workshop: WORKSHOP,
  workspaces: [{ name: "dodi_v2", path: WORKSPACE_PATH, tracker: { type: "linear", project: "DOD" } }],
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "vp-engineering", name: "Jasper", model: "openai/gpt-5.4-mini",
    channels: [], passiveChannels: [], keywords: [], isDefault: false,
    schedule: [], budgetUsd: 10, maxTurns: 25, coreServers: [], delegateServers: [],
    icon: "", soul: "", systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function seGate(config?: Partial<SoftwareEngineerConfigLike>) {
  const def = getArchetype("software-engineer")!;
  const agentConfig = makeAgentConfig({
    archetype: "software-engineer",
    archetypeConfig: { ...seConfig, ...config } as never,
  });
  return buildArchetypeGuardrailGate(agentConfig, def);
}

interface SoftwareEngineerConfigLike {
  workshop: string;
  workspaces: Array<{ name: string; path: string; tracker: { type: string; project: string } }>;
}

/** A synthetic archetype whose preToolUseHooks returns the given matchers (or throws). */
function syntheticGate(
  produce: () => HookCallbackMatcher[],
) {
  const def = { id: "synthetic", preToolUseHooks: produce } as unknown as ArchetypeDefinition;
  return buildArchetypeGuardrailGate(makeAgentConfig({ archetype: "synthetic", archetypeConfig: {} }), def);
}

const denyHook = (reason: string) => async () => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

describe("T2 — archetype guardrail gate port parity", () => {
  it("Edit inside workspace → deny, reason steers to code_task (flagship parity proof)", async () => {
    const gate = seGate();
    const d = await gate({ toolName: "Edit", input: { file_path: `${WORKSPACE_PATH}/src/index.ts` } });
    expect(d.behavior).toBe("deny");
    expect((d as { reason: string }).reason).toContain("code_task");
    expect((d as { reason: string }).reason).toContain("dodi_v2");
  });

  it("Edit outside any workspace (inside workshop) → allow", async () => {
    const gate = seGate();
    await expect(gate({ toolName: "Edit", input: { file_path: `${WORKSHOP}/scratch.ts` } })).resolves.toEqual({
      behavior: "allow",
    });
  });

  it("Bash anywhere (even a workspace path in input) → allow (not in BLOCKED_TOOLS)", async () => {
    const gate = seGate();
    await expect(gate({ toolName: "Bash", input: { command: `cd ${WORKSPACE_PATH} && ls` } })).resolves.toEqual({
      behavior: "allow",
    });
  });

  it("NotebookEdit with notebook_path inside workspace → deny (path extraction honored)", async () => {
    const gate = seGate();
    const d = await gate({ toolName: "NotebookEdit", input: { notebook_path: `${WORKSPACE_PATH}/nb.ipynb` } });
    expect(d.behavior).toBe("deny");
  });

  it("assembly-time throw (preToolUseHooks throws) → every call denied (deny-all)", async () => {
    const gate = syntheticGate(() => {
      throw new Error("archetype exploded at production");
    });
    const d1 = await gate({ toolName: "Read", input: {} });
    const d2 = await gate({ toolName: "Bash", input: { command: "ls" } });
    expect(d1.behavior).toBe("deny");
    expect((d1 as { reason: string }).reason).toContain("Archetype hook initialization failed");
    expect(d2.behavior).toBe("deny");
  });

  it("matcher regex honored: {matcher:'^Edit$'} denies Edit, allows Write", async () => {
    const gate = syntheticGate(() => [{ matcher: "^Edit$", hooks: [denyHook("no edits")] }]);
    await expect(gate({ toolName: "Edit", input: {} })).resolves.toMatchObject({ behavior: "deny" });
    await expect(gate({ toolName: "Write", input: {} })).resolves.toEqual({ behavior: "allow" });
  });

  it("call-time throw → deny (throw-is-deny containment), reason contains 'evaluation failed'", async () => {
    const gate = syntheticGate(() => [
      {
        hooks: [
          async () => {
            throw new Error("kaboom at call time");
          },
        ],
      },
    ]);
    const d = await gate({ toolName: "Edit", input: {} });
    expect(d.behavior).toBe("deny");
    expect((d as { reason: string }).reason).toContain("evaluation failed");
  });

  it("first-deny-wins: {continue:true} then a denying hook → deny (evaluation continues past non-deny)", async () => {
    const gate = syntheticGate(() => [
      { hooks: [async () => ({ continue: true }), denyHook("second hook says no")] },
    ]);
    const d = await gate({ toolName: "Edit", input: {} });
    expect(d.behavior).toBe("deny");
    expect((d as { reason: string }).reason).toBe("second hook says no");
  });

  it("software-engineer with workspaces:[] → allow-all (matchers [] — buildHooks installs nothing)", async () => {
    const gate = seGate({ workspaces: [] });
    await expect(gate({ toolName: "Edit", input: { file_path: `${WORKSPACE_PATH}/x.ts` } })).resolves.toEqual({
      behavior: "allow",
    });
  });

  it("archetype-less config through buildDefaultGuardrailGate → allow-all (canon branch untouched)", async () => {
    const gate = buildDefaultGuardrailGate(makeAgentConfig());
    await expect(gate({ toolName: "Edit", input: { file_path: "/anything" } })).resolves.toEqual({
      behavior: "allow",
    });
  });

  it("narrowing pin (spec §D6): the gate synthesizes a hook input carrying ONLY tool_name/tool_input + best-effort session fields, and that is sufficient for the software-engineer policy — the deny/allow cases above prove sufficiency; a future archetype needing full CLI session fields extends this adapter deliberately", async () => {
    // The software-engineer archetype depends only on tool_name/tool_input.
    // Feeding it exactly that shape (which is all the gate builds) produces
    // correct decisions — the same ones the Claude lane produces.
    const gate = seGate();
    await expect(gate({ toolName: "Write", input: { file_path: `${WORKSPACE_PATH}/a.ts` } })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(gate({ toolName: "Read", input: { file_path: `${WORKSPACE_PATH}/a.ts` } })).resolves.toEqual({
      behavior: "allow",
    });
  });
});
