# KPR-465 bench chunk (D) — engine bench script, contained `mokie-bench` clone, conditional endpointing lever

> **For agentic workers:** Use dodi-dev:implement. Tasks D1–D3 (bench script + R6) follow chunk B in the binding order and precede chunk C. Task D4 (endpointing, R4) is **conditional** — it is built only after the A0 decomposition (chunk E Task E3) names the EOU stage as the largest or second-largest remaining term after A2 (spec §4, arm A3) — and is the last product-code task of the ticket. Task D5 is an on-instance runbook, not code.

**Goal:** An operator-run loopback bench (`scripts/voice-engine-bench.ts`) that posts the fixed 10-turn script at the real adapter with the worker's exact request shape and produces a content-free result file plus per-turn assertion records; a documented, contained `mokie-bench` clone lifecycle with three delete-time checks; and, conditionally, one worker-side `voice.livekit.endpointing.{minDelayMs,maxDelayMs}` key whose absence is byte-identical to today.

**Architecture:** The pure pieces (script lines with expected-answer keyword sets, request-body builder mirroring `hive-llm.ts`, SSE chunk parser mirroring `openai-translator.ts`, per-turn assertion) live in `src/voice/voice-bench-script.ts` so the CLI is thin and the R6 loopback test can drive the same code against a real `VoiceAdapter` with a fake spawn. The bench never reads engine rows; it writes `turnId`s so chunk B's reader joins `toolCount` by identity. The kill drills keep a human in the loop (the operator names the CLI child pid under the quiet window; the script only sequences *when*). Endpointing is parsed leniently by `config.ts` (raw passthrough — the engine never reads it) and validated at worker config load, where an invalid value fails the worker with a clear error; `session.ts` spreads it into `turnHandling` only when present and stamps the effective values on `session_started`.

**Tech Stack:** TypeScript, Node `http`, `node:util.parseArgs`, `node:readline` (kill drills), `@livekit/agents` 1.6.4 `TurnHandlingOptions.endpointing` + `voice.defaultEndpointingOptions`, Vitest.

Spec authority: §4.2 Tier E (bench + clone), §6.1 script, §4.1 endpointing lever, §8 R6, R4, R7. Canon R7 (real SDK + fake media is the product harness — the bench is an *engine* instrument and touches no worker media).

## Testing Contract (chunk D)

### Required Test Groups

- Unit: `required`
  - Scope: `src/voice/voice-bench-script.ts` (`BENCH_SCRIPT` shape invariants, `buildBridgeRequest`, `parseSseChunk`, `assertTurn`); `src/voice-worker/worker-config.ts` (`resolveVoiceEndpointingConfig`); `src/config.ts` (raw passthrough); reader allowlist for `session_started` keys.
  - Reason: request shape and assertion logic are pure; the endpointing validator is pure.
  - Minimum assertions: script has exactly 10 turns, two `bargeIn` turns, one `expect.tool` turn, one `recallOf`, every non-barge-in turn carries an `expect`, no line contains a digit-run of ≥ 7 (no phone numbers) or an `@`; request body deep-equals the worker's shape (`stream: true`, `messages`, `call.id`, `call.metadata.{hive_agent_id,goal,context}`, `metadata.voiceTrace.{schemaVersion:2,workerBootId,turnId}` and nothing else); SSE parser yields `text` deltas and a `done` with `finish_reason`; `assertTurn` is case-insensitive and returns `keywordPass: null` for turns without keywords; endpointing absent → `undefined`, `{minDelayMs: 300}` → accepted, `{minDelayMs: -1}`/`{minDelayMs: 600, maxDelayMs: 500}`/`{minDelayMs: 20000}`/`"300"` → throws naming the key.
- Integration: `required`
  - Scope: `scripts/voice-engine-bench.test.ts` — `runBenchCall` against the real `VoiceAdapter` (bridge bearer, fake spawn) on `127.0.0.1:0`: sequential 10-turn call, barge-in close, rapid double-request, three concurrent calls, injected kill hook timing (a/b/c), result file rows; `src/voice-worker/session.test.ts` — constructor options captured, absent key ⇒ `turnHandling` deep-equals `{ turnDetection: "stt" }`, present key ⇒ `endpointing` spread, `session_started` stamped.
  - Reason: R6 requires the loopback run against the real adapter; R4 requires the session options proven byte-identical.
  - Harness: `existing` (`voice-adapter.integration.test.ts` helpers; `session.test.ts` `sdkState`) — the session mock gains a `ctorOptions` capture and a `defaultEndpointingOptions` export.
  - Minimum assertions: 10 result rows + 1 header row; two rows with `finish: "closed"` (barge-ins) whose attempt terminals read `outcome: "cancelled"`; double-request yields two `engine_received` rows and two results; three concurrent calls yield three distinct `callId`s with 10 rows each; kill hook fired exactly once at the right phase per drill; no row contains the answer text, the bearer, or the agent's goal/context text; `engine_received.correlation === "worker"` for every bench turn.
- E2E: `required` (offline) — the integration suite above IS the offline E2E for the instrument. Tier E on the dodi engine is chunk E's live-instance operation.

### Critical Flows

- One bench call = 10 sequential POSTs with accumulated `messages`, per-turn `turnId`, one shared bench `workerBootId`.
- Barge-in = `req.destroy()` after the first text chunk (+ a fixed 300 ms) on turn 5, and 1 500 ms after send on turn 7 regardless of bytes.
- Double-request = turn 1 and turn 2 posted without awaiting turn 1.
- Kill drills = hook fired (a) after `req.end()` before the first byte on turn 3; (b) after the first byte on turn 3; (c) after `req.end()` before the first byte on turn 1 of a fresh call.

### Regression Surface

- `VoiceAdapter` request parsing/auth — untouched (the bench is a client).
- `session.ts` with no endpointing key — `new voice.AgentSession({...})` receives the identical options object as today (asserted with `toEqual` on the captured ctor options).
- Engine boot never reads `voice.livekit.endpointing` (only `worker-config.ts` does).

### Commands

- Unit: `npx vitest run src/voice/voice-bench-script.test.ts src/voice-worker/worker-config.test.ts src/config.test.ts src/voice/voice-diagnostic-reader.test.ts`
- Integration/offline E2E: `npx vitest run scripts/voice-engine-bench.test.ts src/voice-worker/session.test.ts --reporter=verbose`
- Broader: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Live (Tier E): NOT run by this chunk. The operator command is documented in Task D5 and executed under chunk E's protocol.

### Harness Requirements

