# KPR-381 — Agent Model Catalog (lookup + refresh tools) Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** A CoS agent with the `admin` core server can ask "what model ids are valid right now?" per provider — Gemini answered live from the vendor (header-auth, cached), Claude/Grok/Codex answered from a curated, versioned Mongo catalog it refreshes on demand — and the `model` field on `agent_create`/`agent_update` finally teaches the `<provider>/<model>[:effort]` syntax.

**Architecture:** Two new tools on the existing in-process `admin-mcp-server.ts` (`agent_model_catalog_list` read, `agent_model_catalog_refresh` write), backed by two new Mongo collections (`agent_model_catalog`, `agent_model_catalog_versions`) following the `agent_definitions`/`agent_definition_versions` versioned-document convention. The Gemini live lookup uses `x-goog-api-key` **header** auth (never a URL query param — credential-leak fix) with a module-level 10-minute TTL cache mirroring `team-cache.ts`'s `CacheSlice` shape. The refresh tool is a dumb write endpoint: validate shape, diff, upsert, append a version row — no vendor calls, no scraping.

**Tech Stack:** TypeScript (strict), Node 22+, Zod tool schemas via `@anthropic-ai/claude-agent-sdk` `tool()`, MongoDB driver, Vitest, global `fetch`.

**Spec:** `keepur/hive-docs` → `internal/specs/2026-08-23-agent-model-catalog-design.md` (approved, 2 review rounds clean). Normative for data model, tool signatures, failure modes, and the credential-safety rule.

**Decision register:** Epic KPR-380 predates the coherence-review decision register — its description carries no `## Decision Register — Canon` section. This is a pre-register epic; proceeding without one is expected and is **not** a blocker. Spec Key Points serve as the de facto decision record for this child.

**Baseline:** worktree `/Users/mokie/github/lane-kpr-381-mature`, branch `lane/kpr-381-mature-20260823` @ `fe39d60` (epic branch `kpr-380`). All line references verified against this baseline.

