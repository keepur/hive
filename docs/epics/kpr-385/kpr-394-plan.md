# KPR-394 Implementation Plan — Provider plugins: load Lane B provider modules via `hive plugin add`

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-394-spec.md](./kpr-394-spec.md) (spec-review clean at hard fable final, 2 rounds) — the contract. Epic: KPR-385 (Decision Register canon C1–C21 binds; ABI baseline `6b58099`, freeze ARMED — this ticket's contract movements are exactly the registered decisions R1–R4, nothing more). **Every anchor below verified against this worktree's HEAD `1d138c5`.** All baselines were recorded by actually running the suites at that HEAD on default Node v26.7.0 (env stubs; CLAUDE.md's Node-26 breakage is tsx dev mode only, which no plan command uses; `npm ci` already run in this worktree).

**Delivery-tier input (plan author's view, reviewer classifies authoritatively): capable.** This ticket rewires the manager's both construction sites and its static route resolver, adds a two-phase boot load through index.ts's startup ordering, widens provider types across nine files (R2), touches the credentials registry/CLI, the plugin CLI, doctor, the model catalog, package.json's module-resolution surface, and the bundle pipeline — broad blast radius across load-bearing seams, even though each individual edit is mechanical and fully transcribed here.

**Goal:** a plugin carrying a `provider:` block in `plugin.yaml` makes `<id>/<model>[:<effort>]` a routable agent `model` after the restart `hive plugin add` already performs — full Lane B surface (assembly, ToolBridge, guardrails, delegates, breaker, outage queue, telemetry) with credentials resolved manager-side on the existing `secret-env`/Honeypot chain (C7/C15, byte-identical to grok's). A *declared* provider that fails to load is **declared-broken**: turns routed at its prefix fail with an honest breaker-invisible `TurnAssemblyError`, never a silent Claude fallback. Only never-declared prefixes keep the unknown-prefix → Claude canon.

**Architecture (mapping spec §4 onto this codebase):**

- `src/agents/provider-adapters/provider-abi.ts` (NEW) — the ABI barrel (spec §4.2/§4.7): `LANE_B_PROVIDER_ABI_VERSION = 1`, the `LaneBProviderKit` interface, and **type-only re-exports** of the contract closure (declarations re-exported, not moved — discharges the KPR-391 §4.3 re-homing note). Compiles to a near-empty JS file (one constant); published to plugin authors via a `@keepur/hive/provider-abi` subpath export whose `types` condition points at the shipped declaration tree (Task 8).
- `src/plugins/provider-decl.ts` (NEW) — the **light, dependency-free** manifest layer: `normalizeProviderDecl`, `validateProviderDecl` (regex / reserved ids / exact-integer abi / env-key shape), `readInstalledProviderDecls` (quiet manifest reader), `auditInstalledProviderDecls` (doctor/static view), and the `RESERVED_PROVIDER_IDS` / `BUILTIN_ROUTABLE_PREFIXES` sets. Deliberately imports **no adapter code** so the CLI (`plugin.ts`, `credentials.ts`) and doctor consume it without dragging the Lane B implementation layer into their bundles.
- `src/agents/provider-adapters/provider-registry.ts` (NEW) — the runtime registry (spec §4.3), **module-global state** (not manager-instance: `resolveProviderModel` is a module-scope pure function also consumed statically by `providerFor` and `prepareSpawn` — spec §4.3 planner note honored). Built-ins seed from `LANE_B_PROVIDER_MODULES` + `SESSION_SEMANTICS` at module load (both tables stay, unchanged). Two-phase boot load: `declarePluginProviders()` (phase a — sync, called from the manager constructor right after `loadPlugins`) and `activateDeclaredProviders()` (phase b — async `import()` + `createProviderModule(kit)` + validation), plus `sessionSemanticsIfKnown`/`sessionSemanticsForRoute`, `describeUnroutableProvider`, `warnOrphanProviderPrefixes`, and the engine-built kit.
- `agent-manager.ts` — `ProviderModelRoute` flattens to `{ provider: string; model; reasoningEffort? }` (R2 relaxation; every construction literal byte-identical); `resolveProviderModel` gains the registry consult ahead of the Claude fallback; **both** construction sites (top-level tail + nested `delegateTurnRunner`) replace the `LANE_B_PROVIDER_MODULES` lookup with the same `getRegisteredProvider` call — still one shared lookup path (KPR-391 §4.3 property preserved); `resolveProviderModuleSlice` generalizes `resolveGrokModuleSlice` (which stays, as the grok arm); `activateProviderPlugins()` is the phase-b entry awaited by index.ts **immediately after manager construction, before `bgTaskManager.start()`/`scanOrphans()`** (their completion callbacks can already dispatch turns — spec §4.3 r1 correction).
- R3 lives in `tool-transport.ts`: the compatibility record gains the `laneB` column (the single non-Claude value every classify site already computes), and `partitionInventoryForProvider` reads `columns[provider] ?? columns.laneB ?? "unsupported"` — built-ins bit-identical, plugin ids get the truthful generic column, a stale hand-built record with neither column is honestly unsupported.
- Credentials-CLI extension (spec §6 edge 5, definite deliverable): `pluginProviderCredentialEntries` in `credential-registry.ts` maps installed manifest decls onto `CredentialEntry` shape; `credentials.ts` merges them into list/add. The bootstrap wizard consumes only the static `CREDENTIAL_REGISTRY` array (verified: `credentials-wizard.ts` imports nothing new) — bootstrap unaffected, pinned by its zero-edit suite.

**Spec rulings honored (load-bearing, per task):**
- *C6/C11 — frozen ABI:* the plan implements R1–R4 exactly as registered, nothing more. R4 is a no-op by construction (`providerConfig` shape untouched — Task 2 makes zero edits to `LaneBModuleDeps.providerConfig`). Kit member list = the spec floor (scaffold, loop, sse, createLogger) with **zero additions**; the sse member names follow the real exports (`splitSseEvents`/`parseSseEvent`/`isSseDone` — the spec's `consumeBufferedSseEvents` name does not exist in `sse.ts`; ⚠-delegated kit-list detail, resolved to the actual surface).
- *Spec §4.3 two-phase boot:* phase (a) is synchronous inside the constructor manifest pass (`agent-manager.ts:527`); phase (b) is `await agentManager.activateProviderPlugins()` inserted in `index.ts` immediately after the constructor call (`:380-393`), strictly before `bgTaskManager.start()`/`scanOrphans()` (`:413-414`). The `registerPluginCommands` slot (`index.ts:661`, after `slackAdapter.start`) is deliberately NOT reused — transcription carries the comment.
- *Spec §4.3 honest failure:* declared (registered, still-loading, or broken) ids route to themselves; `createProviderAdapter` throws `TurnAssemblyError` with the spec's message shape (`provider '<id>' from plugin '<name>' failed to load: <reason>`) inside `runOneSpawnAttempt`'s recorded try — `classifyThrown` short-circuits to non-provider, breaker-invisible (pinned in Task 4's tests).
- *Spec §4.1 edge 1 refinement (plan-level, flagged for review):* the r1 registry sketch keys `brokenProviders` by id, but a **collision** entry keyed by id would shadow the healthy first registration. Refined: first registration wins deterministically (plugin order = `appConfig.plugins` order); the second declaration is rejected with `log.error` carrying **both plugin names** and surfaces as a broken row in doctor's static audit — the id's routing state stays with the first registrant, never last-wins shadowing. Spec's observable guarantees (deterministic first-wins, both names visible, never silent) all hold.
- *C7/C15 — credential tiering:* `resolveEnvKeyCredential` / `assertSafeBaseUrlOverride` consumed at the manager tier only (`resolveProviderModuleSlice`); modules never touch env/Keychain; missing key throws the byte-identical `Passthrough credential missing (authentication): <KEY> — seed it via \`hive credentials add <KEY>\`` contract (verified at `passthrough-providers.ts:179-192`).
- *Spec §4.6 — boot-only:* SIGUSR1 never loads/unloads provider code; the reload path gains only the orphan-prefix warn. `hive plugin add`/`remove` already restart (`plugin.ts:109/:151`) — no new operator step.
- *Spec §4.11 mechanics (⚠-delegated, resolved):* `z.string()` + in-handler runtime validation, NOT a dynamic enum — the admin test harness mocks the SDK `tool()` wrapper (zod never runs there), so in-handler validation is the only behavior-testable form; it also keeps one validation idiom for both tools. Plugin ids reach the admin server via a new optional `AdminToolDeps.listPluginProviderIds` dep (wired at `agent-runner.ts:1454`) — keeps the admin test harness free of the heavy registry import.
- *C10/C16 — enumerated deltas:* exactly **nine** pre-existing test files change, each enumerated below with per-file baselines and per-edit lists. Tests are NOT typechecked (`tsconfig` excludes `src/**/*.test.ts` — verified), so nothing here claims a test delta is "compile-forced." The C16 record-literal sweep for the R3 column is Task 2's explicit checkbox (every `compatibility: {` literal site in the repo enumerated — swept via grep, output in this plan).
- *C19/C20 — KPR-393 surfaces undisturbed:* `prefix-builder.ts` (follow-through section), `intent-trailer.ts`, and the activity-write `intentTrailer` computation are zero-diff files; `buildProviderInstructions` has **no provider parameter** (verified at `prefix-builder.ts:332` — the R2 mention of it is vacuous for this codebase and honestly recorded as such), so prompt assembly is untouched and golden/provider prefix suites are zero-edit pins.
- *Spec §4.9 / DOD-212:* `hive plugin add` prints the in-process disclosure line before the restart; no new credential paths; `PASSTHROUGH_PROVIDERS` and all Lane A surfaces untouched (zero-diff `passthrough-providers.ts` except the one-line `isLaneAProvider` param widening, R2).
- *Spec §4.10:* `docs/providers.md` gains exactly the routing-paragraph update, the "Plugin-registered providers" class section, and a History entry — same PR as the code, per the matrix's standing rule.
- *Spec §7 fixture:* the in-repo fixture is `test-fixtures/provider-home/` (repo root — outside `src/` so tsc/eslint/prettier/npm-pack never see it), a real on-disk plugin (manifest + plain-JS compiled entry) exercised by real `loadPlugins` + real dynamic import. Not a published example (non-goal).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `src/plugins/provider-decl.test.ts` (NEW — manifest normalize/validate/read/audit); `src/agents/provider-adapters/provider-registry.test.ts` (NEW — seeding, declare states, collision, activation incl. kit round-trip and real fixture import, semantics overlay, orphan scan); `src/agents/provider-adapters/tool-transport.test.ts` (delta — R3 column + partition fallback).
  - Reason: the manifest layer, the registry, and the R3 partition are the ticket's pure load-bearing surfaces.
  - Harness: **existing** (plain vitest; registry tests mock only the logger; the fixture e2e test uses the real loader + real `import()`).
  - Minimum assertions: the per-task lists in Tasks 1–3.

- Integration: **required**
  - Scope: `src/agents/agent-manager.test.ts` (delta — one additive describe at the KPR-392 grok seam: routing, both construction sites, slice resolution, honest-failure, breaker keying); `src/agents/session-store.test.ts` (delta — plugin-provider semantics on the read side); `src/admin/admin-mcp-server.test.ts` (delta — catalog acceptance); `src/cli/credentials.test.ts` + `src/setup/credential-registry.test.ts` (delta — dynamic provider credential entries); `src/cli/doctor-checks.test.ts` (delta — section render).
  - Reason: these are the wiring seams; each reuses its file's existing harness (verified idioms: `registry._agents.set`/`smsCtx`/`makeRunResult`/`mockLogWarn` in the manager suite; fake-collection mocks in session-store; `buildAdminTools` handler-direct in admin; injected `CredentialsCliIO` in credentials).
  - Minimum assertions: the per-task lists in Tasks 3–7; all non-enumerated existing tests green with zero expectation edits.

- E2E: **not-required**
  - Scope: n/a in CI. The spec's live smoke (§7 — `hive plugin add` of a local fixture on a dev instance, one turn, remove, doctor at each step) is operator-run and optional, post-merge.
  - Reason: the fixture-import registry test + the manager construction-site tests cover the full in-process path; the CLI/restart choreography is pre-existing machinery this ticket only adds validation printing to.
  - Harness: not-applicable.
  - Minimum assertions: n/a.

### Critical Flows

- **Routing:** `sol/sol-large-2:high` on a registered plugin → route `{ provider: "sol", model: "sol-large-2", reasoningEffort: "high" }`; a declared-broken id still routes to itself and the turn fails with the honest message; `grock/...` (never declared) → Claude fallback, byte-identical to today (existing pin at `agent-manager.test.ts:3499` stays green unedited).
- **Both construction sites:** primary spawn and nested delegate turn both construct through `getRegisteredProvider(route.provider).module.createAdapter` — fixture module observes `context: "primary"` and `context: "nested"` respectively, with the same `deps` object (G4 stays a module rule).
- **Slice:** `providerConfig = { agentModel: default-model, apiKey: env→Honeypot(SOL_API_KEY), baseUrl: validated SOL_BASE_URL override or undefined }`, per spawn; missing key ⇒ `TurnAssemblyError` naming `hive credentials add SOL_API_KEY`, breaker closed after 3 attempts, recovery next spawn.
- **Ops keying:** three hard-fault turns on `sol` trip only the `sol` breaker (lazy map, zero wiring); `codex` breaker untouched.
- **Built-in bit-identity:** the full provider-adapters suite (540), manager suite (230), dispatcher (91), breaker (29), session-store (17) pass with zero expectation edits outside the enumerated files.
- **Semantics overlay:** `sessionSemanticsIfKnown` — builtin Record first, plugin overlay second, unknown `undefined`; session-store's fail-closed unknown-provider scrub posture unchanged (existing pin at `session-store.test.ts:111` green unedited); a *registered* `server-resumable` plugin row now returns its handle.
- **Bundle surface:** `npm run check:bundle` green with the `exports` map + shipped `pkg/types/` declaration tree; no repo-external `@keepur/hive/...` module-specifier deep imports exist (swept: only a registry URL in beekeeper and package-name references in hive-plugins).

### Regression Surface

- **Zero-expectation-edit suites (C10) — real baselines recorded at `1d138c5` (env stubs, Node v26.7.0):**
  | Suite | Baseline |
  |---|---|
  | `src/agents/provider-adapters/` (all 19 files, directory total) | 540 passed |
  | `src/agents/provider-adapters/provider-modules.test.ts` | 21 passed |
  | `src/agents/provider-adapters/types.test.ts` | 9 passed |
  | `src/agents/provider-adapters/turn-assembly.test.ts` | 23 passed |
  | `src/agents/agent-manager.test.ts` | 230 passed |
  | `src/agents/agent-runner.test.ts` | 179 passed |
  | `src/agents/session-store.test.ts` | 17 passed |
  | `src/agents/provider-circuit-breaker.test.ts` | 29 passed |
  | `src/channels/dispatcher.test.ts` | 91 passed |
  | `src/plugins/plugin-loader.test.ts` | 47 passed |
  | `src/cli/credentials.test.ts` | 17 passed |
  | `src/setup/credential-registry.test.ts` | 8 passed |
  | `src/setup/credentials-wizard.test.ts` | 6 passed |
  | `src/admin/admin-mcp-server.test.ts` | 87 passed |
  | `src/cli/doctor.test.ts` | 52 passed |
  | `src/cli/doctor-checks.test.ts` | 64 passed |
  | `src/agents/prefix-builder.golden.test.ts` | 12 passed |
  | `src/agents/prefix-builder.provider.test.ts` | 16 passed |
  | `src/agents/prefix-builder.test.ts` | 12 passed |
  | `src/agents/toolkit-section.test.ts` | 26 passed |
  | `src/agents/provider-adapters/tool-transport.test.ts` | 56 passed |

- **Enumerated pre-existing test-file deltas (the complete list — C10/C16; nothing else may change):**
  1. `src/agents/provider-adapters/tool-transport.test.ts` — baseline **56**, expected **60**. Six existing full-record `toEqual` pins gain the `laneB` key (lines 20, 71, 88, 106, 121, 159 — rule: `laneB` equals the record's `openai` value, the one-code-path invariant), plus 4 new partition-fallback tests. (Task 2.)
  2. `src/agents/agent-runner.test.ts` — baseline **179**, expected **179**. One literal edit: the full-record `toEqual` at line 1178 (`keychain.compatibility`) gains `laneB` = its `openai` value. No count change, no other edits.
  3. `src/plugins/plugin-loader.test.ts` — baseline **47**, expected **50**. Three additive tests (provider-block normalize round-trip through `normalizeManifest`; absent block → `undefined`; structurally-invalid block → manifest-invalid skip, matching the MCP-entry precedent). (Task 1.)
  4. `src/agents/agent-manager.test.ts` — baseline **230**, expected **239**. One additive describe (9 tests) placed directly after the `"Lane B grok (KPR-392)"` describe; **zero edits to existing tests**. (Task 4.)
  5. `src/agents/session-store.test.ts` — baseline **17**, expected **19**. Two additive tests (registered plugin-provider rows, both semantics values); the existing fail-closed unknown-provider pin (line 111) is untouched and must stay green. (Task 3.)
  6. `src/admin/admin-mcp-server.test.ts` — baseline **87**, expected **91**. Four additive tests (list accepts a plugin id unseeded; refresh upserts a plugin id; refresh rejects an unknown id naming the valid set; gemini refresh still rejected). (Task 7.)
  7. `src/cli/doctor-checks.test.ts` — baseline **64**, expected **68**. Four additive render tests. (Task 6.)
  8. `src/cli/credentials.test.ts` — baseline **17**, expected **21**. Four additive tests via the new `dynamicEntries` parameter. (Task 5.)
  9. `src/setup/credential-registry.test.ts` — baseline **8**, expected **10**. Two additive tests for `pluginProviderCredentialEntries`. (Task 5.)
- New test files: `src/plugins/provider-decl.test.ts` (30 tests), `src/agents/provider-adapters/provider-registry.test.ts` (18 tests).
- Post-change provider-adapters directory total: 540 + 4 (tool-transport) + 18 (provider-registry) = **562**.
- Untouched modules (empty diff verified in Task 11): `provider-modules.ts` (the table stays as the builtin seed — only its file-top comment's "until then" clause is now stale prose, deliberately left), `dispatch-loop.ts`, `sse.ts`, `tool-bridge.ts`, all four adapters, `passthrough-providers.ts` beyond the one `isLaneAProvider` line, `prefix-builder.ts`, `intent-trailer.ts`, `activity/types.ts`, `outage/` (all three files — `OutageQueueStore.provider` is already `string`, verified `outage-queue-store.ts:46`), `error-classification.ts`, `oauth-credentials.ts`.
- C16 note: the `classification-crosscheck.test.ts` fixture tables are decoupled from source; nothing here touches classification and no claim is made that any mutation in this plan would fail them.

### Commands

- Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle gate (Task 8 only): `npm run check:bundle`
- Targeted inner loop:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/plugins/ src/agents/provider-adapters/ src/agents/agent-manager.test.ts \
    src/agents/session-store.test.ts src/agents/agent-runner.test.ts \
    src/cli/credentials.test.ts src/setup/ src/admin/admin-mcp-server.test.ts \
    src/cli/doctor-checks.test.ts src/channels/dispatcher.test.ts
  ```
- Per-file count verification: `... npx vitest run <file>` and read the `Tests  N passed` line — vitest runtime output, never grep (`it.each` expansion).

### Verification Rules

- Every task ends with its verify command actually run and output matching the stated expectation before the task's commit (dodi-dev:verify).
- Zero-edit suites verified by **count match against the baselines above** plus `git diff --name-only 1d138c5` showing no test file outside the enumerated nine.
- No success claim for Task 10 without pasting the observed failing test names.
- Before each commit: `npm run lint` + `npm run format` (new files must satisfy Prettier; `test-fixtures/` is outside its glob and stays as written).

---

## File Structure

```
src/agents/provider-adapters/provider-abi.ts          NEW   R1: ABI constant + kit type + type re-exports
src/agents/provider-adapters/provider-registry.ts     NEW   §4.3 runtime registry + kit value + two-phase load
src/agents/provider-adapters/provider-registry.test.ts NEW  18 tests
src/plugins/provider-decl.ts                          NEW   §4.1 manifest layer (light, CLI-safe)
src/plugins/provider-decl.test.ts                     NEW   30 tests
src/plugins/types.ts                                  MOD   PluginProviderDecl + manifest field
src/plugins/plugin-loader.ts                          MOD   normalizeManifest provider arm
src/plugins/plugin-loader.test.ts                     MOD   delta #3 (+3)
src/agents/provider-adapters/provider-module.ts       MOD   R2: provider → string
src/agents/provider-adapters/types.ts                 MOD   R2: AgentProviderAdapter.provider → string
src/agents/provider-adapters/turn-scaffold.ts         MOD   R2: abstract provider → string
src/agents/provider-adapters/turn-assembly.ts         MOD   R2: assembleProviderTurn provider → string
src/agents/provider-adapters/tool-transport.ts        MOD   R2+R3: laneB column + string partition
src/agents/provider-adapters/tool-transport.test.ts   MOD   delta #1
src/agents/provider-adapters/passthrough-providers.ts MOD   R2: isLaneAProvider(p: string)
src/agents/provider-circuit-breaker.ts                MOD   R2: provider params → string
src/agents/session-store.ts                           MOD   R2 + registry-aware semantics read
src/agents/session-store.test.ts                      MOD   delta #5 (+2)
src/agents/agent-manager.ts                           MOD   §4.3/§4.4 registry integration
src/agents/agent-manager.test.ts                      MOD   delta #4 (+9)
src/agents/agent-runner.ts                            MOD   admin catalog dep wire (1 line + import)
src/agents/agent-runner.test.ts                       MOD   delta #2 (1 literal)
src/index.ts                                          MOD   phase-b await + reload orphan warn
src/cli/plugin.ts                                     MOD   §4.8 install validation + disclosure
src/cli/credentials.ts                                MOD   §6 edge-5 dynamic entries
src/cli/credentials.test.ts                           MOD   delta #8 (+4)
src/setup/credential-registry.ts                      MOD   pluginProviderCredentialEntries
src/setup/credential-registry.test.ts                 MOD   delta #9 (+2)
src/cli/doctor-checks.ts                              MOD   §4.8 provider-plugins section
src/cli/doctor-checks.test.ts                         MOD   delta #7 (+4)
src/cli/doctor.ts                                     MOD   section wiring (+ config-not-loaded line)
src/admin/admin-mcp-server.ts                         MOD   §4.11 catalog widening
src/admin/admin-mcp-server.test.ts                    MOD   delta #6 (+4)
test-fixtures/provider-home/plugins/hive-plugin-sol/plugin.yaml       NEW  in-repo fixture (spec §7)
test-fixtures/provider-home/plugins/hive-plugin-sol/dist/provider.js  NEW  fixture factory (plain ESM JS)
package.json                                          MOD   exports map (provider-abi subpath)
build/bundle.ts                                       MOD   copy dist d.ts tree → pkg/types/
scripts/check-bundle-pack.mjs                         MOD   required-file additions
docs/providers.md                                     MOD   §4.10 sections + History entry
```

---

### Task 0: Baseline pin

- [ ] Confirm worktree HEAD: `git -C /Users/mokie/github/lane-kpr-394-mature rev-parse --short HEAD` → `1d138c5` (or a later commit of this lane containing it).
- [ ] Re-run the key baselines and confirm they match the Regression Surface table:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/provider-adapters/          # expect: Tests  540 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/agent-manager.test.ts       # expect: Tests  230 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/plugins/plugin-loader.test.ts      # expect: Tests  47 passed
  ```
- [ ] No commit (baseline only).

### Task 1: ABI barrel + manifest layer (R1, §4.1, §4.2, §4.7)

**1a. Create `/Users/mokie/github/lane-kpr-394-mature/src/agents/provider-adapters/provider-abi.ts`:**

```ts
/**
 * KPR-394 (§4.2/§4.7): the Lane B provider-plugin ABI surface — the ONE
 * documented import point for plugin authors (`@keepur/hive/provider-abi`,
 * a types-only subpath export consumed as a devDependency; types erase at
 * build, so a plugin carries no runtime dependency on the engine) and the
 * home of the ABI version constant.
 *
 * Declarations are RE-EXPORTED from their canonical homes, not moved (this
 * discharges the KPR-391 §4.3 "re-homing deferred to KPR-394's ABI freeze"
 * note). Every name reachable from this barrel is frozen ABI under C6
 * governance: any breaking change to a re-exported contract or to a kit
 * member's behavior bumps LANE_B_PROVIDER_ABI_VERSION (exact-integer
 * handshake, §4.7 — additive, non-breaking growth does not bump; bumps are
 * themselves registered decisions).
 */
import type { LaneBTurnScaffold } from "./turn-scaffold.js";
import type { runBoundedDispatchLoop } from "./dispatch-loop.js";
import type { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";
import type { createLogger } from "../../logging/logger.js";

/**
 * §4.7: the manifest's `abi:` integer must EXACTLY equal this. Mismatch in
 * either direction ⇒ declared-broken with a reason naming both numbers.
 * Exact integer, not semver: the ABI is one frozen contract, and
 * "compatible range" semantics invite the silent-drift class the freeze
 * exists to prevent.
 */
export const LANE_B_PROVIDER_ABI_VERSION = 1;

/**
 * §4.2 (R1): the engine-injected provider kit, handed to
 * `createProviderModule(kit)` at activation. Runtime injection hands the
 * plugin the RUNNING engine's shared implementation layer by reference —
 * a plugin cannot `import` it (the engine package is not resolvable from
 * `<hiveHome>/plugins/node_modules/`, and a bundled private copy would
 * re-create the clone problem KPR-391 killed). Member list is the spec
 * floor — scaffold, loop, sse framing, logger — and every member is frozen
 * surface: resist growth.
 */
export interface LaneBProviderKit {
  /** === LANE_B_PROVIDER_ABI_VERSION — belt-and-braces runtime assertion. */
  abiVersion: number;
  /** Abstract per-turn lifecycle base (KPR-391) — EXTEND IT: deadline,
   *  containment, ToolBridge lifecycle, usage accounting come free. */
  LaneBTurnScaffold: typeof LaneBTurnScaffold;
  /** The shared bounded tool-dispatch loop (codex/gemini/grok template). */
  runBoundedDispatchLoop: typeof runBoundedDispatchLoop;
  /** Generic SSE framing (KPR-391 §4.3 / C9) — event interpretation stays
   *  provider-side. */
  sse: {
    splitSseEvents: typeof splitSseEvents;
    parseSseEvent: typeof parseSseEvent;
    isSseDone: typeof isSseDone;
  };
  /** Engine logging with the engine's redaction conventions. */
  createLogger: typeof createLogger;
}

// ── The contract and its transitive type closure (type-only, re-exported) ──
export type {
  LaneBProviderModule,
  LaneBAdapterConstructionArgs,
  LaneBModuleDeps,
  ProviderModuleRoute,
} from "./provider-module.js";
export type {
  AgentProviderAdapter,
  AgentProviderTurnRequest,
  SessionSemantics,
  ReasoningEffort,
  GuardrailGate,
  GuardrailToolCall,
  GuardrailDecision,
} from "./types.js";
export type {
  LaneBTurnScaffold,
  LaneBTurnHarness,
  LaneBTurnTotals,
  LaneBUsageDelta,
  LaneBTurnOutcome,
  LaneBSessionPolicyState,
} from "./turn-scaffold.js";
export type {
  BoundedDispatchLoopDriver,
  DispatchRoundResult,
  DispatchLoopErrorDecision,
} from "./dispatch-loop.js";
export type { SseEvent } from "./sse.js";
export type {
  ProviderTurnAssembly,
  DelegateTurnRunner,
  ProviderMemoryBundle,
  ProviderSkillIndexEntry,
} from "./turn-assembly.js";
export type {
  HiveToolInventoryEntry,
  HiveToolSchemaEntry,
  HiveToolTransportDescriptor,
  ProviderToolCompatibility,
  HiveToolTransportKind,
  OmittedToolRecord,
} from "./tool-transport.js";
export type { RunResult, StreamCallback, WorkItemContext } from "../agent-runner.js";
export type { ResourceLimits } from "../model-router.js";
export type { TurnHistoryStore } from "../turn-history-store.js";
```

(If `tsc` flags any re-exported name as absent, fix the name against the source module — do not drop the export silently; every listed name was verified present at `1d138c5` except as follows: verify `TurnHistoryStore`'s export name in `src/agents/turn-history-store.ts` before committing.)

**1b. In `/Users/mokie/github/lane-kpr-394-mature/src/plugins/types.ts`**, add above `export interface PluginManifest`:

```ts
/**
 * KPR-394 (§4.1): a plugin's Lane B provider declaration — at most one per
 * plugin (v1). `id` is the model prefix agents use; `entry` resolves through
 * the same compiled-artifact chain as MCP server entries (`provider.ts` →
 * `dist/provider.(min.)js`); `abi` must exactly equal the engine's
 * LANE_B_PROVIDER_ABI_VERSION. `apiKeyEnv` is secret-env class (env →
 * Honeypot per spawn, engine-resolved — modules never see env/Keychain, C7);
 * `baseUrlEnv` is plain env, validated https-or-loopback when set.
 */
export interface PluginProviderDecl {
  id: string;
  entry: string;
  abi: number;
  sessionSemantics: "stateless-replay" | "server-resumable";
  defaultModel?: string;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  description?: string;
}
```

and add to `PluginManifest` (after `registerCommands?: string;`):

```ts
  /** KPR-394: optional Lane B provider declaration (one per plugin, v1). */
  provider?: PluginProviderDecl;
```

**1c. Create `/Users/mokie/github/lane-kpr-394-mature/src/plugins/provider-decl.ts`** (deliberately imports no adapter or engine-runtime code — consumed by the CLI, doctor, the loader, and the runtime registry alike):

```ts
/**
 * KPR-394 (§4.1/§4.7): the light manifest layer for provider plugins —
 * normalization, validation, and quiet manifest reading. NO adapter or
 * engine-runtime imports: `hive plugin add`, `hive credentials`, and
 * `hive doctor` consume this without dragging the Lane B implementation
 * layer into the CLI bundle. The runtime registry
 * (src/agents/provider-adapters/provider-registry.ts) builds on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PluginProviderDecl } from "./types.js";

/** §4.1: model-prefix shape — lowercase, 2–16 chars, letter first. */
export const PROVIDER_ID_REGEX = /^[a-z][a-z0-9-]{1,15}$/;

/**
 * §4.1: the full set resolveProviderModel recognizes plus aliases and the
 * compatibility key: `laneB` itself is unreachable via the lowercase-only id
 * regex (reserved for clarity); `laneb` is its reachable lowercased
 * near-miss.
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "claude",
  "openai",
  "openai-codex",
  "codex",
  "gemini",
  "google-gemini",
  "grok",
  "kimi",
  "deepseek",
  "laneB",
  "laneb",
]);

/**
 * §4.6: prefixes the engine routes without a plugin — used by the
 * orphan-model warn and doctor. (`claude` included: `claude/x` falls through
 * the unknown-prefix canon to Claude, which is not an orphan condition.)
 */
export const BUILTIN_ROUTABLE_PREFIXES: ReadonlySet<string> = new Set([
  "claude",
  "openai",
  "openai-codex",
  "codex",
  "gemini",
  "google-gemini",
  "grok",
  "kimi",
  "deepseek",
]);

const ENV_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Structural normalization — THROWS on garbage (missing/mistyped required
 * keys, unknown session-semantics), matching normalizeServerEntry's
 * precedent: an unparseable block invalidates the manifest and the loader
 * skips the plugin with an error log. Semantic failures where the id is
 * known (regex, reserved, abi, collision, entry) are validateProviderDecl /
 * registry territory and land declared-broken instead. `hive plugin add`
 * runs both at install time, so the curated path surfaces every class
 * before the restart.
 */
export function normalizeProviderDecl(raw: any): PluginProviderDecl {
  if (!raw || typeof raw !== "object") throw new Error("provider block must be a mapping");
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("provider.id must be a non-empty string");
  const entry = raw.entry;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("provider.entry must be a non-empty string");
  }
  const abi = raw.abi;
  if (typeof abi !== "number" || !Number.isInteger(abi)) {
    throw new Error("provider.abi must be an integer");
  }
  const semantics = raw["session-semantics"] ?? raw.sessionSemantics;
  if (semantics !== "stateless-replay" && semantics !== "server-resumable") {
    throw new Error(
      `provider.session-semantics must be 'stateless-replay' or 'server-resumable' (got ${JSON.stringify(semantics)})`,
    );
  }
  const optStr = (v: unknown, name: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`provider.${name} must be a non-empty string when set`);
    }
    return v;
  };
  return {
    id,
    entry,
    abi,
    sessionSemantics: semantics,
    defaultModel: optStr(raw["default-model"] ?? raw.defaultModel, "default-model"),
    apiKeyEnv: optStr(raw["api-key-env"] ?? raw.apiKeyEnv, "api-key-env"),
    baseUrlEnv: optStr(raw["base-url-env"] ?? raw.baseUrlEnv, "base-url-env"),
    description: optStr(raw.description, "description"),
  };
}

export type ProviderDeclVerdict = { ok: true } | { ok: false; reason: string };

/** §4.1/§4.7 semantic validation — shared by the registry's declare pass,
 *  `hive plugin add`, and doctor's static audit. */
export function validateProviderDecl(decl: PluginProviderDecl, engineAbi: number): ProviderDeclVerdict {
  if (!PROVIDER_ID_REGEX.test(decl.id)) {
    return {
      ok: false,
      reason: `provider id '${decl.id}' is invalid — must match ${String(PROVIDER_ID_REGEX)} (lowercase, 2-16 chars, letter first)`,
    };
  }
  if (RESERVED_PROVIDER_IDS.has(decl.id)) {
    return {
      ok: false,
      reason: `provider id '${decl.id}' is reserved (built-in provider ids, their aliases, and the laneB compatibility key cannot be re-registered)`,
    };
  }
  if (decl.abi !== engineAbi) {
    return {
      ok: false,
      reason: `plugin requires provider ABI ${decl.abi}; engine provides ${engineAbi} — ${
        decl.abi > engineAbi
          ? "upgrade hive or install an older plugin version"
          : "install a newer plugin version built for this engine"
      }`,
    };
  }
  if (decl.apiKeyEnv !== undefined && !ENV_KEY_REGEX.test(decl.apiKeyEnv)) {
    return { ok: false, reason: `provider.api-key-env '${decl.apiKeyEnv}' is not a valid env var name` };
  }
  if (decl.baseUrlEnv !== undefined && !ENV_KEY_REGEX.test(decl.baseUrlEnv)) {
    return { ok: false, reason: `provider.base-url-env '${decl.baseUrlEnv}' is not a valid env var name` };
  }
  return { ok: true };
}

/**
 * Quiet manifest reader for out-of-engine consumers (credentials CLI,
 * plugin add collision check, doctor). Same dual-path resolution as
 * loadPlugins (npm-installed first, in-tree fallback); unreadable or
 * structurally-invalid manifests are skipped silently — the loader's own
 * pass logs them.
 */
export function readInstalledProviderDecls(
  pluginNames: readonly string[],
  rootDir: string,
): { plugin: string; decl: PluginProviderDecl }[] {
  const out: { plugin: string; decl: PluginProviderDecl }[] = [];
  for (const name of pluginNames) {
    for (const dir of [join(rootDir, "plugins", "node_modules", name), join(rootDir, "plugins", name)]) {
      const manifestPath = join(dir, "plugin.yaml");
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
        if (raw?.provider !== undefined) out.push({ plugin: name, decl: normalizeProviderDecl(raw.provider) });
      } catch {
        // Skipped quietly — the engine loader's pass owns the error log.
      }
      break; // first existing manifest wins, matching loadPlugins
    }
  }
  return out;
}

export interface ProviderDeclAuditRow {
  plugin: string;
  id: string;
  abi: number;
  semantics: string;
  status: "ok" | "broken";
  reason?: string;
}

/**
 * §4.8: doctor's STATIC view — validation + collision + (optionally) entry
 * resolution, derived from manifests alone. Runtime activation faults
 * (a throwing factory) are engine-process facts and surface in engine logs
 * and per-turn errors, not here; the render notes that honestly.
 */
export function auditInstalledProviderDecls(
  pluginNames: readonly string[],
  rootDir: string,
  engineAbi: number,
  resolveEntry?: (plugin: string, entry: string) => boolean,
): ProviderDeclAuditRow[] {
  const rows: ProviderDeclAuditRow[] = [];
  const seen = new Map<string, string>(); // id → first registrant
  for (const { plugin, decl } of readInstalledProviderDecls(pluginNames, rootDir)) {
    const base = { plugin, id: decl.id, abi: decl.abi, semantics: decl.sessionSemantics };
    const verdict = validateProviderDecl(decl, engineAbi);
    if (!verdict.ok) {
      rows.push({ ...base, status: "broken", reason: verdict.reason });
      continue;
    }
    const first = seen.get(decl.id);
    if (first) {
      rows.push({
        ...base,
        status: "broken",
        reason: `id collision — already registered by plugin '${first}' (first registration wins)`,
      });
      continue;
    }
    seen.set(decl.id, plugin);
    if (resolveEntry && !resolveEntry(plugin, decl.entry)) {
      rows.push({
        ...base,
        status: "broken",
        reason: `compiled entry not resolvable (expected dist/${decl.entry.replace(/\.ts$/, "")}.(min.)js)`,
      });
      continue;
    }
    rows.push({ ...base, status: "ok" });
  }
  return rows;
}
```

**1d. In `/Users/mokie/github/lane-kpr-394-mature/src/plugins/plugin-loader.ts`**, add the import (beside the existing `./types.js` import):

```ts
import { normalizeProviderDecl } from "./provider-decl.js";
```

and in `normalizeManifest` (line 239), add the field after `registerCommands`:

```ts
    registerCommands: raw["register-commands"] ?? undefined,
    provider: raw.provider !== undefined ? normalizeProviderDecl(raw.provider) : undefined,
```

**1e. Create `/Users/mokie/github/lane-kpr-394-mature/src/plugins/provider-decl.test.ts`** — 30 tests:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ROUTABLE_PREFIXES,
  PROVIDER_ID_REGEX,
  RESERVED_PROVIDER_IDS,
  auditInstalledProviderDecls,
  normalizeProviderDecl,
  readInstalledProviderDecls,
  validateProviderDecl,
} from "./provider-decl.js";

const FULL_RAW = {
  id: "sol",
  entry: "provider.ts",
  abi: 1,
  "session-semantics": "stateless-replay",
  "default-model": "sol-large-2",
  "api-key-env": "SOL_API_KEY",
  "base-url-env": "SOL_BASE_URL",
  description: "Sol frontier models",
};

function decl(overrides: Record<string, unknown> = {}) {
  return normalizeProviderDecl({ ...FULL_RAW, ...overrides });
}

describe("normalizeProviderDecl", () => {
  it("full kebab-key block round-trips", () => {
    expect(normalizeProviderDecl(FULL_RAW)).toEqual({
      id: "sol",
      entry: "provider.ts",
      abi: 1,
      sessionSemantics: "stateless-replay",
      defaultModel: "sol-large-2",
      apiKeyEnv: "SOL_API_KEY",
      baseUrlEnv: "SOL_BASE_URL",
      description: "Sol frontier models",
    });
  });

  it("minimal block leaves optionals undefined", () => {
    const d = normalizeProviderDecl({ id: "sol", entry: "provider.ts", abi: 1, "session-semantics": "server-resumable" });
    expect(d.defaultModel).toBeUndefined();
    expect(d.apiKeyEnv).toBeUndefined();
    expect(d.baseUrlEnv).toBeUndefined();
    expect(d.sessionSemantics).toBe("server-resumable");
  });

  it("missing id throws", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, id: undefined })).toThrow(/provider\.id/);
  });

  it("missing entry throws", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, entry: undefined })).toThrow(/provider\.entry/);
  });

  it("non-integer abi throws", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, abi: "1" })).toThrow(/provider\.abi/);
    expect(() => normalizeProviderDecl({ ...FULL_RAW, abi: 1.5 })).toThrow(/provider\.abi/);
  });

  it("unknown session-semantics throws (the only two coherent Lane B values)", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, "session-semantics": "client-transcript" })).toThrow(
      /session-semantics/,
    );
  });

  it("empty optional string throws rather than silently coercing", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, "api-key-env": "" })).toThrow(/api-key-env/);
  });
});