- The bench test constructs the adapter through `voice-adapter.integration.test.ts`'s `makeAdapter` pattern (copy the helper into the new test file or extract it to `src/channels/voice/testing/adapter-fixture.ts` — extraction preferred, one PR-local refactor with no behavior change).
- The fake spawn streams a canned answer per script turn (keyed by `turnIndex` from the last user message's marker) so keyword assertions are deterministic; the lookup turn's spawn returns `toolCalls: 1`.
- `session.test.ts`: `class AgentSession { constructor(options) { sdkState.ctorOptions.push(options); ... } }` and `voice.defaultEndpointingOptions = { mode: "fixed", minDelay: 500, maxDelay: 3000, alpha: 0.9 }` in the mock; a real-SDK pin in `src/voice-worker/deps.smoke.test.ts` asserts `voice.defaultEndpointingOptions` equals those values on the pinned 1.6.4.

### Non-Required Rationale

- None optional. Live Tier E execution is deferred to chunk E by design, not skipped.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- The bench must never print the bearer, the request headers, or any response text at any log level; the test greps the result file and captured stdout for the fake token and the canned answers.

---

### Task D1: `src/voice/voice-bench-script.ts` — script, request builder, SSE parser, assertion

**Files:**
- Create: `src/voice/voice-bench-script.ts`
- Test: `src/voice/voice-bench-script.test.ts`

- [ ] **Step 1: Write the module.**

```typescript
/**
 * KPR-465 §6.1: the fixed 10-turn caller script and the pure pieces of the
 * engine bench (request shape = the worker's, SSE parse = the adapter's).
 * No personal data, no config import, no network. Content-free outputs.
 */
import type { VoiceTraceMetadata } from "./voice-trace.js";
import type { BenchResultRow } from "./voice-latency-compare.js";

export const BENCH_SCRIPT_VERSION = "kpr-465-v1";

export type BenchTurnKind = "greeting" | "factual" | "recall" | "lookup" | "long" | "goodbye";

export interface BenchTurn {
  index: number; // 1-based
  kind: BenchTurnKind;
  text: string;
  /** Expected answer: keyword set (case-insensitive substring, ANY match), recall source turn, tool requirement. */
  expect: { keywords?: string[]; recallOf?: number; tool?: true } | null;
  /** V4 barge-in point: close the response mid-sentence, or during the tool wait. */
  bargeIn?: "mid-sentence" | "during-tool-wait";
}

export const BENCH_SCRIPT: readonly BenchTurn[] = [
  { index: 1, kind: "greeting", text: "Hello?", expect: null },
  { index: 2, kind: "factual", text: "Quick one: how many days are in a leap year?", expect: { keywords: ["366"] } },
  { index: 3, kind: "factual", text: "And what is the capital city of Japan?", expect: { keywords: ["tokyo"] } },
  { index: 4, kind: "factual", text: "How many minutes are there in three hours?", expect: { keywords: ["180", "one hundred eighty", "one hundred and eighty"] } },
  { index: 5, kind: "long", text: "Tell me, in a few sentences, why a leap year exists at all — walk me through the calendar drift and how the extra day fixes it.", expect: { keywords: ["365", "orbit", "drift", "february", "four"] }, bargeIn: "mid-sentence" },
  { index: 6, kind: "recall", text: "What was the number you gave me a moment ago for the leap year?", expect: { recallOf: 2, keywords: ["366"] } },
  { index: 7, kind: "lookup", text: "Please search our past conversations for the exact phrase bench marker and tell me how many results you find.", expect: { tool: true, keywords: ["result", "found", "none", "nothing", "zero", "0"] }, bargeIn: "during-tool-wait" },
  { index: 8, kind: "lookup", text: "Try that search once more for the phrase bench marker and just give me the count.", expect: { tool: true, keywords: ["result", "found", "none", "nothing", "zero", "0"] } },
  { index: 9, kind: "factual", text: "Last one: how many sides does a hexagon have?", expect: { keywords: ["six", "6"] } },
  { index: 10, kind: "goodbye", text: "That's all I needed, thanks — goodbye.", expect: { keywords: ["bye", "goodbye", "take care", "talk", "later"] } },
];

export interface BridgeRequestInput {
  callId: string;
  agentId: string;
  goal: string;
  context: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  workerBootId: string;
  turnId: string;
}

/** Byte-for-byte the shape src/voice-worker/hive-llm.ts posts (KPR-464 trace metadata included). */
export function buildBridgeRequest(input: BridgeRequestInput): Record<string, unknown> {
  const voiceTrace: VoiceTraceMetadata = { schemaVersion: 2, workerBootId: input.workerBootId, turnId: input.turnId };
  return {
    stream: true,
    messages: input.messages,
    call: { id: input.callId, metadata: { hive_agent_id: input.agentId, goal: input.goal, context: input.context } },
    metadata: { voiceTrace },
  };
}

export type SseEvent = { type: "text"; text: string } | { type: "done"; finishReason: string | null } | { type: "end" };

/** Incremental parser over the adapter's `data: {...}\n\n` / `data: [DONE]\n\n` framing (openai-translator.ts). */
export class SseChunkParser {
  private buffer = "";
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") {
          events.push({ type: "end" });
          continue;
        }
        let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (typeof choice.delta?.content === "string" && choice.delta.content.length > 0) {
          events.push({ type: "text", text: choice.delta.content });
        }
        if (choice.finish_reason) events.push({ type: "done", finishReason: choice.finish_reason });
      }
    }
    return events;
  }
}

export interface TurnAssertion {
  expectsTool: boolean;
  keywordPass: boolean | null;
}

/** Keyword check on the (in-memory only) answer; never returns or stores the text. */
export function assertTurn(turn: BenchTurn, answerText: string): TurnAssertion {
  const expectsTool = turn.expect?.tool === true;
  const keywords = turn.expect?.keywords;
  if (!keywords || keywords.length === 0) return { expectsTool, keywordPass: null };
  const haystack = answerText.toLowerCase();
  return { expectsTool, keywordPass: keywords.some((k) => haystack.includes(k.toLowerCase())) };
}

export type { BenchResultRow };

export function benchResultRow(input: {
  callId: string;
  arm: string;
  turn: BenchTurn;
  turnId: string;
  assertion: TurnAssertion;
  clientFirstTextMs: number | null;
  clientTotalMs: number;
  textLength: number;
  status: number | null;
  finish: "stop" | "error" | "closed" | "none";
  drill?: string;
}): BenchResultRow & { kind: BenchTurnKind; clientTotalMs: number; finish: string; bargeIn: boolean; drill?: string; script: string } {
  return {
    callId: input.callId,
    arm: input.arm,
    turnIndex: input.turn.index,
    turnId: input.turnId,
    expectsTool: input.assertion.expectsTool,
    keywordPass: input.assertion.keywordPass,
    clientFirstTextMs: input.clientFirstTextMs,
    textLength: input.textLength,
    status: input.status,
    kind: input.turn.kind,
    clientTotalMs: input.clientTotalMs,
    finish: input.finish,
    bargeIn: input.turn.bargeIn !== undefined,
    ...(input.drill ? { drill: input.drill } : {}),
    script: BENCH_SCRIPT_VERSION,
  };
}
```

Turn 1 is the caller's greeting, not the SIP quiet-answer opening: the bench has no SIP leg, so the KPR-464 L1 "quiet answer" shape is a Tier L observation only — record it as such in the evidence record (chunk E). Turn 7's "during-tool-wait" barge-in is a fixed 1 500 ms-after-send close because the client cannot see the tool start; the adapter's `toolAckInjected` on the attempt terminal tells the reader whether the ack preceded the close.

- [ ] **Step 2: Unit tests (`src/voice/voice-bench-script.test.ts`).**

```typescript
import { describe, expect, it } from "vitest";
import { BENCH_SCRIPT, SseChunkParser, assertTurn, buildBridgeRequest, benchResultRow } from "./voice-bench-script.js";
import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";

describe("bench script (KPR-465 §6.1)", () => {
  it("has the fixed shape: 10 turns, two barge-ins, two tool turns, one recall, expectations on every non-greeting turn, no personal data", () => {
    expect(BENCH_SCRIPT).toHaveLength(10);
    expect(BENCH_SCRIPT.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(BENCH_SCRIPT.filter((t) => t.bargeIn).map((t) => t.index)).toEqual([5, 7]);
    expect(BENCH_SCRIPT.filter((t) => t.expect?.tool).map((t) => t.index)).toEqual([7, 8]);
    expect(BENCH_SCRIPT.filter((t) => t.expect?.recallOf).map((t) => t.expect!.recallOf)).toEqual([2]);
    for (const t of BENCH_SCRIPT.slice(1)) expect(t.expect).not.toBeNull();
    for (const t of BENCH_SCRIPT) {
      expect(t.text).not.toMatch(/\d{7,}/);
      expect(t.text).not.toContain("@");
    }
  });
  it("builds the worker's exact request shape and nothing else", () => {
    const body = buildBridgeRequest({ callId: "c", agentId: "mokie-bench", goal: "g", context: "x", messages: [{ role: "user", content: "Hello?" }], workerBootId: "b", turnId: "t" });
    expect(body).toEqual({
      stream: true,
      messages: [{ role: "user", content: "Hello?" }],
      call: { id: "c", metadata: { hive_agent_id: "mokie-bench", goal: "g", context: "x" } },
      metadata: { voiceTrace: { schemaVersion: 2, workerBootId: "b", turnId: "t" } },
    });
    expect(Object.keys(body).sort()).toEqual(["call", "messages", "metadata", "stream"]);
  });
  it("parses the adapter's SSE framing incrementally", () => {
    const p = new SseChunkParser();
    const a = formatSSETextChunk("id", "Tok", "m");
    expect(p.push(a.slice(0, 10))).toEqual([]);
    expect(p.push(a.slice(10) + formatSSETextChunk("id", "yo", "m"))).toEqual([{ type: "text", text: "Tok" }, { type: "text", text: "yo" }]);
    expect(p.push(formatSSEDone("id", "m", "error"))).toEqual([{ type: "done", finishReason: "error" }, { type: "end" }]);
  });
  it("asserts keywords case-insensitively and returns null where no keywords exist", () => {
    expect(assertTurn(BENCH_SCRIPT[1]!, "There are 366 days.")).toEqual({ expectsTool: false, keywordPass: true });
    expect(assertTurn(BENCH_SCRIPT[2]!, "Kyoto.")).toEqual({ expectsTool: false, keywordPass: false });
    expect(assertTurn(BENCH_SCRIPT[6]!, "I found no results.")).toEqual({ expectsTool: true, keywordPass: true });
    expect(assertTurn(BENCH_SCRIPT[0]!, "Hi there")).toEqual({ expectsTool: false, keywordPass: null });
  });
  it("result rows never carry text", () => {
    const row = benchResultRow({ callId: "c", arm: "A0-cold", turn: BENCH_SCRIPT[1]!, turnId: "t", assertion: { expectsTool: false, keywordPass: true }, clientFirstTextMs: 900, clientTotalMs: 1400, textLength: 20, status: 200, finish: "stop" });
    expect(JSON.stringify(row)).not.toContain("366");
    expect(row).toMatchObject({ turnIndex: 2, kind: "factual", bargeIn: false, script: "kpr-465-v1" });
  });
});
```

- [ ] **Step 3: Verify and commit.**

Run: `npx vitest run src/voice/voice-bench-script.test.ts` — pass.

```bash
git add src/voice/voice-bench-script.ts src/voice/voice-bench-script.test.ts
git commit -m "feat(voice): fixed bench caller script, bridge request builder, SSE parser (KPR-465)"
```

### Task D2: `scripts/voice-engine-bench.ts`

**Files:**
- Create: `scripts/voice-engine-bench.ts`

- [ ] **Step 1: Write the CLI.**

```typescript
#!/usr/bin/env node
/**
 * KPR-465 §4.2 Tier E: loopback engine bench. Operator-run on the instance
 * host, from the instance directory (HIVE_HOME) so config.ts resolves the
 * bridge token the way the worker does (env → Honeypot). The token is never
 * logged. Posts the fixed §6.1 script at the real adapter; writes a
 * content-free JSONL result file. Engine stages come from the engine's own
 * voice_diagnostic rows for the call ids this script prints.
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { realpathSync, appendFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

import { BENCH_SCRIPT, BENCH_SCRIPT_VERSION, SseChunkParser, assertTurn, benchResultRow, buildBridgeRequest, type BenchTurn } from "../src/voice/voice-bench-script.js";

export type Drill = "double-request" | "concurrent-3" | "kill-a" | "kill-b" | "kill-c";
export const DRILLS: readonly Drill[] = ["double-request", "concurrent-3", "kill-a", "kill-b", "kill-c"];
export const BARGE_IN_AFTER_FIRST_TEXT_MS = 300;
export const BARGE_IN_DURING_TOOL_WAIT_MS = 1_500;

export interface BenchOptions {
  baseUrl: string; // http://127.0.0.1:<port>
  token: string; // never logged
  agentId: string;
  arm: string;
  goal: string;
  context: string;
  workerBootId: string;
  out: (row: Record<string, unknown>) => void;
  /** Kill drills: invoked at the drilled phase; the CLI wires an operator prompt, tests inject a spy. */
  kill?: (phase: "before-first-byte" | "after-first-byte", turn: BenchTurn) => Promise<void>;
  drill?: Drill;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface TurnOutcome {
  status: number | null;
  firstTextMs: number | null;
  totalMs: number;
  text: string; // in-memory only
  finish: "stop" | "error" | "closed" | "none";
}

export function postTurn(
  opts: BenchOptions,
  body: Record<string, unknown>,
  hooks: { onSent?: () => Promise<void>; onFirstText?: () => Promise<void>; closeAfterMs?: number; closeAfterFirstTextMs?: number },
): Promise<TurnOutcome> {
  const url = new URL("/v1/chat/completions", opts.baseUrl);
  const payload = JSON.stringify(body);
  const startedAt = performance.now();
  return new Promise((resolve) => {
    let status: number | null = null;
    let firstTextMs: number | null = null;
    let text = "";
    let finish: TurnOutcome["finish"] = "none";
    let settled = false;
    const parser = new SseChunkParser();
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ status, firstTextMs, totalMs: performance.now() - startedAt, text, finish });
    };
    const req = httpRequest(
      { method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}`, "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        status = res.statusCode ?? null;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          for (const ev of parser.push(chunk)) {
            if (ev.type === "text") {
              if (firstTextMs === null) {
                firstTextMs = performance.now() - startedAt;
                void hooks.onFirstText?.();
                if (hooks.closeAfterFirstTextMs !== undefined) {
                  setTimeout(() => {
                    finish = "closed";
                    req.destroy();
                    done();
                  }, hooks.closeAfterFirstTextMs).unref?.();
                }
              }
              text += ev.text;
            } else if (ev.type === "done") {
              finish = ev.finishReason === "error" ? "error" : "stop";
            }
          }
        });
        res.on("end", done);
        res.on("error", done);
      },
    );
    req.on("error", () => {
      if (finish === "none") finish = "closed";
      done();
    });
    req.end(payload, () => {
      void hooks.onSent?.();
    });
    if (hooks.closeAfterMs !== undefined) {
      setTimeout(() => {
        if (settled) return;
        finish = "closed";
        req.destroy();
        done();
      }, hooks.closeAfterMs).unref?.();
    }
  });
}

