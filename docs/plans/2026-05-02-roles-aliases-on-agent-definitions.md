# Structured Roles + Aliases on agent_definitions — Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Goal:** Add a structured `roles: string[]` field to agent definitions, fix the team-cache projection bug that referenced a nonexistent `role` field, tighten tool descriptions so agents reach for `team_lookup_agent` before `admin_agent_get`, and backfill roles for dodi + keepur agents.

**Architecture:** Pure additive schema change. New `roles: string[]` (required, soft-warn empty) + `aliases?: string[]` (already in schema — promoted from `fields` blob to top-level on admin tools). Existing `title` field is left alone — it's archetype-related and conceptually different. team-cache.ts had a typo bug: it projected `role` from agent docs but the field was never named `role`. Fix that *and* add the field. Pair with description tweaks on `team_lookup_agent` and `admin_agent_get` to route the model away from the heavyweight admin path for routine teammate info.

**Tech Stack:** TypeScript, MongoDB driver, Vitest, Zod, MCP SDK.

**Out of scope (separate plan, separate worktree):** Beekeeper-side changes — `tune-instance` skill audit step for empty `roles`, `agent-builder` skill prompts. File those after this plan ships and the engine v0.4.1 release lands.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types/agent-definition.ts` | Modify | Add `roles: string[]` field + thread through `toAgentConfig` and `AGENT_DEFINITION_DEFAULTS` |
| `src/types/agent-config.ts` | Modify | Add `roles: string[]` to `AgentConfig` |
| `src/types/agent-definition.test.ts` | Modify | Cover new field |
| `setup/setup-seeds.ts` | Modify | Pass `roles` through seed-import construction |
| `setup/migrate-agents.ts` | Modify | Pass `roles` through legacy file→DB construction |
| `src/admin/admin-api.ts` | Modify | Pass `roles` through REST agent-create construction |
| `src/team-roster/types.ts` | Modify | `TeamMember.role?` → `roles?: string[]` |
| `src/team-roster/team-cache.ts` | Modify | Fix typo bug (projected nonexistent `role` field); project `roles[]` and `aliases` |
| `src/team-roster/team-roster.ts` | Modify | Render `roles` joined in `teamSummary()` |
| `src/team-roster/team-roster.test.ts` | Modify | Cover joined roles render |
| `src/team-roster/team-cache.test.ts` | Modify | Cover roles projection |
| `src/team-roster/team-roster-mcp-server.ts` | Modify | Tighten `team_lookup_agent` description |
| `src/admin/admin-mcp-server.ts` | Modify | Promote `roles` (req'd) + `aliases` (opt) to top-level on `agent_create` / `agent_update`; tighten `agent_get` description; render `roles` in `agent_get` output |
| `src/admin/admin-mcp-server.test.ts` | Modify | Cover top-level roles + agent_get rendering |
| `src/agents/agent-registry.ts` | Modify | Soft-warn at load if any active agent has empty/missing `roles` |
| `seeds/chief-of-staff/agent.yaml` | Modify | Add `roles: ["Chief of Staff"]` |
| `scripts/migrate-agents-add-roles.ts` | Create | One-time backfill (dodi + keepur hardcoded maps) |
| `package.json` | Modify | Add `migrate:agents:add-roles` script entry |

---

### Task 1: Schema — add `roles` to AgentDefinition + AgentConfig + every construction site

**Files:**
- Modify: `src/types/agent-definition.ts`
- Modify: `src/types/agent-config.ts`
- Modify: `setup/setup-seeds.ts`
- Modify: `setup/migrate-agents.ts`
- Modify: `src/admin/admin-api.ts`

> **Why this task is wide:** Adding a required field to `AgentDefinition` triggers TypeScript errors at every construction site. There are four: `admin-mcp-server.ts` (covered in Task 4), `admin-api.ts`, `setup-seeds.ts`, and `setup/migrate-agents.ts`. Fix three of them here so `npm run typecheck` is green at the end of Task 1; Task 4 covers the fourth (admin MCP) along with its own input-shape changes.

- [ ] **Step 1:** Add the field on `AgentDefinition` after `aliases`.

In `src/types/agent-definition.ts`, after line 9 (`aliases?: string[];`):

```typescript
/**
 * What this agent does — one or more concise role labels surfaced via
 * team_lookup_agent and the team summary in system prompts. Required from
 * KPR-141 onwards; legacy docs may have an empty array (engine soft-warns
 * at load time). Examples: ["VP Engineering"], ["Production Support",
 * "Bilingual liaison (Mandarin/English)"].
 */
