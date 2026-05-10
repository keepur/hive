# Voice-Adapter → Claude Agent SDK Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Ticket:** [KPR-207](https://linear.app/keepur/issue/KPR-207/refactor-voice-adapter-to-claude-agent-sdk-oauth-path)
**Builds on:** [PR #249](https://github.com/keepur/hive/pull/249) (voice-adapter auth model)

**Goal:** Replace voice-adapter's raw `@anthropic-ai/sdk` calls with `@anthropic-ai/claude-agent-sdk`'s `query()` so voice runs on the operator's Claude subscription (OAuth) instead of requiring a separate `ANTHROPIC_API_KEY`.

**Architecture:** Voice adapter no longer constructs an `Anthropic` client. For each `POST /v1/chat/completions` it calls `query({ prompt, options: { systemPrompt, model, maxTurns: 1, settingSources: [], permissionMode: "bypassPermissions", extraArgs: { "strict-mcp-config": null } } })` and translates the SDK's `stream_event` messages into OpenAI-format SSE chunks for Vapi. Only `content_block_delta` events with `delta.type === "text_delta"` are forwarded; `tool_use`, `thinking`, and other content-block types are filtered. Conversation history from Vapi's request is rendered into the user prompt as a transcript block; no SDK session reuse across turns (each turn is a fresh `query()`). No MCP servers, no hooks, no agent-runner overhead — voice is a single-turn dispatcher, not a full agent session.

**Latency budget:** First-`text_delta` arrival time is logged on every call. Acceptance gate is p50 < 1.5s across ≥5 real calls on the dodi mac mini. If exceeded, the design is revisited (likely SDK-session-resume per Vapi call), not shipped anyway.

**OAuth-absent behavior:** If `query()` fails because `~/.claude/.credentials.json` is missing/unreadable, the adapter returns HTTP 503 `{"error":"Voice unavailable"}` with an error-level log line. No silent fallback, no mid-stream crash.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (already a hive dependency, used by `AgentRunner`), Node `http` server (unchanged).

## Testing Contract

### Required Test Groups

- **Unit:** required
  - Scope: `renderConversationPrompt()` — the new helper that turns Vapi's OpenAI-format `messages[]` into a single transcript-style prompt for `query()`.
  - Reason: pure transformation, easy to unit test, regression risk if Vapi changes message shape.
  - Minimum assertions:
    - System messages are filtered out (system prompt comes via `systemPrompt` option, not the rendered transcript).
    - Final user message is the "respond to this" anchor.
    - Empty/single-message conversations don't crash.
    - Tool messages (if any sneak through) are skipped without throwing.

- **Integration:** not-required
  - Reason: the SDK's `query()` function spawns a `claude` CLI subprocess and depends on the operator's OAuth credentials. Mocking `query()` couples tests to SDK internals; running the real CLI in CI would burn subscription budget on every PR. Smoke verification is done manually against the dodi instance per the verify step below.

- **E2E:** not-required
  - Reason: covered by the manual Vapi end-to-end smoke (calling `+1 650-729-6067`), which is the actual acceptance criterion. Automating this would require a full Vapi sandbox account in CI plus phone-number provisioning — disproportionate cost.

### Critical Flows

- `POST /v1/chat/completions` with `stream: true` (Vapi default) → SSE stream of `data: {…delta…}` chunks → terminating `data: [DONE]`.
- `POST /v1/chat/completions` with `stream: false` → single JSON body in OpenAI chat-completion shape.
- `GET /health` (unchanged).
- Webhook auth path (paths other than `/v1/chat/completions`) (unchanged).

### Regression Surface

- `src/agents/agent-runner.ts` — must not regress (we are NOT modifying it; we are using the same SDK it does).
- `src/agents/prompt-builder.ts` `buildVoiceSystemPrompt` — must keep its current signature; we still call it.
- `src/index.ts` voice-adapter wiring — `new VoiceAdapter(port, secret, registry, memoryManager)` constructor signature stays the same.
- PR #249's auth model — unchanged. Body-based auth on `/v1/chat/completions`, shared-secret on everything else.

### Commands

- Unit: `npx vitest run src/channels/voice` (project uses Vitest)
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Manual smoke (post-deploy):
  ```
  npm run bundle
  cp pkg/server.min.js ~/services/hive/dodi/.hive/pkg/server.min.js
  launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent
  # Then place a real call via Vapi dashboard "Talk" button on Mokie assistant
  # OR phone the assigned number after Inbound Settings → Assistant = Mokie
  ```

### Harness Requirements

- Vitest harness already configured (no new setup).
- Manual smoke: dodi instance must be running with the patched bundle. No new infra.

### Non-Required Rationale

- Integration: see above — would either mock to meaninglessness or burn real subscription budget.
- E2E: see above — disproportionate setup cost vs. the easy manual smoke that's the actual acceptance test.

### Verification Rules

- Missing harness is not a skip reason. The Vitest harness exists; if a unit test fails, fix the implementation.
- If a unit test exposes a Vapi message-shape assumption that's wrong, demote to spec lane and verify against a real captured request from `/tmp/vapi-call*.log`.
- Manual smoke must produce a real two-way conversation before claiming KPR-207 done.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/channels/voice/voice-adapter.ts` | HTTP server + auth + dispatch loop | Modify — replace `Anthropic` calls with `query()` |
| `src/channels/voice/conversation-prompt.ts` | NEW — render Vapi messages → transcript prompt | Create |
| `src/channels/voice/conversation-prompt.test.ts` | Unit tests for the renderer | Create |
| `src/channels/voice/openai-translator.ts` | OpenAI ↔ Claude format helpers | Unchanged — see note below |

`openai-translator.ts` is **not modified** by this plan. `openaiToClaude` and `openaiToolsToClaude` remain as-is — unused by the new flow but kept as a Phase-2 placeholder (matches the deferred-tools posture in the spec). Removing them is a separate cleanup, not in scope here.

No changes to `src/index.ts` (constructor signature unchanged) or `src/agents/prompt-builder.ts`.

## Branch state

KPR-207 has been **rebased onto `voice-adapter-auth-rework`** (PR #249's branch) so the body-based auth model on `POST /v1/chat/completions` is present in the working tree. The smoke commands in Task 3 use `Authorization: Bearer no-credentials-provided` — this only succeeds because #249's auth-by-`assistant.id` rule is in place. After #249 merges to `main`, this branch will rebase cleanly off `main` (the auth commit drops because it's already there).

If the implementer is starting from a clean clone, run:

```bash
cd /Users/mokie/github/hive-KPR-207
git log --oneline main..HEAD
# Expected: at least
#   c286de2 fix(voice): support Vapi Custom LLM auth model + add diag logging
```

If that commit isn't present, rebase first: `git rebase voice-adapter-auth-rework`.

---

## Tasks

### Task 1: Conversation-prompt renderer

**Files:**
- Create: `src/channels/voice/conversation-prompt.ts`
- Create: `src/channels/voice/conversation-prompt.test.ts`

- [ ] **Step 1:** Write the renderer.

```typescript
// src/channels/voice/conversation-prompt.ts
import type { OpenAIChatRequest } from "./openai-translator.js";

/**
 * Render Vapi's OpenAI-format messages array into a single user prompt
 * suitable for `query()`. The system message is dropped (delivered via
 * the `systemPrompt` option). Tool messages are skipped (Phase-2 concern).
 *
 * Format chosen for readability by the Claude side: a transcript with
 * speaker labels, ending with an explicit instruction to respond to the
 * latest caller turn. Vapi sends the full history on every turn, so we
 * render it all every time and skip SDK session resume — keeps state
 * machine simple at the cost of a few extra cache-creation tokens per
 * turn (negligible for short voice calls).
 */
export function renderConversationPrompt(messages: OpenAIChatRequest["messages"]): string {
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const speaker = m.role === "user" ? "Caller" : "You";
      const content = typeof m.content === "string" ? m.content : "";
      return `${speaker}: ${content}`;
    });

  if (turns.length === 0) {
    // Edge case: Vapi calls /v1/chat/completions with only the system message
    // (e.g., at call start when "Assistant speaks first"). Just prompt the
    // agent to begin.
    return "The caller has just connected. Greet them as the agent.";
  }

  return [
    "The phone call so far (transcribed live):",
    "",
    ...turns,
    "",
    "Respond to the caller's most recent message above. Keep it conversational and short — you are speaking, not writing.",
  ].join("\n");
}
```

- [ ] **Step 2:** Write the tests.

```typescript
// src/channels/voice/conversation-prompt.test.ts
import { describe, it, expect } from "vitest";
import { renderConversationPrompt } from "./conversation-prompt.js";

