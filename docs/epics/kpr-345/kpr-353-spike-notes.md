# KPR-353 Task 0 — Live spike evidence (the §Open-assumptions gate)

**Worktree:** `hive-kpr-353` @ branch `kpr-353`, HEAD `39eeb61` · Node v24.16.0 · macOS · 2026-07-21.
**Backend:** `POST https://chatgpt.com/backend-api/codex/responses` · model `gpt-5.4-mini` (config.ts:278 default) · codex ChatGPT-subscription OAuth (`~/.codex/auth.json` PRESENT, resolved via `createCodexOpenAITokenProvider()`).
**Headers:** exactly the real adapter's set (`codex-subscription-adapter.ts:78-83`) — `authorization: Bearer <token>`, `content-type: application/json`, `accept: text/event-stream`, `openai-beta: responses=v1`. No additional header was required.
**Driver:** `.dodi/kpr353-spike.ts` (gitignored, run under `npx tsx`, NEVER committed). A supporting probe `.dodi/kpr353-probe.ts` (also gitignored) isolated the leg-c delta below. Secret *values* are never logged — presence + result *shape* only; every `encrypted_content` is logged as `<len=N>`, `summary` as `<redacted>`.

**Blocking-gate verdict: ALL FOUR LEGS GREEN.** No STOP condition. Two in-scope request-shape deltas surfaced (both fold into Task 3 verbatim — see §Deltas). The token provider returned a usable session (not null → not BLOCKED).

---

## Per-leg verdict table

| Leg | HTTP | Verdict | Key shape fact |
|---|---|---|---|
| (a) function tools accepted | 200 | **GREEN** | `tools: [{type:"function", name, description, parameters, strict:false}]` accepted, no 4xx. Model emitted `response.function_call_arguments.delta/done`. |
| (b) `function_call` in completed output | 200 | **GREEN** | `function_call` item delivered via `response.output_item.done`; `arguments` is a **JSON string** (`"{}"`). |
| (c) encrypted reasoning include | 200 | **GREEN** | `reasoning` item carries `encrypted_content` (string, `<len=1080>`) **only when the request sends a `reasoning` field** (see Delta 2). |
| (d) replayed input-item lists accepted | 200 (d1 + d2) | **GREEN** | continuation with `function_call_output` (d1) AND next-turn replay of the full list incl. real encrypted reasoning items (d2) both accepted; d2 answered correctly (`get_current_time`). |

---

## Observed `response.completed` output-item type inventory

The completed turn's output items were of these types (field names as observed):

- **`reasoning`** — keys: `id`, `type`, `content` (array, empty on these turns), `encrypted_content` (string — present only with a `reasoning` request field), `summary` (redacted in logs). Example id prefix `rs_…`.
- **`function_call`** — keys: `id` (prefix `fc_…`), `type`, `status` (`"completed"`), `arguments` (**JSON string**, e.g. `"{}"`), `call_id` (prefix `call_…`), `name`.
- **`message`** — keys: `id` (prefix `msg_…`), `type`, `status`, `content` (array of `{type:"output_text", annotations:[], logprobs:[], text}`), `phase` (`"final_answer"`), `role` (`"assistant"`).

### `function_call` field shapes (leg b — consumed by Task 2 capture + Task 3 §D2)
```
call_id   : string   (e.g. "call_WfjUfbAyh8Y78szFEB5eBCHa")
name      : string   (e.g. "get_current_time")
arguments : string   (JSON-encoded object — "{}" here; parse before dispatch)
id        : string   ("fc_…")
status    : "completed"
type      : "function_call"
```

### reasoning item / encrypted_content (leg c)
Reasoning items **do** carry `encrypted_content` (string). Observed lengths: 1080 (leg a/b/c turn), 1036 (leg d2 turn). `content` was an empty array on these low-complexity turns; the encrypted blob is the load-bearing field for cross-turn replay under `store:false`. Values NEVER printed — `<len=N>` only.

---

## §Deltas — in-scope request-shape adjustments (fold into Task 3 verbatim)

These are the small deltas the plan's contingency rule anticipates ("an additional required header, a `tool_choice` field, an item-field rename … recorded here and folded into Task 3's body verbatim — in-scope adjustments, not redesigns"). Neither is a wholesale rejection.