roles: string[];
```

- [ ] **Step 2:** Thread it through `AGENT_DEFINITION_DEFAULTS` (so docs missing the field deserialize to `[]` instead of crashing) and `toAgentConfig`.

Add to `AGENT_DEFINITION_DEFAULTS` block (~line 75):

```typescript
roles: [] as string[],
```

In `toAgentConfig` (~line 89), after the `aliases` line:

```typescript
roles: doc.roles ?? AGENT_DEFINITION_DEFAULTS.roles,
```

- [ ] **Step 3:** Mirror on `AgentConfig` in `src/types/agent-config.ts`. Find the `aliases` field and add directly after:

```typescript
roles: string[];
```

- [ ] **Step 4:** Update `setup/setup-seeds.ts` (~line 54). In the existing `const doc: AgentDefinition = { ... }` block, insert one new line for `roles` immediately after the `slackBot:` line and before `createdAt:`. Do NOT rewrite the rest of the block — only insert this single line:

```typescript
roles: raw.roles ?? AGENT_DEFINITION_DEFAULTS.roles,
```

`AGENT_DEFINITION_DEFAULTS` is already imported in `setup-seeds.ts` — no import change needed.

- [ ] **Step 5:** Update `setup/migrate-agents.ts` (~line 103). Same pattern — add `roles` to the doc construction:

```typescript
roles: raw.roles ?? AGENT_DEFINITION_DEFAULTS.roles,
```

- [ ] **Step 6:** Update `src/admin/admin-api.ts` (~line 165). Add `roles` to the doc construction. Since this is the REST agent-create handler, it should also accept `roles` as an input field. Look at the parameter parsing immediately above the construction — add `roles` to whatever input shape is being read (likely a `body` JSON shape). Set:

```typescript
roles: body.roles ?? [],
```

If `admin-api.ts` returns a typed input schema (e.g., zod), add `roles: z.array(z.string()).optional()` (mirror admin-mcp-server.ts but optional here, since this REST endpoint is lower-traffic and we don't want to break legacy clients with a hard required).

- [ ] **Step 7:** Verify

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 8:** Commit

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts setup/setup-seeds.ts setup/migrate-agents.ts src/admin/admin-api.ts
git commit -m "feat(types): add roles field to AgentDefinition + thread through all construction sites (KPR-141)"
```

---

### Task 2: team-roster module — `role` → `roles[]` end-to-end (single commit)

**Files:**
- Modify: `src/team-roster/types.ts`
- Modify: `src/team-roster/team-cache.ts`
- Modify: `src/team-roster/team-roster.ts`
- Modify: `src/team-roster/team-cache.test.ts`
- Modify: `src/team-roster/team-roster.test.ts`

> **Single-commit rationale:** Renaming `TeamMember.role` to `roles[]` cascades into two consumer files (`team-cache.ts`, `team-roster.ts`). Splitting the rename + consumer fixes across commits leaves a broken-typecheck window. Land all five files in one commit.

> **The bug being fixed in `team-cache.ts`:** The current `AgentDefDoc` interface declares `role?: string` and the agent-projection mapping does `role: d.role` — but `agent_definitions` documents have never had a `role` field. The mapping silently produced `undefined` for every agent. This task replaces it with the new `roles[]` field on the schema. (Note: `AgentDefDoc` here is a TypeScript narrowing for the cache, not a MongoDB projection — the actual `find({})` returns all fields. Adding a real MongoDB `{ projection: ... }` is left out of scope.)

