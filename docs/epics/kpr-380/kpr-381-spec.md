# KPR-381 — Agent model catalog (lookup + refresh tools)

**Ticket:** KPR-381 (single child of epic KPR-380).
**Consumers of this spec:** the `write-plan` worker and the implementing lane session; mirrored here (from `keepur/hive-docs` → `internal/specs/2026-08-23-agent-model-catalog-design.md`) per the epic-workflow docs convention — public epic directories carry their children's specs and plans.
**Repo baseline:** `kpr-380` @ `fe39d60` (= `main` @ `fe39d60`).
**Review status:** approved, 2 rounds clean by spec-reviewer (round 1 caught a real credential-leak risk — the Gemini API key was originally going in a URL query param; fixed to `x-goog-api-key` header auth before any code was written. Round 2 approved clean).

---

# Agent model catalog — design

## TL;DR

Chief-of-Staff agents (Mokie/Hermi) currently have no reliable way to discover valid LLM model ids across hive's 4 US-frontier providers (Claude, Grok, Codex/GPT, Gemini) when an operator asks for something like "the latest Grok" or "Gemini Pro, latest" — the admin tool's `model` field is a bare string with only Claude examples, and 3 of 4 providers run on subscription auth with no live vendor model-list endpoint to query. This spec adds two new tools on the existing `admin-mcp-server.ts` — `agent_model_catalog_list` (read) and `agent_model_catalog_refresh` (write) — backed by two new Mongo collections (`agent_model_catalog`, `agent_model_catalog_versions`), plus a small fix to the `model` field's own tool description. Gemini gets a genuine live vendor lookup (it's the only provider with an API key); Claude/Grok/Codex get a curated, versioned table that CoS agents refresh on demand using their own existing WebSearch/WebFetch tools — no scheduled cron, no server-side scraping logic.

## Key Points