describe("renderConversationPrompt", () => {
  it("filters out system messages", () => {
    const out = renderConversationPrompt([
      { role: "system", content: "you are an assistant" },
      { role: "user", content: "hi" },
    ]);
    expect(out).not.toContain("you are an assistant");
    expect(out).toContain("Caller: hi");
  });

  it("labels speakers as Caller and You", () => {
    const out = renderConversationPrompt([
      { role: "user", content: "hello?" },
      { role: "assistant", content: "hey there" },
      { role: "user", content: "who is this" },
    ]);
    expect(out).toContain("Caller: hello?");
    expect(out).toContain("You: hey there");
    expect(out).toContain("Caller: who is this");
  });

  it("ends with a respond-to-latest instruction", () => {
    const out = renderConversationPrompt([{ role: "user", content: "hi" }]);
    expect(out.toLowerCase()).toContain("respond to the caller");
  });

  it("handles empty / system-only conversations with a greet prompt", () => {
    expect(renderConversationPrompt([])).toMatch(/greet|connected/i);
    expect(
      renderConversationPrompt([{ role: "system", content: "x" }]),
    ).toMatch(/greet|connected/i);
  });

  it("skips tool messages without throwing", () => {
    const out = renderConversationPrompt([
      { role: "user", content: "what's my balance" },
      { role: "tool", content: "balance: $42" } as any,
      { role: "assistant", content: "you have $42" },
    ]);
    expect(out).not.toContain("balance: $42");
    expect(out).toContain("Caller: what's my balance");
    expect(out).toContain("You: you have $42");
  });
});
```

- [ ] **Step 3:** Verify.

```bash
cd /Users/mokie/github/hive-KPR-207
npx vitest run src/channels/voice/conversation-prompt
```

Expected: 5 passing tests, no failures.

- [ ] **Step 4:** Commit.

```bash
git add src/channels/voice/conversation-prompt.ts src/channels/voice/conversation-prompt.test.ts
git commit -m "feat(voice): add conversation-prompt renderer for SDK refactor (KPR-207)"
```

---

### Task 2: Swap voice-adapter to `query()`

**Files:**
- Modify: `src/channels/voice/voice-adapter.ts`

- [ ] **Step 1:** Replace the Anthropic SDK import with the agent SDK.

Find the existing imports near the top of the file. Replace:

```typescript
import Anthropic from "@anthropic-ai/sdk";
```

with:

```typescript
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { renderConversationPrompt } from "./conversation-prompt.js";
import { config } from "../../config.js";
```

(Note: `config` import may already exist — leave the existing one if so.)

Drop the now-unused translator imports:

```typescript
// Remove these from the existing import block:
import {
  openaiToClaude,
  openaiToolsToClaude,
  formatSSETextChunk,
  formatSSEDone,
  formatNonStreamingResponse,
  type OpenAIChatRequest,
} from "./openai-translator.js";
```

Replace with the slimmer set we still need:

```typescript
import {
  formatSSETextChunk,
  formatSSEDone,
  formatNonStreamingResponse,
  type OpenAIChatRequest,
} from "./openai-translator.js";
```

- [ ] **Step 2:** Drop the `Anthropic` instance field.

In the `VoiceAdapter` class, remove:

```typescript
private anthropic: Anthropic;
```

And remove the constructor line:

```typescript
this.anthropic = new Anthropic();
```

- [ ] **Step 3:** Replace the LLM dispatch in `handleChatCompletion`.

The current body of `handleChatCompletion` (after the call-session bookkeeping and `buildVoiceSystemPrompt` calls) ends with two branches: `request.stream === false` (non-streaming) and the streaming default. Replace both branches with the `query()`-based dispatch. Key behaviors:

- **Latency log**: capture `Date.now()` before consuming the stream, log first-`text_delta` arrival time once per call (`firstTokenMs` field).
- **OAuth-absent → 503**: catch the SDK's auth-failure error class (subprocess exit with stderr containing `Could not resolve authentication method` or similar). Return 503 `{"error":"Voice unavailable"}` and log error. Do this BEFORE writing any SSE headers in the streaming branch (we need to be able to set the status code).

```typescript
// Build the user-side prompt from the conversation transcript
const prompt = renderConversationPrompt(request.messages);

