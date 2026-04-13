# Remove Triage Layer Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Delete the Haiku triage classifier and route inbound messages directly from the dispatcher to the agent.

**Architecture:** Today, `Dispatcher.dispatch` (and fan-out `dispatchToAgent`) calls `triage()` before the full agent to post a fast ack / short-circuit trivial turns. This plan removes that branch entirely — the per-turn model router already selects Haiku for trivial turns, so the full agent covers the fast-path with real thread context. No replacement, no flag — just deletion.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK (no changes to SDK usage).

**Linear:** [KPR-12](https://linear.app/keepur/issue/KPR-12/remove-triage-layer-route-messages-directly-to-agents)

---

## File Structure

- Delete: `src/agents/triage.ts` — classifier module
- Modify: `src/channels/dispatcher.ts` — remove triage import, both triage branches (~lines 168-240 and 513-543)
- Modify: `src/channels/dispatcher.test.ts` — remove triage mock + config stub field
- Modify: `src/config.ts` — remove `triage` config block (lines 224-228)
- Modify: `src/types/agent-config.ts` — remove `triageModel` field
- Modify: `src/types/agent-definition.ts` — remove `triageModel` field + `toAgentConfig` mapping
- Modify: `src/admin/admin-mcp-server.ts` — remove `triageModel` printout (line 107)
- Modify: `src/agents/agent-registry.test.ts` — remove `triageModel` test expectation
- Modify: `src/agents/agent-runner.test.ts` — remove `triage: { enabled: false }` config stub field
- Modify: `CLAUDE.md` — drop the `triage.ts` bullet from Key Files

No new files. No tests added — deletion is covered by existing dispatcher tests (which already mock triage disabled).

---

### Task 1: Delete triage module and remove wiring from dispatcher

**Files:**
- Delete: `src/agents/triage.ts`
- Modify: `src/channels/dispatcher.ts`

- [ ] **Step 1:** Delete `src/agents/triage.ts`

```bash
rm src/agents/triage.ts
```

- [ ] **Step 2:** In `src/channels/dispatcher.ts`, remove the import at line 8:

```typescript
import { triage } from "../agents/triage.js";
```

- [ ] **Step 3:** In `src/channels/dispatcher.ts` `dispatch()` (around lines 168-243), replace the entire triage block with a direct call into the full agent. Delete lines 168-240 (the `// 4. Triage gate` comment through the closing `}` of the `if (isInteractive && config.triage.enabled ...)` branch) and also delete the `let processingStarted = false;` line and the `if (!processingStarted) await adapter?.onProcessingStart?.(item);` reset. Replace with a single unconditional `onProcessingStart` call before the full-agent block.

Resulting shape (existing surrounding code unchanged):

```typescript
    const adapter = this.adapters.get(item.source.adapterId ?? item.source.kind);
    const agentConfig = this.registry.get(agentId);
    void agentConfig; // no triage gating — kept only if still referenced downstream

    // 4. Full agent processing
    await adapter?.onProcessingStart?.(item);
    try {
      const runResult = await this.agentManager.sendMessage(agentId, item);
      // ...existing body unchanged...
```

If `agentConfig` is no longer referenced anywhere else in `dispatch()`, drop the `const agentConfig = ...` line and the `void agentConfig;` marker entirely. Verify with a quick search in the function body before committing.

- [ ] **Step 4:** In `src/channels/dispatcher.ts` `dispatchToAgent()` (fan-out path, around lines 503-543), delete the entire `// Skip triage for fan-out` block (lines 513-543) including the `try/catch`. The `isInteractive` constant above it becomes unused in this function — delete it too. Also delete the now-unused `agentConfig` local if it is no longer referenced.

- [ ] **Step 5:** In `src/channels/dispatcher.ts`, remove any remaining references to `skipTriage`. The `resolveAgents` helper currently returns `{ agentId, skipTriage }` tuples — change to `{ agentId }[]` (or plain `string[]`). Update every `return` in `resolveAgents` and `resolveFromTeam` accordingly, and update the call sites in `dispatch()` and fan-out that destructure `skipTriage`. The `passiveChannels` check at line 423 (`skipTriage: a.passiveChannels.includes(item.source.label)`) simply drops — `passiveChannels` only mattered for the triage gate. Preserve `passiveChannels` as a concept in the agent config (it may still be used elsewhere; grep to confirm), but it no longer affects dispatch.

Before committing, run:

```bash
grep -n "skipTriage\|triage" src/channels/dispatcher.ts
```

Expected: no matches.

- [ ] **Step 6:** Verify build

```bash
npx tsc --noEmit
```

Expected: clean (no errors). If `passiveChannels` is referenced elsewhere, leave it; if not, flag for a follow-up.

- [ ] **Step 7:** Commit

```bash
git add src/agents/triage.ts src/channels/dispatcher.ts
git commit -m "refactor(dispatcher): remove triage layer, route directly to agent (KPR-12)"
```

---

### Task 2: Remove triage config, types, and admin surfacing

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types/agent-config.ts`
- Modify: `src/types/agent-definition.ts`
- Modify: `src/admin/admin-mcp-server.ts`

- [ ] **Step 1:** In `src/config.ts`, delete the `triage` block at lines 224-228:

```typescript
  triage: {
    model: optional("TRIAGE_MODEL", "claude-haiku-4-5-20251001"),
    timeoutMs: parseInt(optional("TRIAGE_TIMEOUT_MS", "10000"), 10),
    enabled: optional("TRIAGE_ENABLED", "true") === "true",
  },
```

- [ ] **Step 2:** In `src/types/agent-config.ts` line 29, delete:

```typescript
  triageModel?: string; // Override triage model. Default: config.triage.model
```

- [ ] **Step 3:** In `src/types/agent-definition.ts`, delete `triageModel?: string;` at line 13 and the `triageModel: doc.triageModel,` mapping at line 103 in `toAgentConfig`.

- [ ] **Step 4:** In `src/admin/admin-mcp-server.ts` line 107, delete:

```typescript
    if (doc.triageModel) lines.push(`Triage Model: ${doc.triageModel}`);
```

- [ ] **Step 5:** Verify build

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6:** Commit

```bash
git add src/config.ts src/types/agent-config.ts src/types/agent-definition.ts src/admin/admin-mcp-server.ts
git commit -m "refactor: drop triage config and triageModel field (KPR-12)"
```

---

### Task 3: Clean up tests and docs

**Files:**
- Modify: `src/channels/dispatcher.test.ts`
- Modify: `src/agents/agent-runner.test.ts`
- Modify: `src/agents/agent-registry.test.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1:** In `src/channels/dispatcher.test.ts`, remove the `triage: { enabled: false }` field from the mocked config (line 16) and delete the `vi.mock("../agents/triage.js", ...)` block (lines 20-22).

- [ ] **Step 2:** In `src/agents/agent-runner.test.ts` line 88, delete the `triage: { enabled: false }` field from the mocked config.

- [ ] **Step 3:** In `src/agents/agent-registry.test.ts`, remove the `triageModel: "claude-haiku-4-5"` line (line 104) and the `expect(config.triageModel).toBe("claude-haiku-4-5")` assertion (line 111).

- [ ] **Step 4:** In `CLAUDE.md`, delete the line:

```
- `src/agents/triage.ts` — fast Haiku classifier (done/continue)
```

Also update the Architecture diagram block to remove the `→ Triage (fast Haiku for simple queries, interactive channels only)` line.

- [ ] **Step 5:** Verify

```bash
npm run check
```

Expected: typecheck, lint, format, and tests all pass. No references to `triage` remain in `src/`:

```bash
grep -rn "triage" src/ | grep -v "triage" # should be empty
```

(Run `grep -rn "triage\|triageModel" src/` — expected: no matches.)

- [ ] **Step 6:** Commit

```bash
git add src/channels/dispatcher.test.ts src/agents/agent-runner.test.ts src/agents/agent-registry.test.ts CLAUDE.md
git commit -m "test,docs: remove triage references (KPR-12)"
```

---

## Notes

- **No migration needed.** `triageModel` is not set on any plugin agent seed (`grep triageModel plugins/` → no matches). If a DB agent document happens to have `triageModel`, the field will simply be ignored by the reader after deletion — MongoDB tolerates extra fields.
- **No feature flag.** The ticket is explicit: delete entirely. `TRIAGE_ENABLED` env var in `.env` / deploy `.env` should be cleaned up opportunistically but a stale var is harmless.
- **Out of scope** (per ticket): meeting-listener silence / "this message is not for me" — will be handled via a listening-mode flag on the agent in a separate ticket, not here.
- **Behavioral check before merge:** spot-check a trivial greeting ("hi Rae") in dev against the full agent — should still respond fast via the model router's Haiku selection. If latency is noticeably worse, note it on the PR but don't re-add triage.