---

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/admin/model-catalog-cache.ts` (new), the two new tool handlers + the `.describe()` changes in `src/admin/admin-mcp-server.ts`
  - Reason: The list tool has 6 distinct spec'd failure modes (missing key, vendor fetch fail single-provider, vendor fetch fail all-4 partial, unseeded curated doc, empty entries, cache hit) and one security invariant (key never in URL, never in error text). The refresh tool owns the versioned-write contract. All are pure handler logic drivable via the existing `buildAdminTools` fake-Db test harness — no subprocess, no network.
  - Minimum assertions:
    - **Cache:** miss when empty; hit within TTL; miss after TTL expiry (fake timers); `invalidateGeminiModelCache()` clears.
    - **Refresh:** upserts `agent_model_catalog` with `provider`/`models`/`updatedAt`/`updatedBy`; appends one `agent_model_catalog_versions` row (snapshot + changeSummary + createdAt + updatedBy); diff summary text names added/removed ids and total count; `addedAt` preserved for retained ids and stamped `now` for new ids; duplicate ids in input rejected with `isError`; Zod schema's `provider` enum **rejects `"gemini"` at the schema level** (`safeParse` fails — no handler-level rejection exists to test).
    - **List:** curated read maps doc → entries with `source: "curated"` and `asOf` = `updatedAt` ISO; unseeded provider contributes zero array entries + one prose "not yet seeded" note; gemini success calls `fetch` with `x-goog-api-key` header and a URL containing **no** key; gemini entries filter out non-`generateContent` and image/video/audio/embedding families; second call within TTL performs **zero** additional fetches; missing key + `provider: "gemini"` → `isError` with the `hive credentials add GEMINI_API_KEY` message; vendor 500 + `provider: "gemini"` → `isError` with sanitized status-only message that does **not** contain the key or the request URL; vendor failure on the all-4 call → curated entries still returned + one gemini prose note, `isError` **absent** (partial results, never whole-call failure); network-level fetch rejection produces a fixed sanitized message (not `String(err)`).
    - **Describe fix:** `agent_create`'s `model` schema `.description` and `agent_update`'s `fields` `.description` both mention `agent_model_catalog_list` and the `<provider>/<model>[:effort]` syntax.

- Integration: `not-required` (see rationale)
  - Scope: n/a
  - Reason: Both tools are single-module handlers over a `Db` handle; the established repo pattern for this exact file (`admin-mcp-server.test.ts`, 900 lines) is fake-Db handler-level testing, which exercises the full tool surface including the Mongo write shapes. There is no cross-module boundary introduced (no dispatcher, no runner, no adapter changes).
  - Harness: `not-applicable`
  - Minimum assertions: n/a

- E2E: `not-required` (see rationale)
  - Scope: n/a
  - Reason: No automated E2E channel harness exists in this repo; the equivalent evidence is the rollout seeding step (Task 6) — three real `agent_model_catalog_refresh` calls + one `agent_model_catalog_list` on a live instance, which is precisely the production flow.
  - Harness: `not-applicable`
  - Minimum assertions: n/a

### Critical Flows

- CoS calls `agent_model_catalog_list` (no arg) on a seeded instance → JSON array with curated claude/grok/codex entries + live gemini entries, each with correct `source`/`asOf`.
- CoS calls `agent_model_catalog_list` while Gemini is down or unkeyed → the 3 curated providers still answer; one honest prose note explains the missing gemini leg; **no key material anywhere in the output**.
- CoS researches via WebSearch, calls `agent_model_catalog_refresh` with a full replacement list → doc upserted, version row appended, diff summary returned.
- Operator inspects `agent_model_catalog_versions` after a bad refresh → append-only audit trail has every snapshot.

### Regression Surface

- The 12 existing admin tools (`agent_list` … `memory_lifecycle_run_consolidation`) — the only shared code touched is `ensureIndexes()` (gains a second `createIndex`) and two `.describe()` strings; every existing test in `admin-mcp-server.test.ts` must stay green.
- The new `import { config } from "../config.js"` in `admin-mcp-server.ts` makes the test file transitively load `config.ts` → the test file **must** add a `vi.mock("../config.js", …)` (Task 2) or every existing admin test breaks on `required("SLACK_APP_TOKEN")`.
- `src/llm/catalog.ts` / `LLM_CATALOG` — untouched by design (separate sidecar system); verify no import creep.
- Bundle: `admin-mcp-server.ts` is bundled into `pkg/server.min.js`; `npm run bundle` must still pass (new code is plain TS + global fetch, no new externals).

### Commands

- Unit (fast loop): `npx vitest run src/admin/`
- Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle sanity (before PR): `npm run bundle`

### Harness Requirements

- Existing fake-Db harness in `src/admin/admin-mcp-server.test.ts` — extend `makeFakeDb()` with two catalog collections (Task 2).
- `vi.hoisted` + `vi.mock("../config.js", …)` for the config singleton (established pattern — see `src/agents/agent-manager.test.ts:54`).
- `vi.stubGlobal("fetch", …)` for the Gemini leg; `vi.useFakeTimers()` for TTL expiry; `invalidateGeminiModelCache()` in `beforeEach` (module-level cache persists across tests).
- No live network in any test.

### Non-Required Rationale

- Integration: no new module boundary — both tools live and die inside `buildAdminTools()` over the injected `Db`; the fake-Db handler tests ARE the boundary tests for this file per repo convention (KPR-122 port note at the top of the existing test file).
- E2E: no automated harness exists; live-instance seeding at rollout (Task 6, operator-run) is the production-path validation, matching how prior admin-tool additions (KPR-184, KPR-221, KPR-329) shipped.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify** (house rule) the credential-safety test: temporarily switch the fetch to `?key=` query-param auth and confirm the header-auth assertion fails before claiming it.

---

## File Structure

**Create**
- `src/admin/model-catalog-cache.ts` — module-level TTL cache for the Gemini live lookup (`CacheSlice` shape from `team-cache.ts`).
- `src/admin/model-catalog-cache.test.ts` — unit tests for the cache.

**Modify**
- `src/admin/admin-mcp-server.ts` — inline types, `fetchGeminiModels`, two new tools, extended `ensureIndexes`, two `.describe()` updates.
- `src/admin/admin-mcp-server.test.ts` — config mock, fake-Db extension, new describe blocks.
- `CLAUDE.md` — two new collections in the "MongoDB collections (engine-written)" list.

**Not touched (by design):** `src/llm/catalog.ts`, `src/config.ts` (gemini.apiKey already exists at `src/config.ts:376`), `AdminToolDeps` (no new constructor dependency).

---

### Task 1: Gemini TTL cache module

**Files:**
- Create: `src/admin/model-catalog-cache.ts`
- Create: `src/admin/model-catalog-cache.test.ts`

Why module-level, not closure-scoped: `buildAdminTools()` runs once per `AgentRunner` spawn, and post-KPR-220 every turn is a fresh spawn — a cache inside the builder closure would never survive a single turn. Module scope makes it a process-wide singleton, same lifetime as the engine's `TeamCache` instance.

- [ ] **Step 1:** Create `src/admin/model-catalog-cache.ts`:

```ts
/**
 * KPR-381: module-level TTL cache for the Gemini live model lookup.
 *
 * Mirrors src/team-roster/team-cache.ts's CacheSlice shape, but lives at
 * module scope rather than inside a class instance: buildAdminTools() runs
 * once per AgentRunner spawn (fresh instance per turn post-KPR-220), so a
 * closure-scoped cache would never get a hit across turns. Module scope
 * makes it a process-wide singleton.
 *
 * ~10 minutes: long enough to avoid redundant vendor calls within one
 * conversation, short enough that a same-session "refresh" mentally still
 * feels live (spec, Gemini live-lookup section). A stale-but-present slice
 * is never served past TTL — expiry is a hard miss, and a fetch failure
 * never falls back to the stale slice (honest-failure posture).
 */

interface CacheSlice<T> {
  data: T[] | null;
  loadedAt: number;
}

export const GEMINI_CACHE_TTL_MS = 10 * 60_000;

let slice: CacheSlice<unknown> = { data: null, loadedAt: 0 };

export function getCachedGeminiModels<T>(): T[] | null {
  if (slice.data && Date.now() - slice.loadedAt < GEMINI_CACHE_TTL_MS) {
    return slice.data as T[];
  }
  return null;
}

export function setCachedGeminiModels<T>(data: T[]): void {
  slice = { data, loadedAt: Date.now() };
}

/** Test hook + honest-failure reset. Clears the slice unconditionally. */
export function invalidateGeminiModelCache(): void {
  slice = { data: null, loadedAt: 0 };
}
```

- [ ] **Step 2:** Create `src/admin/model-catalog-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GEMINI_CACHE_TTL_MS,
  getCachedGeminiModels,
  setCachedGeminiModels,
  invalidateGeminiModelCache,
} from "./model-catalog-cache.js";