- **Scope: 4 providers only** — `claude`, `grok`, `codex`, `gemini`. Kimi/Deepseek explicitly out of scope for this round (operator doesn't use them for agent assignment today).
- **Split mechanics by auth mode, not by symmetry.** Only Gemini has an API key (`GEMINI_API_KEY`), so only Gemini gets a true live lookup at call time. Claude, Grok, and Codex all run on subscription OAuth with no discoverable model-list surface — those three are a curated, versioned Mongo table instead.
- **Refresh is on-demand, not scheduled.** No cron. A CoS agent calls `agent_model_catalog_refresh` after doing its own web research (existing WebSearch/WebFetch tools — no new fetching/scraping logic is built into the tool itself). This keeps the human-in-the-loop moment intact: the operator sees the research happen conversationally before anything is written.
- **`agent_model_catalog_refresh` is a dumb write endpoint** — validate shape, diff against the current doc, write, append a version-history row, return a change summary. It does not itself call any vendor API or fetch any URL. This was a deliberate rejection of an alternative (tool-side scraping) that would duplicate existing agent tooling and remove the review moment.
- **Naming disambiguates from the existing sidecar catalog.** `src/llm/catalog.ts` / `LLM_CATALOG` is a separate, pre-existing thing scoped to 4 fixed *internal* engine tasks (router classifier, meeting classifier, memory, vision) — it is not touched by this spec and this feature does not replace it. The new collections/tools are named `agent_model_catalog*` specifically to avoid confusion with that catalog.
- **No write-time validation/blocking on `agent_create`/`agent_update`.** This is a lookup aid, not a gate — an operator/agent can still set any `model` string, including off-catalog ones (unknown providers still fall back to Claude per existing `resolveProviderModel` behavior). The existing "vendor call 400s if the id is wrong" honesty pattern remains the real enforcement.
- **Bundled, not follow-up:** the `model` field's Zod `.describe()` on `agent_create`/`agent_update` gets expanded to mention the `<provider>/<model>[:effort]` syntax and point at `agent_model_catalog_list`. This is the original discoverability gap that motivated the whole feature and is small enough to ship in the same change.
- ⚠ **Seed data at ship time must reflect actual production reality, not stale code defaults.** E.g. Codex should seed with `gpt-5.5` (confirmed running today on the `luna` agent in the keepur instance) — not `gpt-5.4-mini`, which is the `DEFAULT_CODEX_MODEL`/`CODEX_AGENT_MODEL` fallback constant and is already behind what's actually deployed.
- ⚠ **Gemini's live lookup needs a short in-memory cache** (reusing the `team-cache.ts` `CacheSlice`/TTL pattern) to avoid a redundant vendor call on every single `agent_model_catalog_list` invocation within one conversation.
- **Access control**: no new `coreServers` flag. These are two more tools on the existing in-process `admin-mcp-server.ts` — any agent that already has the `admin` core server (Mokie, Hermi) gets them automatically.

---

## Problem

Setting an agent's `model` field today (`admin_agent_create`/`admin_agent_update`) is a bare string with zero discoverability:

```ts
model: z.string().describe("Model to use (e.g. 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5')"),
```

(`src/admin/admin-mcp-server.ts:240`)

This teaches nothing about the `<provider>/<model>[:effort]` prefix syntax hive's own `resolveProviderModel` supports (`src/agents/agent-manager.ts:179-316`), and there is no tool anywhere that tells a CoS agent what model ids are actually valid right now for a given provider. `docs/providers.md` documents capability *parity* per provider/lane in detail, but deliberately never enumerates concrete model ids (that's not its job, and it isn't linked from any agent-facing surface anyway).

The practical failure mode: an operator says "put this new agent on the latest Grok" and the CoS agent has no principled way to answer beyond guessing a plausible-looking string and finding out it's wrong only when a real turn 400s in production. Verified during this design's brainstorm session by manually curling Gemini's live `/v1beta/models` endpoint to confirm `gemini-3.1-pro-preview` is real — that's the kind of check a CoS agent should be able to do itself, on demand, and only Gemini genuinely supports the "check the vendor live" version of that check.

## Non-goals

- Kimi/Deepseek coverage (not used for agent assignment today; can be a trivial follow-up given the same shape).
- Scheduled/cron-driven refresh.
- Any change to `src/llm/catalog.ts` / `LLM_CATALOG` (the sidecar engine-task catalog) — separate system, separate purpose, untouched.
- Hard validation / write-time blocking on `model`.
- OpenAI API-key path (`openai/...`) — operator runs subscription-only across Claude/Grok/GPT; `codex` is the relevant GPT route, not `openai`.

## Data model

Two new Mongo collections, following the existing versioned-document convention already used for `agent_definitions`/`agent_definition_versions` (`src/types/agent-definition.ts:99-104`, `src/admin/admin-mcp-server.ts:99-136`).

### `agent_model_catalog`

One document per **curated** provider only — `claude`, `grok`, `codex`. Gemini is never stored here; it's always resolved live.

```ts
interface AgentModelCatalogEntry {
  id: string;            // e.g. "grok-4.6"
  displayName: string;   // e.g. "Grok 4.6"
  notes?: string;        // free text, e.g. "subscription default", "reasoning tier"
  addedAt: Date;
}

interface AgentModelCatalogDoc {
  _id: "claude" | "grok" | "codex";
  provider: "claude" | "grok" | "codex";
  models: AgentModelCatalogEntry[];
  updatedAt: Date;
  updatedBy: string;      // agentId that called the refresh tool
}
```

### `agent_model_catalog_versions`

Append-only audit trail, mirroring `AgentDefinitionVersion`'s shape exactly (`src/types/agent-definition.ts:99-104`):

```ts
interface AgentModelCatalogVersion {
  provider: "claude" | "grok" | "codex";
  snapshot: AgentModelCatalogEntry[];   // the models array as of this write
  changeSummary: string;                 // human-readable diff description
  createdAt: Date;
  updatedBy: string;
}
```

Index: `{ provider: 1, createdAt: -1 }`, created lazily on first handler call — same pattern as the existing `agentVersions.createIndex({ agentId: 1, createdAt: -1 })` at `src/admin/admin-mcp-server.ts:107-115`.

## Tools

Both added to `buildAdminTools()` in `src/admin/admin-mcp-server.ts`, alongside `agent_create`/`agent_update`/`list_archetypes`. Same file, same `AdminToolDeps` (`db`, `agentId`, `instanceCapabilitiesJson`, optional `memoryLifecycle` — `src/admin/admin-mcp-server.ts:87-97`), no new constructor dependency required — `config.gemini.apiKey` is already a resolved module-level singleton (`src/config.ts:376`, resolved env→Keychain once at boot) and can be imported directly the same way `agent-manager.ts` already does (`appConfig.gemini.apiKey || undefined`, `src/agents/agent-manager.ts:666`).

### `agent_model_catalog_list`

```ts
{
  provider: z.enum(["claude", "grok", "codex", "gemini"]).optional()
    .describe("Omit to list all 4 providers."),
}
```

Behavior per provider:
- **gemini** — live call using **header auth**, not a query-string key: `GET https://generativelanguage.googleapis.com/v1beta/models` with `x-goog-api-key: ${config.gemini.apiKey}`. This is a deliberate departure from the query-param form used ad hoc during this design's brainstorm session — every existing handler in `admin-mcp-server.ts` catches into `String(err)` and returns it as tool text (e.g. the pattern at `src/admin/admin-mcp-server.ts:220`), and a fetch/undici error can embed the request URL; a query-string key would leak into agent-visible tool output on any transport-level failure. The gemini branch's catch block must not use the shared `String(err)` pattern verbatim — it must construct a sanitized message (status code + a fixed string, never the raw error object or request URL) before returning `isError: true`. Header auth removes the leak vector at the source; the sanitized catch is defense in depth.
  - Filtered to models with `thinking`/generation-capable shape (exclude embedding/TTS/image/video-only entries — see filtering note below). Cached in-process with a `CacheSlice<T>`/TTL pattern identical to `team-cache.ts:6,36,55-` (`TTL_MS` ~10 minutes — long enough to avoid redundant calls within one conversation, short enough that a same-session "refresh" mentally still feels live).
  - **Failure modes, explicit:**
    - `config.gemini.apiKey` empty (not every instance has seeded it) → return `isError: true` with a plain "Gemini API key not configured on this instance (`GEMINI_API_KEY`) — run `hive credentials add GEMINI_API_KEY`, then restart the hive service (gemini key resolution happens once at boot, per `docs/providers.md` footnote 16)" message. Does not throw past the handler boundary.
    - Vendor fetch fails (network, 401, 429, 5xx) → same `isError: true` shape, sanitized status-only message (per the credential-safety rule above). The stale cache, if one exists, is **not** served as a silent fallback — masking a real vendor-side failure as fresh data is worse than an honest error, consistent with the rest of the engine's honest-failure posture (e.g. the provider circuit breaker's fast-fail behavior).
    - When `provider` is omitted (all-4 listing) and the gemini leg fails — whether from a missing key or a fetch failure — while claude/grok/codex succeed: **partial results, not a whole-call failure**, in both cases identically. Return the 3 curated providers' entries normally, plus one extra text note appended to the response (not a 4th array-shaped element) explaining why the gemini leg is absent. This matches the return-shape fix below — errors are prose, entries are the typed array. (Only the single-provider `gemini`-only call uses the `isError: true` shape described above; the all-4 call never hard-errors on gemini's account.)
