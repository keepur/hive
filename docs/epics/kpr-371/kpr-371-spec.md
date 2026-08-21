# KPR-371 — Grok (xAI) support in Hive's agents

**Ticket:** KPR-371 (child of epic KPR-368; sibling KPR-370 covers the beekeeper half, separate repo).
**Consumers of this spec:** the `write-plan` worker and the implementing lane session.
**Repo baseline:** `kpr-371` @ `dd8abf5` (= `main` @ `dd8abf5`).
**Operator rulings (May, 2026-08-15 brainstorm session):**
- **R1 — Scope: selectable route.** Grok is one more provider an agent can be pinned to. Cross-provider failover was considered and explicitly set aside.
- **R2 — Sequencing: spike first, then build.** The spike is **complete** and its findings are recorded in §3; implementation is unblocked.
- **R3 — Lane A.** Initially ruled Lane B on the belief that Lane A required a paid API key; that premise was empirically falsified (§3.2) and the ruling was revised to Lane A.
- **R4 — Subscription auth, no API key.** Consistent with fleet posture: Claude and codex both run subscription auth. No `XAI_API_KEY` path in v1.
- **R5 — Credential ownership: share the CLI's file.** Hive reads and writes `~/.grok/auth.json`, the same credential the `grok` CLI owns. Operator logs in once via `grok login`.
- **R6 — Default model `grok-4.6`; route prefix `grok/`.**

## TL;DR

Hive gains a `grok/…` provider route that runs on xAI's **Anthropic-compatible** endpoint (`https://api.x.ai`) through the existing **Lane A passthrough** — the full Claude runtime (MCP tools, skills, memory, hooks, resume, delegate subagents) with per-spawn env substitution, no new execution path. The one genuinely new piece is **auth**: unlike kimi/deepseek (static API keys), Grok authenticates with a **subscription OAuth token** read from `~/.grok/auth.json`, which expires every 6 hours and whose refresh token **rotates on use** — so hive must refresh and write back, under a single-flight guard, or it will break the operator's `grok` CLI login.

## Key Points

