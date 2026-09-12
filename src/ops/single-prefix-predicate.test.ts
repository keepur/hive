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
 *
 * ⚠ SCOPE LIMIT, stated because `outage-notices.ts` asserts the contract
 * REPO-WIDE ("the ONLY function in this repository that tests a reserved
 * prefix") and this guard is narrower than that claim. It recognizes three
 * SPELLINGS of a prefix test (see `SHAPES`) and cannot recognize a fourth. Not
 * caught, among others: a prefix held in a named constant or built by
 * concatenation (`startsWith(SOME_CONST)`, `startsWith("sched" + ":")`), a
 * literal embedded in a larger pattern (`/^(sched|callback):/`), `indexOf(…) === 0`,
 * a `substring`/`substr` comparison, a `switch` over `id.split(":")[0]`, or any
 * of these reached through a helper in another file. So: a green run is
 * evidence, not proof, and a reviewer looking at a new id-classifying branch
 * must read it rather than trust this file. It catches the shapes a
 * well-intentioned author actually reaches for, which is the failure mode the
 * criterion is about.
 *
 * ⚠ AND ONLY THE `startsWith` SHAPE HAS ITS REACH PINNED against a real
 * occurrence (the `sse.ts` hit the allowlist excuses). The other two shapes
 * match nothing in the tree today, so their patterns are asserted to be
 * well-formed and to run, but NOT to be capable of matching — the same
 * asymmetry the ⚠ able-to-fail block below reasons about for the glob. They
 * were added because they are cheap and non-flaky (verified: zero hits, so no
 * expected-set churn), not because they are verified live.
 */
describe("one reserved-prefix predicate (KPR-454 AC4, C6)", () => {
  // `import.meta.url` is `<repo>/src/ops/single-prefix-predicate.test.ts`, so
  // "../../" is the repository root. The value ENDS WITH A SLASH, so every
  // use below is `${root}${file}`, never `${root}/${file}`.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const RESERVED = ["sched:", "callback:", "event:", "team-", "worker:"];

  /**
   * The spellings recognized, most-common first. `label` is what a hit reports,
   * so the `startsWith` label keeps the pre-existing hit strings byte-identical
   * (the expected-set assertion below pins them).
   *
   * Every reserved literal above is regex-safe as written (letters plus `:` and
   * `-`, none of which is a metacharacter outside a character class), so the
   * literals are interpolated raw rather than escaped — stated so a future
   * reserved prefix containing e.g. `.` or `+` gets an escape rather than a
   * silently wrong pattern.
   */
  const SHAPES: ReadonlyArray<{ label: string; pattern: (literal: string) => RegExp }> = [
    { label: "startsWith", pattern: (l) => new RegExp(`\\.\\s*startsWith\\s*\\(\\s*["'\`]${l}`) },
    // An anchored regex literal: `/^sched:/.test(id)`, `id.match(/^sched:/)`.
    { label: "anchored-regex", pattern: (l) => new RegExp(`/\\^${l}`) },
    // A sliced-prefix equality: `id.slice(0, 6) === "sched:"`.
    { label: "slice-equals", pattern: (l) => new RegExp(`\\.\\s*slice\\s*\\([^)]*\\)\\s*===\\s*["'\`]${l}`) },
  ];

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
        for (const shape of SHAPES) {
          if (!shape.pattern(literal).test(source)) continue;
          const hit = `${file}: ${shape.label}("${literal}")`;
          hits.push(hit);
          // The allowlist is deliberately SHAPE-AGNOSTIC: an entry excuses a
          // (file, literal) pair however it is spelled, because the reviewed
          // judgement it records ("this literal is a coincidence in this file")
          // does not change with the spelling.
          const allowed = ALLOWLIST.some((a) => a.file === file && (a.literal === "*" || a.literal === literal));
          if (!allowed) offenders.push(hit);
        }
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
    //
    // ⚠ SORTED, and the expected list is kept in sorted order too. `hits` is
    // accumulated in `globSync` order, which is not a documented-stable
    // ordering across platforms or tinyglobby versions — harmless while there
    // is one element, a flake the day a second legitimate allowlisted hit
    // lands. `sort()` makes the comparison depend on the SET, which is what
    // this pins.
    expect(files.length, "the source glob stopped reaching the tree").toBeGreaterThan(100);
    expect(
      hits.sort(),
      "the pre-allowlist hit set changed: either the reserved-prefix regex no longer matches its one known real " +
        "occurrence (this test guards nothing — fix the regex), or a NEW hit appeared. If the new hit is a real " +
        "second predicate it also shows in `offenders` above; if it is an allowlisted one (e.g. outage-notices.ts's " +
        "own predicate rewritten with a literal startsWith) add it to the expected list here with its reason.",
    ).toEqual(['src/agents/provider-adapters/sse.ts: startsWith("event:")']);
  });

  it("each recognized shape matches its own canonical spelling, and only it", () => {
    // The ⚠ note in the docblock says the two new shapes have no real
    // occurrence in the tree to pin their reach against. This is the substitute:
    // a synthetic sample per shape, so a pattern that has rotted into matching
    // NOTHING is caught here rather than reporting a silent pass. (This file is
    // a `.test.ts` and is filtered out of the scan's own glob, so the samples
    // below can hold the literal spellings without becoming hits.)
    const samples: Record<string, string> = {
      startsWith: 'if (id.startsWith("sched:")) return "cron";',
      "anchored-regex": 'if (/^sched:/.test(id)) return "cron";',
      "slice-equals": 'if (id.slice(0, 6) === "sched:") return "cron";',
    };
    expect(Object.keys(samples).sort()).toEqual(SHAPES.map((s) => s.label).sort());
    for (const shape of SHAPES) {
      expect(shape.pattern("sched:").test(samples[shape.label]!), `${shape.label} matches its own sample`).toBe(true);
      // …and does not fire on a DIFFERENT reserved literal, which is what keeps
      // a hit's reported literal meaningful.
      expect(shape.pattern("worker:").test(samples[shape.label]!), `${shape.label} is literal-specific`).toBe(false);
    }
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
