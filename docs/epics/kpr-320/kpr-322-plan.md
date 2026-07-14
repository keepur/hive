# KPR-322 — Implementation Plan: LiveKit Agents worker + hive-as-LLM-node bridge

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Ticket:** KPR-322 (W5.2), child of epic KPR-320 (W5 Voice v2). **Blocks:** KPR-324, KPR-325. **Consumes:** KPR-321 §8 artifacts.
**Spec:** [`kpr-322-spec.md`](./kpr-322-spec.md) (clean through 2 Frontier review rounds). Section refs (§n) are spec sections; E1–E4 / SIP-1..5 / P0–P4 are the spec's IDs.
**Plan type:** CODE plan (engine diff + net-new worker) with an ops tail (SIP wiring) and D3-gated empirical tasks (P0–P4, SIP-5).
**Anchors:** every code anchor below re-verified 2026-07-14 against lane worktree `/Users/mokie/github/lane-kpr-322` @ `18ca193` (base = main @ W6, per spec). W3 (epic kpr-309) is NOT merged; Task 0 re-confirms before any delivery work.
**Status:** DRAFT — dispatcher runs the plan-review loop; not self-approved.

**Goal:** A LiveKit Agents worker (Node, in-repo at `src/voice-worker/`) that runs phone calls over the KPR-321 Twilio SIP trunk with hive's existing voice endpoint as the pipeline's LLM node, plus the small enumerated engine diff (E1 bridge auth, E2 abort-on-disconnect, E3 config, E4 optional initiation tool) and the SIP wiring the spec owns (SIP-1..SIP-5).

**Architecture:** SIP audio → LiveKit Cloud → worker `AgentSession` (Deepgram STT → `HiveLLM` bridge → Cartesia/ElevenLabs TTS) → SIP audio. The bridge POSTs each turn to `http://127.0.0.1:<voice.port>/v1/chat/completions` (SSE) — the hardened Vapi spawn path (per-thread lock, budget, resume + outer retry, circuit breaker) — and converts SSE text deltas to `ChatChunk`s. No engine imports of LiveKit SDKs; the worker is a separate launchd service.

**Tech stack:** TypeScript strict / Node 22; `@livekit/agents` 1.5.x + plugin packages (deepgram, cartesia, elevenlabs, silero) + `@livekit/rtc-node` + `livekit-server-sdk`; vitest; launchd; MongoDB telemetry.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: E1 auth semantics (`voice-adapter.test.ts`), E2 `abortThread` lock-release (`agent-manager.test.ts`), E3 config resolver (`config.test.ts`), E4 tool schema/dispatch payload, worker pure modules (`sse.ts`, `chat-ctx.ts`, `interruption-marker.ts`, `tts-normalize.ts`, `error-map.ts`, `cells.ts`), worker heartbeat (`voice-worker-heartbeat.test.ts`), doctor reader (`doctor-checks.test.ts`), setup-script planning logic (`livekit-setup.test.ts` — pure diff function, fake client).
  - Reason: E1/E2 are security- and correctness-load-bearing engine changes on a live shared endpoint (Vapi coexists); the bridge's SSE/error/marker logic is the worker's core contract and is fully testable without LiveKit media.
  - Minimum assertions (E1 — all seven, exactly these):
    1. Valid `Authorization: Bearer <HIVE_VOICE_BRIDGE_TOKEN>` + worker-shaped body (NO `assistant` object, `call.metadata.hive_agent_id` set) → 200, spawn runs.
    2. Non-matching bearer (`Bearer no-credentials-provided`) + Vapi-shaped body (`assistant` present) → **falls through** to the shape check and succeeds (Vapi default-header behavior unbroken).
    3. Neither token nor Vapi shape (no `assistant`, wrong/absent bearer) → 401 (the token is load-bearing for the worker path).
    4. `serverSecret` unset + valid bridge token → 200 (carve-out from the `voice-adapter.ts:112-117` 403-gate); `serverSecret` unset + Vapi-shaped, no token → 403 (unchanged).
    5. Bridge token configured but body has no resolvable `call.metadata.hive_agent_id` → 400 (authenticated but malformed; distinct from 401).
    6. `bridgeToken === ""` (LiveKit disabled) → every Vapi request byte-identical to pre-E1 behavior (regression).
    7. Loopback bind: adapter listens on `bindHost` (integration: `server.address()` reports `127.0.0.1`; request over `127.0.0.1` succeeds).
  - Minimum assertions (E2): `abortThread` aborts the ticket-holding spawn and the queued same-thread turn then proceeds (real `AgentManager`, hanging mocked runner); `abortThread` returns false when idle; adapter fires `abortThread(agentId, "voice:<callId>")` on premature socket close mid-stream; adapter does NOT fire it on normal completion; no response write after premature close (no throw, no `write after end`); outer retry suppressed when client is gone. **Negative-verify (CI-documented + P3-live):** see Verification Rules below.
  - Minimum assertions (worker pure modules): SSE parser yields one chunk per `delta.content`, terminates on `data: [DONE]`, tolerates split frames across network chunks, zero-content stream → empty turn (no synthesis); full-transcript serialization (every turn, system dropped worker-side is NOT done — system never sent); interruption marker prefixes ONLY the next user message after an interrupted turn, ~15-word tail; error map covers every §8 row (spoken-notice 200 passthrough, budget-503 retry-once, auth-503/401 no-retry, 500 retry-once, ECONNREFUSED → `engine_unreachable`, mid-stream error → delivered-text-is-the-turn); cell resolver maps all four §14.1 cells + rejects unknown.

- Integration: **required**
  - Scope: `voice-adapter.integration.test.ts` (real HTTP server, port 0, real client sockets) for E1 auth matrix over the wire, loopback bind, and E2 socket-destroy; `hive-llm` bridge against a stub SSE engine server (real HTTP, canned SSE frames, abort observation).
  - Reason: E1/E2 semantics are HTTP-socket-level (headers, premature `close`, write-after-close) — mock `ServerResponse` objects can't prove them.
  - Harness: **existing** — `src/channels/voice/voice-adapter.integration.test.ts` (KPR-219 pattern: real server, `port: 0`, mock AgentManager/Dispatcher, SSE byte-level asserts) and `src/agents/agent-manager.test.ts` (real AgentManager, `mockRunnerSend`/`mockRunnerAbort`, `makeSmsCtx`/`makeRunResult` helpers). Worker-side stub-engine harness: **setup-required** (one helper in the new test file; plain `node:http`, no new deps).
  - Minimum assertions: first-turn + resume-turn round-trips still pass untouched (existing suite green); disconnect mid-stream → abort surface invoked ≤ 100ms; `HiveLLMStream` yields chunks in arrival order and propagates `AbortController.abort()` to the in-flight request (stub server observes the socket close).

- E2E: **not-required** (in CI) / **required as gated PoC** (P0–P4, SIP-5 — designed, NOT run; each requires recorded operator go per D3)
  - Scope: live SIP call path, barge-in on a real call, latency cells, vendor A/B.
  - Reason: requires LiveKit Cloud + vendor accounts + PSTN + spend — architecturally impossible in CI and explicitly operator-gated by the program ruling.
  - Harness: setup-required at delivery (§16 ops cards + Tasks 11–13); the P-gate tasks below ARE the E2E protocol.
  - Minimum assertions: the §15 pass criteria verbatim (P0 connect/greeting/two-way/hangup; P1 ≥90% spoken turns + resume ≥8/9; P2 latency vs 323-bound placeholders; P3 ≤500ms stop + lock-release + resume; P4 §14.4 decision rule).

### Critical Flows

- Vapi turn (regression): Vapi-shaped POST → resolve → spawn → SSE deltas → `[DONE]` — byte-identical pre/post E1.
- Bridge turn: token-authed POST, full transcript, `call.metadata.hive_agent_id` → `buildVoiceSystemPrompt` → resume-or-full-prompt → stream → `ChatChunk`s.
- Barge-in: client socket close mid-generation → in-flight spawn aborted → per-thread lock released → next turn spawns immediately → resume survives (or outer retry fires).
- Outage honesty: circuit-open → 200 spoken notice → flows through TTS (zero new code — regression-guard only).

### Regression Surface

- The Vapi coexistence path: `handleRequest` auth fall-throughs, `resolveAgentId` 3-priority chain (`voice-adapter.ts:501-517`), outer retry (`voice-adapter.ts:337-351`), circuit-open/budget/auth rows (`voice-adapter.ts:354-383`), `sdkSessionResumed` telemetry semantics.
- `AgentManager` spawn coordinator: lock/budget/ticket cleanup invariants (`withSpawnTicket`), `stopAgent` (which shares `ticket.abort()`), reflection scheduling — existing `agent-manager.test.ts` suite must stay green.
- `hive doctor` existing sections (prefix-cache, spawn-coordinator) — new voice-worker section must not perturb them.
- Engine bundle gates: `npm run bundle` + `check:bundle` (worker is unbundled; engine entry must not pull LiveKit imports).

### Commands

- Unit + Integration (all CI groups): `npm run test` (vitest; targeted: `npx vitest run src/channels/voice src/agents/agent-manager.test.ts src/voice-worker src/cli/doctor-checks.test.ts`)
- Full quality gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle gates (engine unaffected proof): `npm run check:bundle`
- E2E: gated-PoC-only — protocols in Tasks 14–19; **never run without the recorded operator go**.

### Harness Requirements

- Existing vitest harness; no new services for CI groups. Worker unit tests must import ONLY the pure modules (no `@livekit/agents` import in `sse/chat-ctx/marker/normalize/error-map/cells` tests — those modules are written import-free by design, Task 6). One smoke test imports `@livekit/agents` to prove the dep loads on the ARM64 runner; if the native prebuild fails to load in CI, that is a **concrete blocker to report**, not a skip.
- Gated PoC harness: LiveKit Cloud project + Deepgram/Cartesia/ElevenLabs keys + `HIVE_VOICE_BRIDGE_TOKEN` in Honeypot (§16, May), 321 artifacts through B7, `voice-pilot` test agent (Task 14 prep).

### Non-Required Rationale

- E2E (CI): see above — PSTN/vendor/spend cannot exist in CI; the D3 ruling additionally forbids unapproved runs. All other groups required.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify rule for E2 (bug-fix-class change):** after the E2 tests pass on delivery HEAD, re-run the two designated tests with the fix reverted and confirm they FAIL: (a) `git stash push -- src/channels/voice/voice-adapter.ts src/agents/agent-manager.ts` → `npx vitest run src/agents/agent-manager.test.ts -t "abortThread"` must fail to compile/fail, and `npx vitest run src/channels/voice/voice-adapter.integration.test.ts -t "disconnect"` must fail on the missing abort call → `git stash pop`. Record both outputs in the implement-lane notes. (b) The live-call negative-verify (demonstrate the lock-queue hazard on pre-E2 engine code) is P3's first step (Task 17) — gated.

---

## 0. How to run this plan

- **Program mode:** maturity-first. This plan is written now, executed only after the operator re-opens W5 delivery **and W3 (epic kpr-309) has merged**. Task 0 is a hard gate: no other task starts before it passes or its demote-to-spec branch is taken.
- **D3 rule:** Tasks 14–19 (P0–P4, SIP-5) each begin with an operator-go block. Execution of any of them without a recorded "go" (date + words, in Linear KPR-322 comments at execution time) is a scope breach. Approvals are per-gate — never generalized.
- **External preconditions (stated, not plan tasks):**
  - KPR-321 execution complete **through B7** (trunk shell + credential list; Twilio keys seeded — 321 A6/A7/T9) before Task 12 (SIP-1).
  - §16 ops cards done by May before Task 12 / any P-gate: LiveKit Cloud project + `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`; Deepgram/Cartesia/ElevenLabs keys; `HIVE_VOICE_BRIDGE_TOKEN` (`openssl rand -hex 32` class) — all in Honeypot `hive/dodi/<KEY>`. Agents never create accounts or see raw secrets.
  - KPR-323's blessed latency baseline before P2 thresholds bind (placeholder until then).
- **Secrets:** every command that needs a secret resolves it from Keychain inside the single invocation (321 §0.2 pattern); never echoed, never in transcripts, never in the repo. Subprocesses via argv arrays only (`execFileSync(bin, [args])`).
- **Conventions:** `createLogger` for logging; strict TS, no `any` without justification; tests beside source (`src/**/*.test.ts`); commit per task; `npm run check` before any PR.
- Tick each `- [ ]` as executed.

---

## 1. Execution order

```
Task 0 (anchor re-confirm gate — HARD)
   ├─ engine track:  T1(E3 config) ── T2(E1 auth+bind) ── T3(E2 abort) ── [T4(E4 tool, severable)]
   ├─ worker track:  T5(deps+skeleton) ── T6(bridge core) ── T7(session+errors) ── T8(telemetry) ── T9(doctor) ── T10(plist)
   └─ script:        T11(livekit-setup.ts)            (needs only T1's config names + T5's deps)
external: 321-through-B7 + §16 accounts ──► T12(SIP-1..3 run) ── T13(SIP-4)
gated:    T14[GO](voice-pilot + P0) ── T15[GO](P1) ── T16[GO](P2) ── T17[GO](P3 incl. E2 negative-verify) ── T18[GO](P4 A/B)
          T19[GO + May-confirm inbound agent](SIP-5 cutover — LAST) ── T20(close-out)
```

| Task | What | Depends on | Parallel with |
|---|---|---|---|
| 0 | Anchor re-confirm | W5 re-open + W3 merged | — (blocks all) |
| 1 | E3 config keys | 0 | 5–11 |
| 2 | E1 bridge auth + loopback bind | 1 | 5–11 |
| 3 | E2 abort-on-disconnect | 1 (not 2) | 5–11 |
| 4 | E4 `voice_call` LiveKit tool (severable → may move to 325) | 1, 5 (sdk dep) | any |
| 5 | Worker deps + config + skeleton | 0 | 1–3 |
| 6 | Bridge core (`HiveLLM` + pure modules) | 5 | 1–3 |
| 7 | Session orchestration + §8 error rows | 6 | 1–3 |
| 8 | Worker telemetry (JSONL + heartbeat + call stats) | 7 | 9 prep |
| 9 | `hive doctor` voice-worker section | 8 (kind name only) | 10 |
| 10 | launchd plist + dev mode | 5 | 9 |
| 11 | `scripts/livekit-setup.ts` | 1, 5 | 2,3,6–10 |
| 12 | Run SIP-1..3 | 11 + **external: 321 B7 + §16.1** | 13 prep |
| 13 | SIP-4 origination URI | 12 | — |
| 14 | `voice-pilot` agent + **P0** [GO] | 2,3,7,8,10,12,13 + §16.2/3 | — |
| 15 | **P1** [GO] | 14 | — |
| 16 | **P2** [GO] | 15 + 323 baseline | — |
| 17 | **P3** incl. E2 negative-verify [GO] | 15 | 16 |
| 18 | **P4** A/B matrix [GO] | 16,17 | — |
| 19 | **SIP-5** cutover [GO + May confirms inbound agent] | 14(P0),15(P1) — spec sequences it last in practice: after 18 | — |
| 20 | Close-out | all | — |

