# KPR-394 — Provider plugins: load Lane B provider modules via `hive plugin add`

**Epic:** KPR-385 (Provider first-class-ness) · **Type:** loading/registration mechanism on the frozen KPR-391 contract · **Status:** spec draft
**ABI baseline:** the `LaneBProviderModule` contract at `6b58099` (C6/C11 — freeze ARMED; every contract movement in this spec is a registered decision under KPR-394 governance).

## TL;DR

A hive plugin can now ship a Lane B provider: a `provider:` block in `plugin.yaml` names a new model-prefix id and a compiled entry that exports `createProviderModule(kit)` returning a `LaneBProviderModule` (the KPR-391 contract, unchanged in shape). The engine loads it at boot into a runtime provider registry that `resolveProviderModel`, both agent-manager construction sites, session semantics, the circuit breaker, and the outage queue all key on — so a plugin provider gets the full first-class ops surface automatically, with credentials resolved manager-side on the existing `secret-env`/Honeypot chain (C7/C15, byte-identical to grok's). Loading is boot-only (`hive plugin add`/`remove` already restart the service); there is no hot load or unload.

## Key Points

- **In scope:** `provider:` manifest block (id, entry, `abi`, session semantics, default model, api-key/base-url env names) parsed by the plugin loader; a runtime provider registry (`provider-registry.ts`) seeded from `LANE_B_PROVIDER_MODULES` + plugin registrations; entry-point factory contract `createProviderModule(kit)` with an engine-injected **provider kit** (`LaneBTurnScaffold`, `runBoundedDispatchLoop`, `sse` helpers, `createLogger`) so a plugin provider is glue, not a clone; manager-side credential slice resolution mirroring `resolveGrokModuleSlice`; integer ABI handshake; declared-but-broken honest failure path; doctor/`plugin add` surfacing; `docs/providers.md` plugin-provider class section; model-catalog tools accepting registered plugin ids.
- **Registered ABI decisions (C6):** (R1) the entry-point factory + kit become part of the plugin ABI, versioned by one integer `LANE_B_PROVIDER_ABI_VERSION = 1`; (R2) provider-id **type relaxations** — `LaneBProviderModule.provider`, `AgentProviderAdapter.provider`, scaffold/assembly/partition/breaker provider parameters widen from closed literal unions to `string` (relaxations only; in-tree literals and tables unaffected); (R3) the tool-compatibility record gains one additive `laneB` column (the single non-Claude value every classify site already computes) and the partition falls back to it for non-built-in ids; (R4) `providerConfig` stays exactly `{ agentModel?; apiKey?; baseUrl? }` — no shape change.
- **Out of scope:** Lane A plugin providers (passthrough table stays engine-owned and exception-free, C13), hot load/unload or SIGUSR1 provider reload, more than one provider per plugin, any contract redesign beyond R1–R4, sandboxing/process isolation, moving openai onto the shared loop (C1), a published example provider plugin (an in-repo test fixture only), per-provider breaker config.
- **Security (DOD-212, unchanged and load-bearing):** provider plugins install through curated registries exactly like MCP-server plugins; a provider module runs **in-process** (precedent: `registerCommands` already dynamic-imports plugin JS into the engine). Least-privilege `deps` is interface honesty enforced at curation/review tier, not a process boundary — DOD-212 already accepts that a malicious plugin can exfil secrets. `hive plugin add` prints an explicit "registers provider '<id>' — runs in-process" disclosure.
- **Credentials:** no new path. `api-key-env` resolves per spawn via `resolveEnvKeyCredential` (env → Honeypot; missing key ⇒ the same breaker-invisible `TurnAssemblyError`); `base-url-env` overrides validate via `assertSafeBaseUrlOverride` (https, or http to loopback only). Both are manager-tier (C15); modules never touch env/Keychain (C7).
- **Failure honesty:** a *declared* provider that fails to load (abi mismatch, bad entry, throwing factory) is registered as **broken** — turns routed to its prefix fail with an honest breaker-invisible `TurnAssemblyError`, never a silent Claude fallback. Only never-declared prefixes keep the existing unknown-prefix → Claude canon.
- **Breaker/outage/telemetry are automatic:** all ops surfaces already key on the resolved route provider string via lazy maps — a plugin provider gets its own breaker, its own outage-queue episodes, and its own heartbeat rows with no per-provider wiring. Classification fidelity (status-prefix error decoration, C5 grok shape) is a documented module-authoring obligation; a sloppy plugin degrades only its own breaker.
- ⚠ **Delegated assumptions** (flagged inline in the sections): manifest key names/shape (§4.1); kit member list (§4.2); `server-resumable` plugin providers get no manager-arm stale-handle self-heal in v1 (§4.3); model-catalog enum widening mechanics (§4.11); types published via a `@keepur/hive/provider-abi` subpath export (§4.2).

---

## 1. Problem / context

KPR-391 extracted the Lane B implementation layer and delivered `LaneBProviderModule` as a deliberately self-contained contract; KPR-392 proved it as consumer #4 (grok = one module entry, no fifth clone). The freeze gate is satisfied (C6/C11): the contract at `6b58099` is the plugin ABI baseline. What does not exist yet is any way for that contract to be satisfied from outside `src/` — `LANE_B_PROVIDER_MODULES` is a static in-engine `Record`, `resolveProviderModel` recognizes a hardcoded prefix set, and `SESSION_SEMANTICS` / the tool-compatibility partition are closed unions. Operator decision 2026-08-25 (May) reversed the no-engine-extension-points posture for provider adapters specifically (DeepSeek Harness / Cordis inspiration, without adopting that harness): a plugin package should be able to register a new provider via `hive plugin add` with zero engine source changes.

## 2. Goals

1. `hive plugin add @vendor/hive-plugin-<name>` on a plugin carrying a `provider:` block makes `<id>/<model>[:<effort>]` a routable agent `model` value after the (automatic) service restart — full Lane B surface: prompt assembly, ToolBridge tool execution, guardrails, delegates, breaker, outage queue, telemetry.
2. The plugin author writes glue, not clones: the engine's shared implementation layer (scaffold, bounded dispatch loop, SSE framing) is handed to the module at load time.
3. Every settled constraint holds: curated distribution (DOD-212), `secret-env`/Honeypot credentials, caller-resolved least-privilege `providerConfig` (C7), C15 helpers at the manager tier, C8 primary-only history wiring as a module rule, no breaker/outage semantic changes.
4. Failure modes are honest and operator-visible: abi mismatch, unresolvable entry, id collision, and factory throw each produce a logged, doctor-visible, per-turn-honest outcome — never silent misrouting.

## 3. Non-goals

- **No Lane A plugin providers.** Lane A rides the full Claude runtime with per-spawn env substitution — extending it from plugins would be a credential/env-injection surface with no module contract mediating it, and the Lane A table is deliberately exception-free vendor-endpoint-only (C13). `passthrough-providers.ts` is untouched. A future Lane A extension would be its own registered decision.
- **No hot load, hot reload, or hot unload.** ESM module caching makes true code reload impossible in-process; partial states (old adapter objects + new module code) are exactly the impostor-shaped hazard this codebase avoids. §4.6.
- **No multi-provider plugins** in v1: one `provider:` block per plugin. A second provider is a second plugin. (Registry curation stays legible; nothing in the design precludes lifting this later.)
- **No contract redesign.** `LaneBProviderModule`, `LaneBAdapterConstructionArgs`, `LaneBModuleDeps` keep their `6b58099` shapes; R1–R3 are additive/relaxing only. The pre-freeze stress license is spent (C6).
- **No sandboxing / process isolation** for provider modules. Stdio isolation would require re-designing the adapter boundary (an adapter is an in-process object the manager calls); the curated-registry gate is the DOD-212 answer. Revisit only with evidence.
- **No per-provider breaker/outage tuning**, no plugin-supplied stale-handle matchers (§4.3), no plugin-supplied compatibility columns, no `SESSION_SEMANTICS` values beyond the two that make sense on Lane B.
- **No published example/template provider plugin** in this ticket (in-repo test fixture only). Authoring docs ride `docs/providers.md` + a short authoring section; a polished template package is follow-up material.
- **No engine-repo parity-matrix rows for third-party providers** (§4.10).

## 4. Design

### 4.1 Registration mechanism: manifest field, not convention

A plugin declares at most one provider in `plugin.yaml`:

```yaml
provider:
  id: sol                      # model prefix — ^[a-z][a-z0-9-]{1,15}$
  entry: src/provider.ts       # compiled dist/provider.(min.)js — same resolution as MCP entries
  abi: 1                       # must equal the engine's LANE_B_PROVIDER_ABI_VERSION
  session-semantics: stateless-replay   # or server-resumable
  default-model: sol-large-2   # → providerConfig.agentModel
  api-key-env: SOL_API_KEY     # optional; secret-env class — env → Honeypot per spawn
  base-url-env: SOL_BASE_URL   # optional; plain env, validated (https or loopback http)
  description: Sol frontier models via the Sol Agents API
```

Decisions:

- **Manifest field over convention** (e.g. "any `dist/provider.js` auto-loads"): a convention would make in-process code execution an *implicit* consequence of file layout; a manifest field is a reviewable, curator-visible declaration and gives `hive plugin add` something concrete to disclose and validate. Consistent with how every other plugin capability (MCP servers, seeds, `register-commands`) is manifest-declared.
- **`id` is the model prefix** agents use (`sol/sol-large-2:high`). Validation at parse time: shape regex; **reserved-id rejection** — the full set `resolveProviderModel` recognizes plus aliases and the compatibility key: `claude`, `openai`, `openai-codex`, `codex`, `gemini`, `google-gemini`, `grok`, `kimi`, `deepseek`, `laneB` (itself unreachable via the lowercase-only id regex, reserved for clarity) and its reachable lowercased near-miss `laneb`; **cross-plugin collision** — second registrant of the same id is rejected (declared-broken, §4.3) with both plugin names logged.
- **`entry`** resolves through the existing `resolvePluginServerPath` priority chain (dev dist → npm bundled → npm/in-tree `.js` fallbacks) — provider modules get the same "plain-`tsc` customer build works" property MCP entries have.
- **Credential/env naming:** the manifest names *which* env keys the engine resolves; the engine does the resolving (C7 — modules never see env/Keychain). `api-key-env` rides the exact `secret-env` resolution chain (`resolveEnvKeyCredential`: `process.env` → Honeypot `hive/<instanceId>/<KEY>`; missing ⇒ the existing breaker-invisible `TurnAssemblyError` naming `hive credentials add <KEY>`). `base-url-env` is plain env (non-secret, per the ticket constraint); when set, the value passes `assertSafeBaseUrlOverride` validation — https, or http to loopback only — before reaching the module; when unset, `providerConfig.baseUrl` is `undefined` and the module uses its own built-in default endpoint (grok-override semantics, generalized). ⚠ Delegated: singular explicit keys (`api-key-env`/`base-url-env`) rather than reusing the list-shaped `env:`/`secret-env:` MCP keys — `providerConfig` has exactly one apiKey and one baseUrl slot (R4), so singular keys state the truth; the plan may rename without spec impact.
- `hiveApi` (the existing plugin-wide semver gate) continues to apply to the whole plugin, independent of the provider `abi` handshake (§4.7).

### 4.2 Entry-point contract and the provider kit (registered decision R1)

The compiled entry exports one named function:

```ts
export function createProviderModule(kit: LaneBProviderKit): LaneBProviderModule;
```

```ts
export interface LaneBProviderKit {
  abiVersion: number;                       // === LANE_B_PROVIDER_ABI_VERSION
  LaneBTurnScaffold: typeof LaneBTurnScaffold;   // abstract base — extend it
  runBoundedDispatchLoop: typeof runBoundedDispatchLoop;
  sse: { parseSseEvent; consumeBufferedSseEvents };   // generic SSE framing (KPR-391 §4.3)
  createLogger: (module: string) => Logger;
}
```

Why a factory with an injected kit, not a bare `export const module`: a tool-executing adapter **cannot** be written without the engine's shared layer — the scaffold owns ToolBridge construction, the #407 deadline, containment, and result building. A plugin cannot `import` that layer: plugins install under `<hiveHome>/plugins/node_modules/<name>` where `@keepur/hive` is not resolvable, and bundling a private copy would re-create exactly the clone problem KPR-391 killed (a stale private scaffold missing the next #407-class fix). Runtime injection hands the plugin the *running engine's* layer by reference — shared fixes cover plugin providers structurally, the epic's core thesis. Precedent for the mechanism: `registerCommands(registry)` already works this way.

- The kit is part of the plugin ABI; any breaking change to a kit member's contract bumps `LANE_B_PROVIDER_ABI_VERSION` (§4.7). Additive kit members do not bump.
- ⚠ Delegated: exact kit member list. Floor: scaffold + loop + sse (nothing tool-executing works without the first; codex-template providers need the other two). `createLogger` included so plugin logs land in engine logging with redaction conventions. Resist growth — every member is frozen surface.
- **Compile-time types:** the ABI types (`LaneBProviderModule` closure, `LaneBProviderKit`, and the transitive type closure KPR-391 deferred — `RunResult`, `WorkItemContext`, `StreamCallback`, `ResourceLimits`) are published for plugin authors as type-only declarations under a `@keepur/hive/provider-abi` subpath export; plugin authors take `@keepur/hive` as a devDependency (types erased at build — no runtime dependency). This discharges the KPR-391 §4.3 "re-homing deferred to KPR-394's ABI freeze" note: the declarations are re-exported (not moved) from a single `provider-abi` barrel that becomes the documented ABI surface. ⚠ Delegated: adding an `exports` map to package.json must preserve current entry points (bin, main) — plan-level verification with the bundle guards.
- The factory is called once at load, synchronously after import; a throw ⇒ declared-broken (§4.3). The returned module's `provider` must equal the manifest `id` (mismatch ⇒ declared-broken — the manifest is the curator-reviewed truth).

### 4.3 Runtime provider registry and routing

New `src/agents/provider-adapters/provider-registry.ts`, the single runtime source of provider truth:

```ts
interface RegisteredProvider {
  id: string;
  module: LaneBProviderModule;
  semantics: SessionSemantics;
  source: "builtin" | { plugin: string };
  slice?: ProviderSliceDecl;        // plugin only: default-model / api-key-env / base-url-env
}
// plus: brokenProviders: Map<string, { plugin: string; reason: string }>
```

- **Seeding:** built-ins seed from `LANE_B_PROVIDER_MODULES` + `SESSION_SEMANTICS` (both tables stay — they are the built-in seed, unchanged). Plugin providers enter via the **two-phase boot load** (r1 correction — the constructor path alone cannot deliver the guarantee): **(a) synchronous declaration** — the manager constructor's existing synchronous `loadPlugins` manifest pass (`plugin-loader.ts:70`, called at `agent-manager.ts:527`) registers every declared provider id immediately in a *declared-not-yet-loaded* state carrying declared-broken turn semantics, so from the first instant a turn routed at the prefix gets the honest `TurnAssemblyError`, never the Claude fallback; **(b) asynchronous activation** — a new `activateProviderPlugins()` async pass (`await import()` of each compiled entry + factory call + kit injection; the engine is ESM, so import is necessarily async and cannot run inside the sync constructor) awaited in `index.ts` **before any spawn-capable surface starts** — the slot exists immediately after manager construction (`index.ts:380`) — and activation must sit there, before `bgTaskManager.start()`/`scanOrphans()` (`:413-414`), whose completion callbacks can already dispatch turns, not merely before the first channel-adapter start (`:555`). Phase (a) owns the honesty guarantee (declared ⇒ never misrouted); phase (b) owns availability (loaded ⇒ turns run). The `registerPluginCommands` precedent (`plugin-loader.ts:316`, invoked `index.ts:661`) proves in-process dynamic import of plugin entries but its slot runs *after* `slackAdapter.start` — a provider activation pass in that slot would open a boot window of declared-but-unregistered prefixes; the activation pass must NOT reuse it.
- **`resolveProviderModel`:** (note for the planner: it is a module-scope pure function, also consumed statically by `providerFor` and prepareSpawn — the registry consult therefore reads module-global registry state or takes the registry as an explicit parameter; do not thread a manager-instance dependency into the static call sites) after the hardcoded arms, an unknown prefix consults the registry: registered plugin id ⇒ `{ provider: id, model, reasoningEffort }` (generic route arm added to `ProviderModelRoute`; `splitProviderModel` effort parsing applies unchanged — effort *mapping* is module-owned, delivered on `route.reasoningEffort` as for built-ins); **declared-broken id ⇒ still routes to that id**, and `createProviderAdapter` throws `TurnAssemblyError("provider '<id>' from plugin '<name>' failed to load: <reason>")` — breaker-invisible, honest text in the thread. Only never-declared prefixes keep the documented unknown-prefix → Claude fallback. Rationale: for a declared provider the operator's intent is known; silently running the turn on Claude with a foreign model string is the worst outcome (wrong model, wrong creds, plausible-looking output).
- **Session semantics:** the manifest declares `stateless-replay` or `server-resumable` — the only two coherent Lane B values (`client-transcript` is the Claude-runtime lane; `conversation-store` is unoccupied by ruling). `sessionSemanticsFor` becomes registry-consulting (built-in Record first, plugin overlay second; unreachable-unknown defaults to `stateless-replay` — fail-safe: never persist a handle). Write side (`persistsResumableHandle`), read side (session-store), and the KPR-313 handoff/history-clear logic all follow automatically since they key on semantics + provider string. **v1 limitation, documented:** the manager's `server-resumable` stale-handle self-heal arm additionally gates on `isStaleServerHandleError`, whose sentinel/prose matchers are openai/gemini-specific — a plugin provider's stale handle therefore surfaces as an ordinary error turn rather than self-healing. A plugin whose backend needs healing implements it in-adapter (codex precedent, C12); a plugin-supplied matcher hook is deliberate future ABI, not v1. ⚠ Flagged as a delegated acceptance.
- **Stateless-replay plumbing:** `deps.turnHistoryStore`/`agentId` are already passed to every module; `provider_turn_history` keys on the provider string, so plugin history rows, the 7d TTL, and the handoff clear all work unchanged. C8 (primary-context-only wiring) becomes a documented module-authoring rule for plugins, exactly as it is for grok.

### 4.4 Manager integration (both construction sites)

- Both `createProviderAdapter`'s Lane B tail and the nested `delegateTurnRunner` replace their `LANE_B_PROVIDER_MODULES[route.provider]` lookups with registry lookups — still one shared lookup path, so the two sites still cannot drift (KPR-391 §4.3 property preserved). The nested runner's registry-miss containment branch (`provider does not execute tools`) survives and now also serves any future registry gap.
- **Slice resolution** generalizes `resolveGrokModuleSlice` (C15 — manager-tier, C7 — module-opaque): for a plugin provider, `providerConfig = { agentModel: slice.defaultModel, apiKey: slice.apiKeyEnv ? resolveEnvKeyCredential(slice.apiKeyEnv, { instanceId }) : undefined, baseUrl: <validated env override or undefined> }`, resolved **per spawn** (rotation via `hive credentials add` takes effect next spawn, byte-identical failure contract). Built-in arms unchanged.
- Delegates (KPR-354) work for plugin providers with zero new machinery: the nested runner constructs the same module with `context: "nested"`, session-less/history-less by module rule, budget-accounted, abort-chained, breaker-invisible.
- Assembly (`assembleProviderTurn`) is called with the plugin provider id (string). Prompt composition (`buildProviderInstructions`, follow-through section per C19, toolkit, guardrail gate fail-closed) is provider-uniform and applies unchanged.

### 4.5 Type widenings and the compatibility column (registered decisions R2, R3)

- **R2 (relaxations):** `LaneBProviderModule.provider`, `LaneBTurnScaffold`'s abstract `provider`, `AgentProviderAdapter.provider`, `assembleProviderTurn`/`partitionInventoryForProvider`/`buildProviderInstructions` provider parameters, breaker-registry/`providerFor`/outage-queue provider types widen from `LaneBProviderId`/`AgentProviderId` literal unions to `string`. Pure relaxations: every in-tree literal still typechecks, no runtime behavior changes, the closed unions **remain** as the built-in table keys (`LANE_B_PROVIDER_MODULES: Record<LaneBProviderId, …>`, `SESSION_SEMANTICS: Record<AgentProviderId, …>` — exhaustiveness for built-ins is kept where it earns its keep).
- **R3 (additive `laneB` column):** every classify site in `tool-transport.ts` already computes exactly one non-Claude compatibility value and fans it into four identical columns (one-code-path rule, KPR-348 canon). The descriptor's `compatibility` key union gains `"laneB"`, populated with that same single value at each site; `partitionInventoryForProvider(inventory, provider: string)` reads `compatibility[provider] ?? compatibility.laneB`. Built-in behavior is bit-identical; plugin providers get the truthful generic Lane B column (which is the only column that has ever existed, four times over). Test deltas here are this ticket's enumerated deliberate deltas (C10/C16 discipline: enumerate record-literal edits, don't claim compile-forced for test files).

### 4.6 Load timing, unload, rollback

- **Boot-only load, two-phase (§4.3):** synchronous declaration in the constructor's manifest pass, async activation awaited in `index.ts` strictly before any channel adapter, scheduler, or other spawn-capable surface starts. `hive plugin add` and `hive plugin remove` already restart the service (`restartHiveService`) — so "install → usable" and "remove → gone" each cost exactly the restart the CLI already performs. No new operator step.
- **SIGUSR1 never loads or unloads provider code.** Rationale: ESM import caching makes reload-in-place impossible; late-loading a *new* provider on SIGUSR1 is technically feasible but buys nothing (the install path restarts anyway) and creates a second, subtly different load context to keep correct. The existing SIGUSR1 broken-MCP-server rescan does **not** extend to provider entries in v1 — a boot-time entry-resolution failure is declared-broken until restart, matching the honest-failure path. SIGUSR1 keeps its existing meaning (agent defs, skills, prefix flush).
- **Unload/rollback story:**
  1. *Misbehaving provider, agents to move now:* repoint each agent's `model` to a built-in + SIGUSR1 — the grok rollback pattern, unchanged. The provider's breaker meanwhile fast-fails its own turns without touching any other provider.
  2. *Remove the plugin:* `hive plugin remove` + its automatic restart. After restart the id is *undeclared*, so the unknown-prefix → Claude canon applies to any agent still pointed at it — mitigated by a **boot/reload-time warn** in the registry for every agent whose `model` carries a `/`-prefix matching no registered or built-in provider, plus a doctor informational line (§4.8). Cross-provider reassignment gets the standard KPR-313 fresh-session handoff; orphaned `provider_turn_history` rows TTL out (7d).
  3. *Engine downgrade below the plugin's `abi`:* the handshake (§4.7) declares it broken at boot — honest per-turn failures, doctor-visible, no misrouting.

### 4.7 Version/compat handshake

- New exported constant `LANE_B_PROVIDER_ABI_VERSION = 1` (home: the `provider-abi` barrel, §4.2). The manifest's `abi:` integer must **exactly equal** it; mismatch in either direction ⇒ declared-broken with a reason naming both numbers ("plugin requires provider ABI 2; engine provides 1 — upgrade hive / install an older plugin version").
- **Exact integer, not semver:** the ABI is one frozen contract, not a package; "compatible range" semantics invite the exact silent-drift class the freeze exists to prevent. Additive, non-breaking growth (a new optional kit member, a new optional manifest key) does not bump; any change that could make a correct existing plugin misbehave bumps. Bumps are themselves registered decisions (C6 governance continues past this ticket).
- The factory also receives `kit.abiVersion` for belt-and-braces runtime assertion by defensive plugin authors.
- The plugin-wide `hiveApi` semver gate is unchanged and orthogonal (it guards manifest schema / env machinery; `abi` guards the provider contract).

### 4.8 Ops integration: breaker, outage queue, telemetry, doctor

- **Circuit breaker:** `ProviderCircuitBreakerRegistry` is a lazy per-provider map — a plugin provider gets its own breaker on first spawn with zero wiring (R2 widens the signature types only). All KPR-306/307 semantics apply as-is: three-hard-fault trip, p95 breach, half-open real-turn probes, `ProviderCircuitOpenError` fast-fail, per-provider `circuit_breaker_stats` heartbeat rows.
- **Outage queue:** the dispatcher's episode logic keys on `providerFor(agentId)` (a string) — plugin-provider outages open their own episodes, queue their own turns, and replay independently. No change.
- **Classification fidelity is an authoring obligation, not an engine guarantee:** `error-classification.ts` matches status-prefixed/prose fault patterns; modules must decorate transport errors with status prefixes (C5's grok target shape — all decorations status-prefixed; anomalies deliberately breaker-visible where they indicate route infrastructure). Documented in the authoring section; a plugin that ships bare error strings degrades only its own breaker's evidence, never a sibling's.
- **`TurnAssemblyError` boundary unchanged:** missing credential, broken provider, invalid base URL all classify non-provider — config faults never trip a plugin breaker or open an outage episode.
- **Doctor:** new informational "Provider plugins" section — registered ids (with source plugin + abi), declared-broken ids with reasons, and orphaned agent-model prefixes. Informational only; never flips the exit code (KPR-296 canon: only identity-class incidents fail the doctor).
- **`hive plugin add`:** post-install validation extends to the provider block (parse, id regex, reserved/collision check against the *installed* plugin set, abi check against the installed engine) and prints the in-process disclosure line before the restart.

### 4.9 Security posture (DOD-212 applied, not amended)

- **Curated distribution unchanged and load-bearing:** provider plugins arrive via `hive plugin add` from registries, same as MCP-server plugins. Raw-URL/dev-mode installs remain the developer escape hatch, not the production path. Registry curation matters *more* for engine-extending plugins: the curation checklist for a provider plugin includes the in-process-execution review and the parity/authoring-doc obligations (§4.10).
- **Honest threat model:** a provider module executes inside the engine process — architecturally it can read `process.env` and reach engine internals regardless of what the `deps` interface offers. The least-privilege `providerConfig` slice (C7) and the no-engine-import contract are *interface honesty* — they make the legitimate surface small, reviewable, and drift-visible — not a sandbox. This is already DOD-212's stated posture for plugins ("the MCP server is the legitimate credential holder; a malicious plugin can exfil secrets directly"); the in-process precedent is `register-commands`. No new trust tier is created; nothing is quietly downgraded.
- **Credential blast radius:** the engine resolves only the manifest-named `api-key-env` for the provider being constructed — a plugin provider is never *handed* a sibling's credential (the hazard the `LaneBModuleDeps` docstring pre-recorded). Base-URL validation (loopback-or-https) keeps the KPR-384 override posture: an override redirects both credential and conversation stream, so it is constrained the same way grok's is.
- **No agent-visible credential paths added:** all resolution is manager-tier at spawn; nothing lands in model-facing context.

### 4.10 Parity-matrix and docs obligations

- **Engine matrix documents the class, not the instances.** `docs/providers.md` gains: (a) a routing-paragraph update (plugin-registered prefixes; declared-broken honesty; the unknown-prefix canon now scoped to *undeclared* prefixes); (b) a "Plugin-registered providers" section stating exactly what the class guarantees (Lane B execution path over the tool bridge; generic `laneB` tool column; session semantics per declaration with the no-manager-self-heal caveat; effort suffix delivered raw to the module; breaker/outage/telemetry full; costUsd 0 unless the module reports; auth via manifest-named Honeypot-chained key) and what it does not (no engine validation of the vendor surface — row-17-equivalent status is the plugin's claim); (c) a History entry. Third-party providers never get engine-repo matrix rows — unmaintainable and a false imprimatur.
- **Per-provider parity documentation is a plugin obligation:** a provider plugin's README must carry a parity statement covering the matrix's row set (tools, sessions, effort, auth, validation status). Enforced at registry-curation tier (checklist item), echoed in the authoring docs. ⚠ Delegated: prose obligation + curation, not code enforcement — consistent with "employees come through curated channels"; code-enforcing README shape would be theater.
- The engine-side changes in this ticket that touch provider behavior surfaces (routing paragraph, plugin class section) land in the same PR per the matrix's standing rule.

### 4.11 Model catalog touchpoint (KPR-381)

`agent_model_catalog_list` / `agent_model_catalog_refresh` currently pin `z.enum` provider sets. They widen to accept any *registered* provider id, mapping plugin providers onto the curated-collection path (operator/agent seeds via refresh; unseeded returns the existing "not yet seeded" prose note — already graceful). Gemini stays live-resolved; built-in behavior unchanged. ⚠ Delegated: mechanics (dynamic enum at server construction vs `z.string()` + runtime validation) are plan-level; the agent-facing contract is "catalog tools answer for every routable provider id."

## 5. The six deferred design questions — decided

| # | Question | Position | Where |
|---|---|---|---|
| 1 | Registration mechanism | Manifest `provider:` block in plugin.yaml (one per plugin); entry exports `createProviderModule(kit)`; never convention/auto-discovery | §4.1, §4.2 |
| 2 | Load timing | Boot-only; `hive plugin add`/`remove` already restart; SIGUSR1 never touches provider code | §4.6 |
| 3 | Unload/rollback | No hot unload. Repoint models + SIGUSR1 (grok pattern) for agent-level rollback; `plugin remove` + auto-restart for removal; declared-broken ⇒ honest per-turn `TurnAssemblyError`, never silent Claude fallback; orphan-prefix warn + doctor line | §4.3, §4.6 |
| 4 | Version handshake | Exact-match integer `LANE_B_PROVIDER_ABI_VERSION` (=1) in the manifest, fail-closed to declared-broken; orthogonal to `hiveApi`; bumps are registered decisions | §4.7 |
| 5 | Parity-matrix obligations | Engine documents the plugin-provider *class* in `docs/providers.md`; per-provider parity is a plugin README obligation enforced by registry curation | §4.10 |
| 6 | Breaker/outage integration | Automatic via provider-string keying (lazy maps, R2 type relaxation only); classification fidelity is a documented authoring obligation; config faults stay `TurnAssemblyError`/non-provider | §4.8 |

## 6. Edge cases

1. **Two plugins declare the same id** — first registration wins deterministically (plugin load order = `appConfig.plugins` order); the second is declared-broken with both names in the reason. Never last-wins silent shadowing.
2. **Plugin id collides with a future engine built-in** — reserved set blocks today's ids; if a later engine version promotes an id a plugin already uses, the built-in seeds first and the plugin goes declared-broken (visible), not shadowed. Noted in authoring docs (pick vendor-distinct ids).
3. **Factory throws / returns garbage** — try/caught at load; non-conforming return (missing `createAdapter`, `provider` mismatch vs manifest id) ⇒ declared-broken. A throw from `createAdapter` at spawn time lands in `runOneSpawnAttempt`'s recorded try and classifies via `classifyThrown` like any adapter construction fault today.
4. **Adapter misbehavior at turn time** — the scaffold's containment frame (if used) bounds it; a module that bypasses the kit entirely is still bounded by the manager's existing per-spawn try + breaker accounting. A hang is bounded by the #407 wall-clock deadline **only if** the module honors `resourceLimits.timeoutMs` — scaffold users get this free; documented as the reason the authoring docs say "extend the scaffold" in bold.
5. **`hive credentials add SOL_API_KEY`** — does NOT work today (r1 correction): `addCredential` rejects keys absent from the static `CREDENTIAL_REGISTRY` (`src/cli/credentials.ts:111-116`, exit 1 "Unknown key"). The Keychain *resolution* chain does read arbitrary `hive/<instanceId>/<KEY>` entries (`honeypot set` works as the raw fallback), but the declared-broken/missing-key error text directs operators to `hive credentials add <KEY>` — so **extending the credentials CLI to accept manifest-declared provider keys is a definite in-scope deliverable** (touches `src/setup/credential-registry.ts`, which bootstrap also consumes — the plan must verify bootstrap is unaffected), not a conditional.
6. **Model with no plugin default** (`sol/` malformed or bare) — falls through the module's own chain (`route.model || providerConfig.agentModel || module literal`); a module with no literal default should fail its turn with an honest message (authoring guidance), never guess.
7. **Effort suffix on plugin models** — parsed generically, delivered on `route.reasoningEffort`; mapping/coercion/warn-once is module-owned (grok/gemini precedents cited in authoring docs).
8. **Voice / KPR-386 surfaces** — provider-pinning caveats in `docs/providers.md` (voice unsupported off-Claude) apply to plugin providers identically; no new statement needed beyond the class section's pointer.
9. **`agent_turn_telemetry` / activity log / C20 `intentTrailer`** — provider-agnostic manager writes keyed on the route provider string; plugin providers appear with their own id, Claude-control comparison unaffected.

## 7. Verification strategy

- **Zero-behavior-change pin for built-ins:** the full existing suites (adapter, manager, breaker, classification, turn-assembly, tool-bridge, provider-modules) pass with **no expectation edits except the enumerated R3 record-literal deltas** in tool-transport tests (each listed in the PR body, C10/C16 discipline — enumerate, don't claim compile-forced).
- **New tests (additive):** manifest parse/validation (regex, reserved ids, abi mismatch, singular-key rules); registry seeding + collision + declared-broken; `resolveProviderModel` with registered/broken/undeclared plugin prefixes; semantics overlay + `persistsResumableHandle` for both declared values; slice resolution with injected `resolveSecret` (env-first, Honeypot-fallback, missing-key `TurnAssemblyError` message shape); base-URL validation accept/reject; `partitionInventoryForProvider` `laneB` fallback + built-in bit-identity; breaker + outage keying with a novel id; both manager construction sites building a **fixture plugin module** (in-repo test fixture: manifest + factory returning a fake adapter) in primary and nested contexts, including the G4 primary-only history rule; kit injection round-trip (factory receives the real scaffold class and can extend it); catalog-tool acceptance of a registered id.
- **Negative verification** (repo practice): break the abi number in the fixture manifest and confirm declared-broken + honest turn failure; unregister the fixture and confirm the undeclared-prefix canon (and the orphan warn) — evidence the honest-failure path is exercised, not assumed.
- **Docs check:** `docs/providers.md` diff contains exactly the §4.10 sections + History entry.
- **Bundle guards:** `npm run check:bundle` green — the `exports`-map addition and the `provider-abi` barrel must not disturb the four bundle guards.
- **Live smoke (operator-run, optional):** install the fixture (or a trivial echo-provider plugin) on a dev instance via `hive plugin add` from a local registry file; one turn end-to-end; remove + restart; confirm doctor lines at each step.

## 8. Open assumptions (all ⚠-delegated, none blocking)

- ⚠ Manifest key names/shape (`api-key-env`/`base-url-env` singular keys) — plan may rename; substance (engine-resolved, secret-env chain, singular slots) is the decided part.
- ⚠ Kit member list floor (scaffold, loop, sse, createLogger) — additions during implementation require the "every member is frozen ABI" test.
- ⚠ `server-resumable` plugin providers get no manager-arm stale-handle self-heal in v1 (in-adapter healing is their lever); a matcher hook is future registered ABI.
- ⚠ Types via `@keepur/hive/provider-abi` subpath export with `exports`-map addition — verify no regression to existing entry-point resolution and the bundle guards.
- ⚠ Model-catalog enum-widening mechanics (dynamic enum vs string + runtime validation).
- ⚠ Parity obligation for third-party providers is prose + curation, not code-enforced.
- (resolved at spec review r1) The credentials-CLI extension for manifest-declared provider keys is a definite deliverable — see §6 edge 5; no longer an open assumption.