- **Lane A, not Lane B.** xAI serves a working Anthropic Messages API at `api.x.ai/v1/messages`. Verified live: tool-use round-trip, prompt caching, and thinking blocks all work under subscription auth. Lane A therefore gives full hive-runtime parity for ~7 files and no new code path; the Lane B ACP adapter is filed as a follow-up, not built here.
- **Subscription auth works against the public API — deliberately.** The OAuth JWT carries an `api:access` scope, and `api:access` is a first-class entry in xAI's published OIDC discovery document. This is *not* the OpenAI/ChatGPT split that KPR-351 hit; no doomed round-trip risk.
- **`ANTHROPIC_AUTH_TOKEN` is the correct carrier, empirically.** `Authorization: Bearer <oauth token>` returns 200; `x-api-key: <oauth token>` returns 400. Lane A's existing env pin — set `ANTHROPIC_AUTH_TOKEN`, scrub `ANTHROPIC_API_KEY` — is already exactly right. This closes the inference gap flagged during research (the repo previously only ever populated that var with a static key).
- **Refresh-with-write-back is mandatory, not optional.** Access token TTL is 6h; the refresh grant returns a **rotated** refresh token and spends the old one. A read-only "seed" design would sign the operator's CLI out on first refresh. Verified end-to-end: refresh → atomic 0600 write-back → CLI still authenticates → new token still reaches the API.
- **One structural change to Lane A:** `PassthroughProviderDef.authTokenKey: string` assumes a static key. It becomes a discriminated credential source so a provider can declare either an env/Honeypot key (kimi, deepseek — unchanged) or an OAuth file (grok).
- **Ops surfaces come free.** The circuit breaker and outage queue key generically off `AgentProviderId`; adding the union member gives Grok its own breaker, its own outage queue, and honest-outage behavior with no registry edits.
- **Documented caveats:** subscription exposes only `grok-4.6`/`grok-4.5` (the API's wider menu is unreachable); `:effort` is clamped to `{low,medium,high}` by the existing Lane A clamp — out-of-set values are **dropped with a warning, not coerced** — so Grok's native `xhigh` is not expressible; no Anthropic server-side tools; `costUsd` is nominal (Claude pricing) as with all Lane A providers.
- ⚠ **Assumption to re-verify at implementation time:** whether subscription-token traffic on `api.x.ai` bills the subscription pool or an API-credit balance. It returned 200 on an account with no API credits purchased, which implies the subscription pool, but xAI does not document this. Not a blocker; it is a cost-attribution unknown to watch.
- ⚠ **Supply-chain note:** `@xai-official/grok` is the official CLI (`xai-org/grok-build`, Apache-2.0, publisher `security@x.ai`). Hive does not depend on it at runtime — it only reads the credential file the CLI produces. The operator must run `grok login` once per machine.

## 1. Problem / Context

Hive agents run on Claude by default, with `kimi/…` and `deepseek/…` available as Lane A passthrough routes and `openai`/`gemini`/`codex` as Lane B native adapters (KPR-345/346). KPR-368 asks for Grok as a second frontier model across beekeeper and hive; this ticket is the hive half.

The ticket was filed noting that hive's provider mechanism was unresearched from beekeeper's vantage point and warning against assuming beekeeper's findings transfer. They do not: hive already has a two-lane provider architecture, and the work is to add a row to it — plus solve an auth shape hive has not previously handled.

## 2. Goals / Non-goals

**Goals.** An operator sets an agent's `model` to `grok/grok-4.6`, sends SIGUSR1, and that agent runs on Grok with full hive-runtime parity, authenticated by the machine's existing `grok login` session, with Grok-specific breaker/outage isolation and an honest parity-matrix row.

**Non-goals.** Cross-provider failover (R1). A Lane B ACP adapter (follow-up). `XAI_API_KEY` support (R4). Per-turn model selection — models remain static per agent (KPR-338). Beekeeper's own sessions (KPR-370).

## 3. Spike findings (complete — evidence for every design decision below)

All probes run 2026-08-15 against a live SuperGrok subscription on this machine.

### 3.1 The Anthropic-compatible endpoint exists
`POST https://api.x.ai/v1/messages` with an invalid key returns `400 invalid-argument` ("Incorrect API key provided"); a nonexistent route on the same host returns `404`. The handler exists and parses Anthropic-format requests. xAI's docs nav does not document it; the x.ai marketing claim of Anthropic compatibility is accurate.

### 3.2 Subscription OAuth authenticates it
With the `~/.grok/auth.json` access token as `Authorization: Bearer`, the same request returns **200** with a valid Anthropic-shaped body (`type: message`, `thinking` + `text` blocks, `model: grok-4.6`). The same token as `x-api-key` returns **400**. JWT claims: `iss=https://auth.x.ai`, `scope=openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write`.

### 3.3 Tool use and caching work
A request carrying an Anthropic `tools` array returned `stop_reason: tool_use` with a well-formed `tool_use` block (correct `name`, `input`, `id`). Usage reported `cache_read_input_tokens: 128`, so prompt caching is active on the compat path.

### 3.4 Token lifetime and rotation
Access token TTL is **21600s (6h)**. OIDC discovery at `https://auth.x.ai/.well-known/openid-configuration` publishes `token_endpoint: https://auth.x.ai/oauth2/token`, `grant_types_supported` including `refresh_token`, and `token_endpoint_auth_methods_supported` including `none` — a public client refresh needs only `client_id` + `refresh_token`, both present in `auth.json`.

The same discovery document advertises `scopes_supported` including **`api:access`** (alongside `openid`, `profile`, `email`, `offline_access`, `grok-cli:access`, `team:read`, `org:read`, `grok-plugins:access`, and the conversations/workspaces pairs) — the published-contract evidence that subscription API access is deliberate, complementing the JWT claim in §3.2.

A live refresh returned a **new access token and a rotated refresh token**; the prior refresh token is spent. Writing the new pair back to `~/.grok/auth.json` (atomic replace, mode preserved 0600) left the `grok` CLI fully working and the new token valid against the API. **Read-only credential sharing is therefore not viable.**

### 3.5 Model menu under subscription
`grok models` reports `grok-4.6` (default) and `grok-4.5`. The API's broader catalogue (grok-4.3, the 1M-context 4.20 family, grok-build-0.1) is not offered to the subscription session.

### 3.6 `auth.json` shape
Single top-level entry keyed `https://auth.x.ai::<client_id>`, whose value carries `key` (access token), `refresh_token`, `expires_at` (ISO-8601 Z), `auth_mode`, `oidc_issuer`, `oidc_client_id`, plus profile/team fields. Implementations must key off the first (only) entry rather than a hardcoded string, and must preserve unknown fields on write-back.

## 4. Design

### D1 — Route and table entry
Add `grok` to `LaneAProviderId` and `AgentProviderId`; add a `SESSION_SEMANTICS` entry of `client-transcript` (matching the other Lane A members). Table row: `displayName: "Grok (xAI)"`, `baseUrl: "https://api.x.ai"`, `defaultModel: "grok-4.6"`.

**Complete touch-point list.** Compile-forced — the type system catches omissions:
- `types.ts` — `AgentProviderId` union member; `SESSION_SEMANTICS` entry (keyed `Record<AgentProviderId, …>`).
- `passthrough-providers.ts` — `LaneAProviderId` union member; table row.
- `agent-manager.ts:587` — the `ClaudeAgentAdapter` return gate. `route.provider` narrows past it into `assembleProviderTurn`, whose parameter is typed `LaneBProviderId` (`turn-assembly.ts:174`), so omitting this gate is a compile error.

**Not** compile-forced — omitting any of these compiles clean and fails silently:
- `passthrough-providers.ts:58-60` — the **`isLaneAProvider` body**, a hand-written `p === "kimi" || p === "deepseek"` type predicate. Miss it and grok turns take the wrong branch at **two** sites: `agent-manager.ts:1663`, where the session-handoff notice degrades to the Lane B variant, and `agent-manager.ts:1674`, where `:effort` is silently dropped instead of clamped. No compile error, no runtime error. **This is the highest-risk omission in the change.**
- `agent-manager.ts:571` — the `resolvePassthroughSpawn` gate. Omit it and grok yields a `ClaudeAgentAdapter` with no passthrough env: a grok model id sent to Anthropic's endpoint.
- `agent-manager.ts:184` — the `ProviderModelRoute` union arm. Listed here rather than above because adding `grok` to `AgentProviderId` does not by itself force it; it is only forced once the prefix arm below exists.
- `agent-manager.ts:204-209` — the `resolveProviderModel` prefix arm.

`PassthroughSpawnConfig.provider` widens automatically with the union, and `AgentRunner` takes the config opaquely, so no runner-side change follows.

Model resolution keeps the existing chain, unchanged (`passthrough-providers.ts:112`): **route model → configured (`GROK_AGENT_MODEL`) → table default**. An explicit `grok/grok-4.5` route therefore wins over the config override, not the reverse.

### D2 — Credential source (the one structural change)
`PassthroughProviderDef` today has `authTokenKey: string`, hardwiring "static key from env or Honeypot". Replace with a discriminated `credential` field:

- `{ kind: "env-key", key: "KIMI_API_KEY" }` — existing behaviour, kimi/deepseek unchanged.
- `{ kind: "oauth-file", path: "~/.grok/auth.json" }` — new, grok.

`resolvePassthroughSpawn` branches on the discriminant. The `env-key` branch is byte-for-byte the current logic. The `oauth-file` branch is §D3. Both return the same `PassthroughSpawnConfig`, so `buildPassthroughEnv` and the runner are untouched.

### D3 — OAuth refresh mechanics
On each spawn, for an `oauth-file` provider:

1. Read and parse the credential file; take the single entry.
2. If `expires_at` is more than the **refresh threshold of 60 minutes** in the future, return `key` as-is. This is the common case; no network call on the hot path. `expires_at` is authoritative — do not decode the JWT `exp` (the codex precedent does, but there is no need to here). If `expires_at` is missing or unparseable, refresh.
3. Otherwise perform the refresh grant (`grant_type=refresh_token`, `client_id`, `refresh_token`) against the issuer's token endpoint, derived from `oidc_issuer` in the file via OIDC discovery — do not hardcode the token URL.
4. Write the rotated pair back: update `key`, `refresh_token`, `expires_at`; preserve every other field; write to a temp file in the same directory, `chmod 0600`, then atomically replace.
5. Return the fresh access token.

**Why hive performs the grant rather than delegating to the vendor CLI.** The in-repo precedent (`oauth-credentials.ts`) refreshes codex by shelling `codex login status` and letting the CLI own its file. That is not available here: `grok login --help` exposes no refresh or token subcommand, and a live `grok models` invocation left `expires_at` untouched — there is no documented headless refresh trigger to shell. Hive therefore performs a standard public-client OIDC grant, which the spike validated end-to-end (§3.4). This is why the rotation race below is hive's problem to solve rather than the CLI's.

**Single-flight is required.** The spawn budget defaults to 5 and threads run in parallel, so concurrent spawns can hit an expiring token simultaneously. Two spawns racing the rotation grant would spend each other's refresh token and hard-break the credential. Serialize per credential path with an in-process promise-keyed mutex, and have losers re-read the file rather than issue their own grant.

**Failure modes** all raise `TurnAssemblyError` — classified `non-provider`, so they never trip the Grok circuit breaker, matching the existing missing-credential contract:
- file absent / unparseable → message directing the operator to run `grok login`
- refresh grant rejected → **re-read the credential file once before failing.** A rejected grant most often means another process legitimately refreshed first — the interactive `grok` CLI, or a second hive instance — leaving a valid fresh pair on disk. If the re-read yields an unexpired token, use it and proceed. Only when the re-read still shows an expired or absent credential is the refresh token genuinely revoked; raise then, with its own distinct message. This is the mechanism behind the cross-process self-healing claimed in §6
- **transient network failure** on the discovery or grant fetch, **while the on-disk token is still unexpired** (inside the 60-minute threshold but not yet dead) → **log a warning and proceed with the valid token**. It works, and failing here would ground every turn during an `auth.x.ai` blip while hive holds a perfectly usable credential. The residual exposure is the accepted mid-turn-expiry case below
- **transient network failure** with an already-expired token → a distinct message naming the network cause, *not* the `grok login` text, which would misdirect the operator during an `auth.x.ai` blip. Deliberate consequence: an xAI auth-server outage surfaces as `non-provider` faults — no breaker trip, no outage-queue replay
- write-back failure → **fail the turn**, with its own distinct message. Once the grant has been issued the old refresh token is spent regardless of whether the turn proceeds; what failing buys is immediate, attributable surfacing at the moment the file went stale, instead of a delayed mystery break. Subsequent spawns will take the rejected-grant path above and, after the re-read confirms nothing fresher landed, direct the operator to `grok login`.

**Mid-turn expiry — ruled, accepted.** The token is resolved once per spawn and pinned into `ANTHROPIC_AUTH_TOKEN` for the whole turn; nothing refreshes it mid-flight. A turn that outlives the remaining TTL starts returning 401s, and those classify as `auth` **provider** faults — unlike the spawn-time failures above, they count toward the grok breaker's trip streak. The 60-minute threshold (vs. the 6h TTL) is sized so this cannot occur for any turn shorter than an hour, which covers every normal channel turn. Turns that genuinely exceed an hour (long `code-task` sessions) remain exposed, and that is **accepted**: the failure self-heals — the breaker isolates grok only, and the outage queue replays the turn on a fresh spawn that resolves a new token. Rejected alternative: refreshing mid-turn would require reaching into a live spawn's pinned env, which Lane A's design deliberately forbids.

**Implementation notes.** The `oauth-file` branch makes `resolvePassthroughSpawn` async (filesystem + network). `createProviderAdapter` is already async so the change is contained, but it ripples into `passthrough-providers.test.ts`: tests need a **fetch seam** alongside the existing `resolveSecret` seam for the contract's no-network requirement to hold. Expand `~` in the configured path; apply a bounded timeout to both fetches; cache OIDC discovery per process so refresh costs one round-trip, not two.

### D4 — Env pin
Unchanged from the existing Lane A shape: `ANTHROPIC_BASE_URL` = table `baseUrl`, `ANTHROPIC_AUTH_TOKEN` = resolved access token, `ANTHROPIC_API_KEY: undefined`, all model pins + `CLAUDE_CODE_SUBAGENT_MODEL` set to the one resolved model, `ENABLE_TOOL_SEARCH: "false"`, `CLAUDE_CODE_ENTRYPOINT: undefined`. §3.2 confirms the bearer carrier is correct for an OAuth token.

### D5 — Ops
No breaker or outage-queue edits: both key off `AgentProviderId`. Grok gets an isolated breaker, its own outage queue, and honest-outage notices by construction. The session-handoff notice must use the Claude-runtime variant (`isLaneAProvider` already governs this). The model router stays skipped for Lane A; static `:effort` delivers through `clampLaneAEffort`.

### D6 — Config and credential registry
Add `grok: { agentModel: optional("GROK_AGENT_MODEL", "") }` in `src/config.ts`, mirroring kimi/deepseek. **No secret entry** — the credential is never boot-time resolved.

**Ruling: omit Grok from `src/setup/credential-registry.ts` entirely in v1, and add no new `hive doctor` check.** The registry drives `hive credentials add <KEY>`, a paste-a-secret flow that does not apply here — listing Grok would advertise an interaction that cannot succeed. The remediation surface is the `TurnAssemblyError` message (§D3), which names `grok login` at the moment of failure. A doctor line reporting credential presence/expiry is a reasonable future addition, but it is a new check with its own acceptance criteria and exit-code semantics (per KPR-296 only identity-class checks may flip the exit code); it is filed as a follow-up (§7) rather than smuggled in here.

### D7 — Documentation
`docs/providers.md` gains Grok cells across all 17 parity rows with footnotes for: subscription-only model menu (§3.5), no `xhigh` effort, no Anthropic server-side tools, nominal `costUsd`, and the once-per-machine `grok login` prerequisite. Add a History entry. CLAUDE.md's "Provider adapters" section gains Grok in the Lane A sentence.

## 5. Testing contract

- **Table/unit** (mirroring `passthrough-providers.test.ts`): table shape; `isLaneAProvider("grok")`; model resolution chain; `buildPassthroughEnv` exact pin record for grok.
- **OAuth resolution** (new, filesystem- and fetch-mocked, no real network): valid unexpired token returned without a grant; expiring token triggers a grant and write-back; write-back preserves unknown fields and 0600; rotated refresh token is persisted; missing file, unparseable file, rejected grant, network failure, and write-back failure each raise `TurnAssemblyError` — and the network-failure message is distinct from the `grok login` message.
- **`isLaneAProvider("grok")` returns true**, asserted directly — the highest-risk of the four touch points the compiler cannot enforce (§D1); the remaining three are covered by the `providerFor` and spawn-path tests below.
- **Single-flight** (new): N concurrent resolutions against one expiring credential issue exactly **one** grant; the others observe the refreshed value.
- **Integration** (mirroring `agent-manager.test.ts`): `providerFor` maps `grok/grok-4.6`; a spawn produces the `laneAPassthrough` bag and skips Lane B assembly; missing credential never trips the breaker; three faults trip the **grok** breaker only, leaving Claude and kimi closed; session-handoff notice uses the Claude-runtime variant.
- **Negative-verify** the rotation-persistence and single-flight tests per house rule: revert the source fix and confirm each fails on pre-fix code.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Concurrent spawns race the rotation grant and mutually spend refresh tokens | **High** — hard-breaks the credential and the operator's CLI | Single-flight mutex (§D3); write-back failure fails the turn |
| xAI closes or changes the undocumented Anthropic-compat endpoint | Medium | Breaker isolates it; rollback is resetting the agent's `model` + SIGUSR1. The Lane B ACP adapter is the filed fallback |
| xAI rotates `auth.json`'s on-disk schema | Medium | Key off the single entry, preserve unknown fields, fail with a `grok login` message rather than guessing |
| Subscription traffic on `api.x.ai` is later metered as API credits | Low–Medium | Flagged as an unknown to watch (§Key Points); does not change the code |
| Two hive instances on one machine share `~/.grok/auth.json` | Low | Single-flight is per-process; cross-process racing is possible but bounded — the loser re-reads and retries. Document it |

## 7. Out of scope — follow-ups to file

1. **Lane B ACP adapter for Grok Build.** `grok agent stdio` speaks Agent Client Protocol (JSON-RPC 2.0) with per-session MCP injection via `_meta.pluginDirs`; xAI explicitly supports embedding. Valuable as a hedge if the compat endpoint closes, and as hive's first ACP integration.
2. **Table-drive `resolveProviderModel`.** Its Lane A arms are hand-written string comparisons in `agent-manager.ts`, duplicating knowledge the table and `isLaneAProvider()` already hold in `passthrough-providers.ts`. Grok makes it a third; driving it off the table makes vendor #4 free.
3. **Fail closed on unknown provider prefixes.** `grock/grok-5` currently becomes a Claude call with a garbage model id. Pre-existing, and Grok is the third opportunity to hit it.
4. **Cross-provider failover** (R1) — provider-agnostic, belongs under KPR-368 if wanted.
