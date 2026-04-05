# Code-Aware Compaction Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Enhance the PreCompact hook to extract code context from the conversation being compacted and inject file summaries + code insights into the preservation instructions.

**Architecture:** Two-layer extraction in the PreCompact hook: (1) regex scan for file paths → exact MongoDB lookups, (2) embed conversation tail → Qdrant similarity search for files and code insights. The prefetcher gains a `getCompactionContext()` method that the hook calls. The AgentRunner receives the prefetcher as an optional constructor parameter.

**Tech Stack:** TypeScript, MongoDB, Qdrant, Ollama (embeddings only — no LLM calls)

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/code-index/prefetcher.ts` | Modify | Add `getCompactionContext(conversationText, agentId)` method with two-layer extraction |
| `src/agents/agent-runner.ts` | Modify | Accept optional prefetcher in constructor, call it from `buildPreCompactHook()` |
| `src/agents/agent-manager.ts` | Modify | Pass prefetcher through to AgentRunner |
| `src/index.ts` | Modify | Pass prefetcher to AgentManager |
| `src/agents/agent-runner.test.ts` | Modify | Add tests for code-aware PreCompact hook |

---

### Task 1: Add getCompactionContext() to prefetcher

**Files:**
- Modify: `src/code-index/prefetcher.ts`

The existing `getContext()` embeds a prompt and does Qdrant similarity search. The new method does two-layer extraction purpose-built for compaction.

- [ ] **Step 1:** Add file path regex helper

After the class closing brace (or as a private method), add a helper to extract file paths from conversation text:

```typescript
  /** Extract probable file paths from conversation text */
  private extractFilePaths(text: string): string[] {
    // Match patterns like src/foo/bar.ts, plugins/dodi/server.ts, setup/wizard.ts, etc.
    const pathRegex = /(?:^|\s|`|"|')((src|plugins|dist|docs|scripts|setup|skills|service|agents-templates|test)\/.+?\.(ts|tsx|js|jsx|json|yaml|yml|md))\b/gm;
    const paths = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(text)) !== null) {
      paths.add(match[1]);
    }
    return [...paths];
  }
```

- [ ] **Step 2:** Add `getCompactionContext()` method

After `getContext()` (line 125), add:

```typescript
  /**
   * Get code context for PreCompact hook — two-layer extraction.
   * Layer 1: Regex extract file paths → exact MongoDB lookups (precise, no embedding)
   * Layer 2: Embed conversation tail → Qdrant similarity + code insights (fuzzy)
   * Returns formatted text to append to PreCompact systemMessage, or empty string.
   */
  async getCompactionContext(conversationText: string, agentId?: string): Promise<string> {
    try {
      await this.ensureConnected();
    } catch {
      return "";
    }

    const fileSections: string[] = [];
    const insightSections: string[] = [];
    const seenPaths = new Set<string>();

    // --- Layer 1: Exact file path lookups (no embedding needed) ---
    try {
      const paths = this.extractFilePaths(conversationText);
      if (paths.length > 0) {
        const codeIndexCol = this.mongo.db(this.options.dbName).collection("code_index");
        // Build $or query — each path could be in any repo
        const records = await codeIndexCol
          .find({ filePath: { $in: paths } })
          .project({ repo: 1, filePath: 1, summary: 1, role: 1 })
          .toArray();

        for (const r of records) {
          const key = `${r.repo}:${r.filePath}`;
          if (!seenPaths.has(key)) {
            seenPaths.add(key);
            fileSections.push(`- ${key} — ${r.summary} [${r.role}]`);
          }
        }
      }
    } catch {
      // MongoDB down — Layer 1 fails, continue to Layer 2
    }

    // --- Layer 2: Semantic similarity search (needs embedding) ---
    try {
      // Use tail of conversation as the query — captures recent context
      const tail = conversationText.slice(-2000);
      const queryVector = await embedOllama(this.options.ollamaUrl, tail);

      // 2a. Search code index for relevant files
      const codeResults = await this.qdrant.search(CODE_INDEX_COLLECTION, {
        vector: queryVector,
        limit: this.prefetchLimit,
        with_payload: true,
      });

      for (const r of codeResults) {
        if (r.score < this.scoreThreshold) continue;
        const p = r.payload as Record<string, unknown>;
        const key = `${p.repo}:${p.filePath}`;
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          fileSections.push(`- ${key} — ${p.summary} [${p.role}]`);
        }
      }

      // 2b. Search agent memory for code insights
      if (agentId) {
        const memResults = await this.qdrant.search("agent_memory", {
          vector: queryVector,
          limit: 10,
          with_payload: true,
          filter: {
            must: [{ key: "agentId", match: { value: agentId } }],
          },
        });

        const codeMemories = memResults
          .filter((r) => r.score >= this.scoreThreshold)
          .filter((r) => typeof r.payload?.topic === "string" && (r.payload.topic as string).startsWith("code:"));

        if (codeMemories.length > 0) {
          const mongoIds = codeMemories.map((r) => r.payload?.mongoId as string).filter(Boolean);
          if (mongoIds.length > 0) {
            const { ObjectId } = await import("mongodb");
            const memCollection = this.mongo.db(this.options.dbName).collection("agent_memory");
            const records = await memCollection
              .find({ _id: { $in: mongoIds.map((id) => new ObjectId(id)) } })
              .toArray();

            for (const r of records) {
              const topic = String((r as Record<string, unknown>).topic ?? "").replace(/^code:/, "");
              const content = String((r as Record<string, unknown>).content ?? "");
              insightSections.push(`- ${topic}: ${content}`);
            }
          }
        }
      }
    } catch {
      // Ollama/Qdrant down — Layer 2 fails, use whatever Layer 1 found
    }

    if (fileSections.length === 0 && insightSections.length === 0) return "";

    // Cap total file entries
    const cappedFiles = fileSections.slice(0, 10);

    const parts: string[] = [];
    if (cappedFiles.length > 0) {
      parts.push(
        "Files actively referenced in this conversation:",
        ...cappedFiles,
        "Preserve references to these files and any decisions made about them.",
      );
    }
    if (insightSections.length > 0) {
      parts.push(
        "",
        "Code insights from prior sessions:",
        ...insightSections,
        "Preserve these insights if relevant to the conversation.",
      );
    }

    return parts.join("\n");
  }
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/code-index/prefetcher.ts
git commit -m "feat(compaction): add getCompactionContext() with two-layer code extraction (#89)"
```

---

### Task 2: Thread prefetcher through to AgentRunner

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/index.ts`

- [ ] **Step 1:** Add optional prefetcher to AgentRunner constructor

In `src/agents/agent-runner.ts`, add import at top:

```typescript
import type { CodeIndexPrefetcher } from "../code-index/prefetcher.js";
```

Update the constructor (line 56):

```typescript
// BEFORE:
constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = [], skillIndex: SkillIndex = new Map(), eventSubscribersJson = "{}") {

// AFTER:
constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = [], skillIndex: SkillIndex = new Map(), eventSubscribersJson = "{}", private prefetcher?: CodeIndexPrefetcher) {
```

Remove the manual `this.eventSubscribersJson = eventSubscribersJson;` line (line 61) and use `private` keyword on the parameter instead — or leave as-is and just add the prefetcher. Read the constructor body to decide.

Actually, simpler: just add a property and assign it:

```typescript
  private prefetcher?: CodeIndexPrefetcher;

  // In constructor, add after eventSubscribersJson assignment:
  this.prefetcher = prefetcher;
```

Wait — the existing constructor doesn't use `private` keyword on params (it assigns manually at lines 57-61). Follow the same pattern:

```typescript
  private prefetcher?: import("../code-index/prefetcher.js").CodeIndexPrefetcher;

  constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = [], skillIndex: SkillIndex = new Map(), eventSubscribersJson = "{}", prefetcher?: import("../code-index/prefetcher.js").CodeIndexPrefetcher) {
    this.agentConfig = agentConfig;
    this.memoryManager = memoryManager;
    this.plugins = plugins;
    this.skillIndex = skillIndex;
    this.eventSubscribersJson = eventSubscribersJson;
    this.prefetcher = prefetcher;
  }
```

Use the inline `import()` type to avoid a top-level import if the module may not be available. Alternatively, just add a normal import since the prefetcher is already part of the codebase. Read the existing imports to decide — a normal import is cleaner:

```typescript
import type { CodeIndexPrefetcher } from "../code-index/prefetcher.js";
```

- [ ] **Step 2:** Update AgentManager to accept and pass prefetcher

In `src/agents/agent-manager.ts`, add property and constructor param:

```typescript
// Add property:
private prefetcher?: import("../code-index/prefetcher.js").CodeIndexPrefetcher;

// Update constructor to accept it:
constructor(registry: AgentRegistry, memoryManager: MemoryManager, sessionStore: SessionStore, activityLogger?: ActivityLogger, prefetcher?: import("../code-index/prefetcher.js").CodeIndexPrefetcher) {
  // ... existing assignments ...
  this.prefetcher = prefetcher;
}

// Update createRunner() (line 50-55):
private createRunner(agentId: string): AgentRunner {
  const config = this.registry.get(agentId);
  if (!config) throw new Error(`Unknown agent: ${agentId}`);
  const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
  return new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher);
}
```

- [ ] **Step 3:** Update index.ts — reorder init blocks and pass prefetcher to AgentManager

**Critical ordering issue:** In `src/index.ts`, the `AgentManager` is constructed at ~line 152, but the prefetcher is created later at ~lines 180-201 inside `if (config.codeIndex.enabled)`. The prefetcher must exist before `AgentManager` is constructed.

Fix: Move the prefetcher creation block (the `if (config.codeIndex.enabled) { ... }` section that creates the `CodeIndexPrefetcher`) ABOVE the `AgentManager` construction. The prefetcher depends only on `config` — no dependencies on anything created between the two blocks.

Then pass `prefetcher` as the last argument to `new AgentManager(...)`:

```typescript
// After moving prefetcher creation above:
agentManager = new AgentManager(registry, memoryManager, sessionStore, activityLogger, prefetcher);
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5:** Commit

