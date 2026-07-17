# KPR-313 Spec — W3.4: Session-identity guards + turn-boundary switching

**Epic:** KPR-309 · **Depends on:** KPR-310 (verdict: SAFE-WITH-CONSTRAINTS; consumer statement §KPR-313) · **Serializes after:** KPR-311 **and** KPR-312 (Gate 1 order W3.2 → W3.3 → W3.4; both touch 313's shared files), W2 epic merge (kpr-305 lambda shape) · **Status:** draft

## TL;DR

Session-store rows gain a `provider` tag (store **field**, not id rewriting); `SessionStore.get()` returns a tagged ref and scrubs legacy fabricated ids (`codex-pilot-*`, `gemini-pilot-*`, `resp_*` untagged). `finalizeSpawnResult` persists a resumable id **only** for providers whose adapters actually resume (`claude`, `openai`); codex/gemini rows persist with an **empty** `sessionId` — the row survives (thread→agent mapping intact), the fake handle does not. A guard inside the `spawnTurn` lambda (post-`acquire()`, post-reflection-re-resolve — R7 untouched; zero-I/O on the hot path, one authoritative post-lock re-read only on trip to close the queued-turn stale-tag race) refuses to resume a session whose provider tag ≠ the turn's provider: it strips the id and marks the turn for a **hive-owned handoff** — fresh session + agent memory (already in every fresh system prompt per the standard assembly order) + a one-line prompt annotation telling the agent thread continuity was reset. Voice applies the same eligibility compare at its own store read so a mismatch re-sends the full in-call transcript (its native handoff) instead of a silently context-less fresh turn. No transcript reconstruction, no cross-provider context translation. Under 311's W3 clamp the guard trips only on pre-existing poisoned rows and operator `agent.model` provider edits; the same machinery serves router-driven switching unchanged when the §5 clamp lifts (parked in kpr-311-spec §5 → W3.5/KPR-314).

## Key Points

- **The poisoning is real and traced end-to-end** (§1): `CodexSubscriptionAdapter` fabricates `codex-pilot-${uuid}` (`codex-subscription-adapter.ts:65`) or returns a `store:false` Responses id (`:118`, `state.responseId ?? sessionId`); `finalizeSpawnResult` persists any non-aborted `result.sessionId` — **including error results** (`agent-manager.ts:1156`, HEAD `fc5e5aa`); the next Claude turn resumes it and the CLI answers `No conversation found with session ID: <id>` (verified in the CLI bundle: in stream-json mode this arrives as an in-band `result` message, `subtype: "error_during_execution"`, `is_error: true`, **carrying a freshly minted `session_id`**, then the process exits 1).
- **Ticket-framing reconciliation (honest):** the static trace shows the unknown-resume error string matches **neither** `isAuthRebuildResumeError` (`agent-manager.ts:185-189`) nor any voice-auth sentinel — so on slack/sms/ws the observed shape is an **errored turn + store churn** (each failed turn persists the CLI's freshly minted id), not a silent auth-rebuild retry; on **voice** the outer any-failure retry (`voice-adapter.ts:327-341`) silently drops history; and whenever the auth-rebuild retry *does* fire (genuine auth-shaped errors), it silently drops history by design. All three vectors are preempted by the same guard. One plan step reproduces the poisoned-row resume on a dev instance to pin the exact observed shape (⚠ delegated).
- **Never-persist rule is a provider capability, not string-sniffing:** `RESUMABLE_SESSION_PROVIDERS: ReadonlySet<AgentProviderId> = {"claude", "openai"}` in `provider-adapters/types.ts`. Codex sends no `previous_response_id` and posts `store: false` — stateless by construction; gemini uses `runEphemeral` — same; openai chains via `previousResponseId` (`openai-agents-adapter.ts:63`, returns `lastResponseId`) — genuinely resumable.
- **Rows persist, handles don't:** the session store doubles as the dispatcher's thread→agent map (`findAgentByThread`/`findAgentsByThread`). Skipping writes for pilots would break restart thread-continuity — so pilot turns upsert the row with `sessionId: ""` + provider tag.
- **Guard placement respects R7 exactly:** kpr-305 lambda order is `acquire()` (`:577-581`, on the static provider) → reflection sessionId re-resolve (`:592-599`) → `prepareSpawn` → attempt(s) → one `record()`. The guard is a compare inserted between the re-resolve and `recordSpawn`; on the hot path it is zero-I/O, and **only when it trips** it performs one authoritative post-lock store re-read (§3.3 — closes the queued-turn stale-tag race) before deciding fresh-vs-adopt. Nothing moves across the R7 boundary. Under the clamp, the acquire-time static route provider ≡ the effective `shaping.route.provider` (311 §5 invariant), so keying the guard on the already-in-scope acquire route is exact. Lifting the clamp re-keys `acquire()` *and* this guard together — same parked decision (311 §5 → W3.5).
- **M7b is a feature for hive, not a bug:** ids are stable on SDK 0.2.104 (same id every non-fork resume) and an "older" persisted id resumes the **latest** state — so hive's persist-last-returned discipline stays valid and crash-recovery replay is safe. The secondary hazard the verdict names (no time-travel semantics) needs no code: hive never wants a snapshot. Chain-following remains dormant-but-valid; no new assertion added (YAGNI).
- **Errored-turn persist rider:** an error turn that attempted a resume and came back with a *different* id (the `error_during_execution` fresh-mint churn) no longer overwrites the row. Error turns may only re-persist the **same** id they resumed (TTL refresh). Success-path compaction rotation (KPR-211) is untouched.
- **Turn-boundary switching is structural, and this spec says so** (§4): the adapter is constructed per spawn attempt from a registry read inside the per-thread-locked lambda — there is no mid-turn switch surface. 313 adds the *session-side* correctness for those boundaries (don't resume across a provider change); it builds no scheduler, no switching policy.

## 1. Problem — the poisoning story, traced

### 1.1 The write path (how poison gets in)

1. An agent whose `agent.model` is pilot-prefixed (e.g. `codex/gpt-5.5:medium`) takes a turn. `CodexSubscriptionAdapter.runTurn` sets `const sessionId = request.sessionId ?? \`codex-pilot-${randomUUID()}\`` (`codex-subscription-adapter.ts:65`). Success returns `state.responseId ?? sessionId` (`:118`) — a `resp_…` Responses-API id posted with `store: false` (`:91`), resumable by nothing; error/abort paths return the fabricated `codex-pilot-…` uuid (`:104-151`). Gemini fabricates `gemini-pilot-${uuid}` (`gemini-adk-adapter.ts:56`) and runs `runEphemeral` — same non-handle.
2. `finalizeSpawnResult` (HEAD `agent-manager.ts:1154-1168`; kpr-305 `:1218` — same body plus R4 `timedOut`/`aborted` passthrough) persists it: `if (result.sessionId && !result.aborted)` → `sessionStore.set(agentId, threadId, result.sessionId, …)`. Note the condition — **error results persist too**. The store row `_id: "{agentId}:{threadId}"` (`session-store.ts:6-21`) now claims continuity that does not exist.

### 1.2 The read path (how the next Claude turn breaks)

3. Operator edits the agent back to a Claude model (SIGUSR1 reload). Next turn: `runWorkItemTurn` reads the store (`agent-manager.ts:504`) → `ctx.sessionId = "codex-pilot-…"` → `ClaudeAgentAdapter.runTurn` → `runner.send` → `query({ resume: "codex-pilot-…" })` (`agent-runner.ts:1763`).
4. The CLI cannot find the session. Verified against the pinned SDK bundle (0.2.104 `cli.js`): it emits `No conversation found with session ID: <id>` — in stream-json mode as an **in-band result message** `{type:"result", subtype:"error_during_execution", is_error:true, session_id:<freshly minted uuid>, total_cost_usd:0, errors:[…]}` — then initiates graceful shutdown with exit code 1 (the SDK transport surfaces `Error: Claude Code process exited with code 1` if the iterator is still draining).
5. In `runner.send`'s result handling (`agent-runner.ts:1895-1937`): `resultSessionId = result.session_id` — **the fresh mint, not the poisoned id** — and `error` is set from `result.errors`. The turn fails; the user sees an error.
6. Back in the lambda: `isAuthRebuildResumeError("No conversation found…")` and `…("Claude Code process exited with code 1")` both **miss** the regex (`agent-manager.ts:185-189`) — no retry on slack/sms/ws. `finalizeSpawnResult` then persists the **fresh minted id** (error + non-aborted → write). The next turn resumes an id that corresponds to no real conversation → repeat. The thread is wedged in an error-churn loop until the 7-day TTL, an operator delete, or a turn whose minted id happens to resolve to an empty session file — in which case the turn **succeeds with zero history: the silent drop**.
7. **Voice variant:** the voice adapter's outer retry (`voice-adapter.ts:327-341`, kpr-305 adds only a `circuitOpen` skip) fires on *any* resume failure and reruns as turn-1 with the transcript — the store heals with the retry's real id, but SDK-side thread history is silently gone. **Auth-rebuild variant:** when a genuine auth-shaped error matches the regex, the retry strips `sessionId` and the turn succeeds fresh — silent history drop with only a `log.warn`. The ticket's "via the auth-rebuild retry" phrasing names this vector; the codex-poison path as traced today produces the churn/wedge shape instead. Both are cured by the same guard, and the plan's repro step (⚠A8) pins which shape production actually exhibits.

### 1.3 Secondary hazard (verdict M7b)

A "stale" persisted id is not stale: ids are stable across resumes on 0.2.104, so replaying an older persisted id resumes the **latest** session state, not a snapshot. For hive's crash-recovery (crash between adapter return and `sessionStore.set`) this is exactly the desired semantics. No code needed; recorded here so nobody "fixes" it.

## 2. Anchoring & canon (D2)

**kpr-305 tip note:** the W2 branch advanced to `2ad4194` (KPR-308 W2.3) during this spec's review round; every surface anchored below was re-verified unchanged at the new tip (independent review confirmation + spot re-checks: acquire `:577-581`, reflection re-resolve `:592-599`, `finalizeSpawnResult` `:1218`). Line refs below cite `2ad4194`; **refresh all cites at plan time** (mandatory per Gate 1 D2 anyway).

| Surface | HEAD `fc5e5aa` | `origin/kpr-305` `2ad4194` | Anchor used |
|---|---|---|---|
| `session-store.ts` | full file | **identical** (empty diff) | HEAD refs; **313's primary file** |
| All four provider adapters + `types.ts` | — | **identical** | HEAD refs |
| `spawnTurn` lambda | `:531-591` | `:563-660` — breaker acquire/record wrap | **kpr-305 shape** — guard inserts at `:599` (post-re-resolve) |
| `finalizeSpawnResult` | `:1154-…` | `:1218-…` + R4 `timedOut`/`aborted` passthrough | **kpr-305 shape** |
| `prepareSpawn` / `SpawnShaping` / `createProviderAdapter` | `:1017-1073` / — / `:396-434` | identical to HEAD | **KPR-311's post-delivery shape as amended by KPR-312** (`SpawnShaping.effortOverride`, 312 §3.4) — 313 branches after both child PRs merge |
| `runWorkItemTurn` | `:499-516` | identical | HEAD refs |
| Reflection reads | `:550` (authoritative), `:889` (best-effort) | `:592-599` / shifted | kpr-305 shape |
| `agent-runner.ts` result handling | `:1895-1964` | +R4 `timedOut` stamp (additive) | HEAD refs; **read-only** for 313 |
| `voice-adapter.ts` `sessionStore.get` | `:247` | same call, KPR-307 additions elsewhere | kpr-305 shape |
| `error-classification.ts` | absent | frozen exports, additive-only | **read-only — 313 makes no change** (§7) |

**Canon note:** epic KPR-309 is pre-register; R3/R4/R7 cite W2's register (KPR-305 @ `af74cf7`), binding external canon. 311's provider clamp and pilot gate are spec-ready epic canon — this spec designs *around* the clamp and is explicit about what that makes reachable (§4). 312's `effortOverride` channel is **functionally** disjoint from 313 (313 never touches effort), but 312 edits the same shared files 313 edits — `agent-manager.ts` (`SpawnShaping`), `provider-adapters/types.ts`, `claude-agent-adapter.ts` (312 spec §5) — so serialization is file-level, not just conceptual. Delivery rule: branch from the epic branch after **both** 311's and 312's child PRs merge (Gate 1 order W3.2 → W3.3 → W3.4); re-confirm every line ref at then-HEAD (Gate 1 D2).

## 3. Design

### 3.1 Provider-tagged session rows

**Where the tag lives: a store field.** Ids are opaque provider handles — prefixing them would require strip/re-add at every adapter boundary and would hand the SDK a corrupted resume value on any missed strip. A field is additive, queryable, and invisible to adapters.

```ts
// session-store.ts
interface SessionDoc {
  _id: string;                  // "{agentId}:{threadId}" — unchanged
  sessionId: string;            // "" ⇒ row exists for thread-mapping only; nothing resumable
  provider?: AgentProviderId;   // NEW — producer tag; absent ⇒ legacy (pre-313) row
  …                             // token fields unchanged
}

export interface StoredSessionRef {
  sessionId: string | undefined;      // undefined ⇒ nothing to resume
  provider: AgentProviderId | undefined;
}
```

**`get()` returns `StoredSessionRef | undefined`** (undefined ⇒ no row at all) and owns all normalization at the single choke point:

1. Row absent (incl. legacy-slack fallback miss) → `undefined`.
2. Tagged row: `sessionId: doc.sessionId || undefined` — and if `!RESUMABLE_SESSION_PROVIDERS.has(doc.provider)`, force `sessionId: undefined` (belt-and-braces; post-313 writes never store a handle for those providers anyway). `provider` returned as stored.
3. **Legacy untagged row (poison scrub):** if `doc.sessionId` matches `/^(codex-pilot-|gemini-pilot-|resp_)/` → return `{ sessionId: undefined, provider: undefined }`, `log.warn` once per key, and fire-and-forget `deleteOne` (lazy cleanup; the 7-day TTL is the backstop). The `deleteOne` **must be `.catch`-swallowed** (log-only) — `get()` runs inside the R7 window on the reflection re-resolve path, and a rejected floating promise from a Mongo blip must not become an unhandled rejection or a new throw surface there. Otherwise the row predates the adapters or was written by a Claude turn → `{ sessionId: doc.sessionId, provider: "claude" }` (grandfather rule — the fleet's rows are Claude; this prevents a mass history-drop on upgrade).

   **Deliberate tradeoff on untagged `resp_` rows:** a pre-313 openai-agent row holds a *genuinely resumable* `resp_…` handle, and scrubbing it costs that thread a one-time chain reset. Scrub anyway: an untagged row carries no provenance (nothing says the *current* agent provider still matches the row's producer), and a wrongly-grandfathered `resp_` id handed to a Claude resume reproduces exactly the churn loop this ticket exists to kill. One bounded reset inside the ≤7-day legacy window beats an unbounded failure mode — a decision, not an oversight.

**`set()` gains a `provider` parameter** (positional 4th, before `tokenData`; single production caller). It stores what it is given — the resumability *rule* lives in the manager (§3.2), not the store. **No migration script:** legacy rows are handled by rule 3 and age out ≤7 days via the existing TTL index (`session-store.ts:32`).

Call sites updated to the new `get()` shape: `agent-manager.ts:504` (`runWorkItemTurn` — sets `ctx.sessionId` + `ctx.sessionProvider`), `:550` (reflection authoritative re-resolve — updates both on `effectiveCtx`), `:889` (reflection best-effort pre-read), `voice-adapter.ts:247` (sets both, plus the voice prompt-shape rule in §3.5). **Shape hazard at the reflection re-resolve** (kpr-305 `:594-596`): the existing staleness check is `if (freshSessionId !== ctx.sessionId)` — a string compare that becomes a ref-vs-string compare under the new return type and would then *always* mismatch. It must compare fields: rebuild `effectiveCtx` when `fresh?.sessionId !== ctx.sessionId || fresh?.provider !== ctx.sessionProvider`. `findAgentByThread`/`findAgentsByThread`/`delete`/`clearAgent` unchanged.

### 3.2 Never-persist-non-resumable (the write-side rule)

```ts
// provider-adapters/types.ts
/** Providers whose adapters return a genuinely resumable session handle.
 *  claude: SDK resume (KPR-310-verified). openai: previousResponseId chaining
 *  (openai-agents-adapter.ts:63; server retention 30d > store TTL 7d).
 *  codex: store:false + no chaining — stateless. gemini: runEphemeral — stateless. */
export const RESUMABLE_SESSION_PROVIDERS: ReadonlySet<AgentProviderId> = new Set(["claude", "openai"]);
```

`finalizeSpawnResult(ctx, result, route)` — new third parameter, `shaping.route` from the lambda (post-311 it is already in scope; single call site on the kpr-305 shape):

```ts
if (result.sessionId && !result.aborted) {
  const resumable = RESUMABLE_SESSION_PROVIDERS.has(route.provider);
  // ⚠A4 churn-mint rider: an ERROR turn that attempted a resume and returned a
  // DIFFERENT id is a failed-resume mint (error_during_execution fresh session_id)
  // — never let it overwrite the row. Success-path rotation (KPR-211) unaffected.
  const churnMint = !!result.error && !!ctx.sessionId && result.sessionId !== ctx.sessionId;
  if (churnMint) {
    log.warn("skipping session persist — errored turn returned a different id than resumed", {…});
  } else {
    this.sessionStore.set(ctx.agentId, ctx.threadId, resumable ? result.sessionId : "", route.provider, tokenData);
  }
}
```

- Pilot rows (`""` + tag) keep `findAgentByThread` and restart thread-continuity working — the ticket's rule is satisfied literally: the *row* persists, the non-resumable *id* never does.
- Adapters are untouched — they keep returning whatever they return; `RunResult` shape unchanged. Resumability is a static per-provider fact today; if codex ever implements chaining, the set gains a member in that change.
- `TurnResult.newSessionId` derivation (`result.sessionId || ctx.sessionId || ""`) unchanged — consumers see what ran, not what persisted.

### 3.3 Resume-eligibility guard (the read-side rule)

`TurnContext` gains two optional fields:

```ts
/** Provider tag of the stored session (set wherever sessionId is resolved). */
sessionProvider?: AgentProviderId;
/** Set by spawnTurn's guard: this turn starts fresh due to a provider change;
 *  prepareSpawn prepends the handoff annotation. Never set by callers. */
sessionHandoff?: boolean;
```

Insertion point — kpr-305 lambda, immediately after the reflection re-resolve block (`:592-599`) and **before** `if (!effectiveCtx.sessionId) this.recordSpawn(…)` so the new-session metric stays honest:

```ts
// KPR-313: session-identity guard. Resume only a same-provider handle; on any
// provider transition with prior thread state, hand off (fresh + memory + notice).
// Hot path is a pure compare — no I/O; R7 order (acquire → re-resolve →
// prepareSpawn → record) intact. On trip ONLY: one authoritative post-lock store
// re-read — non-reflection turns capture sessionId+tag PRE-lock (runWorkItemTurn),
// so under same-thread contention across a provider transition the captured tag is
// stale by a full turn; the re-read adopts the queue-predecessor's already-switched
// session instead of dropping its exchange (⚠A9).
// `route` is the acquire-time static route (kpr-305 :577); under the W3 clamp it is
// provably ≡ shaping.route.provider (311 §5). Clamp lift re-keys acquire AND this
// guard together (parked: kpr-311-spec §5 → W3.5/KPR-314).
if (effectiveCtx.sessionProvider && effectiveCtx.sessionProvider !== route.provider) {
  const fresh = await this.sessionStore.get(ctx.agentId, ctx.threadId); // post-lock ⇒ authoritative
  if (fresh?.provider === route.provider) {
    // A queued predecessor already performed the switch — adopt its state, no handoff.
    effectiveCtx = { ...effectiveCtx, sessionId: fresh.sessionId, sessionProvider: fresh.provider };
  } else {
    log.warn("session provider mismatch — fresh session with memory handoff", {
      agentId, threadId, stored: effectiveCtx.sessionProvider, turn: route.provider,
      hadSessionId: !!effectiveCtx.sessionId,
    });
    effectiveCtx = { ...effectiveCtx, sessionId: undefined, sessionHandoff: true };
  }
}
```

Notes:

- The trip condition keys on `sessionProvider` alone, not `sessionId`: a codex-tagged row with `sessionId: ""` read by a Claude turn (codex→claude round trip) has nothing to resume but **does** have invisible prior thread turns — the annotation must still fire.
- **Why re-resolve-on-trip, not accept-the-race:** without the re-read, two same-thread turns queued across a provider transition would *each* trip the guard — turn A runs fresh + handoff and persists the new-provider session; queued turn B still holds the stale old-provider tag, trips again, and starts fresh a second time, silently dropping turn A's exchange. The re-read costs one store read **only when the guard trips** (rare: provider edits + round trips), is post-lock and therefore authoritative (same rationale as the KPR-220 Phase 15 reflection re-resolve at the same spot), and fully closes the race. Reflection turns re-resolve just above anyway; their trip-path re-read is a redundant-but-idempotent second read, not worth a special case.
- The adopt branch clears neither field to `undefined` blindly — `fresh.sessionId` may itself be `undefined` (e.g. predecessor was a non-resumable pilot turn): the turn then runs fresh *without* a handoff annotation only if `fresh.provider === route.provider`, which is exactly the same-provider-stateless case (pilot statelessness, §5) where no *transition* annotation is owed.

### 3.4 The handoff — fresh context + memory, hive-owned

The ticket's "hive-owned fresh-context+memory handoff" decomposes into three parts, two of which already exist:

1. **Fresh context:** `sessionId: undefined` → the SDK spawns a new session (§3.3 strips it).
2. **Memory carryover — already automatic:** every fresh spawn assembles the full system prompt including agent memory (assembly order per CLAUDE.md: soul → systemPrompt → constitution → team → toolkit → **agent memory** → date/time). Structured-memory/semantic recall MCPs ride along per the agent's `coreServers`. Nothing to build; this spec's contribution is *stating* that this is the carryover mechanism.
3. **The annotation (new):** `prepareSpawn`'s non-voice branch, when `ctx.sessionHandoff`, prepends one line to the assembled prompt (before the sender prefix): a named constant, exact wording plan-level, content requirements binding — states that thread continuity was reset because the agent's engine changed; prior turns in this thread are not in context; memory is intact. The **recall suggestion** ("use `conversation_search` for prior context") is **conditioned on the target provider being `claude`**: pilot adapters run tool-free (`assertToolFreePilot`), so a claude→pilot handoff must not tell the agent to call a tool it cannot reach — the pilot variant of the constant simply omits that clause. This lands as a small edit inside 311's rewritten §2 derivation (sequenced files, §6). The voice carve-out branch stays annotation-free — voice re-sends the transcript itself on a provider transition (§3.5) and supplies its own prompt shape (KPR-219).

**Deliberately NOT built:** transcript reconstruction from the conversation index. The index is Qdrant+Ollama-backed, semantic-only (`conversation-index.ts:113` — no by-thread-recent scroll), and infrastructure-optional; wiring it into the turn path would add an availability dependency to every switch for a recap the agent can fetch itself via the `conversation-search` MCP it already carries (universal-9 baseline). The ticket says fresh-context **+ memory** — this spec takes that literally. ⚠A5.

### 3.5 Guard vs. the retry paths

- **Auth-rebuild retry:** the guard runs before any attempt, so the retry only ever sees same-provider Claude resume ids (pilots never carry a handle post-313). When it fires on a genuine auth-rebuild it still drops history by design — pre-existing, purposeful, out of scope (§7). De facto it becomes Claude-only without a code change.
- **Voice — eligibility must be applied at voice's own read, not left to the spawnTurn guard.** Voice chooses its *prompt shape* from resume-presence (`voice-adapter.ts:249-254`): stored id ⇒ latest-message-only prompt; no stored id ⇒ `renderConversationPrompt` (full transcript). If voice naively passed a mismatched-provider id through and let the spawnTurn guard strip it, the turn would **succeed fresh with only the last user message** — `runOnce` returns ok, the outer any-failure retry never fires, and mid-call context is silently lost. That would be a *regression*: pre-313 the doomed resume failed hard and the outer retry re-sent the full transcript. Rule: voice applies the provider-eligibility compare **at its `:247` read** — `effectiveResume` is set only when the stored ref's provider matches the agent's static route provider (`resolveProviderModel(agentConfig.model)`; exporting that helper — or relocating it to `provider-adapters/` — is a plan detail); on mismatch voice treats the thread as no-resume, so `renderConversationPrompt` fires and the full in-call transcript IS voice's handoff (`ctx.sessionId`/`ctx.sessionProvider` left unset — the spawnTurn guard then has nothing to do). The outer retry itself is unchanged: with mismatches filtered upstream it fires only for genuine same-provider resume failures — its actual job.

## 4. W3 reachability — what is live now vs. designed-for-later

Under 311's clamp (effective provider ≡ static provider; router never emits `provider`), a provider mismatch at the guard can only arise from:

1. **Pre-existing poisoned rows** — handled *before* the guard by `get()`'s scrub (§3.1 rule 3); the guard never even sees them. Live on upgrade day; self-extinguishing ≤7 days (TTL).
2. **Operator agent-def edits** (`agent.model` claude↔pilot, SIGUSR1) — the guard's live path today, fully testable end-to-end now. This *is* an engine switch at a turn boundary: adapter construction is per-spawn from a registry read inside the locked lambda (`createProviderAdapter`, HEAD `:396-434`), so an edit can never affect an in-flight turn — the "turn boundaries only" requirement is enforced by construction, not by new machinery. 313 adds the session-side correctness for that boundary.
3. **Round trips** (claude→codex→claude): first codex turn trips the guard (claude-tagged row), retags the row `codex`/`""`; the return claude turn trips it again (codex tag) → fresh + handoff. Deterministic, testable now.

**Dormant until the clamp lifts:** router-originated per-turn provider switches. The guard, tag, persist rule, and handoff are all keyed on `route.provider` and are provider-source-agnostic — when 311 §5's lift re-keys `acquire()`, the guard re-keys with it (same parked decision, W3.5/KPR-314 pickup) and the full switching flow becomes live with **zero new session-side design**. This spec builds no switching policy, scheduler, or per-turn provider selection — that would be dead code under the clamp (YAGNI) and 311 already parks the lift.

## 5. Edge cases

| Case | Behavior |
|---|---|
| Poisoned row already in store (fabricated prefix, untagged) | `get()` scrub: treated as absent, `log.warn`, lazy `deleteOne`; TTL backstop. Next turn fresh + **no** annotation (no provider signal survives — acceptable: the alternative is annotating on a guess) |
| Legacy untagged row, plain uuid | Grandfathered `provider: "claude"` — Claude turns resume normally (fleet-upgrade no-op); pilot turns trip the guard (correct: history isn't visible to a pilot) |
| Codex/gemini turn completes (success or error) | Row upserted `sessionId: ""` + tag; `findAgentByThread` intact; next same-provider turn resumes nothing (stateless pilots — pre-existing D3 condition, not changed here) |
| OpenAI pilot chain | `resp_…` ids tagged `openai`, resumed via `previousResponseId`; retention 30d > TTL 7d. Expired/404 chain → adapter error echoes the request id back → churn-mint rider doesn't fire (same id) → row persists; error repeats until TTL/operator delete. Pre-existing; a resume-failure sentinel per provider is deliberate future work (§7) |
| Error turn, resumed, different id returned (`error_during_execution` mint) | ⚠A4 rider: persist skipped, `log.warn`; row keeps the prior value. Stable-id invariant means the prior value is still the right handle if the session exists at all |
| Error turn, resumed, same id returned | Persist proceeds (TTL refresh; harmless per M7b/M8 — fault non-poisoning) |
| First turn errors (no resume attempted) | Rider doesn't fire (`ctx.sessionId` unset); behavior unchanged from today |
| Success-path compaction rotation (KPR-211) | No error → rider doesn't fire; rotated id persists as today |
| Auth-rebuild retry | Guard precedes it; fires only for same-provider Claude ids; retry result persists via the normal path (fresh real id — heals the row) |
| Voice, provider mismatch mid-call | Eligibility applied at voice's own `:247` read (§3.5): mismatch ⇒ no `effectiveResume` ⇒ `renderConversationPrompt` sends the **full transcript** — context preserved, no silent latest-message-only turn; carve-out skips the annotation; outer retry untouched and now mismatch-free |
| Same-thread lock contention across a provider transition | Non-reflection turns capture id+tag **pre-lock** (`runWorkItemTurn:504`) — under contention the read is a full turn stale (harmless same-provider via M7b id-stability, harmful across a transition: naive double-trip would drop the predecessor's exchange). Closed by §3.3's re-resolve-on-trip: queued turn B re-reads post-lock, sees the predecessor's same-provider row, adopts it — one store read, only on trip |
| Reflection turns | Re-resolve (`:550`) updates id+tag; guard applies uniformly. A post-provider-edit reflection runs fresh (near-empty output, bounded cost, rare) — no special-casing (YAGNI) |
| ws / sms / scheduler / team | All route through `runWorkItemTurn` → `spawnTurn` — single guarded path; sms `wrap`-threadId key format untouched |
| Concurrent threads, same agent | Row per `agentId:threadId`; per-thread lock serializes same-thread; guard is per-turn pure compare — no shared mutable state |
| Agent-def provider edit mid-thread, turn in flight | In-flight turn unaffected (adapter + config captured at spawn); next turn acquires on the new provider → guard trips → handoff. Turn-boundary semantics by construction |
| Fork ids | Hive never sets `forkSession` (zero references in `src/`) — out of scope; M7a invariant recorded for whoever adds forking later |
| Session TTL vs tag | Tag rides the row; TTL (7d inactivity) unchanged. No migration needed — legacy inference (§3.1) covers the window |
| `sessionStore.get` Mongo failure | `withRetry` fail-soft → `undefined` → fresh turn, guard no-op — same degraded mode as today |
| SIGUSR1 removes agent mid-lambda (311's race) | Guard reads `effectiveCtx` + the acquire-time `route`, and — only on trip — the §3.3 fail-soft store re-read (`withRetry`, never throws); it never dereferences the registry, so it adds no new throw surface inside the R7 window |

## 6. Serialization vs siblings (file-conflict discipline)

- **After 311 AND 312 (both child PRs merged into the epic branch; Gate 1 order W3.2 → W3.3 → W3.4):** `finalizeSpawnResult(…, route)` and the guard's clamp-identity argument consume `SpawnShaping.route` (311); the annotation edit lands inside 311's rewritten `prepareSpawn` **as amended by 312** (`SpawnShaping.effortOverride` merge line lives in the same derivation, 312 §3.4). 312 is *functionally* disjoint — 313 never touches effort, `model-router.ts`, or `error-classification.ts` — but it edits three of 313's shared files (`agent-manager.ts`, `provider-adapters/types.ts`, `claude-agent-adapter.ts`; 312 spec §5), so 313 anchors those surfaces to **312's post-delivery shape** and branches only after it merges. Re-confirm all line refs at then-HEAD (Gate 1 D2). W2 epic merge gates delivery (kpr-305 lambda shape), inherited from 311.
- Files exclusively 313's in this epic: `session-store.ts`, `voice-adapter.ts` (eligibility-at-read + call-site shape). Shared (sequenced, not conflicting): `agent-manager.ts` (TurnContext, lambda guard, `finalizeSpawnResult`, resolver call sites, prepareSpawn annotation line — beside 311's route merge and 312's `effortOverride` copy), `provider-adapters/types.ts` (one exported const — 311 adds `ReasoningEffort`, 312 adds `AgentProviderTurnRequest.effort` in the same file). `claude-agent-adapter.ts`: 312 touches it (8th forwarded arg); **313 does not** — listed to make the non-overlap explicit.

## 7. Non-goals

- **No clamp lift, no router-driven provider switching** — parked in kpr-311-spec §5 (pickup W3.5/KPR-314); the guard is designed to survive the lift, not to enable it.
- **No cross-provider context translation / transcript replay** — handoff = fresh + memory + annotation, period (§3.4).
- **No codex/gemini resume implementation** — flipping a provider into `RESUMABLE_SESSION_PROVIDERS` is that future ticket's one-line concern.
- **No classifier work** — neither the complexity classifier (312) nor the fault classifier: "No conversation found…" classifies `non-provider` under the frozen R3 taxonomy, which is correct for the breaker (config/state fault, not provider unhealth); a countable `bad-session` kind is deliberate future work if churn observability is ever wanted.
- **No auth-rebuild retry redesign** — it keeps its regex and its history-drop-on-genuine-auth-rebuild semantics.
- **No telemetry/doctor surface** — guard trips and scrubs are `log.warn`-visible; rare, self-extinguishing events don't earn a heartbeat field (YAGNI).
- **No `RunResult`/adapter interface changes** — resumability is a static provider fact in a const set, not a per-result flag.
- **No forkSession, no `resumeSessionAt`, no session snapshots** — M7b says there is no time-travel to offer.

## 8. Testing surface

**Existing pins that must stay green (mock-shape ripple):** `agent-manager.test.ts` mocks `sessionStore.get` widely (`:961-974`, `:1077`, `:1515-1531`, `:1815-1891` auth-rebuild + persist-per-turn pins) — every mock updates to the `StoredSessionRef` shape mechanically; the auth-rebuild retry test (`:1815`) must pass unchanged in behavior. `voice-adapter.test.ts` similarly. Post-W2/311 merge: breaker-order and route-derivation tests stay green.

**New tests:**

1. **`session-store` unit** (new test file beside source per repo convention): tag round-trip on `set`/`get`; `sessionId: ""` row → `{sessionId: undefined, provider}`; non-resumable-tagged row with a non-empty id → `sessionId: undefined` (belt-and-braces); legacy untagged uuid → `provider: "claude"`; each fabricated prefix (`codex-pilot-`, `gemini-pilot-`, `resp_`) → scrub + lazy delete observed; legacy-slack fallback path returns the same normalized shape.
2. **Guard (agent-manager):** stored tag ≠ turn provider (post-lock re-read still mismatched) → `runTurn` receives `sessionId: undefined` **and** the prompt contains the annotation constant **and** `recordSpawn` counted a new session; tag match → resume id passed through, no annotation, **no** trip-path store re-read (hot path stays zero-I/O — pin the `get` call count); codex-tagged `""` row + claude turn → no resume **and** annotation still fires (round-trip case); untagged-legacy uuid + claude static → resumes with **no** trip (fleet-upgrade regression pin); annotation variant: claude-target contains the `conversation_search` clause, pilot-target omits it (§3.4).
3. **Contention race (⚠A9 re-resolve-on-trip):** two same-thread turns queued across a provider transition — turn A trips, runs fresh + handoff, persists the new-provider row; queued turn B's stale tag trips the compare, the post-lock re-read returns A's same-provider row, and B **adopts** it (resumes A's session, no second handoff, A's exchange preserved). Negative-verify: with the re-read removed, the test must fail (B double-drops).
4. **Persist rule:** claude/openai success → id + tag persisted; codex/gemini success → `""` + tag persisted and `findAgentByThread` still resolves the agent; churn-mint rider — error + resumed + different id → **no** `set` call (negative-verify per repo discipline: revert the rider, confirm the test fails on pre-fix code); error + same id → `set` called; first-turn error with fresh id → `set` called (rider scoped to attempted resumes).
5. **Inverse-direction lens (both ways, explicitly):** claude→pilot transition and pilot→claude transition each get an end-to-end spawn test (guard + persist + next-turn read), not just one direction.
6. **Voice (B1 regression pins):** resolver returns tagged ref; **provider mismatch at the `:247` read ⇒ `effectiveResume` unset AND the prompt is the full `renderConversationPrompt` transcript, not latest-message-only** (negative-verify: with eligibility left to the spawnTurn guard, the test must fail on the latest-message-only prompt); provider match ⇒ latest-message prompt + resume as today; carve-out prompt contains no annotation.
7. **Reflection:** authoritative re-resolve updates `sessionProvider` **via the field-wise compare** (§3.1 — pin that a same-id/same-provider fresh read does NOT rebuild `effectiveCtx`, guarding against the ref-vs-string regression); mismatched reflection runs fresh without throwing.
8. **Scrub throw-safety:** `get()` with a `deleteOne` that rejects → no unhandled rejection, normalized ref still returned (pins the `.catch`-swallow, §3.1).
9. **Live repro (plan step, manual):** on a dev instance, insert a `codex-pilot-…` row for a claude agent's thread, drive one turn pre-fix — record the exact observed failure shape (pins §1's trace empirically, ⚠A8) — then confirm post-fix: scrub log, fresh turn, annotation visible, row healed with tag.

## ⚠ Delegated assumptions

1. ⚠ **Tag is a store field, not an id prefix** — additive schema; adapters untouched. *Non-blocking.*
2. ⚠ **`RESUMABLE_SESSION_PROVIDERS = {claude, openai}`** — openai counted resumable on the strength of `previousResponseId` chaining + `lastResponseId` return; revisit if the Agents SDK run ever sets `store: false`. *Non-blocking.*
3. ⚠ **Legacy untagged uuid rows grandfathered as `claude`; fabricated-prefix rows lazily scrubbed** — prevents fleet-wide history drop on upgrade; TTL bounds the inference window to ≤7 days. *Non-blocking.*
4. ⚠ **Churn-mint persist rider** (error + attempted resume + different id ⇒ skip write) — surgical; preserves max-turns/compaction continuity on success paths. *Non-blocking.*
5. ⚠ **Handoff = fresh + memory + one-line annotation; no transcript reconstruction** — reads the ticket's "fresh-context+memory handoff" literally; agents self-serve recall via `conversation-search`. *Non-blocking (the one product-shaped call in this spec; flagged for the operator).*
6. ⚠ **Guard keyed on the acquire-time static route under the W3 clamp** — provably ≡ effective provider per 311 §5; re-keys together with `acquire()` at the clamp lift (same parked decision). *Non-blocking.*
7. ⚠ **Reflection gets no special-casing on a tripped guard** — rare, bounded token waste accepted over a new code path. *Non-blocking.*
8. ⚠ **Ticket-framing reconciliation** — the traced text-channel failure shape is error-churn/wedge, not the auth-rebuild retry (regex miss verified against the CLI bundle's actual error strings); voice and genuine auth-rebuild are the silent-drop vectors. The live repro (§8.9) is the empirical pin; if production shows the retry firing on poisoned rows after all, the guard's design is unaffected (it preempts all vectors). *Non-blocking.*
9. ⚠ **Re-resolve-on-trip** — the guard performs one authoritative post-lock store re-read only when it trips, closing the queued-turn stale-tag race (§3.3/§5) instead of accepting a rare double-drop; hot path stays zero-I/O. *Non-blocking.*
10. ⚠ **Voice eligibility at the read** — voice filters mismatched-provider resumes at `voice-adapter.ts:247` so its full-transcript prompt shape fires (its native handoff); requires exposing the static-route helper to voice (export vs relocate = plan detail). *Non-blocking.*

No blocking product ambiguity: the poisoning fix, tag schema, and guard placement are fully determined by the code trace + KPR-310 invariants + 311/312's canon; the single judgment call (handoff scope, ⚠5) has a safe literal-reading default the operator can veto at spec review.