const model = agentConfig.model;
const completionId = `chatcmpl-${randomUUID()}`;
const startedAt = Date.now();
let firstTokenMs: number | undefined;

// One-shot SDK query — no MCP servers, no hooks, no session reuse.
// The SDK handles auth (ANTHROPIC_API_KEY env if set, else OAuth via the
// claude CLI's ~/.claude/.credentials.json). On operator instances with
// no API key configured, this falls through to the subscription path.
const q = query({
  prompt,
  options: {
    model,
    systemPrompt,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
    settingSources: [],
    includePartialMessages: request.stream !== false,
    env: {
      ...process.env,
      ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "hive/voice",
      CLAUDECODE: undefined,
    },
    extraArgs: { "strict-mcp-config": null },
  },
});

const isAuthError = (err: unknown): boolean => {
  const s = String(err);
  return /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i.test(
    s,
  );
};

if (request.stream === false) {
  // Non-streaming: collect full text from result message.
  let text = "";
  let resultSubtype: string | undefined;
  try {
    for await (const message of q) {
      const msg = message as SDKMessage;
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
              text = block.text;
            }
          }
        }
      } else if (msg.type === "result") {
        resultSubtype = (msg as any).subtype;
        if (resultSubtype === "success") {
          text = (msg as any).result || text;
        }
      }
    }
  } catch (err) {
    if (isAuthError(err)) {
      log.error("Voice query failed — OAuth credentials unavailable", { error: String(err), callId, agentId });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Voice unavailable" }));
      return;
    }
    log.error("Voice query error (non-streaming)", { error: String(err), callId, agentId });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
    return;
  }

  // Result subtype other than "success" → 500. Non-streaming is request/response
  // so we have not yet committed any bytes; we can still surface a clean error.
  if (resultSubtype && resultSubtype !== "success") {
    log.error("Voice query result reported failure", { callId, agentId, resultSubtype });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
    return;
  }

  log.info("Voice turn complete", { callId, agentId, firstTokenMs, totalMs: Date.now() - startedAt, mode: "non-streaming" });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(formatNonStreamingResponse(completionId, text, model)));
  return;
}

// Streaming: peek the first SDK message to surface auth failures BEFORE
// committing to SSE headers (which would lock us into a 200 response).
const iter = q[Symbol.asyncIterator]();
let firstMessage: IteratorResult<SDKMessage>;
try {
  firstMessage = (await iter.next()) as IteratorResult<SDKMessage>;
} catch (err) {
  if (isAuthError(err)) {
    log.error("Voice query failed — OAuth credentials unavailable", { error: String(err), callId, agentId });
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Voice unavailable" }));
    return;
  }
  log.error("Voice query error (streaming/init)", { error: String(err), callId, agentId });
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Internal error" }));
  return;
}

res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
});

const handleStreamMessage = (msg: SDKMessage) => {
  if (msg.type === "stream_event") {
    const event = (msg as any).event;
    if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
      res.write(formatSSETextChunk(completionId, event.delta.text ?? "", model));
    }
  }
};