Engine track (T1–T3) and worker track (T5–T11) are genuinely independent after Task 0 — the bridge contract is fixed by the spec, not by the engine diff. T4 is severable: delivery may re-scope it to KPR-325 without touching anything else.

---

## 2. Tasks

### Task 0 — Anchor re-confirmation gate (mandatory; demote-to-spec escape hatch)

**Files:** none modified. Output: a pass/fail table in the implement-lane notes.

Rule: for each anchor, re-locate it at delivery HEAD (grep by symbol, not line). **Cosmetic drift** (line shifts, renames with same semantics) → update the plan's line refs inline and proceed. **Material drift** (signature/semantics/keying/error-shape changes) → STOP, demote the ticket to the spec lane per the program Task-0 pattern; do not "adapt on the fly".

- [ ] **W3 surface 1 — `Dispatcher.routeVoiceTurn`** (today `src/channels/dispatcher.ts:752`, `(ctx: TurnContext, onStream?) => Promise<TurnResult>`): confirm signature, taskLedger/audit semantics, dedup-skip. Material if: signature reshaped or voice routing moved off `TurnContext`.
- [ ] **W3 surface 2 — `TurnContext`/`spawnTurn`/session keying**: `TurnContext` fields (today `agent-manager.ts:71-92`), Mongo `sessions` keyed `(agentId, threadId)` with `_id "{agentId}:{threadId}"` (`session-store.ts:6-21`), 7-day TTL (`session-store.ts:31-32`), outer-retry contract (`voice-adapter.ts:337-351`). Material if: KPR-313 changed resume semantics or thread keying that `threadId = voice:<callId>` (§6) rides on.
- [ ] **W3 surface 3 — adapter error taxonomy**: string-match `"Spawn budget exceeded"` (`voice-adapter.ts:375`), `isAuthError` regex (`voice-adapter.ts:24-29`), `instanceof ProviderCircuitOpenError` catch (`voice-adapter.ts:324`). If W3 landed typed errors, re-bind §8 rows / Task 3 guards to the typed forms (cosmetic if 1:1 mapping exists; material otherwise).
- [ ] **W3 surface 4 — `systemPromptOverride` consumption**: `TurnContext.systemPromptOverride` (`agent-manager.ts:79-86`) still bypasses `buildSystemPrompt` and reaches the runner (`runOneSpawnAttempt`, `agent-manager.ts:1061`). Material if prompt assembly moved.
- [ ] **W3 surface 5 — circuit-breaker fast-fail placement**: `ProviderCircuitOpenError` still thrown pre-spawn and catchable at the adapter (`agent-manager.ts` acquire path + `voice-adapter.ts:318-327`). Material if classification relocated behind a provider-adapter layer.
- [ ] **Load-bearing engine anchors** (re-locate each; update refs): `listen(this.port)` no-host bind (`voice-adapter.ts:82`); `serverSecret` 403-gate (`:112-117`); Vapi `Bearer no-credentials-provided` comment + body-shape auth (`:125-159`); `threadId = voice:${callId}` (`:236`); `buildVoiceSystemPrompt` call (`:243-246`); `onStream` SSE relay (`:272-289`); error rows (`:354-383`); `resolveAgentId` (`:501-517`); `includePartialMessages: !!onStream` (`agent-runner.ts:1808`); `text_delta → onStream` (`agent-runner.ts:1912-1917`); `AgentRunner.abort()` (`agent-runner.ts:2090-2097`); 25ms lock-wait loop (`agent-manager.ts:681-688`); `SpawnTicket` + `attachAbort` (`agent-manager.ts:223-229`, `:1042`); `stopAgent` ticket walk (`:1304-1326`); voice wiring gate `config.voice.enabled && config.voice.serverSecret` (`index.ts:699-712`); `config.voice` block (`config.ts:408-417`); `formatSSETextChunk`/`formatSSEDone` shapes (`openai-translator.ts:129-199`); Vapi `voice_call` schema (`voice-mcp-server.ts:53-64`) + metadata threading (`:87-92`); stdio-server registration block (`agent-runner.ts:552-570`) + bundle entry map (`build/bundle.ts:91`) + min-js path map (`agent-runner.ts:245`).
- [ ] **agents-js pin (§5.4)**: pin exact versions of `@livekit/agents`, `@livekit/agents-plugin-{deepgram,cartesia,elevenlabs,silero}`, `@livekit/rtc-node`, `livekit-server-sdk` (1.5.x line at spec time); verify from release notes/docs: (1) `deepgram.STTv2` Flux + session `turnDetection: "stt"`; (2) turn-detector model plugin for the Nova-3 cell — if absent, record the accepted fallback (VAD/endpointing-only) as an A/B validity caveat in the lane notes; (3) false-interruption resume options; (4) preemptive generation availability (nice-to-have; record only). Pin the exact `llm.LLM`/`llm.LLMStream` subclass signatures against the installed typings and mechanically adjust Task 6's class skeleton if they differ (cosmetic); if the custom-LLM extension point itself changed shape (no subclass path and no `llmNode` override), that is **material → demote**.
- [ ] Record the full table (anchor → found-at → cosmetic/material/UNCHANGED) in lane notes. Any material row → demote-to-spec, stop.

### Task 1 — E3: config keys (`voice.livekit.*`, `voice.bridgeToken`, `voice.bindHost`, `telephony.twilio.*`)

**Files:**
- Modify: `src/config.ts` (voice block at `:408-417`; new resolver near `resolveCircuitBreakerConfig`)
- Test: `src/config.test.ts` (exists — add cases)

- [ ] **Step 1:** Add the liberal-loader resolver (KPR-225 F3 style) above the `config` export in `src/config.ts`:

```typescript
/**
 * KPR-322 E3: resolve the optional hive.yaml `voice.livekit` section.
 * Liberal-loader style (KPR-225 F3): all keys optional, unknown keys ignored,
 * non-object input → defaults. Exported pure for unit tests.
 */
export interface VoiceLivekitConfig {
  enabled: boolean;
  /** wss://<project>.livekit.cloud — non-secret. */
  url: string;
  /** SIPOutboundTrunk id from SIP-1 (ST_...). */
  sipTrunkId: string;
  /** E.164 → hive agent id map for inbound dispatch (S5). */
  inboundAgents: Record<string, string>;
  /** A/B cell defaults (S7); per-dispatch metadata overrides. */
  defaultStt: string;
  defaultTts: string;
}

export function resolveVoiceLivekitConfig(raw: unknown): VoiceLivekitConfig {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;
  const inboundAgents: Record<string, string> = {};
  if (src.inboundAgents && typeof src.inboundAgents === "object" && !Array.isArray(src.inboundAgents)) {
    for (const [num, agent] of Object.entries(src.inboundAgents as Record<string, unknown>)) {
      if (typeof agent === "string" && agent.trim()) inboundAgents[num] = agent.trim();
    }
  }
  return {
    enabled: src.enabled === true,
    url: str(src.url, ""),
    sipTrunkId: str(src.sipTrunkId, ""),
    inboundAgents,
    defaultStt: str(src.defaultStt, "deepgram/flux-general-en"),
    defaultTts: str(src.defaultTts, "cartesia/sonic-3"),
  };
}

/**
 * KPR-322: env-first / Honeypot-second secret resolution for out-of-engine
 * processes (the voice worker reuses the engine loader; this is the same
 * `optional()` semantics exposed for worker-side vendor keys).
 */
export function resolveSecretEnv(key: string): string {
  return process.env[key] || fromKeychain(key) || "";
}
```

(`fromKeychain` is the existing module-level closure at `config.ts:210`.)

- [ ] **Step 2:** Extend the `voice` block (at `config.ts:408-417`) and add `telephony` beside it:

```typescript
  voice: {
    enabled: !!hive.voice?.provider,
    provider: (hive.voice?.provider as string) ?? "",
    publicUrl: (hive.voice?.publicUrl as string) ?? "",
    phoneNumberId: (hive.voice?.phoneNumberId as string) ?? "",
    assistants: (hive.voice?.assistants ?? {}) as Record<string, string>,
    apiKey: optional("VAPI_API_KEY", ""),
    serverSecret: optional("VAPI_SERVER_SECRET", ""),
    port: parseInt(optional("VOICE_PORT", String(ports.voice ?? portBase + 5)), 10),
    // KPR-322 E1/E3: shared bridge secret (worker → adapter) + bind host.
    // Loopback default — both callers are local (worker directly; Vapi via
    // the cloudflared tunnel, which connects from localhost ⚠ verify tunnel
    // topology at delivery; escape hatch: voice.bindHost: "0.0.0.0").
    bridgeToken: optional("HIVE_VOICE_BRIDGE_TOKEN", ""),
    bindHost: ((hive.voice as Record<string, unknown> | undefined)?.bindHost as string) || "127.0.0.1",
    // KPR-322 E3: LiveKit worker section + worker/server API pair.
    livekit: resolveVoiceLivekitConfig((hive.voice as Record<string, unknown> | undefined)?.livekit),
    livekitApiKey: optional("LIVEKIT_API_KEY", ""),
    livekitApiSecret: optional("LIVEKIT_API_SECRET", ""),
  },
  // KPR-322 E3: names reserved by 321 §9, wired here. Consumed by
  // scripts/livekit-setup.ts (SIP-1) — never by cloud-model-facing code.
  telephony: {
    twilio: {
      number: ((hive.telephony as Record<string, { number?: string; trunkDomain?: string }> | undefined)?.twilio?.number as string) ?? "",
      trunkDomain:
        ((hive.telephony as Record<string, { number?: string; trunkDomain?: string }> | undefined)?.twilio?.trunkDomain as string) ?? "",
    },
  },
```

(Adjust the `hive.telephony` cast to the file's existing `hive` typing idiom if it differs — the loader stays liberal: absent keys → `""`/defaults, unknown keys ignored.)

- [ ] **Step 3:** Tests in `src/config.test.ts` (mirror the existing `resolveCircuitBreakerConfig` cases):

```typescript
import { resolveVoiceLivekitConfig } from "./config.js";

describe("resolveVoiceLivekitConfig (KPR-322 E3)", () => {
  it("defaults on absent/garbage input", () => {
    for (const input of [undefined, null, 42, "x", []]) {
      const c = resolveVoiceLivekitConfig(input);
      expect(c.enabled).toBe(false);
      expect(c.url).toBe("");
      expect(c.sipTrunkId).toBe("");
      expect(c.inboundAgents).toEqual({});
      expect(c.defaultStt).toBe("deepgram/flux-general-en");
      expect(c.defaultTts).toBe("cartesia/sonic-3");
    }
  });
  it("parses a full section and filters junk inboundAgents entries", () => {
    const c = resolveVoiceLivekitConfig({
      enabled: true,
      url: " wss://p.livekit.cloud ",
      sipTrunkId: "ST_1",
      inboundAgents: { "+15551230000": "nora", "+15551231111": 7, "+15551232222": " " },
      defaultStt: "deepgram/nova-3",
      defaultTts: "elevenlabs/eleven_flash_v2_5",
      unknownKey: "ignored",
    });
    expect(c.enabled).toBe(true);
    expect(c.url).toBe("wss://p.livekit.cloud");
    expect(c.inboundAgents).toEqual({ "+15551230000": "nora" });
    expect(c.defaultStt).toBe("deepgram/nova-3");
  });
  it("enabled must be literal true", () => {
    expect(resolveVoiceLivekitConfig({ enabled: "true" }).enabled).toBe(false);
  });
});
```

- [ ] **Step 4:** Verify — `npx vitest run src/config.test.ts` green; `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck` green.
- [ ] **Step 5:** Commit — `git add src/config.ts src/config.test.ts && git commit -m "feat(kpr-322): E3 voice.livekit + telephony.twilio config keys"`

### Task 2 — E1: bridge bearer auth + serverSecret carve-out + loopback bind

**Files:**
- Modify: `src/channels/voice/voice-adapter.ts` (constructor `:45-68`, `start()` `:81-82`, `handleRequest` `:111-160`)
- Modify: `src/index.ts:699-712` (wiring + start gate)
- Test: `src/channels/voice/voice-adapter.test.ts`, `src/channels/voice/voice-adapter.integration.test.ts`

- [ ] **Step 1:** Add the constant-time comparator near `isAuthError` in `voice-adapter.ts`:

```typescript
import { createHash, timingSafeEqual, randomUUID } from "node:crypto"; // extend the existing crypto import

/**
 * KPR-322 E1: constant-time bearer comparison. sha256 normalizes lengths so
 * timingSafeEqual never throws on length mismatch. Exported for unit tests.
 */
export function timingSafeTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 2:** Constructor: insert `bridgeToken` after `serverSecret`, and `bindHost` after `dispatcher` (both `private`):

```typescript
  constructor(
    private port: number,
    private serverSecret: string,
    /** KPR-322 E1: shared bridge secret (HIVE_VOICE_BRIDGE_TOKEN). "" = LiveKit bridge disabled. */
    private bridgeToken: string,
    private registry: AgentRegistry,
    private memoryManager: MemoryManager,
    private agentManager: AgentManager,
    private dispatcher?: Dispatcher,
    /** KPR-322 E1: loopback default — both callers are local. */
    private bindHost: string = "127.0.0.1",
  ) {
```

Update every `new VoiceAdapter(` call site in both voice test files (insert `""` or the test token as arg 3; leave trailing args as-is).

- [ ] **Step 3:** `start()` — bind to `bindHost` (replaces `voice-adapter.ts:82`):

```typescript
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, this.bindHost, () => resolve());
    });
