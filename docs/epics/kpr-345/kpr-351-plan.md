# KPR-351 Implementation Plan — Production validation: Luna on keepur, epic build, codex flagship arc

> **For agentic workers:** Use dodi-dev:implement to execute this plan. **Only Stream A (Tasks 1–5) and Task 6 are implementable without a human gate.** Tasks 7–12 are live-runbook executions that run ONLY inside May's scheduled window (G0) — an agentic session must HARD-STOP at the end of Task 6 and wait for the operator.

**Spec:** [kpr-351-spec.md](./kpr-351-spec.md) (@ 3dfe172) — the contract; the runbook phases/gates (§D3), matrix legs (§D4), inverse transition (§D5), and evidence contract (§D6) are followed, not re-derived. Epic: [kpr-345-spec.md](./kpr-345-spec.md) child-6 row. Baseline: 346–350, 352–354, 356 all merged; all anchors below verified against this worktree (detached at 3dfe172; code tip c2f8e4e).

**Goal:** Land the four assigned refinements (R1 openai API-key single path, R2 chain-orphan re-read, R3 record-once test strengthening, key-conditioned R5) and execute the live validation runbook on keepur/Luna — epic-build deploy, staged claude→codex flagship arc, gating legs C0–C8, KPR-313 inverse transition, exact restore — with per-leg evidence in `kpr-351-spike-notes.md`.

**Architecture:** Two work streams with an explicit human-gate boundary. **Stream A (pre-window, in-repo):** the whole code diff is three files — `openai-agents-adapter.ts` loses `buildAuthAttempts`/`runWithAuthFallback`/the three oauth options and gains `buildClient()` + a missing-key throw (R1); `agent-manager.ts`'s stale-heal arm gains one post-lock `sessionStore.get` re-read with adopt-or-fresh retry (R2); tests strengthen/extend in the two suites + one additive classification pin. **Stream B (in-window, live):** the spec §D3 runbook executed verbatim — deploy.sh single-instance rsync-fallback deploy of the locally-bundled epic engine, admin-API-driven Luna mutations (every one with its inverse pre-recorded), matrix legs, inverse transition, rollback + exact restore. **Stream C (post-window):** spike-notes consolidation, KPR-355 row facts, conditional R5.

**Tech stack:** TypeScript strict, vitest beside source, existing test scaffolding only (manager suite's module-level adapter mocks + fake session store; adapter suite's mocked `@openai/agents`). Live stream: bash + curl + mongoexport/mongodump + launchctl on the keepur Mac. No new dependencies.

**Delivery-tier recommendation (for the reviewer):** `capable`. The R2 arm sits inside the breaker/churn-mint/KPR-313 state machine — the same composition-risk shape that earned KPR-350 `capable`. R1 is mechanical deletion but rewires the adapter's only network-auth path; the runbook tasks are procedure-heavy but code-free.

