# KPR-454 plan — chunk 4: capture points and boot

Implements design **D2**, **D3**, **D6** (the stable-identity fix), **D10** (wiring) and **AC13**/**AC14**. Two tasks, two commits.

Two placement rules in this chunk are correctness constraints, not style points, and both have a history of being got wrong:

1. The two new hook matchers go **outside** the archetype `PreToolUse` `try`/`catch` in `buildHooks`. They are adjacent in the function and collapsing them into one `try` silently couples a diagnostics feed to a fail-closed security gate **in both directions** — a broken archetype would disarm failure observation, and a broken observer would disarm archetype policy.
2. The publisher's construction, `init()` and `setOpsPublisher(` go **above** `src/index.ts`'s `// ── Spawn-capable boundary ──` marker, and both anchors go in **all three** of `src/boot-order.test.ts`'s lists. Adding to list (a) alone is the exact failure mode that guard exists to catch.

---

### Task 5: Capture points on both lanes, and `agentId` through the Lane B assembly

**Files:**
- Modify: `src/agents/agent-runner.ts:1936-1974` (`buildHooks`)
- Modify: `src/agents/provider-adapters/turn-assembly.ts:96-158` (interface), `:244` (primary return), `:327` (nested return)
- Modify: `src/agents/provider-adapters/turn-scaffold.ts:186-196`
- Modify: `src/agents/provider-adapters/tool-bridge.ts:49-67` (options), `:318-359` (`wrap`)
- Create: `src/ops/testing/lane-harness.ts`
- Create: `src/ops/capture-points.integration.test.ts`

⚠ **The two lane harnesses live in a plain module, `src/ops/testing/lane-harness.ts` — NOT exported from a `.test.ts`.** Chunk 5's AC8/AC11/AC12 drive a real `AgentRunner` hook set and a real `ToolBridge` through the same construction this task builds, and an earlier draft had `capture-points.integration.test.ts` export them. That is wrong on measurement, not on taste: under vitest 4.1.11 a consumer importing a `.test.ts` **re-registers that file's suites and file-scope hooks into the importer**, so this task's `beforeEach`/`vi.mock` would become active for the acceptance file's cases and this suite would run twice under different fixtures. The repository has **zero** cross-`.test.ts` imports; the established pattern is a plain module (`src/obligations/testing/{fake-db,harness,refusals}.ts`), which this plan already follows for `src/ops/testing/fake-db.ts`. A plain module also gets `tsc --noEmit` coverage, which `.test.ts` files do not.

Put `buildClaudeLaneHarness(...)` and `buildLaneBHarness(...)` there; **both** `capture-points.integration.test.ts` and `acceptance.integration.test.ts` import from it, and neither imports the other.

- [ ] **Step 1:** Add the two matchers to `buildHooks`, outside the archetype `try`.

Replace the tail of `buildHooks` — the `return hooks;` at `agent-runner.ts:1973` — with the block below, leaving the `PreCompact` assignment and the whole archetype `try`/`catch` exactly as they are.

```typescript
    // ── KPR-454 D2: runtime tool-failure observation ────────────────────
    // Registered OUTSIDE the archetype try/catch above, deliberately: a
    // broken archetype must not disarm failure observation, and a broken
    // observer must not disarm the fail-closed deny-all PreToolUse matcher.
    // The two are adjacent in this function and collapsing them into one try
    // couples a diagnostics feed to a security gate in both directions
    // (AC13, structurally pinned by a test).
    //
    // Both matchers are unmatched (all tools), both are async, and both
    // RETURN AN EMPTY OBJECT. The SDK's PostToolUse/PostToolUseFailure
    // hookSpecificOutput offers `additionalContext` and (on PostToolUse) a
    // classifier-context field; neither is used, and a test pins the empty
    // return — a hook that altered tool output would breach C15's "cannot
    // alter a turn's outcome" on the one path where altering is trivially
    // available.
    hooks.PostToolUseFailure = [{
      hooks: [async (input: HookInput) => {
        // Rule 1: OWN-ABORT SUPPRESSES. A turn killed by its wall-clock
        // deadline (KPR-402) or by an operator abort produces tool errors
        // that are consequences of the kill, not faults of the tool.
        // `is_interrupt` alone does NOT suppress: an interrupt the runtime
        // did not cause is a real fault, and it is the KPR-438
        // background-subagent signature this producer should be the standing
        // detector for.
        if (this.wasAborted) return {};
        const failure = input as PostToolUseFailureHookInput;
        // Rule 2: identity is read AT FIRE TIME, never captured at build
        // time — this.workItemContextRef.current is KPR-453's live reference
        // and this.agentConfig.id is the stable slug (never the display
        // name). buildHooks is rebuilt per send() and AgentRunner is
        // per-spawn, so capture-at-build would be equivalent TODAY; reading
        // .current is required anyway, because KPR-453 canon fixes the
        // pattern rather than the coincidence.
        const ctx = this.workItemContextRef.current;
        observeToolFailure({
          tool: failure.tool_name,
          error: failure.error,
          lane: "claude",
          agentId: this.agentConfig.id,
          workItemId: ctx?.workItemId,
          threadId: ctx?.threadId,
          durationMs: failure.duration_ms,
          signals: { isInterrupt: failure.is_interrupt },
        });
        return {};
      }],
    }];
    // The SUCCESS hook — the shipped CLI's own hook table describes
    // PostToolUse as "Run after successful tool", so this is the RECOVERY
    // signal D2 makes an obligation, never a failure signal. NO FIELD of the
    // SDK's success payload beyond the tool's name is read: the outcome is
    // carried by WHICH hook event fired, and is never inferred from what the
    // tool returned or from what the turn spent (C12/AC15). Chunk 5's hunk
    // scan runs over this insertion, so keep the result field's own name out
    // of this comment too.
    hooks.PostToolUse = [{
      hooks: [async (input: HookInput) => {
        if (this.wasAborted) return {};
        observeToolSuccess({ tool: (input as PostToolUseHookInput).tool_name, lane: "claude" });
        return {};
      }],
    }];

    return hooks;
  }
```

Imports to add at the top of `agent-runner.ts`:

```typescript
import { observeToolFailure, observeToolSuccess } from "../ops/observe.js";
import type { PostToolUseFailureHookInput, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
```

Both hook events are already in `HOOK_EVENTS` and in the `HookEvent` union (verified in `sdk.d.ts` at 0.3.258, lines 854 and 873), so they are wireable through the existing `Partial<Record<HookEvent, HookCallbackMatcher[]>>` shape with no type work.

Subagent-originated failures are **included**: `BaseHookInput.agent_id` is present only inside a subagent and no filtering is applied — a delegate's tool failure is a runtime tool failure. `agent_id` is **not stored**; the publishing agent is the parent's stable slug, matching Lane B where a nested delegate turn's bridge carries the parent's assembly.

- [ ] **Step 2:** Add `agentId?` to `ProviderTurnAssembly` and set it at both construction sites.

In `turn-assembly.ts`, inside the `ProviderTurnAssembly` interface, beside `memoryInTurnInput?`:

```typescript
  /**
   * KPR-454 D6: the agent's `agent_definitions` SLUG — the stable identity
   * D5 requires. Needed because ToolBridgeOptions.agentId is documented
   * "logging/telemetry label only" and is fed `config.name`, the DISPLAY
   * name, which D5 says is never an identity.
   *
   * Optional because this type is frozen provider ABI
   * (LANE_B_PROVIDER_ABI_VERSION = 1): this is exactly the
   * `datetimeInTurnInput?` (KPR-432) / `memoryInTurnInput?` (KPR-434)
   * additive-optional precedent and needs no version bump. Absent ⇒ the
   * `agentId` detail key is OMITTED on a published tool failure, never
   * substituted with the display name and never guessed.
   */
  agentId?: string;
