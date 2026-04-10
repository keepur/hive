import { describe, it, expect } from "vitest";
import { systemPromptCard } from "./prompt-card.js";
import type { SoftwareEngineerConfig } from "./config.js";
import type { AgentConfig } from "../../types/agent-config.js";

function makeCtx(overrides?: { cfg?: Partial<SoftwareEngineerConfig>; agent?: Partial<AgentConfig> }) {
  const cfg: SoftwareEngineerConfig = {
    workshop: "/Users/mokie/dev",
    workspaces: [
      {
        name: "dodi_v2",
        path: "/Users/mokie/dev/dodi_v2",
        tracker: { type: "linear", project: "DOD" },
        primary: true,
      },
    ],
    ...overrides?.cfg,
  };
  const agentConfig = {
    id: "vp-engineering",
    name: "Jasper",
    title: "VP Engineering",
    ...overrides?.agent,
  } as AgentConfig;

  return { agentConfig, archetypeConfig: cfg };
}

describe("systemPromptCard", () => {
  it("renders identity with title", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("Your title is VP Engineering");
    expect(card).toContain("software engineer");
  });

  it("falls back to agent name when title is unset", () => {
    const card = systemPromptCard(makeCtx({ agent: { title: undefined } }));
    expect(card).toContain("Your title is Jasper");
  });

  it("includes workshop path", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("`/Users/mokie/dev`");
  });

  it("lists workspaces with tracker info", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("**dodi_v2** (primary)");
    expect(card).toContain("Linear (project: DOD)");
  });

  it("includes workshop/workspace policy section", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("Workshop vs Workspace Policy");
    expect(card).toContain("Delegate-only");
    expect(card).toContain("code_task");
  });

  it("includes ticket-as-spec workflow", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("Ticket as Spec");
  });

  it("includes four delivery primitives", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("Brainstorm");
    expect(card).toContain("File Ticket");
    expect(card).toContain("Code Task");
    expect(card).toContain("Review");
  });

  it("includes review recipe with gh commands", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("gh pr view");
    expect(card).toContain("gh pr checks");
  });

  it("includes definition of done", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("Definition of Done");
    expect(card).toContain("PR merged and CI green");
  });

  it("includes hard guardrails", () => {
    const card = systemPromptCard(makeCtx());
    expect(card).toContain("Guardrails");
    expect(card).toContain("Never");
  });

  // ── Branch: multiple workspaces ────────────────────────────────────

  it("renders multiple workspaces", () => {
    const card = systemPromptCard(
      makeCtx({
        cfg: {
          workspaces: [
            {
              name: "dodi_v2",
              path: "/Users/mokie/dev/dodi_v2",
              tracker: { type: "linear", project: "DOD" },
              primary: true,
            },
            { name: "hive", path: "/Users/mokie/dev/hive", tracker: { type: "github", repo: "dodi-hq/hive" } },
          ],
        },
      }),
    );
    expect(card).toContain("**dodi_v2** (primary)");
    expect(card).toContain("**hive**:");
    expect(card).toContain("GitHub Issues (repo: dodi-hq/hive)");
  });

  // ── Branch: no workspaces ──────────────────────────────────────────

  it("renders workshop-only card when no workspaces", () => {
    const card = systemPromptCard(makeCtx({ cfg: { workspaces: [] } }));
    expect(card).toContain("No workspaces configured");
    expect(card).toContain("full agency");
    // Should NOT include workspace policy section
    expect(card).not.toContain("Workshop vs Workspace Policy");
  });

  // ── Tracker type formatting ────────────────────────────────────────

  it("formats clickup tracker", () => {
    const card = systemPromptCard(
      makeCtx({
        cfg: {
          workspaces: [{ name: "proj", path: "/Users/mokie/dev/proj", tracker: { type: "clickup", list: "abc" } }],
        },
      }),
    );
    expect(card).toContain("ClickUp (list: abc)");
  });

  // ── Determinism ────────────────────────────────────────────────────

  it("is deterministic (same input produces same output)", () => {
    const ctx = makeCtx();
    const a = systemPromptCard(ctx);
    const b = systemPromptCard(ctx);
    expect(a).toBe(b);
  });
});
