# Agent Tool-Discoverability Audit Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Verify that agents can answer "do I have this tool / what does it do / why did my call fail" from runtime surfaces alone (no per-tool prompt prose) across all four tool surfaces, then close concrete gaps and file follow-ups for design-shaped gaps.

**Architecture:** Audit-first, fix-second. Phase 1 walks each of the four surfaces (MCP tools, SDK builtins, shell binaries, per-call identity) with concrete inspection steps and produces a single audit doc with findings sorted into three buckets (working / concrete-fix / needs-design). Phase 2 applies only the concrete-fix items the audit confirms. Phase 3 files needs-design follow-ups in Linear without preemptively designing them. Phase 4 captures the discoverability invariant in a reference memory file.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, MCP stdio servers, `src/agents/toolkit-section.ts` (KPR-87 surface), `src/tools/server-catalog.ts`, `src/agents/agent-runner.ts`. Linear for follow-ups. Audit doc lives in the private `keepur/hive-docs` companion repo.

## Testing Contract

### Required Test Groups
- **Unit:** required only if Phase 2 ships code changes that touch `src/agents/toolkit-section.ts`, `src/tools/server-catalog.ts`, or any MCP server `description` / response-shape code. Scope: pure-function output of `buildToolkitSection`, catalog entry resolution, and any tool-response shape changes. Min assertions: every concrete-fix code change has a unit test that fails without the fix and passes with it. If Phase 2 is documentation-only (e.g. catalog blurb edits) the existing `src/agents/toolkit-section.test.ts` and `src/tools/server-catalog.test.ts` remain the regression surface — extend them rather than adding new files.
- **Integration:** not-required. Reason: discoverability is a prompt-string assembly concern; integration coverage is provided by the existing toolkit-section tests plus an end-to-end spot-check rendered system prompt captured in the audit doc (Task 1 step 3) — that spot-check is the integration evidence and lives in the doc, not in CI.
- **E2E:** not-required. Reason: the audit's "spot-check a real rendered system prompt for Mokie / Jessica" step IS the e2e validation; no automated harness exists or is justified for this ticket. Harness: dump the rendered prompt via a one-shot script invocation against the dev MongoDB; instructions captured in Task 1.

### Critical Flows / Regression Surface / Commands / Harness Requirements / Non-Required Rationale
- **Critical flow:** agent boot → `AgentRunner.buildSystemPrompt` → `buildToolkitSection` emits the four subsections → prompt reaches both parent session and delegate subagents.
- **Regression surface:** `src/agents/toolkit-section.ts`, `src/agents/agent-runner.ts` (specifically the call site at line 277 and `filterCoreServers` / `buildDelegateAgents` paths), `src/tools/server-catalog.ts`, every `src/**/*-mcp-server.ts` file's MCP `description` argument and individual tool `description` fields.
- **Commands:** `npm run typecheck`, `npm run lint`, `npm run test`, `npm run check` (full gate). Run `npm run check` before each Phase 2 commit.
- **Harness for prompt spot-check:** a small one-shot invocation (`tsx scripts/dump-agent-prompt.ts <agent-id>` — create only if absent; otherwise reuse existing tooling under `src/admin/`) that loads the agent definition from MongoDB and prints the assembled system prompt to stdout. The exact command goes in the audit doc.
- **Non-required rationale:** integration/e2e tests for prompt content would lock the engine to a specific prose layout the team is still iterating on; the audit doc + manual spot-check is the right shape for this stage.

### Verification Rules
- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## Phase 1 — Audit (Tasks 1–4: one per surface)

### Audit deliverable

Single markdown doc at `~/github/hive-docs/internal/audits/2026-05-04-tool-discoverability.md` (create the `internal/audits/` directory if absent — convention is fine; spec authorizes "auditor picks or creates the appropriate subdirectory"). The doc has four top-level sections (one per surface, Tasks 1–4). Each surface section contains three subsections — `Working as intended`, `Gap with concrete fix`, `Gap that needs design` — even if a subsection is empty (write "None." rather than omitting). Each finding includes: the surface, the symptom, the affected file/agent/server, and (for fix bucket) a one-line proposed fix, (for needs-design bucket) the open question.