describe("model-catalog-cache", () => {
  beforeEach(() => {
    invalidateGeminiModelCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("misses when empty", () => {
    expect(getCachedGeminiModels()).toBeNull();
  });

  it("hits within TTL", () => {
    setCachedGeminiModels([{ id: "gemini-3.1-pro-preview" }]);
    vi.advanceTimersByTime(GEMINI_CACHE_TTL_MS - 1_000);
    expect(getCachedGeminiModels()).toEqual([{ id: "gemini-3.1-pro-preview" }]);
  });

  it("misses after TTL expiry — stale data is never served", () => {
    setCachedGeminiModels([{ id: "gemini-3.1-pro-preview" }]);
    vi.advanceTimersByTime(GEMINI_CACHE_TTL_MS + 1);
    expect(getCachedGeminiModels()).toBeNull();
  });

  it("invalidate clears an unexpired slice", () => {
    setCachedGeminiModels([{ id: "x" }]);
    invalidateGeminiModelCache();
    expect(getCachedGeminiModels()).toBeNull();
  });
});
```

- [ ] **Step 3 (verify):** `npx vitest run src/admin/model-catalog-cache.test.ts` — expect `4 passed`.
- [ ] **Step 4 (commit):** `git add src/admin/model-catalog-cache.ts src/admin/model-catalog-cache.test.ts && git commit -m "feat(admin): gemini model-lookup TTL cache module (KPR-381)"`

---

### Task 2: Inline types, collections, index, and `agent_model_catalog_refresh`

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (imports at :10-20; types after the `checkToolSearch` block ~:80; collections + `ensureIndexes` in `buildAdminTools` at :99-115; new tool appended after `list_archetypes` at :782)
- Modify: `src/admin/admin-mcp-server.test.ts` (config mock at top; `makeFakeDb` at :69-78; new describe block)

- [ ] **Step 1:** Add imports to `src/admin/admin-mcp-server.ts` (after the existing import block, :10-20):

```ts
import { createLogger } from "../logging/logger.js";
import { config as appConfig } from "../config.js";
import { getCachedGeminiModels, setCachedGeminiModels } from "./model-catalog-cache.js";
```

and below the imports:

```ts
const log = createLogger("admin-mcp");
```

(`config.gemini.apiKey` is a resolved module-level singleton — env→Keychain once at boot, `src/config.ts:375-379` — imported directly the same way `agent-manager.ts:15` does. No new `AdminToolDeps` field, per spec.)

- [ ] **Step 2:** Add inline types + constants after the `checkToolSearch` function (~line 80). Inline deliberately — nothing else in the codebase consumes these; revisit only if a second consumer shows up (spec, file-level change list):

```ts
// ---------------------------------------------------------------------------
// KPR-381: agent model catalog — curated model ids for claude/grok/codex
// (subscription-auth providers with no live model-list endpoint) + a live
// Gemini lookup. Types are inline on purpose: no second consumer exists.
// NOT related to src/llm/catalog.ts (LLM_CATALOG) — that is the sidecar
// catalog for 4 fixed internal engine tasks and is untouched here.
// ---------------------------------------------------------------------------

type CuratedCatalogProvider = "claude" | "grok" | "codex";

interface AgentModelCatalogEntry {
  id: string; // e.g. "grok-4.6"
  displayName: string; // e.g. "Grok 4.6"
  notes?: string; // free text, e.g. "subscription default"
  addedAt: Date;
}

interface AgentModelCatalogDoc {
  _id: CuratedCatalogProvider;
  provider: CuratedCatalogProvider;
  models: AgentModelCatalogEntry[];
  updatedAt: Date;
  updatedBy: string; // agentId that called the refresh tool
}

/** Append-only audit trail — mirrors AgentDefinitionVersion's shape. */
interface AgentModelCatalogVersion {
  provider: CuratedCatalogProvider;
  snapshot: AgentModelCatalogEntry[];
  changeSummary: string;
  createdAt: Date;
  updatedBy: string;
}

/** One row in agent_model_catalog_list's entries JSON. */
interface CatalogListEntry {
  provider: CuratedCatalogProvider | "gemini";
  id: string;
  displayName: string;
  notes?: string;
  source: "live" | "curated";
  asOf: string; // ISO — fetch time for gemini, updatedAt for curated
}

const CURATED_CATALOG_PROVIDERS: readonly CuratedCatalogProvider[] = ["claude", "grok", "codex"];
```

- [ ] **Step 3:** In `buildAdminTools()`, add the two collection handles next to the existing ones (:101-102):

```ts
  const catalogDocs = db.collection<AgentModelCatalogDoc>("agent_model_catalog");
  const catalogVersions = db.collection<AgentModelCatalogVersion>("agent_model_catalog_versions");
```

and extend `ensureIndexes()` (:107-115) to also create the versions index lazily — same pattern, same swallow-on-error:

```ts
  function ensureIndexes(): Promise<void> {
    if (!indexInit) {
      indexInit = Promise.all([
        agentVersions.createIndex({ agentId: 1, createdAt: -1 }),
        catalogVersions.createIndex({ provider: 1, createdAt: -1 }),
      ])
        .then(() => undefined)
        .catch(() => undefined);
    }
    return indexInit;
  }
```

- [ ] **Step 4:** Add the `agent_model_catalog_refresh` tool to the returned array, after `list_archetypes` (:782) and before `verify_path`. Note the Zod enum contains only the 3 curated providers — **gemini is excluded at the schema boundary, no handler-level rejection exists or is needed** (spec):

```ts
    tool(
      "agent_model_catalog_refresh",
      "Replace the curated model list for one provider (claude/grok/codex) after researching current vendor reality with your own WebSearch/WebFetch. Pass the FULL replacement list, not a delta. Upserts agent_model_catalog, appends a version-history row, returns a diff summary. Performs no vendor calls itself. Gemini is always resolved live and cannot be refreshed.",
      {
        provider: z.enum(["claude", "grok", "codex"]).describe("Gemini is always live — nothing to refresh."),
        models: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .describe("Model id as the provider route accepts it (e.g. 'grok-4.6', 'gpt-5.5', 'claude-opus-5')."),
              displayName: z.string().min(1),
              notes: z.string().optional().describe("Free text, e.g. 'subscription default', 'reasoning tier'."),
            }),
          )
          .min(1)
          .describe("The full replacement list for this provider."),
        changeSummary: z
          .string()
          .optional()
          .describe(
            "What changed and why, e.g. 'Anthropic shipped Opus 6, added; removed Opus 4.7 (deprecated per vendor changelog)'.",
          ),
      },
      async ({ provider, models, changeSummary }) => {
        try {
          await ensureIndexes();

          const ids = models.map((m) => m.id);
          if (new Set(ids).size !== ids.length) {
            return {
              isError: true,
              content: [{ type: "text", text: `Duplicate model ids in input: ${ids.join(", ")}.` }],
            };
          }

          const now = new Date();
          const current = await catalogDocs.findOne({ _id: provider as never });
          const prevById = new Map((current?.models ?? []).map((m) => [m.id, m]));
          const newIds = new Set(ids);
          const added = ids.filter((id) => !prevById.has(id));
          const removed = [...prevById.keys()].filter((id) => !newIds.has(id));

          const nextModels: AgentModelCatalogEntry[] = models.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            ...(m.notes ? { notes: m.notes } : {}),
            // Preserve addedAt for retained ids; stamp now for new ones.
            addedAt: prevById.get(m.id)?.addedAt ?? now,
          }));

          await catalogDocs.updateOne(
            { _id: provider as never },
            { $set: { provider, models: nextModels, updatedAt: now, updatedBy: agentId } },
            { upsert: true },
          );

          const fmt = (xs: string[]) => (xs.length > 0 ? ` (${xs.join(", ")})` : "");
          const diffText = `+${added.length}${fmt(added)}, -${removed.length}${fmt(removed)}`;

          await catalogVersions.insertOne({
            provider,
            snapshot: nextModels,
            changeSummary: changeSummary ?? diffText,
            createdAt: now,
            updatedBy: agentId,
          });

          return {
            content: [
              {
                type: "text",
                text: `${provider} catalog updated: ${diffText}. ${nextModels.length} models total.${
                  changeSummary ? ` — ${changeSummary}` : ""
                }`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `agent_model_catalog_refresh error: ${String(err)}` }],
          };
        }
      },
    ),