describe("validateProviderDecl", () => {
  it("a well-formed decl at the engine ABI passes", () => {
    expect(validateProviderDecl(decl(), 1)).toEqual({ ok: true });
  });

  it.each(["Sol", "s", "seventeen-chars-x", "so_l"])("id shape %j is rejected by the regex", (id) => {
    expect(PROVIDER_ID_REGEX.test(id)).toBe(false);
    const v = validateProviderDecl(decl({ id }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/invalid/);
  });

  it.each(["claude", "codex", "openai-codex", "google-gemini", "kimi", "laneb"])(
    "reserved id %j is rejected",
    (id) => {
      expect(RESERVED_PROVIDER_IDS.has(id)).toBe(true);
      const v = validateProviderDecl(decl({ id }), 1);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/reserved/);
    },
  );

  it("abi above the engine names both numbers and says upgrade hive", () => {
    const v = validateProviderDecl(decl({ abi: 2 }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("ABI 2");
      expect(v.reason).toContain("provides 1");
      expect(v.reason).toMatch(/upgrade hive/);
    }
  });

  it("abi below the engine names both numbers and says newer plugin", () => {
    const v = validateProviderDecl(decl({ abi: 0 }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("ABI 0");
      expect(v.reason).toMatch(/newer plugin/);
    }
  });

  it("malformed api-key-env name is rejected", () => {
    const v = validateProviderDecl(decl({ "api-key-env": "sol_key" }), 1);
    expect(v.ok).toBe(false);
  });

  it("malformed base-url-env name is rejected", () => {
    const v = validateProviderDecl(decl({ "base-url-env": "1BAD" }), 1);
    expect(v.ok).toBe(false);
  });
});

describe("readInstalledProviderDecls / auditInstalledProviderDecls", () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "kpr394-decl-"));
    const mk = (name: string, yaml: string) => {
      const dir = join(root, "plugins", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.yaml"), yaml);
    };
    mk(
      "hive-plugin-sol",
      "name: hive-plugin-sol\nprovider:\n  id: sol\n  entry: provider.ts\n  abi: 1\n  session-semantics: stateless-replay\n  api-key-env: SOL_API_KEY\n",
    );
    mk("hive-plugin-plain", "name: hive-plugin-plain\nmcp-servers: {}\n");
    return root;
  }

  it("reads provider decls; plugins without a block are skipped", () => {
    const root = makeRoot();
    const decls = readInstalledProviderDecls(["hive-plugin-sol", "hive-plugin-plain"], root);
    expect(decls).toHaveLength(1);
    expect(decls[0]!.plugin).toBe("hive-plugin-sol");
    expect(decls[0]!.decl.id).toBe("sol");
  });

  it("missing manifests are skipped without throwing", () => {
    const root = makeRoot();
    expect(readInstalledProviderDecls(["no-such-plugin"], root)).toEqual([]);
  });

  it("a structurally-invalid provider block is skipped quietly", () => {
    const root = makeRoot();
    const dir = join(root, "plugins", "hive-plugin-bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "name: hive-plugin-bad\nprovider:\n  id: bad\n");
    expect(readInstalledProviderDecls(["hive-plugin-bad"], root)).toEqual([]);
  });

  it("audit: valid decl is an ok row", () => {
    const root = makeRoot();
    const rows = auditInstalledProviderDecls(["hive-plugin-sol"], root, 1);
    expect(rows).toEqual([
      { plugin: "hive-plugin-sol", id: "sol", abi: 1, semantics: "stateless-replay", status: "ok" },
    ]);
  });

  it("audit: abi mismatch is a broken row naming both numbers", () => {
    const root = makeRoot();
    const rows = auditInstalledProviderDecls(["hive-plugin-sol"], root, 2);
    expect(rows[0]!.status).toBe("broken");
    expect(rows[0]!.reason).toContain("ABI 1");
    expect(rows[0]!.reason).toContain("provides 2");
  });

  it("audit: id collision — first ok, second broken with the first's name", () => {
    const root = makeRoot();
    const dir = join(root, "plugins", "hive-plugin-sol2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plugin.yaml"),
      "name: hive-plugin-sol2\nprovider:\n  id: sol\n  entry: provider.ts\n  abi: 1\n  session-semantics: stateless-replay\n",
    );
    const rows = auditInstalledProviderDecls(["hive-plugin-sol", "hive-plugin-sol2"], root, 1);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[1]!.status).toBe("broken");
    expect(rows[1]!.reason).toContain("hive-plugin-sol");
  });

  it("audit: unresolvable entry is a broken row when a resolver is supplied", () => {
    const root = makeRoot();
    const rows = auditInstalledProviderDecls(["hive-plugin-sol"], root, 1, () => false);
    expect(rows[0]!.status).toBe("broken");
    expect(rows[0]!.reason).toMatch(/entry not resolvable/);
  });

  it("BUILTIN_ROUTABLE_PREFIXES covers every resolveProviderModel arm incl. aliases and claude", () => {
    for (const p of ["claude", "openai", "openai-codex", "codex", "gemini", "google-gemini", "grok", "kimi", "deepseek"]) {
      expect(BUILTIN_ROUTABLE_PREFIXES.has(p)).toBe(true);
    }
    expect(BUILTIN_ROUTABLE_PREFIXES.has("laneb")).toBe(false);
  });
});
```

**1f. In `/Users/mokie/github/lane-kpr-394-mature/src/plugins/plugin-loader.test.ts`** — enumerated delta #3, purely additive. Append a new describe at the end of the file:

```ts
describe("normalizeManifest — provider block (KPR-394)", () => {
  it("carries a normalized provider decl through the manifest", () => {
    const manifest = normalizeManifest({
      name: "hive-plugin-sol",
      "mcp-servers": {},
      provider: {
        id: "sol",
        entry: "provider.ts",
        abi: 1,
        "session-semantics": "stateless-replay",
        "api-key-env": "SOL_API_KEY",
      },
    });
    expect(manifest.provider).toEqual({
      id: "sol",
      entry: "provider.ts",
      abi: 1,
      sessionSemantics: "stateless-replay",
      defaultModel: undefined,
      apiKeyEnv: "SOL_API_KEY",
      baseUrlEnv: undefined,
      description: undefined,
    });
  });

  it("absent provider block stays undefined", () => {
    expect(normalizeManifest({ name: "p", "mcp-servers": {} }).provider).toBeUndefined();
  });

  it("a structurally-invalid provider block throws (manifest-invalid skip, MCP-entry precedent)", () => {
    expect(() => normalizeManifest({ name: "p", "mcp-servers": {}, provider: { id: "sol" } })).toThrow(
      /provider\.entry/,
    );
  });
});
```

(`normalizeManifest` is already imported by this test file; if not, add it to the existing import from `./plugin-loader.js`.)

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/plugins/provider-decl.test.ts src/plugins/plugin-loader.test.ts
  # expect: Test Files 2 passed; provider-decl 30 passed, plugin-loader 50 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: R1 — provider-abi barrel + manifest provider block

  LANE_B_PROVIDER_ABI_VERSION=1 + LaneBProviderKit + type-only re-export
  of the frozen contract closure (re-homed by re-export, not moved).
  plugin.yaml gains the provider: block — normalize (structural, throws)
  in the loader; validate (regex/reserved/exact-abi/env-name) in the new
  light provider-decl module shared by CLI, doctor, and the registry.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 2: R2 type relaxations + R3 laneB column

Pure relaxations: every in-tree literal still typechecks, no runtime behavior changes for built-ins, the closed unions **remain** as the built-in table keys. Tests are not typechecked, so the only pre-existing test edits are the runtime-visible R3 record pins (deltas #1/#2).

- [ ] `src/agents/provider-adapters/provider-module.ts` line 68-70: `provider: LaneBProviderId;` → `provider: string;` with the comment line `/** R2 (KPR-394): widened from LaneBProviderId — plugin ids are arbitrary registered strings; in-tree modules keep their literals. */` above it. Drop `LaneBProviderId` from the type import at line 16 (now unused).
- [ ] `src/agents/provider-adapters/types.ts` line 130: `readonly provider: AgentProviderId;` → `readonly provider: string;` (add trailing comment `// R2 (KPR-394): widened — adapters keep their literals; ops surfaces key on strings`). `AgentProviderId`, `SESSION_SEMANTICS`, `sessionSemanticsFor` all stay exactly as-is (built-in exhaustiveness kept where it earns its keep).
- [ ] `src/agents/provider-adapters/turn-scaffold.ts` line 83: `abstract readonly provider: LaneBProviderId;` → `abstract readonly provider: string;`. Remove `LaneBProviderId` from the file's type import if now unused (lint confirms).
- [ ] `src/agents/provider-adapters/turn-assembly.ts` line 174: `provider: LaneBProviderId;` → `provider: string;`. Remove the now-unused `LaneBProviderId` from the line-14 import (keep `GuardrailGate`).
- [ ] `src/agents/provider-adapters/passthrough-providers.ts` line 97: `export function isLaneAProvider(p: AgentProviderId): p is LaneAProviderId {` → `export function isLaneAProvider(p: string): p is LaneAProviderId {`. Remove the `AgentProviderId` type import if now unused.
- [ ] `src/agents/provider-circuit-breaker.ts`: replace every `provider: AgentProviderId` / `provider(: | ,) AgentProviderId` parameter and field with `string` — the complete set at `1d138c5`: `ProviderCircuitOpenError.provider` (:78, :91), `CircuitBreakerSnapshot.provider` (:109), `ProviderCircuitBreaker` constructor (:156), `breakerFor` (:488), `acquire` (:498), `stateFor` (:508). Then delete the now-unused `AgentProviderId` import (:24). Frozen Open-Circuit-Contract fields (KPR-307): type relaxation only, field names/meanings untouched — note this in the commit body.
- [ ] `src/agents/provider-adapters/tool-transport.ts` — R3:
  1. Descriptor type (line 37): `compatibility: Record<"claude" | LaneBProviderId, ProviderToolCompatibility>;` → `compatibility: Record<"claude" | LaneBProviderId | "laneB", ProviderToolCompatibility>;` with a comment: `// R3 (KPR-394): laneB = the single non-Claude value every classify site computes — the generic Lane B column plugin providers read via the partition fallback.`
  2. The three classify literals gain a final `laneB` key: broken block (after `grok: "unsupported",`) add `laneB: "unsupported",`; builtin/subagent block add `laneB: nonClaude,`; default block add `laneB: nonClaudeCompatibility,`.
  3. Replace `partitionInventoryForProvider` (lines 224-239) with:
     ```ts
     export function partitionInventoryForProvider(
       inventory: readonly HiveToolInventoryEntry[],
       provider: string,
     ): { bridgeable: HiveToolInventoryEntry[]; omitted: OmittedToolRecord[] } {
       const bridgeable: HiveToolInventoryEntry[] = [];
       const omitted: OmittedToolRecord[] = [];
       for (const entry of inventory) {
         const columns = entry.compatibility as Partial<Record<string, ProviderToolCompatibility>>;
         // R3 (KPR-394): built-in ids read their own column (bit-identical to
         // pre-R3, which the type guaranteed present); non-built-in (plugin)
         // ids fall back to the generic laneB column. A record carrying
         // neither column (a stale hand-built literal) is honestly
         // unsupported — never silently bridged.
         const compatibility = columns[provider] ?? columns.laneB ?? "unsupported";
         if (BRIDGEABLE_COMPATIBILITIES.has(compatibility)) {
           bridgeable.push(entry);
         } else {
           omitted.push({ name: entry.name, transport: entry.transport, compatibility });
         }
       }
       return { bridgeable, omitted };
     }
     ```
