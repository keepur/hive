import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";

/**
 * KPR-454 AC4 / contract C6: `sourceOfId` is the ONLY reserved-WorkItem.id-
 * prefix test in the repository. A second one — anywhere — is the drift this
 * criterion exists to prevent (the KPR-452 D1 and KPR-416/KPR-420 lesson).
 *
 * This is a text scan, deliberately: the offenders it must catch are files
 * that would otherwise never be imported by this test.
 */
describe("one reserved-prefix predicate (KPR-454 AC4, C6)", () => {
  // `import.meta.url` is `<repo>/src/ops/single-prefix-predicate.test.ts`, so
  // "../../" is the repository root. The value ENDS WITH A SLASH, so every
  // use below is `${root}${file}`, never `${root}/${file}`.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const RESERVED = ["sched:", "callback:", "event:", "team-", "worker:"];

  // Deliberate, reviewed classifications. Adding to this list is a decision,
  // never a way to silence a real hit — the boot-order.test.ts allowlist
  // discipline.
  const ALLOWLIST: ReadonlyArray<{ file: string; literal: string; reason: string }> = [
    {
      file: "src/agents/provider-adapters/sse.ts",
      literal: "event:",
      reason: "SSE wire-format field name, not a WorkItem id",
    },
    {
      file: "src/outage/outage-notices.ts",
      literal: "*",
      reason: "the one predicate itself (SOURCE_PREFIXES / sourceOfId)",
    },
  ];

  it("no module outside outage-notices.ts tests a reserved id prefix", () => {
    const files = globSync(["src/**/*.ts", "scripts/**/*.ts", "build/**/*.ts", "setup/**/*.ts"], {
      cwd: root,
      absolute: false,
    }).filter((f) => !f.endsWith(".test.ts"));

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(`${root}${file}`, "utf8");
      for (const literal of RESERVED) {
        const pattern = new RegExp(`\\.\\s*startsWith\\s*\\(\\s*["'\`]${literal}`);
        if (!pattern.test(source)) continue;
        const allowed = ALLOWLIST.some((a) => a.file === file && (a.literal === "*" || a.literal === literal));
        if (!allowed) offenders.push(`${file}: startsWith("${literal}")`);
      }
    }

    expect(
      offenders,
      "a second reserved-prefix predicate exists — route it through sourceOfId (src/outage/outage-notices.ts) " +
        "or, if the literal is a coincidence, add a reviewed entry to ALLOWLIST with its reason",
    ).toEqual([]);
  });

  it("every allowlist entry still corresponds to a real occurrence (no stale entries)", () => {
    for (const entry of ALLOWLIST) {
      if (entry.literal === "*") continue;
      const source = readFileSync(`${root}${entry.file}`, "utf8");
      expect(
        source,
        `stale allowlist entry: ${entry.file} no longer contains startsWith("${entry.literal}")`,
      ).toContain(`startsWith("${entry.literal}")`);
    }
  });
});