Each Phase 1 task = one commit on this branch in `~/github/hive-docs` (the audit-doc repo), separate from the Phase 2 commits in `~/github/hive`.

### Task 1: Audit MCP-tools surface (coreServers + delegateServers)

**Goal:** verify `buildToolkitSection` reaches every agent path and that catalog blurbs are sufficient.

**Steps:**

1. **Wiring reach (parent session).** Read `src/agents/agent-runner.ts` lines 270–290 and confirm `buildToolkitSection` is invoked from `buildSystemPrompt`. Then trace `buildSystemPrompt` callers — grep `grep -n "buildSystemPrompt" src/agents/agent-runner.ts` — and confirm every spawned parent session goes through it. Record finding (working / gap).
2. **Wiring reach (delegate subagents).** In `src/agents/agent-runner.ts` find `buildDelegateAgents` (line 988 at time of writing — confirm by `grep -n buildDelegateAgents src/agents/agent-runner.ts`) and the loop that constructs delegate `AgentDefinition` objects. Verify whether the delegate's `prompt`/`description` field receives a toolkit section, or whether delegates rely on the parent's prompt + the SDK's automatic Agent-tool description. If delegates do NOT receive their own toolkit section, classify as either working-by-design (parent prompt covers it) or gap-with-concrete-fix (delegate is blind to its own MCP capability inventory). Document the classification with reasoning.
3. **Spot-check rendered prompts.** For `mokie` (dodi CoS, Opus, large delegate set) and `jessica` (dodi customer success, the original symptom agent), dump the assembled system prompt. If a `scripts/dump-agent-prompt.ts` does not exist, write one that: imports the same MongoDB client module that `src/agents/agent-registry.ts` uses (grep `from ".*mongo` inside `src/agents/agent-registry.ts` and reuse that same import path — there is no canonical `src/db/mongo.ts`), loads the agent def via `src/agents/agent-registry.ts`, instantiates `AgentRunner` enough to call `buildSystemPrompt`, and prints to stdout. Paste the rendered "Your toolkit" section verbatim into the audit doc. Note whether each subsection (Built-in / Engine-provided / Capability MCPs / Delegated capability MCPs) appears with the expected entries. Confirm `google` shows up for Jessica.
4. **Catalog blurb quality.** Read `src/tools/server-catalog.ts` end-to-end. For each server the spec calls out — `google`, `quo`, `code-task`, `team-roster`, `event-bus`, `slack` — record the current `description` / `toolkitBlurb` and rate each against the three discoverability questions. A blurb that doesn't tell an agent "what it does" without prose is a gap-with-concrete-fix. A blurb that's adequate but stale is also concrete-fix. A blurb whose right text depends on tenant config (e.g. which Slack workspace) is needs-design.
5. **Identity context in blurbs.** For account-bound servers (`google`, `slack`, `quo`, `resend`), determine whether the blurb mentions the bound identity. Note that identity is per-agent (Jessica's `google` ≠ Mokie's `google`), so static catalog blurbs CAN'T encode it. Record the design question — is the right surface (a) per-agent toolkit-blurb override, (b) tool response, (c) elsewhere — under needs-design.
6. **Plugin manifests.** Run `find ~/services -maxdepth 6 -name plugin.yaml 2>/dev/null` (or wherever plugins resolve in this dev box) plus check `src/plugins/types.ts` for the manifest schema, and audit at least one plugin manifest's `description`/`usage` fields against the same rubric. If no plugins are installed locally, note that and skip without marking as a gap.

**Commit:** `audit(tool-discoverability): MCP-tools surface findings`

### Task 2: Audit SDK built-ins surface

**Goal:** verify `SDK_BUILTINS` is current and complete vs. the shipped SDK version, and blurbs are adequate.

**Steps:**