- **claude / grok / codex** — read straight from `agent_model_catalog`, `_id` = provider. Empty/missing doc → no array entries for that provider, plus one prose note per empty provider: "not yet seeded — call `agent_model_catalog_refresh` first."

Return shape: **one JSON text block for the entries array, plus zero or more separate prose notes appended after it** for any provider leg that failed or is unseeded (gemini fetch failure, empty curated doc). The array itself never contains error/placeholder rows — a provider either contributes real entries or contributes nothing to the array and one note explaining why. Entries JSON matches `list_archetypes`'s `JSON.stringify(catalog, null, 2)` convention at `src/admin/admin-mcp-server.ts:758-782`:

```ts
Array<{
  provider: "claude" | "grok" | "codex" | "gemini";
  id: string;
  displayName: string;
  notes?: string;
  source: "live" | "curated";
  asOf: string;   // ISO timestamp — cache time for gemini, updatedAt for curated
}>
```

### `agent_model_catalog_refresh`

```ts
{
  provider: z.enum(["claude", "grok", "codex"])
    .describe("Gemini is always live — nothing to refresh."),
  models: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    notes: z.string().optional(),
  })).min(1),
  changeSummary: z.string().optional()
    .describe("What changed and why, e.g. 'Anthropic shipped Opus 6, added; removed Opus 4.7 (deprecated per vendor changelog)'."),
}
```