let resultSubtype: string | undefined;
try {
  const checkResult = (msg: SDKMessage) => {
    if (msg.type === "result") resultSubtype = (msg as any).subtype;
  };
  if (!firstMessage.done) {
    handleStreamMessage(firstMessage.value);
    checkResult(firstMessage.value);
  }
  while (true) {
    const next = await iter.next();
    if (next.done) break;
    const msg = next.value as SDKMessage;
    handleStreamMessage(msg);
    checkResult(msg);
  }
  if (!res.writableEnded) {
    // Non-success result is logged but not surfaced to Vapi mid-stream — caller
    // already heard whatever audio was emitted; abruptly ending the stream
    // would degrade more than it helps. Logging is enough to alert ops.
    if (resultSubtype && resultSubtype !== "success") {
      log.warn("Voice query result reported failure (post-stream)", { callId, agentId, resultSubtype });
    }
    res.write(formatSSEDone(completionId, model));
  }
} catch (err) {
  log.error("Voice query error (streaming)", { error: String(err), callId, agentId });
  if (!res.writableEnded) {
    res.write(formatSSEDone(completionId, model, "error"));
  }
}

log.info("Voice turn complete", { callId, agentId, firstTokenMs, totalMs: Date.now() - startedAt, mode: "streaming", resultSubtype });
res.end();
```

- [ ] **Step 3b:** Export `isAuthError` for testability.

The `isAuthError` helper is defined inside `handleChatCompletion` per the snippet above. **Hoist it to module scope** (just below the imports) and export it so the test can exercise it without spinning up the adapter:

```typescript
// Exported for unit tests.
export function isAuthError(err: unknown): boolean {
  const s = String(err);
  return /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i.test(
    s,
  );
}
```

Then both `handleChatCompletion` branches reference the module-scope helper instead of the inner const.

- [ ] **Step 3c:** Add the test for `isAuthError`.

Append to `src/channels/voice/conversation-prompt.test.ts` (same file — co-locating voice unit tests keeps the surface small) OR create `src/channels/voice/voice-adapter.test.ts`. Pick whichever the project conventions favor; `voice-adapter.test.ts` is cleaner since the helper lives there.

```typescript
// src/channels/voice/voice-adapter.test.ts
import { describe, it, expect } from "vitest";
import { isAuthError } from "./voice-adapter.js";

describe("isAuthError", () => {
  it.each([
    "Could not resolve authentication method",
    "Expected ANTHROPIC_API_KEY or authToken",
    "Error reading credentials.json",
    "401 Unauthorized: token expired",
    "user not authenticated",
  ])("matches: %s", (msg) => {
    expect(isAuthError(new Error(msg))).toBe(true);
  });

  it.each([
    "ECONNREFUSED 127.0.0.1:6333",
    "Tool call failed",
    "Validation error: missing field",
  ])("does not match: %s", (msg) => {
    expect(isAuthError(new Error(msg))).toBe(false);
  });

  it("handles non-Error throws via String() coercion", () => {
    expect(isAuthError("Could not resolve authentication method")).toBe(true);
    expect(isAuthError({ message: "Could not resolve authentication method" })).toBe(false); // String({...}) === "[object Object]"
  });
});
```

- [ ] **Step 4:** Drop the `tools` translation block.

The existing line:

```typescript
const tools = openaiToolsToClaude(request.tools);
```

and any `...(tools ? { tools } : {})` spread should be removed — the new flow doesn't pass tools. (Tools are deferred to the spec's Phase 2 anyway.)

- [ ] **Step 5:** Drop the now-unused message translation.

The existing line:

```typescript
const { system, messages } = openaiToClaude(request.messages, systemPrompt);
```

should be removed. `systemPrompt` is passed directly to `query()` as the `systemPrompt` option; messages are rendered via `renderConversationPrompt` into `prompt`.

- [ ] **Step 6:** Verify build + typecheck.

```bash
cd /Users/mokie/github/hive-KPR-207
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck clean, all 1261+ tests pass (the 5 new tests bring it to 1266+).

- [ ] **Step 7:** Commit.

```bash
git add src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.test.ts
git commit -m "refactor(voice): use Claude Agent SDK query() for OAuth path (KPR-207)"
```

