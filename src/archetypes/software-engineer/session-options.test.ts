import { describe, it, expect } from "vitest";
import { sessionOptions } from "./session-options.js";
import type { SoftwareEngineerConfig } from "./config.js";
import type { AgentConfig } from "../../types/agent-config.js";

const agentConfig = { id: "vp-engineering", name: "Jasper" } as AgentConfig;
const cfg: SoftwareEngineerConfig = {
  workshop: "/Users/mokie/dev",
  workspaces: [],
};

describe("sessionOptions", () => {
  it("returns cwd set to workshop", () => {
    const opts = sessionOptions({ agentConfig, archetypeConfig: cfg });
    expect(opts.cwd).toBe("/Users/mokie/dev");
  });

  it("returns settingSources with only 'project'", () => {
    const opts = sessionOptions({ agentConfig, archetypeConfig: cfg });
    expect(opts.settingSources).toEqual(["project"]);
  });

  it("does not include 'user' in settingSources", () => {
    const opts = sessionOptions({ agentConfig, archetypeConfig: cfg });
    expect(opts.settingSources).not.toContain("user");
  });
});