```bash
git add src/agents/agent-runner.ts src/agents/agent-manager.ts src/index.ts
git commit -m "feat(compaction): thread prefetcher through AgentManager to AgentRunner (#89)"
```

---

### Task 3: Enhance buildPreCompactHook() to call prefetcher

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** Update `buildPreCompactHook()` to query code context

Replace lines 729-752.

**Critical SDK type note:** The PreCompact hook's `input` parameter is `PreCompactHookInput`, NOT a messages array. Its shape is:
```typescript
type PreCompactHookInput = {
  session_id: string;
  transcript_path: string;  // <-- file path to the conversation transcript
  cwd: string;
  trigger: 'manual' | 'auto';
  custom_instructions: string | null;
};
```

We read the transcript file to extract conversation text for code context analysis.

Add `readFile` import at top of agent-runner.ts:
```typescript
import { readFile } from "node:fs/promises";
```

Then replace the hook:

```typescript
  private buildPreCompactHook(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const agentName = this.agentConfig.name;
    const agentId = this.agentConfig.id;
    const prefetcher = this.prefetcher;

    return {
      PreCompact: [{
        hooks: [async (input: any, _toolUseId, _opts) => {
          log.info("PreCompact hook fired", { agent: agentId });

          const baseInstructions = [
            `You are ${agentName} (agent ID: ${agentId}). When summarizing this conversation for compaction:`,
            "- Preserve your identity, role, and any behavioral instructions from your system prompt",
            "- Keep all customer/contact names, deal details, and reference numbers",
            "- Retain every decision made and commitment given — who decided what, and why",
            "- Preserve active workflows: what's in progress, what's pending, next steps",
            "- Keep tool call results that informed decisions (not raw API responses)",
            "- Discard pleasantries, thinking-out-loud, and intermediate failed attempts",
          ].join("\n");

          // Attempt to inject code context (graceful — never blocks compaction)
          let codeContext = "";
          if (prefetcher && input?.transcript_path) {
            try {
              const transcript = await readFile(input.transcript_path, "utf-8");
              if (transcript.length > 0) {
                codeContext = await prefetcher.getCompactionContext(transcript, agentId);
              }
            } catch (err) {
              log.warn("Code context extraction failed during compaction — proceeding without", {
                agent: agentId,
                error: String(err),
              });
            }
          }

          const systemMessage = codeContext
            ? `${baseInstructions}\n\n${codeContext}`
            : baseInstructions;

          return { continue: true, systemMessage };
        }],
      }],
    };
  }
```