1. **SDK version and tool inventory.** Read `package.json` to find the pinned `@anthropic-ai/claude-agent-sdk` version. Then inspect `node_modules/@anthropic-ai/claude-agent-sdk/dist/**` (or the `.d.ts` files) — grep for `allowedTools` and the union/enum of tool names. Capture the full list. Compare against `SDK_BUILTINS` in `src/agents/toolkit-section.ts` (lines 47–53).
2. **Gap classification.** Tools in the SDK but missing from `SDK_BUILTINS` are concrete-fix (add them). Tools in `SDK_BUILTINS` no longer in the SDK are concrete-fix (remove them). Pay specific attention to `Task` / `Agent` (sub-agent dispatch) — spec flags these as likely gaps. Also check for `TodoWrite`, `KillShell`, `BashOutput`, anything new in recent SDK releases.
3. **Blurb adequacy.** For each entry in `SDK_BUILTINS` and any net-new addition, judge whether the blurb answers "when would I use this." Spec calls out `Task`, `WebFetch`, `NotebookEdit` as spot-checks. Record any blurb upgrades as concrete-fix items with the proposed text.
4. **Cross-check against actual session config.** In `src/agents/agent-runner.ts` find where `Options` are passed to the SDK (grep `allowedTools` or `disallowedTools` if present) and confirm whether the engine constrains the SDK tool set. If it does, `SDK_BUILTINS` should reflect the constrained list, not the SDK's full set. Record the result.

**Commit:** `audit(tool-discoverability): SDK built-ins findings`

### Task 3: Audit shell-binaries surface

**Goal:** decide whether unannounced shell binaries (`gog`, `gh`, `mongosh`, `sqlite3`, `jq`, `security`, `osascript`, `launchctl`, `cloudflared`) are a real discoverability gap.

**Steps:**