/** One scripted call. Returns the call id. Barge-ins are always on (script turns 5 and 7). */
export async function runBenchCall(opts: BenchOptions, callId = `bench-${opts.arm}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const runTurn = async (turn: BenchTurn, extra: { drill?: string } = {}) => {
    const turnId = randomUUID();
    messages.push({ role: "user", content: turn.text });
    const body = buildBridgeRequest({ callId, agentId: opts.agentId, goal: opts.goal, context: opts.context, messages: [...messages], workerBootId: opts.workerBootId, turnId });
    const isKill = opts.drill?.startsWith("kill-") && ((opts.drill === "kill-c" && turn.index === 1) || (opts.drill !== "kill-c" && turn.index === 3));
    const outcome = await postTurn(opts, body, {
      closeAfterFirstTextMs: turn.bargeIn === "mid-sentence" ? BARGE_IN_AFTER_FIRST_TEXT_MS : undefined,
      closeAfterMs: turn.bargeIn === "during-tool-wait" ? BARGE_IN_DURING_TOOL_WAIT_MS : undefined,
      onSent: isKill && (opts.drill === "kill-a" || opts.drill === "kill-c") ? () => opts.kill!("before-first-byte", turn) : undefined,
      onFirstText: isKill && opts.drill === "kill-b" ? () => opts.kill!("after-first-byte", turn) : undefined,
    });
    if (outcome.text.length > 0) messages.push({ role: "assistant", content: outcome.text });
    opts.out(
      benchResultRow({
        callId, arm: opts.arm, turn, turnId, assertion: assertTurn(turn, outcome.text), clientFirstTextMs: outcome.firstTextMs, clientTotalMs: outcome.totalMs,
        textLength: outcome.text.length, status: outcome.status, finish: outcome.finish, ...(isKill ? { drill: opts.drill } : extra),
      }),
    );
    await sleep(250); // caller think-time; keeps turns strictly sequential like a real call
  };
  if (opts.drill === "double-request") {
    // V9: turn 1 and turn 2 posted without awaiting — the second must wait on the pending opening.
    await Promise.all([runTurn(BENCH_SCRIPT[0]!, { drill: "double-request" }), runTurn(BENCH_SCRIPT[1]!, { drill: "double-request" })]);
    for (const turn of BENCH_SCRIPT.slice(2)) await runTurn(turn);
    return callId;
  }
  for (const turn of BENCH_SCRIPT) await runTurn(turn);
  return callId;
}

async function operatorKillPrompt(phase: string, turn: BenchTurn): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Note: this kill-drill instruction assumes a quiet window (Task E3) — pgrep finding wrong process is a real risk
  // if other agents are live, which is exactly why the quiet window is a precondition, not a suggestion.
  process.stderr.write(
    `\n[kill drill] phase=${phase} turn=${turn.index}. Identify the lease's CLI child NOW, e.g.\n` +
      `  pgrep -P <engine-pid> -nf claude-agent-sdk   # newest matching child of the engine\n` +
      `and kill exactly that pid (kill -9 <pid>). Press Enter when done.\n`,
  );
  await new Promise<void>((r) => rl.question("", () => r()));
  rl.close();
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      arm: { type: "string" },
      agent: { type: "string", default: "mokie-bench" },
      calls: { type: "string", default: "8" },
      out: { type: "string" },
      "base-url": { type: "string" },
      drill: { type: "string" },
      warmup: { type: "boolean", default: false },
      goal: { type: "string", default: "KPR-465 engine bench" },
      context: { type: "string", default: "Scripted latency bench. Answer briefly." },
    },
  });
  if (!values.arm || !values.out) {
    process.stderr.write("usage: voice-engine-bench --arm <label> --out <jsonl> [--agent mokie-bench] [--calls 8] [--base-url http://127.0.0.1:<port>] [--drill double-request|concurrent-3|kill-a|kill-b|kill-c] [--warmup]\n");
    return 2;
  }
  if (values.drill && !DRILLS.includes(values.drill as Drill)) {
    process.stderr.write(`unknown drill ${values.drill}\n`);
    return 2;
  }
  // Late import: config.ts loads hive.yaml/.env/Honeypot from HIVE_HOME; keep the module importable by tests without it.
  const { config } = await import("../src/config.js");
  const token = config.voice.bridgeToken;
  if (!token) {
    process.stderr.write("HIVE_VOICE_BRIDGE_TOKEN is not configured for this instance\n");
    return 2;
  }
  const baseUrl = values["base-url"] ?? `http://127.0.0.1:${config.voice.port}`;
  const workerBootId = randomUUID();
  writeFileSync(values.out, `${JSON.stringify({ run: true, script: BENCH_SCRIPT_VERSION, arm: values.arm, agent: values.agent, workerBootId, startedAt: new Date().toISOString(), calls: Number(values.calls), drill: values.drill ?? null, warmup: values.warmup })}\n`);
  const opts: BenchOptions = {
    baseUrl,
    token,
    agentId: values.agent!,
    arm: values.arm,
    goal: values.goal!,
    context: values.context!,
    workerBootId,
    out: (row) => appendFileSync(values.out!, `${JSON.stringify(row)}\n`),
    drill: values.drill as Drill | undefined,
    kill: operatorKillPrompt,
  };
  const callIds: string[] = [];
  if (values.warmup) {
    // §6.2: the first turn after a restart is a discarded warm-up — its own call id, not passed to the reader.
    const warmId = `bench-${values.arm}-warmup-${randomUUID().slice(0, 8)}`;
    await postTurn(opts, buildBridgeRequest({ callId: warmId, agentId: opts.agentId, goal: opts.goal, context: opts.context, messages: [{ role: "user", content: BENCH_SCRIPT[0]!.text }], workerBootId, turnId: randomUUID() }), {});
    process.stderr.write(`warm-up call ${warmId} discarded\n`);
  }
  if (values.drill === "concurrent-3") {
    const ids = await Promise.all([1, 2, 3].map(() => runBenchCall({ ...opts, drill: undefined })));
    callIds.push(...ids);
  } else {
    const n = Number.parseInt(values.calls!, 10);
    for (let i = 0; i < n; i += 1) callIds.push(await runBenchCall(opts));
  }
  process.stderr.write(`bench complete: ${callIds.length} call(s)\n${callIds.map((id) => `  --call ${id}=${values.arm}`).join("\n")}\n`);
  return 0;
}

