# KPR-346 Task 0 — V1 credential-precedence spike (the BLOCKING gate)

**Worktree:** `hive-kpr-346` @ branch `kpr-346`, HEAD `01175ea` · Node v24.16.0 · macOS (Apple Silicon, subscription-logged-in dev Mac) · 2026-07-23.
**SDK:** `@anthropic-ai/claude-agent-sdk` **0.2.104** · **bundled CLI 2.1.104 (Claude Code)**. *The precedence finding is CLI-version-scoped — re-verify if the SDK/CLI major changes.*
**Driver:** `<session-scratchpad>/kpr346-spike.ts` (the canonical Step 0.1 driver, verbatim), run under `npx tsx`. **NEVER COMMITTED.** The probe token `sk-kpr346-fake-precedence-probe` is fake by design; no real credential or key material was ever printed (vendor 401s mask all but a 4-char tail — see L2).

**Blocking-gate verdict: GREEN — all precedence legs pass in the production-faithful (launchd) context. Tasks 1–5 may proceed.** The injected `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` **outrank** the subscription OAuth session for `query()` turns — the token rides as **`Authorization: Bearer`**. **One load-bearing caveat surfaced (feeds Task 2 §D5 pin set): precedence is conditional on `CLAUDE_CODE_ENTRYPOINT` — see §Contingency / Entrypoint finding.**

---

## Per-leg verdict table

| Spike leg | Consumed by | Verdict | Notes |
|---|---|---|---|
| L1 env precedence (base URL + token used) | Task 2 env builder (§D5) | **GREEN** | Base URL honored in **every** configuration. Injected token carried as **`Authorization: Bearer <token>`** (`bearerMatches: true`), **not** `x-api-key` — auth scheme = **Bearer**. Conditional on entrypoint (below). |
| L2 vendor 401 negative control | Task 2 + §D7 classification row (foreign 401 → auth kind) | **GREEN** | Invalid token ⇒ **vendor** HTTP 401 (auth-error JSON), **never an OAuth completion**. DeepSeek echoes the fake-token tail `****robe` — proof the *injected* token reached the vendor, not the OAuth token (`****agAA`). |

---

## L1 — local-listener probe (deterministic, no vendor account)

A `127.0.0.1:8377` listener records `Authorization` scheme + whether the header equals `Bearer <FAKE_TOKEN>` / `x-api-key == FAKE_TOKEN`, then returns a synthetic 401.

**Production-faithful run (launchd context simulated — `CLAUDE_CODE_ENTRYPOINT` stripped so the SDK stamps its default `sdk-ts`):**

| field | value |
|---|---|
| request reached listener | **yes** — `POST /v1/messages?beta=true` (plus one unauthenticated `GET /` capability/preflight ping) |
| `scheme` | `Bearer` |
| `bearerMatches` | **`true`** on every `/v1/messages` hit (~11 — the CLI retries the synthetic 401) |
| `xApiKeyMatches` | `false` |
| turn result | errored honestly (`Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"kpr346 probe"}}`) |

