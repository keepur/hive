# Agent Creation UX — Phase 1 Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Fix `agent_create` to write archetype/title/archetypeConfig fields, default `coreServers` to a sensible baseline, reject unknown archetypes, expose a `list_archetypes` discovery tool, and mirror the creation-surface changes on `agent_update`.

**Architecture:** All changes live in the admin MCP surface, the archetype registry interface, and the shared agent-definition defaults. No runtime behavior change — the archetype plumbing and system-prompt card rendering already work. This phase fixes the creation/update authoring experience so agents created going forward carry correct archetype + coreServers data.

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/sdk`, Vitest.

**Spec:** [2026-04-20-agent-creation-ux-design.md](../specs/2026-04-20-agent-creation-ux-design.md) — Phase 1 section.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types/agent-definition.ts` | Modify | Add `coreServers` + `delegateServers` baselines to `AGENT_DEFINITION_DEFAULTS`. |
| `src/archetypes/registry.ts` | Modify | Extend `ArchetypeDefinition` interface with optional `description` / `whenToUse` / `configSchema`. |
| `src/archetypes/registry.test.ts` | Modify | Back-compat test — archetype without new fields still registers. |
| `src/archetypes/software-engineer/index.ts` | Modify | Populate `description`, `whenToUse`, `configSchema`. |
| `src/admin/admin-mcp-server.ts` | Modify | `agent_create` schema + doc-construction fix + unknown-archetype rejection; `agent_update` schema + unknown-archetype rejection; new `list_archetypes` tool. |
| `src/admin/admin-mcp-server.test.ts` | Modify | Regression tests for all of the above. |

---

### Task 1: Add `coreServers` + `delegateServers` baselines to defaults

**Files:**
- Modify: `src/types/agent-definition.ts:74-84`

- [ ] **Step 1:** Extend `AGENT_DEFINITION_DEFAULTS`.

Replace the existing object with:

```ts
/** Defaults applied by toAgentConfig when fields are absent */
export const AGENT_DEFINITION_DEFAULTS = {
  maxConcurrent: 3,
  timeoutMs: 300_000,
  budgetUsd: 10,
  maxTurns: 200,
  icon: "",
  keywords: [] as string[],
  passiveChannels: [] as string[],
  delegatePrompts: {} as Record<string, string>,
  schedule: [] as AgentSchedule[],
  coreServers: ["memory", "structured-memory", "keychain", "event-bus", "contacts"] satisfies readonly string[],
  delegateServers: [] satisfies readonly string[],
} as const;
```

Rationale for the two new entries:
- `coreServers` = the "functional team member" baseline (memory, structured-memory, keychain, event-bus, contacts). Slack/schedule/team are already implicit in `agent-runner.ts` so not listed here.
- `delegateServers` = empty, stated explicitly so callers see the baseline without guessing.

The `satisfies readonly string[]` pattern preserves the `as const` narrow-literal nature without forcing a widening at the declaration site. Call sites that spread (`[...AGENT_DEFINITION_DEFAULTS.coreServers]`) handle readonly→mutable fine.

- [ ] **Step 2:** Typecheck.

Run: `cd ~/github/hive && npm run typecheck`
Expected: zero errors.

- [ ] **Step 3:** Commit.

```bash
git add src/types/agent-definition.ts
git commit -m "feat(types): add coreServers and delegateServers baselines to AGENT_DEFINITION_DEFAULTS"
```

---

### Task 2: Extend `ArchetypeDefinition` with discovery fields

**Files:**
- Modify: `src/archetypes/registry.ts:41-59`
- Modify: `src/archetypes/registry.test.ts` (add back-compat test)

- [ ] **Step 1:** Add three optional fields to the interface and two exported types.

In `src/archetypes/registry.ts`, after the existing context interfaces and before `ArchetypeDefinition`, add:

```ts
/** Shape describing one archetypeConfig field for skill discovery. */
export interface ArchetypeConfigFieldSchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  description: string;
}

/** Self-description surfaced by list_archetypes. All fields optional for back-compat. */
export interface ArchetypeDescription {
  description?: string;
  whenToUse?: string;
  configSchema?: Record<string, ArchetypeConfigFieldSchema>;
}
```

Then update `ArchetypeDefinition` to extend `ArchetypeDescription`:

```ts
export interface ArchetypeDefinition<Config = unknown> extends ArchetypeDescription {
  /** Stable discipline id, e.g. "software-engineer". */
  id: string;

  /** Validate the raw archetypeConfig blob. Throws on invalid. Returns typed config. */
  validateConfig(config: unknown): Config;

  /** Return the system-prompt card (rendered once per session). */
  systemPromptCard(ctx: ArchetypePromptContext<Config>): string;

  /** Return PreToolUse hook matchers. Merged into agent-runner's hook set. */
  preToolUseHooks(ctx: ArchetypeHookContext<Config>): HookCallbackMatcher[];

  /** Declare the memory scopes this archetype exposes to the memory MCP server. */
  memoryScopes(ctx: ArchetypeMemoryContext<Config>): MemoryScope[];

  /** Return partial SDK query options merged into agent-runner's query() call. */
  sessionOptions(ctx: ArchetypeSessionContext<Config>): Partial<SdkQueryOptions>;
}
```

- [ ] **Step 2:** Add a back-compat test.

In `src/archetypes/registry.test.ts`, after the existing tests in the `describe("archetype registry", ...)` block, add:

```ts
  it("registers an archetype without description/whenToUse/configSchema (back-compat)", () => {
    registerArchetype(stub("legacy"));
    const def = getArchetype("legacy");
    expect(def).toBeDefined();
    expect(def?.description).toBeUndefined();
    expect(def?.whenToUse).toBeUndefined();
    expect(def?.configSchema).toBeUndefined();
  });

  it("surfaces description/whenToUse/configSchema when provided", () => {
    registerArchetype(
      stub("software-engineer", {
        description: "Owns codebases.",
        whenToUse: "When the role centers on shipping code.",
        configSchema: {
          workshop: { type: "string", required: true, description: "Engineering root." },
        },
      }),
    );
    const def = getArchetype("software-engineer");
    expect(def?.description).toBe("Owns codebases.");
    expect(def?.whenToUse).toBe("When the role centers on shipping code.");
    expect(def?.configSchema?.workshop.required).toBe(true);
  });
```

- [ ] **Step 3:** Run tests.

Run: `cd ~/github/hive && npm run test -- registry`
Expected: all tests pass, including the two new cases.

- [ ] **Step 4:** Commit.

```bash
git add src/archetypes/registry.ts src/archetypes/registry.test.ts
git commit -m "feat(archetypes): add optional description/whenToUse/configSchema to ArchetypeDefinition"
```

---

### Task 3: Populate software-engineer self-description

**Files:**
- Modify: `src/archetypes/software-engineer/index.ts`

- [ ] **Step 1:** Pass the three new fields into `registerArchetype`.

Replace the body of `src/archetypes/software-engineer/index.ts` with:

```ts
import { registerArchetype } from "../registry.js";
import { validateConfig } from "./config.js";
import { systemPromptCard } from "./prompt-card.js";
import { preToolUseHooks } from "./hooks.js";
import { memoryScopes } from "./memory-scopes.js";
import { sessionOptions } from "./session-options.js";
import type { SoftwareEngineerConfig } from "./config.js";

registerArchetype<SoftwareEngineerConfig>({
  id: "software-engineer",
  description:
    "Owns codebases and ships production code through disciplined delivery (ticket → spec → PR → CI → close).",
  whenToUse:
    "Pick this when the agent's core job is writing, reviewing, or shipping production code. For product strategists, marketers, or anyone where code is incidental, use a plain agent.",
  configSchema: {
    workshop: {
      type: "string",
      required: true,
      description:
        "Absolute filesystem path — the engineer's bounded root directory (e.g. /Users/you/dev).",
    },
    workspaces: {
      type: "array",
      required: false,
      description:
        "Registered codebases inside the workshop. Do NOT prompt for these at creation time — workspace registration is a separate admin flow. Start with an empty array.",
    },
  },
  validateConfig,
  systemPromptCard,
  preToolUseHooks,
  memoryScopes,
  sessionOptions,
});
```

- [ ] **Step 2:** Typecheck + test.

Run: `cd ~/github/hive && npm run typecheck && npm run test -- archetypes`
Expected: all green.

- [ ] **Step 3:** Commit.

```bash
git add src/archetypes/software-engineer/index.ts
git commit -m "feat(archetypes/software-engineer): populate description/whenToUse/configSchema"
```

---

### Task 4: Add `list_archetypes` admin tool

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (add new tool after the last existing registerTool)
- Modify: `src/admin/admin-mcp-server.test.ts` (add test)

- [ ] **Step 1:** Find the end of the last registered tool (after `instance_capabilities`, around line 630+) and add the new tool.

First add imports near the top of `src/admin/admin-mcp-server.ts`:

