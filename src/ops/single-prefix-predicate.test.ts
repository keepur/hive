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

    const hits: string[] = [];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(`${root}${file}`, "utf8");
      for (const literal of RESERVED) {
        const pattern = new RegExp(`\\.\\s*startsWith\\s*\\(\\s*["'\`]${literal}`);
        if (!pattern.test(source)) continue;
        hits.push(`${file}: startsWith("${literal}")`);
        const allowed = ALLOWLIST.some((a) => a.file === file && (a.literal === "*" || a.literal === literal));
        if (!allowed) offenders.push(`${file}: startsWith("${literal}")`);
      }
    }

    expect(
      offenders,
      "a second reserved-prefix predicate exists — route it through sourceOfId (src/outage/outage-notices.ts) " +
        "or, if the literal is a coincidence, add a reviewed entry to ALLOWLIST with its reason",
    ).toEqual([]);

    // ⚠ THE ABLE-TO-FAIL HALF. The assertion above is `toEqual([])`, so it is
    // green both when the repository is clean AND when this scan has stopped
    // reaching anything — a glob that matches nothing, or a regex that matches
    // nothing, guards nothing while reporting a pass. Both halves of the reach
    // are therefore pinned against reality:
    //
    //  · the glob reaches the tree (269 non-test files at this commit; the
    //    floor is deliberately far below that, so ordinary growth and pruning
    //    never touch it and only a broken pattern does), and
    //  · the regex matches a REAL occurrence — the one `sse.ts` hit the
    //    allowlist exists to excuse. Asserted as the EXACT pre-allowlist hit
    //    set rather than as a `toContain`, which additionally pins that the
    //    allowlist is excusing exactly one thing: a new hit shows up here as
    //    well as in `offenders`, and one silenced by an allowlist entry added
    //    without a matching source change shows up here alone.
    //
    // The second `it` below pins the same literal by substring; this pins it
    // through THIS test's own regex, which is the thing that can rot.
    expect(files.length, "the source glob stopped reaching the tree").toBeGreaterThan(100);
    expect(hits, "the reserved-prefix regex no longer matches its one known real occurrence").toEqual([
      'src/agents/provider-adapters/sse.ts: startsWith("event:")',
    ]);
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
