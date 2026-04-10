import { describe, it, expect } from "vitest";
import { isInsideWorkshop, findWorkspace, workshopSlug, workspaceSlug } from "./paths.js";
import type { SoftwareEngineerConfig, Workspace } from "./config.js";

const cfg: SoftwareEngineerConfig = {
  workshop: "/Users/mokie/dev",
  workspaces: [
    { name: "dodi_v2", path: "/Users/mokie/dev/dodi_v2", tracker: { type: "linear", project: "DOD" } },
    { name: "hive", path: "/Users/mokie/dev/hive", tracker: { type: "github", repo: "dodi-hq/hive" } },
  ],
};

describe("isInsideWorkshop", () => {
  it("returns true for the workshop root itself", () => {
    expect(isInsideWorkshop("/Users/mokie/dev", cfg)).toBe(true);
  });

  it("returns true for a file inside the workshop", () => {
    expect(isInsideWorkshop("/Users/mokie/dev/scratch.ts", cfg)).toBe(true);
  });

  it("returns true for a file deep inside a workspace", () => {
    expect(isInsideWorkshop("/Users/mokie/dev/dodi_v2/apps/web/index.ts", cfg)).toBe(true);
  });

  it("returns false for a path outside the workshop", () => {
    expect(isInsideWorkshop("/Users/mokie/github/other", cfg)).toBe(false);
  });

  it("returns false for a path that looks like but is not inside workshop", () => {
    // /Users/mokie/dev-tools is NOT inside /Users/mokie/dev
    expect(isInsideWorkshop("/Users/mokie/dev-tools/foo.ts", cfg)).toBe(false);
  });

  it("handles trailing slashes on input", () => {
    expect(isInsideWorkshop("/Users/mokie/dev/dodi_v2/", cfg)).toBe(true);
  });

  it("handles dots in path", () => {
    expect(isInsideWorkshop("/Users/mokie/dev/dodi_v2/./src/../src/index.ts", cfg)).toBe(true);
  });
});

describe("findWorkspace", () => {
  it("returns the workspace for a file inside it", () => {
    const ws = findWorkspace("/Users/mokie/dev/dodi_v2/src/index.ts", cfg);
    expect(ws?.name).toBe("dodi_v2");
  });

  it("returns the workspace for the workspace root itself", () => {
    const ws = findWorkspace("/Users/mokie/dev/dodi_v2", cfg);
    expect(ws?.name).toBe("dodi_v2");
  });

  it("returns undefined for a file in workshop but outside any workspace", () => {
    expect(findWorkspace("/Users/mokie/dev/scratch.ts", cfg)).toBeUndefined();
  });

  it("returns undefined for a file outside the workshop entirely", () => {
    expect(findWorkspace("/tmp/foo.ts", cfg)).toBeUndefined();
  });

  it("distinguishes between workspaces with similar prefixes", () => {
    const cfgNested: SoftwareEngineerConfig = {
      workshop: "/Users/mokie/dev",
      workspaces: [
        { name: "app", path: "/Users/mokie/dev/app", tracker: { type: "github", repo: "x/app" } },
        { name: "app-tools", path: "/Users/mokie/dev/app-tools", tracker: { type: "github", repo: "x/tools" } },
      ],
    };
    expect(findWorkspace("/Users/mokie/dev/app/main.ts", cfgNested)?.name).toBe("app");
    expect(findWorkspace("/Users/mokie/dev/app-tools/build.ts", cfgNested)?.name).toBe("app-tools");
  });

  it("handles dot-dot traversal in path", () => {
    const ws = findWorkspace("/Users/mokie/dev/dodi_v2/src/../package.json", cfg);
    expect(ws?.name).toBe("dodi_v2");
  });
});

describe("workshopSlug", () => {
  it("returns the Claude Code project slug for the workshop", () => {
    expect(workshopSlug(cfg)).toBe("-Users-mokie-dev");
  });
});

describe("workspaceSlug", () => {
  it("returns the Claude Code project slug for a workspace", () => {
    const ws: Workspace = {
      name: "dodi_v2",
      path: "/Users/mokie/dev/dodi_v2",
      tracker: { type: "linear", project: "DOD" },
    };
    expect(workspaceSlug(ws)).toBe("-Users-mokie-dev-dodi-v2");
  });
});