1. **Inventory.** List the binaries the spec enumerates plus any others the audit notices on the dev host (`which gog gh mongosh sqlite3 jq security osascript launchctl cloudflared`). Note which exist on this host.
2. **Per-agent relevance.** For each binary, jot down which agents would plausibly need it (spec hint: Mokie/Hermi need `gh`; Sige doesn't). Skip exhaustive matrices — the goal is to confirm or refute "this is a gap for someone."
3. **Try-and-read-the-error sufficiency.** Reference KPR-113 (capabilities-anchor posture) per the spec. Determine whether the constitution / capabilities anchor already tells agents to attempt-and-read. Constitution lives at `templates/constitution-bootstrap.md.tpl` (and a duplicate at `setup/templates/constitution-bootstrap.md.tpl` — confirm both stay in sync as a side note). The agent-side prompt assembler is `src/agents/prompt-builder.ts` (NOT `system-prompt-builder.ts`). Also `grep -rn "capabilit" src/ templates/ setup/ --include="*.ts" --include="*.md" --include="*.tpl"` to catch any other capability-anchor language. Record whether attempt-and-read is the documented posture. If it is, classify the surface as working-as-intended with a note that absence of an announce-list is by design. If not, classify as needs-design (the design question is "where do shell binaries get announced — per-agent? per-host? somewhere else?").
4. **Concrete-fix fence.** If the auditor finds a specific binary an agent demonstrably misses (e.g. Mokie not knowing `gh` is available), file as concrete-fix with the proposed surface (likely a per-agent capability blurb). Otherwise leave as needs-design.

**Commit:** `audit(tool-discoverability): shell-binaries findings`

### Task 4: Audit per-call identity / config state surface

**Goal:** verify tool responses carry enough identity/config context for agents to self-diagnose.

**Steps:**

1. **Identity-bound servers.** Pick the canonical four: `google`, `slack`, `quo`, `team-roster`. For each, read the server source (`src/google/google-mcp-server.ts`, `src/slack/slack-mcp-server.ts`, `src/quo/quo-mcp-server.ts`, `src/team-roster/team-roster-mcp-server.ts`) and identify the success-response shape of each tool. Record whether the response includes the acting identity (e.g. `from: jessica@dodihome.com` for a sent gmail; `posted_as: 'Mokie'` for a Slack post).
2. **Failure-response shape.** Same files: identify the error-response shape. The Jessica symptom was rooted in agents not knowing they could use a tool — but the deeper question is whether failure responses tell an agent WHY a call didn't land (auth missing? wrong identity? rate-limited? feature flag off?). For each server, sample at least one error path.
3. **`team_lookup_human` lookup-key surfacing.** Spec specifically asks: when `team_lookup_human` returns a hit, is the lookup-key surfaced? Read `src/team-roster/team-roster-mcp-server.ts` and check the response field for the matched lookup key. Record working / concrete-fix.
4. **Bucket the findings.** A response that drops identity is usually concrete-fix (add the field). A response shape that conflicts across servers (no consistent convention) is needs-design (engine-wide identity convention). Don't preemptively design the engine-wide convention here — file it as needs-design.

**Commit:** `audit(tool-discoverability): per-call identity findings`

---

## Phase 2 — Concrete fixes (driven by audit; pre-listed likely candidates with caveat)

> **All Phase 2 tasks are gated on Phase 1 audit confirmation.** Each task header marks "Likely if audit reveals X." Implementer MUST cross-reference the audit doc's concrete-fix bucket before doing the task. If the audit didn't flag the gap, skip the task and note that in the commit log of Task 9. Conversely, if the audit surfaces concrete-fix items not pre-listed below, add them as additional Task 8.x entries.

### Task 5: Refresh `SDK_BUILTINS` list and blurbs (likely if Task 2 reveals SDK drift)

**Likely gap:** `SDK_BUILTINS` in `src/agents/toolkit-section.ts` is missing `Task` / `Agent` / `TodoWrite` or has stale entries vs. the pinned SDK version.

**Steps:**

1. Update `src/agents/toolkit-section.ts` `SDK_BUILTINS` array (lines 47–53) to match the SDK inventory captured in Task 2.
2. Extend `src/agents/toolkit-section.test.ts` with assertions for the new entries — every added line gets one assertion that it appears in the rendered output for a default-shaped input.
3. Run `npm run check`.

**Commit:** `fix(toolkit): refresh SDK_BUILTINS to match shipped SDK version`

### Task 6: Improve `SERVER_CATALOG` blurbs flagged in Task 1 (likely if audit flags blurb-quality gaps)

**Likely gap:** one or more of `google`, `quo`, `code-task`, `team-roster`, `event-bus`, `slack` have blurbs that don't answer "what does it do" without prompt prose.

**Steps:**

1. For each flagged server, edit the entry in `src/tools/server-catalog.ts`. Use the proposed fix line from the audit doc verbatim where possible. Keep `toolkitBlurb` ≤ ~100 chars per the catalog comment.
2. Update `src/tools/server-catalog.test.ts` if it asserts specific text on these entries; otherwise rely on the existing shape tests.
3. Run `npm run check`.

**Commit:** `fix(catalog): clarify <server-name(s)> blurbs for runtime discoverability`

### Task 7: Surface delegate-subagent toolkit (likely if Task 1 step 2 reveals delegates lack their own toolkit section)

**Likely gap:** delegate subagents built by `buildDelegateAgents` in `src/agents/agent-runner.ts` (line 988 at time of writing) get a generic prompt instead of a toolkit-aware one, so a delegated session can't introspect what it has access to.

**Steps:**

1. In `src/agents/agent-runner.ts` `buildDelegateAgents`, decide whether each delegate's prompt should include a `buildToolkitSection` call scoped to that delegate's own server (most delegates are single-server). Confirm the design with the audit doc's note before implementing — if audit says "by-design, parent prompt covers it," skip this task entirely.
2. If implementing, factor the delegate-scoped toolkit assembly so it reuses `buildToolkitSection` rather than duplicating logic.
3. Add a unit test in `src/agents/toolkit-section.test.ts` (or a new test alongside `buildDelegateAgents`) that confirms delegate-scoped output.
4. Run `npm run check`.

**Commit:** `fix(agent-runner): include toolkit section in delegate subagent prompts`

### Task 8: Add identity field to identity-bound MCP responses (likely if Task 4 flags missing identity in success responses)

**Likely gap:** `google`, `slack`, `quo`, or `team-roster` success responses don't carry the acting identity / lookup key.

**Steps:**

1. For each server flagged in Task 4 step 1 or step 3, edit the corresponding `src/<server>/<server>-mcp-server.ts` file. Add the identity field to the relevant tool's success response schema. Keep field names consistent across servers if possible (e.g. always `acting_as` or always `identity`) — but if cross-server consistency requires a design call, defer that to Phase 3 follow-up and use the per-server local convention here.
2. Add a unit test for each touched response shape.
3. Run `npm run check`.

**Commit (one per server):** `fix(<server>): include acting identity in success response`

> Each touched server is its own commit. If three servers need the fix, that's three commits in this task.

### Task 9: Phase 2 reconciliation note

After all concrete fixes land, append a short "Fixes applied" section to the audit doc listing each commit SHA and the audit-bucket item it addressed. This makes the audit doc self-contained for posterity.

**Commit (in `hive-docs` repo):** `audit(tool-discoverability): record applied fixes`

---

## Phase 3 — Follow-ups for needs-design gaps

### Task 10: File Linear follow-ups

For each item in any surface's `Gap that needs design` bucket, create a Linear ticket. Each ticket:

- **Title:** crisp problem statement (no jargon — "Decide where shell-binary inventory is announced to agents").
- **Body:** copy the audit-doc finding verbatim, link back to KPR-174 and the audit doc URL/path, list the open question(s), and explicitly do NOT propose a solution (these are design tickets, not implementation tickets).
- **Labels / state:** match KPR-174's wave + priority unless the audit suggests otherwise. Default to Backlog.

Use the Linear GraphQL API directly (per project convention — `Authorization` header from `security find-generic-password -s hive/keepur/LINEAR_API_KEY -w`). Capture the new ticket IDs in the audit doc under each needs-design item.

**Out-of-scope guard:** if the audit uncovered a 5th surface (per spec), file ONE follow-up ticket for "audit surface 5" and stop. Do NOT expand this audit's scope.

**No code commit.** Linear tickets only. Append the ticket IDs to the audit doc in the same commit as Task 11 if convenient.

---

## Phase 4 — Memory entry

### Task 11: Write the discoverability invariant memory entry

**Goal:** capture the invariant for the next time we add a tool surface.

**Steps:**

1. Create `/Users/mokie/.claude/projects/-Users-mokie-github-hive/memory/reference_tool_discoverability.md`. Keep it short — this is a reference, not a manifesto.
2. Content (paraphrased; final wording can adapt to audit findings):
   - Three discoverability questions every tool surface must answer at runtime: do I have it / what does it do / why did it fail.
   - Four current surfaces: MCP tools (toolkit-section), SDK builtins (`SDK_BUILTINS`), shell binaries (attempt-and-read or capabilities-anchor), per-call identity (tool response shape).
   - Anti-pattern: solving this with per-tool prompt paragraphs (cross-link `feedback_no_per_tool_prompt_awareness.md`).
   - Pointer to the audit doc in `keepur/hive-docs` and the KPR-174 ticket.
3. Update `/Users/mokie/.claude/projects/-Users-mokie-github-hive/memory/MEMORY.md` to add the new reference under the "References (where things live)" section. One line, terse.

**Commit:** memory files are user-scope, not repo-scope. No git commit in `~/github/hive`. Write the file directly.

---

## Spec Ambiguities

None. The spec is explicit about scope, surfaces, buckets, output location, and out-of-scope items. The only judgment calls (e.g. should delegates get their own toolkit section) are correctly framed as audit findings rather than predetermined fixes, which is consistent with the audit-shape posture.