```

and extend the started log: `log.info("Voice adapter started", { port: this.port, bindHost: this.bindHost });`

- [ ] **Step 4:** Replace the top of `handleRequest` (`voice-adapter.ts:111-160`) with the E1 enforcement semantics (spec §12 — load-bearing, not decorative):

```typescript
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = (req.headers["authorization"] as string) ?? "";
    const bearerSecret = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
    // KPR-322 E1: a matching bridge bearer authenticates the request as the
    // LiveKit worker, regardless of body shape. A present-but-NON-matching
    // bearer is NOT an immediate 401 — Vapi sends `Authorization: Bearer
    // no-credentials-provided` by default, so non-matching bearers fall
    // through to the Vapi shape check below.
    const isBridgeAuthed = this.bridgeToken !== "" && timingSafeTokenEqual(bearerSecret, this.bridgeToken);

    // Pre-E1 dead-endpoint gate, with the bridge carved out: a LiveKit-only
    // instance (no VAPI_SERVER_SECRET) must still serve bridge-authed turns.
    if (!this.serverSecret && !isBridgeAuthed) {
      log.error("Voice endpoint called but VAPI_SERVER_SECRET not configured — rejecting");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server secret not configured" }));
      return;
    }

    const providedSecret =
      (req.headers["x-vapi-secret"] as string) ?? (req.headers["server-secret"] as string) ?? bearerSecret ?? "";
    const hasValidSecret = providedSecret === this.serverSecret;

    // Custom LLM endpoint. Two authenticated shapes:
    //  (a) bridge: `Authorization: Bearer <HIVE_VOICE_BRIDGE_TOKEN>` — no
    //      `assistant` object; agent resolves via call.metadata.hive_agent_id.
    //  (b) Vapi: no/non-matching bearer, but Vapi-shaped — an `assistant`
    //      object present, resolving through the existing three-priority
    //      chain (assistant.metadata → voice.assistants map → call.metadata;
    //      the MCP-initiated flow legitimately uses call.metadata).
    // Anything neither token-bearing nor Vapi-shaped → 401. The worker sends
    // no `assistant`, so a wrong/missing token gets 401, never a spawn.
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readBody(req);
      let request: OpenAIChatRequest;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!isBridgeAuthed && !request.assistant) {
        log.warn("Voice request rejected — no bridge token and not Vapi-shaped", {
          hasBearer: !!bearerSecret,
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const agentId = this.resolveAgentId(request);
      if (!agentId) {
        if (isBridgeAuthed) {
          // Authenticated bridge but malformed body — a request error, not auth.
          log.warn("Bridge request missing resolvable agent", { hasCallMeta: !!request.call?.metadata });
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "call.metadata.hive_agent_id required" }));
          return;
        }
        log.warn("Voice request rejected — could not resolve agent from request body", {
          assistantId: request.assistant?.id,
          hasMetadata: !!request.assistant?.metadata,
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const agentConfig = this.registry.get(agentId);
      if (!agentConfig) {
        log.warn("Voice request rejected — agent not in registry", { agentId });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      return this.handleChatCompletion(req, res, request, agentId, agentConfig);
    }

    // All other paths require the shared secret (unchanged).
    if (!hasValidSecret) {
```

(The remainder of `handleRequest` — invalid-secret log, `/health`, 404 — is unchanged.)

- [ ] **Step 5:** `src/index.ts:699-712` — start the adapter for either caller and pass the new args:

```typescript
  let voiceAdapter: import("./channels/voice/voice-adapter.js").VoiceAdapter | undefined;
  const livekitBridgeWanted = config.voice.livekit.enabled && !!config.voice.bridgeToken;
  if ((config.voice.enabled && config.voice.serverSecret) || livekitBridgeWanted) {
    const { VoiceAdapter } = await import("./channels/voice/voice-adapter.js");
    voiceAdapter = new VoiceAdapter(
      config.voice.port,
      config.voice.serverSecret,
      config.voice.bridgeToken,
      agentRegistry,
      memoryManager,
      agentManager,
      dispatcher, // KPR-223
      config.voice.bindHost,
    );
    await voiceAdapter.start();
    log.info("Voice adapter started", { port: config.voice.port, livekitBridge: livekitBridgeWanted });
  }
```

(Match the existing local variable names at the call site — `agentRegistry`/`memoryManager` per `index.ts:703-709`.)

- [ ] **Step 6:** Tests. Add to `voice-adapter.test.ts` a `describe("E1 bridge auth (KPR-322)")` block implementing Testing-Contract E1 assertions 1–6 via the file's existing `makeReq`/mock-res helpers (bearer header variants × body shapes: worker-shape `{ stream, messages, call: { id, metadata: { hive_agent_id } } }` with NO `assistant`; Vapi-shape with `assistant.metadata.hive_agent_id`). Add to `voice-adapter.integration.test.ts` an over-the-wire case for assertion 7:

```typescript
  it("binds loopback by default and accepts bridge-token requests without VAPI secret (KPR-322 E1)", async () => {
    // makeAdapter extended: serverSecret "", bridgeToken "tok-1", bindHost default.
    const { server, port } = await startAdapter({ serverSecret: "", bridgeToken: "tok-1" });
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    const res = await postChat(port, {
      headers: { authorization: "Bearer tok-1" },
      body: {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        call: { id: "call-abc", metadata: { hive_agent_id: "test-agent" } },
      },
    });
    expect(res.statusCode).toBe(200); // spawn ran via the mock AgentManager
  });
```

Plus the negative twin: same request with `authorization: "Bearer wrong"` → 401; and a Vapi-shape request with `Bearer no-credentials-provided` + `serverSecret: "vapi-secret"` → 200 (fall-through preserved).

- [ ] **Step 7:** Verify — `npx vitest run src/channels/voice` green (including all pre-existing suites, byte-identical Vapi expectations untouched); `npm run typecheck` green.
- [ ] **Step 8:** Commit — `git commit -m "feat(kpr-322): E1 bridge bearer auth + serverSecret carve-out + loopback bind"`

### Task 3 — E2: abort in-flight spawn on client disconnect (barge-in lock release)

**Files:**
- Modify: `src/agents/agent-manager.ts` (new public method near `stopAgent`, `:1304`)
- Modify: `src/channels/voice/voice-adapter.ts` (`spawnTurnViaAgentManager`, `:225-433`)
- Test: `src/agents/agent-manager.test.ts`, `src/channels/voice/voice-adapter.integration.test.ts`

- [ ] **Step 1:** `AgentManager.abortThread` (place directly above `stopAgent`):

```typescript
  /**
   * KPR-322 E2: abort the in-flight spawn for one thread. Voice barge-in —
   * the adapter calls this when the bridge's/Vapi's HTTP socket closes
   * before the turn completes; without it the per-thread lock
   * (`agentId:threadId`) keeps the caller's post-interruption turn queued
   * behind the abandoned one (25ms wait loop, withSpawnTicket). Only the
   * ticket-holding (running) spawn is aborted — lock-waiters hold no ticket.
   * Returns true if a matching in-flight ticket was aborted.
   */
  abortThread(agentId: string, threadId: string): boolean {
    const threadKey = `${agentId}:${threadId}`;
    const tickets = this.activeTickets.get(agentId);
    if (!tickets) return false;
    let aborted = false;
    for (const ticket of tickets) {
      if (ticket.threadKey === threadKey) {
        ticket.abort();
        aborted = true;
      }
    }
    if (aborted) {
      log.info("Aborted in-flight spawn for thread", { agentId, threadId });
    }
    return aborted;
  }
```

- [ ] **Step 2:** Adapter wiring in `spawnTurnViaAgentManager`. Insert after `const onStream ...` / before `const ctx: TurnContext = {` (around `voice-adapter.ts:290`):

```typescript
    // KPR-322 E2: abort the in-flight spawn when the client disconnects
    // pre-completion (LiveKit barge-in cancels the bridge's HTTP request;
    // a Vapi hang-up benefits identically). `close` also fires after a
    // normal `end()` — `writableEnded` distinguishes premature closes.
    // All later response writes are suppressed via `clientGone`.
    let clientGone = false;
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      const abortedInFlight = agentManager.abortThread(agentId, threadId);
      log.info("Voice client disconnected mid-turn", { callId, agentId, abortedInFlight });
    });
```

and guard the stream callback's first line (`voice-adapter.ts:277`):

```typescript
          if (!chunk || clientGone) return;
```

- [ ] **Step 3:** Suppress spawn/retry/writes for a gone client. Immediately before `let outcome = await runOnce(ctx);` add:

```typescript
    if (clientGone) {
      log.info("Voice turn skipped — client disconnected before spawn", { callId, agentId });
      return;
    }
```

Change the outer-retry condition (`voice-adapter.ts:337`) to include `!clientGone`:

```typescript
    if (!outcome.ok && !outcome.circuitOpen && effectiveResume && !outcome.bytesSent && !clientGone) {
```

And immediately after the retry block (before `if (!outcome.ok) {`):

```typescript
    // E2: never write into a dead socket — the turn (aborted or completed)
    // ends silently; next turn's resume either works or trips the outer
    // full-transcript retry (recoverable by construction, spec §7).
    if (clientGone) {
      log.info("Voice turn ended after client disconnect — response suppressed", {
        callId,
        agentId,
        ok: outcome.ok,
        aborted: outcome.ok ? (outcome.result.aborted ?? false) : undefined,
      });
      return;
    }
```

- [ ] **Step 4:** `agent-manager.test.ts` — new describe (reuse the file's `makeRunResult`/`makeWorkItem` helpers; add `makeVoiceCtx` mirroring `makeSmsCtx` with `channel: "voice"`, `threadId: "voice:call-1"`):

```typescript
describe("abortThread (KPR-322 E2)", () => {
  it("aborts the ticket-holding spawn so the queued same-thread turn proceeds", async () => {
    mockConversationIndex.mockResolvedValue(undefined);
    // Zombie voice turn: hangs until abort fires (emulates generation into a dead socket).
    let releaseFirst!: (r: ReturnType<typeof makeRunResult>) => void;
    mockRunnerSend.mockReturnValueOnce(new Promise((resolve) => { releaseFirst = resolve; }));
    mockRunnerAbort.mockImplementationOnce(() => releaseFirst(makeRunResult({ aborted: true })));

    const first = manager.spawnTurn(makeVoiceCtx({ agentId: "agent-a" }));
    await vi.waitFor(() => expect(mockRunnerSend).toHaveBeenCalledTimes(1));

    // Post-interruption turn on the SAME thread: queues on the per-thread lock.
    mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "post-interruption reply" }));
    const second = manager.spawnTurn(makeVoiceCtx({ agentId: "agent-a" }));
    await new Promise((r) => setTimeout(r, 80)); // > 3 lock-wait cycles
    expect(mockRunnerSend).toHaveBeenCalledTimes(1); // hazard: still queued

    expect(manager.abortThread("agent-a", "voice:call-1")).toBe(true);
    const [turn1, turn2] = await Promise.all([first, second]);
    expect(turn1.aborted).toBe(true);
    expect(turn2.finalMessage).toBe("post-interruption reply");
  });

  it("returns false when nothing is in flight for the thread", () => {
    expect(manager.abortThread("agent-a", "voice:none")).toBe(false);
  });

  it("does not abort a different thread of the same agent", async () => {
    mockConversationIndex.mockResolvedValue(undefined);
    let release!: (r: ReturnType<typeof makeRunResult>) => void;
    mockRunnerSend.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const inflight = manager.spawnTurn(makeVoiceCtx({ agentId: "agent-a" })); // voice:call-1
    await vi.waitFor(() => expect(mockRunnerSend).toHaveBeenCalledTimes(1));
    expect(manager.abortThread("agent-a", "voice:call-2")).toBe(false);
    expect(mockRunnerAbort).not.toHaveBeenCalled();
    release(makeRunResult());
    await inflight;
  });
});
```

- [ ] **Step 5:** `voice-adapter.integration.test.ts` — extend the mock AgentManager with `abortThread: vi.fn()` and add:

```typescript
  it("aborts the in-flight spawn and suppresses writes when the client disconnects mid-stream (KPR-322 E2)", async () => {
    // spawn streams one chunk then hangs until abortThread is called.
    let sawAbort!: () => void;
    const abortSignal = new Promise<void>((r) => { sawAbort = r; });
    const abortThread = vi.fn((agentId: string, threadId: string) => { sawAbort(); return true; });
    const { port, spawnFinished } = await startAdapterWithHangingSpawn({ abortThread });

    const req = beginStreamingChat(port, workerShapedBody("call-e2"));
    await req.firstChunk(); // headers + first SSE delta arrived
    req.destroySocket();    // premature close — no end()

    await abortSignal;
    expect(abortThread).toHaveBeenCalledWith("test-agent", "voice:call-e2");
    await spawnFinished;    // adapter returned without throwing / writing after close
  });

  it("does not call abortThread on normal completion", async () => {
    const abortThread = vi.fn();
    const { port } = await startAdapter({ abortThread });
    const res = await postChat(port, workerShapedBody("call-ok"));
    expect(res.statusCode).toBe(200);
    expect(abortThread).not.toHaveBeenCalled();
  });
```

(`startAdapterWithHangingSpawn`/`beginStreamingChat` are small helpers in the same file following its existing `makeAdapter`/request-builder idiom: the spawn stub invokes `onStream("first ")` then awaits a promise the `abortThread` mock resolves — this encodes "the abort is what unblocks the zombie".)

- [ ] **Step 6:** Verify — `npx vitest run src/agents/agent-manager.test.ts src/channels/voice` all green (pre-existing suites untouched).
- [ ] **Step 7:** **Negative-verify (CI-side):** run the Verification-Rules stash protocol; record the two failing outputs, then `git stash pop` and confirm green again.
- [ ] **Step 8:** Commit — `git commit -m "fix(kpr-322): E2 abort in-flight voice spawn on client disconnect (barge-in lock release)"`

### Task 4 — E4 (optional, severable): `voice_call` LiveKit-variant MCP tool

> Severable per spec §12: delivery may move this whole task to KPR-325 without touching any other task. If severed, skip and note in lane notes.

**Files:**
- Create: `src/voice/livekit-voice-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (registration beside the Vapi block `:552-570`; min-js map `:245`)
- Modify: `build/bundle.ts` (entry map, beside `:91`)
- Test: `src/voice/livekit-voice-mcp-server.test.ts` (payload-builder unit test)

- [ ] **Step 1:** Server (stdio, tier-2 vendor pattern; exact same `to`/`goal`/`context` schema as `voice-mcp-server.ts:53-64`):

```typescript
#!/usr/bin/env node
/**
 * LiveKit Voice MCP Server (KPR-322 E4) — initiate outbound calls on the
 * LiveKit pipeline. Creates an agent dispatch consumed by the hive-voice
 * worker (src/voice-worker/), which places the SIP call and bridges the
 * conversation back to this hive's spawn path.
 *
 * Env (set by agent-runner):
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET — LiveKit Cloud project
 *   AGENT_ID, AGENT_NAME — calling agent identity
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentDispatchClient } from "livekit-server-sdk";

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const AGENT_NAME = process.env.AGENT_NAME ?? "";

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  process.stderr.write("livekit-voice-mcp-server: LIVEKIT_URL/API_KEY/API_SECRET are required\n");
  process.exit(1);
}

/** Exported for unit tests — pure dispatch-payload builder. */
export function buildDispatchArgs(input: { to: string; goal: string; context?: string }): {
  roomName: string;
  agentName: string;
  metadata: string;
} {
  return {
    roomName: `call-${randomUUID()}`,
    agentName: "hive-voice",
    metadata: JSON.stringify({
      hive_agent_id: AGENT_ID,
      agent_name: AGENT_NAME,
      to: input.to,
      goal: input.goal,
      context: input.context ?? "",
    }),
  };
}

const server = new McpServer({ name: "voice-livekit", version: "1.0.0" });

server.tool(
  "voice_call",
  "Initiate an outbound phone call (LiveKit pipeline). You (the agent) will be the voice on the call — " +
    "speech-to-text and text-to-speech run in the call worker while you author every conversational turn. " +
    "Provide a clear goal describing what you want to accomplish on the call.",
  {
    to: z.string().describe("Recipient phone number in E.164 format (e.g., +14155551234)"),
    goal: z
      .string()
      .describe("What you want to accomplish on this call — this is injected into your system prompt during the call"),
    context: z.string().optional().describe("Additional context for the call (order details, vendor history, etc.)"),
  },
  async ({ to, goal, context }) => {
    try {
      const args = buildDispatchArgs({ to, goal, context });
      const client = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      const dispatch = await client.createDispatch(args.roomName, args.agentName, { metadata: args.metadata });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Call dispatch created.",
              `Call ID: ${args.roomName}`,
              `Dispatch: ${dispatch.id}`,
              `To: ${to}`,
              "",
              "The voice worker is placing the call now.",
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to dispatch call: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

(Match the file tail — `server.connect` idiom — to `voice-mcp-server.ts`'s exact bottom lines.)

- [ ] **Step 2:** Registration in `agent-runner.ts`, directly after the Vapi voice block (`:552-570`):

```typescript
    // LiveKit voice MCP server (KPR-322 E4) — outbound calls via the
    // hive-voice worker. Gated on the livekit section + API pair; server
    // key name "voice-livekit" so agents can carry either/both.
    if (config.voice.livekit.enabled && config.voice.livekitApiKey && config.voice.livekitApiSecret) {
      servers["voice-livekit"] = {
        type: "stdio",
        command: "node",
        args: [mcpPath("voice/livekit-voice-mcp-server.js")],
        env: {
          LIVEKIT_URL: config.voice.livekit.url,
          LIVEKIT_API_KEY: config.voice.livekitApiKey,
          LIVEKIT_API_SECRET: config.voice.livekitApiSecret,
          AGENT_ID: this.agentConfig.id,
          AGENT_NAME: this.agentConfig.name,
        },
      };
    }
```

Add to the min-js path map (`agent-runner.ts:245`): `"voice/livekit-voice-mcp-server.js": "voice-livekit.min.js",` and to `build/bundle.ts` beside `:91`: `"mcp/voice-livekit": "dist/voice/livekit-voice-mcp-server.js",` (confirm the entry-key ↔ min-js naming convention against the existing `mcp/voice` pair and keep it consistent).

- [ ] **Step 3:** Unit test `src/voice/livekit-voice-mcp-server.test.ts`: `buildDispatchArgs` returns `call-`-prefixed room, `agentName: "hive-voice"`, metadata JSON round-trips `{hive_agent_id, to, goal, context}` and defaults `context` to `""`. (No live client call — constructor-only import risk is covered by the Task 5 dep smoke test.)
- [ ] **Step 4:** Verify — `npx vitest run src/voice` green; `npm run check:bundle` green (proves engine bundle + stdio bundle gates absorb the new entry).
- [ ] **Step 5:** Commit — `git commit -m "feat(kpr-322): E4 voice_call LiveKit dispatch MCP tool (severable)"`

### Task 5 — Worker: dependencies, config, skeleton

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/voice-worker/worker-config.ts`
- Create: `src/voice-worker/cells.ts`
- Create: `src/voice-worker/main.ts` (skeleton; session orchestration lands in Task 7)
- Test: `src/voice-worker/cells.test.ts`, `src/voice-worker/deps.smoke.test.ts`

- [ ] **Step 1:** `npm install --save @livekit/agents @livekit/agents-plugin-deepgram @livekit/agents-plugin-cartesia @livekit/agents-plugin-elevenlabs @livekit/agents-plugin-silero @livekit/rtc-node livekit-server-sdk` — **pin the exact versions recorded at Task 0** (1.5.x line). Engine bundle unaffected (no engine imports); confirm with `npm run check:bundle` at Step 6.
- [ ] **Step 2:** `src/voice-worker/worker-config.ts` — reuse the engine loader (S4/§3):

```typescript
/**
 * Voice-worker configuration (KPR-322). Reuses the engine's config loader —
 * hive.yaml + .env + Honeypot (env-first, Keychain-second) — so the worker
 * resolves vendor keys exactly the way the engine does. Cloud-model agents
 * never see these values; they live in this worker process only.
 */
import { config, resolveSecretEnv } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("voice-worker-config");

export interface WorkerConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sipTrunkId: string;
  inboundAgents: Record<string, string>;
  defaultStt: string;
  defaultTts: string;
  deepgramApiKey: string;
  cartesiaApiKey: string;
  elevenlabsApiKey: string;
  bridgeToken: string;
  bridgeUrl: string; // http://127.0.0.1:<voice.port>/v1/chat/completions
  mongoUri: string;
  mongoDbName: string;
}

export function loadWorkerConfig(): WorkerConfig {
  const lk = config.voice.livekit;
  if (!lk.enabled) throw new Error("voice.livekit.enabled is false — voice worker refusing to start");
  const wc: WorkerConfig = {
    livekitUrl: lk.url,
    livekitApiKey: config.voice.livekitApiKey,
    livekitApiSecret: config.voice.livekitApiSecret,
    sipTrunkId: lk.sipTrunkId,
    inboundAgents: lk.inboundAgents,
    defaultStt: lk.defaultStt,
    defaultTts: lk.defaultTts,
    deepgramApiKey: resolveSecretEnv("DEEPGRAM_API_KEY"),
    cartesiaApiKey: resolveSecretEnv("CARTESIA_API_KEY"),
    elevenlabsApiKey: resolveSecretEnv("ELEVENLABS_API_KEY"),
    bridgeToken: config.voice.bridgeToken,
    bridgeUrl: `http://127.0.0.1:${config.voice.port}/v1/chat/completions`,
    mongoUri: config.mongo.uri,
    mongoDbName: config.mongo.dbName,
  };
  for (const [k, v] of Object.entries({
    livekitUrl: wc.livekitUrl,
    livekitApiKey: wc.livekitApiKey,
    livekitApiSecret: wc.livekitApiSecret,
    deepgramApiKey: wc.deepgramApiKey,
    bridgeToken: wc.bridgeToken,
  })) {
    if (!v) throw new Error(`voice worker missing required config: ${k}`);
  }
  // TTS keys are per-cell: require at boot only the default cell's key; the
  // other vendor's absence downgrades that A/B cell with a warning.
  if (wc.defaultTts.startsWith("cartesia/") && !wc.cartesiaApiKey) throw new Error("CARTESIA_API_KEY missing for default TTS cell");
  if (wc.defaultTts.startsWith("elevenlabs/") && !wc.elevenlabsApiKey) throw new Error("ELEVENLABS_API_KEY missing for default TTS cell");
  if (!wc.cartesiaApiKey || !wc.elevenlabsApiKey) log.warn("One TTS vendor key missing — that A/B cell unavailable");
  return wc;
}
```

(Adjust `config.mongo.uri/dbName` accessors to the engine config's exact field names — used verbatim by `contacts` server env at `agent-runner.ts:577-579`.)

- [ ] **Step 3:** `src/voice-worker/cells.ts` — pure cell resolver (S7; the four §14.1 cells):

```typescript
/** A/B cell identifiers (spec §14.1). Import-free — unit-testable without LiveKit. */
export interface VendorCell {
  stt: "deepgram/flux-general-en" | "deepgram/nova-3";
  tts: "cartesia/sonic-3" | "elevenlabs/eleven_flash_v2_5";
}

