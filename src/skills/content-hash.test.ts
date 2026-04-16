import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContentHash } from "./content-hash.js";

describe("computeContentHash", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "content-hash-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hashes a single SKILL.md", () => {
    const skillDir = join(tmp, "skill-a");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: test
description: d
agents: [all]
---

# Content`,
    );

    const hash = computeContentHash(skillDir);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes sidecar files in the hash", () => {
    const skillDir = join(tmp, "skill-b");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: test
description: d
agents: [all]
---

# Content`,
    );

    const hashBefore = computeContentHash(skillDir);

    writeFileSync(join(skillDir, "helper.md"), "# Helper content");
    const hashAfter = computeContentHash(skillDir);

    expect(hashBefore).not.toBe(hashAfter);
  });

  it("excludes origin block from SKILL.md hash", () => {
    const dir1 = join(tmp, "with-origin");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(
      join(dir1, "SKILL.md"),
      `---
name: test
description: d
agents: [all]
origin:
  type: registry
  source: keepur/default
---

# Content`,
    );

    const dir2 = join(tmp, "without-origin");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(dir2, "SKILL.md"),
      `---
name: test
description: d
agents: [all]
---

# Content`,
    );

    expect(computeContentHash(dir1)).toBe(computeContentHash(dir2));
  });

  it("produces stable hashes for identical content", () => {
    const dir1 = join(tmp, "stable-1");
    const dir2 = join(tmp, "stable-2");

    for (const dir of [dir1, dir2]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: stable
description: same
agents: [milo]
---

# Same content`,
      );
      writeFileSync(join(dir, "extra.txt"), "same sidecar");
    }

    expect(computeContentHash(dir1)).toBe(computeContentHash(dir2));
  });

  it("handles nested sidecar directories", () => {
    const skillDir = join(tmp, "nested");
    mkdirSync(join(skillDir, "sub"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: test
description: d
agents: [all]
---

body`,
    );
    writeFileSync(join(skillDir, "sub", "nested.txt"), "nested file");

    const hash = computeContentHash(skillDir);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