Handler:
1. Load current doc (if any), diff `models` by `id` (added / removed / unchanged) — purely for the summary text, not a validation gate (no check that ids are "real"; the vendor call remains the source of truth for actual validity, same honesty posture as everywhere else in the provider-adapter code).
2. Upsert `agent_model_catalog` with the new `models` array, `updatedAt: new Date()`, `updatedBy: agentId`.
3. Insert one `agent_model_catalog_versions` row (snapshot + changeSummary + createdAt + updatedBy).
4. Return a text summary: `"claude catalog updated: +1 (claude-opus-6), -1 (claude-opus-4-7 removed). 6 models total."` — mirrors the tone of `agent_create`'s own confirmation text at `src/admin/admin-mcp-server.ts:379`.

(`provider === "gemini"` is already excluded at the Zod schema level — the enum only contains `claude`/`grok`/`codex` — so no handler-level rejection step is needed; this is enforced at the schema boundary, not the handler body.)

No outbound HTTP, no scraping, no vendor call inside this handler at all — it only persists what the calling agent already researched using its own tools.

## Gemini live-lookup filtering note

Google's `/v1beta/models` list returns every model family (chat, image, video, TTS, embeddings, live/streaming variants — confirmed during brainstorm: `gemini-3.1-pro-preview`, `gemini-3.1-flash-image-preview` a.k.a. "Nano Banana 2", `veo-3.1-generate-preview`, `lyria-3-pro-preview`, etc. all showed up in one `?key=` query). The handler must filter to models plausible for **agentic chat use** before returning — at minimum exclude entries whose `name`/`displayName` indicates image/video/audio/TTS/embedding-only, and prefer entries where `supportedGenerationMethods` includes `generateContent`. This is a best-effort filter (documented as such, not a hard guarantee), since the field doesn't cleanly distinguish "works on the Interactions API adapter" — same caveat the KPR-352 spike already flagged for this same field.

## Bundled fix: `model` field discoverability