- [ ] **Step 1:** `src/team-roster/types.ts` — replace `role?: string;` with:

```typescript
roles?: string[];
```

- [ ] **Step 2:** `src/team-roster/team-cache.ts` — update the `AgentDefDoc` interface (~line 13) — replace `role?: string;` with `roles?: string[];`. Keep all other fields (including the existing `aliases?: string[]`):

```typescript
interface AgentDefDoc {
  _id: string;
  name: string;
  roles?: string[];     // ← was `role?: string` (typo bug — field never existed on the doc)
  model?: string;
  homeBase?: string;
  channels?: string[];
  aliases?: string[];
  disabled?: boolean;
}
```

- [ ] **Step 3:** `src/team-roster/team-cache.ts` — update the `getAgents()` mapping (~line 98). Replace:

```typescript
role: d.role,
```

with:

```typescript
roles: d.roles ?? [],
```

- [ ] **Step 4:** `src/team-roster/team-cache.ts` — update the `getHumans()` mapping (~line 79). Humans currently use a singular `role` per ContactDoc; lift to a one-element array so `TeamMember.roles` is uniform across humans and agents. Replace:

```typescript
role: d.role,
```

with:

```typescript
roles: d.role ? [d.role] : [],
```

- [ ] **Step 5:** `src/team-roster/team-roster.ts` — in `teamSummary()`, update both `role` reads.

Humans loop (~line 91):
```typescript
// before:
const role = h.role ? ` — ${h.role}` : "";

// after:
const role = h.roles && h.roles.length > 0 ? ` — ${h.roles.join(" / ")}` : "";
```

Agents loop (~line 98):
```typescript
// before:
const role = a.role ? ` — ${a.role}` : "";

// after:
const role = a.roles && a.roles.length > 0 ? ` — ${a.roles.join(" / ")}` : "";
```

- [ ] **Step 6:** Update `src/team-roster/team-cache.test.ts`. Any existing test asserting on `role: "..."` in the projection output now expects `roles: ["..."]`. Add one new positive case: a doc with `roles: ["A", "B"]` is projected as `roles: ["A", "B"]`. A doc with no `roles` field at all is projected as `roles: []`.

- [ ] **Step 7:** Update `src/team-roster/team-roster.test.ts`. Any existing test asserting on rendered role substrings switches to the joined form. Add one new test case: agent with `roles: ["A", "B"]` renders as `"... — A / B ..."`.

- [ ] **Step 8:** Verify

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run typecheck && npm run test -- src/team-roster/
```

Expected: typecheck green, all team-roster tests pass.

- [ ] **Step 9:** Commit

```bash
git add src/team-roster/types.ts src/team-roster/team-cache.ts src/team-roster/team-roster.ts src/team-roster/team-cache.test.ts src/team-roster/team-roster.test.ts
git commit -m "fix(team-roster): rename role→roles[] across module + fix nonexistent-field projection bug (KPR-141)"
```

---

### Task 3: team_lookup_agent — tighten description

**Files:**
- Modify: `src/team-roster/team-roster-mcp-server.ts`
- Modify: `src/team-roster/team-roster-mcp-server.test.ts`

- [ ] **Step 1:** Replace the description string for `team_lookup_agent` (~line 52):

```typescript
// before:
"Look up a team-agent by agentId or name (aliases supported). Provide exactly one. agentId match is case-sensitive; name/alias match is case-insensitive. Returns full agent card or null if no match.",

// after:
"Look up a team-agent by agentId or name (aliases supported). USE THIS FOR ROUTINE TEAMMATE INFO — roles, channel, model. Reserve `agent_get` (admin) for editing or version history. Provide exactly one of agentId|name. agentId match is case-sensitive; name/alias match is case-insensitive. Returns full agent card or null if no match.",
```

- [ ] **Step 2:** Mirror improvement for `team_lookup_human` (~line 32) — same routing hint pattern, lighter touch since there's no admin equivalent for humans:

```typescript
// before:
"Look up a team-human by name or email. Provide exactly one. Returns full contact card or null if no match. Match is case-insensitive exact (no fuzzy/partial).",