```

In `assembleProviderTurn`'s return (`:244`), add `agentId: input.config.id,` beside `instructions`. That return **is** the assembly object, so "beside `instructions`" is unambiguous.

In `buildNestedDelegateAssembly`'s return (`:327`), the shape is **different and the field goes one level in**. That return is `{ assembly: { … }, maxTurns }`, so `agentId: input.config.id,` belongs **inside the `assembly:` object literal that opens at `:328`**, beside `instructions` / `datetimeInTurnInput` / `memoryInTurnInput` — not at the top level of the returned object, where it would be a stray property on a `{assembly, maxTurns}` wrapper that `ProviderTurnAssembly` never sees. The value `input.config.id` is correct here: it is the **parent's** slug, matching the Claude lane's treatment of subagents in D2.

- [ ] **Step 3:** Forward it into the bridge.

In `tool-bridge.ts`'s `ToolBridgeOptions`, beside the existing `agentId`:

```typescript
  /** Logging/telemetry label only (adapter passes its display name). */
  agentId: string;
  /**
   * KPR-454 D6: the agent_definitions SLUG, distinct from the display label
   * above. The second field needs a second name because `agentId` is already
   * taken here by the display label; `agentSlug` says which of the two
   * identities the bridge is holding at the one site that holds both.
   * Optional — absent ⇒ the published `agentId` detail key is omitted.
   * `agentId` keeps its documented meaning and all its existing log call
   * sites; nothing renames it.
   */
  agentSlug?: string;