- [ ] **C16 record-literal sweep (checkbox — paste output into the task log):** the complete set of `compatibility: {` literal sites in the repo (swept at plan time; re-run and reconcile):
  ```bash
  grep -rn "compatibility: {" src/ --include="*.ts" -l
  # plan-time result: tool-transport.ts (source, 3 — edited above);
  # tests: tool-transport.test.ts(7), turn-assembly.test.ts(4),
  # openai-agents-adapter.test.ts(4), codex-subscription-adapter.test.ts(4),
  # gemini-interactions-adapter.test.ts(2), grok-gateway-adapter.test.ts(1),
  # tool-bridge.test.ts(1), agent-manager.test.ts(3),
  # prefix-builder.provider.test.ts(2), toolkit-section.test.ts(1),
  # agent-runner.test.ts (assertion at :1178).
  ```
  Of these, only literals used as **assertion expectations against classify output** need edits (they observe the new `laneB` key at runtime): the six `toEqual` sites in `tool-transport.test.ts` (:20, :71, :88, :106, :121, :159) and the one in `agent-runner.test.ts` (:1178). Every other site is a hand-built *input* literal (five columns) — the partition and bridge read columns by key, so they run unchanged; **no edits** there (and no "compile-forced" claim anywhere — tests are not typechecked).