export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
```

- [ ] **Step 2: Typecheck; commit.**

```bash
npx tsc --noEmit
git add scripts/voice-engine-bench.ts
git commit -m "feat(voice): voice-engine-bench loopback CLI with barge-in, double-request, concurrency and kill drills (KPR-465)"
```

### Task D3: R6 loopback test against the real adapter

**Files:**
- Create: `src/channels/voice/testing/adapter-fixture.ts` (extract `makeAdapter`/`postChatCompletion`-style helpers from `voice-adapter.integration.test.ts`, behavior-preserving; the integration test imports them back)
- Create: `scripts/voice-engine-bench.test.ts`

- [ ] **Step 1: Extract the adapter fixture.** Move `makeAdapter` (with its fake registry/memory-manager/agent-manager wiring and the `engineRows()` trace-row accessor) into the new module, exported; keep `voice-adapter.integration.test.ts` green by importing them. No behavior change; commit separately: `refactor(voice): extract the loopback adapter fixture for reuse (KPR-465)`.

- [ ] **Step 2: Bench test.**

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
// Same file-level mocks as voice-adapter.integration.test.ts (logger, SDK, prompt-builder, config) — copy verbatim.
import { makeAdapter, engineRows, BRIDGE_TOKEN } from "../src/channels/voice/testing/adapter-fixture.js";
import { runBenchCall, type BenchOptions } from "./voice-engine-bench.js";
import { BENCH_SCRIPT } from "../src/voice/voice-bench-script.js";
import type { TurnContext, TurnResult } from "../src/agents/agent-manager.js";
import { randomUUID } from "node:crypto";

const CANNED: Record<number, string> = {
  1: "Hi, this is the bench agent.", 2: "A leap year has 366 days.", 3: "The capital of Japan is Tokyo.", 4: "There are 180 minutes in three hours.",
  5: "A leap year exists because the orbit takes about 365 and a quarter days, so the calendar would drift; adding a day in February every four years fixes it.",
  6: "The number was 366.", 7: "I searched and found no results for that phrase.", 8: "Zero results.", 9: "A hexagon has six sides.", 10: "Goodbye, take care.",
};
function turnIndexOf(ctx: TurnContext): number {
  const last = ctx.voicePrompt?.latestUserMessage ?? ctx.workItem.text;
  return BENCH_SCRIPT.find((t) => last.includes(t.text))?.index ?? 1;
}
function scriptedSpawn(delayMs = 20) {
  return async (ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
    const i = turnIndexOf(ctx);
    const text = CANNED[i]!;
    await new Promise((r) => setTimeout(r, delayMs));
    for (const word of text.split(" ")) {
      onStream?.(`${word} `);
      await new Promise((r) => setTimeout(r, 5));
    }
    return {
      finalMessage: text, newSessionId: "s", errors: [], llmMs: 10, toolMs: i === 7 || i === 8 ? 300 : 0, toolCalls: i === 7 || i === 8 ? 1 : 0, toolSummary: null,
      toolAckInjected: 0, streamed: true, compactions: 0,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 200000, costUsd: 0, durationMs: 10 },
      stageTimings: { lockWaitMs: 0, spawnPrepMs: 1, bootToInitMs: 600, initToFirstTokenMs: 900 },
    };
  };
}

describe("voice-engine-bench against the real adapter (R6)", () => {
  const rows: Record<string, unknown>[] = [];
  let stop: () => void = () => {};
  let opts: BenchOptions;
  beforeEach(async () => {
    rows.length = 0;
    const a = await makeAdapter({ spawn: scriptedSpawn() });
    stop = () => a.adapter.stop();
    opts = { baseUrl: `http://127.0.0.1:${a.port}`, token: BRIDGE_TOKEN, agentId: "mokie", arm: "A0-cold", goal: "g", context: "x", workerBootId: randomUUID(), out: (r) => rows.push(r), sleep: async () => {} };
  });
  afterEach(() => stop());

  it("posts ten turns with the worker's shape, records assertions, closes twice for barge-in, never writes text or the token", async () => {
    const callId = await runBenchCall(opts, "bench-r6");
    expect(callId).toBe("bench-r6");
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.turnIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.filter((r) => r.finish === "closed").map((r) => r.turnIndex)).toEqual([5, 7]);
    expect(rows.filter((r) => r.expectsTool).map((r) => r.turnIndex)).toEqual([7, 8]);
    expect(rows.find((r) => r.turnIndex === 2)!.keywordPass).toBe(true);
    expect(rows.find((r) => r.turnIndex === 1)!.keywordPass).toBeNull();
    const received = engineRows("engine_received").filter((r) => r.callId === "bench-r6");
    expect(received).toHaveLength(10);
    expect(received.every((r) => r.correlation === "worker")).toBe(true);
    expect(new Set(received.map((r) => r.turnId)).size).toBe(10);
    const terminals = engineRows("engine_attempt_terminal").filter((r) => r.callId === "bench-r6");
    expect(terminals.filter((r) => r.outcome === "cancelled")).toHaveLength(2);
    expect(terminals.find((r) => r.turnId === rows.find((x) => x.turnIndex === 8)!.turnId)!.toolCount).toBe(1);
    const dump = JSON.stringify(rows);
    for (const s of [BRIDGE_TOKEN, ...Object.values(CANNED), "g\"", "hive_agent_id"]) expect(dump).not.toContain(s);
  });

  it("double-request: turn 2 is posted before turn 1 settles and both complete", async () => {
    await runBenchCall({ ...opts, drill: "double-request" }, "bench-dbl");
    expect(rows.filter((r) => r.drill === "double-request")).toHaveLength(2);
    expect(engineRows("engine_received").filter((r) => r.callId === "bench-dbl")).toHaveLength(10);
  });

  it("three concurrent calls keep their ids and rows apart", async () => {
    const ids = await Promise.all(["c1", "c2", "c3"].map((id) => runBenchCall(opts, `bench-${id}`)));
    for (const id of ids) expect(rows.filter((r) => r.callId === id)).toHaveLength(10);
  });

  it.each([["kill-a", "before-first-byte", 3], ["kill-b", "after-first-byte", 3], ["kill-c", "before-first-byte", 1]] as const)(
    "%s fires the kill hook exactly once at %s on turn %d and tags the row",
    async (drill, phase, turnIndex) => {
      const kill = vi.fn(async () => {});
      await runBenchCall({ ...opts, drill, kill }, `bench-${drill}`);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls[0]![0]).toBe(phase);
      expect(kill.mock.calls[0]![1].index).toBe(turnIndex);
      expect(rows.find((r) => r.drill === drill)!.turnIndex).toBe(turnIndex);
    },
  );
});
```

(The adapter resolves the agent through the fixture's fake registry; use the id the fixture registers — `"mokie"` in `voice-startup.integration.test.ts`, whatever `makeAdapter` registers here. The bench's `--agent` default `mokie-bench` is an operator concern.)

- [ ] **Step 3: Verify and commit.**

Run: `npx vitest run scripts/voice-engine-bench.test.ts src/channels/voice/voice-adapter.integration.test.ts --reporter=verbose` — pass.

```bash
git add scripts/voice-engine-bench.test.ts src/channels/voice/testing/adapter-fixture.ts src/channels/voice/voice-adapter.integration.test.ts
git commit -m "test(voice): R6 loopback bench run against the real adapter (KPR-465)"
```

### Task D4 (CONDITIONAL — build only after chunk E Task E3 names the EOU stage): `voice.livekit.endpointing`

**Files:**
- Modify: `src/config.ts:221-260` (`VoiceLivekitConfig`, `resolveVoiceLivekitConfig`)
- Modify: `src/voice-worker/worker-config.ts:12-70`
- Modify: `src/voice-worker/session.ts:204-211`, `:495`
- Modify: `src/voice/voice-trace.ts` (`CallPayload`), `src/voice/voice-diagnostic-reader.ts` (`PAYLOAD_FIELDS.session_started`, validation)
- Test: `src/config.test.ts`, `src/voice-worker/worker-config.test.ts`, `src/voice-worker/session.test.ts`, `src/voice-worker/deps.smoke.test.ts`, `src/voice/voice-diagnostic-reader.test.ts`

- [ ] **Step 1: One liberal-loader key in `config.ts` (raw passthrough; the engine never reads it).**

```typescript
export interface VoiceLivekitConfig {
  // ... existing fields ...
  /**
   * KPR-465 §4.1 (conditional lever): raw `voice.livekit.endpointing` value.
   * Deliberately NOT validated here — the engine process never consumes it;
   * the voice worker validates it at its own config load (worker-config.ts)
   * so a bad value fails the worker with a clear error and never the engine.
   */
  endpointing: unknown;
}
// in resolveVoiceLivekitConfig's return:
    endpointing: src.endpointing,