**Decision-register canon honored (per task):**
- *Subscription-first + 2026-07-23 validation-ground directives* — gating scope is codex/keepur/Luna on a locally-built epic engine; openai L-legs key-conditioned non-gating; Lane A excluded (KPR-346 canon); dodi untouched (Tasks 6–12 structure).
- *Stale strings stay `non-provider` forever; no FAULT_PATTERNS stale row* — `error-classification.ts` source untouched (Task 1 adds a test-only auth-alternate pin for the NEW missing-key message, which the existing `api.?key is not available` alternate already matches — no row edit).
- *Record-once breaker semantics* — R2 preserves the `else if` single-retry structure; record stays at `agent-manager.ts:1054`; R3 makes the pin non-vacuous (Tasks 2–3).
- *KPR-350 churn-mint + redaction ratifications* — the retry still passes the outer `effectiveCtx` to `finalizeSpawnResult` (rider intact); the R2 warn surfaces adoption as a **boolean only**, never a handle value (Task 2).
- *KPR-353 §D7 breadth + KPR-354 nested invariants* — bind C7/C6 expectations; no code edits to either subsystem (validation shape, spec §D7 table).
- *R4 status quo ante* — restore PATCHes field-scoped to `model`/`delegateServers` only (never a full-doc resubmit — the admin API's `maxConcurrent`→`spawnBudget` canonicalization would corrupt the diff-empty gate); May's two G3 decision points recorded, never defaulted into (Task 11).

---

## Plan-time resolutions (verified read-only, 2026-07-23)

These close the spec's ⚠ delegated assumptions that were resolvable at plan time:

1. **`ADMIN_API_TOKEN` is NOT configured on keepur** — absent from `~/services/hive/keepur/.env` (only `BROWSER_CDP_ENDPOINT` + 3 Slack vars) and from Keychain `hive/keepur/ADMIN_API_TOKEN`. The admin API therefore does not run today (`src/index.ts:740` gates `AdminApi` construction on a non-empty token). **Resolution: seed a throwaway token into Keychain at P0** — `config.ts:22` (`optional()`) resolves env → Keychain, and `config.ts:416` reads `ADMIN_API_TOKEN` through it, so the P1 deploy's service restart picks it up with zero `.env`/`hive.yaml` edits. Removed + service kicked at P5 (exact status quo ante: admin API down again). The spec's direct-Mongo fallback remains the documented plan-B (Task 7 records both).
2. **PATCH → reload wiring confirmed in code:** `admin-api.ts:200` — `updateAgent` calls `this.onReload()` (= `safeReload`, `index.ts:746`) after every PATCH. SIGUSR1 stays belt-and-braces after each mutation per spec §Edge.
3. **`brave-search` is DEAD on keepur — C6 delegate re-pinned to `google`.** `BRAVE_API_KEY` is absent (`.env` + Keychain), and `agent-runner.ts:620` only configures the brave-search server when `config.brave.apiKey` resolves — so `activeDelegateNames` (`agent-runner.ts:1199-1224`, `if (!allConfigs[serverName]) continue`) would **silently drop** a brave-search delegate and no Task tool would be synthesized (a false-RED trap, not an error). **C6 uses `google`**: plugin installed on keepur (`plugins/node_modules/@keepur/hive-plugin-google`), production-proven as a delegate on this very instance (Hermi's `delegateServers`), catalog entry present (`server-catalog.ts:25` — feeds the Task tool's delegate listing), external plugin transport, not in `DELEGATE_UNSAFE_SERVERS` (`server-traits.ts:16-19`), not autonomy-blocked (only resend/quo/code-task/code-search are). Fallback if google misbehaves in-window: `conversation-search` (always-configured stdio, `agent-runner.ts:814`; catalog `server-catalog.ts:119`; delegate-safe) — with the caveat that it is also in Luna's coreServers (name collision between the core entry and the delegate entry is unexercised; record whatever is observed). C1's example tool likewise avoids brave-search: use **contacts**.
4. **`OPENAI_API_KEY` absent on keepur** (env + Keychain) — P6 L0–L3 will not run unless May supplies a key inside the window; **R5/T4 is expected to be a no-op** (status-quo worst case pre-accepted by KPR-350). Plan carries it as a conditional task, not a default.
5. **`GEMINI_API_KEY` IS present in keepur Keychain** (the KPR-352 dev key) — optional N1/N2 legs are key-satisfied; still optional/non-gating and run only if the window has slack.
6. **C4 legacy-layout confidence upgraded to "expected GREEN by construction":** keepur's only customer skill (`skills/memory-hygiene/skills/memory-hygiene-review/` — legacy double-`skills/`) is already projected at `~/services/hive/keepur/.skill-projections/memory-hygiene-review-8317631941/skills/memory-hygiene-review → <legacy path>` (symlink, verified). `deriveProviderSkillIndex` (`src/agents/provider-adapters/skill-index.ts:21`) walks `<plugin.path>/skills/<name>/SKILL.md` over the projected plugin list and `realpathSync`s the symlink — the projection normalizes layout upstream of Lane B. The live leg still runs (it is the point of C4); a miss would now be a projection-rebuild bug, which is the finding to record.
7. **Deploy mechanics verified against the worktree's shipped script:** `service/deploy.sh:10` (`BUILD_DIR` env), `:28` (`HIVE_SINGLE_INSTANCE`), `:40` (`--rollback`), `:239-288` (npm-pack-first, rsync-from-`$BUILD_DIR` fallback, `pkg/server.min.js` sanity check). `check:bundle` exists (`package.json:60`).
8. **R1 blast radius confirmed minimal:** `preferOAuth`/`codexAuthPath`/`codexRefreshCommand` appear nowhere outside the openai adapter + its test (both `agent-manager.ts` construction sites — `:643`, `:756` — pass only `name`/`model`/`assembly`). `codex-subscription-adapter.ts` keeps its own `codexAuthPath`/`codexRefreshCommand` options (different consumer, untouched). `isProviderAuthError` loses its only consumer but lives in `oauth-credentials.ts`, which spec §D7 keeps out of the diff — left untouched, noted for the reviewer.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: R1 in `openai-agents-adapter.test.ts` — single-client construction from `options.apiKey`/env, no token-provider client (string-typed key pin), missing-key error shape + `auth` classification, existing posture/streaming/abort/bridge pins green under the new harness default; additive auth-alternate pin in `error-classification.test.ts` (source file untouched).
  - Reason: R1 rewires the adapter's only auth path; the missing-key message IS the honest-outage contract (auth row alternate) and a drifted string would silently classify `non-provider` and reset breaker streaks.
  - Minimum assertions: T1 flows below, each mapped to a step.

- Integration (manager-level, mocked adapters): **required**
  - Scope: R2 through the real `spawnTurn` path in `agent-manager.test.ts` — adopt/fresh/gating legs, single-retry, redaction; R3 record-once spy (one `record` per spawnTurn, classification = finalized attempt's).
  - Reason: the R2 arm's correctness is defined by its interplay with the per-thread lock, record-once, churn-mint, and the KPR-313 guard — only the manager suite exercises that composition.
  - Harness: **existing** — module-level `mockOpenAIRunTurn` (`agent-manager.test.ts:122-158`), fake session store `_sessions` map (`:312-337`), `smsCtx` (`:907`), the KPR-350 describe's `octx`/`openaiAgent` helpers (`:2925-2935`), public `manager.circuitBreakers` (`:2976` precedent). No new harness.
  - Minimum assertions: T2/T3 flows below.

- E2E: **required — the live runbook IS the e2e group.** Scope: spec §D3 phases P0–P5 with gating legs C0–C8 (§D4), the P4 inverse transition (§D5), and the P5 diff-empty restore gate. Reason: this is the ticket's charter — flipping codex from "mechanism-verified" to "live-validated" requires production evidence no CI harness can produce. Harness: **setup-required and human-gated** — the keepur instance + the locally-bundled epic engine, executable only inside May's G0 window; the harness setup is itself Tasks 6–7. Pass/fail semantics bind to the spec's gating matrix verbatim: **gating** = C0–C8 all GREEN + P4 evidence items 1–5 + P5 final-state diff empty; **non-gating** = L0–L3 (key-conditioned), N1–N2 (optional), C7's *which*-outcome (gating only that the thread survives). Evidence artifact = `kpr-351-spike-notes.md` per the §D6 contract. A RED gating leg triggers the spec §D2 abort ladder (rollback + restore + record), and the ticket returns to the spec lane or files the sized follow-up per §D4's own dispositions (e.g. C4 loader-side miss ⇒ follow-up + matrix caveat).

### Critical Flows

- **T1 — R1 single-path auth (unit, Task 1):** (a) missing key (no `options.apiKey`, no env) ⇒ `RunResult.error === "OpenAI API key is not available; set OPENAI_API_KEY (hive credentials add OPENAI_API_KEY)"`, no Runner constructed, turn resolves (not throws), bridge still closed; `classifyTurnResult({error})` ⇒ `{outcome:"fault", kind:"auth"}` and `classifyThrown(new Error(msg))` ⇒ `auth` (pin in error-classification.test.ts). (b) `options.apiKey` ⇒ exactly one Runner + one OpenAIProvider per turn, client `_options.apiKey === "sk-test"` and `typeof === "string"` (never a token-provider function — the deleted oauth attempt's signature). (c) env `OPENAI_API_KEY` resolves when `options.apiKey` absent. (d) every pre-existing pin (posture `modelSettings`, `previousResponseId`, no `conversationId`, streaming, abort, SDK-error mapping, all KPR-348/354 bridge groups) green under the collapsed mock + `apiKey: "sk-test"` harness default. Negative-verify: with the adapter source stashed (pre-R1 code) and the new tests in place, the missing-key test FAILS (old code silently ran the SDK-default client path).
- **T2 — R2 adopt-or-fresh (manager, Task 2):** contender-seeded store row (`resp-contender`, provider openai) + first attempt stale ⇒ exactly 2 adapter calls, retry `sessionId === "resp-contender"` (adopt, not fresh), success persists normally, warn meta `adoptedContenderHandle: true` and no handle value in any warn meta; row holding the SAME stale handle ⇒ fresh retry (`adoptedContenderHandle: false`); row absent or empty-handle ⇒ fresh retry; row tagged another provider ⇒ fresh retry; adopted retry that errors stale again ⇒ NO third attempt, error surfaces. Existing KPR-350 legs (heal-success persist, churn-mint block, gating quartet) and the auth-rebuild arm tests pass **unmodified**. Negative-verify: with the `agent-manager.ts` edit stashed, the adopt test fails (retry sessionId undefined).
- **T3 — R3 non-vacuous record-once (manager, Task 3):** `vi.spyOn(manager.circuitBreakers, "record")` — stale→success turn records exactly once with `{outcome:"success"}`; stale→failure turn records exactly once more with `{outcome:"fault", kind:"non-provider", message:"boom"}`; streak stays 0 (existing assertions kept). Negative-verify (vacuity proof): a scratch mutant that records the first attempt inside the stale arm keeps the OLD streak-0 assertions green but fails the new `toHaveBeenCalledTimes(1)` — evidence captured, mutant reverted.
- **T4 — R5 matcher refinement (conditional, Task 13):** only if L2 ran and the live payload missed `isStaleServerHandleError` (`agent-manager.ts:299`) — pin the captured string as must-match, keep the must-NOT-match table green, classification stays `non-provider`. No key ⇒ explicit no-op recorded in spike notes.
- **Live flows:** the C0–C8 / P2 / P4 / P5 legs as specified in Tasks 7–11 (each step binds to its spec §D4/§D5 GREEN criteria).

### Regression Surface

- `agent-manager.test.ts`: every existing describe passes unmodified — auth-rebuild pair (`:1933`, `:1954` area), KPR-313 group (`:2363+`, incl. adopt-branch pins `:2893`), KPR-353 handoff-clear group (`:2860+`), KPR-350 group's four existing legs (`:2937-3002` — the record-once leg is *replaced* by its strengthened form, the other three are byte-untouched), gemini KPR-352 group (`:3005+`), Lane A, KPR-354 nested-delegate groups.
- `openai-agents-adapter.test.ts`: the auth-fallback test is deleted (its subject no longer exists); every other test passes with only the harness default change (`preferOAuth: false` → `apiKey: "sk-test"`) and the mock collapse (Runner.run ≡ module `run` mock) — assertion bodies untouched.
- `error-classification.ts` + `oauth-credentials.ts` + codex/gemini adapters + `tool-bridge.ts` + `turn-assembly.ts` + `session-store.ts` + `turn-history-store.ts` + `types.ts`: **zero source edits** (Task 5 boundary diff enforces).
- Live: the three non-Luna keepur agents (Hermi/Alexandria/Samantha) on the epic engine for the window — guarded by C0 + abort ladder A3.

### Commands

- Unit + Integration (targeted): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/agent-manager.test.ts src/agents/provider-adapters/error-classification.test.ts`
- Broader regression (required before any commit claim): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- E2E: Tasks 7–12 (manual, in-window, evidence into spike notes). Artifact gate: `npm run check:bundle` (Task 6).

### Harness Requirements

- In-repo: none beyond the existing suites (no network, no Mongo, no live keys).
- Live: May's scheduled window (G0); keepur Mac shell access; `mongodump`/`mongoexport` (verified present; **no mongosh** — any direct-Mongo fallback uses a node one-liner via the engine's bundled driver); Keychain write access for the P0 token seed; `~/.codex/auth.json` present for the launchd user; Slack access to #agent-luna / #agent-hermi.

### Non-Required Rationale

- None — all three groups required (E2E satisfied by the runbook as defined above).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker. (The one *legitimate* wait state is G0 — a human gate, not a harness gap.)
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Live legs: every "X happened" claim needs its before-state snapshot proving X was absent (spec §Testing sketch — the staged-transition discipline). No leg is GREEN without its §D6 evidence block written down.

---

## File Structure

| File | Action | Task |
|---|---|---|
| `src/agents/provider-adapters/openai-agents-adapter.ts` | modify — R1: delete oauth attempt + 3 options; `buildClient()` + missing-key throw; `runWithAuthFallback` → `runWithClient` | 1 |
| `src/agents/provider-adapters/openai-agents-adapter.test.ts` | modify — mock collapse, harness default, delete fallback test, add T1 legs, drop dead `makeJwt` | 1 |
| `src/agents/provider-adapters/error-classification.test.ts` | modify — additive auth-alternate pin (source untouched) | 1 |
| `src/agents/agent-manager.ts` | modify — R2: stale-heal arm post-lock re-read, adopt-or-fresh (`:1032-1047` block only) | 2 |
| `src/agents/agent-manager.test.ts` | modify — T2 describe added; T3 record-once leg strengthened in place | 2, 3 |
| `CLAUDE.md` | modify — openai auth rider (Task 4); codex live-validated clause (Task 13, post-evidence only) | 4, 13 |
| `docs/epics/kpr-345/kpr-351-spike-notes.md` | create — §D6 scaffold pre-window; filled in-window | 4, 7–12 |
| `src/agents/agent-manager.ts:299` (`isStaleServerHandleError`) | conditional modify — R5 only against a live L2 capture | 13 |
| Everything else (`oauth-credentials.ts`, `codex-subscription-adapter.ts`, `gemini-interactions-adapter.ts`, `tool-bridge.ts`, `turn-assembly.ts`, `session-store.ts`, `turn-history-store.ts`, `error-classification.ts`, `types.ts` values) | **untouched** | 5 enforces |

---

# Stream A — pre-window code changes (CI-verifiable now)

## Task 1: R1 — openai adapter API-key single path

**Files:**
- Modify: `src/agents/provider-adapters/openai-agents-adapter.ts`
- Modify: `src/agents/provider-adapters/openai-agents-adapter.test.ts`
- Modify: `src/agents/provider-adapters/error-classification.test.ts`

- [ ] **Step 1:** Adapter — imports and options. Replace line 7 and the options interface (`:9-17`):

```typescript
import { envValue } from "./oauth-credentials.js";
```

```typescript
export interface OpenAIAgentsAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  apiKey?: string;
}
```

Also drop `run` from the `@openai/agents` import (line 1 — the bare-run path is deleted):

```typescript
import { Agent, OpenAIProvider, Runner, tool } from "@openai/agents";
```

Delete the `OpenAIAuthAttempt` interface (`:29-32`).

- [ ] **Step 2:** Adapter — fail the missing-key case before spinning up MCP servers. At the top of `runTurn`'s `try` (immediately before `const bridged = await bridge.connect();`, `:66-69`), insert:

```typescript
      // KPR-351 (R1): API-key single path — resolve the client BEFORE
      // connecting tool servers, so persistent misconfig fails in
      // microseconds. The throw is caught by this method's own catch and
      // lands in RunResult.error, where the auth row's existing
      // `api.?key is not available` alternate classifies it `auth` →
      // breaker → honest outage (gemini-identical posture, KPR-352 §D7).
      // The finally below still runs bridge.close() on this path.
      const client = this.buildClient();
```

- [ ] **Step 3:** Adapter — replace `runWithAuthFallback` + `buildAuthAttempts` (`:161-224`) wholesale with:

```typescript
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options: { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIStreamResultLike>;
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options: { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike>;
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options:
      | { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string }
      | { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike | OpenAIStreamResultLike> {
    const runner = new Runner({
      modelProvider: new OpenAIProvider({ openAIClient: client as never }),
    });
    return (await runner.run(agent, prompt, options as never)) as OpenAIResultLike | OpenAIStreamResultLike;
  }

  /**
   * KPR-351 (R1): API-key single path. The codex-oauth attempt is DELETED —
   * the KPR-348 spike proved the codex subscription token authenticates the
   * chatgpt.com backend only and 401s against api.openai.com Responses, so
   * the attempt could only burn one doomed network round-trip per turn and
   * kept a dead org-affinity hazard alive (KPR-350 §Edge). Mirrors the
   * KPR-352 §D7 Vertex deletion: surface-driven single-path auth.
   * `createCodexOpenAITokenProvider` survives in oauth-credentials.ts — the
   * codex adapter is its consumer. Revisit trigger: OpenAI ever serving
   * Responses under subscription auth is a NEW ticket, not a re-add here.
   */
  private buildClient(): OpenAI {
    const apiKey = this.options.apiKey ?? envValue("OPENAI_API_KEY");
    if (!apiKey) {
      // Message shaped to the auth row's existing `api.?key is not
      // available` alternate (error-classification.ts FAULT_PATTERNS) —
      // `hive credentials add OPENAI_API_KEY` recovers on the next spawn.
      throw new Error(
        "OpenAI API key is not available; set OPENAI_API_KEY (hive credentials add OPENAI_API_KEY)",
      );
    }
    return new OpenAI({ apiKey });
  }
```

Update both call sites (`:93`, `:109`): `this.runWithAuthFallback(agent, request.prompt, {...})` → `this.runWithClient(client, agent, request.prompt, {...})`.

- [ ] **Step 4:** Test harness — collapse the two run mocks so Runner-driven runs hit the same `vi.fn()` all existing tests already assert on. In the `vi.mock("@openai/agents", ...)` factory, change the module `run` export (line 58) to reuse the hoisted mock:

```typescript
    run: runnerRunMock,
```

(`runMock = vi.mocked(run)` then IS `runnerRunMock`; `Runner` already returns `{ options, run: runnerRunMock }` — every `runMock.mockResolvedValueOnce`/`toHaveBeenCalledWith(agent, prompt, options)` assertion works unchanged because `runner.run` has the same `(agent, prompt, options)` shape.)

In `makeAdapter` (`:72-80`) replace `preferOAuth: false,` with `apiKey: "sk-test",`.

- [ ] **Step 5:** Delete the auth-fallback test (`"prefers Codex OAuth and falls back to API-key auth on OpenAI auth failures"`, `:363-391`) and the now-dead `makeJwt` helper (`:808-815` area). Run `npx eslint src/agents/provider-adapters/openai-agents-adapter.test.ts` and remove any imports it reports newly unused (candidates: `writeFileSync`, `mkdtempSync` — only if no other test uses them; `rmSync`/`join`/`tmpdir` are used elsewhere in the file).

- [ ] **Step 6:** Add the T1 tests in the main `describe("OpenAIAgentsAdapter")` block, where the deleted test was:

```typescript
  it("KPR-351 R1: missing key ⇒ pre-request fail — auth-shaped RunResult.error, no Runner, turn resolves", async () => {
    // beforeEach deleted OPENAI_API_KEY; explicit undefined overrides the harness default.
    const result = await makeAdapter({ apiKey: undefined }).runTurn({ prompt: "hello" });
    expect(result.error).toBe(
      "OpenAI API key is not available; set OPENAI_API_KEY (hive credentials add OPENAI_API_KEY)",
    );
    expect(result.aborted).toBe(false);
    expect(RunnerMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    // The honest-outage contract: the message classifies auth (breaker food),
    // via the RunResult path this adapter actually takes AND the throw path.
    expect(classifyTurnResult({ error: result.error })).toEqual({
      outcome: "fault",
      kind: "auth",
      message: result.error,
    });
  });

  it("KPR-351 R1: single API-key path — exactly one Runner/client per turn, string key, from options.apiKey", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);
    await makeAdapter().runTurn({ prompt: "hello" });
    expect(RunnerMock).toHaveBeenCalledTimes(1);
    expect(OpenAIProviderMock).toHaveBeenCalledTimes(1);
    const client = (OpenAIProviderMock.mock.calls[0]![0] as any).openAIClient;
    // A token-provider client (the deleted codex-oauth attempt) carried a
    // FUNCTION apiKey — string-typed is the single-path pin.
    expect(client._options.apiKey).toBe("sk-test");
    expect(typeof client._options.apiKey).toBe("string");
  });

  it("KPR-351 R1: OPENAI_API_KEY env resolves when options.apiKey is absent", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    runMock.mockResolvedValueOnce(makeSdkResult() as never);
    await makeAdapter({ apiKey: undefined }).runTurn({ prompt: "hello" });
    const client = (OpenAIProviderMock.mock.calls[0]![0] as any).openAIClient;
    expect(client._options.apiKey).toBe("sk-env");
  });
```

(`classifyTurnResult` is already imported at `:16`; `_options.apiKey` access follows the deleted test's own precedent at old `:387`.)

- [ ] **Step 7:** `error-classification.test.ts` — extend the auth-alternates `it.each` list (beside the gemini alternate at `:70`):

```typescript
    // KPR-351 R1: the OpenAIAgentsAdapter missing-key throw — pinned per the
    // auth row's standing rule (alternates land with their sentinel). No row
    // edit needed: the existing `api.?key is not available` alternate matches.
    "OpenAI API key is not available; set OPENAI_API_KEY (hive credentials add OPENAI_API_KEY)",
```

- [ ] **Step 8:** Verify.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/error-classification.test.ts`
Expected: all pass; zero skipped.

Run: `grep -n "createCodexOpenAITokenProvider\|preferOAuth\|codexAuthPath\|codexRefreshCommand\|isProviderAuthError" src/agents/provider-adapters/openai-agents-adapter.ts`
Expected: no output.

- [ ] **Step 9:** Negative-verify (repo convention). `git stash push -- src/agents/provider-adapters/openai-agents-adapter.ts` → run the missing-key test → expect **FAIL** (pre-R1 code silently ran the no-attempt/bare-run path and produced no auth error) → `git stash pop` → re-run → pass. Record the failing assertion line in the commit body.

- [ ] **Step 10:** Commit.

```bash
git add src/agents/provider-adapters/openai-agents-adapter.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/error-classification.test.ts
git commit -m "KPR-351: R1 — openai adapter API-key single path (codex-oauth attempt deleted, missing-key auth throw)"
```

## Task 2: R2 — chain-orphan closure in the stale-heal arm

**Files:**
- Modify: `src/agents/agent-manager.ts:1032-1047` (the stale-heal arm body only)
- Modify: `src/agents/agent-manager.test.ts` (new nested describe inside `"stale-handle self-heal (KPR-350 §D3)"`, after `:3002`)

- [ ] **Step 1:** Replace the arm body (currently the warn + fresh `runOneSpawnAttempt` at `:1033-1047`) with:

```typescript
        ) {
          // KPR-351 (R2): chain-orphan closure. Two same-thread turns can
          // both resolve the same stale handle PRE-lock; the first heals and
          // persists a fresh chain head; the queued second then trips this
          // arm and — without a re-read — would retry fresh, orphaning the
          // healed chain (one exchange lost, healed handle overwritten). One
          // post-lock sessionStore re-read (authoritative under the per-
          // thread lock — the KPR-313 adopt-branch's own idiom above) adopts
          // a contender's same-provider, non-empty, DIFFERENT handle; every
          // other shape falls through to the fresh retry exactly as KPR-350
          // shipped it. Single-retry semantics (`else if`), record-once,
          // churn-mint, and the auth-rebuild arm are untouched; the store
          // read is withRetry fail-soft — no new throw surface inside the
          // recorded try.
          const contender = await this.sessionStore.get(effectiveCtx.agentId, effectiveCtx.threadId);
          const adoptedSessionId =
            contender?.provider === shaping.route.provider &&
            contender.sessionId &&
            contender.sessionId !== effectiveCtx.sessionId
              ? contender.sessionId
              : undefined;
          // Deliberately NOT logging the error string or any handle value:
          // the provider's stale-handle message embeds the resp_ handle
          // (log-redaction posture — KPR-350 §D3 "no handle value"); R2
          // adoption is surfaced as a boolean only.
          log.warn("spawnTurn stale-server-handle — self-heal retry (KPR-350, adopt-or-fresh KPR-351)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            provider: shaping.route.provider,
            adoptedContenderHandle: adoptedSessionId !== undefined,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: adoptedSessionId },
            shaping,
            ticket,
            onStream,
          );
        }
```

(The warn message keeps the `"stale-server-handle"` substring both existing redaction pins match on — `agent-manager.test.ts:2951`, `:3043`. `finalizeSpawnResult` still receives the outer `effectiveCtx`, so the churn-mint rider interplay is byte-identical to KPR-350's.)

- [ ] **Step 2:** Add the T2 describe inside the KPR-350 stale-heal describe (after the `"gating: …"` test, `:3002`):

```typescript
      describe("chain-orphan re-read (KPR-351 R2)", () => {
        function seedRow(threadId: string, sessionId: string, provider = "openai") {
          sessionStore._sessions.set(`openai-pilot:${threadId}`, { sessionId, provider });
        }

        it("contender-healed row is adopted: retry carries the contender's handle, success persists normally", async () => {
          const ctx = octx("sms:line-1:kpr351-adopt");
          seedRow(ctx.threadId, "resp-contender");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "adopted", sessionId: "resp-contender-2" }));
          const result = await manager.spawnTurn(ctx);
          expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBe("resp-contender"); // adopt, NOT fresh
          expect(result.finalMessage).toBe("adopted");
          expect(sessionStore.set).toHaveBeenCalledWith(
            "openai-pilot", ctx.threadId, "resp-contender-2", "openai", expect.anything(),
          );
          // Redaction: adoption is a boolean; no handle value in any warn meta.
          expect(mockLogWarn).toHaveBeenCalledWith(
            expect.stringContaining("stale-server-handle"),
            expect.objectContaining({ adoptedContenderHandle: true }),
          );
          const leaked = mockLogWarn.mock.calls.some(([, meta]) =>
            JSON.stringify(meta ?? "").includes("resp-contender"),
          );
          expect(leaked).toBe(false);
        });

        it("row holds the SAME stale handle (no contender heal) ⇒ fresh retry, as KPR-350 shipped", async () => {
          const ctx = octx("sms:line-1:kpr351-same");
          seedRow(ctx.threadId, "resp_stale");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-fresh" }));
          await manager.spawnTurn(ctx);
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBeUndefined();
          expect(mockLogWarn).toHaveBeenCalledWith(
            expect.stringContaining("stale-server-handle"),
            expect.objectContaining({ adoptedContenderHandle: false }),
          );
        });

        it("row absent, empty-handle row, or foreign-provider row ⇒ fresh retry (no cross-provider adoption)", async () => {
          // absent
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-a" }));
          await manager.spawnTurn(octx("sms:line-1:kpr351-absent"));
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBeUndefined();
          // empty handle ("" normalizes to undefined in the store's get())
          const ctx2 = octx("sms:line-1:kpr351-empty");
          seedRow(ctx2.threadId, "");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-b" }));
          await manager.spawnTurn(ctx2);
          expect(mockOpenAIRunTurn.mock.calls[3]![0].sessionId).toBeUndefined();
          // foreign provider tag
          const ctx3 = octx("sms:line-1:kpr351-xprov");
          seedRow(ctx3.threadId, "claude-uuid-9", "claude");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-c" }));
          await manager.spawnTurn(ctx3);
          expect(mockOpenAIRunTurn.mock.calls[5]![0].sessionId).toBeUndefined();
        });

        it("adopted retry that errors stale AGAIN ⇒ no second retry (single-retry semantics intact)", async () => {
          const ctx = octx("sms:line-1:kpr351-twice");
          seedRow(ctx.threadId, "resp-contender");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp-contender" }));
          const result = await manager.spawnTurn(ctx);
          expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
          expect(result.errors).toEqual([STALE]);
        });
      });
```

- [ ] **Step 3:** Verify.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
Expected: all pass — including the four pre-existing KPR-350 legs, the gemini group, and the auth-rebuild tests, all byte-unmodified.

- [ ] **Step 4:** Negative-verify. `git stash push -- src/agents/agent-manager.ts` → run the adopt test → expect **FAIL** on `calls[1]![0].sessionId` (undefined ≠ "resp-contender") → `git stash pop` → pass. Record in commit body.

- [ ] **Step 5:** Commit.

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-351: R2 — stale-heal arm adopts a contender-healed handle (post-lock store re-read, chain-orphan closed)"
```

## Task 3: R3 — non-vacuous breaker record-once leg

**Files:**
- Modify: `src/agents/agent-manager.test.ts:2967-2979` (replace the leg in place)

- [ ] **Step 1:** Replace the `"breaker record-once: …"` test body with:

```typescript
      it("breaker record-once: exactly one record per spawnTurn, classification = finalized attempt's; streak 0 both ways", async () => {
        // KPR-351 (R3): the streak-0 assertions alone were vacuous — stale
        // AND "boom" both classify non-provider, so streak 0 held even if
        // the first attempt were recorded. The spy makes the pin bite.
        const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "resp-f2" }));
        await manager.spawnTurn(octx("sms:line-1:kpr350-brk-1"));
        expect(recordSpy).toHaveBeenCalledTimes(1); // first attempt's stale fault never recorded
        expect(recordSpy.mock.calls[0]![1]).toEqual({ outcome: "success" });

        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "resp_stale" }));
        await manager.spawnTurn(octx("sms:line-1:kpr350-brk-2"));
        expect(recordSpy).toHaveBeenCalledTimes(2);
        expect(recordSpy.mock.calls[1]![1]).toEqual({ outcome: "fault", kind: "non-provider", message: "boom" });

        const snap = manager.circuitBreakers.stateFor("openai")!; // non-null-assertion per stateFor("claude")! precedent
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0);
      });