```

- [ ] **Step 5:** Update `src/admin/admin-mcp-server.test.ts` — **required in this task, not later**: the new `config.js` import breaks every existing admin test without a mock. At the top of the file, immediately after the existing `vi.mock("@anthropic-ai/claude-agent-sdk", …)` block (:11-19), add:

```ts
// KPR-381: admin-mcp-server now imports the config singleton for the gemini
// key. Mock it — the real config.ts throws on missing SLACK_* env at import.
const mockConfig = vi.hoisted(() => ({ gemini: { apiKey: "test-gemini-key" } }));
vi.mock("../config.js", () => ({ config: mockConfig }));
```

Then extend the fake Db (:21-78). Add the stores next to the existing ones:

```ts
let catalogDocsStore = new Map<string, any>();
let catalogVersionsStore: any[] = [];

function makeCatalogDocsCollection(): any {
  return {
    findOne: vi.fn(async (filter: any) => catalogDocsStore.get(filter?._id) ?? null),
    updateOne: vi.fn(async (filter: any, update: any, opts: any) => {
      const id = filter?._id;
      const existing = catalogDocsStore.get(id);
      if (existing && update.$set) Object.assign(existing, update.$set);
      else if (opts?.upsert) catalogDocsStore.set(id, { _id: id, ...update.$set });
      return { modifiedCount: existing ? 1 : 0 };
    }),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeCatalogVersionsCollection(): any {
  return {
    insertOne: vi.fn(async (doc: any) => {
      catalogVersionsStore.push({ ...doc });
      return { insertedId: "cv" };
    }),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}
```

and reroute `makeFakeDb()` (:69-78) by name:

```ts
function makeFakeDb(): any {
  const defs = makeAgentDefsCollection();
  const versions = makeAgentVersionsCollection();
  const catalogDocs = makeCatalogDocsCollection();
  const catalogVersions = makeCatalogVersionsCollection();
  return {
    collection: (name: string) => {
      if (name === "agent_definitions") return defs;
      if (name === "agent_model_catalog") return catalogDocs;
      if (name === "agent_model_catalog_versions") return catalogVersions;
      return versions;
    },
  };
}
```

- [ ] **Step 6:** Add the refresh describe block at the end of the test file:

```ts
describe("admin-mcp-server — agent_model_catalog_refresh (KPR-381)", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
    catalogDocsStore = new Map();
    catalogVersionsStore = [];
    mockConfig.gemini.apiKey = "test-gemini-key";
  });

  it("upserts the catalog doc and appends a version row", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const result = await handler({
      provider: "grok",
      models: [
        { id: "grok-4.6", displayName: "Grok 4.6", notes: "subscription default" },
        { id: "grok-4.5", displayName: "Grok 4.5" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/grok catalog updated: \+2 \(grok-4\.6, grok-4\.5\), -0\. 2 models total\./);

    const doc = catalogDocsStore.get("grok");
    expect(doc.provider).toBe("grok");
    expect(doc.models).toHaveLength(2);
    expect(doc.models[0].addedAt).toBeInstanceOf(Date);
    expect(doc.updatedBy).toBe("admin");
    expect(doc.updatedAt).toBeInstanceOf(Date);

    expect(catalogVersionsStore).toHaveLength(1);
    expect(catalogVersionsStore[0].provider).toBe("grok");
    expect(catalogVersionsStore[0].snapshot).toHaveLength(2);
    expect(catalogVersionsStore[0].changeSummary).toMatch(/\+2/);
    expect(catalogVersionsStore[0].updatedBy).toBe("admin");
  });

  it("diffs against the current doc and preserves addedAt for retained ids", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const oldDate = new Date("2026-01-01T00:00:00Z");
    catalogDocsStore.set("claude", {
      _id: "claude",
      provider: "claude",
      models: [
        { id: "claude-opus-5", displayName: "Opus 5", addedAt: oldDate },
        { id: "claude-opus-4-7", displayName: "Opus 4.7", addedAt: oldDate },
      ],
      updatedAt: oldDate,
      updatedBy: "seed",
    });

    const result = await handler({
      provider: "claude",
      models: [
        { id: "claude-opus-5", displayName: "Opus 5" },
        { id: "claude-opus-6", displayName: "Opus 6" },
      ],
      changeSummary: "Opus 6 shipped; 4.7 deprecated",
    });
    expect(result.content[0].text).toMatch(/\+1 \(claude-opus-6\), -1 \(claude-opus-4-7\)\. 2 models total/);
    expect(result.content[0].text).toMatch(/Opus 6 shipped/);

    const doc = catalogDocsStore.get("claude");
    const retained = doc.models.find((m: any) => m.id === "claude-opus-5");
    const fresh = doc.models.find((m: any) => m.id === "claude-opus-6");
    expect(retained.addedAt).toEqual(oldDate);
    expect(fresh.addedAt.getTime()).toBeGreaterThan(oldDate.getTime());
    expect(catalogVersionsStore[0].changeSummary).toBe("Opus 6 shipped; 4.7 deprecated");
  });

  it("rejects duplicate model ids", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const result = await handler({
      provider: "codex",
      models: [
        { id: "gpt-5.5", displayName: "GPT-5.5" },
        { id: "gpt-5.5", displayName: "GPT-5.5 again" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Duplicate model ids/);
    expect(catalogDocsStore.size).toBe(0);
    expect(catalogVersionsStore).toHaveLength(0);
  });

  it("excludes gemini at the Zod schema level — no handler rejection needed", () => {
    const tools = makeTools();
    const t = tools.find((x: any) => x.name === "agent_model_catalog_refresh")!;
    const providerSchema = (t.inputSchema as any).provider;
    expect(providerSchema.safeParse("gemini").success).toBe(false);
    expect(providerSchema.safeParse("claude").success).toBe(true);
    expect(providerSchema.safeParse("grok").success).toBe(true);
    expect(providerSchema.safeParse("codex").success).toBe(true);
  });
});
```

- [ ] **Step 7 (verify):** `npx vitest run src/admin/admin-mcp-server.test.ts` — expect all pre-existing tests **and** the 4 new ones green (no `SLACK_*` env needed thanks to the config mock). Then `npm run typecheck` — expect clean exit.
- [ ] **Step 8 (commit):** `git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts && git commit -m "feat(admin): agent_model_catalog_refresh tool + versioned catalog collections (KPR-381)"`

---

### Task 3: `agent_model_catalog_list` (curated read + Gemini live lookup)

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (module-level fetch helper near the types; tool inserted directly before `agent_model_catalog_refresh`)
- Modify: `src/admin/admin-mcp-server.test.ts` (new describe block)

**Credential-safety rule (spec, non-negotiable):** the key travels ONLY as an `x-goog-api-key` header — never a URL query param — and the gemini branch never returns `String(err)` (an undici error can embed the request URL). Failures produce a fixed sanitized message (HTTP status + fixed text at most).

- [ ] **Step 1:** Add the Gemini lookup helper at module level (below the type block from Task 2):

```ts
/**
 * KPR-381: live Gemini model lookup. Header auth ONLY (x-goog-api-key) — a
 * query-param key would leak into agent-visible tool output via any error
 * message that echoes the request URL. Every failure path throws a
 * GeminiLookupError whose message is sanitized by construction (HTTP status
 * + fixed text; never the raw error object, never the URL). pageSize=1000
 * avoids nextPageToken pagination (vendor max; full list fits one page).
 */
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

/**
 * Best-effort exclusion of non-chat model families (image/video/audio/TTS/
 * embedding). The vendor field doesn't cleanly distinguish "works on the
 * Interactions adapter" — same caveat KPR-352 flagged — so this filter is
 * documented best-effort, not a hard guarantee.
 */
const GEMINI_NON_CHAT_RE = /(embed|imagen|image|veo|video|lyria|audio|tts)/i;

interface GeminiApiModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

class GeminiLookupError extends Error {}

async function fetchGeminiModels(apiKey: string): Promise<CatalogListEntry[]> {
  const cached = getCachedGeminiModels<CatalogListEntry>();
  if (cached) return cached;

  let res: Response;
  try {
    res = await fetch(GEMINI_MODELS_URL, { headers: { "x-goog-api-key": apiKey } });
  } catch {
    // Deliberately NOT String(err): transport errors can embed request detail.
    throw new GeminiLookupError(
      "Gemini model lookup failed: network error reaching generativelanguage.googleapis.com.",
    );
  }
  if (!res.ok) {
    throw new GeminiLookupError(`Gemini model lookup failed: vendor returned HTTP ${res.status}.`);
  }
  let body: { models?: GeminiApiModel[] };
  try {
    body = (await res.json()) as { models?: GeminiApiModel[] };
  } catch {
    throw new GeminiLookupError("Gemini model lookup failed: unparseable vendor response.");
  }

  const asOf = new Date().toISOString();
  const entries: CatalogListEntry[] = (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .filter((m) => !GEMINI_NON_CHAT_RE.test(`${m.name ?? ""} ${m.displayName ?? ""}`))
    .map((m) => {
      const id = (m.name ?? "").replace(/^models\//, "");
      return { provider: "gemini" as const, id, displayName: m.displayName ?? id, source: "live" as const, asOf };
    })
    .filter((e) => e.id.length > 0);

  setCachedGeminiModels(entries);
  return entries;
}

const GEMINI_KEY_MISSING_MSG =
  "Gemini API key not configured on this instance (GEMINI_API_KEY) — run `hive credentials add GEMINI_API_KEY`, " +
  "then restart the hive service (gemini key resolution happens once at boot; see docs/providers.md).";
```

- [ ] **Step 2:** Add the list tool to the returned array, directly before `agent_model_catalog_refresh`:

```ts
    tool(
      "agent_model_catalog_list",
      "List valid LLM model ids per provider for agent `model` assignment. Gemini is resolved live from the vendor (cached ~10 min); claude/grok/codex come from the curated catalog (maintained via agent_model_catalog_refresh). Use before setting `model` on agent_create/agent_update. Returns a JSON entries array plus prose notes for any provider leg that is unseeded or unavailable.",
      {
        provider: z.enum(["claude", "grok", "codex", "gemini"]).optional().describe("Omit to list all 4 providers."),
      },
      async ({ provider }) => {
        try {
          await ensureIndexes();
          const wantCurated = provider
            ? CURATED_CATALOG_PROVIDERS.filter((p) => p === provider)
            : [...CURATED_CATALOG_PROVIDERS];
          const wantGemini = provider === undefined || provider === "gemini";

          const entries: CatalogListEntry[] = [];
          const notes: string[] = [];

          for (const p of wantCurated) {
            const doc = await catalogDocs.findOne({ _id: p as never });
            if (!doc || (doc.models ?? []).length === 0) {
              notes.push(`${p}: not yet seeded — call agent_model_catalog_refresh first.`);
              continue;
            }
            const asOf = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt);
            for (const m of doc.models) {
              entries.push({
                provider: p,
                id: m.id,
                displayName: m.displayName,
                ...(m.notes ? { notes: m.notes } : {}),
                source: "curated",
                asOf,
              });
            }
          }

          if (wantGemini) {
            const key = appConfig.gemini.apiKey;
            if (!key) {
              // Only the gemini-only call hard-errors; the all-4 call
              // degrades to partial results + a prose note (spec).
              if (provider === "gemini") {
                return { isError: true, content: [{ type: "text", text: GEMINI_KEY_MISSING_MSG }] };
              }
              notes.push(`gemini: ${GEMINI_KEY_MISSING_MSG}`);
            } else {
              try {
                entries.push(...(await fetchGeminiModels(key)));
              } catch (err) {
                // Sanitized by construction — GeminiLookupError messages
                // carry status + fixed text only. No stale-cache fallback:
                // masking a vendor failure as fresh data is worse than an
                // honest error (spec; matches breaker fast-fail posture).
                const msg = err instanceof GeminiLookupError ? err.message : "Gemini model lookup failed.";
                log.warn(`agent_model_catalog_list gemini leg failed: ${msg}`);
                if (provider === "gemini") {
                  return { isError: true, content: [{ type: "text", text: msg }] };
                }
                notes.push(`gemini: ${msg}`);
              }
            }
          }

          return {
            content: [
              { type: "text", text: JSON.stringify(entries, null, 2) },
              ...notes.map((n) => ({ type: "text" as const, text: n })),
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `agent_model_catalog_list error: ${String(err)}` }],
          };
        }
      },
    ),
```

(The outer `String(err)` catch is the file's standard pattern and is safe here: the gemini branch can never throw past its inner catch, so no error object that touched the request can reach it.)

- [ ] **Step 3:** Add the list-tool describe block to `admin-mcp-server.test.ts`. Requires the cache-reset import at the top of the file:

```ts
import { invalidateGeminiModelCache } from "./model-catalog-cache.js";
```

```ts
describe("admin-mcp-server — agent_model_catalog_list (KPR-381)", () => {
  const geminiOkResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      models: [
        {
          name: "models/gemini-3.1-pro-preview",
          displayName: "Gemini 3.1 Pro Preview",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        {
          name: "models/gemini-3.1-flash-image-preview",
          displayName: "Nano Banana 2",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/text-embedding-005",
          displayName: "Text Embedding 005",
          supportedGenerationMethods: ["embedContent"],
        },
        {
          name: "models/veo-3.1-generate-preview",
          displayName: "Veo 3.1",
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    }),
  };

  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
    catalogDocsStore = new Map();
    catalogVersionsStore = [];
    invalidateGeminiModelCache();
    mockConfig.gemini.apiKey = "test-gemini-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedGrok() {
    catalogDocsStore.set("grok", {
      _id: "grok",
      provider: "grok",
      models: [
        { id: "grok-4.6", displayName: "Grok 4.6", notes: "subscription default", addedAt: new Date() },
        { id: "grok-4.5", displayName: "Grok 4.5", addedAt: new Date() },
      ],
      updatedAt: new Date("2026-08-23T00:00:00Z"),
      updatedBy: "hermi",
    });
  }

  it("returns curated entries with source/asOf for a seeded provider", async () => {
    seedGrok();
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "grok" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      {
        provider: "grok",
        id: "grok-4.6",
        displayName: "Grok 4.6",
        notes: "subscription default",
        source: "curated",
        asOf: "2026-08-23T00:00:00.000Z",
      },
      { provider: "grok", id: "grok-4.5", displayName: "Grok 4.5", source: "curated", asOf: "2026-08-23T00:00:00.000Z" },
    ]);
  });

  it("unseeded curated provider → empty entries array + prose note, not an error", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "codex" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    expect(result.content[1].text).toMatch(/codex: not yet seeded — call agent_model_catalog_refresh first/);
  });

  it("gemini live lookup uses x-goog-api-key HEADER auth — key never in the URL", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers["x-goog-api-key"]).toBe("test-gemini-key");
    expect(url).not.toContain("test-gemini-key");
    expect(url).not.toContain("key=");

    const parsed = JSON.parse(result.content[0].text);
    // Filtered: embedding (no generateContent), image + veo (family regex).
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      provider: "gemini",
      id: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro Preview",
      source: "live",
    });
    expect(typeof parsed[0].asOf).toBe("string");
  });

  it("second call within TTL serves the cache — zero extra fetches", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    await handler({ provider: "gemini" });
    await handler({ provider: "gemini" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("missing gemini key + provider=gemini → isError with credentials-add remediation", async () => {
    mockConfig.gemini.apiKey = "";
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/hive credentials add GEMINI_API_KEY/);
  });

  it("vendor 500 + provider=gemini → sanitized status-only error, no key, no URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Gemini model lookup failed: vendor returned HTTP 500.");
    expect(result.content[0].text).not.toContain("test-gemini-key");
    expect(result.content[0].text).not.toContain("generativelanguage");
  });

  it("network-level rejection → fixed sanitized message, never String(err)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED https://generativelanguage.googleapis.com/v1beta/models?leak=1");
      }),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/network error/);
    expect(result.content[0].text).not.toContain("leak=1");
  });

  it("all-4 listing with a failed gemini leg → partial results + prose note, NOT isError", async () => {
    seedGrok();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.every((e: any) => e.provider !== "gemini")).toBe(true);
    expect(parsed.filter((e: any) => e.provider === "grok")).toHaveLength(2);
    const noteTexts = result.content.slice(1).map((c: any) => c.text).join("\n");
    expect(noteTexts).toMatch(/claude: not yet seeded/);
    expect(noteTexts).toMatch(/codex: not yet seeded/);
    expect(noteTexts).toMatch(/gemini: Gemini model lookup failed: vendor returned HTTP 429\./);
  });

  it("all-4 listing with a missing gemini key → partial results + prose note, NOT isError", async () => {
    seedGrok();
    mockConfig.gemini.apiKey = "";
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const noteTexts = result.content.slice(1).map((c: any) => c.text).join("\n");
    expect(noteTexts).toMatch(/gemini: Gemini API key not configured/);
  });
});
```

(Add `afterEach` to the vitest import at :1 if not already imported.)

- [ ] **Step 4 (verify):** `npx vitest run src/admin/` — expect all admin tests green (existing + Task 2's 4 + these 9 + cache's 4). Then `npm run typecheck` — clean.
- [ ] **Step 5 (negative-verify the credential fix):** temporarily change `GEMINI_MODELS_URL` fetch to append `&key=${apiKey}` via a query param and drop the header — confirm the header-auth test **fails** — then revert. This proves the test guards the leak vector.
- [ ] **Step 6 (commit):** `git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts && git commit -m "feat(admin): agent_model_catalog_list — curated read + header-auth gemini live lookup (KPR-381)"`

---

### Task 4: `model` field discoverability fix

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (`agent_create` model describe :240; `agent_update` fields describe :412-415)
- Modify: `src/admin/admin-mcp-server.test.ts` (2 assertions)

- [ ] **Step 1:** Replace the `model` field's `.describe()` in `agent_create` (:240):

```ts
        model: z
          .string()
          .describe(
            "Model to use. Bare id (e.g. 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5') routes to Claude. " +
              "Prefix <provider>/<model>[:effort] routes elsewhere — e.g. 'codex/gpt-5.5:medium', " +
              "'gemini/gemini-3.1-pro-preview', 'grok/grok-4.6'. Call agent_model_catalog_list first to check " +
              "what's currently valid per provider; see docs/providers.md for full capability parity.",
          ),
