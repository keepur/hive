# KPR-393 Implementation Plan — GPT follow-through gap: Lane B prompt pressure + fleet-wide intent-trailer telemetry

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-393-spec.md](./kpr-393-spec.md) (approved, Gate 1 signed off) — the contract. Epic: KPR-385 (Decision Register canon C1–C17 binds). **Every anchor below verified against this worktree's HEAD `b51c496`.** All baselines in this plan were recorded by actually running the suites at that HEAD (reviewer re-verified identical counts on default Node 26 — no Node pinning needed; see Commands).

**Delivery-tier input (plan author's view, reviewer classifies authoritatively): standard.** Two small additive surfaces — a static prompt section composed only by `buildProviderInstructions`, and a pure regex detector wired as one boolean at an existing record call — with every line of production and test code transcribed in this plan, zero shared-layer edits (no loop, no scaffold, no adapters), and the two pre-existing test-file deltas fully enumerated.

**Goal:** (D1) every Lane B system prompt carries explicit follow-through pressure — commitments execute in-turn, or the reply states what it is waiting on, or the work is explicitly scheduled — with the Claude lane byte-untouched; (D2) the intent-trailer symptom becomes measurable fleet-wide via an optional `intentTrailer?: true` boolean on `activity_log` records, computed by a conservative English-only detector for **every** provider (Claude is the control baseline), skipped on error turns, no text stored; (D3) the phase-2 loop-nudge decision criteria stay documentation-only — they live in the spec (§D3) and the detector module's docstring points at them. No loop, scaffold, adapter, bridge, or session-semantics change of any kind (C1).

**Architecture:** `followThroughSection()` joins the KPR-349 section-helper family in `src/agents/prefix-builder.ts` and is pushed by `buildProviderInstructions` inside the existing `toolsExecutable` gate, immediately after the toolkit section (tool-adjacent guidance stays contiguous; static text ahead of the memory/datetime sections preserves any provider-side prefix caching). `buildPrefix` never calls it — golden-suite zero-diff by construction. New pure module `src/agents/intent-trailer.ts` exports `detectIntentTrailer(text): boolean` (final ~300 chars, word-boundary-anchored first-person-future patterns, curly/straight apostrophes). `AgentManager.recordSpawnObservability` (the inline `this.activityLogger?.record({...})` at `agent-manager.ts:1860` — there is no named `recordActivity` method) computes the boolean and conditionally spreads the field; `ActivityRecord` (`src/activity/types.ts`) gains the optional member (additive, schemaless Mongo, no migration).

**Spec rulings honored (load-bearing, per task):**
- *C1 / spec §Non-goals — no loop changes:* `dispatch-loop.ts`, `turn-scaffold.ts`, all four adapters, `tool-bridge`, `turn-assembly`, session semantics: zero-diff surfaces, verified by empty `git diff` in Task 5. D3 is documentation only — the criteria are already written in the spec; this plan adds only a docstring pointer.
- *Spec §D1 — placement & gate:* composed only by `buildProviderInstructions`, inside `toolsExecutable`, directly after the toolkit push. Uniform across codex/gemini/grok/openai — no per-provider forks (⚠ flagged assumption, honored as specced). Exact wording is implementation-final; the three behavioral clauses (do-then-report / state-the-wait / schedule-explicitly) are binding and content-pinned in the test.
- *Spec §D2 — redaction posture:* booleans only; the one `log.info` carries agentId, provider-prefixed model, toolCalls — never text. Detection is text-based only (deliberately NOT conditioned on `toolCalls === 0`); detection is skipped when `result.error` is set even if text is present; field set only when detected, absent otherwise (never `false`).
- *Spec §Edge cases:* empty/whitespace text → false; "No response needed." fixture-pinned negative; bare "on it" clause-anchored so "based on it" / "working on it" never match; English-only limitation documented in the module docstring.
- *C10/C16 — enumerated deltas:* exactly two pre-existing test files change (`prefix-builder.provider.test.ts`, `agent-manager.test.ts`), enumerated below with per-file baselines. Tests are NOT typechecked — nothing in this plan claims a test-file delta is "compile-forced." The C16 record-literal sweep is an explicit checkbox (Task 3).
- *Spec §Testing contract:* `prefix-builder.golden.test.ts` must show **zero diff** (baseline 12 tests, re-verified in Task 5); intent-trailer fixtures use text *shapes* from the real Sol transcripts, not verbatim thread content.
- *Spec §Integration points — docs:* `docs/providers.md` has no behavior-row change (prompt content isn't a matrix row); Task 5 confirms and directs a PR-body note on whether a "prompt guidance" caveat row is warranted. No other docs deliverable exists in the spec — no separate docs task (YAGNI).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `src/agents/intent-trailer.test.ts` (new — detector positives/negatives/tail-window, fixtures seeded from the spec's transcript shapes); `src/agents/prefix-builder.provider.test.ts` (delta — section presence, order, joiner count, gate, three-clause content pin).
  - Reason: the detector and the prompt section are the ticket's two load-bearing surfaces; both are pure and fully deterministic.
  - Harness: **existing** (plain vitest; the provider prefix suite's `richInputs()` fixture helper already covers every composition path).
  - Minimum assertions: the per-task lists in Tasks 1–2.

- Integration: **required**
  - Scope: `src/agents/agent-manager.test.ts` (delta — three additive tests at the activity-audit seam: positive, negative-absent, error-turn-with-text-absent).
  - Reason: the record call site is the only wiring; the existing suite's `activityLogger = { record: vi.fn() }` pattern drives it end-to-end through `spawnTurn`.
  - Harness: **existing** (`makeRunResult` / `makeCtx` / `makeWorkItem` helpers in scope at the insertion point).
  - Minimum assertions: Task 3's list; all non-enumerated existing tests green with zero expectation edits.

- E2E: **not-required**
  - Scope: n/a.
  - Reason: prompt text and a telemetry boolean; the measurable outcome (per-provider intent-trailer rates vs. the Claude control) is exactly what D2 exists to collect in production over ≥14 days — the spec's D3 criteria govern the follow-up, not this PR's CI.
  - Harness: not-applicable.
  - Minimum assertions: n/a.

### Critical Flows

- Lane B prompt: `buildProviderInstructions` with `toolsExecutable: true` renders `## Follow-through` between `## Your toolkit` and `## File-Tier Memory`; with `toolsExecutable: false` the section is absent; the three binding clauses are present verbatim; joiner arithmetic holds (11 sections → 10 joiners on the rich fixture).
- Claude lane: `buildPrefix` output byte-identical — golden suite passes unedited.
- Telemetry: success turn with promise-shaped tail → record carries `intentTrailer: true` + one info log; non-promise turn → field **absent** (not `false`); error turn with promise-shaped text → field absent, `error` intact; empty-text turns (reflection) → absent via detector short-circuit.

### Regression Surface

- **Zero-expectation-edit suites (C10) — real baselines recorded at `b51c496` (env stubs; counts identical on Node 24 and 26):**
  | Suite | Baseline |
  |---|---|
  | `src/agents/prefix-builder.golden.test.ts` | 12 passed |
  | `src/agents/prefix-builder.test.ts` | 12 passed |
  | `src/agents/toolkit-section.test.ts` | 26 passed |
  | `src/agents/provider-adapters/` (all 19 files: dispatch-loop, turn-scaffold, sse, all four adapters, tool-bridge, turn-assembly, tool-transport, error-classification, classification-crosscheck, provider-modules, builtin-executor, archetype-gate, skill-index, passthrough-providers, types) | 540 passed |
  | `src/activity/activity-logger.test.ts` | 19 passed |
- **Enumerated pre-existing test-file deltas (the complete list — C10/C16; nothing else may change):**
  1. `src/agents/prefix-builder.provider.test.ts` — baseline **15**, expected **16**. Assertion additions inside 3 existing tests ("full assembly renders every layer in spec order" order array; "sections are joined by …" count 9→10 + comment; gate "false → …" gains a not-contains) plus 1 new content-pin test. (Task 1.)
  2. `src/agents/agent-manager.test.ts` — baseline **227**, expected **230**. Three additive tests in a new describe; **zero edits to existing tests** — safe because every existing activity assertion is `objectContaining`/property-style and no existing `makeRunResult` fixture text matches the detector (swept explicitly in Task 3). (Task 3.)
- New test file: `src/agents/intent-trailer.test.ts` (18 tests; 21 after the pre-PR r1 hardening added 2 discourse-marker negatives + 1 slice-boundary test).
- Untouched modules (empty diff verified in Task 5): `dispatch-loop.ts`, `turn-scaffold.ts`, `sse.ts`, `tool-bridge.ts`, `turn-assembly.ts`, `toolkit-section.ts`, all four adapters, `types.ts` (provider-adapters), `session-store.ts`, `activity-logger.ts`, `docs/providers.md`.
- C16 note: the `classification-crosscheck.test.ts` literal fixture tables are decoupled from source — this plan makes **no** claim that any source mutation here would fail them (nothing in this ticket touches classification).

### Commands

- Node: default Node (v26) is fine for every command in this plan — CLAUDE.md's Node-26 breakage is tsx dev mode only, which no plan command uses; the plan reviewer reproduced all baselines on v26. `npm ci` already run in this worktree.
- Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Targeted inner loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/intent-trailer.test.ts src/agents/prefix-builder.provider.test.ts src/agents/prefix-builder.golden.test.ts src/agents/agent-manager.test.ts src/agents/provider-adapters/ src/activity/activity-logger.test.ts`
- Per-file count verification: `... npx vitest run <file>` and read the `Tests  N passed` line — vitest runtime output, never grep (`it.each` expansion).

### Verification Rules

- Every task ends with its verify command actually run and output matching the stated expectation before the task's commit (dodi-dev:verify).
- Zero-edit suites are verified by **count match against the baselines above** plus `git diff --name-only` showing no test file outside the enumerated two.
- No success claim for the negative-verification task without pasting the failing test names observed.

---

## File Structure

```
src/agents/prefix-builder.ts                   MODIFIED  (D1: followThroughSection + compose + docstring)
src/agents/prefix-builder.provider.test.ts     MODIFIED  (enumerated delta #1)
src/agents/intent-trailer.ts                   NEW       (D2: detector)
src/agents/intent-trailer.test.ts              NEW       (D2: detector fixtures)
src/agents/agent-manager.ts                    MODIFIED  (D2: one compute + conditional field + one log)
src/activity/types.ts                          MODIFIED  (D2: optional intentTrailer?: true)
src/agents/agent-manager.test.ts               MODIFIED  (enumerated delta #2)
```

---

### Task 0: Baseline pin

- [ ] Confirm worktree HEAD: `git -C /Users/mokie/github/lane-kpr-393-mature rev-parse --short HEAD` → `b51c496` (or a later commit of this lane containing it).
- [ ] Re-run the zero-edit baselines and confirm they match the table above:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/prefix-builder.golden.test.ts   # expect: Tests  12 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/prefix-builder.provider.test.ts # expect: Tests  15 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/agent-manager.test.ts           # expect: Tests  227 passed
  ```
- [ ] No commit (baseline only).

### Task 1: D1 — Lane B follow-through prompt section

All edits in `/Users/mokie/github/lane-kpr-393-mature/src/agents/prefix-builder.ts` and `/Users/mokie/github/lane-kpr-393-mature/src/agents/prefix-builder.provider.test.ts`.

- [ ] In `prefix-builder.ts`, add the new section helper directly **after** the `fileTierMemoryGuidance()` function (which ends at ~line 120):

  ```ts
  /**
   * KPR-393 §D1: Lane B follow-through pressure. Composed ONLY by
   * buildProviderInstructions (toolsExecutable-gated, directly after the
   * toolkit — it references tools, so tool-adjacent guidance stays
   * contiguous). buildPrefix never calls this: the Claude lane is trained
   * against the intent-trailer failure mode and its golden bytes stay
   * untouched. Generic phrasing by design — no per-tool paragraphs (the
   * toolkit section already names callback/schedule where provisioned).
   */
  export function followThroughSection(): string {
    return (
      "## Follow-through\n" +
      "When your reply commits to an action, do the action first: execute it with your tools in this turn, then report the result. " +
      'Never end a turn on unexecuted intent ("I\'ll check…", "on it", "first step is…").\n' +
      "If you genuinely cannot proceed, do not promise — state exactly what you are waiting on and from whom.\n" +
      "For work that must happen later, schedule it explicitly with your tools; do not assume a future turn will remember this one."
    );
  }
  ```

- [ ] In `buildProviderInstructions` (~line 333), insert the push directly after the toolkit push and before the pre-existing `// §D1: guidance keyed on the INVENTORY` comment (that comment is KPR-349's §D1, unrelated — do not touch it):

  ```ts
    if (input.toolsExecutable) {
      parts.push(buildProviderToolkitSection({ toolInventory: input.toolInventory, plugins: input.plugins }));
      // KPR-393 §D1: follow-through pressure directly after the toolkit.
      parts.push(followThroughSection());
  ```

- [ ] Update the `buildProviderInstructions` JSDoc layer-order line (~line 309) from
  `* †toolkit → †file-tier guidance (iff memory entry in inventory) →` to
  `* †toolkit → †follow-through (KPR-393) → †file-tier guidance (iff memory entry in inventory) →`

- [ ] In `prefix-builder.provider.test.ts` — enumerated delta #1, four edits:
  1. In `"full assembly renders every layer in spec order, datetime last"`, insert `"## Follow-through",` into the `order` array immediately after `"## Your toolkit",`.
  2. In `"sections are joined by \\n\\n---\\n\\n (joiners = sections − 1)"`, replace the comment and expectation:
     ```ts
      // 11 sections: soul, card, systemPrompt, constitution, team, toolkit,
      // follow-through, file-tier, skills, memory, datetime → 10 joiners.
      const joinerCount = instructions.split(SECTION_JOINER).length - 1;
      expect(joinerCount).toBe(10);
     ```
  3. In the gate test `"false → no toolkit, no file-tier, no skills; constitution/roster/memory still present"`, add after the `"## Your toolkit"` not-contains line:
     ```ts
      expect(instructions).not.toContain("## Follow-through");
     ```
  4. Add one new test at the end of the `"buildProviderInstructions — toolsExecutable gate"` describe (after the `"true + no memory entry in inventory …"` test):
     ```ts
      it("follow-through renders whenever tools are executable and pins the three binding clauses (KPR-393 §D1)", async () => {
        const input = richInputs();
        input.toolsExecutable = true;
        input.skillIndex = []; // independent of skills/memory inventory
        input.toolInventory = [engineEntry("slack")];
        const { instructions } = await buildProviderInstructions(makeAgentConfig(), input);
        expect(instructions).toContain("## Follow-through");
        // The three behavioral clauses are binding (spec §D1); wording drift
        // beyond them is fine, these anchors are not.
        expect(instructions).toContain("do the action first");
        expect(instructions).toContain("state exactly what you are waiting on and from whom");
        expect(instructions).toContain("schedule it explicitly with your tools");
      });
     ```

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/prefix-builder.provider.test.ts src/agents/prefix-builder.golden.test.ts src/agents/prefix-builder.test.ts
  # expect: Test Files 3 passed; Tests 40 passed (16 + 12 + 12) — golden at 12 = zero-diff proof
  ```
- [ ] Commit:
  ```
  KPR-393: D1 — Lane B follow-through prompt section

  followThroughSection() in prefix-builder, composed only by
  buildProviderInstructions inside the toolsExecutable gate, directly
  after the toolkit. buildPrefix untouched; golden suite zero-diff.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 2: D2 — intent-trailer detector module + fixtures

- [ ] Create `/Users/mokie/github/lane-kpr-393-mature/src/agents/intent-trailer.ts`:

  ```ts
  /**
   * KPR-393 §D2: intent-trailer detection — true when delivered text ends on
   * an unexecuted first-person commitment ("I'll check…", "on it", "first
   * step is…"). Conservative and English-only by design: bilingual or
   * non-English output is missed, so the telemetry undercounts rather than
   * misfires. Only booleans ever leave this module — callers must never
   * persist the text (redaction posture).
   *
   * Consumer: agent-manager's activity-audit write (every provider — the
   * Claude lane's rate is the control baseline). The phase-2 loop-nudge
   * decision criteria that read this telemetry are documented in
   * docs/epics/kpr-385/kpr-393-spec.md §D3 (Lane B rate ≥3× Claude AND
   * ≥5 occurrences/week AND ≥70% sampled precision, over ≥14d of data).
   */

  /** Only the tail is scanned — promises cluster at the end of a reply;
   *  bounding the window cuts false positives from mid-text narration of
   *  work that the rest of the reply then reports as done. */
  const TAIL_CHARS = 300;

  /**
   * Conservative first-person-future patterns (spec §D2), word-boundary
   * anchored, curly/straight apostrophes. "let me know" is excluded (a
   * request to the reader, not a self-commitment); bare "on it" anchors to
   * clause starts so "based on it" / "still working on it" never match.
   */
  const PATTERNS: readonly RegExp[] = [
    /\bI['’]ll\s+\p{L}+/iu, // "I'll check…"
    /\bI\s+will\s+\p{L}+/iu, // "I will draft…"
    /\bI['’]m\s+going\s+to\s+\p{L}+/iu, // "I'm going to pull…"
    /\blet\s+me\s+(?!know\b)\p{L}+/iu, // "Let me inspect…" (never "let me know")
    /(?:^|[.!?…\n—–]\s*)(?:I['’]m\s+)?on\s+it\b/iu, // clause-start "on it" / "I'm on it"
    /\bfirst\s+step\s+is\b/iu, // "First step is to inspect…"
  ];

  /** True when delivered text ends on an unexecuted first-person commitment.
   *  Conservative, English-only. Empty/whitespace text → false. */
  export function detectIntentTrailer(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const tail = trimmed.slice(-TAIL_CHARS);
    return PATTERNS.some((re) => re.test(tail));
  }
  ```

- [ ] Create `/Users/mokie/github/lane-kpr-393-mature/src/agents/intent-trailer.test.ts` (fixtures are text *shapes* from the spec's Sol transcripts — paraphrased, no verbatim thread content):

  ```ts
  import { describe, expect, it } from "vitest";
  import { detectIntentTrailer } from "./intent-trailer.js";

  // KPR-393 §D2. Positives seed from the two real failure archetypes the
  // spec documents (intra-turn plan-narration; cross-turn contingent
  // promise); negatives from the real zero-tool-but-correct shapes
  // ("No response needed", discussion verdicts, completed reports).

  describe("detectIntentTrailer — positives (Sol transcript shapes)", () => {
    it.each([
      // intra-turn archetype: plan narrated as the final message
      "Understood. I'll own the follow-up edit. First step is to inspect the current draft and existing feedback, then I'll post the exact proposed delta.",
      // cross-turn contingent promise
      "Yes. I'll lead rev 2 and give first review. Send the base commit and paths; I'll draft from there.",
      // bare acknowledgment closers
      "Got it — on it.",
      "On it.",
      // curly-apostrophe variant
      "Understood. I’ll check the deploy logs and report back.",
      "Good question. I'm going to pull the actual numbers before answering.",
      "Let me inspect the current artifact first.",
      "I will follow up with the vendor tomorrow.",
    ])("flags %j", (text) => {
      expect(detectIntentTrailer(text)).toBe(true);
    });
  });

  describe("detectIntentTrailer — negatives", () => {
    it.each([
      // meeting-rules-mandated reply (spec §Edge cases, fixture-pinned)
      "No response needed.",
      // substantive discussion verdict, no tools required
      "Verdict: ship it as-is. The deadline semantics are unchanged and the risk is contained to the new adapter.",
      // completed-work report
      "Done — the fix is deployed and the check passed.",
      // "on it" as substring / mid-clause (anchor guard)
      "The decision was based on it, so nothing changes.",
      "The team is still working on it and expects Friday.",
      // reader-directed closer, not a self-commitment
      "Here's the summary you asked for. Let me know if you want the longer version.",
      // empty / whitespace (reflection or aborted turns)
      "",
      "   \n  ",
    ])("does not flag %j", (text) => {
      expect(detectIntentTrailer(text)).toBe(false);
    });
  });

  describe("detectIntentTrailer — tail window", () => {
    it("a promise more than ~300 chars before the end does not flag (completed-report tail)", () => {
      const text =
        "I'll check the logs first. " +
        "The results follow. ".repeat(20) +
        "All checks passed; nothing further is required.";
      expect(text.length).toBeGreaterThan(400); // the promise sits outside the 300-char tail
      expect(detectIntentTrailer(text)).toBe(false);
    });

    it("a promise inside the final 300 chars flags even with long preceding text", () => {
      const text = "Analysis complete. ".repeat(30) + "Next, I'll draft the migration plan.";
      expect(detectIntentTrailer(text)).toBe(true);
    });
  });
  ```

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/intent-trailer.test.ts
  # expect: Test Files 1 passed; Tests 18 passed
  ```
- [ ] Commit:
  ```
  KPR-393: D2 — intent-trailer detector module

  Pure, conservative, English-only detectIntentTrailer over the final
  ~300 chars; fixtures seeded from the real Sol transcript shapes.
  Booleans only — no text leaves the module.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 3: D2 — activity-record wiring + type + manager tests

- [ ] In `/Users/mokie/github/lane-kpr-393-mature/src/activity/types.ts`, extend the `// Outcome` block of `ActivityRecord` (the interface's last two members are currently `streamed: boolean;` and `error?: string;`):

  ```ts
    // Outcome
    streamed: boolean;
    error?: string;
    /**
     * KPR-393 §D2: present-and-true iff the delivered text ends on an
     * unexecuted first-person commitment (detectIntentTrailer) on a
     * non-error turn. Absent otherwise — never false. Additive/optional:
     * schemaless Mongo, no migration. Detection is deliberately text-only —
     * slice against `toolCalls` in queries.
     */
    intentTrailer?: true;
  ```

- [ ] In `/Users/mokie/github/lane-kpr-393-mature/src/agents/agent-manager.ts`, add the import beside the other `./` sibling imports near the top of the file:

  ```ts
  import { detectIntentTrailer } from "./intent-trailer.js";
  ```

- [ ] In `recordSpawnObservability` (the `// Activity audit` block at ~line 1859), replace:

  ```ts
      // Activity audit
      this.activityLogger?.record({
  ```

  with:

  ```ts
      // Activity audit
      // KPR-393 §D2: fleet-wide intent-trailer telemetry — boolean only, no
      // text stored (redaction posture). Error turns are skipped even when
      // text is present (a delivered error is not a promise). Every provider
      // runs the detector — the Claude lane's rate is the phase-2 control.
      const intentTrailer = !result.error && detectIntentTrailer(result.text);
      if (intentTrailer) {
        log.info("Intent trailer detected", {
          agentId: ctx.agentId,
          model: this.registry.get(ctx.agentId)?.model ?? "unknown",
          toolCalls: result.toolCalls,
        });
      }
      this.activityLogger?.record({
  ```

  and inside the record object literal, add as the final entry after `error: result.error,`:

  ```ts
        error: result.error,
        ...(intentTrailer ? { intentTrailer: true as const } : {}),
  ```

- [ ] **C16 record-literal sweep (checkbox, output pasted into the task log):** confirm no existing `agent-manager.test.ts` fixture text can trip the detector and no existing assertion is exact-object-equality on the activity record:
  ```bash
  grep -nE "text: \"[^\"]*(I'll|I’ll|on it|let me|first step|going to|I will)" src/agents/agent-manager.test.ts
  # expect: no output
  grep -n "activityLogger.record).toHaveBeenCalledWith(" src/agents/agent-manager.test.ts
  # expect: every hit wraps expect.objectContaining — none are bare object literals
  ```

- [ ] In `/Users/mokie/github/lane-kpr-393-mature/src/agents/agent-manager.test.ts` — enumerated delta #2, purely additive: insert the following describe immediately **after** the closing `});` of the test `"records telemetry, conversation index, and activity audit on success"` (~line 4041; all helper identifiers — `registry`, `memoryManager`, `sessionStore`, `turnTelemetryStore`, `mockRunnerSend`, `makeRunResult`, `makeWorkItem`, `makeCtx` — are in scope there):

  ```ts
      describe("intent-trailer telemetry (KPR-393 §D2)", () => {
        function makeAuditManager() {
          const activityLogger = { record: vi.fn() };
          const localManager = new AgentManager(
            registry as any,
            memoryManager as any,
            sessionStore as any,
            undefined as any,
            turnTelemetryStore as any,
            activityLogger as any,
          );
          return { activityLogger, localManager };
        }

        it("sets intentTrailer: true when the delivered text ends on an unexecuted commitment", async () => {
          const { activityLogger, localManager } = makeAuditManager();
          mockRunnerSend.mockResolvedValueOnce(
            makeRunResult({ text: "Understood — I'll check the deploy logs and report back." }),
          );
          const item = makeWorkItem({ text: "check the logs", source: { kind: "sms", id: "line-1", label: "May" } });
          await localManager.spawnTurn(makeCtx(item, "sms"));
          expect(activityLogger.record).toHaveBeenCalledTimes(1);
          expect(activityLogger.record.mock.calls[0]![0].intentTrailer).toBe(true);
        });

        it("omits the field entirely on a non-promise turn (absent, not false)", async () => {
          const { activityLogger, localManager } = makeAuditManager();
          mockRunnerSend.mockResolvedValueOnce(
            makeRunResult({ text: "Done — the fix is deployed and the check passed." }),
          );
          const item = makeWorkItem({ text: "status?", source: { kind: "sms", id: "line-1", label: "May" } });
          await localManager.spawnTurn(makeCtx(item, "sms"));
          const arg = activityLogger.record.mock.calls[0]![0];
          expect("intentTrailer" in arg).toBe(false);
        });

        it("error turn with promise-shaped text stays unflagged (a delivered error is not a promise)", async () => {
          const { activityLogger, localManager } = makeAuditManager();
          mockRunnerSend.mockResolvedValueOnce(
            makeRunResult({ text: "I'll retry the deploy right away.", error: "exit code 1" }),
          );
          const item = makeWorkItem({ text: "deploy", source: { kind: "sms", id: "line-1", label: "May" } });
          await localManager.spawnTurn(makeCtx(item, "sms"));
          const arg = activityLogger.record.mock.calls[0]![0];
          expect(arg.error).toBe("exit code 1");
          expect("intentTrailer" in arg).toBe(false);
        });
      });
  ```

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/agent-manager.test.ts src/activity/activity-logger.test.ts
  # expect: Test Files 2 passed; agent-manager Tests 230 passed, activity-logger 19 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck
  # expect: clean exit
  ```
- [ ] Commit:
  ```
  KPR-393: D2 — intentTrailer activity telemetry wiring

  One boolean computed at the manager's activity-audit write (skipped on
  error turns), optional additive ActivityRecord field set only when
  detected, one redaction-safe info log. All providers — Claude is the
  control baseline.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 4: Negative verification (repo convention — no committed changes)

Two temporary reverts of the load-bearing new behavior; paste the observed failing test names, then restore. Per C16: no claim is made (or tested) that any decoupled literal fixture table fails from these mutations — the pins below are direct consumers.

- [ ] Revert A — D1 composition:
  ```bash
  perl -pi -e 's/^(\s*)parts\.push\(followThroughSection\(\)\);/$1\/\/ NEGVERIFY parts.push(followThroughSection());/' src/agents/prefix-builder.ts
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/prefix-builder.provider.test.ts
  ```
  Expected: **3 failed / 13 passed** — failing: "full assembly renders every layer in spec order, datetime last"; "sections are joined by \n\n---\n\n (joiners = sections − 1)"; "follow-through renders whenever tools are executable and pins the three binding clauses (KPR-393 §D1)". The gate-false absence assertion passes vacuously when the section is never composed — that is expected, not a gap. **Record the actual observed set; all 3 named failures required.**
  ```bash
  git checkout -- src/agents/prefix-builder.ts
  ```
- [ ] Revert B — D2 wiring:
  ```bash
  perl -pi -e 's/const intentTrailer = !result\.error && detectIntentTrailer\(result\.text\);/const intentTrailer = false as boolean; \/\/ NEGVERIFY/' src/agents/agent-manager.ts
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts -t "intent-trailer"
  ```
  Expected: **1 failed** — "sets intentTrailer: true when the delivered text ends on an unexecuted commitment" (the two absence tests still pass, as designed).
  ```bash
  git checkout -- src/agents/agent-manager.ts
  ```
- [ ] Confirm clean tree: `git status --porcelain` → empty (besides this plan file if not yet committed by the walking session).
- [ ] No commit.

### Task 5: Final gate, count verification, zero-diff audits

- [ ] Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → all green.
- [ ] Zero-edit suite counts match baselines exactly:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/prefix-builder.golden.test.ts src/agents/prefix-builder.test.ts \
    src/agents/toolkit-section.test.ts src/activity/activity-logger.test.ts src/agents/provider-adapters/
  # expect: golden 12, prefix-builder 12, toolkit-section 26, activity-logger 19, provider-adapters 540 — all passed, zero edits
  ```
- [ ] Diff audit — only the seven enumerated files changed since `b51c496`:
  ```bash
  git diff --name-only b51c496 -- src/ docs/providers.md
  # expect exactly:
  #   src/activity/types.ts
  #   src/agents/agent-manager.test.ts
  #   src/agents/agent-manager.ts
  #   src/agents/intent-trailer.test.ts
  #   src/agents/intent-trailer.ts
  #   src/agents/prefix-builder.provider.test.ts
  #   src/agents/prefix-builder.ts
  # (docs/providers.md absent = no parity-row change, per spec §Integration points)
  ```
- [ ] Docs confirmation (spec §Integration points): `docs/providers.md` untouched; direct the PR body to note: "Prompt guidance (KPR-393 follow-through section) applies uniformly to all four Lane B providers; not a parity-matrix behavior row — no caveat row added." If the implementer judges a caveat row IS warranted, stop and surface to the walking session rather than editing unilaterally. While making the no-caveat call, glance at the Lane B intro line (`docs/providers.md` ~line 9, "they get the same prompt assembly … as Claude") — already imprecise pre-existing phrasing the new section brushes against; no row change is forced by it (reviewer-confirmed), just don't let it flip your judgment silently.
- [ ] D3 confirmation: no loop/scaffold/adapter diffs exist (covered by the diff audit above); the phase-2 criteria live in the spec §D3 and are referenced from `intent-trailer.ts`'s docstring — nothing further to build (C1).
- [ ] No commit unless fixes were needed (any fix commits use the same trailer).

---

## Execution Handoff

Execute tasks in order (0→5); each of Tasks 1–3 is one commit. The walking session owns the plan-file commit and the PR. Rollback story: D1 is prompt text (revert = one commit revert, next spawn reassembles); D2 is an optional field readers must not assume (revert = one commit revert; stray `intentTrailer` fields in `activity_log` are inert and age out with the TTL).