```

- [ ] **Step 2:** Negative-verify — vacuity proof. Scratch-insert a first-attempt record at the top of the stale-heal arm in `agent-manager.ts` (immediately after the `) {` of the arm):

```typescript
          this.circuitBreakers.record(permit, classifyTurnResult(finalResult), 0); // SCRATCH MUTANT — do not commit
```

Run the test: expect the OLD assertions (streak 0, state closed) to stay GREEN under the mutant while the new `toHaveBeenCalledTimes(1)` **FAILS** (2 calls) — that is the vacuity evidence. Delete the mutant line, re-run, all green. Record both runs' output in the commit body.

- [ ] **Step 3:** Verify + commit.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
Expected: all pass.

```bash
git add src/agents/agent-manager.test.ts
git commit -m "KPR-351: R3 — record-once breaker leg strengthened with a record spy (vacuity closed, mutant-verified)"
```

## Task 4: CLAUDE.md auth rider + spike-notes scaffold

**Files:**
- Modify: `CLAUDE.md` (provider-adapters paragraph, line 248 area)
- Create: `docs/epics/kpr-345/kpr-351-spike-notes.md`

- [ ] **Step 1:** In the pilot-adapters paragraph, replace the final sentence `Models default from ... credentials resolve via `oauth-credentials.ts` (e.g. Codex subscription auth).` with:

```markdown
Models default from `config.{codex,openai,gemini}.agentModel`. Auth: codex = subscription OAuth (`oauth-credentials.ts`, `~/.codex/auth.json`); openai = **API-key single path** (`OPENAI_API_KEY` — the codex-oauth fallback attempt was deleted in KPR-351: the subscription token authenticates the chatgpt.com backend only and 401s against api.openai.com Responses; a missing key fast-fails as an `auth`-classified error into the honest-outage path); gemini = API-key single path (KPR-352, Vertex deleted).
```

(Do **NOT** add the "codex live-validated" clause yet — that claim becomes true only after the runbook's gating legs are GREEN; it lands in Task 13.)

- [ ] **Step 2:** Create `docs/epics/kpr-345/kpr-351-spike-notes.md` as the §D6 scaffold. Structure (fill the plan-time facts now, leave `TBD (in-window)` markers elsewhere):

```markdown
# KPR-351 spike notes — production validation on keepur (Luna, codex surface, epic build)

Evidence contract: spec §D6. Per leg: intent → action → observed → verdict GREEN/AMBER/RED → deltas (tagged with the spec section they refine).

## Global
- Pinned SHA + `check:bundle` gate output: TBD (Task 6)
- Rebase-onto-main taken? (spec ⚠, driver's call): TBD
- P0 state snapshot (paths + timestamps): TBD
- G0 sign-off (May, window): TBD · G1: TBD · G2a/b/c: TBD · G3 (May, two decision points): TBD
- R4 decision record — keep-epic-build? park-Luna-on-sonnet?: TBD (explicit May calls, defaults are rollback + restore)

## Plan-time facts (2026-07-23, read-only)
- ADMIN_API_TOKEN absent on keepur → P0 seeds a throwaway token into Keychain `hive/keepur/ADMIN_API_TOKEN` (removed at P5; admin API down again = status quo ante). Fallback if admin API misbehaves: direct Mongo update + SIGUSR1 (node one-liner — no mongosh on this Mac).
- BRAVE_API_KEY absent → brave-search inert on keepur; C6 delegate = `google` (Hermi-proven on this instance); fallback `conversation-search` (also a Luna coreServer — record any name-collision behavior).
- OPENAI_API_KEY absent → L0–L3 expected skipped; R5/T4 no-op unless May supplies a key in-window.
- GEMINI_API_KEY present (KPR-352 dev key) → N1/N2 key-satisfied, still optional.
- C4 projection check: legacy skill already projected flat (`.skill-projections/memory-hygiene-review-*/skills/memory-hygiene-review` symlink) — Lane B index expected to see it by construction.

## Mutation ledger (every def/config mutation, inverse recorded BEFORE applying)
| # | When | Mutation | Inverse | Applied | Reverted |
|---|---|---|---|---|---|
| M1 | P0 | Keychain add hive/keepur/ADMIN_API_TOKEN | security delete-generic-password -s hive/keepur/ADMIN_API_TOKEN + kickstart | TBD | TBD |
| M2 | P1 | engine .hive → epic build (deploy.sh) | `hive rollback` (.hive.prev = 0.10.1) | TBD | TBD |
| M3 | P2 | Luna model → claude-sonnet-4-6 | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M4 | P2 | Luna model → codex/gpt-5.5:medium | (flagship state — reverted by M8/M9 chain) | TBD | TBD |
| M5 | C6 | Luna delegateServers → ["google"] | PATCH delegateServers [] | TBD | TBD |
| M6 | C7 | Luna model → codex/gpt-5.4-mini:medium | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M7 | P4 | Luna model → claude-sonnet-4-6 | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M8 | P5 | engine rollback → 0.10.1 | (May G3 call could skip) | TBD | — |
| M9 | P5 | Luna → observed P0 def (model + delegateServers, field-scoped) | — (this IS the restore) | TBD | — |

## Legs
### C0 — Hermi Claude-lane smoke (G1 gate) …
### P2 — staged claude baseline + claude→codex handoff (G2a) …
### C1 — tool turn … ### C2 — stateless-replay continuity … ### C3 — memory …
### C4 — skills + legacy layout … ### C5 — guardrail posture (structural) …
### C6 — delegate Task turn (KPR-354 enum confirmation) … ### C7 — poisoned-replay (deliberate) …
### C8 — telemetry honesty … ### P4 — inverse transition (KPR-313 proof, G2c) …
### P5 — restore + diff-empty gate (G3) …
### L0–L3 (key-conditioned) — NOT RUN unless OPENAI_API_KEY appears: …
### N1–N2 (optional gemini) …

## KPR-355 row-fact deltas
- codex rows → live-validated (cite leg evidence): TBD
- openai rows: unchanged unless P6 ran: TBD
- Lane A (kimi/deepseek): explicitly restated live-unvalidated (KPR-346 canon).
```

- [ ] **Step 3:** Commit.

```bash
git add CLAUDE.md docs/epics/kpr-345/kpr-351-spike-notes.md
git commit -m "KPR-351: CLAUDE.md openai auth rider + spike-notes scaffold (plan-time facts pre-filled)"
```

## Task 5: Stream-A gate + boundary diff

- [ ] **Step 1:** Full gate.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: typecheck + lint + format + test all green.

- [ ] **Step 2:** Boundary diff — the whole Stream-A code diff touches exactly these files:

Run: `git diff --name-only <base>..HEAD -- src/ CLAUDE.md docs/`
Expected exactly:
```
CLAUDE.md
docs/epics/kpr-345/kpr-351-plan.md
docs/epics/kpr-345/kpr-351-spike-notes.md
src/agents/agent-manager.ts
src/agents/agent-manager.test.ts
src/agents/provider-adapters/error-classification.test.ts
src/agents/provider-adapters/openai-agents-adapter.test.ts
src/agents/provider-adapters/openai-agents-adapter.ts
```
Any other `src/` file in the list = a plan violation; in particular `oauth-credentials.ts`, `error-classification.ts`, and both codex/gemini adapters must be absent.

---

# Stream B — pre-window build + pre-flight (no instance mutation except the M1 token seed)

## Task 6: Artifact build, P0 prep, G0 HARD STOP

**Precondition note:** the build runs from THIS worktree at the delivery branch tip (Stream A included). If the driver takes the recommended rebase-onto-main first (spec ⚠, picks up #324/#325), re-pin the SHA and rebuild — record either way in spike notes.

- [ ] **Step 1:** Build + artifact gate (hard stop if red):

```bash
cd <worktree> && npm ci && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check:bundle
git rev-parse HEAD   # record as PINNED_SHA in spike notes §Global
```
Expected: bundle + all four gates (strings, pack, runtime, qdrant-stub) green; `pkg/server.min.js` present.

- [ ] **Step 2:** P0 state snapshot (read-only; run on the keepur Mac):

```bash
EVID=$HOME/kpr351-evidence/p0 && mkdir -p "$EVID"
mongodump --db hive_keepur --out "$EVID/mongodump"
mongoexport --db hive_keepur -c agent_definitions -q '{"_id":"luna"}' -o "$EVID/luna-def.json"
mongoexport --db hive_keepur -c sessions -o "$EVID/sessions-all.json"          # small collection; grep luna rows
mongoexport --db hive_keepur -c provider_turn_history -o "$EVID/history-all.json"
```
Expected: `luna-def.json` shows `model: "codex/gpt-5.5:medium"`, `delegateServers: []`, `maxConcurrent: 3`, no `spawnBudget`. Record row counts + Luna's session-row field names (the exact schema drives later queries) in spike notes. **`luna-def.json` is the R4 restore reference.**

- [ ] **Step 3:** Seed the admin token (M1 — record inverse in the ledger first):

```bash
ADMIN_TOKEN=$(openssl rand -hex 24)
security add-generic-password -a "$USER" -s "hive/keepur/ADMIN_API_TOKEN" -w "$ADMIN_TOKEN" -U
```
(Token lives in the operator session only — never in spike notes. It activates at the P1 deploy restart; nothing changes until then.)

- [ ] **Step 4:** Remaining pre-flight checks:

```bash
ls -l ~/.codex/auth.json                                    # codex OAuth present
crontab -l 2>/dev/null | grep -i hive; ls ~/Library/LaunchAgents | grep -iv com.hive  # re-verify: no deploy automation
launchctl print gui/$(id -u)/com.hive.keepur.agent | grep -E "state|pid"              # service running (0.10.1)
grep '"version"' ~/services/hive/keepur/.hive/package.json  # expect 0.10.1
```

- [ ] **Step 5:** **G0 — HARD STOP.** Present May the window request + the pre-flight results. Do not proceed to Task 7 in any automated session. Record the G0 sign-off (date/time/window) in spike notes.

---

# Stream C — in-window runbook (executes ONLY inside May's G0 window)

> Abort ladder (spec §D2, applies to every step below): **A1** deploy health-check failure (auto-rollback) · **A2** `hive doctor` datastore-identity failure · **A3** Claude-lane degradation (Hermi/Alexandria/Samantha errors, `claude` breaker episode) · **A4** Luna behavior harmful beyond her own channel (garbage replies in #agent-luna are evidence, not aborts) · **A5** May says stop. Any abort ⇒ `cd ~/services/hive/keepur && hive rollback` + Luna def restore (Task 11 Step 3) + spike-notes record. If deploy.sh dies mid-run (between bootout and bootstrap): re-run the same deploy command (fetch_engine starts with `rm -rf .hive.next`), or `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hive.keepur.agent.plist` to re-boot the untouched `.hive`.

## Task 7: P1 — deploy the epic build + G1

- [ ] **Step 1:** Deploy (spec §D1 verbatim — the script's own single-instance developer path):

```bash
cd <worktree>
HIVE_SINGLE_INSTANCE=1 HIVE_SINGLE_ID=keepur HIVE_SINGLE_CONFIG=hive.yaml \
HIVE_SINGLE_LOGS=logs HIVE_SINGLE_PORTS="3300 3301 3302 3303 3304 3305 3306" \
HIVE_SINGLE_ROOT=$HOME/services/hive/keepur \
BUILD_DIR=<worktree> \
  ./service/deploy.sh --tag=0.0.0-kpr351-local
```
Expected: `fetch_engine: npm pack @keepur/hive@0.0.0-kpr351-local` fails → `falling back to rsync from <worktree>` → bootout → port drain → `npm install --omit=dev` → swap → bootstrap → health check PASS. A health-check failure auto-rolls back (A1 — abort, diagnose `.hive.broken`, finding recorded).

- [ ] **Step 2:** Post-deploy identification + rollback-readiness gate (do not proceed past this step without all four):

```bash
echo "kpr-345 epic $(git -C <worktree> rev-parse HEAD) $(date +%F)" > ~/services/hive/keepur/.hive/BUILD_INFO
grep '"version"' ~/services/hive/keepur/.hive/package.json        # 0.10.0 — epic build identifies by BUILD_INFO, not version
ls ~/services/hive/keepur/.hive.prev/pkg/server.min.js && grep '"version"' ~/services/hive/keepur/.hive.prev/package.json   # MUST be 0.10.1
tail -5 ~/services/hive/keepur/logs/hive.log                      # "Hive is running" marker
cd ~/services/hive/keepur && hive doctor                          # Datastore identity PASS (A2 aborts)
```

- [ ] **Step 3:** Admin API up (token from Step 6.3 now active):

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3304/admin/agents | head -c 400
```
Expected: JSON array containing the four keepur agents. If the admin API is NOT up (config edge): fall back to the documented direct-Mongo mechanic for ALL later mutations and note version-history entries manually in the ledger:

```bash
# fallback mutation shape (run from ~/services/hive/keepur/.hive, node + bundled mongodb driver)
node -e 'const{MongoClient}=require("mongodb");(async()=>{const c=await MongoClient.connect("mongodb://localhost:27017");await c.db("hive_keepur").collection("agent_definitions").updateOne({_id:"luna"},{$set:JSON.parse(process.argv[1])});await c.close();console.log("ok")})()' '{"model":"claude-sonnet-4-6"}'
kill -USR1 $(pgrep -f "keepur/.hive/pkg/server.min.js")
```

- [ ] **Step 4:** **C0 — Hermi Claude-lane smoke (the G1 gate):** post in #agent-hermi a request that forces ≥1 tool call (e.g. "Hermi, quick smoke: look up Alexandria in contacts and tell me her role"). Verify: correct reply; no new errors in `logs/hive.err`; telemetry row for the turn. Evidence + verdict → spike notes C0. **G1 passes** = deploy healthy + rollback verified + C0 GREEN.

## Task 8: P2 — staged claude baseline + claude→codex handoff (G2a)

Every PATCH below: record the inverse in the mutation ledger FIRST; follow with belt-and-braces `kill -USR1 $(pgrep -f "keepur/.hive/pkg/server.min.js")` (PATCH already triggers `safeReload` — verified plan-time, admin-api.ts:200).

- [ ] **Step 1 (M3):** `curl -s -X PATCH http://localhost:3304/admin/agents/luna -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-6"}'` → response shows the new model.
- [ ] **Step 2:** Start a NEW thread in #agent-luna; baseline claude turn planting the recall fact: *"Luna, validation run note: the passphrase for this exercise is 'cobalt-heron-42'. Please confirm you've noted it."* Verify reply, then: sessions row for (luna, this thread) has `provider: "claude"` + a real (non-empty) sessionId — `mongoexport --db hive_keepur -c sessions -o - 2>/dev/null | grep luna` (adapt to the P0-observed schema). Snapshot → spike notes (the before-state for the handoff).
- [ ] **Step 3 (M4):** PATCH `{"model":"codex/gpt-5.5:medium"}`. Send a second message in the SAME thread (e.g. *"Thanks — what's the passphrase?"*). **G2a evidence:** (a) `grep "Session provider mismatch" ~/services/hive/keepur/logs/hive.log | tail -1` shows `stored: "claude", turn: "codex"`; (b) fresh codex turn completes with a coherent reply (memory-bridge recall of the passphrase is a bonus data point — record either way; in-thread context is NOT expected across a handoff); (c) sessions row now `provider: "codex"`, `sessionId: ""`; (d) history clear ran as a no-op (no prior codex history). Evidence → spike notes P2.

## Task 9: P3 — matrix legs C1–C8 (G2b = all gating legs GREEN)

All on the validation thread unless noted; per-leg §D6 blocks in spike notes; GREEN criteria are spec §D4's, restated here as executable checks. **Ordering is load-bearing: C2's snapshots MUST be captured before C7 (the heal destroys the doc).**

- [ ] **C1 — tool turn:** *"Luna, use your contacts tool to look up Mike Williams and tell me his email."* Verify: correct in-channel answer; latest telemetry row for luna shows codex-attributed model, `toolCalls ≥ 1`, `toolSummary` naming the bridged contacts tool; `grep -i "luna" logs/hive.log | tail -30` bridge/dispatch lines redaction-clean (no message text, no schema payloads).
- [ ] **C2 — stateless-replay continuity:** same thread: *"What was the passphrase, and who did you just look up?"* Verify: BOTH facts recalled (passphrase came through turn-1-of-codex context only if planted post-handoff — if the claude-era fact didn't bridge, re-plant it in the C1 turn and rerun; the gating assertion is turn-over-turn codex continuity); `provider_turn_history` doc exists for `{agentId:"luna", threadId, provider:"codex"}` with whole-turn items appended; **≥1 reasoning item with `encrypted_content`** (`:medium` effort ⇒ effort-gated replay exercised — inspect the raw doc); sessions row still `sessionId: ""`. Export the doc to `$EVID/../c2-history.json` — this is also C7's before-state.
- [ ] **C3 — memory:** *"Luna, use your memory recall to tell me what you remember about your weekly memory-hygiene routine."* Verify: reply grounded in real memories; telemetry/log shows the `mcp__structured-memory__memory_recall` call (KPR-349 Lane B name); hot-tier content visibly steering behavior (instructions carry the memory block).
- [ ] **C4 — skills + legacy layout:** *"Luna, load your memory-hygiene-review skill and summarize its steps (don't execute them)."* Verify: `load_skill` call observed; reply reflects the actual SKILL.md content (spot-check against `~/services/hive/keepur/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md`); this doubles as the legacy-layout check (plan-time expectation: GREEN via projection — a miss = projection/index finding, sized per spec: in-place if trivial, else follow-up + matrix caveat).
- [ ] **C5 — guardrails (structural, no mutation):** no live denial leg (spec ruling — Luna has no archetype; allow-all IS her correct posture). Evidence: spawn-time gate construction log line + C1's calls having flowed through `wrap()`. Matrix-note honestly: deny path remains unit-pinned.
- [ ] **C6 — delegate Task turn (M5, KPR-354 enum confirmation):** PATCH `{"delegateServers":["google"]}` + SIGUSR1. *"Luna, delegate to your google helper: what's on the calendar today?"* Verify: synthesized `Task` tool advertised (enum-restricted `subagent_type` — completion of the call IS the live enum acceptance); `grep "Nested delegate turn complete" logs/hive.log | tail -1` shows `{provider: "codex", delegate: "google"}`; no saturation (`maxConcurrent: 3` ⇒ parent+nested fit; a denial ⇒ record + retry in a quiet moment); sessions + `provider_turn_history` row counts unchanged by the nested turn (compare to pre-leg export). **If the codex backend rejects the enum schema:** record the exact payload, apply KPR-354's pre-authorized fallback (plain-string `subagent_type` + runner-side validation — a one-line schema change in the Task synthesis), `npm run check:bundle`, redeploy via the Task-7 command, re-run the leg — in scope per that spec's own contingency. Then PATCH `{"delegateServers":[]}` (M5 inverse) + SIGUSR1.
- [ ] **C7 — deliberate poisoned replay (M6):** confirm C2's history export exists FIRST. PATCH `{"model":"codex/gpt-5.4-mini:medium"}` + SIGUSR1; same thread: *"Summarize this conversation so far."* Two acceptable outcomes, both recorded: (a) backend 4xx on foreign encrypted reasoning ⇒ exactly one fresh retry + history clear (warn log from the KPR-353 §D7 self-heal; history doc gone then re-created) + coherent reply; (b) backend tolerates ⇒ no self-heal, noted. **Gating only that the thread survives.** Restore: PATCH `{"model":"codex/gpt-5.5:medium"}` (M6 inverse) + SIGUSR1.
- [ ] **C8 — telemetry honesty (query-only):** across the C1–C7 rows: `llmMs = durationMs − toolMs` shape (± rounding), nonzero single-counted usage, `costUsd: 0`, `toolSummary` populated; codex breaker closed throughout: `mongoexport --db hive_keepur -c telemetry -q '{"kind":"circuit_breaker_stats"}' -o - | grep codex` → `state: "closed"`, zero trips.
- [ ] **G2b:** all gating legs GREEN (C7 outcome-neutral) → record sign-off. Any RED → abort ladder or spec-sized follow-up per leg disposition.

## Task 10: P4 — inverse transition (G2c, the KPR-313 proof)

- [ ] **Step 1 (M7):** Pre-state: export the thread's `provider_turn_history` doc + sessions row (must be non-empty codex history — the first-ever production non-empty clear). PATCH `{"model":"claude-sonnet-4-6"}` + SIGUSR1.
- [ ] **Step 2:** Same thread: *"Luna, quick check-in — how's this validation run going?"* Gating evidence (spec §D5, all five): (1) guard warn `stored: "codex", turn: "claude"`; (2) the thread's `provider_turn_history` doc **deleted** (export → zero rows for the threadId); (3) sessions row `provider: "claude"` with a real handle; (4) `sessionHandoff` path fired = the warn + fresh session (annotation text stays unit-pinned — prompt content is log-redacted; state this honestly in the notes); (5) reply coherent WITHOUT codex-era in-thread context (fresh session by design; memory is the bridge).
- [ ] **Step 3:** One more turn in the thread → verify the claude session RESUMES (sessions row's handle stable/rotated-by-resume, no second guard warn). **G2c** → sign-off recorded.

## Task 11: P5 — restore + G3

- [ ] **Step 1:** Present May the two G3 decision points BEFORE any restore action (recorded verbatim in spike notes; defaults apply only on explicit "defaults"): (a) keep the epic build until the epic releases, or roll back now (default: roll back); (b) park Luna on `claude-sonnet-4-6` until release, or restore observed codex state (default: restore).
- [ ] **Step 2 (M8, default path):** `cd ~/services/hive/keepur && hive rollback` → verify `grep '"version"' .hive/package.json` = **0.10.1**, "Hive is running" marker, `hive doctor` PASS, one Hermi smoke turn GREEN.
- [ ] **Step 3 (M9):** Luna def restore — **field-scoped to exactly what the pass mutated** (never the full export — the admin API's PATCH canonicalization would flip `maxConcurrent: 3` → `spawnBudget: 3` and false-fail the diff gate):

```bash
curl -s -X PATCH http://localhost:3304/admin/agents/luna -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"model":"codex/gpt-5.5:medium","delegateServers":[]}'
kill -USR1 $(pgrep -f "keepur/.hive/pkg/server.min.js")
```
(0.10.1's admin API is running because the Keychain token survives the rollback restart.)

- [ ] **Step 4:** Diff-empty gate:

```bash
mongoexport --db hive_keepur -c agent_definitions -q '{"_id":"luna"}' -o - 2>/dev/null | python3 -m json.tool > /tmp/luna-post.json
python3 -m json.tool "$HOME/kpr351-evidence/p0/luna-def.json" > /tmp/luna-pre.json
diff /tmp/luna-pre.json /tmp/luna-post.json
```
Expected: differences ONLY in `updatedAt`/`updatedBy` (PATCH stamps them; note honestly). Every other field byte-equal — in particular `model`, `delegateServers`, `maxConcurrent: 3` intact, **no `spawnBudget` key appeared**. Residual `provider_turn_history`/`agent_definition_versions` docs are inert (TTL / history) — left alone per R4.

- [ ] **Step 5 (M1 inverse):** `security delete-generic-password -s "hive/keepur/ADMIN_API_TOKEN"` then `launchctl kickstart -k gui/$(id -u)/com.hive.keepur.agent` → verify service healthy and port 3304 no longer serving (`curl -s -m 2 http://localhost:3304/admin/agents; echo $?` → connection refused). Status quo ante complete. **G3** sign-off recorded.

## Task 12: P6 — non-gating legs (conditional, window-permitting)

- [ ] **openai L0–L3:** ONLY if May supplies `OPENAI_API_KEY` in-window (absent at plan time — expected skip). If run: per spec §D4 L-series on a scratch agent or temporarily-flipped Luna, under the epic build (i.e., before Task 11 Step 2 — slot P6 between Tasks 10 and 11 in that case). L2's captured payload feeds Task 13's conditional R5. Record every leg (or the skip) in spike notes.
- [ ] **gemini N1–N2:** optional; key present (dev tier). N1 needs the KPR-352 T0 thread's persisted handle (from that spike's notes) aged >1d — record live status/payload of the resume attempt; a genuine-expiry observation folds into the adapter sentinel ONLY if observed, as a follow-up-sized note. N2 = one delegate turn on a gemini scratch agent. Skip freely; absence changes only KPR-355 wording.

---

# Stream D — post-window

## Task 13: Consolidation, KPR-355 row facts, conditional R5

**Files:**
- Modify: `docs/epics/kpr-345/kpr-351-spike-notes.md` (consolidation)
- Modify: `CLAUDE.md` (live-validated clause — only if gating legs GREEN)
- Conditional modify: `src/agents/agent-manager.ts:299` + `agent-manager.test.ts` (R5/T4)

- [ ] **Step 1:** Consolidate spike notes: every leg has its §D6 block; mutation ledger fully reconciled (every Applied has its Reverted or an explicit May-decision note); G0–G3 sign-offs; R4 decision record; KPR-355 row-fact delta list (codex rows → live-validated with leg citations; openai rows unchanged unless P6 ran; Lane A restated live-unvalidated).
- [ ] **Step 2:** CLAUDE.md — append to the Task-4 rider sentence (only with GREEN evidence): `The codex surface is live-validated in production (KPR-351: keepur/Luna flagship arc — tools, stateless replay incl. encrypted reasoning, delegate Task turn, KPR-313 inverse transition).`
- [ ] **Step 3 (conditional R5/T4):** if L2 ran AND the live payload missed `isStaleServerHandleError`: refine the matcher minimally against the captured string; add the string to the must-match table + keep every must-NOT-match entry green; classification pin stays `non-provider`. If L2 didn't run: write the explicit no-op line in spike notes (`R5: no-op — no OPENAI_API_KEY in window; matcher ships as KPR-350 built it`).
- [ ] **Step 4:** Final gate + commit.

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
git add docs/epics/kpr-345/kpr-351-spike-notes.md CLAUDE.md src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-351: runbook evidence — spike notes, KPR-355 row facts, CLAUDE.md live-validated clause"
```

---

## Notes for the reviewer (plan-level decisions and rationale)

1. **Admin-token seeding over the direct-Mongo fallback as primary** — the spec prefers the admin surface (version history, field-scoped PATCH semantics R4 leans on); `optional()`'s env→Keychain resolution makes the seed zero-config-file, and M1's inverse restores the exact pre-pass posture (admin API down). The Mongo fallback stays fully specified in Task 7 Step 3.
2. **C6 = `google`, not spec-suggested `brave-search`** — plan-time probe found `BRAVE_API_KEY` absent; `activeDelegateNames` would silently drop it (no Task tool, a false-RED trap). `google` is Hermi-production-proven on this instance. This exercises the spec's own named fallback path ("another catalog-eligible tier-2 server configured on keepur").
3. **R1 test-mock collapse (`run: runnerRunMock`)** — one line in the mock factory keeps ~25 existing assertions byte-identical while every turn now flows through `Runner.run` (same `(agent, prompt, options)` signature). The alternative (rewriting every test to a second mock) was churn without added evidence.
4. **R1 throw placement (top of try, pre-`bridge.connect()`)** — fails misconfig in microseconds without spawning MCP subprocesses, lands in `RunResult.error` via the adapter's own catch (gemini-identical), keeps `bridge.close()` in the finally. Spec's "classifyThrown = auth" sketch is honored by the additive classification pin (both classify paths share the same FAULT_PATTERNS table).
5. **R2 same-provider conjunct on adoption** — the spec's ruling text says "different non-empty handle"; the plan adds `contender.provider === shaping.route.provider`, mirroring the KPR-313 adopt-branch idiom the ruling itself cites: adopting a foreign-provider handle would resume cross-provider, which the guard exists to prevent. Fresh retry remains the fallthrough for that shape.
6. **P5 ordering follows the spec default** (rollback first, def restore under 0.10.1); the restore-flip's KPR-313 re-trip under 0.10.1 legacy machinery is expected/unremarkable per §D5.
7. **`isProviderAuthError` becomes consumer-less** after R1 but `oauth-credentials.ts` is outside spec §D7's change table — left untouched, flagged as candidate cleanup for a future sweep.