**Key design notes:**
- `input.transcript_path` is a file path provided by the SDK containing the conversation transcript.
- We read the file and pass its contents to `getCompactionContext()`.
- The prefetcher call is wrapped in try/catch — code context is enrichment, never a blocker.
- If transcript_path is missing or file read fails, falls back to base instructions only.
- `input` is typed as `any` because the SDK's `PreCompactHookInput` type may not be exported. Read the actual imports to see if it's available — if so, use it.

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(compaction): enhance PreCompact hook with code-aware context (#89)"
```

---

### Task 4: Tests

**Files:**
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1:** Read existing PreCompact hook tests

Read the test file and find any existing tests for `buildPreCompactHook` or `PreCompact`. The test suite uses `getCapturedOptions()` to inspect query options passed to the SDK. The hooks are in `options.hooks.PreCompact`.

- [ ] **Step 2:** Add test — PreCompact hook without prefetcher (backward compat)

The hook input is `PreCompactHookInput` with `transcript_path` (a file path), not a messages array. Tests should write a temp file and pass its path.

```typescript
it("PreCompact hook returns base instructions when no prefetcher provided", async () => {
  const runner = new AgentRunner(makeAgentConfig({ name: "Jasper" }), memoryManager as any);
  await runner.send("test");
  const options = getCapturedOptions();
  expect(options.hooks).toBeDefined();

  const preCompact = options.hooks.PreCompact[0].hooks[0];
  const result = await preCompact({ transcript_path: "/tmp/test-transcript.txt", trigger: "auto" }, undefined, {});
  expect(result.continue).toBe(true);
  expect(result.systemMessage).toContain("Jasper");
  expect(result.systemMessage).toContain("Preserve your identity");
  expect(result.systemMessage).not.toContain("Files actively referenced");
});
```

- [ ] **Step 3:** Add test — PreCompact hook with prefetcher appends code context

```typescript
it("PreCompact hook appends code context when prefetcher provides results", async () => {
  // Write a temp transcript file
  const transcriptPath = "/tmp/test-transcript-code.txt";
  await writeFile(transcriptPath, "Let me fix the bug in src/index.ts\nI updated the handler.");

  const mockPrefetcher = {
    getCompactionContext: vi.fn().mockResolvedValue(
      "Files actively referenced in this conversation:\n- hive:src/index.ts — app entry [entry]\nPreserve references to these files.",
    ),
  };
  const runner = new AgentRunner(
    makeAgentConfig({ name: "Jasper" }),
    memoryManager as any,
    [],
    new Map(),
    "{}",
    mockPrefetcher as any,
  );
  await runner.send("test");
  const options = getCapturedOptions();

  const preCompact = options.hooks.PreCompact[0].hooks[0];
  const result = await preCompact({ transcript_path: transcriptPath, trigger: "auto" }, undefined, {});
  expect(result.systemMessage).toContain("Preserve your identity");
  expect(result.systemMessage).toContain("Files actively referenced");
  expect(mockPrefetcher.getCompactionContext).toHaveBeenCalled();
});
```

- [ ] **Step 4:** Add test — PreCompact hook survives prefetcher failure

```typescript
it("PreCompact hook returns base instructions when prefetcher throws", async () => {
  const transcriptPath = "/tmp/test-transcript-fail.txt";
  await writeFile(transcriptPath, "Some conversation about src/agents/agent-runner.ts");

  const mockPrefetcher = {
    getCompactionContext: vi.fn().mockRejectedValue(new Error("Qdrant down")),
  };
  const runner = new AgentRunner(
    makeAgentConfig({ name: "Jasper" }),
    memoryManager as any,
    [],
    new Map(),
    "{}",
    mockPrefetcher as any,
  );
  await runner.send("test");
  const options = getCapturedOptions();

  const preCompact = options.hooks.PreCompact[0].hooks[0];
  const result = await preCompact({ transcript_path: transcriptPath, trigger: "auto" }, undefined, {});
  expect(result.continue).toBe(true);
  expect(result.systemMessage).toContain("Preserve your identity");
  expect(result.systemMessage).not.toContain("Files actively referenced");
});
```

Note: Add `import { writeFile } from "node:fs/promises"` to test file imports. Use `afterEach` or `afterAll` to clean up temp files if needed.

**Important:** The test snippets above use pseudo-patterns for clarity. Read the actual test file to match the real constructor call pattern, mock setup, and option capture mechanism. Adapt accordingly.

- [ ] **Step 5:** Verify

Run: `npx vitest run src/agents/agent-runner.test.ts`
Expected: all tests pass

- [ ] **Step 6:** Commit

```bash
git add src/agents/agent-runner.test.ts
git commit -m "test(compaction): add tests for code-aware PreCompact hook (#89)"
```

---

### Task 5: Final verification

- [ ] **Step 1:** Full type check

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2:** Full test suite

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 3:** Build

Run: `npm run build`
Expected: clean build