**Winning auth mechanism (Task 2 pin set): the injected `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer <token>`.** `ANTHROPIC_API_KEY`-as-`x-api-key` was **never** needed (no Decision Register Entry required — the plan's default `authToken` carrier stands; see §Contingency for the API_KEY-carrier attempt).

---

## L2 — vendor negative controls (invalid token ⇒ vendor 401, not OAuth completion)

Raw single-request captures against the real vendor endpoints with the **fake** token (deterministic; the CLI-driver leg produces the identical outcome but retries the 401 many times against the live vendor, so the raw capture is recorded here as the authoritative shape):

**L2a — Kimi** `POST https://api.moonshot.ai/anthropic/v1/messages?beta=true` → **HTTP 401**
```json
{"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}
```

**L2b — DeepSeek** `POST https://api.deepseek.com/anthropic/v1/messages?beta=true` → **HTTP 401**
```json
{"error":{"message":"Authentication Fails, Your api key: ****robe is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}}
```

`****robe` is the masked tail of `sk-kpr346-fake-precedence-probe` (…`probe` → `robe`) — **the injected token is what the vendor rejected**, not the subscription OAuth token (which, when it leaks — see §Contingency — masks to `****agAA`). Both vendors return their own auth-error 401 shape; **no OAuth fallback / silent completion ever occurred** ⇒ env WINS. **§D7 mapping:** a foreign endpoint's 401 is a plain auth-error JSON body (`type: *_authentication_error` / `invalid_authentication_error`), distinguishable from an Anthropic 401 by body shape — classify as provider **auth** fault (breaker-eligible), not a `TurnAssemblyError`.

---

## Contingency ladder / root-cause (§V1) — the entrypoint finding

The canonical driver spreads `...process.env`. Run **verbatim inside a Claude Code session** (as this spike was), L1 **initially reported env LOSES**: the base URL was honored, but the Bearer value was the **subscription OAuth token** (`bearerMatches: false`; DeepSeek showed `****agAA`, not `****robe`). The contingency ladder was walked:

1. **`ANTHROPIC_API_KEY` as carrier instead of `ANTHROPIC_AUTH_TOKEN`** (Step 0.2.1) — **also LOST** (DeepSeek still `****agAA`). So a carrier swap is not the fix; **no Decision Register Entry is warranted** (the API_KEY-carrier path was tried and rejected — the plan's `ANTHROPIC_AUTH_TOKEN`/Bearer posture is correct).
2. **CLI force-mode surfaces** (Step 0.2.2). Root cause located in the bundled CLI's auth gate:
   - Client build (cli.js): `W = { apiKey: U7() ? null : envKey, authToken: U7() ? oauthAccessToken : undefined }`. When `U7()` (subscription mode) is truthy the **OAuth access token is forced and env carriers are nulled**.
   - `U7() = oJ() && hasSubscriptionScopes`. `oJ()` returns `!( cloudFlags || (authTokenPresent && !SV8()) || (apiKeySource && !SV8()) )`, **but** the live decision keys on `CLAUDE_CODE_ENTRYPOINT`: the CLI treats any entrypoint that is **not** `sdk-ts` / `sdk-py` / `sdk-cli` / `local-agent` as **first-party interactive Claude Code → prefer OAuth** (`cli.js`: `q!=="sdk-ts"&&q!=="sdk-py"&&…`).
   - The parent Claude Code session exports **`CLAUDE_CODE_ENTRYPOINT=claude`**; `...process.env` leaked it into the child, so the child self-identified as first-party and preferred OAuth. (`CLAUDE_CODE_SIMPLE=1`/`--bare` also flips the gate but **hangs the SDK `query()` streaming protocol** — not a usable override.)

**Resolution — env precedence is real in production.** The Agent SDK sets `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` **only when the var is unset**. Under launchd (the hive's production context) none of the outer `CLAUDE_CODE_*` session vars exist, so the child is stamped `sdk-ts` ⇒ `U7()` false ⇒ **injected `ANTHROPIC_AUTH_TOKEN` (Bearer) wins**. Confirmed by clearing `CLAUDE_CODE_ENTRYPOINT` before the spawn: L1 flipped to `bearerMatches: true` on every hit (the production-faithful run recorded above). **No STOP condition — the ladder ended at a supported, default-in-production mechanism.**

### → Task 2 (§D5 `buildPassthroughEnv`) action — defensive pin

The precedence guarantee holds by default under launchd, **but** is conditional on the child not inheriting a non-SDK `CLAUDE_CODE_ENTRYPOINT`. **Recommendation (fold into `buildPassthroughEnv`):** in addition to `ANTHROPIC_API_KEY: undefined` and `CLAUDECODE: undefined`, **scrub `CLAUDE_CODE_ENTRYPOINT` from the passthrough env spread** (let the SDK restamp `sdk-ts`) — defense-in-depth so passthrough precedence is guaranteed even if the engine is ever launched from a context that set it (nested Claude Code, `code_task`, dev `npm run dev` under an outer session). Low-cost, isolated to the pin set. Add a runner-test assertion: passthrough env must **not** carry a `CLAUDE_CODE_ENTRYPOINT` of `claude`/`cli` (either absent or `sdk-ts`).

---

## Evidence (commands + exit codes)

- `node --version` → `v24.16.0` (Node 22/24 requirement met; **not** 26). exit 0
- SDK/CLI: `require(...claude-agent-sdk/package.json).version` → `0.2.104`; `node cli.js --version` → `2.1.104 (Claude Code)`. exit 0 (`npx claude --version` does **not** work — no such bin; the CLI is `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`)
- Canonical driver, verbatim, inside session → **L1 env LOSES** (contamination). exit 1
- `kpr346-spike-c1.ts` (API_KEY carrier) → **L1 env LOSES** (DeepSeek `****agAA`). exit 0
- `kpr346-spike-c2.ts` (`CLAUDE_CODE_SIMPLE=1`) → **hung** `query()` (killed, exit 144) — unusable override
- `kpr346-spike-min.ts` MIN-3 (`CLAUDE_CODE_ENTRYPOINT` cleared) → **injected token reached endpoint: true** (`bearer: true`) — root cause pinpointed
- `env -u CLAUDE_CODE_ENTRYPOINT npx tsx kpr346-spike.ts` (launchd-faithful) → **L1 env WINS** (`bearerMatches: true` all hits). L2 legs then retry the live vendor 401 (slow) — captured raw instead ↓
- Raw `curl` L2 with fake token → Kimi **HTTP 401** `invalid_authentication_error`; DeepSeek **HTTP 401** `****robe is invalid`. exit 0
- Run prep: child worktree lacked `node_modules` → symlinked from `/Users/mokie/github/hive/node_modules` (main repo has the SDK); scratchpad also symlinked + `{"type":"module"}` package.json added so tsx runs the top-level-await ESM driver. All scratch-only, uncommitted.

---

## V2–V6 delivery checklist (placeholder — Task 5 fills this in)

Delivery-time live-endpoint validation, graceful-degradation posture (funded vendor keys optional/deferred/non-gating per HUMAN_DIRECTIVE precedent — keys absent ⇒ document + defer, code still ships; production reassignment stays gated).

| Leg | What to run | Verdict |
|---|---|---|
| V2 full-runtime fidelity | Reassign one dev agent `kimi/…` then `deepseek/…` (`admin_agent_update` + SIGUSR1): MCP round-trips (in-process + stdio), archetype PreToolUse hook, skill load, one Task subagent spawn (**no Claude model id in vendor console logs**), streaming partials, second-turn resume (provider-tagged `sessions` row) | _TBD (Task 5)_ |
| V3 server-side tool absence | Invoke WebSearch/WebFetch on the foreign endpoint; record failure shape; file strip-server-side-tools follow-up if turn-fatal & non-trivial | _TBD (Task 5)_ |
| V4 `:effort` delivery | Turn with `:high` — vendor accepts/ignores without turn-fatal error | _TBD (Task 5)_ |
| V5 breaker/outage live | Point table baseUrl at an unreachable host: 3 turns → `kimi` circuit opens (`circuit_breaker_stats` provider `kimi`), one honest-outage notice, queue + replay on restore; a Claude agent keeps working | _TBD (Task 5)_ |
| V6 KPR-313 live | Reassign a threaded agent `claude→kimi` mid-thread: annotation observed, fresh session; reverse and verify inverse | _TBD (Task 5)_ |