**Delta 1 — `store: false` ⇒ `response.completed.response.output` is EMPTY. Output items must be accumulated from streaming `response.output_item.done` events (each carrying `.item`).**
The plan driver's original parse read only `response.completed.response.output`, which came back `[]` on every turn. The items (`reasoning`, `function_call`, `message`) are delivered incrementally via `response.output_item.done`. **Task 3's §D2 loop MUST harvest completed output items from `response.output_item.done` (dedup by `item.id`/`call_id`), not from the `response.completed` payload.** The current real adapter (`codex-subscription-adapter.ts:296-331`) only parses `output_text.delta/done` + response metadata today — it does not yet harvest `output_item.done` items; Task 3 adds that harvesting.

**Delta 2 — a `reasoning` request field is REQUIRED to obtain encrypted reasoning items.**
With NO `reasoning` field (the plan driver's original body), `gpt-5.4-mini` emitted **no** reasoning item at all — only the `function_call` — so leg c had nothing to find. Adding `reasoning: { effort: "medium" }` made the backend emit a `reasoning` item with `encrypted_content` (`<len=1016..1080>`). `reasoning: { effort, summary: "auto" }` behaves identically. **Task 3 must send a `reasoning: { effort: <resolved> }` field whenever encrypted-reasoning replay is wanted.** This mirrors the real adapter, which already conditionally sends `reasoning: { effort }` when `reasoningEffort` is set (`codex-subscription-adapter.ts:86`) — Task 3 makes it load-bearing for the replay path rather than optional.

No other deltas. No extra header, no `tool_choice` field, no item-field rename beyond the above was needed.

---

## Redacted transcripts (encrypted_content as `<len=N>` only — NEVER the actual value)

### LEG a/b/c — tool-forcing turn `[user1]` → HTTP 200
event types: `response.completed, response.created, response.function_call_arguments.delta, response.function_call_arguments.done, response.in_progress, response.output_item.added, response.output_item.done`
output source: `response.output_item.done` (completed.output was empty — Delta 1)
```json
[
 { "id": "rs_…", "type": "reasoning", "content": [], "encrypted_content": "<len=1080>", "summary": "<redacted>" },
 { "id": "fc_…", "type": "function_call", "status": "completed", "arguments": "{}", "call_id": "call_…", "name": "get_current_time" }
]
```
`function_call shape: { call_id: 'string', name: 'get_current_time', arguments: 'string' }` · `reasoning item with encrypted_content present: true`

### LEG d1 — continuation `[user1, ...out1, function_call_output]` → HTTP 200
`function_call_output` = `{ type:"function_call_output", call_id:<from out1>, output:<ISO timestamp> }`. Accepted; model produced a message reflecting the tool output:
```json
[
 { "id": "msg_…", "type": "message", "status": "completed",
   "content": [ { "type": "output_text", "annotations": [], "logprobs": [], "text": "Right now it is **2026-07-22T05:23:23.924Z**." } ],
   "phase": "final_answer", "role": "assistant" }
]
```

### LEG d2 — next-turn replay `[user1, ...out1, function_call_output, ...out2, user2]` → HTTP 200
Replayed the full prior turn **including the real (unredacted-in-transit) encrypted reasoning + function_call + function_call_output + assistant message**, plus a new user turn ("Which tool did you just use? One word."). Accepted; answered correctly:
```json
[
 { "id": "rs_…", "type": "reasoning", "content": [], "encrypted_content": "<len=1036>", "summary": "<redacted>" },
 { "id": "msg_…", "type": "message", "status": "completed",
   "content": [ { "type": "output_text", "annotations": [], "logprobs": [], "text": "get_current_time" } ],
   "phase": "final_answer", "role": "assistant" }
]
```
The correct answer proves the replayed encrypted reasoning items were accepted and used (not merely tolerated) across a turn boundary under `store: false`.

---

## Spike-outcome → task dependency table

| Spike leg | Consumed by | Verdict | Notes |
|---|---|---|---|
| (a) function tools accepted | Task 3 (§D1 binding) | **GREEN** | Request shape delta: none for the tool-advertisement itself. Tool object `{type:"function", name, description, parameters, strict}` accepted as-is. |
| (b) `function_call` in completed output | Task 3 (§D2 loop) + Task 2 (capture) | **GREEN** | Item delivered via `response.output_item.done` (Delta 1), NOT `response.completed.output`. Fields: `call_id`, `name`, `arguments` (JSON **string** — parse before dispatch), `id` (`fc_…`), `status:"completed"`, `type:"function_call"`. §D2 loop harvests from streaming `output_item.done`. |
| (c) encrypted reasoning include | Task 3 body + §D3 turn records | **GREEN** | Requires `reasoning: { effort }` request field (Delta 2). `include: ["reasoning.encrypted_content"]` accepted. Reasoning item fields: `id` (`rs_…`), `type:"reasoning"`, `content:[]`, `encrypted_content` (string), `summary`. Persist `encrypted_content` verbatim for replay; never log its value. |
| (d) replayed item lists accepted | Task 1 store shape + Task 3 replay | **GREEN** | Same-turn continuation (d1, with `function_call_output`) AND next-turn replay of the full item list incl. real encrypted reasoning (d2) both HTTP 200. Store shape (Task 1) must retain: user turns, `reasoning` items (with `encrypted_content`), `function_call` items, `function_call_output` items, assistant `message` items — replayed in original order. `store:false` means the client is the sole history keeper. |

---

## Contingency rules (recorded per plan)

- **Small request-shape deltas** the spike surfaces (an additional required header, a `tool_choice` field, an item-field rename) are recorded in §Deltas above and folded into Task 3's body verbatim — they are in-scope adjustments, not redesigns. Two such deltas surfaced (Delta 1: harvest items from `response.output_item.done`; Delta 2: send a `reasoning:{effort}` field). Both fold in cleanly and both align with the existing real adapter.
- **Wholesale rejection would STOP the ticket:** if the backend had rejected function tools, produced no `function_call` items, rejected `include` with no workaround, or rejected replayed lists, the affected leg would be marked FAILED and Tasks 1–7 would not start. **None occurred** — every leg returned HTTP 200 with the expected shapes.

## Gate result

**GREEN — all four legs green. Tasks 1–7 may proceed.** No demote-to-spec. The two surfaced deltas are in-scope body adjustments for Task 3, recorded verbatim above.

---

## Post-implementation live e2e (Task 7.3 — real adapter, full tool-flip surface)

Re-run of the T0 surface **after** the implementation landed — but through the **real `CodexSubscriptionAdapter`** end to end (not raw HTTP): a hand-built `ProviderTurnAssembly` advertising the `Bash` claude-builtin, an allow-all guardrail gate, a Map-backed `TurnHistoryStore` stand-in, and a two-turn same-thread conversation that forces a real tool call and then a stateless-replay continuation. Encrypted content is recorded as `<len=N>` only — never the value.

**Environment header:** HEAD `3fac469` · node v24.16.0 · dev Mac (fleet codex subscription auth `~/.codex/auth.json`) · 2026-07-21 · model `gpt-5.4-mini`, `reasoning.effort=high` (medium first run produced no reasoning item for the trivial task — expected model-behavior variance; high reliably exercises the encrypted-reasoning path, capture code unchanged).

### Turn 1 — real Bash tool call (redacted)

Prompt: `"Run \`echo hive-353-live\` with the Bash tool and tell me its output."`

- `result.text` = `hive-353-live` → **contains marker ✓**
- `result.toolCalls` = **1** (`>= 1` ✓)
- `result.toolMs` = **9** (`> 0` ✓)
- `result.durationMs` = 3141, `result.llmMs` = 3132 → **`llmMs === durationMs - toolMs` ✓** (§D6 tool-time excluded from the breaker p95 window)
- store received **exactly one `append`**; its flattened items (in order):

  | # | type | shape (redacted) |
  |---|------|------------------|
  | 1 | `user` | the prompt input_text |
  | 2 | `reasoning` | `encrypted_content` present, `<len=1080>` |
  | 3 | `function_call` | name `Bash`, arguments JSON string |
  | 4 | `function_call_output` | hive-executed output `hive-353-live\n` |
  | 5 | `message` | assistant final text |

  → reasoning-item-with-`encrypted_content` **AND** a `function_call`/`function_call_output` pair both present in the single persisted turn record ✓

### Turn 2 — stateless replay continuity (redacted)

Prompt (same thread `kpr353-live-thread`): `"What was the exact string you echoed a moment ago?"`

- The adapter `load()`ed turn 1's flattened items (incl. the real `<len=1080>` encrypted reasoning item) and prefixed them to the new user item — the full `store:false` replay path.
- `result.text` = `hive-353-live` → **replay continuity confirmed ✓** (the model recovered the echoed string from replayed history alone)
- **No §D7 heal fired** — stdout/stderr scanned for the `"Codex replay rejected"` warn across the whole turn: **not seen** ✓. The backend accepted the replayed encrypted-reasoning list (HTTP 200), matching T0 leg (d2).
- `result.error` = null (request accepted); second `append` recorded (append-total 2).

**Verdict: ALL_PASS.** The tool-flip surface — bridged Responses function tools → hive-owned dispatch loop → encrypted-reasoning capture → whole-turn persist → next-turn stateless replay — works live on the real subscription endpoint, post-implementation.