// after:
"Look up a team-human by name or email. USE THIS FOR ROUTINE TEAMMATE INFO — roles, email, pronouns. Provide exactly one of name|email. Returns full contact card or null if no match. Match is case-insensitive exact (no fuzzy/partial).",
```

- [ ] **Step 3:** Update `team-roster-mcp-server.test.ts` — any tests asserting on tool description strings need updating; if there are no such assertions, no test change needed.

- [ ] **Step 4:** Verify

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run test -- src/team-roster/
```

Expected: pass.

- [ ] **Step 5:** Commit

```bash
git add src/team-roster/team-roster-mcp-server.ts src/team-roster/team-roster-mcp-server.test.ts
git commit -m "feat(team-roster): tighten lookup tool descriptions to route away from admin (KPR-141)"
```

---

### Task 4: admin-mcp-server — promote roles + aliases to top-level; tighten agent_get

**Files:**
- Modify: `src/admin/admin-mcp-server.ts`
- Modify: `src/admin/admin-mcp-server.test.ts`

The admin `agent_create` and `agent_update` tools currently accept `aliases` only via the opaque `fields` blob. Promote `roles` and `aliases` to typed top-level inputs for discoverability. Also tighten `agent_get` description so the model reaches for `team_lookup_agent` first.

- [ ] **Step 1:** Update `agent_create`'s `inputSchema` (~line 145). Add `roles` (required) and `aliases` (optional) before the `fields` entry, and tighten the description:

```typescript
description:
  "Create a new agent definition. Required: _id, name, model, homeBase, roles. Roles is an array of concise role labels (e.g. [\"VP Engineering\"] or [\"Production Support\", \"Bilingual liaison\"]) — used by team_lookup_agent and the team summary in agent system prompts. Archetype is optional — pass it when the role is a discipline with shared infrastructure (see list_archetypes). Soul/systemPrompt shape the agent's voice and role; if omitted they default to empty strings. Additional tuning (channels, schedule, budget, autonomy, archetypeConfig, etc.) goes in `fields`.",
inputSchema: {
  _id: z.string().describe("Agent ID (lowercase with hyphens, e.g. 'my-agent')"),
  name: z.string().describe("Display name for the agent"),
  roles: z
    .array(z.string())
    .min(1)
    .describe(
      "What this agent does — one or more concise role labels (e.g. [\"VP Engineering\"], or [\"Production Support\", \"Bilingual liaison (Mandarin/English)\"]). Surfaced via team_lookup_agent and team summary in system prompts.",
    ),
  aliases: z
    .array(z.string())
    .optional()
    .describe("Optional short names / nicknames for name-based routing (e.g. [\"Sam\"] for \"Samantha\")."),
  model: z.string().describe("Model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),
  // ... rest unchanged
```

- [ ] **Step 2:** Update the handler in two precise places — do not rewrite the full handler.

(a) Handler arg destructure (~line 179): add `roles, aliases` to the existing destructure list. The new line:

```typescript
async ({ _id, name, roles, aliases, model, homeBase, soul, systemPrompt, archetype, title, fields }) => {
```

(b) `doc: AgentDefinition = { ... }` object literal (~line 210): the existing `aliases:` line is at line 213 (`aliases: f.aliases as string[] | undefined,`). Replace that line with two lines — top-level overrides `f.aliases`, and `roles` is the new required field. Keep ALL other fields in the literal unchanged:

```typescript
aliases: aliases ?? (f.aliases as string[] | undefined),
roles,
```

This is a 1-line replacement → 2-line insertion. Do not touch any other field of the object literal.

- [ ] **Step 3:** Mirror on `agent_update`. Find the tool definition (search for `"agent_update"`).

Add `roles` and `aliases` to the inputSchema as optional (both are optional on update — `agent_update` is delta-style, only field-set-on-call is mutated):