```

- [ ] **Step 2:** Replace `agent_update`'s `fields` `.describe()` (:412-415):

```ts
        fields: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Additional fields (channels, schedule, autonomy, archetypeConfig, budgetUsd, model, etc.). " +
              "For `model`: bare id routes to Claude; <provider>/<model>[:effort] routes elsewhere " +
              "(e.g. 'codex/gpt-5.5:medium', 'grok/grok-4.6') — call agent_model_catalog_list to check valid ids per provider.",
          ),
```

- [ ] **Step 3:** Add the describe-metadata tests to the test file:

```ts
describe("admin-mcp-server — model field discoverability (KPR-381)", () => {
  it("agent_create's model describe teaches provider-prefix syntax and points at the lookup tool", () => {
    const tools = makeTools();
    const t = tools.find((x: any) => x.name === "agent_create")!;
    const desc = (t.inputSchema as any).model.description as string;
    expect(desc).toContain("<provider>/<model>[:effort]");
    expect(desc).toContain("agent_model_catalog_list");
    expect(desc).toContain("claude-haiku-4-5");
  });

  it("agent_update's fields describe covers the model syntax and the lookup tool", () => {
    const tools = makeTools();
    const t = tools.find((x: any) => x.name === "agent_update")!;
    const desc = (t.inputSchema as any).fields.description as string;
    expect(desc).toContain("<provider>/<model>[:effort]");
    expect(desc).toContain("agent_model_catalog_list");
  });
});
```

- [ ] **Step 4 (verify):** `npx vitest run src/admin/admin-mcp-server.test.ts` — all green.
- [ ] **Step 5 (commit):** `git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts && git commit -m "docs(admin): teach provider-prefix model syntax in agent_create/agent_update describes (KPR-381)"`

---

### Task 5: CLAUDE.md collections list

**Files:**
- Modify: `CLAUDE.md` (the "MongoDB collections (engine-written)" bullet, line ~268)

- [ ] **Step 1:** In the collections bullet, insert after `agent_definition_versions`:

```
`agent_model_catalog` + `agent_model_catalog_versions` (agent-facing model-id catalog KPR-381 — one curated doc per subscription-auth provider claude/grok/codex + append-only refresh audit trail; gemini is never stored, always resolved live via `agent_model_catalog_list`),
```

so the list begins: `` `agent_definitions`, `agent_definition_versions`, `agent_model_catalog` + `agent_model_catalog_versions` (…), `sessions` … ``

- [ ] **Step 2 (verify):** `grep -c "agent_model_catalog" CLAUDE.md` — expect `1` (single bullet mention covering both).
- [ ] **Step 3 (commit):** `git add CLAUDE.md && git commit -m "docs: add agent_model_catalog collections to CLAUDE.md (KPR-381)"`

---

### Task 6: Full gate + rollout seeding (operational, post-merge)

**Files:** none (verification + operational runbook)

- [ ] **Step 1 (full gate):**

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck clean, lint clean, prettier clean, all vitest suites pass. If prettier flags the new/edited files, run `npm run format` and amend.

- [ ] **Step 2 (bundle sanity):** `npm run bundle` — expect a fresh `pkg/server.min.js` with exit 0 (the new code uses only global fetch + existing deps; no new externals).

- [ ] **Step 3 (rollout seeding — after merge + release, per instance, NOT a migration script):** one `agent_model_catalog_refresh` call per curated provider, executed conversationally by the CoS agent (or via a direct tool call). Seed values per spec — these reflect verified production reality, **not** stale code defaults:
  - **codex:** `gpt-5.5` ("GPT-5.5") — confirmed running on `luna` (keepur). Deliberately NOT `gpt-5.4-mini` (the stale `DEFAULT_CODEX_MODEL` fallback).
  - **grok:** `grok-4.6` ("Grok 4.6", notes: "subscription default"), `grok-4.5` ("Grok 4.5") — the exact two ids subscription auth exposes.
  - **claude:** `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` (must be included — production Haiku-tier agents run it), plus older assignable ids (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-opus-4-8`) as a reviewed judgment call at seed time.
  - Verify with one `agent_model_catalog_list` (no arg): all four providers contribute entries, gemini rows show `source: "live"`.

- [ ] **Step 4 (commit if formatting changed anything):** standard `git add -A && git commit -m "chore: format (KPR-381)"` only if Step 1 required it.

---

## Assumptions / open judgment calls (each deliberate, spec-compatible)

1. `pageSize=1000` (vendor max) on the Gemini list avoids `nextPageToken` pagination — the full model list fits one page today; a non-secret query param is fine (only the key is banned from the URL).
2. `addedAt` semantics on refresh: preserved for retained ids, stamped `now` for new ids (spec defines the field but not carry-over; preservation is the only reading that makes the field meaningful).
3. Duplicate-id rejection in `refresh` is a small defensive addition beyond the spec's minimum ("validate shape") — cheap, prevents a nonsense doc.
4. The cache module is a separate file (`src/admin/model-catalog-cache.ts`) rather than inline — spec allows either; a module is required anyway for cross-spawn lifetime and gives tests a clean reset hook.
5. Tool ordering in the array: list before refresh, both between `list_archetypes` and `verify_path`.
