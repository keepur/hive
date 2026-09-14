import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";

/**
 * KPR-501 D8: the single-writer repository guard for `ops_events`.
 *
 * The publisher's accept path (`src/ops/publisher.ts`, `store.events.insertOne(`)
 * is the ONLY place in the repository that writes an `ops_events` document. A
 * second writer — anywhere — would bypass the reason registry, the dedupe key
 * derivation and the subscription match stamping the notifier trusts verbatim.
 * A future writer must go through the publisher (the drainer), never a direct
 * insert.
 *
 * Reads are unconstrained in principle, but the collection NAME is pinned to
 * the modules that own the handle: a future reader (KPR-455) adds itself to the
 * `OPS_EVENTS_COLLECTION` entry of `EXPECTED` below as a reviewed decision, the
 * same allowlist discipline as `single-prefix-predicate.test.ts`.
 *
 * This is a text scan, deliberately (the offenders it must catch are files this
 * test would otherwise never import), over the precedent's glob set. Excluded:
 * `*.test.ts` and `src/ops/testing/**` — `notifier-harness.ts` inserts directly
 * and `lane-harness.ts` reads the constant; both are test infrastructure.
 *
 * Comment lines (`//` line comments and `/*`- / `*`-prefixed block-comment
 * lines) are stripped before matching, so a doc comment quoting a needle is not
 * a hit. Only WHOLE comment lines are stripped; a trailing `//` after code is
 * left in place so no code is ever removed (the stricter direction).
 *
 * ⚠ SCOPE LIMIT: a green run is evidence, not proof. Not caught, among others:
 * the collection name built by concatenation, a handle reached through an alias
 * (`const e = store.events; e.insertOne(…)`), or `insertMany`/`bulkWrite`/
 * `updateOne({upsert})` on the handle. It catches the spellings an author
 * actually reaches for.
 */
describe("single ops_events writer (KPR-501 D8)", () => {
  // `import.meta.url` is `<repo>/src/ops/single-events-writer.test.ts`, so
  // "../../" is the repository root, WITH a trailing slash.
  const root = fileURLToPath(new URL("../../", import.meta.url));

  // Each needle → the exact set of files allowed (and required) to contain it.
  // Adding a file is a reviewed decision, never a way to silence a real hit.
  const EXPECTED: ReadonlyArray<{ needle: string; pattern: RegExp; files: readonly string[] }> = [
    {
      needle: "OPS_EVENTS_COLLECTION",
      pattern: /\bOPS_EVENTS_COLLECTION\b/,
      files: ["src/ops/store.ts", "src/ops/types.ts"],
    },
    {
      // Quote-closed on BOTH sides, same quote style: `store.ts` carries index
      // labels like "ops_events.cursor" and a `db.ops_events.dropIndex(`
      // remediation string, which a prefix-only or unquoted needle would hit.
      needle: '"ops_events"',
      pattern: /(["'])ops_events\1/,
      files: ["src/ops/types.ts"],
    },
    {
      // Keyed on the `store.events.` handle: bare `.events.insertOne(` hits
      // exist in src/workflow/event-emitter.ts and
      // src/events/event-bus-mcp-server.ts, unrelated to ops_events.
      needle: "store.events.insertOne(",
      pattern: /\bstore\.events\.insertOne\(/,
      files: ["src/ops/publisher.ts"],
    },
  ];

  /** Drops whole comment lines; never touches a line that starts with code. */
  function stripCommentLines(source: string): string {
    return source
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"));
      })
      .join("\n");
  }

  it("each needle occurs in exactly its expected files", () => {
    const files = globSync(["src/**/*.ts", "scripts/**/*.ts", "build/**/*.ts", "setup/**/*.ts"], {
      cwd: root,
      absolute: false,
    }).filter((f) => !f.endsWith(".test.ts") && !f.startsWith("src/ops/testing/"));

    // Able-to-fail on reach: a glob that matches nothing guards nothing.
    expect(files.length, "the source glob stopped reaching the tree").toBeGreaterThan(100);

    const hits = new Map<string, string[]>(EXPECTED.map((e) => [e.needle, []]));
    for (const file of files) {
      const code = stripCommentLines(readFileSync(`${root}${file}`, "utf8"));
      for (const entry of EXPECTED) {
        if (entry.pattern.test(code)) hits.get(entry.needle)!.push(file);
      }
    }

    for (const entry of EXPECTED) {
      const found = hits.get(entry.needle)!;
      const offenders = found.filter((f) => !entry.files.includes(f)).map((f) => `${f}: ${entry.needle}`);
      expect(
        offenders,
        `${entry.needle} appears outside its allowlist — ops_events has one writer (the publisher's accept path); ` +
          "a new reader adds itself to EXPECTED as a reviewed decision, a new writer goes through the publisher",
      ).toEqual([]);

      // No stale entry: every expected file must still carry a real (non-comment)
      // occurrence, so the guard cannot silently rot to vacuous.
      const missing = entry.files.filter((f) => !found.includes(f)).map((f) => `${f}: ${entry.needle}`);
      expect(missing, `stale EXPECTED entry — the needle no longer occurs in code there`).toEqual([]);
    }
  });

  it("comment stripping removes comment lines and keeps code", () => {
    const sample = [
      "// store.events.insertOne(doc)",
      "  /** OPS_EVENTS_COLLECTION */",
      '   * "ops_events"',
      "await store.events.insertOne(doc); // trailing",
    ].join("\n");
    const code = stripCommentLines(sample);
    expect(code).toBe("await store.events.insertOne(doc); // trailing");
    expect(EXPECTED[0]!.pattern.test(code)).toBe(false);
    expect(EXPECTED[1]!.pattern.test(code)).toBe(false);
    expect(EXPECTED[2]!.pattern.test(code)).toBe(true);
    // The quoted needle is quote-closed on both sides.
    expect(EXPECTED[1]!.pattern.test('"ops_events.cursor"')).toBe(false);
    expect(EXPECTED[1]!.pattern.test("'ops_events'")).toBe(true);
    expect(EXPECTED[1]!.pattern.test("\"ops_events'")).toBe(false);
  });
});