- [ ] `src/agents/provider-adapters/tool-transport.test.ts` — enumerated delta #1: add `laneB: <the record's openai value>` as the final key of each of the six pinned records above, then append 4 new tests at the end of the partition describe:
  ```ts
  it("R3: a plugin provider id reads the laneB fallback column (bridgeable)", () => {
    const entry = makeEntry(
      classifyToolTransport({ name: "mcp__memory__view", transport: "sdk-in-process", source: "engine" }),
    );
    const { bridgeable, omitted } = partitionInventoryForProvider([entry], "sol");
    expect(bridgeable).toEqual([entry]);
    expect(omitted).toEqual([]);
  });

  it("R3: claude-only stays omitted for a plugin id, with the truthful reason", () => {
    const entry = makeEntry(
      classifyToolTransport({ name: "WebSearch", transport: "claude-builtin", source: "sdk-builtin" }),
    );
    const { bridgeable, omitted } = partitionInventoryForProvider([entry], "sol");
    expect(bridgeable).toEqual([]);
    expect(omitted).toEqual([{ name: "WebSearch", transport: "claude-builtin", compatibility: "claude-only" }]);
  });

  it("R3: a record with neither the provider column nor laneB is honestly unsupported", () => {
    const entry = {
      ...makeEntry(classifyToolTransport({ name: "stale", transport: "stdio", source: "plugin" })),
      compatibility: { claude: "direct", openai: "mcp-bridge-candidate", gemini: "mcp-bridge-candidate", codex: "mcp-bridge-candidate", grok: "mcp-bridge-candidate" },
    } as any;
    const { bridgeable, omitted } = partitionInventoryForProvider([entry], "sol");
    expect(bridgeable).toEqual([]);
    expect(omitted[0]!.compatibility).toBe("unsupported");
  });

  it("R3: built-in ids read their OWN column even when laneB diverges (precedence pin)", () => {
    const entry = {
      ...makeEntry(classifyToolTransport({ name: "diverge", transport: "stdio", source: "plugin" })),
      compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only", grok: "claude-only", laneB: "mcp-bridge-candidate" },
    } as any;
    const { bridgeable } = partitionInventoryForProvider([entry], "openai");
    expect(bridgeable).toEqual([]); // own column wins; laneB is fallback only
  });
  ```
  (Adapt `makeEntry` to this file's existing inventory-entry helper — the partition describe around line 196 already builds entries; reuse its exact helper name and shape.)
- [ ] `src/agents/agent-runner.test.ts` — enumerated delta #2: at line 1178, add `laneB:` = the record's `openai` value as the final key. Nothing else.
- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/provider-adapters/ src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts \
    src/channels/dispatcher.test.ts src/agents/provider-circuit-breaker.test.ts
  # expect: provider-adapters 544 (540 + 4), agent-runner 179, agent-manager 230,
  #         dispatcher 91, breaker 29 — all passed, no other file edited
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: R2/R3 — provider type relaxations + laneB compatibility column

  Provider fields/params widen from closed literal unions to string across
  provider-module, adapter contract, scaffold, assembly, partition,
  breaker, isLaneAProvider. Closed unions remain as built-in table keys.
  R3: classify sites emit the generic laneB column; the partition reads
  own-column ?? laneB ?? unsupported — built-ins bit-identical.
  Open-Circuit Contract fields: type relaxation only (KPR-307 unchanged).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 3: Runtime provider registry + fixture + session-store overlay

**3a. Create `/Users/mokie/github/lane-kpr-394-mature/src/agents/provider-adapters/provider-registry.ts`:**

```ts
/**
 * KPR-394 (§4.3): the runtime provider registry — the single runtime source
 * of provider truth. Built-ins seed from LANE_B_PROVIDER_MODULES +
 * SESSION_SEMANTICS at module load (both tables stay; they ARE the seed).
 * Plugin providers enter via the two-phase boot load:
 *   phase (a) declarePluginProviders() — synchronous, called from the
 *   AgentManager constructor's manifest pass: every declared id is
 *   registered immediately in a declared-not-yet-loaded state carrying
 *   declared-broken turn semantics, so from the first instant a turn routed
 *   at the prefix gets the honest TurnAssemblyError, never the Claude
 *   fallback.
 *   phase (b) activateDeclaredProviders() — async import() + factory call +
 *   kit injection, awaited by index.ts immediately after manager
 *   construction, BEFORE bgTaskManager.start()/scanOrphans() (their
 *   completion callbacks can already dispatch turns).
 *
 * Module-global state, deliberately: resolveProviderModel is a module-scope
 * pure function in agent-manager.ts, also consumed statically by
 * providerFor and prepareSpawn — threading a manager instance into those
 * call sites is exactly what the spec's §4.3 planner note forbids.
 *
 * Boot-only (§4.6): SIGUSR1 never loads or unloads provider code. ESM
 * import caching makes reload-in-place impossible; the install path
 * restarts anyway.
 */
import { pathToFileURL } from "node:url";
import { createLogger } from "../../logging/logger.js";
import type { LoadedPlugin, PluginProviderDecl } from "../../plugins/types.js";
import { resolvePluginServerPath } from "../../plugins/plugin-loader.js";
import { BUILTIN_ROUTABLE_PREFIXES, validateProviderDecl } from "../../plugins/provider-decl.js";
import { LANE_B_PROVIDER_ABI_VERSION, type LaneBProviderKit } from "./provider-abi.js";
import { LANE_B_PROVIDER_MODULES } from "./provider-modules.js";
import type { LaneBProviderModule } from "./provider-module.js";
import { SESSION_SEMANTICS, type SessionSemantics } from "./types.js";
import { LaneBTurnScaffold } from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";

const log = createLogger("provider-registry");

export interface RegisteredProvider {
  id: string;
  module: LaneBProviderModule;
  semantics: SessionSemantics;
  source: "builtin" | { plugin: string };
  /** Plugin only: the manifest-named slice keys the manager resolves per
   *  spawn (C7/C15 — engine resolves, module consumes opaquely). */
  slice?: Pick<PluginProviderDecl, "defaultModel" | "apiKeyEnv" | "baseUrlEnv">;
}

interface DeclaredPending {
  id: string;
  plugin: string;
  decl: PluginProviderDecl;
  entryPath: string;
}

interface BrokenProvider {
  plugin: string;
  reason: string;
}

const active = new Map<string, RegisteredProvider>();
const declared = new Map<string, DeclaredPending>();
const broken = new Map<string, BrokenProvider>();

// Built-in seed — at module load, once per process.
for (const [id, module] of Object.entries(LANE_B_PROVIDER_MODULES)) {
  active.set(id, {
    id,
    module,
    semantics: SESSION_SEMANTICS[id as keyof typeof SESSION_SEMANTICS],
    source: "builtin",
  });
}

/** §4.2: the engine-injected kit — the RUNNING engine's shared layer by
 *  reference, so shared fixes cover plugin providers structurally. */
export function buildProviderKit(): LaneBProviderKit {
  return {
    abiVersion: LANE_B_PROVIDER_ABI_VERSION,
    LaneBTurnScaffold,
    runBoundedDispatchLoop,
    sse: { splitSseEvents, parseSseEvent, isSseDone },
    createLogger,
  };
}

function pluginOwnerOf(id: string): string | undefined {
  const a = active.get(id);
  if (a && a.source !== "builtin") return a.source.plugin;
  return declared.get(id)?.plugin ?? broken.get(id)?.plugin;
}

function clearPluginState(id: string): void {
  if (active.get(id)?.source !== "builtin") active.delete(id);
  declared.delete(id);
  broken.delete(id);
}

/**
 * Phase (a) — synchronous declaration. Deterministic first-wins on
 * collisions (plugin order = appConfig.plugins order); the SECOND registrant
 * of an id is rejected with both plugin names logged, and the id's routing
 * state stays with the first (never last-wins shadowing; edge 1). Re-declare
 * from the SAME plugin is idempotent (test/manager re-construction).
 *
 * Ordering note (plan-review r1 fix): the cross-plugin collision check runs
 * BEFORE validation-driven `broken.set`. Checking collision first means an
 * invalid second declaration for an id another plugin already owns never
 * touches `broken`/`declared` for that id — it is rejected outright. Doing
 * validation first would let the second plugin's (possibly invalid) verdict
 * overwrite/shadow the first registrant's row during the phase a→b window
 * and leave a stale broken entry behind once the first registrant activates.
 */
export function declarePluginProviders(
  plugins: readonly LoadedPlugin[],
  opts: { hiveHome: string; distDir?: string },
): void {
  for (const plugin of plugins) {
    const decl = plugin.manifest.provider;
    if (!decl) continue;
    const id = decl.id;
    const owner = pluginOwnerOf(id);
    if (owner === plugin.name) {
      clearPluginState(id); // idempotent re-declare
    } else if (owner !== undefined) {
      // Cross-plugin collision — checked BEFORE validation (see the note
      // above) so an invalid second declaration can never clobber or
      // shadow the id it doesn't own. First registration wins
      // deterministically; the second is rejected with both plugin names
      // logged, and the id's routing state stays with the first — never
      // last-wins shadowing.
      log.error("Provider id collision — first registration wins, second rejected (KPR-394 edge 1)", {
        provider: id,
        first: owner,
        second: plugin.name,
      });
      continue;
    }
    const verdict = validateProviderDecl(decl, LANE_B_PROVIDER_ABI_VERSION);
    if (!verdict.ok) {
      broken.set(id, { plugin: plugin.name, reason: verdict.reason });
      log.error("Provider plugin declaration invalid — declared-broken (honest per-turn failure)", {
        provider: id,
        plugin: plugin.name,
        reason: verdict.reason,
      });
      continue;
    }
    const resolved = resolvePluginServerPath(plugin.name, decl.entry, {
      hiveHome: opts.hiveHome,
      distDir: opts.distDir,
    });
    if ("reason" in resolved) {
      broken.set(id, {
        plugin: plugin.name,
        reason: `compiled entry not resolvable: ${resolved.reason}`,
      });
      log.error("Provider plugin entry not resolvable — declared-broken until restart (§4.6)", {
        provider: id,
        plugin: plugin.name,
        entry: decl.entry,
        pathsChecked: resolved.pathsChecked,
      });
      continue;
    }
    declared.set(id, { id, plugin: plugin.name, decl, entryPath: resolved.path });
    log.info("Provider plugin declared (phase a) — awaiting boot activation", {
      provider: id,
      plugin: plugin.name,
      semantics: decl.sessionSemantics,
    });
  }
}

/**
 * Phase (b) — async activation. The factory is called once, synchronously
 * after import; a throw, a non-conforming return (missing createAdapter),
 * or a provider/manifest-id mismatch ⇒ declared-broken (§4.2, edge 3 — the
 * manifest is the curator-reviewed truth).
 */
export async function activateDeclaredProviders(
  importFn: (entryPath: string) => Promise<any> = (p) => import(pathToFileURL(p).href),
): Promise<void> {
  for (const [id, pending] of [...declared]) {
    try {
      const mod = await importFn(pending.entryPath);
      const factory = mod?.createProviderModule;
      if (typeof factory !== "function") {
        throw new Error("entry does not export createProviderModule(kit)");
      }
      const module: LaneBProviderModule = factory(buildProviderKit());
      if (!module || typeof module.createAdapter !== "function") {
        throw new Error("factory did not return a LaneBProviderModule (missing createAdapter)");
      }
      if (module.provider !== id) {
        throw new Error(
          `module.provider '${String(module.provider)}' does not match manifest id '${id}' — the manifest is the curator-reviewed truth`,
        );
      }
      declared.delete(id);
      active.set(id, {
        id,
        module,
        semantics: pending.decl.sessionSemantics,
        source: { plugin: pending.plugin },
        slice: {
          defaultModel: pending.decl.defaultModel,
          apiKeyEnv: pending.decl.apiKeyEnv,
          baseUrlEnv: pending.decl.baseUrlEnv,
        },
      });
      log.info("Provider plugin activated — full Lane B surface live", {
        provider: id,
        plugin: pending.plugin,
        semantics: pending.decl.sessionSemantics,
      });
    } catch (err) {
      declared.delete(id);
      const reason = err instanceof Error ? err.message : String(err);
      broken.set(id, { plugin: pending.plugin, reason });
      log.error("Provider plugin failed to load — declared-broken (honest per-turn failure, no Claude fallback)", {
        provider: id,
        plugin: pending.plugin,
        reason,
      });
    }
  }
}

/** Active providers only (built-in or activated plugin) — the construction
 *  sites' lookup. */
export function getRegisteredProvider(id: string): RegisteredProvider | undefined {
  return active.get(id);
}

/** True for any PLUGIN-declared id in any state (active, still-declared,
 *  broken) — the resolveProviderModel consult. Built-ins never reach it
 *  (their hardcoded arms fire first). */
export function isPluginDeclaredProvider(id: string): boolean {
  const a = active.get(id);
  return (a !== undefined && a.source !== "builtin") || declared.has(id) || broken.has(id);
}

/** Plugin ids in any state — the model-catalog acceptance set (§4.11). */
export function listPluginProviderIds(): string[] {
  const ids = new Set<string>();
  for (const [id, p] of active) if (p.source !== "builtin") ids.add(id);
  for (const id of declared.keys()) ids.add(id);
  for (const id of broken.keys()) ids.add(id);
  return [...ids];
}

/** §4.3: honest text for a routed-but-unconstructable provider id. */
export function describeUnroutableProvider(id: string): string {
  const b = broken.get(id);
  if (b) return `provider '${id}' from plugin '${b.plugin}' failed to load: ${b.reason}`;
  const d = declared.get(id);
  if (d) {
    return `provider '${id}' from plugin '${d.plugin}' is declared but not yet activated (boot-ordering fault — activateProviderPlugins() must be awaited before spawn-capable surfaces start)`;
  }
  return `provider '${id}' is not registered`;
}

/**
 * §4.3 semantics overlay: built-in Record first, plugin overlay second
 * (declared and broken ids answer with their manifest semantics — the
 * write side must not persist a handle for a stateless-replay provider
 * even while it is broken). Unknown ⇒ undefined.
 */
export function sessionSemanticsIfKnown(provider: string): SessionSemantics | undefined {
  const builtin = (SESSION_SEMANTICS as Partial<Record<string, SessionSemantics>>)[provider];
  if (builtin) return builtin;
  return active.get(provider)?.semantics ?? declared.get(provider)?.decl.sessionSemantics ?? (broken.has(provider) ? brokenSemantics(provider) : undefined);
}

function brokenSemantics(provider: string): SessionSemantics {
  // A broken provider never runs a turn, so no handle is ever produced;
  // fail-safe stateless-replay (never persist a handle).
  return "stateless-replay";
}

/** Route-side lookup: unreachable-unknown defaults fail-safe (§4.3). */
export function sessionSemanticsForRoute(provider: string): SessionSemantics {
  return sessionSemanticsIfKnown(provider) ?? "stateless-replay";
}

export interface OrphanProviderModel {
  agentId: string;
  model: string;
  prefix: string;
}

/**
 * §4.6: boot/reload-time warn for every agent whose model carries a
 * /-prefix matching no registered or built-in provider — such turns run on
 * Claude via the unknown-prefix canon (e.g. after `hive plugin remove`).
 * Returns the orphan list so callers/tests can observe it.
 */
export function warnOrphanProviderPrefixes(
  agents: readonly { agentId: string; model: string }[],
): OrphanProviderModel[] {
  const orphans: OrphanProviderModel[] = [];
  for (const a of agents) {
    const slash = a.model.indexOf("/");
    if (slash <= 0) continue;
    const prefix = a.model.slice(0, slash).toLowerCase();
    if (BUILTIN_ROUTABLE_PREFIXES.has(prefix) || isPluginDeclaredProvider(prefix)) continue;
    orphans.push({ agentId: a.agentId, model: a.model, prefix });
    log.warn(
      "Agent model carries an unknown provider prefix — turns run on Claude via the unknown-prefix canon; if this id belonged to a removed provider plugin, repoint the agent's model",
      { agentId: a.agentId, model: a.model, prefix },
    );
  }
  return orphans;
}

// ── Test seams (never called in production paths) ──────────────────────────

/** Register an already-built plugin module directly (manager tests). */
export function __registerActivePluginProviderForTests(entry: RegisteredProvider): void {
  active.set(entry.id, entry);
}

/** Mark an id declared-broken directly (manager tests). */
export function __markBrokenPluginProviderForTests(id: string, b: BrokenProvider): void {
  broken.set(id, b);
}

/** Remove all plugin state; built-in seed stays. */
export function __resetPluginProvidersForTests(): void {
  for (const [id, p] of [...active]) if (p.source !== "builtin") active.delete(id);
  declared.clear();
  broken.clear();
}
```

**3b. Fixture — create `test-fixtures/provider-home/plugins/hive-plugin-sol/plugin.yaml`:**

```yaml
# KPR-394 in-repo test fixture (spec §7) — NOT a published example plugin.
# Lives outside src/ so tsc/eslint/prettier/npm-pack never see it.
name: hive-plugin-sol
description: In-repo test fixture for KPR-394 provider-plugin loading
provider:
  id: sol
  entry: provider.ts
  abi: 1
  session-semantics: stateless-replay
  default-model: sol-large-2
  api-key-env: SOL_API_KEY
  base-url-env: SOL_BASE_URL
  description: Sol test provider (fixture)
```

and `test-fixtures/provider-home/plugins/hive-plugin-sol/dist/provider.js` (plain ESM JS — the "compiled" artifact):

```js
// KPR-394 fixture entry — the shape a real provider plugin's compiled
// dist/provider.js has. Factory + kit round-trip + fake adapter.
export function createProviderModule(kit) {
  if (kit.abiVersion !== 1) {
    throw new Error(`fixture built for provider ABI 1, engine offers ${kit.abiVersion}`);
  }
  const constructions = [];
  const module = {
    provider: "sol",
    createAdapter(args) {
      constructions.push(args);
      return {
        provider: "sol",
        wasAborted: false,
        abort() {},
        async runTurn() {
          return {
            text: `sol turn ok (model=${args.route.model ?? ""})`,
            sessionId: "",
            costUsd: 0,
            durationMs: 1,
            llmMs: 1,
            toolMs: 0,
            toolCalls: 0,
            toolSummary: "",
            streamed: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 0,
            compactions: 0,
          };
        },
      };
    },
  };
  // Test observability only.
  module.__constructions = constructions;
  module.__kit = kit;
  return module;
}
```

**3c. `src/agents/session-store.ts`** — registry-aware read + R2 widenings:
- Imports (lines 3-8): remove `SESSION_SEMANTICS` and `AgentProviderId` from the `./provider-adapters/types.js` import (keep `persistsResumableHandle`, `type SessionSemantics`); add:
  ```ts
  import { sessionSemanticsIfKnown } from "./provider-adapters/provider-registry.js";
  ```
- Line 17: `provider?: AgentProviderId;` → `provider?: string;` (keep the comment).
- Line 38: `provider: AgentProviderId | undefined;` → `provider: string | undefined;`
- Line 116: replace
  ```ts
      const semantics: SessionSemantics | undefined = SESSION_SEMANTICS[doc.provider];
  ```
  with
  ```ts
      // KPR-394 (§4.3): registry-aware — a REGISTERED plugin provider's row
      // is honored per its declared semantics; genuinely unknown provider
      // strings keep the KPR-347 fail-closed posture (no handle).
      const semantics: SessionSemantics | undefined = sessionSemanticsIfKnown(doc.provider);
  ```
- Line 156: `provider: AgentProviderId` → `provider: string`.

**3d. `src/agents/session-store.test.ts`** — enumerated delta #5, purely additive: append after the fail-closed test (line ~119), inside the same describe:

```ts
  it("KPR-394: a REGISTERED server-resumable plugin provider's row returns its handle", async () => {
    const { __registerActivePluginProviderForTests, __resetPluginProvidersForTests } = await import(
      "./provider-adapters/provider-registry.js"
    );
    __registerActivePluginProviderForTests({
      id: "solr",
      module: { provider: "solr", createAdapter: () => ({}) as any },
      semantics: "server-resumable",
      source: { plugin: "hive-plugin-solr" },
    });
    try {
      mocks.findOne.mockResolvedValueOnce(doc("srv-handle-1", "solr"));
      await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
        sessionId: "srv-handle-1",
        provider: "solr",
      });
    } finally {
      __resetPluginProvidersForTests();
    }
  });

  it("KPR-394: a registered stateless-replay plugin provider's row yields no handle (belt-and-braces)", async () => {
    const { __registerActivePluginProviderForTests, __resetPluginProvidersForTests } = await import(
      "./provider-adapters/provider-registry.js"
    );
    __registerActivePluginProviderForTests({
      id: "sol",
      module: { provider: "sol", createAdapter: () => ({}) as any },
      semantics: "stateless-replay",
      source: { plugin: "hive-plugin-sol" },
    });
    try {
      mocks.findOne.mockResolvedValueOnce(doc("stray-id", "sol"));
      await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
        sessionId: undefined,
        provider: "sol",
      });
    } finally {
      __resetPluginProvidersForTests();
    }
  });
```

(If this suite's logger mock interferes with the registry import, follow the file's existing `vi.mock` hoisting — the registry only needs `createLogger` to return an object with `info`/`warn`/`error`, which the existing mock provides.)

**3e. Create `src/agents/provider-adapters/provider-registry.test.ts`** — 18 tests:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

// Assertable logs (collision both-names, orphan warns).
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { loadPlugins } from "../../plugins/plugin-loader.js";
import { LANE_B_PROVIDER_MODULES } from "./provider-modules.js";
import { LaneBTurnScaffold } from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";
import {
  __markBrokenPluginProviderForTests,
  __registerActivePluginProviderForTests,
  __resetPluginProvidersForTests,
  activateDeclaredProviders,
  buildProviderKit,
  declarePluginProviders,
  describeUnroutableProvider,
  getRegisteredProvider,
  isPluginDeclaredProvider,
  listPluginProviderIds,
  sessionSemanticsForRoute,
  sessionSemanticsIfKnown,
  warnOrphanProviderPrefixes,
} from "./provider-registry.js";

const FIXTURE_HOME = resolve(import.meta.dirname, "../../../test-fixtures/provider-home");

function makeDecl(overrides: Record<string, unknown> = {}) {
  return {
    id: "sol",
    entry: "provider.ts",
    abi: 1,
    sessionSemantics: "stateless-replay" as const,
    apiKeyEnv: "SOL_API_KEY",
    ...overrides,
  };
}

function makePlugin(name: string, decl: ReturnType<typeof makeDecl> | undefined) {
  return {
    name,
    dir: `/nonexistent/${name}`,
    manifest: { name, mcpServers: {}, agentSeeds: [], provider: decl },
    brokenServers: {},
  } as any;
}

/** Declares against the real fixture on disk (entry resolves for real). */
function declareFixture(decl = makeDecl()) {
  declarePluginProviders([makePlugin("hive-plugin-sol", decl)], { hiveHome: FIXTURE_HOME });
}

const fakeModule = (id: string) => ({ provider: id, createAdapter: vi.fn(() => ({}) as any) });
const importStubFor = (mod: unknown) => vi.fn(async () => ({ createProviderModule: () => mod }));

afterEach(() => {
  __resetPluginProvidersForTests();
  vi.clearAllMocks();
});

describe("built-in seed", () => {
  it("all four Lane B built-ins are active with their table modules and semantics", () => {
    for (const id of ["codex", "openai", "gemini", "grok"] as const) {
      const p = getRegisteredProvider(id)!;
      expect(p.source).toBe("builtin");
      expect(p.module).toBe(LANE_B_PROVIDER_MODULES[id]);
    }
    expect(getRegisteredProvider("codex")!.semantics).toBe("stateless-replay");
    expect(getRegisteredProvider("gemini")!.semantics).toBe("server-resumable");
  });

  it("built-ins are not plugin-declared (resolveProviderModel's hardcoded arms own them)", () => {
    expect(isPluginDeclaredProvider("codex")).toBe(false);
    expect(listPluginProviderIds()).toEqual([]);
  });
});

describe("declare (phase a)", () => {
  it("valid decl → declared-not-yet-loaded: routable, unconstructable, honest text", () => {
    declareFixture();
    expect(isPluginDeclaredProvider("sol")).toBe(true);
    expect(getRegisteredProvider("sol")).toBeUndefined();
    expect(describeUnroutableProvider("sol")).toMatch(/declared but not yet activated/);
  });

  it("reserved id → declared-broken with the reserved reason", () => {
    declarePluginProviders([makePlugin("p1", makeDecl({ id: "kimi" }))], { hiveHome: FIXTURE_HOME });
    expect(isPluginDeclaredProvider("kimi")).toBe(true);
    expect(describeUnroutableProvider("kimi")).toMatch(/reserved/);
  });

  it("abi mismatch → declared-broken naming both numbers", () => {
    declarePluginProviders([makePlugin("p1", makeDecl({ abi: 2 }))], { hiveHome: FIXTURE_HOME });
    expect(describeUnroutableProvider("sol")).toMatch(/ABI 2/);
    expect(describeUnroutableProvider("sol")).toMatch(/provides 1/);
  });

  it("unresolvable entry → declared-broken until restart", () => {
    declarePluginProviders([makePlugin("no-such-plugin", makeDecl())], { hiveHome: FIXTURE_HOME });
    expect(describeUnroutableProvider("sol")).toMatch(/entry not resolvable/);
  });

  it("collision: first wins, second rejected with both names logged — even when the second decl is itself invalid (order fix)", () => {
    declareFixture();
    declarePluginProviders([makePlugin("hive-plugin-sol2", makeDecl({ abi: 2 }))], { hiveHome: FIXTURE_HOME });
    // First registrant's state is untouched: the collision check runs
    // BEFORE validation, so the second plugin's invalid (abi-mismatch)
    // decl never overwrites or shadows the id it doesn't own.
    expect(describeUnroutableProvider("sol")).toMatch(/declared but not yet activated/); // first's state intact
    expect(describeUnroutableProvider("sol")).not.toMatch(/ABI/); // no stray broken row from the second decl
    const collisionLog = mockLog.error.mock.calls.find(([msg]) => String(msg).includes("collision"));
    expect(collisionLog![1]).toMatchObject({ provider: "sol", first: "hive-plugin-sol", second: "hive-plugin-sol2" });
  });

  it("re-declare from the SAME plugin is idempotent (manager re-construction)", () => {
    declareFixture();
    declareFixture();
    expect(mockLog.error.mock.calls.filter(([m]) => String(m).includes("collision"))).toHaveLength(0);
    expect(isPluginDeclaredProvider("sol")).toBe(true);
  });
});

describe("activate (phase b)", () => {
  it("success: active with plugin source, manifest semantics, and slice", async () => {
    declareFixture();
    await activateDeclaredProviders(importStubFor(fakeModule("sol")));
    const p = getRegisteredProvider("sol")!;
    expect(p.source).toEqual({ plugin: "hive-plugin-sol" });
    expect(p.semantics).toBe("stateless-replay");
    expect(p.slice).toEqual({ defaultModel: undefined, apiKeyEnv: "SOL_API_KEY", baseUrlEnv: undefined });
    expect(listPluginProviderIds()).toEqual(["sol"]);
  });

  it("kit: abiVersion 1 and the RUNNING engine's layer by reference", () => {
    const kit = buildProviderKit();
    expect(kit.abiVersion).toBe(1);
    expect(kit.LaneBTurnScaffold).toBe(LaneBTurnScaffold);
    expect(kit.runBoundedDispatchLoop).toBe(runBoundedDispatchLoop);
    expect(kit.sse).toEqual({ splitSseEvents, parseSseEvent, isSseDone });
    expect(typeof kit.createLogger).toBe("function");
  });

  it("missing createProviderModule export → declared-broken", async () => {
    declareFixture();
    await activateDeclaredProviders(vi.fn(async () => ({})));
    expect(getRegisteredProvider("sol")).toBeUndefined();
    expect(describeUnroutableProvider("sol")).toMatch(/does not export createProviderModule/);
  });

  it("throwing factory → declared-broken with the thrown message", async () => {
    declareFixture();
    await activateDeclaredProviders(
      vi.fn(async () => ({
        createProviderModule: () => {
          throw new Error("boom at factory");
        },
      })),
    );
    expect(describeUnroutableProvider("sol")).toMatch(/boom at factory/);
  });

  it("non-conforming return (no createAdapter) → declared-broken", async () => {
    declareFixture();
    await activateDeclaredProviders(vi.fn(async () => ({ createProviderModule: () => ({ provider: "sol" }) })));
    expect(describeUnroutableProvider("sol")).toMatch(/missing createAdapter/);
  });

  it("module.provider ≠ manifest id → declared-broken (manifest is curator truth)", async () => {
    declareFixture();
    await activateDeclaredProviders(importStubFor(fakeModule("luna")));
    expect(describeUnroutableProvider("sol")).toMatch(/does not match manifest id/);
  });
});

describe("semantics overlay + orphans + fixture e2e", () => {
  it("sessionSemanticsIfKnown: builtin / active plugin / declared plugin / unknown", async () => {
    expect(sessionSemanticsIfKnown("gemini")).toBe("server-resumable");
    declarePluginProviders([makePlugin("hive-plugin-sol", makeDecl({ sessionSemantics: "server-resumable" }))], {
      hiveHome: FIXTURE_HOME,
    });
    expect(sessionSemanticsIfKnown("sol")).toBe("server-resumable"); // declared, pre-activation
    await activateDeclaredProviders(importStubFor(fakeModule("sol")));
    expect(sessionSemanticsIfKnown("sol")).toBe("server-resumable"); // active
    expect(sessionSemanticsIfKnown("zeta")).toBeUndefined();
  });

  it("sessionSemanticsForRoute defaults unknown to stateless-replay (never persist a handle)", () => {
    expect(sessionSemanticsForRoute("zeta")).toBe("stateless-replay");
  });

  it("warnOrphanProviderPrefixes: bare + builtin + declared skipped; unknown returned + warned", () => {
    declareFixture();
    const orphans = warnOrphanProviderPrefixes([
      { agentId: "a1", model: "claude-opus-5" },
      { agentId: "a2", model: "google-gemini/gemini-3.6-pro" },
      { agentId: "a3", model: "claude/claude-opus-5" },
      { agentId: "a4", model: "sol/sol-large-2" },
      { agentId: "a5", model: "zeta/zeta-9" },
    ]);
    expect(orphans).toEqual([{ agentId: "a5", model: "zeta/zeta-9", prefix: "zeta" }]);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("fixture e2e: real loadPlugins → declare → REAL dynamic import → adapter turn", async () => {
    const plugins = loadPlugins(["hive-plugin-sol"], FIXTURE_HOME);
    expect(plugins).toHaveLength(1);
    declarePluginProviders(plugins, { hiveHome: FIXTURE_HOME });
    await activateDeclaredProviders(); // default importFn — real import()
    const p = getRegisteredProvider("sol")!;
    expect(p.slice?.defaultModel).toBe("sol-large-2");
    const adapter = p.module.createAdapter({
      name: "Sol",
      route: { model: "sol-large-2" },
      assembly: {} as any,
      context: "primary",
      deps: {},
    });
    const result = await adapter.runTurn({ prompt: "hi" });
    expect(result.text).toContain("sol turn ok (model=sol-large-2)");
  });
});
```

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/provider-adapters/provider-registry.test.ts src/agents/session-store.test.ts \
    src/agents/provider-adapters/
  # expect: provider-registry 18 passed, session-store 19 passed,
  #         provider-adapters directory 562 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: runtime provider registry — two-phase load, semantics overlay

  provider-registry.ts: builtin seed from LANE_B_PROVIDER_MODULES +
  SESSION_SEMANTICS (module-global — resolveProviderModel is static);
  declare (sync, honest-failure routable from the first instant) +
  activate (async import + factory + engine-injected kit). Collision:
  deterministic first-wins, second rejected with both names, never
  last-wins shadowing. Session-store reads semantics through the overlay;
  fail-closed unknown-provider posture unchanged. In-repo fixture plugin
  under test-fixtures/ (spec §7 — not a published example).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 4: Manager integration + boot ordering (§4.3/§4.4/§4.6)

All edits in `/Users/mokie/github/lane-kpr-394-mature/src/agents/agent-manager.ts`, `src/index.ts`, and `src/agents/agent-manager.test.ts`.

**4a. Imports (agent-manager.ts top):**
- Delete the `LANE_B_PROVIDER_MODULES` import and its 3-line comment (lines 31-34).
- In the `provider-module.js` type import, drop `LaneBProviderModule` (keep `LaneBModuleDeps`).
- In the `types.js` imports: drop `AgentProviderId` (now unused after 4f) and drop `sessionSemanticsFor` from the value import (keep `persistsResumableHandle`).
- Add `TurnAssemblyError` to the existing `error-classification.js` import (beside `classifyThrown, classifyTurnResult, TURN_DEADLINE_SUBTYPE`).
- Add:
  ```ts
  // KPR-394 (§4.3/§4.4): both Lane B construction sites resolve through the
  // runtime provider registry — builtin seed + hive-plugin-add-loaded
  // modules — via one shared lookup (getRegisteredProvider), so the two
  // sites still cannot drift (KPR-391 §4.3 property preserved).
  import {
    activateDeclaredProviders,
    declarePluginProviders,
    describeUnroutableProvider,
    getRegisteredProvider,
    isPluginDeclaredProvider,
    sessionSemanticsForRoute,
    warnOrphanProviderPrefixes,
    type RegisteredProvider,
  } from "./provider-adapters/provider-registry.js";
  ```

**4b. `ProviderModelRoute` (lines 180-192)** — replace the union with:

```ts
/**
 * KPR-394 (§4.3, R2): flattened from a closed literal union to a generic
 * shape — `provider` is any routable provider string (built-in arms below
 * plus plugin-declared ids from the registry). Construction literals are
 * byte-identical to the pre-394 arms; in-tree `route.provider === "..."`
 * comparisons still narrow. KPR-392/KPR-346 semantics unchanged.
 */
interface ProviderModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
}
```

**4c. `resolveProviderModel` (line 196)** — insert between the `grok` arm and the final Claude fallback:

```ts
  // KPR-394 (§4.3): a DECLARED plugin provider id (registered, still
  // loading, or declared-broken) routes to ITSELF — the honest-failure path
  // lives at adapter construction, never a silent Claude fallback. Only
  // never-declared prefixes fall through to the Claude canon below.
  // Registry state is module-global (this function is module-scope and is
  // also consumed statically by providerFor and prepareSpawn).
  if (isPluginDeclaredProvider(provider)) {
    return { provider, model: providerModel, reasoningEffort };
  }
```

**4d. Constructor (line 527)** — directly after `this.plugins = loadPlugins(...)`:

```ts
    // KPR-394 (§4.3 phase a): synchronous declaration — every declared
    // provider id is honest-failure-routable from the first instant.
    // Phase (b) activation is async and awaited by index.ts via
    // activateProviderPlugins() before any spawn-capable surface starts.
    declarePluginProviders(this.plugins, { hiveHome, distDir: DIST_DIR });
```

**4e. New public methods** — insert directly after `getPlugins()` (line 548):

```ts
  /**
   * KPR-394 (§4.3 phase b / §4.6): dynamic-import + factory-activate every
   * declared provider plugin. index.ts MUST await this immediately after
   * construction, BEFORE bgTaskManager.start()/scanOrphans() — their
   * completion callbacks can already dispatch turns. Boot-only; SIGUSR1
   * never loads or unloads provider code.
   */
  async activateProviderPlugins(): Promise<void> {
    await activateDeclaredProviders();
    this.warnOrphanProviderPrefixes();
  }

  /** KPR-394 (§4.6): orphan-model-prefix warn — boot + SIGUSR1 reload. */
  warnOrphanProviderPrefixes(): void {
    warnOrphanProviderPrefixes(this.registry.getAll().map((a) => ({ agentId: a.id, model: a.model })));
  }
```

**4f. `createProviderAdapter` (lines 571-790):**
- After the Lane A branch (line 603-605) and before the `moduleDeps` block, insert:
  ```ts
    // KPR-394 (§4.3/§4.4): registry lookup — the same shared path the nested
    // delegate runner below resolves through. A declared-broken or
    // still-declared id throws the honest breaker-invisible
    // TurnAssemblyError here, inside runOneSpawnAttempt's recorded try
    // (classifyThrown → non-provider: config faults never trip a breaker or
    // open an outage episode).
    const registered = getRegisteredProvider(route.provider);
    if (!registered) {
      throw new TurnAssemblyError(describeUnroutableProvider(route.provider));
    }
  ```
- Replace the `moduleDeps` providerConfig ternary (lines 619-628) with (keep the preceding block comment, appending one line to it: `// KPR-394: slice resolution generalized — see resolveProviderModuleSlice.`):
  ```ts
    const moduleDeps: LaneBModuleDeps = {
      providerConfig: this.resolveProviderModuleSlice(registered),
      turnHistoryStore: this.turnHistoryStore,
      agentId: config.id,
    };
  ```
- Nested runner module lookup (lines 681-689) — replace with:
  ```ts
        const module = getRegisteredProvider(route.provider)?.module;
        if (!module) {
          // KPR-354 belt-and-braces containment, now also the registry-miss
          // path for any future gap (§4.4) — unreachable while construction
          // is boot-locked, kept as containment.
          return `Delegate turn failed (${call.delegate}): provider ${route.provider} does not execute tools`;
        }
  ```
- Top-level tail (lines 779-789) — replace the table lookup with:
  ```ts
    // KPR-394 (§4.4): same registry entry as the nested runner above —
    // model default chains, primary-only history wiring, and key threading
    // all live in the module entries (builtin or plugin).
    return registered.module.createAdapter({
      name: config.name,
      route: { model: route.model, reasoningEffort: route.reasoningEffort },
      assembly,
      context: "primary",
      deps: moduleDeps,
    });
  ```

**4g. Slice resolver** — insert directly above `resolveGrokModuleSlice` (line 801), which stays byte-identical as the grok arm:

```ts
  /**
   * KPR-394 (§4.4): generalized caller-resolved module slice (C7/C15 —
   * engine resolves, module consumes opaquely; a module is never handed a
   * sibling's credential). Built-in arms preserve KPR-391/392 behavior
   * byte-for-byte. Plugin arms resolve the manifest-named keys PER SPAWN:
   * api-key-env on the exact secret-env chain (env → Honeypot; missing ⇒
   * breaker-invisible TurnAssemblyError naming `hive credentials add
   * <KEY>` — rotation takes effect next spawn); base-url-env as plain env
   * validated https-or-loopback (KPR-384 posture: an override redirects
   * credential AND conversation stream). Unset base-url-env ⇒ undefined ⇒
   * the module's own built-in default endpoint (grok-override semantics,
   * generalized).
   */
  private resolveProviderModuleSlice(
    registered: RegisteredProvider,
  ): { agentModel?: string; apiKey?: string; baseUrl?: string } {
    if (registered.source !== "builtin") {
      const slice = registered.slice;
      const baseUrlOverride = slice?.baseUrlEnv ? process.env[slice.baseUrlEnv] : undefined;
      return {
        agentModel: slice?.defaultModel,
        apiKey: slice?.apiKeyEnv
          ? resolveEnvKeyCredential(slice.apiKeyEnv, { instanceId: appConfig.instance.id })
          : undefined,
        baseUrl:
          baseUrlOverride && slice?.baseUrlEnv
            ? assertSafeBaseUrlOverride(baseUrlOverride, slice.baseUrlEnv)
            : undefined,
      };
    }
    switch (registered.id) {
      case "gemini":
        return { agentModel: appConfig.gemini.agentModel, apiKey: appConfig.gemini.apiKey || undefined };
      case "grok":
        return this.resolveGrokModuleSlice();
      case "codex":
        return { agentModel: appConfig.codex.agentModel };
      case "openai":
        return { agentModel: appConfig.openai.agentModel };
      default:
        // Unreachable: the builtin seed is exactly the four Lane B ids.
        return {};
    }
  }
```

**4h. Semantics + providerFor:**
- Line 1069: `sessionSemanticsFor(shaping.route.provider)` → `sessionSemanticsForRoute(shaping.route.provider)`.
- Line 1909: `persistsResumableHandle(sessionSemanticsFor(route.provider))` → `persistsResumableHandle(sessionSemanticsForRoute(route.provider))`.
- Line 901: `providerFor(agentId: string): AgentProviderId | null` → `providerFor(agentId: string): string | null`.

**4i. `src/index.ts`:**
- After the `agentManager = new AgentManager(...)` construction (closing `);` at line 393), insert:
  ```ts
  // KPR-394 (§4.3 phase b / §4.6): activate declared provider plugins
  // BEFORE any spawn-capable surface starts — bgTaskManager.start()/
  // scanOrphans() completion callbacks can already dispatch turns, so the
  // await sits here, immediately after construction. The
  // registerPluginCommands slot further down runs after slackAdapter.start
  // and would open a declared-but-unregistered boot window — deliberately
  // not reused.
  await agentManager.activateProviderPlugins();
  ```
- In `reload()` (the `const reload = async () => {` block), directly after the `agentManager.reloadSkills();` line, add:
  ```ts
    // KPR-394 (§4.6): re-scan for orphan provider-model prefixes after a
    // roster reload (SIGUSR1 or change stream). Never loads provider code.
    agentManager.warnOrphanProviderPrefixes();
  ```

**4j. `src/agents/agent-manager.test.ts`** — enumerated delta #4, purely additive: insert the following describe directly **after** the closing `});` of the `"Lane B grok (KPR-392)"` describe (its helpers — `registry`, `manager`, `makeAgentConfig`, `smsCtx`, `makeRunResult`, `mockLogWarn`, `appConfig`, `mockRunnerSend`, and the four adapter constructor mocks — are all in scope there):

```ts
    describe("provider plugins (KPR-394)", () => {
      let fixture: ReturnType<typeof makeFixtureProviderModule>;

      function makeFixtureProviderModule(id = "sol") {
        const constructions: any[] = [];
        const runTurn = vi.fn(async () => makeRunResult({ text: `${id} says hi` }));
        const abort = vi.fn();
        const module = {
          provider: id,
          createAdapter: vi.fn((args: any) => {
            constructions.push(args);
            return { provider: id, runTurn, abort, wasAborted: false };
          }),
        };
        return { module, constructions, runTurn, abort };
      }

      async function registerSol(slice: Record<string, unknown> | undefined = {
        defaultModel: "sol-large-2",
        apiKeyEnv: "SOL_API_KEY",
        baseUrlEnv: "SOL_BASE_URL",
      }) {
        const reg = await import("./provider-adapters/provider-registry.js");
        fixture = makeFixtureProviderModule();
        reg.__registerActivePluginProviderForTests({
          id: "sol",
          module: fixture.module as any,
          semantics: "stateless-replay",
          source: { plugin: "hive-plugin-sol" },
          slice: slice as any,
        });
        registry._agents.set(
          "agent-sol",
          makeAgentConfig({ id: "agent-sol", name: "AgentSol", model: "sol/sol-large-2:high", coreServers: [] }),
        );
      }

      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
        process.env.SOL_API_KEY = "test-sol-key";
      });

      afterEach(async () => {
        delete process.env.SOL_API_KEY;
        delete process.env.SOL_BASE_URL;
        const reg = await import("./provider-adapters/provider-registry.js");
        reg.__resetPluginProvidersForTests();
      });

      it("routing: registered plugin id maps via providerFor; declared-broken routes to itself; undeclared falls back to claude", async () => {
        await registerSol();
        const reg = await import("./provider-adapters/provider-registry.js");
        reg.__markBrokenPluginProviderForTests("bad", { plugin: "hive-plugin-bad", reason: "abi mismatch" });
        registry._agents.set(
          "agent-bad",
          makeAgentConfig({ id: "agent-bad", name: "AgentBad", model: "bad/bad-1", coreServers: [] }),
        );
        expect(manager.providerFor("agent-sol")).toBe("sol");
        expect(manager.providerFor("agent-bad")).toBe("bad"); // declared-broken: routes, then fails honestly
        registry._agents.set(
          "agent-typo2",
          makeAgentConfig({ id: "agent-typo2", name: "AgentTypo2", model: "zeta/z-1" }),
        );
        expect(manager.providerFor("agent-typo2")).toBe("claude"); // never-declared canon unchanged
      });

      it("primary construction: fixture module builds the adapter with context primary, route model+effort, agentId deps", async () => {
        await registerSol();
        const result = await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-primary" }));
        expect(result.errors).toEqual([]);
        expect(fixture.runTurn).toHaveBeenCalled();
        const args = fixture.constructions[0]!;
        expect(args.context).toBe("primary");
        expect(args.name).toBe("AgentSol");
        expect(args.route).toEqual({ model: "sol-large-2", reasoningEffort: "high" });
        expect(args.deps.agentId).toBe("agent-sol");
        // No builtin adapter and no Claude runner ran.
        expect(mockRunnerSend).not.toHaveBeenCalled();
        expect(mockCodexConstructor).not.toHaveBeenCalled();
      });

      it("slice resolution: agentModel default + env-resolved apiKey; baseUrl undefined when override unset", async () => {
        await registerSol();
        await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-slice" }));
        expect(fixture.constructions[0]!.deps.providerConfig).toEqual({
          agentModel: "sol-large-2",
          apiKey: "test-sol-key",
          baseUrl: undefined,
        });
      });

      it("missing SOL_API_KEY is a config fault that never trips the sol breaker (byte-identical grok contract)", async () => {
        await registerSol();
        delete process.env.SOL_API_KEY;
        for (let i = 0; i < 3; i++) {
          await expect(
            manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: `sms:line-1:kpr394-cred-${i}` })),
          ).rejects.toThrow(/Passthrough credential missing \(authentication\): SOL_API_KEY/);
        }
        process.env.SOL_API_KEY = "test-sol-key";
        const result = await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-cred-ok" }));
        expect(result.errors).toEqual([]);
        expect(manager.circuitBreakers.stateFor("sol")?.state ?? "closed").toBe("closed");
      });

      it("a loopback SOL_BASE_URL override flows to the slice", async () => {
        await registerSol();
        process.env.SOL_BASE_URL = "http://127.0.0.1:4141";
        await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-baseurl-ok" }));
        expect(fixture.constructions[0]!.deps.providerConfig.baseUrl).toBe("http://127.0.0.1:4141");
      });

      it("a cleartext off-box SOL_BASE_URL override is a breaker-invisible config fault", async () => {
        await registerSol();
        process.env.SOL_BASE_URL = "http://evil.example:8317";
        await expect(
          manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-baseurl-bad" })),
        ).rejects.toThrow(/cleartext to a non-loopback host/);
        expect(manager.circuitBreakers.stateFor("sol")?.state ?? "closed").toBe("closed");
      });

      it("declared-broken provider: honest TurnAssemblyError naming plugin + reason; breaker closed; never Claude", async () => {
        const reg = await import("./provider-adapters/provider-registry.js");
        reg.__markBrokenPluginProviderForTests("bad", { plugin: "hive-plugin-bad", reason: "plugin requires provider ABI 2; engine provides 1" });
        registry._agents.set(
          "agent-bad",
          makeAgentConfig({ id: "agent-bad", name: "AgentBad", model: "bad/bad-1", coreServers: [] }),
        );
        await expect(
          manager.spawnTurn(smsCtx({ agentId: "agent-bad", threadId: "sms:line-1:kpr394-broken" })),
        ).rejects.toThrow(/provider 'bad' from plugin 'hive-plugin-bad' failed to load: plugin requires provider ABI 2/);
        expect(manager.circuitBreakers.stateFor("bad")?.state ?? "closed").toBe("closed");
        expect(mockRunnerSend).not.toHaveBeenCalled(); // no silent Claude fallback
      });

      it("nested delegate turn constructs the SAME plugin module with context nested (KPR-354 parity)", async () => {
        await registerSol();
        registry._agents.set(
          "agent-sol",
          makeAgentConfig({
            id: "agent-sol",
            name: "AgentSol",
            model: "sol/sol-large-2",
            delegateServers: ["google"],
            coreServers: [],
          }),
        );
        mockRunnerToolInventory.mockReturnValue([makeSubagentEntry()]);
        await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-nested" }));
        const delegateRunner = fixture.constructions[0]!.assembly.delegateTurnRunner;
        const text = await delegateRunner({
          delegate: "google",
          entry: makeSubagentEntry(),
          prompt: "do the thing",
          workItemContext: undefined,
          signal: new AbortController().signal,
        });
        expect(text).toBe("sol says hi");
        const nested = fixture.constructions.find((c) => c.context === "nested")!;
        expect(nested.name).toBe("AgentSol:google");
        expect(nested.deps).toBe(fixture.constructions[0]!.deps); // one shared deps object, both sites
      });

      it("three hard faults trip ONLY the sol breaker — sibling breakers untouched", async () => {
        await registerSol();
        fixture.runTurn.mockResolvedValue(
          makeRunResult({ error: "connect ECONNREFUSED 127.0.0.1:4141", text: "" }),
        );
        for (let i = 0; i < 3; i++) {
          await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: `sms:line-1:kpr394-fault-${i}` }));
        }
        expect(manager.circuitBreakers.stateFor("sol")?.state).toBe("open");
        expect(manager.circuitBreakers.stateFor("codex")).toBeNull(); // never used this process
      });
    });
```

Implementer notes for 4j (anchors, not design): `makeSubagentEntry` and `mockRunnerToolInventory` are the KPR-354 describe's helpers (visible at `agent-manager.test.ts:4625-4700`) — if they are scoped inside that describe rather than file-level, hoist nothing; instead replicate the entry literal the way that describe builds it. The `DelegateTurnCall` field set is authoritative at `turn-assembly.ts:50`; adjust the call literal to it exactly. If `smsCtx` is named differently at the grok seam (`makeSmsCtx` appears in later describes), use the one in scope at the insertion point.

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/agent-manager.test.ts src/channels/dispatcher.test.ts src/agents/provider-adapters/
  # expect: agent-manager 239 passed, dispatcher 91 passed (zero edits),
  #         provider-adapters 562 passed
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: manager + boot — registry-routed construction, two-phase load

  resolveProviderModel consults the registry ahead of the Claude fallback
  (declared ids route to themselves; never-declared keep the canon). Both
  construction sites resolve through getRegisteredProvider — one shared
  path, no drift. Slice resolution generalized (plugin arms: manifest-named
  keys, env→Honeypot per spawn, validated base-url; builtin arms
  byte-identical). index.ts awaits activateProviderPlugins() immediately
  after construction, before bgTaskManager — no spawn-capable window.
  Orphan-prefix warn at boot + reload.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 5: Credentials CLI extension + `hive plugin add` validation (§6 edge 5, §4.8)

**5a. `src/setup/credential-registry.ts`** — append after `allCredentialKeys()`:

```ts
/**
 * KPR-394 (§6 edge 5): dynamic credential entries for installed provider
 * plugins — `hive credentials add <api-key-env>` must work for
 * manifest-declared provider keys (the declared-broken/missing-key error
 * text directs operators there). Shaped exactly like static entries so the
 * CLI's list/add flow is uniform. The bootstrap wizard deliberately
 * consumes only the static CREDENTIAL_REGISTRY — plugin keys are
 * post-bootstrap by definition (plugins install after init).
 */
export function pluginProviderCredentialEntries(
  decls: readonly { plugin: string; decl: { id: string; apiKeyEnv?: string; description?: string } }[],
): CredentialEntry[] {
  return decls.flatMap(({ plugin, decl }) =>
    decl.apiKeyEnv
      ? [
          {
            server: decl.id,
            title: `Provider '${decl.id}' (plugin ${plugin})`,
            description: decl.description ?? `API key for the '${decl.id}' provider plugin.`,
            helpUrl: `See the ${plugin} plugin README.`,
            kind: "secret" as const,
            fields: [{ key: decl.apiKeyEnv, label: decl.apiKeyEnv }],
          },
        ]
      : [],
  );
}
```

**5b. `src/cli/credentials.ts`:**
- Add imports:
  ```ts
  import { pluginProviderCredentialEntries, type CredentialEntry } from "../setup/credential-registry.js";
  import { readInstalledProviderDecls } from "../plugins/provider-decl.js";
  import { readConfig, configPath } from "./hive-config.js";
  import { hiveHome } from "../paths.js";
  ```
  (merge with the existing `credential-registry.js` import line).
- Add below `defaultCliIO()`:
  ```ts
  /** KPR-394: provider-plugin credential entries from installed manifests.
   *  Fail-soft: a missing hive.yaml (pre-init box) yields the static
   *  registry only. */
  function defaultDynamicEntries(): CredentialEntry[] {
    try {
      const cfg = readConfig(configPath());
      return pluginProviderCredentialEntries(readInstalledProviderDecls(cfg.plugins ?? [], hiveHome));
    } catch {
      return [];
    }
  }
  ```
- `runCredentialsCommand` signature: add a 4th parameter `dynamicEntries: CredentialEntry[] = defaultDynamicEntries()`, and thread it into `listCredentials(io, dynamicEntries)` and `addCredential(args[0], io, dynamicEntries)`.
- `listCredentials(io, dynamicEntries)`: after the static loop, add:
  ```ts
    if (dynamicEntries.length > 0) {
      io.log("");
      io.log("Provider plugin credentials (from installed plugin manifests):");
      for (const entry of dynamicEntries) {
        for (const field of entry.fields) {
          const mark = io.hasSecret(field.key) ? "ok" : "--";
          io.log(`  ${mark}  ${field.key.padEnd(24)} (${entry.server})`);
        }
      }
    }
  ```
- `addCredential(key, io, dynamicEntries)`: replace the lookup line with:
  ```ts
    const entry =
      findCredentialEntryByKey(key) ?? dynamicEntries.find((e) => e.fields.some((f) => f.key === key));
  ```
  (everything else unchanged — the unknown-key rejection and message stay for genuinely unknown keys; `remove` needs no change, it checks only `hasSecret`.)

**5c. `src/cli/credentials.test.ts`** — enumerated delta #8, additive (4 tests, appended describe; reuse the file's existing fake-`io` helper):

```ts
describe("plugin provider credentials (KPR-394)", () => {
  const solEntry = {
    server: "sol",
    title: "Provider 'sol' (plugin hive-plugin-sol)",
    description: "API key for the 'sol' provider plugin.",
    helpUrl: "See the hive-plugin-sol plugin README.",
    kind: "secret" as const,
    fields: [{ key: "SOL_API_KEY", label: "SOL_API_KEY" }],
  };

  it("list shows dynamic provider keys in their own block", async () => {
    const io = makeIo();
    await runCredentialsCommand("list", [], io, [solEntry]);
    const out = io.lines.join("\n");
    expect(out).toContain("Provider plugin credentials");
    expect(out).toContain("SOL_API_KEY");
  });

  it("add accepts a manifest-declared provider key", async () => {
    const io = makeIo({ answers: ["sol-secret-value"] });
    const code = await runCredentialsCommand("add", ["SOL_API_KEY"], io, [solEntry]);
    expect(code).toBe(0);
    expect(io.secrets.get("SOL_API_KEY")).toBe("sol-secret-value");
  });

  it("add still rejects a genuinely unknown key", async () => {
    const io = makeIo();
    const code = await runCredentialsCommand("add", ["NOPE_KEY"], io, [solEntry]);
    expect(code).toBe(1);
    expect(io.lines.join("\n")).toContain("Unknown key: NOPE_KEY");
  });

  it("static registry entries are unaffected when no plugins declare providers", async () => {
    const io = makeIo();
    await runCredentialsCommand("list", [], io, []);
    expect(io.lines.join("\n")).not.toContain("Provider plugin credentials");
  });
});
```

(Adapt `makeIo` to this file's existing IO-fake helper — same name or its local equivalent; assertions target the `CredentialsCliIO` seam only.)

**5d. `src/setup/credential-registry.test.ts`** — enumerated delta #9, additive (2 tests):

```ts
describe("pluginProviderCredentialEntries (KPR-394)", () => {
  it("maps a decl with api-key-env onto a secret entry", () => {
    const entries = pluginProviderCredentialEntries([
      { plugin: "hive-plugin-sol", decl: { id: "sol", apiKeyEnv: "SOL_API_KEY", description: "Sol models" } },
    ]);
    expect(entries).toEqual([
      {
        server: "sol",
        title: "Provider 'sol' (plugin hive-plugin-sol)",
        description: "Sol models",
        helpUrl: "See the hive-plugin-sol plugin README.",
        kind: "secret",
        fields: [{ key: "SOL_API_KEY", label: "SOL_API_KEY" }],
      },
    ]);
  });

  it("a decl without api-key-env contributes nothing", () => {
    expect(pluginProviderCredentialEntries([{ plugin: "p", decl: { id: "sol" } }])).toEqual([]);
  });
});
```

**5e. `src/cli/plugin.ts`** — install-time validation + disclosure. Add imports:

```ts
import { normalizeProviderDecl, readInstalledProviderDecls, validateProviderDecl } from "../plugins/provider-decl.js";
import { LANE_B_PROVIDER_ABI_VERSION } from "../agents/provider-adapters/provider-abi.js";
import type { PluginProviderDecl } from "../plugins/types.js";
```

(`provider-abi.ts` compiles to the constant only — no adapter code enters the CLI bundle.) In `pluginAdd`, after the hiveApi check (line 84-88) and before `const version = ...`, insert:

```ts
  // KPR-394 (§4.8): provider-block validation against the INSTALLED engine +
  // installed plugin set, and the in-process disclosure — all before the
  // restart, so a rejected provider never reaches a boot.
  if (raw?.provider !== undefined) {
    let decl: PluginProviderDecl;
    try {
      decl = normalizeProviderDecl(raw.provider);
    } catch (err) {
      console.error(
        `Invalid provider block in ${target}/plugin.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
      rollbackInstall(target);
      process.exit(1);
    }
    const verdict = validateProviderDecl(decl, LANE_B_PROVIDER_ABI_VERSION);
    if (!verdict.ok) {
      console.error(`Provider '${decl.id}' rejected: ${verdict.reason}`);
      rollbackInstall(target);
      process.exit(1);
    }
    const installedNames = (readConfig(configPath()).plugins ?? []).filter((n: string) => n !== target);
    const collision = readInstalledProviderDecls(installedNames, hiveHome).find(({ decl: d }) => d.id === decl.id);
    if (collision) {
      console.error(`Provider id '${decl.id}' is already registered by installed plugin '${collision.plugin}'.`);
      rollbackInstall(target);
      process.exit(1);
    }
    console.log(
      `⚠ ${target} registers provider '${decl.id}' — its code runs in-process inside the hive engine (curated-registry trust, DOD-212).`,
    );
  }
```

(No dedicated test file exists for `plugin.ts` — it is `process.exit`/`execFileSync` glue, consistent with the repo's status quo; every decision it makes here is the provider-decl unit surface tested in Task 1. Note this in the PR body; the spec's optional live smoke covers the choreography.)

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/cli/credentials.test.ts src/setup/credential-registry.test.ts src/setup/credentials-wizard.test.ts
  # expect: credentials 21 passed, credential-registry 10 passed,
  #         credentials-wizard 6 passed (zero edits — bootstrap unaffected)
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: credentials CLI + plugin add — provider keys and validation

  hive credentials list/add accept manifest-declared provider api-key-env
  keys (dynamic entries from installed manifests; bootstrap wizard
  untouched — static registry only). hive plugin add validates the
  provider block (structure, regex/reserved/exact-abi, collision vs the
  installed set) pre-restart and prints the in-process disclosure
  (DOD-212).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 6: Doctor — "Provider plugins" informational section (§4.8)

**6a. `src/cli/doctor-checks.ts`** — append (mirroring the file's existing `*ForDoctor` fetcher idiom — dynamic `MongoClient` import with `serverSelectionTimeoutMS`, try/finally close):

```ts
// ── KPR-394: provider plugins (informational — never flips the exit code) ──

import {
  BUILTIN_ROUTABLE_PREFIXES,
  auditInstalledProviderDecls,
  type ProviderDeclAuditRow,
} from "../plugins/provider-decl.js";
import { resolvePluginServerPath } from "../plugins/plugin-loader.js";
import { LANE_B_PROVIDER_ABI_VERSION } from "../agents/provider-adapters/provider-abi.js";

export interface OrphanProviderModelRow {
  agentId: string;
  model: string;
}

export async function providerPluginsForDoctor(
  mongoUri: string,
  dbName: string,
  pluginNames: readonly string[],
  rootDir: string,
  timeoutMs = 3000,
): Promise<{ rows: ProviderDeclAuditRow[]; orphans: OrphanProviderModelRow[] }> {
  const rows = auditInstalledProviderDecls(
    pluginNames,
    rootDir,
    LANE_B_PROVIDER_ABI_VERSION,
    (plugin, entry) => "path" in resolvePluginServerPath(plugin, entry, { hiveHome: rootDir }),
  );
  const declaredIds = new Set(rows.map((r) => r.id));
  const orphans: OrphanProviderModelRow[] = [];
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: timeoutMs });
  try {
    await client.connect();
    const docs = await client
      .db(dbName)
      .collection("agent_definitions")
      .find({}, { projection: { _id: 1, model: 1 } })
      .toArray();
    for (const d of docs) {
      const model = typeof d.model === "string" ? d.model : "";
      const slash = model.indexOf("/");
      if (slash <= 0) continue;
      const prefix = model.slice(0, slash).toLowerCase();
      if (BUILTIN_ROUTABLE_PREFIXES.has(prefix) || declaredIds.has(prefix)) continue;
      orphans.push({ agentId: String(d._id), model });
    }
  } catch {
    // Mongo unreachable — the Agents group reports that; render manifests only.
  } finally {
    await client.close().catch(() => {});
  }
  return { rows, orphans };
}