```typescript
roles: z
  .array(z.string())
  .min(1)
  .optional()
  .describe("Replace the agent's roles array. Pass the full new array, not a delta. Cannot be empty."),
aliases: z
  .array(z.string())
  .optional()
  .describe("Replace the agent's aliases array (pass [] to clear). Optional."),
```

Update the handler destructure at the existing `async ({ ... }) =>` line (~line 292) to add `roles, aliases` — leave every other captured arg in place. The current line is:

```typescript
async ({ agent_id, homeBase, soul, systemPrompt, archetype, title, fields }) => {
```

Replace with:

```typescript
async ({ agent_id, homeBase, soul, systemPrompt, archetype, title, roles, aliases, fields }) => {
```

Then explicitly merge `roles` and `aliases` into the `$set`/`merged` block — match the existing pattern used for `homeBase` etc.:

```typescript
// In the merge block, after existing top-level overrides:
if (roles !== undefined) merged.roles = roles;
if (aliases !== undefined) merged.aliases = aliases;
```

The existing `fields.aliases` path stays for backward compatibility, but top-level wins because the explicit `merged.aliases = aliases` runs after the `{ ...fields }` spread.

- [ ] **Step 4:** Tighten `agent_get` description. Find the `"agent_get"` registration:

```typescript
description:
  "Fetch full agent definition (admin). Use ONLY for editing or inspecting version history; for routine teammate info (roles, channel, model) prefer `team_lookup_agent`.",
```

- [ ] **Step 5:** Render `roles` in `agent_get` output. Find where the agent_get handler builds its `lines` array. After the `Aliases:` line (or wherever fits), add:

```typescript
lines.push(`Roles: ${(doc.roles && doc.roles.length > 0) ? doc.roles.join(" / ") : "(not set — backfill via agent_update)"}`);
```

- [ ] **Step 6:** Update tests in `src/admin/admin-mcp-server.test.ts`:
  - Existing `agent_create` test must include `roles: ["X"]` in inputs.
  - Add a positive case: `agent_create` with `roles: ["A", "B"]` persists both.
  - Add a negative case: `agent_create` with `roles: []` is rejected by the schema (zod `.min(1)` enforces).
  - `agent_get` output rendering shows `Roles: A / B`.
  - `agent_update` with `roles: ["X"]` updates the doc; without `roles`, the field is preserved.

- [ ] **Step 7:** Verify

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run test -- src/admin/
```

Expected: all admin tests pass.

- [ ] **Step 8:** Commit

```bash
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "feat(admin): promote roles + aliases to top-level on agent_create/update; tighten agent_get description (KPR-141)"
```

---

### Task 5: agent-registry — soft-warn on empty roles

**Files:**
- Modify: `src/agents/agent-registry.ts`
- Modify: `src/agents/agent-registry.test.ts`

- [ ] **Step 1:** In `agent-registry.ts`, find the `load()` method (~line 58). After the existing per-agent load loop where each agent gets `log.info("Loaded agent", ...)` (~line 126), within the same loop body (right after the info log), add:

```typescript
if (!doc.roles || doc.roles.length === 0) {
  log.warn("Agent has no roles[] — set via admin agent_update or beekeeper tune-instance for proper team_lookup_agent payload", {
    id: agentConfig.id,
    name: agentConfig.name,
  });
}
```

Skip the warning for disabled agents (they're not active anyway). Place the warning inside the `if (!doc.disabled)` branch only.

- [ ] **Step 2:** Add a test in `agent-registry.test.ts` — assert warning fires for agent with `roles: []` and does not fire when `roles` is non-empty. Use the existing logger spy pattern (search for existing `log.warn` test cases for reference).

- [ ] **Step 3:** Verify

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run test -- src/agents/agent-registry.test.ts
```

