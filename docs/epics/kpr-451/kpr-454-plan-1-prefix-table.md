# KPR-454 plan — chunk 1: the one reserved-prefix table, and `waiting`

Implements design **D7** and acceptance criterion **AC4** (contract C6). One task, one commit.

This is the only edit in the whole ticket that touches shared production code on a live path: `policyFor` is called at `src/channels/dispatcher.ts:872` and `:1103` on the honest-outage arm. The refactor is behaviour-preserving to the byte — signature, return type, `OutageSourcePolicy` and every caller are untouched — and the safety argument is that the pre-refactor values are **pinned by test before the file is edited**. Do the steps in order; do not write `waitingFor` before Step 2 is green.

## Why a sibling function is not enough

`OutageSourcePolicy` is 3-valued and collapses `team-`, `callback:`, `event:` and `worker:` into one `silent` bucket. D3's `waiting` needs that bucket **split**: `team-` ⇒ `agent`, the other three ⇒ `nobody`. A `waitingFor` that projected from `policyForId`'s output could not recover the split without a second `startsWith` chain — which is exactly what C6 forbids and what AC4's repository-wide test would fail. So the extraction goes one level deeper than a rename: one ordered prefix→bucket table, one predicate over it, and two exhaustive `Record` projections. Adding a prefix later is then a **compile error** until both projections classify it.

---

### Task 1: Extract the prefix table and derive `waiting`

**Files:**
- Modify: `src/outage/outage-notices.ts:8-26`
- Modify: `src/outage/outage-notices.test.ts` (exists — 46+ lines already pin `policyFor`)
- Create: `src/ops/single-prefix-predicate.test.ts`

- [ ] **Step 1:** Pin the pre-refactor `policyFor` output per prefix, before touching the source.

The existing `src/outage/outage-notices.test.ts` already covers the five prefixes and the fallthrough. Add one table-driven case beside them so the pinning is a single exhaustive statement rather than five scattered `expect`s, and so a later reviewer can see the whole pre-refactor contract in one block. Insert after the existing `describe("policyFor …")` block's last `it`:

```typescript
  // KPR-454 AC4: the pre-refactor value of every reserved prefix, stated once
  // as a table. This case is written BEFORE the D7 extraction and must pass
  // unchanged after it — that equality is the entire behaviour-preserving
  // claim. Negative-verify: break one row of SOURCE_PREFIXES and this fails.
  it("pins every reserved-prefix classification (pre/post-refactor identity)", () => {
    const cases: Array<[string, "skip" | "silent" | "notify"]> = [
      ["sched:agent-a:daily digest:1725465600000", "skip"],
      ["callback:65a1b2c3d4e5f60718293a4b", "silent"],
      ["event:65a1b2c3d4e5f60718293a4b:agent-a", "silent"],
      ["team-65a1b2c3d4e5f60718293a4b", "silent"],
      ["worker:65a1b2c3d4e5f60718293a4b", "silent"],
      ["1725465600.123456", "notify"],
      ["imsg-4471", "notify"],
      ["scheduled:not-a-reserved-prefix", "notify"],
    ];
    for (const [id, expected] of cases) {
      expect(policyFor(item({ id })), `policyFor(${id})`).toBe(expected);
    }
  });
```

Note the last row deliberately: `scheduled:` is **not** `sched:` — it must fall through to `notify`. A refactor that turned the ordered chain into an unordered `Object.keys` scan with a `startsWith` over a map could reorder and mis-hit; this row is what catches that.

- [ ] **Step 2:** Verify the pin is green against the **unmodified** source.

Run: `npx vitest run src/outage/outage-notices.test.ts`
Expected: all tests pass, including the new `pins every reserved-prefix classification` case. If it does not pass here, the table is wrong — fix the table, not the source.

- [ ] **Step 3:** Replace `src/outage/outage-notices.ts:8-26` with the table extraction.

Delete the current header comment block and `policyFor`, and put this in their place. Everything below line 26 in the file (`adapterKeyFor` onward) is untouched.