```

- [ ] **Step 2: Worker-side validation and threading.**

```typescript
export interface VoiceEndpointingConfig {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * KPR-465 §4.1: validate `voice.livekit.endpointing`. undefined ⇒ absent (SDK
 * defaults, byte-identical session options). Anything else must be an object
 * with optional integer minDelayMs/maxDelayMs in [0, 10000], min ≤ max.
 * Throws with the key name — this runs at worker boot ("rejected at load").
 */
export function resolveVoiceEndpointingConfig(raw: unknown): VoiceEndpointingConfig | undefined {
  if (raw === undefined) return undefined;
  const fail = (why: string): never => {
    throw new Error(`voice.livekit.endpointing: ${why}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("must be an object with minDelayMs and/or maxDelayMs");
  const src = raw as Record<string, unknown>;
  const out: VoiceEndpointingConfig = {};
  for (const key of ["minDelayMs", "maxDelayMs"] as const) {
    if (src[key] === undefined) continue;
    const v = src[key];
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 10_000) return fail(`${key} must be an integer in [0, 10000]`);
    out[key] = v as number;
  }
  if (out.minDelayMs !== undefined && out.maxDelayMs !== undefined && out.minDelayMs > out.maxDelayMs) {
    return fail("minDelayMs must be ≤ maxDelayMs");
  }
  if (out.minDelayMs === undefined && out.maxDelayMs === undefined) return undefined; // {} ⇒ absent
  return out;
}
```

`WorkerConfig` gains `endpointing?: VoiceEndpointingConfig;` and `loadWorkerConfig` sets `endpointing: resolveVoiceEndpointingConfig(lk.endpointing),` (keep the object literal's `satisfies`/type intact; the key is optional and undefined when absent).

- [ ] **Step 3: `session.ts` — option spread and stamp.**

Replace lines 204–211:

```typescript
  const turnDetection = cell.stt === "deepgram/flux-general-en" ? "stt" : "vad";
  // KPR-465 §4.1: absent ⇒ no `endpointing` key at all (byte-identical to
  // pre-465 options); present ⇒ only the configured sub-keys, so the SDK
  // resolves the rest from its own defaults per detector.
  const endpointing =
    wc.endpointing === undefined
      ? undefined
      : {
          ...(wc.endpointing.minDelayMs !== undefined ? { minDelay: wc.endpointing.minDelayMs } : {}),
          ...(wc.endpointing.maxDelayMs !== undefined ? { maxDelay: wc.endpointing.maxDelayMs } : {}),
        };
  const session = new voice.AgentSession({
    stt: buildStt(cell, wc.deepgramApiKey),
    tts: ttsProvider,
    vad,
    llm: hiveLLM,
    turnHandling: { turnDetection, ...(endpointing ? { endpointing } : {}) },
    ttsTextTransforms: ["filter_markdown", "filter_emoji", hiveTtsNormalize],
  });
```

and the stamp at line 495:

```typescript
    speechTrace.call({
      event: "session_started",
      turnDetection,
      // Effective values: configured override, else the pinned SDK default for
      // the fixed-mode string detector (1.6.4: 500 / 3000 — the streaming set
      // 300 / 2500 is NOT selected by turnDetection "stt", spec §2).
      endpointingMinDelayMs: endpointing?.minDelay ?? voice.defaultEndpointingOptions.minDelay,
      endpointingMaxDelayMs: endpointing?.maxDelay ?? voice.defaultEndpointingOptions.maxDelay,
    });
```

- [ ] **Step 4: Schema + reader.**

`voice-trace.ts` `CallPayload` gains:

```typescript
  turnDetection?: "stt" | "vad";
  endpointingMinDelayMs?: number;
  endpointingMaxDelayMs?: number;
```

Reader: `session_started: ["direction", "intendedParticipant", "turnDetection", "endpointingMinDelayMs", "endpointingMaxDelayMs"]`; add `"endpointingMinDelayMs", "endpointingMaxDelayMs"` to the `nonnegativeInteger` field loop; add `if ("turnDetection" in value && value.turnDetection !== undefined && !["stt", "vad"].includes(String(value.turnDetection))) return false;`.

- [ ] **Step 5: Tests.**

`src/config.test.ts` (in the `resolveVoiceLivekitConfig` describe): `expect(resolveVoiceLivekitConfig({ endpointing: { minDelayMs: 300 } }).endpointing).toEqual({ minDelayMs: 300 }); expect(resolveVoiceLivekitConfig({}).endpointing).toBeUndefined(); expect(resolveVoiceLivekitConfig({ endpointing: "garbage" }).endpointing).toBe("garbage"); // engine never validates`.

`src/voice-worker/worker-config.test.ts`:

```typescript
describe("resolveVoiceEndpointingConfig (KPR-465)", () => {
  it("absent or empty ⇒ undefined", () => {
    expect(resolveVoiceEndpointingConfig(undefined)).toBeUndefined();
    expect(resolveVoiceEndpointingConfig({})).toBeUndefined();
  });
  it("accepts integer sub-keys in range with min ≤ max", () => {
    expect(resolveVoiceEndpointingConfig({ minDelayMs: 300 })).toEqual({ minDelayMs: 300 });
    expect(resolveVoiceEndpointingConfig({ minDelayMs: 300, maxDelayMs: 2500 })).toEqual({ minDelayMs: 300, maxDelayMs: 2500 });
  });
  it.each([["garbage"], [{ minDelayMs: -1 }], [{ minDelayMs: 600, maxDelayMs: 500 }], [{ minDelayMs: 20000 }], [{ minDelayMs: "300" }], [[300]]])(
    "rejects %j with a clear error naming the key",
    (raw) => expect(() => resolveVoiceEndpointingConfig(raw)).toThrow(/^voice\.livekit\.endpointing: /),
  );
});
```

`src/voice-worker/session.test.ts`: in the `voice` mock add `defaultEndpointingOptions: { mode: "fixed", minDelay: 500, maxDelay: 3000, alpha: 0.9 }` and capture ctor options (`constructor(options: unknown) { super(); sdkState.ctorOptions.push(options); ... }`), then:

```typescript
  it("KPR-465 R4: no endpointing key ⇒ AgentSession options byte-identical (turnHandling is exactly { turnDetection: 'stt' }) and session_started stamps SDK defaults", async () => {
    await runScriptedCall({ wc: baseWc }); // the file's existing runCallSession driver
    const ctor = sdkState.ctorOptions[0] as { turnHandling: unknown };
    expect(ctor.turnHandling).toEqual({ turnDetection: "stt" });
    expect(traceRowsFor("session_started")[0]).toMatchObject({ turnDetection: "stt", endpointingMinDelayMs: 500, endpointingMaxDelayMs: 3000 });
  });
  it("KPR-465 R4: endpointing key ⇒ turnHandling.endpointing carries only the configured sub-keys and the stamp reflects them", async () => {
    await runScriptedCall({ wc: { ...baseWc, endpointing: { minDelayMs: 300 } } });
    const ctor = sdkState.ctorOptions[0] as { turnHandling: unknown };
    expect(ctor.turnHandling).toEqual({ turnDetection: "stt", endpointing: { minDelay: 300 } });
    expect(traceRowsFor("session_started")[0]).toMatchObject({ endpointingMinDelayMs: 300, endpointingMaxDelayMs: 3000 });
  });
```

(`runScriptedCall`/`traceRowsFor` stand for the file's existing `runCallSession` driver and trace-row accessor at ~599–700 — use their real names.)

`src/voice-worker/deps.smoke.test.ts`: `import { voice } from "@livekit/agents"; it("pins 1.6.4 default endpointing (spec §2)", () => expect(voice.defaultEndpointingOptions).toMatchObject({ mode: "fixed", minDelay: 500, maxDelay: 3000 }));`

Reader test: `session_started` with the three keys parses; `turnDetection: "manual"` rejected; `endpointingMinDelayMs: -5` rejected.

- [ ] **Step 6: Verify and commit.**

Run: `npx vitest run src/config.test.ts src/voice-worker/worker-config.test.ts src/voice-worker/session.test.ts src/voice-worker/deps.smoke.test.ts src/voice/voice-diagnostic-reader.test.ts` — pass. Negative-verify: remove the `...(endpointing ? {endpointing} : {})` spread → the second R4 case fails; restore.

```bash
git add src/config.ts src/config.test.ts src/voice-worker/worker-config.ts src/voice-worker/worker-config.test.ts src/voice-worker/session.ts src/voice-worker/session.test.ts src/voice-worker/deps.smoke.test.ts src/voice/voice-trace.ts src/voice/voice-diagnostic-reader.ts src/voice/voice-diagnostic-reader.test.ts
git commit -m "feat(voice-worker): conditional voice.livekit.endpointing lever with session_started stamp (KPR-465 A3)"
```

If Task E3's decomposition does NOT name the EOU stage, this task is not executed; record "A3 not built — EOU stage ranked <n> after A2" in the evidence record and leave every file above untouched.

### Task D5 (LIVE-INSTANCE runbook, not code): the contained `mokie-bench` clone

This task runs only inside a chunk E quiet window (Task E3). Nothing here is executed by tests. It is written here because the clone is the bench's target and its containment claims belong beside the bench.

- [ ] **Step 1: Definition (create immediately before a bench block, via the admin MCP `agent_create` driven by the CoS, or `POST /admin/agents` with `ADMIN_API_TOKEN`).** Copy `model`, `soul`, `systemPrompt`, `timeoutMs` from Mokie's current definition (`agent_get mokie`); everything else is fixed:

```json
{
  "_id": "mokie-bench",
  "name": "Mokie (bench)",
  "model": "<Mokie's model verbatim>",
  "homeBase": "none",
  "roles": ["Bench stand-in (KPR-465) — do not message"],
  "disabled": false,
  "soul": "<Mokie's soul verbatim>",
  "systemPrompt": "<Mokie's systemPrompt verbatim>",
  "timeoutMs": "<Mokie's timeoutMs verbatim>",
  "spawnBudget": 5,
  "channels": [],
  "passiveChannels": [],
  "schedule": [],
  "coreServers": ["memory", "structured-memory", "conversation-search"],
  "delegateServers": []
}
```

Per arm: A0/A1 → no `effort` key; A2 → `effort: "medium"` (then `"low"` only under the spec §4 A2 rule) via `agent_update`. `contacts` is deliberately absent (`contacts_create`/`contacts_update` write dodi's live collection). Nothing from `WORKER_SERVER_DENYLIST` (`src/workers/meeting-worker-pool.ts:54`) and no vendor write surface is on the list.

- [ ] **Step 2: Quiescence pre-check.** Run the same quiescence check as chunk E's Task E3 Step 2 (mongosh query against `spawn_coordinator_stats`/`meeting_worker_claims`) immediately before creating the clone. Proceed only if every row shows `activeSpawns: 0` and `warmVoiceSessions: 0`, and `running claims: 0`, and no live call is up — see spec §6.2 and chunk E Task E3 Step 2 for the exact command and accepted residuals.

- [ ] **Step 2b: Containment, stated honestly (spec §4.2).** The clone runs on an ordinary `AgentRunner`; the four auto-injected servers (`team`, `schedule`, `team-roster`, `skill-author`) cannot be stripped (only worker-mode runners set `suppressAutoInjectedServers`). Containment rests on the fixed script (no line asks for a message, a schedule, or a skill) and the delete window. After `agent_create`: `kill -USR1 <engine-pid>`; readback `agent_get mokie-bench` and record `coreServers`, `channels`, `effort`, `disabled`.

- [ ] **Step 3: Delete-time checks (record each in the evidence record, with UTC timestamps):**

  - [ ] **(3a) Confirm the `team_messages` sender field name first:** Run this query before the count query below to identify the actual field name:
```bash
mongosh "$MONGO_URI" --quiet --eval 'db.team_messages.findOne({}, {fromAgentId:1, senderId:1, agentId:1})'
```
Use whichever field is actually present (likely `fromAgentId` or `senderId`) as the field name in check (1) below.

  - [ ] **(1) No message FROM the clone beyond the scripted lookup exchange** — use the field name confirmed in (3a):
```bash
mongosh "$MONGO_URI" --quiet --eval 'db.team_messages.countDocuments({ <field-name-from-3a>: "mokie-bench" })'
```
Expected: `0`

  - [ ] **(2) The clone's own schedule is empty** — read back via `agent_get` immediately before delete; also:
```bash
mongosh "$MONGO_URI" --quiet --eval 'db.agent_definitions.findOne({ _id: "mokie-bench" }, { schedule: 1 })'
```
Expected: `{ _id: "mokie-bench", schedule: [] }`

  - [ ] **(3) No on-disk agent dir** (skill-author is a real stdio subprocess that could write here):
```bash
ls -la "$HIVE_HOME/agents/mokie-bench" 2>&1
```
Expected: `No such file or directory`; if present: record contents, `rm -rf`, record removal.

**If any check does not match the expected result, do not proceed to `agent_delete` — record the discrepancy (values observed, timestamp) and escalate to the CoS for a decision before continuing.**

Then, when all checks pass: `agent_delete mokie-bench confirm=true` → `kill -USR1 <engine-pid>` → `agent_list` readback shows no `mokie-bench`.

- [ ] **Step 4: Accepted residuals (record, do not fix):** `memory`/`memory_versions`/`agent_memory` rows keyed `mokie-bench` have no TTL and remain; `sessions` rows expire under the 7-day TTL; one fleet-wide team-summary prefix invalidation on create and one on delete (KPR-432/434 cost class) — both inside the quiet window. A clone found by any later session is deleted, never reused.

- [ ] **Step 5: Bench invocation (from the instance dir so `config.ts` finds `hive.yaml`/`.env`/Honeypot):**

```bash
cd ~/services/hive/dodi
npx tsx ~/github/hive/scripts/voice-engine-bench.ts --arm A0-cold --out /tmp/kpr465/A0-cold.jsonl --calls 8 --warmup
# drills, one invocation each (kill drills prompt for the pid):
npx tsx ~/github/hive/scripts/voice-engine-bench.ts --arm A1-warm --out /tmp/kpr465/A1-warm-dbl.jsonl --drill double-request
npx tsx ~/github/hive/scripts/voice-engine-bench.ts --arm A1-warm --out /tmp/kpr465/A1-warm-c3.jsonl --drill concurrent-3
npx tsx ~/github/hive/scripts/voice-engine-bench.ts --arm A1-warm --out /tmp/kpr465/A1-warm-kill-a.jsonl --drill kill-a
```

(Paths are examples; the engine used is the running dodi engine per spec §6.2's "no separately booted engine" ruling. The `voice_diagnostic` rows are read from the instance `hive.log` filtered by the printed call ids and fed to `scripts/voice-latency-compare.ts` with the engine-log cross-check.)

### Task D6: Chunk gate (D1–D3)

- [ ] `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0 after D3; again after D4 if it is built.
- [ ] Record: the R6 pass list, the extraction refactor's before/after pass list for `voice-adapter.integration.test.ts`, and (if built) the R4 negative-verify.