```

In `turn-scaffold.ts:186-196`, inside the `new ToolBridge({…})` literal, after `agentId: this.scaffoldInit.name,`:

```typescript
      agentSlug: this.scaffoldInit.assembly.agentId, // KPR-454 D6 — the slug, not the display label
```

- [ ] **Step 4:** Add the two observe calls inside `wrap()`.

Replace `tool-bridge.ts:347-356` — from `const t0 = Date.now();` through the `catch` arm's closing brace (`:346` closes the `signal.aborted` guard and `:357` closes `execute`; verified at this tree) — with:

```typescript
        const t0 = Date.now();
        try {
          const result = await underlying(input);
          this.record(name, Date.now() - t0);
          // KPR-454 D3, the recovery half. Two arguments and no others — the
          // same closed pair the Claude lane's success hook passes.
          observeToolSuccess({ tool: name, lane: "laneB" });
          return result;
        } catch (err) {
          this.record(name, Date.now() - t0);
          // KPR-454 D3, the failure half. THE single Lane B capture point:
          // every Lane B failure passes through this one catch — an MCP
          // isError converted to a throw in discover() (:290-308, which
          // throws PRECISELY so this catch handles it), a builtin throw, a
          // transport rejection, a delegate Task fault. Nothing is added at
          // discover().
          //
          // Own-abort suppresses: an abort DURING execution surfaces as a
          // rejection and would otherwise be indistinguishable from a fault.
          // Reading the signal here is Lane B's exact analogue of the Claude
          // lane's `wasAborted`, and the two lanes must suppress the same
          // class or the tool-health view is lane-skewed.
          if (!this.opts.signal.aborted) {
            observeToolFailure({
              // `name` is the CANONICAL name the wrapper closed over —
              // mcp__<server>__<tool> or a builtin — BEFORE
              // applyNameAndCapEdges sanitizes/truncates/de-collides for
              // provider constraints. That method builds a new object and
              // never rewrites this closure, so Claude/Lane A/Lane B rows for
              // one tool share a subject.id (AC11).
              tool: name,
              error: errorText(err),
              lane: "laneB",
              agentId: this.opts.agentSlug,
              workItemId: this.opts.workItemContext?.workItemId,
              threadId: this.opts.workItemContext?.threadId,
              durationMs: Date.now() - t0,
              // D6's "the bridge's own TOOL_CALL_TIMEOUT_MS path", supplied as
              // the typed signal it actually arrives as. That constant is
              // handed to the MCP SDK as RequestOptions.timeout (:235, :245,
              // :283), and the SDK rejects with a JSON-RPC McpError whose
              // numeric `.code` is -32001 — which classifyToolError maps to
              // `timeout` ahead of any text test. Read defensively: `err` is
              // `unknown` and most throws here carry no `code` at all.
              signals: {
                mcpErrorCode:
                  typeof (err as { code?: unknown })?.code === "number"
                    ? ((err as { code: number }).code)
                    : undefined,
              },
            });
          }
          // Mirrors the KPR-122 in-process structured-error invariant.
          return `Tool execution failed (${name}): ${errorText(err)}`;
        }