```ts
import { getArchetype, listArchetypeIds } from "../archetypes/registry.js";
```

Then register the tool. Add at the end of the file's tool registration block (before the transport hookup):

```ts
// ---------------------------------------------------------------------------
// list_archetypes
// ---------------------------------------------------------------------------

server.registerTool(
  "list_archetypes",
  {
    title: "List Archetypes",
    description:
      "List registered agent archetypes with self-descriptions. Use this to decide whether an agent you are creating is a discipline-bound archetype (e.g. software-engineer) or a plain unstructured agent.",
    inputSchema: {},
  },
  async () => {
    const ids = listArchetypeIds();
    const catalog = ids
      .map((id) => {
        const def = getArchetype(id);
        if (!def) return null;
        return {
          id: def.id,
          description: def.description ?? null,
          whenToUse: def.whenToUse ?? null,
          configSchema: def.configSchema ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return {
      content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }],
    };
  },
);
```

- [ ] **Step 2:** Add a test.

In `src/admin/admin-mcp-server.test.ts`, add a new `describe` block (or extend an existing one) with:

```ts
describe("list_archetypes", () => {
  it("returns the registered archetype catalog with discovery fields", async () => {
    const handler = toolHandlers.get("list_archetypes");
    expect(handler).toBeDefined();
    const result = await handler!({});
    const text = result.content[0].text as string;
    const catalog = JSON.parse(text) as Array<{ id: string; description: string | null; whenToUse: string | null; configSchema: Record<string, unknown> | null }>;
    // software-engineer is registered at import time via ../archetypes/index
    const se = catalog.find((c) => c.id === "software-engineer");
    expect(se).toBeDefined();
    expect(se?.description).toContain("codebases");
    expect(se?.configSchema).toHaveProperty("workshop");
  });
});
```

Note: the test relies on the software-engineer archetype being registered as a side effect of `import`. The existing test file already imports the admin server module, which transitively imports the archetype registration; if not, add:
```ts
await import("../archetypes/software-engineer/index.js");
```
near the top of the test file.

- [ ] **Step 3:** Run tests.

Run: `cd ~/github/hive && npm run test -- admin-mcp-server`
Expected: new `list_archetypes` test passes plus all existing pass.

- [ ] **Step 4:** Commit.

```bash
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "feat(admin): add list_archetypes tool for archetype discovery"
```

---

### Task 5: Fix `agent_create` — schema promotion, doc-construction, unknown-archetype rejection

**Files:**
- Modify: `src/admin/admin-mcp-server.ts:135-222`
- Modify: `src/admin/admin-mcp-server.test.ts`

- [ ] **Step 1:** Replace the `agent_create` registration block. The new version promotes `homeBase`, `archetype`, `title`, `soul`, `systemPrompt` to top-level, fills in the default `coreServers` baseline, picks up `archetype`/`title`/`archetypeConfig` in the inserted doc, and rejects unknown archetypes.

Locate the existing `agent_create` block at `src/admin/admin-mcp-server.ts:135`. Replace everything from `server.registerTool(` through the closing `);` of that single registration with:

```ts
server.registerTool(
  "agent_create",
  {
    title: "Create Agent",
    description:
      "Create a new agent definition. Required: _id, name, model, homeBase. Archetype is optional — pass it when the role is a discipline with shared infrastructure (see list_archetypes). Soul/systemPrompt shape the agent's voice and role; if omitted they default to empty strings. Additional tuning (channels, schedule, budget, autonomy, archetypeConfig, etc.) goes in `fields`.",
    inputSchema: {
      _id: z.string().describe("Agent ID (lowercase with hyphens, e.g. 'my-agent')"),
      name: z.string().describe("Display name for the agent"),
      model: z.string().describe("Model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),
      homeBase: z
        .string()
        .describe(
          "Primary Slack channel for scheduler delivery and default identity (e.g. 'agent-<id>'). The channel must exist in Slack.",
        ),
      soul: z
        .string()
        .optional()
        .describe("Personality / voice / character definition (5-15 lines). Shapes how the agent talks."),
      systemPrompt: z
        .string()
        .optional()
        .describe("Role definition and guardrails. Concise. Instance-specific flavor — archetype framing layers underneath."),
      archetype: z
        .string()
        .optional()
        .describe(
          "Discipline id from list_archetypes (e.g. 'software-engineer'). Omit for plain unstructured agents.",
        ),
      title: z
        .string()
        .optional()
        .describe("Customer-facing title (e.g. 'VP Engineering'). Typically paired with archetype."),
      fields: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Additional fields (channels, passiveChannels, schedule, coreServers override, delegateServers, plugins, autonomy, archetypeConfig, budgetUsd, maxTurns, etc.)",
        ),
    },
  },
  async ({ _id, name, model, homeBase, soul, systemPrompt, archetype, title, fields }) => {
    const existing = await agentDefs.findOne({ _id: _id as any });
    if (existing) {
      return {
        content: [{ type: "text", text: `Agent '${_id}' already exists. Use agent_update to modify it.` }],
        isError: true,
      };
    }

    if (!homeBase || homeBase.trim() === "") {
      return {
        content: [
          {
            type: "text",
            text: `Missing required field: homeBase (primary channel for scheduled delivery, e.g. 'agent-${_id}').`,
          },
        ],
        isError: true,
      };
    }

    if (archetype !== undefined && !getArchetype(archetype)) {
      const known = listArchetypeIds().join(", ") || "(none registered)";
      return {
        content: [{ type: "text", text: `Unknown archetype: "${archetype}". Known: ${known}.` }],
        isError: true,
      };
    }

    const f = fields ?? {};
    const now = new Date();
    const doc: AgentDefinition = {
      _id,
      name,
      model,
      icon: (f.icon as string) ?? AGENT_DEFINITION_DEFAULTS.icon,
      channels: (f.channels as string[]) ?? [],
      homeBase: homeBase.trim(),
      passiveChannels: (f.passiveChannels as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.passiveChannels],
      keywords: (f.keywords as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.keywords],
      isDefault: (f.isDefault as boolean) ?? false,
      coreServers: (f.coreServers as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.coreServers],
      delegateServers: (f.delegateServers as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.delegateServers],
      delegatePrompts: (f.delegatePrompts as Record<string, string>) ?? {
        ...AGENT_DEFINITION_DEFAULTS.delegatePrompts,
      },
      plugins: f.plugins as string[] | undefined,
      metadata: f.metadata as Record<string, unknown> | undefined,
      soul: soul ?? (f.soul as string) ?? "",
      systemPrompt: systemPrompt ?? (f.systemPrompt as string) ?? "",
      archetype,
      title,
      archetypeConfig: f.archetypeConfig as Record<string, unknown> | undefined,
      schedule: (f.schedule as Array<{ cron: string; task: string }>) ?? [...AGENT_DEFINITION_DEFAULTS.schedule],
      subscribe: f.subscribe as string[] | undefined,
      budgetUsd: (f.budgetUsd as number) ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
      maxTurns: (f.maxTurns as number) ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
      maxConcurrent: (f.maxConcurrent as number) ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
      timeoutMs: (f.timeoutMs as number) ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
      disabled: (f.disabled as boolean) ?? false,
      slackBot: f.slackBot as string | undefined,
      autonomy: f.autonomy as Partial<AutonomyFlags> | undefined,
      resourceTiers: f.resourceTiers as AgentDefinition["resourceTiers"],
      betas: f.betas as string[] | undefined,
      catches: f.catches as string[] | undefined,
      createdAt: now,
      updatedAt: now,
      updatedBy: AGENT_ID,
    };

    await agentDefs.insertOne(doc as any);
    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${_id}' (${name}) created with model ${model}${archetype ? ` — archetype ${archetype}` : ""}. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);
```

- [ ] **Step 2:** Add tests.

In `src/admin/admin-mcp-server.test.ts`, extend the existing `describe("agent_create", ...)` block (or add one) with:

```ts
  it("applies coreServers baseline when not provided", async () => {
    const handler = toolHandlers.get("agent_create");
    const res = await handler!({
      _id: "new-agent",
      name: "New",
      model: "claude-haiku-4-5",
      homeBase: "agent-new",
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("new-agent");
    expect(doc.coreServers).toEqual(["memory", "structured-memory", "keychain", "event-bus", "contacts"]);
    expect(doc.delegateServers).toEqual([]);
  });

  it("honors explicit coreServers override", async () => {
    const handler = toolHandlers.get("agent_create");
    await handler!({
      _id: "explicit-server-agent",
      name: "X",
      model: "claude-haiku-4-5",
      homeBase: "agent-x",
      fields: { coreServers: ["admin"] },
    });
    expect(agentDocsStore.get("explicit-server-agent").coreServers).toEqual(["admin"]);
  });

  it("writes archetype, title, and archetypeConfig into the document", async () => {
    const handler = toolHandlers.get("agent_create");
    await handler!({
      _id: "alex-test",
      name: "Alex",
      model: "claude-sonnet-4-6",
      homeBase: "agent-alex",
      archetype: "software-engineer",
      title: "Head of Product",
      fields: {
        archetypeConfig: { workshop: "/tmp", workspaces: [] },
      },
    });
    const doc = agentDocsStore.get("alex-test");
    expect(doc.archetype).toBe("software-engineer");
    expect(doc.title).toBe("Head of Product");
    expect(doc.archetypeConfig).toEqual({ workshop: "/tmp", workspaces: [] });
  });

  it("rejects unknown archetype", async () => {
    const handler = toolHandlers.get("agent_create");
    const res = await handler!({
      _id: "bad-archetype",
      name: "Bad",
      model: "claude-haiku-4-5",
      homeBase: "agent-bad",
      archetype: "bookkeeper",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown archetype");
    expect(agentDocsStore.has("bad-archetype")).toBe(false);
  });

  it("still requires homeBase", async () => {
    const handler = toolHandlers.get("agent_create");
    const res = await handler!({
      _id: "no-home",
      name: "No",
      model: "claude-haiku-4-5",
      homeBase: "",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("homeBase");
  });
```

- [ ] **Step 3:** Run tests.

Run: `cd ~/github/hive && npm run test -- admin-mcp-server`
Expected: all `agent_create` tests pass (new + existing).

- [ ] **Step 4:** Commit.

```bash
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "fix(admin): agent_create writes archetype fields and applies coreServers baseline"
```

---

### Task 6: Mirror schema promotion on `agent_update`

**Files:**
- Modify: `src/admin/admin-mcp-server.ts:228-278`
- Modify: `src/admin/admin-mcp-server.test.ts`

- [ ] **Step 1:** Replace the `agent_update` registration block.

Locate the existing `agent_update` block at `src/admin/admin-mcp-server.ts:228`. Replace the full registration with:

```ts
server.registerTool(
  "agent_update",
  {
    title: "Update Agent",
    description:
      "Update fields on an existing agent definition. Saves a version snapshot before mutation. Cannot change _id. Creation-boundary fields (homeBase, archetype, title, soul, systemPrompt) are promoted to top-level for discoverability; everything else goes in `fields`.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to update"),
      homeBase: z.string().optional().describe("Primary Slack channel for scheduler delivery."),
      soul: z.string().optional().describe("Personality / voice / character definition."),
      systemPrompt: z.string().optional().describe("Role definition and guardrails."),
      archetype: z
        .string()
        .optional()
        .describe(
          "Discipline id from list_archetypes. Pass null-style empty string to clear (note: fields.archetype: null also works via the fields bag).",
        ),
      title: z.string().optional().describe("Customer-facing title."),
      fields: z
        .record(z.string(), z.any())
        .optional()
        .describe("Additional fields (channels, schedule, autonomy, archetypeConfig, budgetUsd, model, etc.)"),
    },
  },
  async ({ agent_id, homeBase, soul, systemPrompt, archetype, title, fields }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    // Merge top-level promotions into the fields bag for unified handling.
    const merged: Record<string, unknown> = { ...(fields ?? {}) };
    if (homeBase !== undefined) merged.homeBase = homeBase;
    if (soul !== undefined) merged.soul = soul;
    if (systemPrompt !== undefined) merged.systemPrompt = systemPrompt;
    if (archetype !== undefined) merged.archetype = archetype;
    if (title !== undefined) merged.title = title;

    if ("_id" in merged) {
      return {
        content: [{ type: "text", text: "Cannot change _id. Create a new agent instead." }],
        isError: true,
      };
    }
    delete merged.createdAt;

    // Validate unknown archetype if the update sets it. Empty string is allowed
    // as an explicit "clear archetype" signal (via the fields bag) and does not trigger
    // validation — only non-empty strings are checked against the registry.
    if (typeof merged.archetype === "string" && merged.archetype.length > 0 && !getArchetype(merged.archetype)) {
      const known = listArchetypeIds().join(", ") || "(none registered)";
      return {
        content: [{ type: "text", text: `Unknown archetype: "${merged.archetype}". Known: ${known}.` }],
        isError: true,
      };
    }

    const changedFields = Object.keys(merged);
    if (changedFields.length === 0) {
      return {
        content: [{ type: "text", text: `No fields to update for '${agent_id}'.` }],
        isError: true,
      };
    }
    await saveVersion(agent_id, changedFields);

    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { ...merged, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' updated: ${changedFields.join(", ")}. Version saved. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);
```