export function renderProviderPluginsSection(
  rows: ProviderDeclAuditRow[],
  orphans: OrphanProviderModelRow[],
  emit: (line: string) => void = console.log,
): void {
  emit("\nProvider plugins (KPR-394)");
  if (rows.length === 0 && orphans.length === 0) {
    emit("  (no provider plugins installed)");
    return;
  }
  for (const r of rows) {
    if (r.status === "ok") {
      emit(`  ok  ${r.id.padEnd(16)} plugin=${r.plugin}  abi=${r.abi}  semantics=${r.semantics}`);
    } else {
      emit(`  ✗   ${r.id.padEnd(16)} plugin=${r.plugin}  BROKEN: ${r.reason}`);
    }
  }
  for (const o of orphans) {
    emit(`  ⚠   orphan model prefix: agent=${o.agentId} model=${o.model} — routes to Claude (unknown-prefix canon)`);
  }
  emit("  note: static manifest validation; runtime activation faults appear in engine logs and as per-turn errors");
}
```

(Place the imports at the top of the file with the existing imports, not mid-file, per house style.)

**6b. `src/cli/doctor.ts`** — in `runDoctor`'s config-loaded tail, directly after the `renderOutageQueueSection(...)` call:

```ts
    // KPR-394: provider plugins — informational only (KPR-296 canon: only
    // identity-class incidents flip the exit code).
    const providerPlugins = await providerPluginsForDoctor(
      config.mongo.uri,
      config.mongo.dbName,
      config.plugins ?? [],
      hiveHome,
    );
    renderProviderPluginsSection(providerPlugins.rows, providerPlugins.orphans);