```

Four things are deliberately **not** published from this method, and each for its own reason:

| Site | Text | Why not |
| --- | --- | --- |
| `:341-342` | `Tool call denied by policy: …` | A guardrail deny is policy **working**, not a fault. Publishing it would make correct enforcement look like breakage. |
| `:344-345` | `Tool execution aborted (…)` | Pre-execution abort check; the turn is already dying. |
| the `catch`, when `signal.aborted` | — | Handled above: Lane B's analogue of `wasAborted`. |
| `discover()`'s `isError` conversion | — | Not a separate site: it throws precisely so this one catch handles it. Nothing is added there. |

Import at the top of `tool-bridge.ts`: `import { observeToolFailure, observeToolSuccess } from "../../ops/observe.js";`

- [ ] **Step 5:** Write `src/ops/testing/lane-harness.ts` and `src/ops/capture-points.integration.test.ts`.

Build the two harnesses in the plain module first (see the ⚠ note under **Files**), then write this suite against them. ⚠ `src/ops/testing/**` is **excluded** from chunk 5's AC7/AC15 source scans over `src/ops/**` — deliberately, because a lane harness legitimately constructs `RunResult` baselines mentioning `costUsd` and drives runner machinery; those scans constrain the producer's own sources, not its test doubles. Chunk 5's `opsSources` carries the exclusion.

Minimum assertions:

- **Hook placement, direction 1 (AC13) — a thrown archetype must not disarm the observers.** This one is a **real drive**, and the harness already exists: `agent-runner.test.ts:3283`, `it("buildHooks installs deny-all when preToolUseHooks throws (fail-closed)")`, registers a throwing archetype, builds a runner with `makeRunner({ soul, systemPrompt, archetype, archetypeConfig })` and reads `(runner as any).buildHooks()`. Copy that construction into `lane-harness.ts` rather than assuming the private-method seam and the runner shape — an earlier draft silently depended on both. Assert the returned map carries the deny-all `PreToolUse` matcher **and** both `PostToolUseFailure` and `PostToolUse`.

- **Hook placement, direction 2 (AC13) — a broken observer must not disarm the deny-all matcher. Asserted STRUCTURALLY, because it has no realizable runtime failure mode.** Registration of the two observers is straight-line assignment of two array literals; it cannot throw. And the only way to *make* it throw — a `vi.mock` factory for `../ops/observe.js` that throws — kills the module import, taking `AgentRunner` with it, so the test cannot then assert anything about the hook map at all. The property is therefore asserted where it actually lives, in the source: read `src/agents/agent-runner.ts` and assert that `indexOf("hooks.PostToolUseFailure =")` and `indexOf("hooks.PostToolUse =")` both **exceed** `indexOf("All tool calls blocked until the archetype is fixed.")` — the deny-all arm's `permissionDecisionReason` literal at `:1966`, which is confirmed to occur only inside the archetype catch. Anchor on that literal, not on "the closing brace of the try/catch": a brace has no stable textual form to search for, and an implementer left to find one will invent an anchor that reads green regardless. Add a second assertion that both lines are at the function's own indentation (they are top-level statements of `buildHooks`, four spaces), which is what distinguishes "after the catch" from "inside it but textually later". That is the placement rule the criterion is really about, it fails the moment someone moves either assignment inside the `try`, and unlike a thrown-registration drive it is a claim the test can actually see.
- **Empty return:** both matchers' callbacks resolve to `{}` — deep-equal, no `hookSpecificOutput`.
- **Own-abort (AC12):** with `runner.abort()` already called, `PostToolUseFailure` publishes nothing; with `signal.aborted` set, Lane B's catch publishes nothing.
- **Foreign interrupt (AC12):** `is_interrupt: true` with the runner not aborted publishes `errorSig: "interrupted"`.
- **Guardrail deny (AC12):** a gate returning `{behavior: "deny"}` publishes nothing (the denial text is returned; nothing is enqueued).
- **Lane parity (AC11):** the same underlying tool name — including one long enough to trigger `applyNameAndCapEdges` truncation — yields the identical `subject.id` from both lanes.
- **`agentSlug` absent:** with no `agentId` on the assembly, the published `detail` omits `agentId` entirely (no `undefined`, no display name).
- **Containment (AC8, negative-verify):** with a publisher that throws on every call, and again with one whose `insertOne` always rejects, a Claude-lane turn and a Lane B turn produce byte-identical `RunResult`s to a run with no publisher wired, and the turn's own error/abort classification is unchanged. Negative-verify: remove the `try` from `observeToolFailure` and confirm the Lane B case fails.

- [ ] **Step 6:** Run the `PostToolUseFailure` failure-class probe (`⚠ Verify at implementation`).

Write `scripts/probe-posttooluse-failure.ts` (scratch, **not** committed unless the implementer judges it worth keeping beside `scripts/repro-bg-subagent-mcp.ts`; if kept, add it to that directory with a header comment naming this ticket). Leaving it untracked is safe: `scripts/` is outside `tsconfig.include`, outside `eslint src/ setup/` and outside the prettier globs, so a scratch file there cannot fail Task 6's `npm run check`.

```typescript
// Probes WHICH Claude-lane failure classes fire PostToolUseFailure.
// MUST run through the SDK's BUNDLED binary — `query()` from inside this repo
// resolves @anthropic-ai/claude-agent-sdk-darwin-arm64. NEVER `claude -p`,
// which tests the wrong binary (CLAUDE.md, "Agent CLI = the SDK's bundled
// native binary"). The fleet floats ^0.3.258, so deployed instances resolve
// HIGHER than this lockfile — record the resolved version with the result.
import { query } from "@anthropic-ai/claude-agent-sdk";

const fired: string[] = [];
// Register PostToolUseFailure + PostToolUse matchers that push
// `${hook_event_name}:${tool_name}` into `fired`, then drive one prompt per
// class below and print the map.
```

Classes to enumerate, one run each:

| # | Class | How to provoke |
| --- | --- | --- |
| 1 | Throwing in-process MCP tool | a `createSdkMcpServer` tool whose handler throws |
| 2 | MCP `isError` result | a tool returning `{isError: true, content: […]}` |
| 3 | Stdio-server fault | an `mcpServers` stdio entry pointing at a command that exits immediately |
| 4 | Builtin throw | `Read` on a nonexistent absolute path; `Bash` on a command exiting nonzero |
| 5 | KPR-438-style interrupt | the delegating-subagent shape from `scripts/repro-bg-subagent-mcp.ts` (note that script's own caveat: it does **not** reliably reproduce, so treat a null result as inconclusive, not as "does not fire") |
| 6 | **Claude-lane `PreToolUse` DENY** | a `PreToolUse` matcher returning `permissionDecision: "deny"` — i.e. what the archetype gate and the fail-closed deny-all arm actually produce |

**Class 6 is the class AC12 turns on, and it is not optional.** AC12 requires "a guardrail deny publishes nothing" **with no lane qualification**, but the only deny assertion in Step 5 is Lane B's `{behavior: "deny"}`, which returns at `tool-bridge.ts:341` *before* `t0` and therefore provably publishes nothing. The Claude lane is the one with a real fail-closed gate, and whether the CLI fires `PostToolUseFailure` for a call it denied at `PreToolUse` is **unverified**: this plan's only suppression on that hook is `wasAborted`, which a denied call does not set. If it fires, **every archetype denial mints a `tool-failed` row** — policy working, recorded as breakage — and AC12 is violated on exactly the lane that matters.

**⚠ There is no per-call denial field on `PostToolUseFailureHookInput`, so the probe must record more than one fact.** Read from the installed `sdk.d.ts` at 0.3.258: `PostToolUseFailureHookInput` (`:2446-2457`) is `BaseHookInput & { hook_event_name, tool_name, tool_input, tool_use_id, error: string, is_interrupt?, duration_ms? }`, and `BaseHookInput` (`:167`) adds only `session_id`, `transcript_path`, `cwd`, `prompt_id?`, `permission_mode?`, `agent_id?`, `agent_type?`, `effort?`. `permission_mode` is session-level and constant on this fleet, so it cannot discriminate a denied call from an executed one, and `error` is free text, which the next paragraph forbids using. An earlier draft pre-decided a remedy "keyed on the SDK's own denial marker on that input" — that marker does not exist, and an implementer obeying it would make a design call at the keyboard, which is exactly what round 1 removed from the sibling assertion.

**So the probe records THREE facts for class 6, not one:** (i) does `PostToolUseFailure` fire for a `PreToolUse`-denied call, (ii) does `PermissionDenied` fire for it, and (iii) **in what order**. `PermissionDenied` is a first-class hook event (`HOOK_EVENTS` `:854`, `HookEvent` union) and `PermissionDeniedHookInput` (`:2277-2284`) carries `tool_use_id` and `reason`, both verified at this tree.

**The remedy if class 6 fires**, in order of preference:

1. **Id-keyed suppression, if and only if the probe observes `PermissionDenied` firing BEFORE `PostToolUseFailure` for the same `tool_use_id`.** Register a third matcher recording denied `tool_use_id`s into a per-runner `Set`, and have `PostToolUseFailure` return early on membership. Structural, not text-inferred. The ordering is **unverified** and fact (iii) is what decides it — a `PermissionDenied` that fires after, or not at all, makes this unbuildable.
2. **If neither structural discriminator exists** — no `PermissionDenied`, or the wrong order — the ticket **demotes to the spec lane** under this plan's own Verification Rule 3 (a testing-exposed spec/plan mismatch is not reinterpreted here). AC12's Claude-lane clause needs a decision the design does not contain, and inventing one in an implementation lane is the failure mode this paragraph exists to prevent.

Do **not**, under either branch, suppress by inferring "this looks like a policy message" from `failure.error` text — that is a C12 inference, and this producer's whole discipline is that outcome is published, never inferred. If class 6 does not fire at all, record that and leave the matcher as written.

Record, in the implementation report, a table of class → fired/did-not-fire, plus the **resolved** SDK version — `npm ls @anthropic-ai/claude-agent-sdk` (prints `@anthropic-ai/claude-agent-sdk@0.3.258` against this tree today). ⚠ The obvious `node -p "require('@anthropic-ai/claude-agent-sdk/package.json').version"` **does not work here** and must not be used: the package's `exports` map declares no `./package.json` subpath, so it dies with `ERR_PACKAGE_PATH_NOT_EXPORTED`. If a machine-readable string is wanted instead of `npm ls`'s tree, read the file directly, bypassing `exports`: `node -p "JSON.parse(require('fs').readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8')).version"`. Both forms were run in this worktree; both print `0.3.258`.

**The rule on a class that does not fire (C12/AC15): it is left UNCAPTURED on the Claude lane in this ticket.** It is not papered over by inferring failure from a `PostToolUse` `tool_response`, from `costUsd`, from a duration or from an elapsed-time threshold. If a class does not fire, add one line to the `CLAUDE.md` bullet in Task 6 Step 5 naming it, so the next reader knows the coverage boundary rather than assuming totality.

- [ ] **Step 7:** Verify and commit.

Run:
```
npx vitest run src/ops/capture-points.integration.test.ts
npx vitest run src/agents/agent-runner.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/turn-scaffold.test.ts
npm run check:bundle
```
`check:bundle` matters here specifically: `ProviderTurnAssembly` is re-exported from `provider-abi.ts`, so the new field enters the `pkg/types/` d.ts closure that KPR-407's tracer and `scripts/check-bundle-strings.mjs` guard. A field name or doc comment carrying a forbidden business string would fail there rather than in `npm run check`. Non-obvious but worth knowing: this commit is **not** untypechecked despite the absence of a bare `npm run typecheck` above — `check:bundle` → `bundle` → `build` → `tsc`.

```bash
git add src/agents/agent-runner.ts src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/turn-scaffold.ts src/agents/provider-adapters/tool-bridge.ts src/ops/testing/lane-harness.ts src/ops/capture-points.integration.test.ts
git commit -m "feat(KPR-454): capture points on both lanes; agentId through the Lane B assembly

D2: PostToolUseFailure (failure) and PostToolUse (recovery) matchers in
buildHooks, registered outside the archetype fail-closed try so neither can
disarm the other, both returning an empty object, both suppressing on
wasAborted while letting a foreign interrupt through as errorSig:interrupted.
D3: the two lines at wrap()'s single site, with Lane B's signal.aborted as the
exact analogue of wasAborted. D6: ProviderTurnAssembly.agentId? (additive
optional on frozen ABI v1) -> ToolBridgeOptions.agentSlug?, so the published
agent is the definitions slug rather than the display label.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the publisher above the spawn-capable boundary

**Files:**
- Modify: `src/index.ts:404-473` (wiring block), `:575` (SIGUSR1 handler), `~:940` (shutdown)
- Modify: `src/boot-order.test.ts:40-96`
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Construct and wire, above the marker.

Insert immediately before the `// ── Spawn-capable boundary (KPR-394, restated by KPR-414) ──` comment at `index.ts:474`, after the meeting-scribe/ack-lever block:

```typescript
  // KPR-454 (D10): the ops tool-failure publisher. Publishing is a SPAWN-READ
  // fact — the first turn after boot can fail a tool — so construction,
  // init() and singleton registration all sit ABOVE the spawn-capable
  // boundary below, alongside the KPR-394/414/417 wiring. Guarded by
  // src/boot-order.test.ts, which carries both anchors in all three of its
  // lists.
  //
  // init() is NON-FATAL to boot, with a split posture (D10):
  //  - index faults are contained INSIDE init() and keep the publisher wired
  //    (the meeting-scribe precedent at :456, not the worker-pool's
  //    boot-fatal one — none of these indexes carries a correctness role, and
  //    a TTL conflict after a routine activity.retentionDays change must not
  //    silently stop failure recording);
  //  - a REGISTRY-UPSERT fault throws out of init() and leaves the publisher
  //    UNSET, which is the honest degrade: with no registry rows C5 would
  //    fail closed on every publish, so a wired-but-registryless publisher
  //    would spend the rejection counter — the mis-integrated-producer signal
  //    — on what is actually a Mongo outage. Unset ⇒ every observe call is a
  //    no-op.
  const opsPublisher = new OpsPublisher(db, config.activity.retentionDays);
  try {
    await opsPublisher.init();
    setOpsPublisher(opsPublisher);
    // No getSnapshot() argument. Chunk 3 documents that method as having "no
    // caller in this diff, deliberately" (the KPR-220 spawn-coordinator
    // precedent) and D10 invariant (a) agrees; a boot log would be that
    // caller. It would also carry no information — every counter is zero at
    // this instant, since nothing has published yet. init() already logs the
    // three facts worth having (reasons, subscriptions, indexFailures).
    log.info("Ops publisher wired (KPR-454)");
  } catch (err) {
    log.error("Ops publisher init failed — tool-failure publishing is OFF this boot", { error: String(err) });
  }
```

Imports at the top of `index.ts`:

```typescript
import { OpsPublisher } from "./ops/publisher.js";
import { setOpsPublisher } from "./ops/publisher-singleton.js";
```

⚠ **Naming collision to avoid:** `src/ops/publisher-singleton.ts` exports a reader named `opsPublisher()`. `index.ts` does **not** import that reader, so the local `const opsPublisher` above is unambiguous — but do not add the reader import to `index.ts` later without renaming one of the two. The boot-order anchors below are the literal strings `await opsPublisher.init()` and `setOpsPublisher(`, so the local variable name is load-bearing for the guard.

- [ ] **Step 2:** Extend the existing `SIGUSR1` handler in place.

At `index.ts:575`, add one line to the existing handler's body. Do **not** add a second `process.on("SIGUSR1", …)` listener.

```typescript
  process.on("SIGUSR1", () => {
    prefixCache.invalidateAll("sigusr1");
    safeReload();
    // KPR-454 D9: refresh the loaded ops-subscription set. This handler sits
    // BELOW the spawn-capable boundary, correctly and without exception — a
    // signal handler is not a per-spawn read, and the publisher's own wiring
    // (the thing a turn reads) is above the marker.
    void opsPublisher.reloadSubscriptions();
  });
```

- [ ] **Step 3:** Drain on shutdown.

In the `shutdown` function, add `await opsPublisher.stop();` immediately after `await obligations.stop();`. That places it before `slackAdapter.stop()` and `mongoClient.close()`, the KPR-456 ordering — `stop()` clears the reload timer and stops accepting first, then drains within `SHUTDOWN_DRAIN_MS`.

Two properties this and Step 2 rely on, both true under chunk 3 but stated nowhere until now:

- **`stop()` is safe on a publisher whose `init()` threw.** The local `const opsPublisher` exists whether or not `setOpsPublisher` ran, so shutdown calls `stop()` on it either way. `stop()` touches only `stopping`, `reloadTimer` (possibly `undefined`) and `queue` (empty, since an unset singleton means no observe call ever enqueued) — no store access, no throw.
- **The SIGUSR1 `void opsPublisher.reloadSubscriptions()` cannot produce an unhandled rejection.** `reloadSubscriptions` catches its own fault, warns and counts, so the promise it returns never rejects; the bare `void` is correct rather than a swallowed error.

- [ ] **Step 4:** Extend `src/boot-order.test.ts` — **all three lists**.

Add to `(a)`'s presence pass, after `offsetOf("dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled)");`:

```typescript
    // KPR-454: the ops publisher is a spawn-read surface (the first turn
    // after boot can fail a tool), so both anchors are order-pinned below.
    offsetOf("await opsPublisher.init()");
    offsetOf("setOpsPublisher(");
```

Add the same two `offsetOf(...)` entries to `(b)`'s `wiringOffsets` array and to `(c)`'s `wiringStart` `Math.max(...)` set. All three, not one — `(b)` is what fails if the wiring moves below the marker, and `(c)`'s superset sweep must be bounded by the **latest** wiring anchor or a surface introduced between two wiring calls passes green.

Add one `it` documenting the no-`.start(` property, so a later refactor has to argue with it. It goes **inside the first `describe`** — the one that defines `codeOnly` and `offsetOf` — not into the KPR-456 block, which has its own scope.

The title says what the assertion can actually see. `codeOnly` is `index.ts`, so this case guards `index.ts`'s call sites; it says nothing about what `src/ops/publisher.ts` exports, and a `start()` added there with no `index.ts` caller would pass it. That is the right guard for `(c)`'s allowlist, which is also about `index.ts` — but the earlier title ("the ops publisher exposes no `.start(`-spelled method") claimed the stronger property and was therefore false of the test:

```typescript
  it("(d) index.ts never calls opsPublisher.start( — (c)'s allowlist needs no entry (KPR-454 AC13)", () => {
    // The drainer is demand-driven and the subscription-reload timer is armed
    // inside init(), so there is no start() to call and (c)'s allowlist needs
    // no publisher entry. A later refactor introducing `opsPublisher.start(`
    // in index.ts must either place it AFTER the wiring anchors or add it to
    // that allowlist under the reviewed-classification discipline the list's
    // own comment demands. Scope: this scans index.ts, not src/ops/.
    expect(codeOnly).not.toContain("opsPublisher.start(");
  });
```

- [ ] **Step 5:** `CLAUDE.md` (AC14).

Add the three collections to the engine-written MongoDB collections list, each with its key, index and TTL posture. Insert alphabetically-adjacent to the existing `outage_queue` entry:

> `ops_events` (KPR-454 — the append-only ops log, one immutable document per publish, never mutated; keyed by the derived `dedupeKey` `producer:subjectKind:subjectId:reasonId:generation` which is indexed **non-uniquely** because the log appends every publish; four further indexes — the condition-side and clearing-side epoch reads in the compound `(publishedAt, _id)` order the resolver compares, D12's `{publishedAt: 1, _id: 1}` cursor order, and a **separate single-field** `{publishedAt: 1}` TTL bound to `config.activity.retentionDays` (a TTL index must be single-field, so the cursor index cannot carry it — the two share a prefix and are **not** consolidatable)), `ops_subscriptions` (KPR-454 — D5 subscription documents, `{enabled: 1}`, no TTL; the collection and its loaded set ship with **zero rows**, and no code path may create a catch-all), `ops_reasons` (KPR-454 — the D4 reason registry, `_id` = `<producer>:<reasonId>`, unique `(producer, reasonId)`, no TTL; upserted at boot from the producer's code-resident rows writing every field **except** `enabled`, which is `$setOnInsert` — so `enabled: false` + restart is the whole kill switch, and a row the engine's code does not contain takes effect at the next boot with no engine change)

Add one Common Gotchas bullet:

> - **Ops tool-failure publishing (KPR-454):** every tool failure and recovery on both lanes is recorded as a store-only `ops_events` document, and the intended steady state is that **none is delivered** — `matchedSubscriptions: 0` on every row measures how much nobody has claimed yet, and that zero is a fact, not a failure. Two capture points: the Claude lane's `PostToolUseFailure`/`PostToolUse` hook pair in `AgentRunner.buildHooks` (registered **outside** the archetype fail-closed `PreToolUse` `try`, so neither can disarm the other), and Lane B's single `wrap()` success/catch pair in `tool-bridge.ts`. Both suppress on the turn's **own** abort (`wasAborted` / `opts.signal.aborted`) — a deadline kill is not a tool fault — but a **foreign** interrupt publishes as `errorSig: "interrupted"`, which makes this the standing detector for the KPR-438 background-subagent signature. Lane A (kimi/deepseek) runs the full Claude runtime, so its failures are captured by the hooks and stamped `lane: "claude"` — that field names the **capture point**, never the provider; join through `agentId` to the agent definition's `model` if you want the provider. The kill switch is `ops_reasons` data, not config: set `enabled: false` on `hive-runtime:tool-failed` and restart (the reason map is loaded once in `init()`, so restart is the lever; the subscription set, by contrast, reloads every 60 s and on SIGUSR1). No hive.yaml key ships. `waiting` is derived from `waitingFor` in `src/outage/outage-notices.ts`, which since this ticket holds the **only** reserved-`WorkItem.id`-prefix predicate in the repository (`sourceOfId`) — a second `startsWith` chain anywhere fails `src/ops/single-prefix-predicate.test.ts`, whose one allowlisted coincidental hit is `sse.ts:36`'s SSE field-name framing.

If Task 5 Step 6's probe found a failure class that does **not** fire `PostToolUseFailure`, add one sentence to that bullet naming it as an uncaptured class (C12: uncaptured, never inferred).

- [ ] **Step 6:** Verify.

Run:
```
npx vitest run src/boot-order.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: all pass.

**Negative-verify (required):** move the `opsPublisher` block from above the boundary marker to **immediately after `await bgTaskManager.scanOrphans();`** (or, equivalently, after `scheduler.start();`), re-run `src/boot-order.test.ts`, and confirm `(b)` fails. Restore.

**Why that target and not "just below the marker".** `(b)` bounds `Math.max(wiringOffsets) < Math.min(surfaceOffsets)`, and its offsets are **named surfaces**, not the marker — the marker is a comment the test never reads. The earliest named surface is `await bgTaskManager.start()` at `index.ts:492`, while the marker sits at `:474`, so relocating to "just below the marker" leaves both new anchors at roughly offset 14 998 against a `minSurface` of 15 408 and `(b)` **PASSES** — the mutation never crosses the boundary the check enforces. Round 1 verified both the passing case and the two failing targets. Placing the block after `scanOrphans()` puts `maxWiring` past `bgTaskManager.start()`'s offset and `(b)` trips.

**The mutation fails BOTH `(b)` and `(c)`; `(a)` is presence-only and stays green.** Predict both, or the second red test reads as a mis-applied mutation and invites an implementer to "fix" it by adding `bgTaskManager` to `(c)`'s allowlist — the one list whose comment demands a reviewed classification decision. `(c)` flags matches **before** `wiringStart`, and `wiringStart` is `Math.max(...)` over the wiring anchors including the two new ones, so moving the block down past `bgTaskManager` pulls `bgTaskManager.start(` and `bgTaskManager.scanOrphans(` into the swept region. Verified by running it: above the marker `(c)`'s offenders are `[]`; after `scanOrphans()` they are `["bgTaskManager.start(", "bgTaskManager.scanOrphans("]`.

- [ ] **Step 7:** Commit.

```bash
git add src/index.ts src/boot-order.test.ts CLAUDE.md
git commit -m "feat(KPR-454): wire the ops publisher above the spawn-capable boundary

D10: construction, init() and setOpsPublisher above index.ts's boundary
marker, with both anchors in all three of boot-order.test.ts's lists and a
fourth case pinning that the publisher exposes no .start(-spelled method.
init() is non-fatal both ways: an index fault keeps the publisher wired, a
registry-upsert fault leaves it unset and boot continues. Subscription reload
added to the existing SIGUSR1 handler body, never a second listener; the
queue drains before Slack and Mongo close. Documents the three collections
and the capture-point/kill-switch contract in CLAUDE.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