const STT_VALUES = new Set(["deepgram/flux-general-en", "deepgram/nova-3"]);
const TTS_VALUES = new Set(["cartesia/sonic-3", "elevenlabs/eleven_flash_v2_5"]);

/**
 * Resolve the vendor cell for a call: dispatch-metadata override first
 * (experiment variable, per-call pin), config defaults second. Unknown
 * values throw — a mistyped cell must fail the dispatch loudly, not
 * silently fall back and contaminate an A/B run.
 */
export function resolveCell(
  meta: { stt?: string; tts?: string },
  defaults: { defaultStt: string; defaultTts: string },
): VendorCell {
  const stt = meta.stt ?? defaults.defaultStt;
  const tts = meta.tts ?? defaults.defaultTts;
  if (!STT_VALUES.has(stt)) throw new Error(`Unknown STT cell: ${stt}`);
  if (!TTS_VALUES.has(tts)) throw new Error(`Unknown TTS cell: ${tts}`);
  return { stt, tts } as VendorCell;
}
```

- [ ] **Step 4:** `src/voice-worker/main.ts` skeleton (⚠ Task-0 pin banner — exact agents-js entry/CLI signatures adjusted mechanically against the pinned version's typings):

```typescript
/**
 * hive-voice worker entry (KPR-322). Explicit dispatch only
 * (agentName: "hive-voice") — no auto-dispatch. Outbound: dispatch metadata
 * carries { hive_agent_id, to, goal, context, stt?, tts? }; the worker
 * creates the SIP participant and runs the call. Inbound: dispatch rule
 * (SIP-3) spawns a job; agent resolves from voice.livekit.inboundAgents.
 *
 * NOTE (Task-0 pin): class/function names below follow agents-js 1.5.x docs;
 * exact import shapes are pinned at Task 0 and adjusted mechanically.
 */
import { defineAgent, cli, WorkerOptions, type JobContext } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logging/logger.js";
import { loadWorkerConfig } from "./worker-config.js";
import { resolveCell } from "./cells.js";
import { runCallSession } from "./session.js"; // Task 7

const log = createLogger("voice-worker");

export interface DispatchMetadata {
  hive_agent_id?: string;
  agent_name?: string;
  to?: string;
  goal?: string;
  context?: string;
  stt?: string;
  tts?: string;
}

export function parseDispatchMetadata(raw: string | undefined): DispatchMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DispatchMetadata) : {};
  } catch {
    return {};
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const wc = loadWorkerConfig();
    const meta = parseDispatchMetadata(ctx.job.metadata);
    const cell = resolveCell(meta, wc);
    await runCallSession(ctx, wc, meta, cell); // Task 7 owns the whole call
  },
});

// Only run the CLI when executed directly (KPR-183 shim-guard lesson: this
// file is never imported by the engine bundle, but keep the guard anyway).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: "hive-voice" }));
}
```

- [ ] **Step 5:** Tests — `cells.test.ts`: all four cells resolvable via override; defaults applied when metadata absent; unknown stt/tts throws. `deps.smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
describe("livekit deps load on this platform (KPR-322)", () => {
  it("imports @livekit/agents and livekit-server-sdk", async () => {
    const agents = await import("@livekit/agents");
    const sdk = await import("livekit-server-sdk");
    expect(agents.defineAgent).toBeTypeOf("function");
    expect(sdk.SipClient).toBeTypeOf("function");
  });
});
```

If this fails on the CI runner (native prebuild missing), report as a concrete blocker — do not skip.

- [ ] **Step 6:** Verify — `npx vitest run src/voice-worker` green; `npm run typecheck` green; `npm run check:bundle` green (engine bundle untouched by worker deps).
- [ ] **Step 7:** Commit — `git commit -m "feat(kpr-322): voice worker deps, config, cells, entry skeleton"`

### Task 6 — Bridge core: `HiveLLM` + pure modules

**Files:**
- Create: `src/voice-worker/sse.ts` (import-free), `src/voice-worker/chat-ctx.ts` (import-free types), `src/voice-worker/interruption-marker.ts`, `src/voice-worker/tts-normalize.ts`, `src/voice-worker/error-map.ts`, `src/voice-worker/hive-llm.ts`
- Test: `src/voice-worker/sse.test.ts`, `chat-ctx.test.ts`, `interruption-marker.test.ts`, `tts-normalize.test.ts`, `error-map.test.ts`, `hive-llm.test.ts` (stub SSE engine server)

- [ ] **Step 1:** `src/voice-worker/sse.ts` — incremental OpenAI-SSE parser (handles frames split across network chunks; engine frame shapes per `openai-translator.ts:129-199`):

```typescript
/** Incremental OpenAI-compatible SSE parser (KPR-322 §5.4). Import-free. */
export type SSEEvent =
  | { kind: "content"; text: string }
  | { kind: "done"; finishReason: string | null };

export class SSEParser {
  private buffer = "";