Expected: pass.

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-registry.ts src/agents/agent-registry.test.ts
git commit -m "feat(agent-registry): warn on agent load when roles[] is empty (KPR-141)"
```

---

### Task 6: Update chief-of-staff seed

**Files:**
- Modify: `seeds/chief-of-staff/agent.yaml`

- [ ] **Step 1:** Add `roles` to the seed yaml. Insert after the `name:` line (~line 2):

```yaml
roles:
  - Chief of Staff
```

- [ ] **Step 2:** Verify

```bash
cd /Users/mokie/github/hive-KPR-141 && npx tsx -e 'import yaml from "yaml"; import fs from "fs"; const d = yaml.parse(fs.readFileSync("seeds/chief-of-staff/agent.yaml", "utf8")); console.log(JSON.stringify(d.roles));'
```

Expected: `["Chief of Staff"]`.

- [ ] **Step 3:** Commit

```bash
git add seeds/chief-of-staff/agent.yaml
git commit -m "feat(seeds): chief-of-staff seed sets roles=['Chief of Staff'] (KPR-141)"
```

---

### Task 7: Backfill migration script — dodi + keepur agents

**Files:**
- Create: `scripts/migrate-agents-add-roles.ts`
- Modify: `package.json`

- [ ] **Step 1:** Create `scripts/migrate-agents-add-roles.ts`:

```typescript
#!/usr/bin/env npx tsx
/**
 * One-time migration: backfill `roles: string[]` on agent_definitions (KPR-141).
 *
 * Operations (idempotent, safe to re-run):
 *   - For each agent in the appropriate ROLES_MAP (selected by --instance),
 *     set `roles` if currently empty/missing. Existing non-empty `roles` are
 *     left untouched.
 *
 * Usage:
 *   npm run migrate:agents:add-roles -- --instance dodi               # dry-run
 *   npm run migrate:agents:add-roles -- --instance dodi --apply       # commit
 *   npm run migrate:agents:add-roles -- --instance keepur --apply
 *
 * Env: MONGODB_URI (default mongodb://localhost:27017)
 *
 * If your instance isn't dodi or keepur, edit ROLES_MAP_<INSTANCE> in this
 * file before running, or use the admin MCP `agent_update` tool to set roles
 * one-by-one.
 */

import { MongoClient } from "mongodb";

const ROLES_MAP_DODI: Record<string, string[]> = {
  mokie: ["Chief of Staff"],
  jasper: ["VP Engineering"],
  colt: ["DevOps"],
  chloe: ["Product Manager"],
  river: ["Marketing Manager"],
  jessica: ["Customer Success"],
  milo: ["Sales Development Representative"],
  wyatt: ["Product Specialist"],
  sige: ["Production Support", "Bilingual liaison (Mandarin/English)"],
  rae: ["Receptionist"],
  nora: ["Operations & Purchasing"],
};

const ROLES_MAP_KEEPUR: Record<string, string[]> = {
  hermi: ["Chief of Staff"],
  alexandria: ["Engineering Lead"],
  samantha: ["Marketing Operations"],
  luna: ["Content Manager"],
};

const ROLES_MAPS: Record<string, Record<string, string[]>> = {
  dodi: ROLES_MAP_DODI,
  keepur: ROLES_MAP_KEEPUR,
};