`src/admin/admin-mcp-server.ts:240` (and the equivalent free-text mention inside `agent_update`'s `fields` description) gets its `.describe()` expanded from the current Claude-only example to something like:

> "Model to use. Bare id (e.g. 'claude-opus-5') routes to Claude. Prefix `<provider>/<model>[:effort]` routes elsewhere — e.g. 'codex/gpt-5.5:medium', 'gemini/gemini-3.1-pro-preview', 'grok/grok-4.6'. Call `agent_model_catalog_list` first to check what's currently valid per provider — see docs/providers.md for full capability parity."

Pure tool-description change, zero runtime behavior change, ships in the same PR since it's the direct discoverability fix this whole feature exists to close.

## Seed data (ship-time)

Populated via one manual `agent_model_catalog_refresh` call per curated provider at rollout, not a migration script (small, judgment-based data — appropriate for an agent/operator to seed conversationally rather than hardcode). Starting values, reflecting verified current reality as of this design session:

- **codex**: `gpt-5.5` (confirmed running today on `luna`, keepur instance — *not* `gpt-5.4-mini`, the stale `DEFAULT_CODEX_MODEL`/`CODEX_AGENT_MODEL` fallback constant in `src/agents/provider-adapters/codex-subscription-adapter.ts:11` and `src/config.ts:278`).
- **grok**: `grok-4.6` (default), `grok-4.5` — per `docs/providers.md` footnote 16 and `PASSTHROUGH_PROVIDERS.grok.defaultModel` (`src/agents/provider-adapters/passthrough-providers.ts`), subscription auth exposes exactly these two.
- **claude**: mirror the currently-catalogued Claude entries in `src/llm/catalog.ts` (`claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, plus older `sonnet-4-6`/`opus-4-7`/`opus-4-8` if still considered assignable) — a deliberate, reviewed judgment call at seed time, not an automated mirror (the two catalogs serve different purposes and should be allowed to diverge going forward). Include `claude-haiku-4-5` — it's both the sidecar catalog's one non-frontier entry and, per the operator's actual fleet, the model behind production Haiku-tier agents; the seed list should cover the full assignable range, not just frontier-tier ids.

## Security

No new credential exposure. Gemini's key resolution follows the exact existing pattern (`config.gemini.apiKey`, env-first then Honeypot Keychain at boot) — the tool handler reads the already-resolved config value the same way `agent-manager.ts` does today; it never touches Keychain directly and never returns the key value in any tool response. The key is sent as an `x-goog-api-key` header, never a URL query parameter, specifically so it can't leak into agent-visible tool output via an error message that happens to echo the request URL (see the `agent_model_catalog_list` failure-mode notes above — this is the concrete mechanism, not just a principle). This is consistent with the repo's DOD-212 posture: cloud-model agents invoke capabilities, they don't hold secrets.

## Out of scope / follow-up candidates

- Kimi/Deepseek — same shape as Claude/Grok/Codex (curated, no live endpoint), trivial follow-up once this ships.
- Any write-time validation on `agent_create`/`agent_update` against the catalog (deliberately rejected this round — see Key Points).
- Automated/scheduled refresh (deliberately rejected this round in favor of on-demand).

## File-level change list

- `src/admin/admin-mcp-server.ts` — add `agent_model_catalog_list`, `agent_model_catalog_refresh`; expand `model` field `.describe()` on `agent_create`/`agent_update`.
- `AgentModelCatalogEntry`/`AgentModelCatalogDoc`/`AgentModelCatalogVersion` types defined inline in `admin-mcp-server.ts`, not a new shared type file — nothing else in the codebase needs them (unlike `AgentDefinitionVersion`, which is genuinely shared across `admin-mcp-server.ts` and `admin-api.ts` and earns its place in `src/types/agent-definition.ts`). Revisit only if a second consumer shows up.
- New small in-memory TTL cache module (or inline, mirroring `src/team-roster/team-cache.ts`'s `CacheSlice` shape) for the Gemini live-lookup cache.
- Two new Mongo collections (`agent_model_catalog`, `agent_model_catalog_versions`) — no migration needed, created implicitly on first write.
- `CLAUDE.md` — add both new collections to the "MongoDB collections (engine-written)" list, matching how every other engine-written collection is already documented there.

---

## Implementation note (2026-08-23, post-ship)

Three provisions beyond this spec's minimum were added during the review loop and are recorded here for the public mirror's completeness (full decision detail is in the KPR-380 Decision Register — Canon, on the epic ticket):

- The Gemini fetch carries a 10-second `AbortSignal.timeout` — closes an unbounded-hang gap this spec's failure-mode list didn't cover; the abort surfaces through the same sanitized network-error path already specified above.
- A Gemini `200` response yielding zero usable chat models (after the agentic-chat filter) returns an empty entries array plus a prose note, mirroring the "not yet seeded" curated-provider shape — the spec's failure-mode list didn't enumerate this specific case, but the principle ("errors are prose, entries are the typed array") extends to it directly.
- **Superseded by KPR-382:** the single-key read this spec prescribes above (`config.gemini.apiKey` only, § Tools and § Security) is superseded for `agent_model_catalog_list`'s availability judgment. The tool now mirrors the Gemini provider adapter's full key-resolution chain (`config.gemini.apiKey` → env `GOOGLE_GENAI_API_KEY` → `GEMINI_API_KEY` → `GOOGLE_API_KEY`) rather than the config value alone — closing a gap where an instance configured via an adapter-only fallback key had working Gemini turns but a hard-erroring lookup tool with inaccurate remediation text. The credential-safety invariant (header-only auth, sanitized errors, key never in URL or tool output) is unchanged and applies identically regardless of which leg in the chain supplied the key. See the KPR-382 register entry on the epic ticket for the full decision record.