  /** Feed one network chunk; returns zero or more complete events, in order. */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          events.push({ kind: "done", finishReason: null });
          continue;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const choice = parsed.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === "string" && text.length > 0) {
            events.push({ kind: "content", text });
          } else if (choice?.finish_reason) {
            events.push({ kind: "done", finishReason: choice.finish_reason });
          }
        } catch {
          // Malformed frame: skip — the engine only emits well-formed frames;
          // a truncated tail stays in the buffer until its terminator arrives.
        }
      }
    }
    return events;
  }
}
```

- [ ] **Step 2:** `src/voice-worker/chat-ctx.ts` — full-transcript serialization (§5.2 load-bearing: complete history EVERY turn; system never sent — engine owns the prompt, §5.3):

```typescript
/** OpenAI-shape message for the bridge request body. Import-free. */
export interface BridgeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Serialize the session transcript to the bridge messages array.
 * Full transcript every turn — the engine's outer retry re-renders the
 * ENTIRE array when a stale SDK session fails; a delta-only sender would
 * break crash recovery (§5.2). No system message: the engine drops them
 * (conversation-prompt.ts) and owns prompt authority (§5.3).
 */
export function serializeTranscript(turns: TranscriptTurn[]): BridgeMessage[] {
  return turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.text }));
}
```

- [ ] **Step 3:** `src/voice-worker/interruption-marker.ts` (§7 v1 mitigation; ⚠ wording delivery-tunable):

```typescript
/** Spoken-prefix tail marker after a barge-in (KPR-322 §7). Import-free. */
const TAIL_WORDS = 15;

export function buildInterruptionMarker(spokenText: string): string {
  const words = spokenText.trim().split(/\s+/).filter(Boolean);
  const tail = words.slice(-TAIL_WORDS).join(" ");
  return `[caller interrupted you mid-sentence; they heard your reply only up to: "…${tail}"]`;
}

/**
 * Prefix the next user message when the PREVIOUS agent turn was interrupted.
 * Flows through the engine's extractLatestUserMessage unchanged — zero
 * engine cost.
 */