(`openai-translator.ts` is **not staged** — it's unchanged. If `voice-adapter.test.ts` was created in Step 3c, include it; if the auth-error tests were appended to `conversation-prompt.test.ts` instead, stage that file under Task 1's commit retroactively or amend Task 1's commit. Recommended path: create `voice-adapter.test.ts`.)

> **Status (2026-05-09):** Tasks 1 + 2 completed and committed (`f79ee20`, `71e27d8`). The base SDK refactor is in. Local smoke confirmed OAuth path works (Claude responded), but measured **firstTokenMs p50 = 3371ms** across 6 streaming smokes — exceeds the spec's 1500ms gate. Spec was amended to add per-call SDK session resume; Task 2b below implements it.

---

### Task 2b: Per-call SDK session resume

**Files:**
- Modify: `src/channels/voice/voice-adapter.ts`
- Modify: `src/channels/voice/conversation-prompt.ts` (add `extractLatestUserMessage`)
- Modify: `src/channels/voice/conversation-prompt.test.ts` (tests for new helper)

The base implementation in commit `71e27d8` calls `query()` per turn with the full transcript and never reuses sessions. This task adds session reuse: turn-1 of a Vapi call starts a fresh SDK session and captures the `sessionId`; turn-2+ resumes that session and only sends the latest user message. Resume failures fall back to a fresh turn-1 once.

- [ ] **Step 1:** Add `extractLatestUserMessage` to `conversation-prompt.ts`.

```typescript
// src/channels/voice/conversation-prompt.ts (append below renderConversationPrompt)

/**
 * Pull the latest user message off Vapi's history. Used on turn-2+ when the
 * SDK session is being resumed — the prior turns are already in the SDK's
 * session memory, so we only send the new user input.
 *
 * Returns empty string if no user message is present (caller decides what to
 * do; in practice voice-adapter falls back to turn-1 framing in that case).
 */
export function extractLatestUserMessage(messages: OpenAIChatRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : "";
    }
  }
  return "";
}
```

- [ ] **Step 2:** Append tests to `conversation-prompt.test.ts`.

```typescript
// at the bottom of src/channels/voice/conversation-prompt.test.ts
import { extractLatestUserMessage } from "./conversation-prompt.js";

describe("extractLatestUserMessage", () => {
  it("returns the most recent user message", () => {
    expect(
      extractLatestUserMessage([
        { role: "system", content: "x" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });

  it("returns empty string when no user message present", () => {
    expect(extractLatestUserMessage([{ role: "system", content: "x" }])).toBe("");
    expect(extractLatestUserMessage([])).toBe("");
  });

  it("ignores assistant and tool roles when scanning", () => {
    expect(
      extractLatestUserMessage([
        { role: "user", content: "hi" },
        { role: "assistant", content: "later" },
        { role: "tool", content: "tool-output" } as any,
      ]),
    ).toBe("hi");
  });
});
```

- [ ] **Step 3:** Extend `CallSession` in `voice-adapter.ts` to track the SDK session ID.

```typescript
// existing
interface CallSession {
  callId: string;
  agentId: string;
  startedAt: Date;
  // NEW
  sdkSessionId?: string;
}
```

- [ ] **Step 4:** Restructure `handleChatCompletion` to branch on whether a session is already tracked.

The base implementation currently does:
1. Look up / create `CallSession`.
2. Build `systemPrompt`.
3. `prompt = renderConversationPrompt(request.messages)`.
4. `query({ prompt, options: { ... } })`.
5. Consume stream.

Rework as follows. The two paths share most code; factor the difference into `prompt` + `resume` only.

```typescript
import { renderConversationPrompt, extractLatestUserMessage } from "./conversation-prompt.js";

// inside handleChatCompletion, after CallSession bookkeeping + buildVoiceSystemPrompt:

const session = this.sessions.get(callId)!; // guaranteed present after bookkeeping

const buildQuery = (resumeSessionId: string | undefined) => {
  const turnPrompt = resumeSessionId
    ? extractLatestUserMessage(request.messages)
    : renderConversationPrompt(request.messages);

  // If we tried to resume but the latest user message is empty (shouldn't
  // happen mid-call, but defensive), fall back to full transcript framing.
  const safePrompt =
    resumeSessionId && !turnPrompt ? renderConversationPrompt(request.messages) : turnPrompt;
  const effectiveResume = resumeSessionId && turnPrompt ? resumeSessionId : undefined;

  return {
    q: query({
      prompt: safePrompt,
      options: {
        model: agentConfig.model,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        settingSources: [],
        includePartialMessages: request.stream !== false,
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/voice",
          CLAUDECODE: undefined,
        },
        extraArgs: { "strict-mcp-config": null },
        ...(effectiveResume ? { resume: effectiveResume } : {}),
      },
    }),
    isResumeAttempt: !!effectiveResume,
  };
};

let { q, isResumeAttempt } = buildQuery(session.sdkSessionId);
```

- [ ] **Step 5:** Capture `sessionId` from `system/init` events.

In both streaming and non-streaming branches, watch for `msg.type === "system" && msg.subtype === "init"` and write `session.sdkSessionId = msg.session_id`. This persists for use on the next turn of the same Vapi call.

```typescript
// inside the for-await / async-iterator consumption loop, alongside existing branches:
if (msg.type === "system" && (msg as any).subtype === "init") {
  const sid = (msg as any).session_id as string | undefined;
  if (sid) session.sdkSessionId = sid;
}
```

- [ ] **Step 6a:** Extract a `runTurn` helper that consumes one `query()` stream end-to-end.

Move the iterator consumption (with its `system/init` capture, `firstTokenMs` timing, `text_delta` → SSE write, and `resultSubtype` capture) into a helper. The helper writes SSE chunks lazily — `res.writeHead(200, ...)` only fires when the **first `text_delta`** arrives. Errors before first text mean no bytes have been committed and we can retry cleanly.

```typescript
type TurnOutcome =
  | { ok: true; firstTokenMs: number | undefined; resultSubtype?: string }
  | { ok: false; reason: string; bytesSent: boolean };

const runTurn = async (
  q: ReturnType<typeof query>,
  isStreaming: boolean,
): Promise<TurnOutcome> => {
  let firstTokenMs: number | undefined;
  let resultSubtype: string | undefined;
  let assistantText = "";
  let headersSent = false;

  try {
    for await (const message of q) {
      const msg = message as SDKMessage;

      // Capture session id for next turn's resume.
      if (msg.type === "system" && (msg as any).subtype === "init") {
        const sid = (msg as any).session_id as string | undefined;
        if (sid) session.sdkSessionId = sid;
      }

      // Streaming text path — write SSE chunks lazily.
      if (isStreaming && msg.type === "stream_event") {
        const event = (msg as any).event;
        if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
          if (!headersSent) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            headersSent = true;
            firstTokenMs = Date.now() - startedAt;
          }
          res.write(formatSSETextChunk(completionId, event.delta.text ?? "", model));
        }
      }

      // Non-streaming text path — collect assistant text from the canonical message.
      if (!isStreaming && msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
              assistantText = block.text;
            }
          }
        }
      }

      if (msg.type === "result") {
        resultSubtype = (msg as any).subtype;
        if (!isStreaming && resultSubtype === "success") {
          assistantText = (msg as any).result || assistantText;
        }
      }
    }
  } catch (err) {
    return { ok: false, reason: String(err), bytesSent: headersSent };
  }

  if (resultSubtype && resultSubtype !== "success") {
    return { ok: false, reason: `result.subtype=${resultSubtype}`, bytesSent: headersSent };
  }

  // Streaming branch finalization — emit [DONE] and end.
  if (isStreaming) {
    if (!headersSent) {
      // Resume succeeded but produced no text (degenerate but not impossible).
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      headersSent = true;
    }
    res.write(formatSSEDone(completionId, model));
    res.end();
    return { ok: true, firstTokenMs, resultSubtype };
  }

  // Non-streaming branch finalization — return the JSON body to caller.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(formatNonStreamingResponse(completionId, assistantText, model)));
  return { ok: true, firstTokenMs, resultSubtype };
};
```

- [ ] **Step 6b:** Wire the resume + retry-once path.

```typescript
let { q, isResumeAttempt } = buildQuery(session.sdkSessionId);
let outcome = await runTurn(q, request.stream !== false);

const sdkSessionResumeAttempted = isResumeAttempt;

if (!outcome.ok && isResumeAttempt && !outcome.bytesSent) {
  // Resume failed before any bytes hit the wire — retry as turn-1 with full transcript.
  log.warn("Voice session resume failed, retrying as turn-1", {
    callId,
    reason: outcome.reason,
  });
  session.sdkSessionId = undefined;
  ({ q, isResumeAttempt } = buildQuery(undefined));
  outcome = await runTurn(q, request.stream !== false);
}

if (!outcome.ok) {
  // Either not a resume attempt, or retry also failed, or bytes already sent (mid-stream failure).
  if (isAuthError(outcome.reason)) {
    log.error("Voice query failed — OAuth credentials unavailable", {
      callId, agentId, reason: outcome.reason,
    });
    if (!outcome.bytesSent) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Voice unavailable" }));
    } else {
      // Bytes already sent — best we can do is end the SSE stream with an error sentinel.
      if (!res.writableEnded) {
        res.write(formatSSEDone(completionId, model, "error"));
        res.end();
      }
    }
    return;
  }

  log.error("Voice query failed", { callId, agentId, reason: outcome.reason, bytesSent: outcome.bytesSent });
  if (!outcome.bytesSent) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  } else {
    if (!res.writableEnded) {
      res.write(formatSSEDone(completionId, model, "error"));
      res.end();
    }
  }
  return;
}
```

**Why "defer headers" instead of buffering**: the spec's latency gate (turn-2+ p50 < 1500 ms) is defined as time to first `text_delta`. If we buffered until `result` arrived and then flushed, the `firstTokenMs` measurement would be tied to buffer-flush time (effectively turn-completion time), making the 1500 ms gate either trivially fail or meaningless. Deferring headers preserves the metric's meaning and only adds brittleness on mid-stream failures — which can't be cleanly retried under either approach.

**System-prompt drift caveat**: `buildVoiceSystemPrompt` is invoked every turn (current code), but the SDK's `resume` ignores the new `systemPrompt` option and keeps turn-1's. Memory updates and the date-time stamp drift across the call. **Accepted as-is** — voice calls are short (< 5 min typical), the staleness window is bounded, and this matches how `agent-runner.ts` handles cross-message continuity for Slack threads. Document with a one-line code comment in the resume branch.

- [ ] **Step 7:** Add structured fields to the "Voice turn complete" log entry.

Two distinct fields, NOT one:

- `sdkSessionResumeAttempted` — `true` iff this turn started with `options.resume` set (regardless of whether it succeeded). Used by the metrics-bucketing script in Task 3 to classify a turn as "warm" vs "cold."
- `sdkSessionResumed` — `true` iff this turn **successfully** ran on a resumed session (no retry). Used by the spec's "at least one turn-2+ in logs has `sdkSessionResumed: true`" acceptance test.

```typescript
log.info("Voice turn complete", {
  callId,
  agentId,
  firstTokenMs: outcome.firstTokenMs,
  totalMs: Date.now() - startedAt,
  mode: request.stream === false ? "non-streaming" : "streaming",
  resultSubtype: outcome.resultSubtype,
  sdkSessionResumeAttempted, // captured BEFORE retry — preserves the original turn classification
  sdkSessionResumed: sdkSessionResumeAttempted && outcome.ok && isResumeAttempt, // true iff resumed AND we didn't retry
});
```

(After a retry, `isResumeAttempt` is reset to `false` by `buildQuery(undefined)`. That's why we capture `sdkSessionResumeAttempted` separately *before* retry — without it, fault-injected turns would silently bucket into turn-1 metrics and skew the dual-budget measurements.)

- [ ] **Step 8:** Verify.

```bash
cd /Users/mokie/github/hive-KPR-207
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck + lint + format clean, all tests pass (~1278 — adds 3 new `extractLatestUserMessage` tests).

- [ ] **Step 9:** Commit.

```bash
git add src/channels/voice/voice-adapter.ts src/channels/voice/conversation-prompt.ts src/channels/voice/conversation-prompt.test.ts
git commit -m "feat(voice): per-call SDK session resume for warm turn-2+ latency (KPR-207)"
```

---

### Task 3: Bundle, deploy, smoke

**Files:** none (deploy + verify only)

- [ ] **Step 1:** Bundle.

```bash
cd /Users/mokie/github/hive-KPR-207
npm run bundle
```

Expected: `pkg/server.min.js` produced, no errors.

- [ ] **Step 2:** Deploy to dodi instance.

```bash
cp pkg/server.min.js ~/services/hive/dodi/.hive/pkg/server.min.js
launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent
until lsof -nP -iTCP:3105 -sTCP:LISTEN >/dev/null 2>&1; do sleep 2; done
echo "voice adapter back up"
```

Expected: voice adapter listens on `:3105`.

- [ ] **Step 3:** Smoke `/health` (unchanged auth surface).

```bash
SECRET=$(security find-generic-password -s "hive/dodi/VAPI_SERVER_SECRET" -w 2>/dev/null)
curl -sS -o /tmp/v.body -w "HTTP %{http_code}\n" -H "x-vapi-secret: $SECRET" http://localhost:3105/health --max-time 5
cat /tmp/v.body
```

Expected: `HTTP 200` and `{"status":"ok","activeCalls":0}`.

- [ ] **Step 4:** Smoke `POST /v1/chat/completions` with valid assistant ID + Vapi sentinel Bearer.

```bash
curl -sS -o /tmp/v.body -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer no-credentials-provided" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3105/v1/chat/completions \
  --max-time 30 -d '{
    "model": "mokie",
    "stream": false,
    "messages": [{"role":"system","content":"x"},{"role":"user","content":"say hello in five words"}],
    "assistant": {"id":"8709c39d-4d12-4535-b1c3-9a3d227cf937","metadata":{"hive_agent_id":"mokie"}}
  }'
head -c 400 /tmp/v.body
```

Expected: `HTTP 200`, JSON body with a `choices[0].message.content` containing a brief greeting from Mokie. **No `ANTHROPIC_API_KEY` configured** — this proves OAuth path works.

If this returns 500 with `Could not resolve authentication method`, the operator's OAuth credentials aren't being inherited by the spawned `claude` CLI — investigate `~/.claude/.credentials.json` access from the launchd-spawned hive process before continuing.

- [ ] **Step 5:** Real Vapi end-to-end — at least **5 multi-turn calls** (≥ 2 turns each) for the dual-budget measurement.

Place ≥5 calls via the Vapi dashboard's "Talk" button on the Mokie assistant (web call), or phone `+1 (650) 729-6067` after assigning Mokie as inbound. Each call needs at least 2 user utterances so we get both a turn-1 and a turn-2+ measurement.

Expected: live two-way conversation; Mokie greets the caller and responds in character. Check `~/services/hive/dodi/logs/hive.log` for `"Voice call session started"` and no `voice-adapter` errors.

- [ ] **Step 6:** Latency check — split p50 by turn type using `sdkSessionResumed` to distinguish.

```bash
grep '"Voice turn complete"' ~/services/hive/dodi/logs/hive.log \
  | tail -50 \
  | python3 -c "
import sys, json
turn1, turn2plus = [], []
for line in sys.stdin:
    try:
        d = json.loads(line)
        if d.get('msg') != 'Voice turn complete' or 'firstTokenMs' not in d:
            continue
        # Bucket by intent (resume attempted) not outcome (succeeded), so retries
        # after fault-injected resume failures still count toward turn-2+ stats.
        bucket = turn2plus if d.get('sdkSessionResumeAttempted') else turn1
        bucket.append(d['firstTokenMs'])
    except: pass
def p50(arr):
    arr = sorted(arr)
    return arr[len(arr)//2] if arr else None
print(f'turn-1 samples={len(turn1)} p50={p50(turn1)} ms (gate < 4000)')
print(f'turn-2+ samples={len(turn2plus)} p50={p50(turn2plus)} ms (gate < 1500)')
print(f'turn-1 raw: {sorted(turn1)}')
print(f'turn-2+ raw: {sorted(turn2plus)}')
"
```

Acceptance:
- Turn-1 p50 < 4000 ms (cold spawn — accepted, mitigated by Vapi's pre-canned `firstMessage`).
- Turn-2+ p50 < 1500 ms (warm session — the user-perceptible gate).

If either gate fails, **stop** — do not declare KPR-207 done. Surface as design blocker.

- [ ] **Step 7:** Resume-fallback fault-injection test.

The trick: corrupt the saved session **between** Vapi turns of a live call. Doing this by hand on a phone call is unreliable (turns are <2s apart). Use a one-shot watcher that fires on the first new session-dir creation, then renames it after a delay long enough for turn-1 to finish but before turn-2 begins.

In a separate terminal **before** placing the call:

```bash
# Wait for a new session dir to appear, then rename it after 3s.
# Run this once per fault-injection test.
fswatch -1 -E -i '^[0-9a-f-]+$' ~/.claude/projects/ | while read f; do
  echo "[fault] new session: $f — renaming in 3s"
  sleep 3
  mv "$f" "${f}.bak"
  echo "[fault] renamed $f → ${f}.bak"
  break
done
```

Then place a multi-turn web call from the Vapi dashboard. Expected timeline:

1. Call starts → turn-1 → SDK creates a session dir → fswatch fires.
2. fswatch waits 3s (turn-1 completes, ~3.4s window).
3. Renames the dir before turn-2 begins.
4. Speak turn-2 → resume fails → adapter logs warn + retries as turn-1 → audio reply delivered.

Verify:

```bash
grep "Voice session resume failed" ~/services/hive/dodi/logs/hive.log | tail -3
```

Expected: warn entry with `{ msg: "Voice session resume failed, retrying as turn-1", callId, reason }`; audio response heard by caller; call did not drop.

If the timing window misses (turn-1 takes longer than 3s, or turn-2 starts before the rename), increase the `sleep` delay or run the test again. **Acceptance: at least one observed warn-log + successful retry across attempts.**

Restore (optional — SDK will create new sessions on demand): `mv "${f}.bak" "$f"`.

- [ ] **Step 8:** Verification gate — only proceed if Steps 5, 6, AND 7 all pass.

---

### Task 4: Submit

**Files:** none

- [ ] **Step 1:** Push branch and open PR against `main`.

```bash
cd /Users/mokie/github/hive-KPR-207
git push -u origin KPR-207
gh pr create --title "refactor(voice): use Claude Agent SDK for OAuth path (KPR-207)" \
  --body "$(cat <<'EOF'
## Summary

- Voice-adapter now dispatches each `POST /v1/chat/completions` via `@anthropic-ai/claude-agent-sdk`'s `query()` instead of the raw `@anthropic-ai/sdk` client.
- Voice piggybacks on the same OAuth/subscription auth path the rest of the engine uses — no `ANTHROPIC_API_KEY` required on operator instances.
- Vapi's full message history is rendered into a single user-prompt transcript per turn (see `conversation-prompt.ts`); no SDK session reuse across turns, matching the spec's "per-call session lifetime."
- Tools are still deferred to spec Phase 2.

Closes [KPR-207](https://linear.app/keepur/issue/KPR-207). Builds on [#249](https://github.com/keepur/hive/pull/249).

## Test plan

- [x] `npm run check` (typecheck + lint + format + tests, including 5 new unit tests for `renderConversationPrompt`)
- [x] Smoke against dodi: `/health`, `POST /v1/chat/completions` non-streaming with no `ANTHROPIC_API_KEY` set (proves OAuth path works)
- [x] Real Vapi end-to-end call to Mokie assistant — live two-way conversation completed

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2:** Update Linear ticket to "In Review" once PR is open.

Find the "In Review" state ID for the KPR team, then update the issue:

```bash
LINEAR_TOKEN=$(security find-generic-password -s "hive/keepur/LINEAR_API_KEY" -w 2>/dev/null)

# Find state ID (one-time lookup):
curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"query { team(id: \"44dfad37-7541-47f6-b97c-cac768c99cd5\") { states { nodes { id name type } } } }"}' \
  | python3 -c "import sys,json; [print(n['id'], n['name'], n['type']) for n in json.load(sys.stdin)['data']['team']['states']['nodes'] if n['type'] in ('started','review')]"

# Then transition (substitute STATE_ID):
curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { issueUpdate(id: \"590cd9ca-e0df-4a1b-9fcc-6fb7b71ce55c\", input: { stateId: \"STATE_ID\" }) { success issue { state { name } } } }"}'
```

---

## Notes for the implementer

- **Do NOT** modify `src/agents/agent-runner.ts`. We are mirroring its `query()` invocation pattern, not refactoring shared code.
- **Do NOT** add MCP servers to the voice flow. Tools-on-call is a Phase-2 concern (spec) and explicitly out of scope here.
- Per-call SDK session resume is **in scope** as Task 2b — turn-1 starts a session, turn-2+ resumes it. Subprocess pooling across calls is out of scope (KPR-208).
- The `extraArgs: { "strict-mcp-config": null }` line is critical — it sandboxes the spawned CLI from the operator's enabled plugins / connectors. Same rationale as KPR-201 in `agent-runner.ts:1601`.
- `permissionMode: "bypassPermissions"` matches `agent-runner.ts:1567` — voice has no tools, so this is moot but keeps the surface aligned.
- If the SDK CLI subprocess can't find OAuth credentials (Step 4 returns 500 with auth error), check that hive's process inherits the operator's HOME and that `~/.claude/.credentials.json` is readable. Do **not** paper over by setting `ANTHROPIC_API_KEY` — that defeats the whole ticket.