- [ ] **Step 2:** Add tests.

In `src/admin/admin-mcp-server.test.ts`, extend the `agent_update` block (or add one) with:

```ts
  it("accepts archetype via top-level promotion", async () => {
    agentDocsStore.set("alex-test", {
      _id: "alex-test",
      name: "Alex",
      model: "claude-sonnet-4-6",
      homeBase: "agent-alex",
      coreServers: ["memory"],
    });
    const handler = toolHandlers.get("agent_update");
    const res = await handler!({
      agent_id: "alex-test",
      archetype: "software-engineer",
      title: "Head of Product",
      fields: { archetypeConfig: { workshop: "/tmp", workspaces: [] } },
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("alex-test");
    expect(doc.archetype).toBe("software-engineer");
    expect(doc.title).toBe("Head of Product");
    expect(doc.archetypeConfig).toEqual({ workshop: "/tmp", workspaces: [] });
  });

  it("rejects unknown archetype on update", async () => {
    agentDocsStore.set("someone", {
      _id: "someone",
      name: "S",
      model: "claude-haiku-4-5",
      homeBase: "agent-s",
    });
    const handler = toolHandlers.get("agent_update");
    const res = await handler!({ agent_id: "someone", archetype: "bookkeeper" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown archetype");
  });

  it("errors when no updatable fields are provided", async () => {
    agentDocsStore.set("empty-update", {
      _id: "empty-update",
      name: "E",
      model: "claude-haiku-4-5",
      homeBase: "agent-e",
    });
    const handler = toolHandlers.get("agent_update");
    const res = await handler!({ agent_id: "empty-update" });
    expect(res.isError).toBe(true);
  });
```

- [ ] **Step 3:** Run tests.

Run: `cd ~/github/hive && npm run test -- admin-mcp-server`
Expected: new `agent_update` tests pass + existing pass.

- [ ] **Step 4:** Commit.

```bash
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "feat(admin): promote creation-boundary fields on agent_update and reject unknown archetypes"
```

---

### Task 7: Final verification — full check + push

**Files:** none (verification only)

- [ ] **Step 1:** Run the full repo check.

Run: `cd ~/github/hive && npm run check`
Expected: typecheck + lint + format + test all pass.

- [ ] **Step 2:** Push branch.

Run: `cd ~/github/hive && git push -u origin <current-branch>`
Expected: push succeeds; print the PR URL.

- [ ] **Step 3:** Open PR (only when user confirms).

Skip this step if the user wants to hold; otherwise:

```bash
gh pr create --title "Agent creation UX Phase 1 — admin MCP defaults + archetype discovery" --body "$(cat <<'EOF'
## Summary
- Default coreServers baseline on agent creation (memory, structured-memory, keychain, event-bus, contacts)
- agent_create now writes archetype/title/archetypeConfig into the document (previously silently dropped)
- agent_create and agent_update reject unknown archetypes at tool level
- New list_archetypes admin tool returns id + description + whenToUse + configSchema per archetype
- ArchetypeDefinition extended with optional description/whenToUse/configSchema; software-engineer populated

## Spec
docs/specs/2026-04-20-agent-creation-ux-design.md — Phase 1 section.

## Test plan
- [ ] `npm run check` green
- [ ] Manual: ask Hermi to call list_archetypes — returns software-engineer with config schema
- [ ] Manual: create a test agent with no coreServers — doc has baseline
- [ ] Manual: create a test agent with archetype: "software-engineer" + archetypeConfig — archetype is set, not dropped

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementer

- Commit after each task — the plan is designed so every step leaves the repo green.
- If typecheck fails on Task 1 because `coreServers` widens in `AGENT_DEFINITION_DEFAULTS`, the `satisfies readonly string[]` pattern fixes it. If that doesn't resolve, fall back to `as readonly string[]`. Do NOT revert to `as string[]` — it widens the `as const` unnecessarily.
- Task 5's replacement block is the most substantial change. Read the existing block carefully before replacing — preserve any commentary or import lines that are not shown in the new block but exist in the current file.
- Tests in Task 4 and beyond assume `toolHandlers` is already set up in the test file (the existing pattern; confirm by reading the top of `admin-mcp-server.test.ts`).
- Hermi's live keepur agent session: once this phase lands and is deployed, she'll see the new tool schemas immediately on next spawn. No migration script needed for fresh creations. Alex retrofit is a separate one-off admin op covered in the spec's Rollout section.