```

and in the config-not-loaded `else` branch, after the outage-queue skipped lines:

```ts
    console.log("\nProvider plugins (KPR-394)");
    console.log("  ○ skipped: config not loaded");
```

(Add `providerPluginsForDoctor, renderProviderPluginsSection` to the existing `./doctor-checks.js` import.)

**6c. `src/cli/doctor-checks.test.ts`** — enumerated delta #7, additive (4 render tests, appended describe following the file's existing emit-capture idiom):

```ts
describe("renderProviderPluginsSection (KPR-394)", () => {
  const emit = () => {
    const lines: string[] = [];
    return { lines, fn: (l: string) => lines.push(l) };
  };

  it("renders (none installed) when empty", () => {
    const { lines, fn } = emit();
    renderProviderPluginsSection([], [], fn);
    expect(lines.join("\n")).toContain("(no provider plugins installed)");
  });

  it("renders ok rows with plugin, abi, semantics", () => {
    const { lines, fn } = emit();
    renderProviderPluginsSection(
      [{ plugin: "hive-plugin-sol", id: "sol", abi: 1, semantics: "stateless-replay", status: "ok" }],
      [],
      fn,
    );
    const out = lines.join("\n");
    expect(out).toContain("ok  sol");
    expect(out).toContain("plugin=hive-plugin-sol");
    expect(out).toContain("abi=1");
  });

  it("renders broken rows with the reason", () => {
    const { lines, fn } = emit();
    renderProviderPluginsSection(
      [{ plugin: "p", id: "sol", abi: 2, semantics: "stateless-replay", status: "broken", reason: "plugin requires provider ABI 2; engine provides 1" }],
      [],
      fn,
    );
    expect(lines.join("\n")).toContain("BROKEN: plugin requires provider ABI 2");
  });

  it("renders orphan model prefixes with the Claude-canon note", () => {
    const { lines, fn } = emit();
    renderProviderPluginsSection([], [{ agentId: "luna", model: "zeta/z-9" }], fn);
    const out = lines.join("\n");
    expect(out).toContain("orphan model prefix: agent=luna model=zeta/z-9");
    expect(out).toContain("unknown-prefix canon");
  });
});
```

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/cli/doctor-checks.test.ts src/cli/doctor.test.ts
  # expect: doctor-checks 68 passed, doctor 52 passed (zero edits)
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: doctor — informational Provider plugins section

  Static manifest audit (validate + collision + entry resolution) +
  orphan agent-model prefixes from agent_definitions. Informational only —
  never flips the exit code (KPR-296 canon). Runtime activation faults
  stay engine-log/per-turn facts; the render says so.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 7: Model catalog widening (§4.11)

**7a. `src/admin/admin-mcp-server.ts`:**
- `AdminToolDeps` (line 213): add
  ```ts
  /** KPR-394 (§4.11): registered plugin provider ids (any state) — widens
   *  the catalog tools' accepted provider set. Injected (not imported) so
   *  the admin harness stays light; absent ⇒ built-ins only. */
  listPluginProviderIds?: () => string[];
  ```
- Type widenings (curated docs can now hold plugin ids): `AgentModelCatalogDoc._id` and `.provider` → `string`; `AgentModelCatalogVersion.provider` → `string`; `CatalogListEntry.provider` → `string`. `CuratedCatalogProvider` and `CURATED_CATALOG_PROVIDERS` stay as the built-in curated set.
- `agent_model_catalog_list` (line 924): description — append `" Plugin-registered providers (KPR-394) list from the curated catalog as well."`; schema → `provider: z.string().optional().describe("Omit to list all providers (built-ins + registered plugin providers).")`; handler head (lines 931-936) →
  ```ts
        try {
          await ensureIndexes();
          // KPR-394 (§4.11): plugin providers map onto the curated-collection
          // path (unseeded ⇒ the existing prose note); gemini stays live.
          const pluginIds = deps.listPluginProviderIds?.() ?? [];
          const curatedSet: string[] = [...CURATED_CATALOG_PROVIDERS, ...pluginIds];
          const validSet = [...curatedSet, "gemini"];
          if (provider !== undefined && !validSet.includes(provider)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown provider '${provider}'. Valid: ${validSet.join(", ")}.` }],
            };
          }
          const wantCurated = provider ? curatedSet.filter((p) => p === provider) : curatedSet;
          const wantGemini = provider === undefined || provider === "gemini";
  ```
  (rest of the handler unchanged).
- `agent_model_catalog_refresh` (line 1024): description — replace `"for one provider (claude/grok/codex)"` with `"for one curated provider (claude/grok/codex, or a registered plugin provider id — KPR-394)"`; schema → `provider: z.string().describe("A curated provider: claude/grok/codex or a registered plugin provider id. Gemini is always live — nothing to refresh.")`; handler head after `await ensureIndexes();` →
  ```ts
          const pluginIds = deps.listPluginProviderIds?.() ?? [];
          const curatedSet: string[] = [...CURATED_CATALOG_PROVIDERS, ...pluginIds];
          if (provider === "gemini") {
            return {
              isError: true,
              content: [{ type: "text", text: "Gemini is always resolved live and cannot be refreshed." }],
            };
          }
          if (!curatedSet.includes(provider)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown provider '${provider}'. Valid: ${curatedSet.join(", ")}.` }],
            };
          }
  ```

**7b. `src/agents/agent-runner.ts`** — wire the dep at the `createAdminMcpServer({...})` construction (line 1454): add `listPluginProviderIds,` to the deps object, with the import:

```ts
import { listPluginProviderIds } from "./provider-adapters/provider-registry.js";
```

**7c. `src/admin/admin-mcp-server.test.ts`** — enumerated delta #6, additive (4 tests). Append a describe; build tools with the dep injected via the file's `makeTools`-equivalent pattern (pass `listPluginProviderIds: () => ["sol"]` through `buildAdminTools`'s deps — extend the local `makeTools` helper with an optional deps-override parameter if it doesn't already accept one; that helper change is part of this enumerated delta):

```ts
describe("agent_model_catalog — plugin providers (KPR-394)", () => {
  it("list accepts a registered plugin id; unseeded returns the prose note", async () => {
    const tools = makeTools({ listPluginProviderIds: () => ["sol"] });
    const res = await getHandler(tools, "agent_model_catalog_list")({ provider: "sol" });
    expect(res.isError).toBeUndefined();
    const texts = res.content.map((c: any) => c.text).join("\n");
    expect(texts).toContain("sol: not yet seeded");
  });

  it("refresh upserts a plugin provider's curated doc", async () => {
    const tools = makeTools({ listPluginProviderIds: () => ["sol"] });
    const res = await getHandler(tools, "agent_model_catalog_refresh")({
      provider: "sol",
      models: [{ id: "sol-large-2", displayName: "Sol Large 2" }],
    });
    expect(res.isError).toBeUndefined();
    expect(catalogDocsStore.get("sol")?.models?.[0]?.id).toBe("sol-large-2");
  });

  it("refresh rejects an unknown provider naming the valid set", async () => {
    const tools = makeTools({ listPluginProviderIds: () => ["sol"] });
    const res = await getHandler(tools, "agent_model_catalog_refresh")({
      provider: "zeta",
      models: [{ id: "z", displayName: "Z" }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Valid: claude, grok, codex, sol");
  });

  it("gemini refresh still rejected (always live)", async () => {
    const tools = makeTools({ listPluginProviderIds: () => ["sol"] });
    const res = await getHandler(tools, "agent_model_catalog_refresh")({
      provider: "gemini",
      models: [{ id: "g", displayName: "G" }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("always resolved live");
  });
});
```

- [ ] Verify:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/admin/admin-mcp-server.test.ts src/agents/agent-runner.test.ts
  # expect: admin 91 passed, agent-runner 179 passed (only the Task-2 literal edited)
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck   # clean
  ```
- [ ] Commit:
  ```
  KPR-394: model catalog answers for registered plugin provider ids

  z.string() + in-handler validation (the admin harness mocks zod — this
  is the testable form). Plugin ids ride the curated-collection path;
  unseeded keeps the prose note; gemini stays live-only. Ids injected via
  AdminToolDeps.listPluginProviderIds, wired from the runner.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 8: `@keepur/hive/provider-abi` subpath export + bundle guards (§4.2 ⚠)

Pre-verified at plan time: `package.json` has **no** `exports` and **no** `main` today; the pack guard **forbids `dist/`** in the tarball (`check-bundle-pack.mjs:58`), so the declaration tree must ship under `pkg/`; `tsc` already emits declarations (`declaration: true`); no repo (`~/github/beekeeper`, `~/github/hive-plugins`) deep-imports `@keepur/hive/...` as a module specifier — the only hits are a registry URL and package-name strings, so adding an exports map breaks no existing consumer. `bin` resolution is independent of `exports`.

- [ ] `package.json` — insert after `"bugs": {...},`:
  ```json
  "exports": {
    "./provider-abi": {
      "types": "./pkg/types/agents/provider-adapters/provider-abi.d.ts"
    },
    "./package.json": "./package.json"
  },
  ```
  Types-only condition is deliberate (spec §4.2: plugin authors take `@keepur/hive` as a devDependency; types erase at build — no runtime import exists to resolve).
- [ ] `build/bundle.ts` — after the MCP-server builds and before/beside the existing asset-copy block, add (extend the existing `node:fs` import with `cpSync` and `statSync` as needed):
  ```ts
  // KPR-394 (§4.2): ship the provider-abi type surface. The barrel's .d.ts
  // re-exports reach across the dist declaration tree, so copy ALL .d.ts
  // (directories included, maps excluded) into pkg/types/ — pkg/ is the
  // shipped root (dist/ is pack-forbidden).
  cpSync("dist", resolve(PKG_DIR, "types"), {
    recursive: true,
    filter: (src) => !statSync(src).isFile() || src.endsWith(".d.ts"),
  });
  ```
- [ ] `scripts/check-bundle-pack.mjs` — add to the `required` array (after the honeypot line):
  ```js
  "pkg/types/agents/provider-adapters/provider-abi.d.ts",
  "pkg/types/agents/provider-adapters/provider-module.d.ts",
  ```
- [ ] Verify:
  ```bash
  npm run check:bundle
  # expect: all four guards green — strings, pack (required files incl. the
  # two new d.ts sentinels; size within bounds — note the reported MB),
  # runtime, qdrant-stub
  node -e "const p=require('./package.json'); console.log(p.exports['./provider-abi'].types)"
  # expect: ./pkg/types/agents/provider-adapters/provider-abi.d.ts
  ls pkg/types/agents/provider-adapters/provider-abi.d.ts   # exists
  ```
  If the pack-size warn (>5 MB compressed) fires from the d.ts tree, record the number in the PR body — the fail bound is 10 MB; do not silently prune the tree.
- [ ] Commit:
  ```
  KPR-394: publish the provider ABI — exports map + shipped d.ts tree

  @keepur/hive/provider-abi resolves (types condition only — devDependency
  posture, no runtime import). bundle copies dist/**/*.d.ts → pkg/types/
  (dist/ is pack-forbidden); pack guard pins the two ABI sentinels. No
  main existed and no consumer deep-imports the package, so the exports
  map narrows nothing in use.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 9: `docs/providers.md` (§4.10 — same PR as the behavior change)

- [ ] Routing paragraph (line 3): replace the final sentence `An unrecognized prefix falls back to Claude rather than failing the turn.` with:
  ```
  Provider plugins (KPR-394) extend the prefix set: a plugin installed via `hive plugin add` can register one additional provider id, routed exactly like a built-in. A prefix that no built-in and no installed plugin declares falls back to Claude rather than failing the turn; a **declared** provider that failed to load (ABI mismatch, missing compiled entry, throwing factory) instead fails its turns with an honest error — never a silent Claude fallback.
  ```
- [ ] New section — insert between the end of the Footnotes block and `## Ruled non-goals`:
  ```markdown
  ## Plugin-registered providers (KPR-394)

  A hive plugin can register one Lane B provider: a `provider:` block in `plugin.yaml` names the model-prefix id and a compiled entry exporting `createProviderModule(kit)`; the engine loads it at boot (plugin install/remove already restart the service — there is no hot load or unload, and SIGUSR1 never touches provider code). What the class guarantees, and what it does not:

  - **Execution path:** the full Lane B surface — real prompt assembly, tool execution over the hive tool bridge (generic `laneB` tool-compatibility column), fail-closed guardrails, delegate subagents, and the shared implementation layer (scaffold, bounded dispatch loop, SSE framing) injected by the engine at load time, so shared fixes cover plugin providers without a plugin release.
  - **Sessions:** per the manifest's declared semantics (`stateless-replay` on hive-persisted turn history, or `server-resumable` handle chaining). Caveat: the manager's stale-handle self-heal matchers are openai/gemini-specific — a plugin provider's stale handle surfaces as an ordinary error turn; backends that need healing implement it in-adapter (codex precedent).
  - **Effort:** the `:effort` suffix parses generically and is delivered raw on the route; mapping/coercion/warn-once is the module's job (grok/gemini precedents).
  - **Ops:** breaker, honest-outage queue, and telemetry key on the provider id automatically — a plugin provider gets its own breaker, its own outage episodes, and its own heartbeat rows. Classification fidelity is an authoring obligation: decorate transport errors with status prefixes, or degrade only your own breaker's evidence. Config faults (missing key, invalid base URL, broken provider) are breaker-invisible. `costUsd` reports 0 unless the module reports real costs; token counts are whatever the module accumulates.
  - **Auth:** the manifest names an `api-key-env`; the engine resolves it per spawn on the standard env → Honeypot chain (`hive credentials add <KEY>`), and validates any `base-url-env` override (https, or http to loopback only). Modules never touch env or Keychain.
  - **ABI:** the manifest's `abi:` integer must exactly equal the engine's `LANE_B_PROVIDER_ABI_VERSION` (currently 1); mismatch in either direction leaves the provider declared-broken (honest per-turn failures, doctor-visible) — as does a missing compiled entry, an id collision (first registration wins), or a throwing factory. Compile-time types ship as the `@keepur/hive/provider-abi` subpath export (devDependency; types-only).
  - **Not guaranteed:** the engine does not validate the vendor surface behind a plugin provider — row-17-equivalent validation status is the plugin's claim, not the engine's. Third-party providers never get rows in this matrix; a provider plugin's README must carry a parity statement covering this matrix's row set (tools, sessions, effort, auth, validation status), enforced at registry-curation tier (DOD-212: provider plugins run in-process and install through curated registries only).

  Authoring in brief: **extend the kit's scaffold** (the wall-clock deadline, exception containment, and usage accounting only bound your adapter if you do), keep history wiring primary-context-only, pick a vendor-distinct id (built-in ids and aliases are reserved), and route errors through status-prefixed decorations.
  ```
- [ ] History entry — append:
  ```markdown
  2026-08-26 — Provider plugins (KPR-394): `hive plugin add` can register a Lane B provider (`provider:` block — id, compiled entry exporting `createProviderModule(kit)`, exact-integer ABI handshake at LANE_B_PROVIDER_ABI_VERSION=1). Routing paragraph updated: the unknown-prefix → Claude canon now applies only to *undeclared* prefixes; a declared-but-broken provider fails its turns honestly. New "Plugin-registered providers" class section; per-provider parity statements are a plugin README obligation enforced by registry curation, never engine-repo matrix rows.
  ```
- [ ] Verify: `git diff docs/providers.md` shows exactly the three edits above (routing paragraph, class section, History entry) — the parity-matrix table body and footnotes byte-untouched.
- [ ] Commit:
  ```
  KPR-394: docs — plugin-provider class section + routing canon update

  docs/providers.md documents the class, not instances: what a registered
  plugin provider is guaranteed (full Lane B surface, ops keying, Honeypot
  auth chain) and what it is not (no engine validation of the vendor
  surface; parity is a plugin README obligation, curation-enforced).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Task 10: Negative verification (repo convention — no committed changes)

Two temporary reverts of load-bearing new behavior; paste the observed failing test names, then restore. (The spec §7 negative cases — abi-broken fixture and undeclared-prefix canon — are POSITIVE tests shipped in Tasks 3/4; this task is the repo's revert-the-source discipline.)

- [ ] Revert A — silent-Claude-fallback hazard (the exact failure mode the ticket exists to prevent):
  ```bash
  perl -0pi -e 's/if \(isPluginDeclaredProvider\(provider\)\) \{\n    return \{ provider, model: providerModel, reasoningEffort \};\n  \}/if (false) {\n    \/\/ NEGVERIFY\n  }/' src/agents/agent-manager.ts
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts -t "KPR-394"
  ```
  Expected failures (all routing-dependent tests of the new describe — declared ids now silently route to Claude): "routing: registered plugin id maps via providerFor…", "primary construction: fixture module builds the adapter…", "slice resolution…", "missing SOL_API_KEY…", "a loopback SOL_BASE_URL override…", "a cleartext off-box SOL_BASE_URL override…", "declared-broken provider: honest TurnAssemblyError…", "nested delegate turn…", "three hard faults trip ONLY the sol breaker…". **Record the actual observed set; the routing test and the declared-broken test MUST be among the failures.**
  ```bash
  git checkout -- src/agents/agent-manager.ts
  ```
- [ ] Revert B — R3 fallback:
  ```bash
  perl -pi -e 's/const compatibility = columns\[provider\] \?\? columns\.laneB \?\? "unsupported";/const compatibility = columns[provider] ?? "unsupported"; \/\/ NEGVERIFY/' src/agents/provider-adapters/tool-transport.ts
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/tool-transport.test.ts
  ```
  Expected: **2 failed** — "R3: a plugin provider id reads the laneB fallback column (bridgeable)" and "R3: claude-only stays omitted for a plugin id, with the truthful reason" (this second test pins `compatibility: "claude-only"` for a plugin id, only producible via the fallback — the revert yields `"unsupported"` instead, so its `toEqual` mismatches). The neither-column and precedence tests pass by design without the fallback — that is expected, not a gap. Built-in tests all still pass — proof the fallback is reachable only off the built-in path.
  ```bash
  git checkout -- src/agents/provider-adapters/tool-transport.ts
  ```
- [ ] Confirm clean tree: `git status --porcelain` → empty.
- [ ] No commit.

### Task 11: Final gate, count verification, diff audit

- [ ] Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → all green.
- [ ] Bundle gate: `npm run check:bundle` → all four guards green.
- [ ] Zero-edit suite counts match baselines exactly:
  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
    src/agents/provider-adapters/provider-modules.test.ts src/agents/provider-adapters/types.test.ts \
    src/agents/provider-adapters/turn-assembly.test.ts src/channels/dispatcher.test.ts \
    src/agents/provider-circuit-breaker.test.ts src/cli/doctor.test.ts \
    src/setup/credentials-wizard.test.ts src/agents/prefix-builder.golden.test.ts \
    src/agents/prefix-builder.provider.test.ts src/agents/prefix-builder.test.ts \
    src/agents/toolkit-section.test.ts
  # expect: 21, 9, 23, 91, 29, 52, 6, 12, 16, 12, 26 — all passed, zero edits
  ```
- [ ] Changed-suite counts: tool-transport 60, agent-runner 179, plugin-loader 50, agent-manager 239, session-store 19, admin 91, doctor-checks 68, credentials 21, credential-registry 10, provider-decl 30, provider-registry 18; provider-adapters directory total 562.
- [ ] Diff audit — exactly the enumerated file set changed since `1d138c5`:
  ```bash
  git diff --name-only 1d138c5 -- src/ docs/ package.json build/ scripts/ test-fixtures/
  # expect exactly the 40 paths in the File Structure table (37 src/docs/config
  # files + 2 fixture files + 1 — this plan file itself, committed by the
  # walking session). Any file outside the table = stop and reconcile before
  # proceeding.
  ```
- [ ] C19/C20 confirmation (covered by the diff audit): `prefix-builder.ts`, `intent-trailer.ts`, `activity/types.ts`, `dispatch-loop.ts`, `sse.ts`, `tool-bridge.ts`, all four adapters, `passthrough-providers.ts` (beyond the one isLaneAProvider line), `provider-modules.ts`, `outage/` — absent from the diff (or single-line where enumerated).
- [ ] PR-body obligations to note for the walking session: (1) the enumerated nine pre-existing test-file deltas with per-file baselines (C10/C16, listed in the PR body per spec §7); (2) the edge-1 collision refinement (first-wins + log + doctor row, not id-keyed broken state); (3) the sse kit-member naming resolution; (4) `plugin.ts` CLI glue untested-by-convention note; (5) pack-size number after the d.ts tree.
- [ ] No commit unless fixes were needed (any fix commits use the same trailer).

---

## Final-round advisory (caught-by: plan-review/2/fable — apply during implementation, no re-review needed)

In `auditInstalledProviderDecls` (doctor static audit), also `seen.set(decl.id, plugin)` for **invalid** decls, so audit collision detection keys on declaration order regardless of validity — mirroring the runtime's `pluginOwnerOf`. Without this, the doubly-degenerate corner (first registrant invalid → `broken`; second plugin declares the same id validly) renders an **ok** doctor row for the second plugin while turns fail with the first plugin's reason. One line + adjust the audit's collision assertion if the corner is added as a test case (optional).

## Execution Handoff

Execute tasks in order (0→11); each of Tasks 1–9 is one commit; the walking session owns the plan-file commit and the PR. Inner-loop suites per task are listed in each verify block; the full gate runs once at Task 11 (and any time a task's verify surprises).

Rollback story: every layer is additive behind the registry — reverting any single commit leaves built-ins on the same seed tables as today (`LANE_B_PROVIDER_MODULES` / `SESSION_SEMANTICS` are unchanged files). Operational rollback for a misbehaving plugin provider is the spec's §4.6 story (repoint models + SIGUSR1; `hive plugin remove` + its automatic restart), not a code revert.