interface AgentDoc {
  _id: string;
  name: string;
  roles?: string[];
  disabled?: boolean;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const instanceIdx = process.argv.indexOf("--instance");
  if (instanceIdx === -1 || !process.argv[instanceIdx + 1]) {
    console.error("Usage: npm run migrate:agents:add-roles -- --instance <id> [--apply]");
    process.exit(1);
  }
  const instance = process.argv[instanceIdx + 1];
  const map = ROLES_MAPS[instance];
  if (!map) {
    console.error(`Unknown instance "${instance}". Known: ${Object.keys(ROLES_MAPS).join(", ")}.`);
    console.error(`Edit scripts/migrate-agents-add-roles.ts to add a ROLES_MAP for this instance.`);
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = `hive_${instance}`;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const agents = db.collection<AgentDoc>("agent_definitions");

  const all = await agents.find({}).toArray();

  let willUpdate = 0;
  let alreadySet = 0;
  let unmapped = 0;
  const ops: Array<{ updateOne: { filter: { _id: string }; update: { $set: { roles: string[]; updatedAt: Date; updatedBy: string } } } }> = [];

  for (const a of all) {
    if (a.roles && a.roles.length > 0) {
      alreadySet++;
      continue;
    }
    const roles = map[a._id];
    if (!roles) {
      unmapped++;
      console.warn(`  unmapped: ${a._id} (${a.name}) — add to ROLES_MAP_${instance.toUpperCase()} or set via admin agent_update`);
      continue;
    }
    willUpdate++;
    ops.push({
      updateOne: {
        filter: { _id: a._id },
        update: {
          $set: {
            roles,
            updatedAt: new Date(),
            updatedBy: "migrate-agents-add-roles",
          },
        },
      },
    });
  }

  console.log(`Plan against ${dbName}.agent_definitions (total: ${all.length}):`);
  console.log(`  will update: ${willUpdate}`);
  console.log(`  already set: ${alreadySet}`);
  console.log(`  unmapped (skipped): ${unmapped}`);

  if (!apply) {
    console.log("\n(dry-run; pass --apply to commit)");
    await client.close();
    return;
  }

  if (ops.length > 0) {
    const r = await agents.bulkWrite(ops);
    console.log(`Updates: matched=${r.matchedCount} modified=${r.modifiedCount}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2:** Wire into `package.json`. In the `scripts` block, after `"migrate:contacts-categories": "..."`:

```json
"migrate:agents:add-roles": "npx tsx scripts/migrate-agents-add-roles.ts",
```

- [ ] **Step 3:** Verify (dry-run only — actual `--apply` runs happen in the post-merge runbook):

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run migrate:agents:add-roles -- --instance dodi
```

Expected: shows `will update: 11, already set: 0, unmapped: 0` (or similar — exact counts depend on current dodi state; **must not error**).

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run migrate:agents:add-roles -- --instance keepur
```

Expected: shows `will update: 4, already set: 0, unmapped: 0`.

- [ ] **Step 4:** Commit

```bash
git add scripts/migrate-agents-add-roles.ts package.json
git commit -m "feat(scripts): add migrate-agents-add-roles for dodi + keepur backfill (KPR-141)"
```

---

### Task 8: Final quality gate

- [ ] **Step 1:**

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run check
```

Expected: typecheck + lint + format + tests all green. If any pre-existing test (e.g. `model-router.test.ts`) requires env stubs to pass, prefix the env var as previously documented (`SLACK_APP_TOKEN=test`).

- [ ] **Step 2:** Manual smoke check — bundle and verify the published bundle still builds (catches MCP SDK shape mismatches that typecheck misses):

```bash
cd /Users/mokie/github/hive-KPR-141 && npm run check:bundle
```

Expected: green.

- [ ] **Step 3:** No commit — quality-gate is verification only.

---

## Post-Merge Runbook (executed by the operator after PR merges and v0.4.1 publishes)

These steps are NOT in the implementation plan — they happen at deploy time, not during the worktree session.

1. `npm run migrate:agents:add-roles -- --instance dodi --apply` (against the dodi instance's MongoDB)
2. `npm run migrate:agents:add-roles -- --instance keepur --apply`
3. `hive update` on dodi + keepur to land v0.4.1
4. Verify via `team_lookup_agent` from a non-CoS agent — e.g. ask Jasper "who's Sige?" and confirm the response includes role.
5. File the beekeeper follow-up ticket covering `tune-instance` enforcement (Phase 1 audit step that finds agents with empty `roles` and walks the operator through filling them) + `agent-builder` skill prompts for `roles` + `aliases` on creation. Title pattern: "KPR-141 follow-up: tune-instance + agent-builder roles enforcement (beekeeper)".

---

Plan saved to `docs/plans/2026-05-02-roles-aliases-on-agent-definitions.md`. Ready to execute?
