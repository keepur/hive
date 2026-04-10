import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { memoryScopes } from "./memory-scopes.js";
import type { SoftwareEngineerConfig } from "./config.js";
import type { AgentConfig } from "../../types/agent-config.js";

const agentConfig = { id: "vp-engineering", name: "Jasper" } as AgentConfig;

const cfg: SoftwareEngineerConfig = {
  workshop: "/Users/mokie/dev",
  workspaces: [
    { name: "dodi_v2", path: "/Users/mokie/dev/dodi_v2", tracker: { type: "linear", project: "DOD" } },
    { name: "hive", path: "/Users/mokie/dev/hive", tracker: { type: "github", repo: "dodi-hq/hive" } },
  ],
};

describe("memoryScopes", () => {
  it("returns workshop + per-workspace scopes", () => {
    const scopes = memoryScopes({ agentConfig, archetypeConfig: cfg });
    expect(scopes).toHaveLength(3); // workshop + 2 workspaces
  });

  it("workshop scope has correct id and dir", () => {
    const scopes = memoryScopes({ agentConfig, archetypeConfig: cfg });
    const ws = scopes.find((s) => s.id === "workshop");
    expect(ws).toBeDefined();
    expect(ws!.backing).toBe("filesystem");
    expect(ws!.dir).toBe(`${homedir()}/.claude/projects/-Users-mokie-dev/memory`);
  });

  it("workspace scope has correct id and dir", () => {
    const scopes = memoryScopes({ agentConfig, archetypeConfig: cfg });
    const ws = scopes.find((s) => s.id === "workspace:dodi_v2");
    expect(ws).toBeDefined();
    expect(ws!.backing).toBe("filesystem");
    expect(ws!.dir).toBe(`${homedir()}/.claude/projects/-Users-mokie-dev-dodi-v2/memory`);
  });

  it("returns only workshop scope when no workspaces", () => {
    const scopes = memoryScopes({
      agentConfig,
      archetypeConfig: { workshop: "/Users/mokie/dev", workspaces: [] },
    });
    expect(scopes).toHaveLength(1);
    expect(scopes[0].id).toBe("workshop");
  });

  it("does not include self scope (agent-runner adds it)", () => {
    const scopes = memoryScopes({ agentConfig, archetypeConfig: cfg });
    expect(scopes.find((s) => s.id === "self")).toBeUndefined();
  });

  it("all scopes use filesystem backing", () => {
    const scopes = memoryScopes({ agentConfig, archetypeConfig: cfg });
    for (const s of scopes) {
      expect(s.backing).toBe("filesystem");
    }
  });
});