export function applyInterruptionMarker(userText: string, interruptedSpokenText: string | null): string {
  if (!interruptedSpokenText) return userText;
  return `${buildInterruptionMarker(interruptedSpokenText)} ${userText}`;
}
```

- [ ] **Step 4:** `src/voice-worker/tts-normalize.ts` (§5.1 defensive filter; ⚠ verify plugin-native handling at PoC):

```typescript
/** Light TTS text normalization — strip markdown residue (KPR-322 §5.1). Import-free. */
export function normalizeForTTS(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1") // [label](url) → label
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2") // emphasis
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // inline/backtick code
    .replace(/^#{1,6}\s+/gm, ""); // headings
}
```

- [ ] **Step 5:** `src/voice-worker/error-map.ts` — the §8 rows as data (worker column):

```typescript
/** Bridge failure taxonomy → worker behavior (spec §8 rows). Import-free. */
export type BridgeFailureClass =
  | "budget_saturated" // engine 503 "Voice temporarily unavailable"
  | "engine_auth" // engine 503 "Voice unavailable" (OAuth)
  | "bridge_auth" // 401/400 from E1 — misconfig, won't heal in-call
  | "spawn_failed" // engine 500 (its own outer retry already ran)
  | "engine_unreachable" // ECONNREFUSED / socket error before response
  | "midstream_error"; // SSE error close after first byte

export interface FailureBehavior {
  retryOnce: boolean;
  retryDelayMs: number;
  /** Key into FALLBACK_LINES (static, never LLM-generated). */
  speak: "hold_on" | "apologize_end" | "canned_engine_down" | "none";
  endCall: boolean;
  telemetryOutcome: string;
}

export const FAILURE_BEHAVIOR: Record<BridgeFailureClass, FailureBehavior> = {
  budget_saturated: { retryOnce: true, retryDelayMs: 2000, speak: "hold_on", endCall: false, telemetryOutcome: "budget_saturated" },
  engine_auth: { retryOnce: false, retryDelayMs: 0, speak: "apologize_end", endCall: true, telemetryOutcome: "engine_auth_failed" },
  bridge_auth: { retryOnce: false, retryDelayMs: 0, speak: "apologize_end", endCall: true, telemetryOutcome: "bridge_auth_failed" },
  spawn_failed: { retryOnce: true, retryDelayMs: 0, speak: "none", endCall: false, telemetryOutcome: "spawn_failed" },
  engine_unreachable: { retryOnce: false, retryDelayMs: 0, speak: "canned_engine_down", endCall: true, telemetryOutcome: "engine_unreachable" },
  midstream_error: { retryOnce: false, retryDelayMs: 0, speak: "none", endCall: false, telemetryOutcome: "midstream_error" },
};

/** Static fallback lines — they exist precisely for when the LLM path is broken. */
export const FALLBACK_LINES = {
  hold_on: "Sorry — give me one second.",
  apologize_end: "I'm sorry, I'm having technical trouble on my end. Let me call you back shortly. Goodbye.",
  canned_engine_down: "I'm sorry, I can't continue this call right now. We'll call you back shortly. Goodbye.",
} as const;

export function classifyHttpFailure(status: number, bodySnippet: string): BridgeFailureClass {
  if (status === 401 || status === 400) return "bridge_auth";
  if (status === 503) {
    return bodySnippet.includes("temporarily") ? "budget_saturated" : "engine_auth";
  }
  return "spawn_failed";
}
```

Escalation composition (documented behavior, asserted in Task 7 tests): `budget_saturated` retry that fails again → speak `apologize_end`, end call; `spawn_failed` retry that fails again → same. Circuit-open is NOT here — the engine speaks it as a normal 200 completion (§8 row 1; zero worker code).

- [ ] **Step 6:** `src/voice-worker/hive-llm.ts` — the bridge class (⚠ Task-0 pin banner as in Task 5; base-class method names adjusted mechanically):

```typescript
/**
 * HiveLLM (KPR-322 §5) — custom llm.LLM that makes hive's spawn path the
 * pipeline's LLM node. POSTs each turn to the engine's OpenAI-compatible
 * voice endpoint (SSE) and yields ChatChunks per text delta. Never buffers
 * (§5.4 — buffering kills the stream). Aborts the HTTP request the moment
 * the framework cancels the stream (§7).
 *
 * NOTE (Task-0 pin): subclass surface follows agents-js 1.5.x (`llm.LLM` /
 * `llm.LLMStream`); exact signatures pinned at Task 0. Fallback shape if
 * subclassing regresses: llmNode override returning ReadableStream<ChatChunk>.
 */
import { llm } from "@livekit/agents";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import { SSEParser } from "./sse.js";
import { serializeTranscript, type BridgeMessage } from "./chat-ctx.js";
import { applyInterruptionMarker } from "./interruption-marker.js";
import { classifyHttpFailure, type BridgeFailureClass } from "./error-map.js";

const log = createLogger("hive-llm");

export class BridgeError extends Error {
  constructor(
    public readonly failureClass: BridgeFailureClass,
    message: string,
    /** True when at least one content chunk was already yielded (mid-stream). */
    public readonly bytesReceived: boolean,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface HiveLLMOptions {
  bridgeUrl: string;
  bridgeToken: string;
  hiveAgentId: string;
  callId: string; // = LiveKit room name, `call-<uuid>`
  goal: string;
  context: string;
}

export class HiveLLM extends llm.LLM {
  /** Set by the session layer when the previous agent turn was interrupted. */
  interruptedSpokenText: string | null = null;
  /** Per-turn bridge timing for §13 telemetry (read by the session layer). */
  lastTurnTiming: { llmTtftMs: number; maxInterChunkGapMs: number } | null = null;

  constructor(private readonly opts: HiveLLMOptions) {
    super();
  }

  chat(chatOpts: { chatCtx: llm.ChatContext }): HiveLLMStream {
    return new HiveLLMStream(this, this.opts, chatOpts.chatCtx);
  }
}

export class HiveLLMStream extends llm.LLMStream {
  constructor(
    private readonly parent: HiveLLM,
    private readonly opts: HiveLLMOptions,
    chatCtx: llm.ChatContext,
  ) {
    super(parent, { chatCtx });
    void this.run(chatCtx);
  }

  private toBridgeMessages(chatCtx: llm.ChatContext): BridgeMessage[] {
    // ChatContext → full transcript (§5.2). Task-0 pin: item/text accessors.
    const turns = chatCtx.items
      .filter((i) => i.type === "message" && (i.role === "user" || i.role === "assistant"))
      .map((i) => ({ role: i.role as "user" | "assistant", text: i.textContent ?? "" }));
    const msgs = serializeTranscript(turns);
    // §7: interruption marker prefixes the LATEST user message only.
    if (this.parent.interruptedSpokenText && msgs.length > 0) {
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (msgs[k]!.role === "user") {
          msgs[k]!.content = applyInterruptionMarker(msgs[k]!.content, this.parent.interruptedSpokenText);
          break;
        }
      }
      this.parent.interruptedSpokenText = null; // consumed
    }
    return msgs;
  }

  private async run(chatCtx: llm.ChatContext): Promise<void> {
    const controller = new AbortController();
    // §7: framework cancels the stream (barge-in) → abort the HTTP request.
    this.abortController?.signal.addEventListener("abort", () => controller.abort()); // Task-0 pin: cancellation hook name
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let lastChunkAt = 0;
    let maxGapMs = 0;
    let yielded = false;
    try {
      const res = await fetch(this.opts.bridgeUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.bridgeToken}`,
        },
        body: JSON.stringify({
          stream: true,
          messages: this.toBridgeMessages(chatCtx),
          call: {
            id: this.opts.callId,
            metadata: {
              hive_agent_id: this.opts.hiveAgentId,
              goal: this.opts.goal,
              context: this.opts.context,
            },
          },
        }),
      });
      if (!res.ok || !res.body) {
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        throw new BridgeError(classifyHttpFailure(res.status, snippet), `bridge HTTP ${res.status}: ${snippet}`, false);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SSEParser();
      const requestId = `hive-${randomUUID()}`;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.kind === "content") {
            const now = Date.now();
            if (!firstTokenAt) firstTokenAt = now;
            if (lastChunkAt) maxGapMs = Math.max(maxGapMs, now - lastChunkAt);
            lastChunkAt = now;
            yielded = true;
            // Yield immediately — NEVER buffer (§5.4).
            this.queue.put({ id: requestId, delta: { role: "assistant", content: ev.text } });
          } else {
            // done frame: [DONE] follows; loop ends when the body closes.
          }
        }
      }
      // Degenerate zero-content turn (§5.1): stream ends empty — no-reply,
      // the session synthesizes nothing.
    } catch (err) {
      if (controller.signal.aborted) {
        log.info("Bridge request aborted (barge-in)", { callId: this.opts.callId });
        return; // cancelled turn — not an error
      }
      if (err instanceof BridgeError) throw err;
      const failureClass: BridgeFailureClass = yielded ? "midstream_error" : "engine_unreachable";
      throw new BridgeError(failureClass, String(err), yielded);
    } finally {
      this.parent.lastTurnTiming = {
        llmTtftMs: firstTokenAt ? firstTokenAt - startedAt : -1,
        maxInterChunkGapMs: maxGapMs,
      };
      this.queue.close(); // Task-0 pin: stream-close idiom
    }
  }
}
```

- [ ] **Step 7:** Tests. Pure modules (`sse/chat-ctx/marker/normalize/error-map`) per the Testing-Contract minimum assertions — include the split-frame SSE case (`push('data: {"choices":[{"del')` then the rest) and the `formatSSEDone` double-frame shape (`data: {...finish_reason:"stop"}\n\ndata: [DONE]\n\n` → exactly one `done` per frame). `hive-llm.test.ts` — stub engine (`node:http` on port 0) that: (a) serves 3 deltas + DONE → stream yields 3 chunks in order, `lastTurnTiming.llmTtftMs >= 0`; (b) sleeps between delta 1 and 2 → `maxInterChunkGapMs > 0`; (c) returns 503 "Voice temporarily unavailable" → `BridgeError` `budget_saturated`; (d) 401 → `bridge_auth`; (e) connection refused (closed port) → `engine_unreachable`; (f) destroys socket after delta 1 → `midstream_error` with `bytesReceived: true`; (g) abort mid-stream → stub server observes request teardown, no error thrown; (h) previous-turn interruption set → latest user message carries the marker prefix, earlier user messages untouched.
- [ ] **Step 8:** Verify — `npx vitest run src/voice-worker` green.
- [ ] **Step 9:** Commit — `git commit -m "feat(kpr-322): HiveLLM bridge — SSE→ChatChunks, abort propagation, error taxonomy"`

### Task 7 — Worker session orchestration + §8 error behaviors

**Files:**
- Create: `src/voice-worker/session.ts`
- Test: `src/voice-worker/session.test.ts` (pure decision helpers), behavior of the full session covered by P0/P1 (gated)

- [ ] **Step 1:** `src/voice-worker/session.ts` — builds the `AgentSession` for one call and owns call lifecycle (complete file; ⚠ Task-0 pin banner for plugin constructor options):

```typescript
/**
 * Per-call session orchestration (KPR-322 §3/§4/§7/§8).
 * - builds STT/TTS/VAD per vendor cell (S7)
 * - outbound: creates the SIP participant (waitUntilAnswered) then triggers
 *   the first generation (empty user transcript → engine's greet branch)
 * - barge-in bookkeeping: records the actually-spoken prefix for the
 *   next-turn interruption marker
 * - §8 failure rows via error-map (retry/speak/end-call)
 * NOTE (Task-0 pin): session event names + plugin option shapes pinned at
 * Task 0 against the installed 1.5.x typings.
 */
import { voice, llm } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { SipClient } from "livekit-server-sdk";
import type { JobContext } from "@livekit/agents";
import { createLogger } from "../logging/logger.js";
import { HiveLLM } from "./hive-llm.js";
import { BridgeError } from "./hive-llm.js";
import { FAILURE_BEHAVIOR, FALLBACK_LINES } from "./error-map.js";
import { normalizeForTTS } from "./tts-normalize.js";
import type { VendorCell } from "./cells.js";
import type { WorkerConfig } from "./worker-config.js";
import type { DispatchMetadata } from "./main.js";
import { TurnMetrics, CallStats } from "./telemetry.js"; // Task 8

const log = createLogger("voice-worker-session");

export function buildStt(cell: VendorCell, deepgramApiKey: string) {
  return cell.stt === "deepgram/flux-general-en"
    ? new deepgram.STTv2({ model: "flux-general-en", apiKey: deepgramApiKey })
    : new deepgram.STT({ model: "nova-3", apiKey: deepgramApiKey });
}

export function buildTts(cell: VendorCell, wc: WorkerConfig) {
  return cell.tts === "cartesia/sonic-3"
    ? new cartesia.TTS({ model: "sonic-3", apiKey: wc.cartesiaApiKey }) // stock voice per persona ⚠ pinned at PoC
    : new elevenlabs.TTS({ model: "eleven_flash_v2_5", apiKey: wc.elevenlabsApiKey });
}

/** Pure: inbound agent resolution (SIP-3). Exported for unit tests. */
export function resolveInboundAgent(
  calledNumber: string | undefined,
  inboundAgents: Record<string, string>,
): { agentId: string; goal: string; context: string } | null {
  if (!calledNumber) return null;
  const agentId = inboundAgents[calledNumber];
  if (!agentId) return null;
  return {
    agentId,
    goal: "Answer this inbound vendor callback professionally and help the caller.",
    context: "Inbound call to the DodiHome ops line (vendor callback).",
  };
}

export async function runCallSession(
  ctx: JobContext,
  wc: WorkerConfig,
  meta: DispatchMetadata,
  cell: VendorCell,
): Promise<void> {
  await ctx.connect();
  const callId = ctx.room.name; // `call-<uuid>` — bridge call.id (§6)
  const outbound = !!meta.to;

  let hiveAgentId = meta.hive_agent_id ?? "";
  let goal = meta.goal ?? "";
  let context = meta.context ?? "";
  if (!outbound) {
    // Inbound (S5): resolve from the E.164 → agent map. Called-number source:
    // SIP participant attributes (sip.trunkPhoneNumber ⚠ Task-0 pin).
    const called = await inboundCalledNumber(ctx); // helper below
    const resolved = resolveInboundAgent(called, wc.inboundAgents);
    if (!resolved) {
      log.error("Inbound call with no inboundAgents mapping — rejecting", { callId });
      ctx.shutdown();
      return;
    }
    ({ agentId: hiveAgentId, goal, context } = resolved);
  }

  const hiveLLM = new HiveLLM({
    bridgeUrl: wc.bridgeUrl,
    bridgeToken: wc.bridgeToken,
    hiveAgentId,
    callId,
    goal,
    context,
  });

  const vad = await silero.VAD.load(); // explicit VAD in BOTH cells (§7 — Flux turn detection ≠ interruption detection)
  const session = new voice.AgentSession({
    stt: buildStt(cell, wc.deepgramApiKey),
    tts: buildTts(cell, wc),
    vad,
    llm: hiveLLM,
    turnDetection: cell.stt === "deepgram/flux-general-en" ? "stt" : "vad", // Nova-3 cell: turn-detector plugin if Task-0 confirms; else VAD fallback (accepted caveat)
  });

  const stats = new CallStats(wc, { callId, agentId: hiveAgentId, cell, direction: outbound ? "outbound" : "inbound" });
  const metrics = new TurnMetrics(callId, cell, hiveLLM);
  metrics.attach(session); // LiveKit metrics events → per-turn JSONL (§13)

  // §7: record the actually-spoken prefix for the next-turn marker.
  session.on("agent_speech_interrupted", (ev: { spokenText?: string }) => {
    hiveLLM.interruptedSpokenText = ev.spokenText ?? "";
    stats.recordInterruption();
  });

  // §8 rows: BridgeError surfaces from the LLM node via session error events.
  session.on("error", async (err: unknown) => {
    const failure = err instanceof BridgeError ? err : null;
    if (!failure) {
      log.error("Session error (non-bridge)", { callId, error: String(err) });
      return;
    }
    const behavior = FAILURE_BEHAVIOR[failure.failureClass];
    stats.recordFailure(behavior.telemetryOutcome);
    if (behavior.retryOnce && !stats.retryConsumed(failure.failureClass)) {
      if (behavior.speak === "hold_on") await session.say(FALLBACK_LINES.hold_on);
      await new Promise((r) => setTimeout(r, behavior.retryDelayMs));
      session.generateReply(); // re-fire the turn once
      return;
    }
    if (behavior.speak !== "none") {
      const line = behavior.speak === "canned_engine_down" ? FALLBACK_LINES.canned_engine_down : FALLBACK_LINES.apologize_end;
      await session.say(line);
    }
    if (behavior.endCall || behavior.retryOnce /* second failure */) {
      await session.say(FALLBACK_LINES.apologize_end).catch(() => {});
      await stats.flush("failed");
      ctx.shutdown();
    }
  });

  const agent = new voice.Agent({
    // §5.3: intentionally unused — the ENGINE owns the prompt
    // (buildVoiceSystemPrompt via TurnContext.systemPromptOverride). Do not
    // "fix" agent behavior here.
    instructions: "Placeholder — hive owns the prompt server-side.",
  });
  await session.start({ agent, room: ctx.room, outputOptions: { transformText: normalizeForTTS } }); // ⚠ Task-0 pin: text-transform hook; if absent, wrap TTS node

  if (outbound) {
    const sip = new SipClient(wc.livekitUrl, wc.livekitApiKey, wc.livekitApiSecret);
    await sip.createSipParticipant(wc.sipTrunkId, meta.to!, ctx.room.name, {
      participantIdentity: `sip-${callId}`,
      waitUntilAnswered: true,
    });
    // First turn (§4): empty user transcript → engine's "caller has just
    // connected — greet them" branch. Matches Vapi behavior; no engine code.
    session.generateReply();
  }

  ctx.addShutdownCallback(async () => {
    await stats.flush("completed");
  });
}

async function inboundCalledNumber(ctx: JobContext): Promise<string | undefined> {
  for (const p of ctx.room.remoteParticipants.values()) {
    const attr = p.attributes?.["sip.trunkPhoneNumber"];
    if (attr) return attr;
  }
  return undefined;
}
```

- [ ] **Step 2:** `session.test.ts` — pure parts only (no LiveKit session construction): `resolveInboundAgent` (mapped number → agentId + generic vendor-callback goal/context; unmapped/undefined → null); failure-behavior composition table asserts every `BridgeFailureClass` maps to defined behavior and that `budget_saturated` is the only `hold_on`+retry row (mirrors §8 exactly).
- [ ] **Step 3:** Verify — `npx vitest run src/voice-worker` green; `npm run typecheck` green (this is where Task-0's pinned typings prove out mechanically).
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-322): voice worker session orchestration + §8 failure behaviors"`

### Task 8 — Worker telemetry: per-turn JSONL, heartbeat, per-call stats

**Files:**
- Create: `src/voice-worker/telemetry.ts`
- Test: `src/voice-worker/telemetry.test.ts`

- [ ] **Step 1:** `src/voice-worker/telemetry.ts` (§13 — **no transcript text, no phone numbers**; heartbeat mirrors `SpawnCoordinatorHeartbeat` at `src/agents/spawn-coordinator-heartbeat.ts`):

```typescript
/**
 * Voice-worker observability (KPR-322 §13). Three surfaces:
 *  1. per-turn JSONL log line (structured logger — callId only, no content)
 *  2. voice_worker_stats heartbeat upsert to db.telemetry every 30s
 *  3. voice_call_stats summary doc at call end (§14/§15 scoring substrate)
 */
import { MongoClient, type Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { HiveLLM } from "./hive-llm.js";
import type { VendorCell } from "./cells.js";
import type { WorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker-metrics");

export interface TurnMetricsLine {
  ts: string;
  callId: string;
  turnSeq: number;
  direction: "outbound" | "inbound";
  cell: VendorCell;
  eouDelayMs: number;
  llmTtftMs: number;
  maxInterChunkGapMs: number;
  ttsTtfbMs: number;
  totalToFirstAudioMs: number;
  interrupted: boolean;
  falseInterruption: boolean;
  errors: string[];
}

export class TurnMetrics {
  private turnSeq = 0;
  constructor(
    private readonly callId: string,
    private readonly cell: VendorCell,
    private readonly hiveLLM: HiveLLM,
    private readonly direction: "outbound" | "inbound" = "outbound",
  ) {}

  /** Wire LiveKit metrics events (EOU/LLM/TTS) — names pinned at Task 0. */
  attach(session: { on(ev: string, cb: (m: never) => void): unknown }): void {
    session.on("metrics_collected", (m) => this.onMetrics(m as Record<string, number | boolean | string>));
  }

  onMetrics(m: Record<string, number | boolean | string>): void {
    const bridge = this.hiveLLM.lastTurnTiming;
    const line: TurnMetricsLine = {
      ts: new Date().toISOString(),
      callId: this.callId,
      turnSeq: this.turnSeq++,
      direction: this.direction,
      cell: this.cell,
      eouDelayMs: Number(m.endOfUtteranceDelayMs ?? -1),
      llmTtftMs: bridge?.llmTtftMs ?? -1,
      maxInterChunkGapMs: bridge?.maxInterChunkGapMs ?? 0,
      ttsTtfbMs: Number(m.ttsTtfbMs ?? -1),
      totalToFirstAudioMs: Number(m.totalToFirstAudioMs ?? -1),
      interrupted: Boolean(m.interrupted ?? false),
      falseInterruption: Boolean(m.falseInterruption ?? false),
      errors: [],
    };
    log.info("voice turn metrics", { ...line, cell: `${this.cell.stt}+${this.cell.tts}` });
  }
}

export class VoiceWorkerHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "voice_worker_stats";
  private timer: NodeJS.Timeout | null = null;
  activeCalls = 0;
  callsStarted = 0;
  callsCompleted = 0;
  lastError: string | null = null;

  constructor(
    private readonly telemetry: Collection,
    private readonly cellDefaults: { defaultStt: string; defaultTts: string },
    private readonly intervalMs = VoiceWorkerHeartbeat.INTERVAL_MS,
  ) {}

  async writeOnce(): Promise<void> {
    await this.telemetry
      .updateOne(
        { kind: VoiceWorkerHeartbeat.TELEMETRY_KIND },
        {
          $set: {
            activeCalls: this.activeCalls,
            callsStarted: this.callsStarted,
            callsCompleted: this.callsCompleted,
            lastError: this.lastError,
            cellDefaults: this.cellDefaults,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      )
      .catch((err) => log.warn("voice-worker heartbeat write failed", { error: String(err) }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.writeOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export class CallStats {
  private interruptions = 0;
  private retries = 0;
  private consumedRetryClasses = new Set<string>();
  private failures: string[] = [];
  private startedAt = Date.now();
  private turnLatencies: number[] = [];

  constructor(
    private readonly wc: WorkerConfig,
    private readonly call: { callId: string; agentId: string; cell: VendorCell; direction: string },
  ) {}

  recordInterruption(): void {
    this.interruptions++;
  }
  recordTurnLatency(ms: number): void {
    this.turnLatencies.push(ms);
  }
  recordFailure(outcome: string): void {
    this.failures.push(outcome);
  }
  retryConsumed(failureClass: string): boolean {
    if (this.consumedRetryClasses.has(failureClass)) return true;
    this.consumedRetryClasses.add(failureClass);
    this.retries++;
    return false;
  }

  async flush(outcome: "completed" | "failed"): Promise<void> {
    const client = new MongoClient(this.wc.mongoUri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
      const sorted = [...this.turnLatencies].sort((a, b) => a - b);
      const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : -1);
      await client.db(this.wc.mongoDbName).collection("telemetry").insertOne({
        kind: "voice_call_stats",
        callId: this.call.callId,
        agentId: this.call.agentId,
        cell: this.call.cell,
        direction: this.call.direction,
        turns: this.turnLatencies.length,
        interruptions: this.interruptions,
        retries: this.retries,
        outcome: this.failures.length && outcome === "failed" ? this.failures[this.failures.length - 1] : outcome,
        durationMs: Date.now() - this.startedAt,
        latency: { p50: pct(50), p95: pct(95) },
        createdAt: new Date(),
      });
    } catch (err) {
      log.warn("voice_call_stats flush failed", { callId: this.call.callId, error: String(err) });
    } finally {
      await client.close().catch(() => {});
    }
  }
}
```

Wire `VoiceWorkerHeartbeat` into `main.ts` worker boot (module scope of the CLI branch: connect one MongoClient with `wc.mongoUri`, `heartbeat.start()`, increment counters from `runCallSession` via a shared instance passed through `entry` — follow the `SpawnCoordinatorHeartbeat` start/initial-`writeOnce` idiom).

- [ ] **Step 2:** `telemetry.test.ts` (mirror `spawn-coordinator-heartbeat.test.ts`): `writeOnce` upserts `{kind: "voice_worker_stats"}` with counters + `updatedAt` (fake collection capturing `updateOne` args); write failure logs and does not throw; `TurnMetricsLine` contains callId only — assert the logged object has **no** `to`/number/text fields; `CallStats.retryConsumed` true only on second call per class; percentile math on a known array.
- [ ] **Step 3:** Verify — `npx vitest run src/voice-worker/telemetry.test.ts` green.
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-322): voice worker telemetry — turn JSONL, heartbeat, call stats"`

### Task 9 — `hive doctor` voice-worker section

**Files:**
- Modify: `src/cli/doctor-checks.ts` (beside `prefixCacheStatsForDoctor`, `:276-305`)
- Modify: `src/cli/doctor.ts` (beside the spawn-coordinator section, `:694-720`)
- Test: `src/cli/doctor-checks.test.ts`

- [ ] **Step 1:** Reader in `doctor-checks.ts` (mirror `prefixCacheStatsForDoctor` exactly — short-lived client, 2s timeout, null on absence):

```typescript
/** KPR-322: voice-worker heartbeat row (kind="voice_worker_stats"). */
export interface VoiceWorkerStatsRow {
  activeCalls: number;
  callsStarted: number;
  callsCompleted: number;
  lastError: string | null;
  cellDefaults: { defaultStt?: string; defaultTts?: string } | null;
  /** Seconds since the worker last wrote this doc; null if no doc yet. */
  staleSeconds: number | null;
}

export async function voiceWorkerStatsForDoctor(uri: string, dbName: string): Promise<VoiceWorkerStatsRow | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const doc = await client.db(dbName).collection("telemetry").findOne<{
      activeCalls?: number;
      callsStarted?: number;
      callsCompleted?: number;
      lastError?: string | null;
      cellDefaults?: { defaultStt?: string; defaultTts?: string };
      updatedAt?: Date;
    }>({ kind: "voice_worker_stats" });
    if (!doc) return null;
    const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : null;
    return {
      activeCalls: doc.activeCalls ?? 0,
      callsStarted: doc.callsStarted ?? 0,
      callsCompleted: doc.callsCompleted ?? 0,
      lastError: doc.lastError ?? null,
      cellDefaults: doc.cellDefaults ?? null,
      staleSeconds: updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 1000) : null,
    };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
```

- [ ] **Step 2:** Section in `doctor.ts` beside the spawn-coordinator render: header `"Voice worker (LiveKit)"`; only rendered when `config.voice.livekit.enabled`; rows: active/started/completed calls, cell defaults, lastError; `staleSeconds > 90` → flag `"heartbeat stale — worker down or wedged (launchctl kickstart -k gui/$(id -u)/com.hive.<id>.voice-worker)"`; `null` row + enabled config → `"no heartbeat yet — worker never started?"`. Follow the file's existing emit/print idiom verbatim.
- [ ] **Step 3:** Tests in `doctor-checks.test.ts` mirroring the existing prefix-cache cases: doc present → mapped row with computed `staleSeconds`; absent → null; connection failure → null.
- [ ] **Step 4:** Verify — `npx vitest run src/cli` green.
- [ ] **Step 5:** Commit — `git commit -m "feat(kpr-322): hive doctor voice-worker heartbeat section"`

### Task 10 — launchd service plist + dev mode

**Files:**
- Modify: `setup/generate-plist.ts`

- [ ] **Step 1:** Add a fourth plist to the generator (gated on hive.yaml `voice.livekit.enabled`), after the existing three; same variable conventions (`LABEL_VOICE = \`com.hive.${instanceId}.voice-worker\``):

```typescript
// ── Voice worker plist (KPR-322 S4) — only when voice.livekit.enabled ──
const voiceLivekitEnabled =
  ((hiveConfig as { voice?: { livekit?: { enabled?: boolean } } }).voice?.livekit?.enabled ?? false) === true;
if (voiceLivekitEnabled) {
  const LABEL_VOICE = `com.hive.${instanceId}.voice-worker`;
  const voiceWorkerPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_VOICE}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>dist/voice-worker/main.js</string>
    <string>start</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${DEPLOY_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/voice-worker.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/voice-worker.err.log</string>
</dict>
</plist>
`;
  writeFileSync(join(SERVICE_DIR, `${LABEL_VOICE}.plist`), voiceWorkerPlist);
  console.log(`Generated ${LABEL_VOICE}.plist`);
}
```

(Copy the surrounding EnvironmentVariables/KeepAlive keys from the file's main-service template verbatim if it carries more — e.g. session-type keys; keep parity. The `start` argv matches the agents-js CLI verb; confirm against the pinned version at Task 0.)

- [ ] **Step 2:** Note in the same commit (code comment in the generator, not a doc file): **pilot deploy runs from a built checkout** (`npm run build` → `dist/` + `node_modules` present). The npm-published tarball does NOT carry `dist/` — packaging the worker into `hive update` artifacts is explicitly out of scope for the pilot (recorded seam; revisit after the 325 verdict). Restart primitive: `launchctl kickstart -k gui/$(id -u)/com.hive.<id>.voice-worker`. Dev mode: `npx tsx src/voice-worker/main.ts dev`.
- [ ] **Step 3:** Verify — `npx tsx setup/generate-plist.ts` on a checkout whose hive.yaml has `voice.livekit.enabled: true` emits the plist; without it, emits nothing new (and does not error). `npm run lint` green.
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-322): voice-worker launchd plist generation"`

### Task 11 — `scripts/livekit-setup.ts`: one-shot idempotent SIP setup (SIP-1..SIP-3)

**Files:**
- Create: `scripts/livekit-setup.ts`
- Test: `src/voice-worker/livekit-setup-plan.test.ts` (pure planning logic — put the pure function in `src/voice-worker/livekit-setup-plan.ts` so it's typechecked/tested with the source tree; the script imports it)
- Create: `src/voice-worker/livekit-setup-plan.ts`

- [ ] **Step 1:** Pure planner `src/voice-worker/livekit-setup-plan.ts`:

```typescript
/**
 * Idempotency planner for scripts/livekit-setup.ts (KPR-322 §10 SIP-1..3).
 * Pure: given current LiveKit state, decide create/skip per object. Matching
 * is by our fixed names — re-running the script never duplicates objects.
 */
export const OUTBOUND_TRUNK_NAME = "dodihome-ops-outbound (KPR-322)";
export const INBOUND_TRUNK_NAME = "dodihome-ops-inbound (KPR-322)";
export const DISPATCH_RULE_NAME = "hive-voice-individual (KPR-322)";
export const ROOM_PREFIX = "call-";
export const AGENT_NAME = "hive-voice";

export interface ExistingState {
  outboundTrunks: Array<{ sipTrunkId: string; name: string }>;
  inboundTrunks: Array<{ sipTrunkId: string; name: string }>;
  dispatchRules: Array<{ sipDispatchRuleId: string; name: string }>;
}

export interface SetupPlan {
  createOutbound: boolean;
  createInbound: boolean;
  createDispatchRule: boolean;
  existingOutboundId?: string;
  existingInboundId?: string;
  existingDispatchRuleId?: string;
}

export function planSetup(state: ExistingState): SetupPlan {
  const outbound = state.outboundTrunks.find((t) => t.name === OUTBOUND_TRUNK_NAME);
  const inbound = state.inboundTrunks.find((t) => t.name === INBOUND_TRUNK_NAME);
  const rule = state.dispatchRules.find((r) => r.name === DISPATCH_RULE_NAME);
  return {
    createOutbound: !outbound,
    createInbound: !inbound,
    createDispatchRule: !rule,
    existingOutboundId: outbound?.sipTrunkId,
    existingInboundId: inbound?.sipTrunkId,
    existingDispatchRuleId: rule?.sipDispatchRuleId,
  };
}
```

- [ ] **Step 2:** `scripts/livekit-setup.ts` (operator-run; secrets resolved from Honeypot INSIDE the invocation per the 321 §9 pattern — piped into API calls, never echoed/logged):

```typescript
#!/usr/bin/env npx tsx
/**
 * One-shot idempotent LiveKit SIP setup (KPR-322 §10 SIP-1..SIP-3).
 * Consumes KPR-321 §8 artifacts: termination URI + E.164 (hive.yaml
 * telephony.twilio.*), SIP credential values (Honeypot, resolved in-process,
 * never printed). Prints object IDs only. Re-runnable: existing objects
 * (matched by name) are reported and skipped.
 *
 * Usage: npx tsx scripts/livekit-setup.ts [--dry]
 */
import { execFileSync } from "node:child_process";
import { SipClient } from "livekit-server-sdk";
import { config } from "../src/config.js";
import {
  planSetup,
  OUTBOUND_TRUNK_NAME,
  INBOUND_TRUNK_NAME,
  DISPATCH_RULE_NAME,
  ROOM_PREFIX,
  AGENT_NAME,
} from "../src/voice-worker/livekit-setup-plan.js";

const dry = process.argv.includes("--dry");

function honeypot(key: string): string {
  // argv-array subprocess (repo security rule) — value never echoed.
  const instanceId = process.env.HIVE_INSTANCE_ID || config.instanceId || "hive";
  try {
    return execFileSync("security", ["find-generic-password", "-s", `hive/${instanceId}/${key}`, "-w"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return process.env[key] ?? "";
  }
}

async function main(): Promise<void> {
  const lk = config.voice.livekit;
  const twilio = config.telephony.twilio;
  const apiKey = config.voice.livekitApiKey || honeypot("LIVEKIT_API_KEY");
  const apiSecret = config.voice.livekitApiSecret || honeypot("LIVEKIT_API_SECRET");
  const trunkUser = honeypot("TWILIO_SIP_TRUNK_USERNAME");
  const trunkPass = honeypot("TWILIO_SIP_TRUNK_PASSWORD");

  const missing = Object.entries({
    "voice.livekit.url": lk.url,
    "telephony.twilio.number": twilio.number,
    "telephony.twilio.trunkDomain": twilio.trunkDomain,
    LIVEKIT_API_KEY: apiKey,
    LIVEKIT_API_SECRET: apiSecret,
    TWILIO_SIP_TRUNK_USERNAME: trunkUser,
    TWILIO_SIP_TRUNK_PASSWORD: trunkPass,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing inputs (config or Honeypot): ${missing.join(", ")}`);
    process.exit(1);
  }

  const sip = new SipClient(lk.url, apiKey, apiSecret);
  const plan = planSetup({
    outboundTrunks: (await sip.listSipOutboundTrunk()).map((t) => ({ sipTrunkId: t.sipTrunkId, name: t.name })),
    inboundTrunks: (await sip.listSipInboundTrunk()).map((t) => ({ sipTrunkId: t.sipTrunkId, name: t.name })),
    dispatchRules: (await sip.listSipDispatchRule()).map((r) => ({ sipDispatchRuleId: r.sipDispatchRuleId, name: r.name })),
  });

  // SIP-1: outbound trunk
  let outboundId = plan.existingOutboundId;
  if (plan.createOutbound && !dry) {
    const t = await sip.createSipOutboundTrunk(OUTBOUND_TRUNK_NAME, twilio.trunkDomain, [twilio.number], {
      authUsername: trunkUser,
      authPassword: trunkPass,
    });
    outboundId = t.sipTrunkId;
  }
  console.log(`SIP-1 outbound trunk: ${plan.createOutbound ? (dry ? "WOULD CREATE" : `created ${outboundId}`) : `exists ${outboundId}`}`);

  // SIP-2: inbound trunk (restricted to our E.164; krisp-class NC ⚠ verify plan availability)
  let inboundId = plan.existingInboundId;
  if (plan.createInbound && !dry) {
    const t = await sip.createSipInboundTrunk(INBOUND_TRUNK_NAME, [twilio.number], {
      krispEnabled: true, // ⚠ ignore-if-unavailable on the pilot plan
    });
    inboundId = t.sipTrunkId;
  }
  console.log(`SIP-2 inbound trunk: ${plan.createInbound ? (dry ? "WOULD CREATE" : `created ${inboundId}`) : `exists ${inboundId}`}`);

  // SIP-3: dispatch rule — individual rooms `call-*` dispatching hive-voice
  if (plan.createDispatchRule && !dry) {
    const r = await sip.createSipDispatchRule(
      { type: "individual", roomPrefix: ROOM_PREFIX },
      {
        name: DISPATCH_RULE_NAME,
        trunkIds: inboundId ? [inboundId] : [],
        roomConfig: { agents: [{ agentName: AGENT_NAME }] },
      },
    );
    console.log(`SIP-3 dispatch rule: created ${r.sipDispatchRuleId}`);
  } else {
    console.log(`SIP-3 dispatch rule: ${dry ? "WOULD CREATE" : `exists ${plan.existingDispatchRuleId}`}`);
  }

  console.log("\nRecord in hive.yaml:  voice.livekit.sipTrunkId: " + (outboundId ?? "<pending>"));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
```

(⚠ Task-0 pin: `SipClient` method names/option shapes against the pinned `livekit-server-sdk`; adjust mechanically. `config.instanceId` accessor: use the engine config's actual instance-id field per `config.ts` — verify name at implementation.)

- [ ] **Step 3:** `livekit-setup-plan.test.ts`: empty state → create all three; full state (all three names present) → create none + existing IDs surfaced; partial state → only missing objects created. Assert the three name constants are distinct and stable.
- [ ] **Step 4:** Verify — `npx vitest run src/voice-worker/livekit-setup-plan.test.ts` green; `npm run lint` green (script included via `eslint src/ setup/`? scripts/ is not linted today — keep the script's pure logic in `src/` (done) and hold the script itself to the same style manually).
- [ ] **Step 5:** Commit — `git commit -m "feat(kpr-322): idempotent LiveKit SIP setup script (SIP-1..3)"`

### Task 12 — Execute SIP-1..SIP-3 (ops; NOT gated — routes nothing until SIP-5)

**External preconditions (verify, don't perform):** 321 complete through B7 (`hive credentials list` shows the five TWILIO_* keys; trunk + credential list exist per 321 §8 table); §16.1 done (LiveKit project + `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in Honeypot; `voice.livekit.url` set in dodi hive.yaml).

- [ ] Confirm preconditions above; if any missing, stop and present the corresponding §16 card to May (mirror 321's card style).
- [ ] Set `telephony.twilio.number` + `telephony.twilio.trunkDomain` in dodi `hive.yaml` from the 321 §8 artifact table (values are non-secret identifiers).
- [ ] Dry run: `cd ~/services/hive/dodi && npx tsx <checkout>/scripts/livekit-setup.ts --dry` — expect three WOULD CREATE lines.
- [ ] Real run: same command without `--dry`. Expect three `created ST_.../SDR_...` lines. Record all three IDs in lane ops notes (they are non-secret).
- [ ] Write `voice.livekit.sipTrunkId: <ST_...>` into dodi hive.yaml.
- [ ] Idempotency verify: re-run without `--dry` — expect three `exists` lines, zero new objects.
- [ ] Scope guard: do NOT touch Twilio in this task; SIP-4/5 are Tasks 13/19.

### Task 13 — SIP-4: origination URI on the Twilio trunk (ops; safe pre-cutover)

- [ ] Read the LiveKit project's SIP endpoint hostname from project settings (non-secret; `<subdomain>.sip.livekit.cloud`).
- [ ] Create the origination URL (321 §0.2 invocation shape — prelude verbatim, secrets in-invocation only):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://trunking.twilio.com/v1/Trunks/{TK_SID}/OriginationUrls" \
  --data-urlencode "FriendlyName=LiveKit origination (KPR-322)" \
  --data-urlencode "SipUrl=sip:{LIVEKIT_SIP_SUBDOMAIN}.sip.livekit.cloud;transport=tcp" \
  --data-urlencode "Weight=1" --data-urlencode "Priority=1" --data-urlencode "Enabled=true" \
  | jq '{sid, sip_url, enabled}'
```

- Expected: `sid` starting `OU`, `sip_url` echoed, `enabled: true`. TLS/SRTP (`;transport=tls`) is the documented secure-trunking upgrade, deliberately NOT enabled for the pilot ⚠.
- [ ] Verify (V-read): `curl -sS -u "$TW_KEY:$TW_SEC" "https://trunking.twilio.com/v1/Trunks/{TK_SID}/OriginationUrls" | jq '.origination_urls[] | {sid, sip_url}'` — one entry.
- [ ] Record `OU_...` sid in ops notes. This routes nothing until SIP-5 (number not on the trunk yet).

### Task 14 — [GATE: operator go, D3] `voice-pilot` test agent + P0 SIP smoke

> **GO block to present (verbatim, fill values):**
> **P0 — first live call over the new stack.** One outbound call to your phone, best-guess cell (Flux × Sonic). Vendors touched: LiveKit Cloud, Twilio (pennies), Deepgram + Cartesia (seconds of usage — cents). No customer-facing surface changes; SIP-5 cutover NOT flipped. Artifacts: telemetry only, no transcripts. Go?

- [ ] Record the go (date/words) in Linear KPR-322 comments; without it, stop.
- [ ] **Prep — test agent (⚠ never Nora's/Sige's live defs):** create `voice-pilot` via admin MCP `agent_create` — Sonnet, minimal coreServers (`memory`, `structured-memory`, `contacts`), soul: brief professional caller persona, systemPrompt: vendor-call test guardrails ("you are on a test call; be concise; never claim to place orders"), `spawnBudget: 5`. Memory writes and reflection from test turns land on this agent only.
- [ ] Prep — engine + worker deployed on dodi: engine restarted with E1–E3 (`launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent`), `HIVE_VOICE_BRIDGE_TOKEN` seeded (§16.3), worker plist bootstrapped, `hive doctor` shows a fresh voice-worker heartbeat.
- [ ] Bridge pre-smoke (no PSTN): `curl` the adapter from the box with the bridge token and a worker-shaped body → expect SSE deltas + `[DONE]`. (Token resolved in-invocation from Honeypot; command mirrors Task 13's prelude shape.)
- [ ] P0 call: `lk dispatch create --agent-name hive-voice --metadata '{"hive_agent_id":"voice-pilot","to":"<operator phone>","goal":"Test call — greet, confirm two-way audio, say goodbye.","context":"P0 smoke"}'` (or E4 tool if Task 4 landed).
- [ ] **Pass criteria (§15 P0):** call connects; hive-authored greeting heard; two-way audio; clean hangup. Record pass/fail + `voice_call_stats` doc snapshot in ops notes.
- [ ] Fail → diagnose from worker logs + engine "Voice turn complete" telemetry; fixes re-enter the relevant task; re-request go only if vendor spend materially changes.

### Task 15 — [GATE: operator go, D3] P1 conversation feasibility

> **GO block:** P1 — one full 10-turn scripted call (operator reads the caller side), best-guess cell. Cost: cents. Artifacts: telemetry only. Go?

- [ ] Record the go. Use the fixed §14.2 script (order status + one lookup pause + two marked barge-in points — write the script at execution, store with lane notes; it contains no real vendor data).
- [ ] Run the call against `voice-pilot`.
- [ ] **Pass criteria (§15 P1):** ≥90% of turns produce a spoken response; no worker crash; `sdkSessionResumed: true` on ≥8 of 9 resume turns (engine "Voice turn complete" logs).
- [ ] Record per-turn table (turnSeq, spoken?, resumed?) in ops notes.

### Task 16 — [GATE: operator go, D3] P2 latency

> **GO block:** P2 — 3 calls, best-guess cell, latency telemetry only. Cost: cents. Thresholds bind to KPR-323's blessed baseline at this moment — placeholders until then. Go?

- [ ] **Bind placeholders first:** read KPR-323's blessed read-only first-audio baseline (`{323_BASELINE_MS}`) from its epic artifact; threshold = `totalToFirstAudioMs p50 ≤ {323_BASELINE_MS} + 300ms`, hard ceiling 2.0s p50 / 3.5s p95 ⚠ (spec placeholders — record the bound values in ops notes before dialing).
- [ ] Record the go. Run 3 scripted calls; pull `voice_call_stats` + per-turn lines.
- [ ] **Pass criteria (§15 P2):** bound thresholds met. If P2 fails **on the spawn term** (`llmTtftMs` dominates), that is 323's lane by design — record the decomposition (§13 fields) and proceed to P3/P4 **only with explicit operator dispensation** (a second recorded ruling, not implied by the P2 go).

### Task 17 — [GATE: operator go, D3] P3 barge-in — including the E2 negative-verify

> **GO block:** P3 — scripted interrupts (2 per call × 3 calls) plus one deliberate hazard demonstration on pre-E2 engine code (2 extra calls). Cost: cents. Proves the barge-in lock-release fix live. Go?

- [ ] Record the go.
- [ ] **Negative-verify first (pre-E2 hazard demonstration):** on the dodi box, build the engine at the commit immediately preceding the Task 3 (E2) commit (`git checkout <pre-E2-sha> && npm run build`), restart the engine. Place one scripted call; interrupt mid-long-answer; speak the next utterance immediately. **Expected (hazard):** post-interruption response latency ≈ remaining runtime of the interrupted turn (observe the lock-wait in engine logs — the post-interruption "Voice turn complete" `totalMs` inflated; record numbers). This is the recorded evidence the fix targets a real fault.
- [ ] Restore delivery HEAD (`git checkout <delivery-sha> && npm run build`), restart engine. Re-run: 2 interrupts per call × 3 calls.
- [ ] **Pass criteria (§15 P3):** agent audio stops ≤500ms after caller onset (worker `interrupted` turn lines + operator stopwatch); post-interruption turn meets the P2 bounds (proves E2 released the lock); next-turn resume survives the abort (`sdkSessionResumed: true` or a single clean outer-retry, never a dead turn).
- [ ] Record both phases' evidence side-by-side (the before/after latency table is the ticket's E2 proof artifact).

### Task 18 — [GATE: operator go, D3] P4 — vendor A/B matrix (§14)

> **GO block:** P4 — full matrix: 2 STT × 2 TTS cells, N=5 scripted calls per cell (~200 turns, ~40 min talk time, same day, cell order randomized). Estimated total vendor cost **<$20 ⚠ verify against live vendor pricing before dialing** — I'll present the recomputed figure with this block. WER scoring requires a **PoC-only local transcript artifact, deleted after scoring** — an explicit, operator-approved exception to the no-transcript posture; approving this block approves that artifact. Go?

- [ ] Record the go (it covers the WER artifact exception explicitly).
- [ ] Everything pinned except the cell (§14.2): same `voice-pilot` def, model, goal/context, script, phone/handset, network. Cell pinned per call via dispatch metadata `{"stt":"...","tts":"..."}` (S7) — recorded in `voice_call_stats.cell`.
- [ ] Run 4 cells × 5 calls, randomized order. Tally operator marks (false interrupts, premature cutoffs against the two marked barge-in points; MOS 1–5 on the 10 fixed sentences per TTS cell).
- [ ] WER-proxy: transcribe-only mode (worker flag added at execution if needed — a `--transcribe-only` dispatch metadata bool that skips LLM/TTS ⚠ small, in-scope wiring): operator reads the fixed 200-word passage per STT cell; recognized text → local file under the instance scratch dir; compute WER; **delete the file; record the deletion in ops notes** (sole transcript exception).
- [ ] Score per §14.3 metrics table (telemetry + tallies + vendor dashboards for cost/min).
- [ ] Apply §14.4 decision rule verbatim: quality floors (MOS ≥3.5; ≤2 combined false-interrupt+premature-cutoff per 50 turns; WER within 2 points of the better cell) → latency (lowest `totalToFirstAudioMs` p50 per axis) → cost tie-break (within 100ms p50 → >25% cheaper wins).
- [ ] **Record the winner cell in the epic Decision Register** (KPR-320) — it becomes 325's default stack; set `voice.livekit.defaultStt/defaultTts` accordingly; loser stays wired via S7 metadata override.

### Task 19 — [GATE: operator go + May-confirm inbound agent, D3] SIP-5: number→trunk cutover (LAST)

> **GO block:** SIP-5 cutover — assigns the E.164 to the Elastic SIP trunk. This **retires 321's interim TwiML forward to the Quo line**: inbound calls to the vendor-announced number will be answered by the LiveKit pipeline agent instead of forwarding. Mutually exclusive with the TwiML routing; rollback is a single reassignment. Two decisions: (1) go/no-go on the cutover; (2) **confirm the inbound default agent** — delegated default is `nora` (⚠ spec §19); the `voice.livekit.inboundAgents` map currently reads `{"<E.164>": "nora"}`. Go, and which agent?

- [ ] Preconditions: P0 + P1 passed (spec sequencing; in practice run after P4 so the winning cell answers). Record the go AND May's inbound-agent confirmation (update `inboundAgents` in hive.yaml if she overrides; SIGUSR1 not needed — worker reads at boot; kickstart the worker).
- [ ] Assign the number to the trunk:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://trunking.twilio.com/v1/Trunks/{TK_SID}/PhoneNumbers" \
  --data-urlencode "PhoneNumberSid={NEW_NUMBER_PN_SID}" \
  | jq '{sid, phone_number}'
```

- [ ] **Inbound verify:** call the number from an outside phone → the pipeline agent answers (hive-authored greeting, vendor-callback goal); no dead air. Record who tested + result.
- [ ] **Rollback rehearsal (once, required by §15):** detach + re-point, then re-cutover:

```bash
# detach from trunk
curl -sS -o /dev/null -w '%{http_code}\n' -u "$TW_KEY:$TW_SEC" -X DELETE \
  "https://trunking.twilio.com/v1/Trunks/{TK_SID}/PhoneNumbers/{NEW_NUMBER_PN_SID}"
# re-point at the 321 TwiML bin (⚠ verify voice_url persisted; else re-set it)
curl -sS -u "$TW_KEY:$TW_SEC" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)/IncomingPhoneNumbers/{NEW_NUMBER_PN_SID}.json" \
  --data-urlencode "VoiceUrl={TWIML_BIN_URL}" --data-urlencode "VoiceMethod=POST" \
  | jq '{sid, voice_url}'
```

Verify the forward answers again (Quo line rings), then repeat the assignment block to re-cutover. Record both flips. LiveKit objects stay in place, inert, throughout any rollback.

### Task 20 — Close-out

- [ ] Fill the handoff artifact table in ops notes: LiveKit object IDs (SIP-1/2/3), Twilio `OU_` sid (SIP-4), cutover state (SIP-5), winner cell + Decision Register link (P4), bound P2 thresholds, `voice-pilot` agent id, Honeypot key names used (names only).
- [ ] Confirm WER artifacts deleted (Task 18 note present); confirm no transcript/phone-number strings in worker logs (spot-check `voice-worker.log`).
- [ ] `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` green at delivery HEAD; `npm run check:bundle` green.
- [ ] Update `CLAUDE.md` Mongo-collections gotcha line: append `voice_worker_stats / voice_call_stats heartbeat+summary KPR-322` (one-line edit, matches the KPR-213/220/294 listing pattern).
- [ ] Seams honored (verify nothing leaked in): no spawn-latency changes (323), no tool-call bridging or masking mechanism (324), no personas/rubric (325), no Vapi removal, no self-hosted LiveKit, no voice cloning, no AMD policy.

---

## 3. Scope guards (restated non-goals)

- **No warm-path/spawn-latency optimization** — KPR-323 owns the dominant latency term; the bridge treats hive TTFT as opaque (§9.1).
- **No mid-call tool contracts / masking mechanism** — §9.2 states the surface only; `maxInterChunkGapMs` is measured for 324, nothing more.
- **No Vapi migration or retirement** — coexistence is the designed pilot state; E1 must leave every Vapi behavior byte-identical.
- **No KPR-325 content** — personas, rubric, pickup-rate thresholds, vendor playbooks.
- **No engine-wide provider-seam changes** (W3's lane), no Quo-number porting, no SMS, no self-hosted LiveKit, no voice cloning, no AMD policy, no TLS/SRTP trunking (documented upgrade only).
- **No new npm packaging for the worker** — pilot runs from a built checkout; tarball packaging is a recorded seam post-325.

## 4. ⚠ verify-at-execution registry (consolidated)

| # | Claim to re-verify live | Where |
|---|---|---|
| 1 | agents-js 1.5.x class shapes: `llm.LLM`/`llm.LLMStream` subclass surface, queue/close idiom, cancellation hook, `STTv2` Flux + `turnDetection: "stt"`, Nova-3 turn-detector plugin, false-interruption resume, session event names (`agent_speech_interrupted`, `metrics_collected`), text-transform hook, CLI verb | Task 0 → Tasks 5–8 |
| 2 | `SipClient` method/option names (`createSipOutboundTrunk/InboundTrunk/DispatchRule`, `createSipParticipant` + `waitUntilAnswered`) | Task 0 → Tasks 4, 7, 11 |
| 3 | Cloudflared tunnel topology — Vapi ingress connects from localhost (loopback bind safe); escape hatch `voice.bindHost: "0.0.0.0"` | Task 14 prep |
| 4 | Vapi requests always carry an `assistant` object (E1 shape check) — confirm on live coexistence traffic before relying on 401s for anything Vapi-shaped | Task 14 prep |
| 5 | krisp-class noise cancellation available on the pilot LiveKit plan | Task 12 (SIP-2) |
| 6 | A/B run cost <$20 — recompute from live vendor pricing before the P4 go | Task 18 |
| 7 | P2 thresholds — bind to KPR-323's blessed baseline; placeholders until then | Task 16 |
| 8 | Interruption-marker wording (delivery-tunable) + TTS markdown-normalization need (plugin-native handling may suffice) | Tasks 15/17 |
| 9 | Twilio `voice_url` persistence across trunk assign/detach (rollback path) | Task 19 |
| 10 | Stock TTS voice choice per persona (config'd at PoC; cloning out of scope) | Task 14 |
| 11 | `config.instanceId` / mongo accessor field names in the engine config object | Tasks 5, 11 |

---

**Execution handoff:** plan saved at `docs/epics/kpr-320/kpr-322-plan.md`. Dispatcher runs the plan-review loop; on approval + W5 re-open + W3 merge, execute via `dodi-dev:implement` starting at Task 0.
