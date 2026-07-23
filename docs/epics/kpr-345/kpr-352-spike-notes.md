# KPR-352 Task 0 — Live spike evidence (Gemini Interactions API shape resolution)

**Worktree:** `hive-deliver-kpr-352` @ branch `kpr-352`, HEAD `411ea4a` · Node v24.16.0 · macOS · 2026-07-23.
**Backend:** `@google/genai` v2.13.0 → Gemini Interactions API (`client.interactions.create`, `stream: true`, `store: true`) · model `gemini-3.6-flash` (plan-time pinned default).
**Key source:** `hive/keepur/GEMINI_API_KEY` (Honeypot Keychain, resolved via `security find-generic-password -s hive/keepur/GEMINI_API_KEY -w` at run time). The key was PRESENT and live — every live leg ran. Secret *value* never printed; only ids/shapes/field-names logged. `signature`/`thought_signature` blobs are structural (per-step continuity tokens), not credentials, but were not persisted anywhere.
**Driver:** `<scratchpad>/kpr352-spike/kpr352-spike.ts` (the plan's verbatim driver) + two supporting probes `kpr352-probe.ts` (function_call carriage shape) and `status-probe.ts` (plain-text completion status). All three gitignored / scratchpad-only — **NEVER committed**.

**Blocking-gate verdict: NO STOP CONDITION.** Chaining (legs a/e) and function tools (leg b) both work end-to-end. Live legs all ran; several in-scope shape deltas surfaced (all fold into Task 1 verbatim — see §Deltas). **STATUS: DONE.**

---

## Per-leg verdict table

| Leg | Result | Verdict | Key shape fact |
|---|---|---|---|
| (a) chaining recalls context | live | **GREEN** | `previous_interaction_id: <a1.id>` → a2 answered `"Teal"` (a1 stated the fact). Chaining carries context server-side. |
| (b) function tools round-trip + call-carriage source | live | **GREEN** | Tool advertised as `{type:"function", name, description, parameters}` accepted. Call surfaced via **`step.start`** (`ev.step`), NOT `interaction.completed` (which has **no `steps` field at all**). `function_result` follow-up accepted; b2 answered with a real time. |
| (c) thinking_level acceptance ×4 | live | **GREEN** | `generation_config.thinking_level` ∈ {minimal, low, medium, high} — **all four accepted**, zero rejections, on `gemini-3.6-flash`. |
| (d) stale/fabricated-id status | live | **GREEN (captured)** | Both fabricated (`interactions/nonexistent-…`) and malformed (`not-even-shaped-like-an-id`) `previous_interaction_id` → **HTTP 400** "Request contains an invalid argument." |
| (e) sibling fork off already-chained parent | live | **GREEN** | Second child forked off `a1.id` (a2 already chained from it) → answered `"Teal"`. Sibling chaining works; parent is reusable. |
| (f) usage keys | live | **GREEN** | `interaction.completed.usage` keys captured verbatim (see §Deltas #6). |

---

## Observed event / stream inventory (field names verbatim)

**Event types** (`ev.event_type`): `interaction.created`, `interaction.status_update`, `interaction.completed`, `step.start`, `step.delta`, `step.stop`.
**`step.delta` `delta.type` values:** `text`, `thought_signature`, `arguments_delta`.
**`step.start` `ev.step.type` values:** `thought`, `model_output` (text turns); `function_call` (tool turns).

### `interaction.completed` payload — envelope only, NO steps array
Keys: `id`, `status`, `usage`, `created`, `updated`, `service_tier`, `object` (`"interaction"`), `model`. **There is no `steps` field** — the plan driver's `interaction.steps` read was always `undefined`. Content (text, function calls) lives **only in the streaming `step.*` events**, never in the completed envelope.

`interaction.completed.status` observed values:
- `"completed"` — normal text turn finished.
- `"requires_action"` — a function_call is pending; the turn is awaiting a `function_result` follow-up.

`interaction.status_update` carries `status: "in_progress"` mid-stream.

### `function_call` carriage — `step.start` is authoritative (probe evidence)
The function_call descriptor arrives on the **`step.start`** event:
```
ev.step = {
  id:        "kpJEAV5P",            // call id (string)
  signature: "<opaque continuity blob>",  // per-step thought/tool signature (structural, not a secret)
  type:      "function_call",
  name:      "get_weather",
  arguments: {}                     // empty at step.start; filled via step.delta
}
```
Arguments stream incrementally via `step.delta` with `delta.type === "arguments_delta"`:
```
delta = { type: "arguments_delta", arguments: "{\"city\":\"Paris\"}" }  // JSON *string* chunk
```
Accumulated across deltas → `"{\"city\":\"Paris\"}"` → parse before dispatch. (Empty-param tools emit no `arguments_delta` — the main-driver `get_current_time` case had `args-delta seen: false`.) `step.stop` carries only `{ index, event_type }` — no step body.

### `function_result` input shape accepted (leg b2)
```
input: [{ type: "function_result", name: "get_current_time", call_id: <id>, result: [{ type: "text", text: <ISO ts> }] }]
```
with `previous_interaction_id: <b1.id>` and `tools: [TOOL]` → HTTP 200, model answered `"The current time is 5:08:50 PM UTC on July 23, 2026."` (b2 succeeded even with a placeholder `call_id`, indicating chaining carries the pending call server-side and `call_id` matching is lenient — Task 1 should still pass the real `ev.step.id`).

---

## §Deltas — in-scope shape adjustments (fold into Task 1 verbatim)

These are the small deltas the plan's contingency rule anticipates. **None is a wholesale rejection.**

**Delta 1 — call-carriage source is streaming `step.start`, NOT `interaction.completed.steps`.**
`interaction.completed` has no `steps` field (envelope only). Task 1's harvest MUST reconstruct function calls from the streaming `step.start` event (`ev.step`: `id`/`name`/`type`/`signature`) + accumulate arguments from `step.delta`/`arguments_delta` (`delta.arguments`, a JSON string), dedup by `ev.step.id`. The dual-source harvest's **streaming leg is the live/authoritative one**; the `completed.steps` leg is dead (never populated).

**Delta 2 — completion status set = {`"completed"`, `"requires_action"`}.**
`interaction.completed.status === "requires_action"` is the signal that a function_call is pending and the `function_result` follow-up loop must run; `"completed"` is a finished text turn. Fold both into Task 1's turn-loop control.

**Delta 3 — stale/foreign `previous_interaction_id` ⇒ HTTP 400 (not 404/403).**
Both fabricated and malformed ids returned **status 400** "Request contains an invalid argument." Observed `STALE_HANDLE_STATUSES` = **{400}**, narrower than the plan's anticipated {400, 403, 404}. **Fold {400} in verbatim.** **CONCERN for Task 1 `STALE_HANDLE_STATUSES` + Task 3 `isStaleServerHandleError`:** 400 is generic — a genuinely malformed request also returns 400. Matching on status 400 alone risks over-matching non-stale faults into the self-heal path. Task 3's matcher should gate on 400 **plus** a message/argument-shape discriminator (the id-argument being the invalid one), not status code alone. Recorded as DONE_WITH_CONCERNS input for Task 3.

**Delta 4 — `thinking_level` lives under `generation_config.thinking_level`; all four levels valid on `gemini-3.6-flash`.**
§D5 map for `gemini-3.6-flash`: `minimal` ✓ `low` ✓ `medium` ✓ `high` ✓ — no rejected levels, no documented vendor-400 config fault for this model.

**Delta 5 — usage field names (verbatim, Task 1 usage mapping).**
`interaction.completed.usage` keys: `total_tokens`, `total_input_tokens`, `input_tokens_by_modality`, `total_cached_tokens`, `total_output_tokens`, `total_tool_use_tokens`, `total_thought_tokens`. Note the `total_` prefix on the scalar counters and the `input_tokens_by_modality` breakdown object.

**Delta 6 — per-step `signature` / `thought_signature` continuity token.**
Text turns emit a `thought_signature` `step.delta` type; `step.start` `function_call` steps carry a `signature` field. These are structural per-step continuity blobs (not secrets). Not load-bearing for the `previous_interaction_id` chaining path proven here (chaining carries context without the client re-sending signatures), so Task 1 need not persist them — but recorded so their appearance in the stream is not mistaken for content.

No wholesale rejection. No extra required header surfaced. `store: true` + `previous_interaction_id` is the working durable-resume shape (server-side history; the client does not replay item lists — the inverse of KPR-353's `store:false` codex model).

---

## Redacted transcripts (ids/shapes only)

### LEG a — chaining recall
```
a1 (fresh):   input "My favorite color is teal. Reply OK." → status_update in_progress → completed "completed" → text "OK."
a2 (chained): previous_interaction_id=<a1.id>, input "What is my favorite color? One word." → text "Teal"   ✓ RECALL OK
```

### LEG b — function tool round-trip
```
b1: input "What time is it… Use your tool." tools=[get_current_time]
    step.start ev.step.type=function_call  (interaction.completed has NO steps field)
    completed.status = requires_action
b2: input [{type:function_result, name:get_current_time, call_id:<id>, result:[{type:text, text:<ISO>}]}]
    previous_interaction_id=<b1.id>, tools=[TOOL]
    → text "The current time is 5:08:50 PM UTC on July 23, 2026."   ✓ time mentioned
probe (get_weather, required param city):
    step.start ev.step = {id:"kpJEAV5P", signature:<blob>, type:"function_call", name:"get_weather", arguments:{}}
    step.delta {type:"arguments_delta", arguments:"{\"city\":\"Paris\"}"}  → accum "{\"city\":\"Paris\"}"
    interaction.completed keys = id,status,usage,created,updated,service_tier,object,model ; status=requires_action ; steps=undefined
```

### LEG c — thinking_level ×4
```
minimal→"OK"  low→"OK."  medium→"OK."  high→"OK"   — all HTTP 200, zero rejections
```

### LEG d — stale/foreign id
```
d1 fabricated "interactions/nonexistent-kpr352-probe" → status=400 "Request contains an invalid argument."
d2 malformed  "not-even-shaped-like-an-id"            → status=400 "Request contains an invalid argument."
```

### LEG e — sibling fork
```
e: previous_interaction_id=<a1.id> (a2 already chained from a1), input "What is my favorite color? One word."
   → text "Teal"   ✓ sibling fork recall OK
```

---

## Spike-outcome → task dependency table

| Spike leg | Consumed by | Verdict | Notes |
|---|---|---|---|
| (a) chaining recalls context | Task 1 loop + Task 3 flip | **GREEN** | `previous_interaction_id` + `store:true` carries context server-side; a2 recalled "Teal". Confirms Task 3's `persistsResumableHandle: true` flip and the server-resumable session model. |
| (b) function tools + result shape; call-carriage source | Task 1 harvest (which source populates) | **GREEN** | **Live/authoritative source = streaming `step.start` (`ev.step`) + `step.delta`/`arguments_delta`**, NOT `interaction.completed.steps` (no such field). Fields verbatim: `ev.step.id`, `ev.step.name`, `ev.step.type="function_call"`, `ev.step.signature`; args = accumulated JSON string from `delta.arguments`. `function_result` input `{type,name,call_id,result:[{type:"text",text}]}` accepted. Completion `status="requires_action"` signals a pending call. |
| (c) thinking_level per model | Task 1 §D5 map | **GREEN** | `generation_config.thinking_level`: minimal/low/medium/high all accepted on `gemini-3.6-flash`; no rejected level, no documented vendor-400 config fault. |
| (d) stale-id status+payload | Task 1 `STALE_HANDLE_STATUSES` + Task 3 matcher | **GREEN (DONE_WITH_CONCERNS)** | Observed status set = **{400}** (both fabricated + malformed), NOT {403,404}. Fold {400} in verbatim. **Concern:** 400 is generic — Task 3 `isStaleServerHandleError` must add a message/argument discriminator so genuine malformed-request 400s don't over-match into self-heal. |
| (e) sibling fork | §Edge "errored/aborted mid-loop" resume semantics | **GREEN** | Parent interaction is reusable — a second child chained off `a1.id` recalled "Teal" independently of the first child a2. Fork-safe. |
| (f) usage keys | Task 1 usage mapping | **GREEN** | `total_tokens, total_input_tokens, input_tokens_by_modality, total_cached_tokens, total_output_tokens, total_tool_use_tokens, total_thought_tokens` (verbatim; note `total_` prefix + `input_tokens_by_modality` object). |

---

## Contingency rules (recorded per plan)

- **Field-name / status deltas fold into Task 1 verbatim** — in-scope adjustments, not redesigns. Five surfaced (Deltas 1–5 above: streaming-`step.start` harvest source, `{completed, requires_action}` status set, stale-handle status `{400}`, `generation_config.thinking_level` levels, usage field names). All fold in cleanly.
- **Leg (b) calls surface ONLY via streaming reconstruction** (`step.start` + `arguments_delta`), never via the `interaction.completed` envelope. The dual-source harvest is satisfied by its streaming leg; **record: the streaming source is the live one, `completed.steps` is dead.**
- **Leg (d) returned a status outside {403,404}** — the live value is **{400}** for both fabricated and malformed ids. Per the plan's rule, replace the set with the observed value ({400}), and note the over-match concern for the matcher (400 is generic).
- **Wholesale rejection would STOP → demote to spec lane.** Chaining (a/e) and function tools (b) were **NOT** rejected — both work end-to-end. **No demote signal.**
- **Key-dead / quota-blocked contingency (did NOT trigger):** key was present and live; live legs ran. Had it been dead, the posture would have been: run Tasks 1–5 on mocks (KPR-348 evidence-gap posture), mark live legs deferred to the KPR-351-class pass, non-gating.

## Gate result

**DONE — no STOP condition.** Chaining, function tools, thinking_level, sibling fork all GREEN; stale-id status captured. Tasks 1–5 proceed. Five in-scope shape deltas (§Deltas 1–5) fold into Task 1 verbatim; one carries a matcher-over-match concern into Task 3 (stale-handle status 400 is generic — gate on more than the status code).

---

## Task 6 (Step 6.3) — post-implementation live turn (evidence-recorded)

Scratch tsx driver (scratchpad, never committed) constructed the **real** `GeminiInteractionsAdapter` against a minimal assembly: one real in-process trivial MCP tool (`get_magic_number`, empty-param, returns a fixed sentinel string), an allow-all guardrail gate, `sessionCwd = repo cwd`, empty skill index, and the Honeypot key (`hive/keepur/GEMINI_API_KEY`). Three back-to-back turns, each a fresh per-spawn adapter. Model: default `gemini-3.6-flash`. IDs/shapes only below — no key material, id tails redacted to char-length.

| Leg | Prompt | Observed result | Verdict |
|---|---|---|---|
| **Turn 1** (fresh chain, tool-forcing) | "What is the magic number? Use your tool." | `toolCalls=1`, `toolSummary=mcp__trivial__get_magic_number×1`, `error=none`, final text coherent and contained the tool-returned number (`…the magic number is 74619.`), returned a real interaction id (shape `<70chars>`). | **GREEN** — ≥1 real tool executed through the bridge, final text coherent, interaction id minted. |
| **Turn 2** (chain turn-1 id as `sessionId`, no-tool recall) | "Without calling any tool, what number did you just tell me?" | `toolCalls=0`, `error=none`, final text `"74619"` (`recalls-number=true`), new id shape `<70chars>`. | **GREEN** — `previous_interaction_id` chaining recalled turn-1 context server-side; no client replay. |
| **Turn 3** (fabricated id) | `sessionId="interactions/fabricated-nonexistent-000000000000"`, prompt "hello" | `RunResult.error = "gemini interaction resume rejected (status 400): 400 Request contains an invalid argument."`, `toolCalls=0`, `text=""`. | **GREEN** — round-1 resume-carrying create failed with the live status (400) AND the invalid-argument discriminator, tagged with the `STALE_HANDLE_SENTINEL` the KPR-350 manager arm consumes. |

Driver exited 0; file deleted post-run (never `git add`-ed). Live status confirms the Task-0 leg-(d) refinement: stale/fabricated `previous_interaction_id` returns **HTTP 400 "Request contains an invalid argument."**, matched by `STALE_HANDLE_STATUSES = {400}` + `STALE_HANDLE_MESSAGE`. Free-tier caveat unchanged (1d retention + training — production gemini assignment needs a paid-tier key).