```typescript
// ---------------------------------------------------------------------------
// Source policy (§5-3a), and — since KPR-454 (D7) — the ONE reserved-prefix
// table in the repository.
//
// Prefix-detected on engine-synthesized ids; the formats are fixed in
// scheduler.ts (sched:/callback:/event:/team-) and meeting-worker-pool.ts
// (worker:). Known caveat (KPR-307 spec Finding 7 r1, ⚠ §10): ws/app ids are
// client-supplied, so a client id colliding with a reserved prefix
// misclassifies. Accepted at spec time; the blast radius is one outage
// notice's policy and — post-KPR-454 — one event's `waiting`, hence one
// mis-selected subscription. The meta.outagePolicy variant remains the
// documented alternative.
//
// KPR-454 D7 / contract C6: `sourceOfId` is the ONLY function in this
// repository that tests a reserved WorkItem.id prefix, and both public
// answers are TOTAL maps from its bucket. That is what keeps them from
// drifting: adding a row to SOURCE_PREFIXES is a COMPILE ERROR until both
// projections classify the new source. A second startsWith chain anywhere
// else is a contract violation, guarded by
// src/ops/single-prefix-predicate.test.ts.
// ---------------------------------------------------------------------------

import type { Waiting } from "../ops/types.js";

export type OutageSourcePolicy = "notify" | "silent" | "skip";

/** The bucket a reserved WorkItem.id prefix names. Fallthrough is "human". */
export type WorkItemSource = "cron" | "callback" | "event" | "agent" | "worker" | "human";

/**
 * THE prefix table. Ordered: the first matching prefix wins, so a longer
 * prefix that shares a head with a shorter one must precede it. (None do
 * today — the five are mutually non-prefixing — but the order is contract,
 * not incidental, and `scheduled:` must NOT hit the `sched:` row's bucket by
 * accident of iteration.) Per-arm rationale lives on the row it explains.
 */
const SOURCE_PREFIXES: ReadonlyArray<readonly [string, WorkItemSource]> = [
  ["sched:", "cron"], // cron re-fires at the next match — queueing would double-run
  ["callback:", "callback"], // one-shot, marked fired pre-dispatch — queue preserves it
  ["event:", "event"], // one-shot event delivery — queue preserves it
  ["team-", "agent"], // agent-to-agent traffic: another agent is blocked on it
  ["worker:", "worker"], // KPR-390: one-shot boss re-entry, claim already terminal
] as const;

/** THE reserved-prefix predicate (C6). Nothing else in the repo may test one. */
export function sourceOfId(id: string): WorkItemSource {
  for (const [prefix, source] of SOURCE_PREFIXES) {
    if (id.startsWith(prefix)) return source;
  }
  // Human channels: slack, sms, imessage, app/ws. NOT "team DM" — a `team-`
  // id returns "agent" above and can never reach here. (The pre-KPR-454
  // comment claimed otherwise; an implementer who trusted it mapped
  // agent-to-agent traffic to a human waiter, which is the misrouting the
  // KPR-451 epic exists to remove.)
  return "human";
}

const POLICY_BY_SOURCE: Record<WorkItemSource, OutageSourcePolicy> = {
  cron: "skip",
  callback: "silent",
  event: "silent",
  agent: "silent",
  worker: "silent",
  human: "notify",
};

const WAITING_BY_SOURCE: Record<WorkItemSource, Waiting> = {
  cron: "nobody",
  callback: "nobody",
  event: "nobody",
  agent: "agent",
  worker: "nobody",
  human: "human-now",
};

export function policyForId(id: string): OutageSourcePolicy {
  return POLICY_BY_SOURCE[sourceOfId(id)];
}

/** Unchanged behaviour, signature, return type and callers (dispatcher.ts:872, :1103). */
export function policyFor(item: WorkItem): OutageSourcePolicy {
  return policyForId(item.id);
}

/**
 * KPR-454 D7 / contract C6: the `waiting` attribute of an ops event, derived
 * from the SAME table as the outage policy — never a second predicate.
 *
 * An absent id ⇒ "nobody", fail-closed to the quietest value and TRUE rather
 * than a fudge: a detached worker or scribe execution has no WorkItem because
 * nobody is directly waiting on it (KPR-453 canon).
 *
 * `waiting: "obligation"` is NEVER derived here — D3 reserves it for KPR-456's
 * sweep, the only component that knows a deadline exists.
 *
 * D6's admissibility bound deliberately does NOT cascade into this function:
 * that bound governs STORAGE of an id, while `waiting` is derived from
 * whatever id the runtime holds, admissible or not. Re-classifying an honest
 * id whose only defect is an unstorable character would buy nothing (a hostile
 * `team-…` id passes the charset anyway).
 */
export function waitingFor(id?: string): Waiting {
  if (id === undefined) return "nobody";
  return WAITING_BY_SOURCE[sourceOfId(id)];
}
```

