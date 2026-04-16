import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  serializeFrontmatter,
  readSkillMd,
  writeSkillMd,
  stripOriginBlock,
} from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses inline agents format", () => {
    const content = `---
name: test-skill
description: A test skill
agents: [milo, jessica]
---

# Body here`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("A test skill");
    expect(frontmatter.agents).toEqual(["milo", "jessica"]);
    expect(body).toContain("# Body here");
  });

  it("parses list agents format", () => {
    const content = `---
name: test-skill
description: A test skill
agents:
  - milo
  - jessica
---

# Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.agents).toEqual(["milo", "jessica"]);
  });

  it("parses origin block", () => {
    const content = `---
name: test-skill
description: test
agents: [all]
origin:
  type: registry
  source: keepur/default
  base-version: 1.2.0
  installed-at: 2026-04-15T00:00:00Z
  modified: true
---

body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.origin).toEqual({
      type: "registry",
      source: "keepur/default",
      "base-version": "1.2.0",
      "installed-at": "2026-04-15T00:00:00Z",
      modified: true,
    });
  });

  it("parses author block", () => {
    const content = `---
name: test-skill
description: test
agents: [milo]
author:
  agent-id: mokie
  authored-at: 2026-04-15T10:00:00Z
  reason: needed a custom workflow
---

body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.author).toEqual({
      "agent-id": "mokie",
      "authored-at": "2026-04-15T10:00:00Z",
      reason: "needed a custom workflow",
    });
  });

  it("parses workflow field", () => {
    const content = `---
name: test-skill
description: test
agents: [all]
workflow: dodi-dev
---

body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.workflow).toBe("dodi-dev");
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow(
      "No YAML frontmatter found",
    );
  });
});

describe("serializeFrontmatter", () => {
  it("produces canonical output", () => {
    const fm = {
      name: "test-skill",
      description: "A test skill",
      agents: ["milo", "jessica"],
      workflow: "dodi-dev",
    };
    const result = serializeFrontmatter(fm, "\n# Body\n");
    expect(result).toBe(`---
name: test-skill
description: A test skill
agents: [milo, jessica]
workflow: dodi-dev
---
\n# Body\n`);
  });

  it("serializes origin and author blocks", () => {
    const fm = {
      name: "s",
      description: "d",
      agents: ["all"],
      origin: {
        type: "registry" as const,
        source: "keepur/default",
        modified: false,
      },
      author: {
        "agent-id": "mokie",
        "authored-at": "2026-04-15",
      },
    };
    const result = serializeFrontmatter(fm, "\nbody\n");
    expect(result).toContain("origin:\n  type: registry\n  source: keepur/default\n  modified: false");
    expect(result).toContain("author:\n  agent-id: mokie\n  authored-at: 2026-04-15");
  });

  it("roundtrips through parse and serialize", () => {
    const original = {
      name: "roundtrip",
      description: "test roundtrip",
      agents: ["milo", "jessica"],
      workflow: "alpha",
    };
    const body = "\n# Hello\n\nSome content.\n";
    const serialized = serializeFrontmatter(original, body);
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized);
    expect(frontmatter.name).toBe(original.name);
    expect(frontmatter.description).toBe(original.description);
    expect(frontmatter.agents).toEqual(original.agents);
    expect(frontmatter.workflow).toBe(original.workflow);
    expect(parsedBody).toBe(body);
  });
});

describe("readSkillMd / writeSkillMd", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "frontmatter-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes and reads back a skill file", () => {
    const path = join(tmp, "SKILL.md");
    const fm = {
      name: "io-test",
      description: "file I/O test",
      agents: ["all"],
    };
    const body = "\n# IO Test\n";
    writeSkillMd(path, fm, body);
    const result = readSkillMd(path);
    expect(result.frontmatter.name).toBe("io-test");
    expect(result.frontmatter.agents).toEqual(["all"]);
    expect(result.body).toBe(body);
  });
});

describe("stripOriginBlock", () => {
  it("removes the origin block from frontmatter", () => {
    const content = `---
name: test
description: d
agents: [all]
origin:
  type: registry
  source: keepur/default
  modified: true
workflow: alpha
---

body`;

    const stripped = stripOriginBlock(content);
    expect(stripped).not.toContain("origin:");
    expect(stripped).not.toContain("type: registry");
    expect(stripped).toContain("name: test");
    expect(stripped).toContain("workflow: alpha");
    expect(stripped).toContain("body");
  });

  it("returns content unchanged when no origin block", () => {
    const content = `---
name: test
description: d
agents: [all]
---

body`;

    expect(stripOriginBlock(content)).toBe(content);
  });

  it("handles origin at end of frontmatter", () => {
    const content = `---
name: test
agents: [all]
origin:
  type: agent-authored
---

body`;

    const stripped = stripOriginBlock(content);
    expect(stripped).not.toContain("origin:");
    expect(stripped).toContain("name: test");
  });

  it("returns non-frontmatter content unchanged", () => {
    const content = "just plain text";
    expect(stripOriginBlock(content)).toBe(content);
  });
});