Three notes for the implementer:

1. **`Waiting` crosses as a type-only import.** `import type { Waiting } from "../ops/types.js"` is erased at compile time, so this adds no runtime edge from `src/outage/` into the new ops module and no import cycle. The one runtime dependency stays ops → outage. Do not change it to a value import; do not re-declare `Waiting` here (two declarations is the drift this whole task removes).
2. **`WorkItem` is already imported** at the top of the file (`import type { WorkItem, ChannelKind } from "../types/work-item.js";`) — keep that line where it is and add the `Waiting` import beside it.
3. Chunk 2 (Task 2) creates `src/ops/types.ts`. If you execute Task 1 first, as ordered, TypeScript will not resolve the import until Task 2 lands. Create `src/ops/types.ts` with at minimum the `Waiting` union as the *first* edit of Task 2, or land Task 1's typecheck at the end of Task 2 — either is fine, but do not invert the commits: the pinning tests must exist before the source moves.

- [ ] **Step 4:** Extend `src/outage/outage-notices.test.ts` with the `waitingFor` and `sourceOfId` coverage AC4 requires.

```typescript
describe("sourceOfId / waitingFor (KPR-454 D7, AC4)", () => {
  it("classifies all six buckets", () => {
    expect(sourceOfId("sched:a:b:1")).toBe("cron");
    expect(sourceOfId("callback:65a1")).toBe("callback");
    expect(sourceOfId("event:65a1:agent-a")).toBe("event");
    expect(sourceOfId("team-65a1")).toBe("agent");
    expect(sourceOfId("worker:65a1")).toBe("worker");
    expect(sourceOfId("1725465600.123456")).toBe("human");
  });

  it("maps every bucket to a waiting value — team- is `agent`, not `human-now`", () => {
    expect(waitingFor("team-65a1")).toBe("agent"); // the stale-comment trap, pinned
    expect(waitingFor("sched:a:b:1")).toBe("nobody");
    expect(waitingFor("callback:65a1")).toBe("nobody");
    expect(waitingFor("event:65a1:agent-a")).toBe("nobody");
    expect(waitingFor("worker:65a1")).toBe("nobody");
    expect(waitingFor("1725465600.123456")).toBe("human-now");
  });

  it("an absent id is `nobody` — the detached worker/scribe case, fail-closed and true", () => {
    expect(waitingFor(undefined)).toBe("nobody");
  });

  it("policyForId and waitingFor project from the same bucket", () => {
    // Not a tautology: it fails if either projection ever acquires a private
    // prefix test instead of reading sourceOfId.
    for (const id of ["sched:x", "callback:x", "event:x", "team-x", "worker:x", "plain-id"]) {
      const bucket = sourceOfId(id);
      expect(policyForId(id)).toBe(
        ({ cron: "skip", callback: "silent", event: "silent", agent: "silent", worker: "silent", human: "notify" } as const)[
          bucket
        ],
      );
    }
  });

  it("KPR-402 continuation legs inherit their origin's bucket", () => {
    // dispatcher.ts:1038 mints `<baseId>#dl<n>`; the suffix is on the TAIL,
    // so prefix detection is unaffected. Already pinned in
    // deadline-continuation.test.ts for policyFor; pinned here for waitingFor.
    expect(waitingFor("team-x#dl1")).toBe("agent");
    expect(waitingFor("sched:x#dl1")).toBe("nobody");
    expect(waitingFor("1725465600.123456#dl2")).toBe("human-now");
  });
});
```

Update the file's import line to pull in the four new exports:

```typescript
import { policyFor, policyForId, sourceOfId, waitingFor, /* …existing… */ } from "./outage-notices.js";
```

- [ ] **Step 5:** Create the repository-wide single-predicate guard, `src/ops/single-prefix-predicate.test.ts`.

```typescript
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
  const RESERVED = ["sched:", "callback:", "event:", "team-", "worker:"];

  // Deliberate, reviewed classifications. Adding to this list is a decision,
  // never a way to silence a real hit — the boot-order.test.ts allowlist
  // discipline.
  const ALLOWLIST: ReadonlyArray<{ file: string; literal: string; reason: string }> = [
    {
      file: "src/agents/provider-adapters/sse.ts",
      literal: "event:",
      // SSE field-name framing (`event: message\ndata: {…}`). Shares a literal
      // with a reserved id prefix by coincidence; it never sees a WorkItem id.
      reason: "SSE wire-format field name, not a WorkItem id",
    },
    {
      file: "src/outage/outage-notices.ts",
      literal: "*",
      reason: "the one predicate itself (SOURCE_PREFIXES / sourceOfId)",
    },
  ];

  it("no module outside outage-notices.ts tests a reserved id prefix", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const files = globSync(["src/**/*.ts"], { cwd: root, absolute: false })
      // Tests may name a prefix freely — they assert against the predicate,
      // they do not implement one.
      .filter((f) => !f.endsWith(".test.ts"));

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(`${root}/${file}`, "utf8");
      for (const literal of RESERVED) {
        // `.startsWith("<prefix>")` in any receiver shape.
        const pattern = new RegExp(`\\.\\s*startsWith\\s*\\(\\s*["'\`]${literal.replace(":", ":")}`, "g");
        if (!pattern.test(source)) continue;
        const allowed = ALLOWLIST.some(
          (a) => a.file === file && (a.literal === "*" || a.literal === literal),
        );
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
    const root = fileURLToPath(new URL("../..", import.meta.url));
    for (const entry of ALLOWLIST) {
      if (entry.literal === "*") continue;
      const source = readFileSync(`${root}/${entry.file}`, "utf8");
      expect(source, `stale allowlist entry: ${entry.file} no longer contains startsWith("${entry.literal}")`).toContain(
        `startsWith("${entry.literal}")`,
      );
    }
  });
});
```

The second `it` is not decoration: an allowlist that outlives its hit is how a real offender later slips in under a stale exemption.

- [ ] **Step 6:** Verify.

Run:
```
npx vitest run src/outage/outage-notices.test.ts src/ops/single-prefix-predicate.test.ts src/channels/deadline-continuation.test.ts
npx vitest run src/channels/dispatcher.test.ts
npm run typecheck
```
Expected: all pass. `deadline-continuation.test.ts:90-95` and the dispatcher suite are the behaviour-preservation evidence — they call `policyFor` and were written before this refactor existed.

Negative-verify (required): change `["team-", "agent"]` to `["team-", "worker"]` in `SOURCE_PREFIXES`, re-run `src/outage/outage-notices.test.ts`, and confirm the `team- is \`agent\`` case fails. Restore.

- [ ] **Step 7:** Commit.

```bash
git add src/outage/outage-notices.ts src/outage/outage-notices.test.ts src/ops/single-prefix-predicate.test.ts
git commit -m "refactor(KPR-454): one reserved-prefix table in outage-notices; add waitingFor

D7/C6: collapse the five-arm startsWith chain into one ordered prefix->bucket
table behind sourceOfId, with policyForId and waitingFor as exhaustive Record
projections so a new prefix is a compile error until both classify it.
policyFor's behaviour, signature and callers are unchanged and pinned per
prefix. Corrects the stale \"team DM\" fallthrough comment, which mapped
agent-to-agent traffic to a human waiter.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
