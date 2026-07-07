# KPR-307 — W2.2: Honest outage behavior — fast-fail + queue-don't-drop

**Status:** DRAFT — decision-ready, awaiting human ruling on the three product decisions (§5). This child carries `needs-human-spec`: the operator rules on §5 before write-plan.
**Epic:** KPR-305 · **Baseline:** branch `mature/KPR-307` off epic branch `kpr-305` @ `f81471a` (code content matches `main` @ `08ca29e`; the epic branch adds only the KPR-306/KPR-308 spec docs).
**Re-confirm note:** maturity-first sweep — spec written ahead of implementation. The write-plan/implement lane MUST re-verify every file/line anchor in §2 at HEAD before coding; `dispatcher.ts` and `agent-manager.ts` are hot files that sibling waves (KPR-306 lands *before* this ticket) will move.
**Ticket text:** "While the breaker is open: immediate honest response to the channel, and turns queue for replay instead of vanishing. Distinct from the delivery retry queue (which stays as-is)."
**Hard dependency:** KPR-306 (encoded in Linear as a blocking edge). This spec BINDS to KPR-306's frozen **Open-Circuit Contract** (`ProviderCircuitOpenError` + `CircuitBreakerSnapshot`, additive-only — `docs/epics/kpr-305/kpr-306-spec.md`, "Open-Circuit Contract" section) and does not redesign the breaker.

## TL;DR

When KPR-306's breaker is open, a turn fast-fails out of `spawnTurn` with `ProviderCircuitOpenError` — and today that surfaces as `"Something went wrong: ProviderCircuitOpenError: …"` on Slack, **silence** on SMS/iMessage (their `deliver()` skips error results), and a raw `Error:` frame on the app channel. This ticket intercepts that error in the dispatcher's existing catch blocks and does two things: (1) sends an **honest, channel-appropriate outage notice** — once per thread per outage episode, as a plain-text `WorkResult` so every adapter actually delivers it — and (2) **persists the WorkItem to a Mongo-backed `outage_queue`** (precedent: `agent_callbacks` + scheduler poller) for automatic replay. A 15s replay poller retries the oldest queued item through the normal dispatch path; while the breaker is open that attempt fast-fails for free (pre-model-router), and once KPR-306's cooldown elapses the attempt *becomes the half-open probe* — success closes the breaker and the drain delivers every queued answer, oldest-first, with a replay context note in the prompt. Cron-fired turns skip with a log (they re-fire); callback/event/team-fired turns queue silently (no human to notify). The delivery retry queue (`src/sweeper/retry-queue.ts`) is untouched. Three product decisions (notice content/repetition, replay semantics, queueing scope) are presented as options in §5 with recommendations.

## Key Points

- **Interception is reactive, at the dispatcher catch — not a proactive pre-dispatch breaker check.** This is load-bearing for KPR-306: its half-open probe is "the next real turn admitted to `spawnTurn`". If KPR-307 routed around dispatch whenever `stateFor(provider)` said open, no turn would ever reach `acquire()` and the breaker could only recover via our replay attempts. Reactive interception keeps live user turns eligible as probes *and* is simpler. Detection: `err instanceof ProviderCircuitOpenError` (same-process, safe per KPR-306's guidance).
- **The probe-failure turn is also made honest.** A half-open probe that fails does NOT throw `ProviderCircuitOpenError` — it runs the real turn and fails with the raw provider error in `TurnResult.errors[0]`, then the breaker re-opens. Rule: after a turn completes with an error, if `agentManager.circuitBreakers.stateFor(provider)?.state === "open"`, treat it exactly like a fast-fail (queue + notice) instead of delivering `"Something went wrong: …"`. This also covers the trip-crossing turn (the Nth consecutive fault that opened the breaker).
- **Queue is Mongo-backed (`outage_queue` collection), surviving restart** — the breaker's own state is deliberately in-memory (KPR-306 non-goal) because it re-trips in seconds; queued *customer messages* are exactly the thing the ticket forbids losing, and an operator restarting the engine mid-outage is a likely event. ⚠ Recommended over in-memory; decision 2a in §5.
- **Replay = re-dispatch through `dispatcher.dispatch()`** with the *same* `id` as the original item, plus `meta.outageReplay: true`. A first-draft fix synthesized a fresh per-attempt id (`replay:<attempt>:<originalId>`) to dodge the 60s dedup map (`dispatcher.ts:104-109`), but §5-2g doesn't increment `attempts` on fast-fail — so during an open breaker that id would repeat (`replay:0:<itemId>`) on every 15s tick and the dedup map would silently drop every attempt after the first, i.e. the item never replays (Finding 1, review round 1). Fixed design: `dispatch()`'s dedup check bypasses when `item.meta?.outageReplay` is set — dedup exists to catch externally-duplicated deliveries (e.g. two adapters seeing the same Slack event); a replay is engine-authored, so there's nothing to dedup against. `meta.targetAgentId` pinned to the originally-resolved agent (resolveAgents step 0, `dispatcher.ts:382-385`), and the original `source`/`meta` preserved so the reply lands in the original thread. Full pipeline reuse: delivery, task ledger, audit log, retry queue — no parallel delivery path.
- **Replay outcomes are dispatcher-authored, not poller-inferred.** `dispatcher.dispatch()` returns `Promise<void>` and never rethrows (both catch sites deliver internally) — awaiting it tells the replay poller nothing about success vs. real-failure vs. fast-fail vs. a disabled-agent drop vs. non-response suppression (Finding 2, review round 1). Fix: the dispatcher's outage-path helper and success path both check `item.meta?.outageReplay` and write the `outage_queue` outcome directly via `store.release(...)`. One consistent table lives in §5-2g; §7.2/§7.4 implement it, nothing infers it after the fact.
- **Honest notices are plain-text `WorkResult`s with `error` UNSET.** Today `result.error` triggers `formatError` on Slack (`slack-adapter.ts:142`), **delivery skip** on SMS (`sms-adapter.ts:62-65`) and iMessage (`imessage-adapter.ts:113-115`), and a raw `Error:` frame on WS. Setting plain text sidesteps all four adapter quirks with zero adapter changes. The same mechanism covers the `failed` terminal case (§5-2g, Finding 6): a replay that exhausts `maxReplayAttempts` also delivers a plain-text notice rather than relying on the normal `"Something went wrong: …"` error path, which SMS/iMessage would otherwise swallow.
- **Outage episode ≠ `openedAt`.** KPR-306's `openedAt` is "most recently opened" and advances on every failed probe (~every 15-60s), so keying once-per-thread notice dedup on it would re-notify every probe cycle. Episode is tracked dispatcher-side: begins at the first honest-path activation for a provider, ends at the first successful turn on that provider **while `stateFor(provider)?.state !== "open"` at the moment that turn completes** (Finding 3, review round 1) — a turn issued before the trip that lands and succeeds *after* the breaker has already opened must not clear the episode, or the very next fast-fail starts a "new" episode and double-notifies mid-outage. Notice dedup key: `(provider-episode, adapterId ?? kind, threadId ?? sender)` — in-memory (restart worst case: one repeated notice per thread).
- **Source policy:** human-sender turns (slack, sms, imessage, app/ws, team-DM) → queue + notice; `callback:`/`event:`/`team-` system one-shots → queue **silently**; `sched:` cron turns → **skip with log** (cron re-fires by design; queueing would double-run). Voice cannot queue (live call) — honest spoken completion text only, not a bare error code (§5-1b; today's baseline is 500, not 503 — Finding 5). Scheduler `request_response` team calls bypass the dispatcher and keep today's failed-marking (non-goal).
- **Delivery retry queue stays as-is** (ticket text). It handles "turn succeeded, channel delivery failed"; this ticket handles "turn never ran because the model provider is down." The two compose: an honest notice whose Slack delivery fails goes to the delivery retry queue like any other message.
- **Boundary with KPR-308:** KPR-308 = WAN outage → WHERE responses go (LAN channel routing for floor-critical agents); KPR-307 = model-provider outage → WHAT happens to turns (honest fast-fail + replay). A WAN outage with no local model is BOTH: the breaker trips on connect-fails (this ticket queues turns + notices), and KPR-308's diversion decides which channel the notice/replayed answer physically reaches. No shared code; the interaction is emergent and correct by construction.
- ⚠ Delegated assumptions flagged in §10: defaults (15s replay tick, 4h TTL, depth 500, 3 replay attempts), notice wording, batched expiry notice, Mongo durability choice.
- **Epic canon:** KPR-305's Gate 1 rulings D3–D6 are recorded; nothing here contradicts them. D4 binds the doctor surface in §7.6 to **informational tier** (never flips exit code). The three §5 decisions are new questions — the operator's ruling on this spec becomes canon on them.

## 1. Problem / verified baseline (re-confirm at HEAD)

The 30-minute-outage profile, after KPR-306 lands: turns fast-fail cleanly and cheaply — but the *user experience* of a fast-fail is untouched. Per-channel today:

| Surface | Evidence | Outage behavior (post-KPR-306, pre-this-ticket) |
|---|---|---|
| Dispatcher catch (single dispatch) | `src/channels/dispatcher.ts:258-275` — builds `WorkResult{ text: "Something went wrong: ${err}", error }`, delivers via source adapter, retry-queues on delivery failure | Every turn during the outage produces a raw error message per message |
| Dispatcher catch (fan-out) | `dispatcher.ts:646-663` — near-duplicate of the above | Same, per fanned-out agent |
| Slack error formatting | `src/slack/response-formatter.ts:32-34` `formatError` → used at `src/channels/slack-adapter.ts:142` (`result.error ? formatError(…) : …`) | `⚠ Jasper: Something went wrong: ProviderCircuitOpenError: …` per message |
| SMS delivery | `src/channels/sms-adapter.ts:62-65` — **skips delivery when `result.error` set** | **Silence.** Customer texts vanish with no acknowledgment |
| iMessage delivery | `src/channels/imessage-adapter.ts:113-115` — same skip | Silence |
| WS/app delivery | `src/channels/ws/ws-adapter.ts` `deliver()` — `text = result.error ? "Error: ${result.error}" : result.text` | Raw error frame on the floor device |
| Voice | `src/channels/voice/voice-adapter.ts` — auth failure → 503 (`:350`), spawn-budget-exceeded → 503 (`:359`), **generic thrown error (incl. `ProviderCircuitOpenError` today) → 500 "Internal error" (`:368`)** | Generic **500**, not 503, to Vapi for a provider outage today (Finding 5, review round 1 — only auth/budget get dedicated 503s) |
| Scheduler cron | `src/scheduler/scheduler.ts:203-250` — `lastRun` stamped before dispatch; synthesized `source: {kind:"slack"}`, id `sched:…` | Failed run is lost until the next cron match (acceptable — re-fires) |
| Callbacks | `scheduler.ts:252-321` — doc marked `fired` BEFORE dispatch (`:265-269`), id `callback:<oid>` | A fast-failed callback **vanishes permanently** — marked fired, never ran |
| Event deliveries | `scheduler.ts:322-413` — `deliveries.$.status` marked fired before dispatch, id `event:…` | Same permanent loss |
| Team fire-and-forget | `scheduler.ts:415-456` — routed via `onDispatch` → dispatcher, id `team-…` | Lost (marked fired) |
| Team request_response | `scheduler.ts:457-489` — calls `runWorkItemTurn` directly, marks `failed` on throw | Requesting agent's tool gets a failure — honest enough, out of scope |
| Dedup map | `dispatcher.ts:104-108`, 60s TTL keyed on `item.id` | A replayed item with the original id within 60s would silently drop |
| Delivery retry queue | `src/sweeper/retry-queue.ts` — in-memory, delivery-only, driven by sweeper step 8 (`src/sweeper/sweeper.ts:188-201`) | **Stays as-is** (ticket text) |
| Durable-queue precedent | `agent_callbacks` collection (`src/callback/callback-mcp-server.ts:54`) + scheduler 30s poller (`scheduler.ts:146-153`) + atomic mark-fired (`:265-269`) | The wiring pattern §7.4 copies |
| Status interception | `dispatcher.ts:112-135` — health reporter, no model call | Still works during an outage (worth a doc note, no change) |

**KPR-306 contract consumed** (from `kpr-306-spec.md`, frozen): `ProviderCircuitOpenError { provider, openedAt, retryAfterMs, reason, lastFaultMessage }` thrown from the top of the `spawnTurn` ticket lambda **before** `prepareSpawn` (no router spend); `agentManager.circuitBreakers.stateFor(provider)` / `.getSnapshot()` for state reads; fast-fail releases the spawn ticket cleanly. Half-open probe = next real turn admitted; `enabled:false` = shadow mode (never throws → this ticket's paths are naturally dormant in shadow mode).

## 2. Goals

1. While the breaker is open, every affected human-facing thread gets **one immediate honest notice** per outage episode — on every channel, including the ones that are silent today.
2. Fast-failed turns (and probe-failure turns) are **queued durably and replayed automatically** after recovery, oldest-first, delivering real answers into the original threads.
3. System-fired one-shots (callbacks, events, team fire-and-forget) stop vanishing; cron turns skip cleanly.
4. Zero change to the delivery retry queue, the breaker, or the per-channel delivery contract for healthy turns.
5. Observability: queue depth/age surfaced in `hive doctor` (informational, D4) and logs; CLAUDE.md collections list updated.

## 3. Non-goals

- **Delivery retry queue changes** — explicitly out (ticket text).
- **Breaker changes** — KPR-306's contract is consumed additively; no new fields requested.
- **Voice queueing** — a live call cannot receive a deferred answer; voice gets an honest spoken failure only.
- **Team `request_response` replay** — the requesting agent's tool has a 1h TTL and its own failure surface (`scheduler.ts:479-489`); replaying into a dead waiter is useless. Keep failed-marking.
- **Reflection turns** — swallowed non-critically inside `AgentManager` (never reach the dispatcher); reflection re-fires post-quiescence. Never queued.
- **Cross-user dedup / semantic merging** of a queued question with the user's re-ask after recovery — the replay context note (§7.5) lets the model handle "I already answered this above" naturally; text-similarity machinery is YAGNI.
- **Model-router / non-spawnTurn LLM calls** — outside the breaker (KPR-306 non-goal), outside this ticket.
- **WAN-outage channel routing** — KPR-308 (see boundary note in Key Points).

## 4. Decision inputs — how the pieces interact (read before §5)

Two structural facts constrain the product options:

1. **Fast-fails are free.** `ProviderCircuitOpenError` throws before the model-router Haiku call. A replay poller can therefore blindly attempt the head item every 15s during an outage at zero marginal cost — no breaker-state pre-check needed, and each post-cooldown attempt is automatically the half-open probe.
2. **Probes must be fed.** Any design that stops *all* traffic from reaching `spawnTurn` while open (e.g. proactive queue-at-intake) starves KPR-306's recovery mechanism. The reactive design keeps two probe feeders: live user turns and replay attempts.

## 5. Product decisions (OPERATOR RULES HERE)

### Decision 1 — Honest-response content, tone, and repetition per channel

What a floor worker / customer / operator sees when the model provider is down.

**1a. Repetition policy** (applies to all channels):

| Option | Behavior | Trade-off |
|---|---|---|
| **(i) Once per thread per episode ← recommended** | First fast-fail in a thread → notice; subsequent turns in that thread during the same episode queue silently | One promise, kept once; no spam during a 30-min outage where a user sends 5 follow-ups. Requires episode tracking (Key Points; cheap) |
| (ii) Every message | Notice per fast-failed turn | Maximally explicit, but during a real outage reads as a broken robot shouting; SMS cost scales per message |
| (iii) Once per thread + refresh after 15 min | Re-notify if the outage outlives a timer and the user writes again | Nice-to-have; adds a second timer dimension for marginal value — defer, additive later |

**1b. Notice content** (⚠ wording delegated; structure decided here). One template, channel-formatted, agent-voiced (delivered as the resolved agent, so Slack shows the agent's name/icon exactly like a normal reply):

- **Slack / app (WS):** `⚠️ I can't reach my AI service right now (provider outage). Your message is saved — I'll answer it automatically as soon as service is back.`
- **SMS / iMessage:** `Our AI assistant is temporarily down. Your message is saved and you'll get a reply when service returns.` (One per sender per episode — SMS costs money and has no threads; keyed on `threadId ?? sender`.) **Note: this is a behavior change from silence to one honest text per episode — deliberate.**
- **Voice:** spoken, not queued: `I'm having trouble reaching my AI service right now — please try again in a few minutes.` Implementation: voice adapter catches `ProviderCircuitOpenError` from `routeVoiceTurn`/`spawnTurn` and returns that sentence as the completion text — preferable to today's baseline, which is a generic **500** "Internal error" (`endWithError` at `voice-adapter.ts:368`; only the auth (`:350`) and spawn-budget (`:359`) paths get dedicated 503s today — Finding 5, review round 1) — either a bare 500 or 503 renders as dead air to Vapi. ⚠ Confirm Vapi renders a normal completion better than a 500/503 during rollout.
- **No retry-time promises in the text.** `retryAfterMs` is probe cadence, not recovery ETA — quoting it would be dishonestly precise.

**1c. Do queued-but-silent turns get any acknowledgment?** Recommended: no extra machinery. Option (additive later): Slack reaction (🕐) per queued message — requires a gateway reaction API that `ChannelAdapter` doesn't expose today; not worth the interface change for v1.

### Decision 2 — Replay semantics

**2a. Durability:**

| Option | Behavior | Trade-off |
|---|---|---|
| **(i) Mongo-backed `outage_queue` ← recommended** | Survives restart; doctor can read it out-of-process; precedent (`agent_callbacks`) is exactly this shape | One new collection + poller (~the same 60 lines either way) |
| (ii) In-memory (retry-queue style) | Symmetric with the breaker's own in-memory state | An engine restart mid-outage — a *likely* operator move — silently drops every queued customer message, which is the ticket's named failure mode. Rejected unless the operator explicitly prefers process-simplicity |

**2b. Ordering:** strictly serial global drain, oldest `enqueuedAt` first. Per-thread FIFO falls out for free; the per-thread spawn lock and spawn budget make parallel drain an optimization with no v1 payoff (30-min outage volumes are tens of items, and serial drain also naturally rations post-recovery load).

**2c. Expiry / TTL:** items older than `maxAgeHours` (default **4h** ⚠) at replay time are marked `expired`, not run — a 4-hour-old "is the truck here yet?" answered confidently is worse than honesty. What the user sees:

| Option | Trade-off |
|---|---|
| (i) Silent expiry (log + doctor count only) | Simplest, but breaks the notice's "I'll answer when service returns" promise |
| **(ii) One batched per-thread notice at drain time ← recommended** | `Service is back — I couldn't get to N earlier message(s) from during the outage. Please re-send anything still needed.` One aggregation pass at drain; honest, no spam |
| (iii) Per-item expiry notices | Spams a thread that queued many messages |

**2d. Replayed-turn presentation:** prompt-note, not hard text prefix. The queued item's text is wrapped at replay: `[This message was received at <time> during an AI service outage and is being replayed now. Acknowledge the delay briefly if a human sent it.]\n\n<original text>`. The model handles phrasing, staleness, and the re-ask-dedup case (Non-goals) in its own voice. A hard `"(answering your earlier question)"` prefix is brittle across channels and voices — rejected.

**2e. Dedup with the user re-asking after recovery:** none beyond 2d (both messages are in the same thread/session; the context note tells the model the earlier one is a replay). Recorded as a decision, not a gap.

**2f. Max queue depth:** global cap, default **500** ⚠. When full, the turn is NOT queued and the notice swaps to the overflow variant: `…I can't even save your message right now — please re-send it later.` (Honest about the drop; drop-oldest would silently break promises already made to other threads.) Per-agent caps: YAGNI.

**2g. Replay failure handling — outcome table (dispatcher-authored, not poller-inferred; Finding 2, review round 1):** `dispatcher.dispatch()` returns `Promise<void>` and never rethrows (both catches at `dispatcher.ts:258-275`/`:646-663` deliver internally), so the replay processor cannot tell success from real-failure from fast-fail from a disabled-agent drop by awaiting `dispatch()` alone. Fix: the dispatcher's outage-path helper and success path both check `item.meta?.outageReplay` and call `store.release(itemId, outcome, ...)` directly — this table is normative for §7.2/§7.4 too, not restated differently there:

| Outcome at replay dispatch | Store result |
|---|---|
| Delivered normally (no outage path triggered) | `done` |
| Non-response suppressed (`NON_RESPONSE_PATTERNS`) | `done` — the model chose not to answer; nothing left to redeliver |
| All resolved agents disabled (`activeList.length === 0`, `dispatcher.ts:149-157`) | `expired`, `lastError: "agent disabled — will not be replayed"`, no notice — the item cannot run again short of re-enabling the agent, and `expired` already carries "we won't deliver an answer" semantics without falsely implying `done` |
| Fast-fail again (`ProviderCircuitOpenError` / post-turn open-state, §7.2) | back to `pending`, attempts unchanged (breaker-open retries are free and expected — counting them would exhaust attempts during the outage itself). Relies on the dedup bypass (Key Points, §7.4 step 3) since the item keeps its original `id` |
| Real failure (turn errored, breaker closed) | attempts+1; `failed` once attempts reach `maxReplayAttempts` (default **3** ⚠), else back to `pending` |

On the `failed` transition, the normal dispatcher error path (`"Something went wrong: …"`) does **not** reach the user on every channel: that `WorkResult` has `error` set, and SMS (`sms-adapter.ts:61-65`) and iMessage (`imessage-adapter.ts:112-116`) both skip delivery outright when `result.error` is set — so on those channels a terminal-failure "the user is not left in silence" claim was false (Finding 6, review round 1). Fix: on `failed`, `notify`-policy items additionally get a plain-text notice (`error` UNSET, same mechanism as §7.3/Key Points): `"I still can't reach my AI service after several tries — your message from <time> could not be answered. Please re-send it."` `silent`-policy items (callback/event/team-) get no notice on `failed`, consistent with their enqueue-time silence.

### Decision 3 — Scope of queueing

**3a. Sources** (policy table — recommended as a package):

| Source (detection) | Policy | Rationale |
|---|---|---|
| Human channels: slack, sms, imessage, app/ws, team DM (default case) | **Queue + notice** | The ticket's core case |
| Cron (`item.id` prefix `sched:` — format at `scheduler.ts:231`) | **Skip with log** | Cron re-fires at the next match; queueing double-runs the task after recovery |
| Callback (`callback:` prefix) | **Queue, silent** | Marked `fired` pre-dispatch — today it vanishes permanently; queueing preserves the one-shot. No human to notify (the eventual replay lands in the original channel). Alternative considered: revert the callback doc to `pending` — rejected: two replay mechanisms for one outage, and the queue already holds the fully-synthesized WorkItem |
| Event delivery (`event:` prefix) | **Queue, silent** | Same one-shot-loss argument |
| Team fire-and-forget (`team-` prefix) | **Queue, silent** | Same |
| Team request_response | Keep failed-marking | Non-goal (waiter TTL) |
| Voice | Honest spoken text, **no queue** | Live call |
| Reflection | Never reaches dispatcher | Non-goal |

⚠ Prefix-based detection is stable at baseline (all synthesized ids are format-fixed in `scheduler.ts`) but stringly; the implementer may instead add one `meta.outagePolicy` field at the three synthesis sites if review prefers — behavior identical for the default case. One more asymmetry worth weighing (Finding 7, review round 1): ws/app item ids are **client-supplied**, not engine-controlled — `ws-adapter.ts:262`, `:294`, `:519` all use `id: msg.id || randomUUID()` — so a WS client that happened to send an id starting with a reserved prefix (`sched:`, `callback:`, `event:`, `team-`) would misclassify under prefix detection. This doesn't change the human-channel default case (WS items still fall through to `notify`), but it's further weight toward the `meta.outagePolicy` field, which is engine-set at the three synthesis sites and immune to client-supplied ids.

**3b. Agents:** **all agents.** A per-agent opt-out (or floor-critical-only queueing) has no motivating case — the honest notice is universally better than the raw error on every channel, and queue depth is globally capped. KPR-308's `floorCritical` flag is a delivery-routing concept, not a queueing one; borrowing it here would tangle the two tickets. Revisit only if a real agent class emerges whose queued replays are worthless.

## 6. Recommended v1 (assembled from §5 recommendations)

Reactive interception in both dispatcher catches + post-turn open-state check → Mongo `outage_queue` (serial 15s replay poller, 4h TTL, depth 500, 3 real attempts) + once-per-thread-per-episode plain-text notices (silent for system one-shots, skip for cron, spoken-only for voice) + batched per-thread expiry notice + prompt-note replay presentation. Everything else in §5 stays a decision record.

## 7. Design

New directory `src/outage/` (three files, KPR-294/295 granularity precedent), logger `createLogger("outage-queue")` / `("outage-replay")`.

### 7.1 `src/outage/outage-queue-store.ts`

```ts
export interface OutageQueueDoc {
  _id: ObjectId;
  itemId: string;            // original WorkItem.id — unique index (idempotent enqueue)
  agentId: string;           // resolved agent, pinned for replay
  provider: AgentProviderId; // from ProviderCircuitOpenError.provider (or stateFor lookup on the post-turn path)
  workItem: WorkItem;        // serialized verbatim (Date + meta survive BSON round-trip)
  policy: "notify" | "silent";
  status: "pending" | "replaying" | "done" | "expired" | "failed";
  attempts: number;          // real (non-fast-fail) replay attempts
  enqueuedAt: Date;
  lastAttemptAt: Date | null;
  lastError: string | null;  // truncated 240, mirrors KPR-306 convention
  noticeSent: boolean;
}
```

Store API: `enqueue(doc)` (upsert on `itemId` — double-enqueue is a no-op), `claimNext()` (atomic `findOneAndUpdate` pending→replaying, oldest `enqueuedAt` first — copies the callback poller's mark-before-dispatch pattern at `scheduler.ts:265-269`), `release(id, outcome)`, `pendingCount()`, `expireOlderThan(cutoff)` (returns expired docs grouped by thread for the batched notice). Indexes: `{ itemId: 1 } unique`, `{ status: 1, enqueuedAt: 1 }`, TTL index on terminal-status docs (`doneAt`, 7d) for hygiene. Boot recovery: `replaying` docs older than one turn deadline (300s + slack) revert to `pending` (crash between claim and release).

### 7.2 Dispatcher interception (both catch sites, `dispatcher.ts:258` and `:646`)

Extract today's duplicated catch bodies into one private helper (`handleTurnFailure(err, item, agentId, adapter)`) — the near-duplication is pre-existing debt this change would otherwise triple. Logic:

```
classify:
  err instanceof ProviderCircuitOpenError                      → outage path (provider from err)
  else if turn errored AND stateFor(providerFor(agentId))?.state === "open"
       AND classifyTurnResult({ error: runResult.error }).outcome === "fault"
       AND HARD_FAULT_KINDS.has(classification.kind)          → outage path (probe-failure / trip-crossing turn)
  else                                                         → existing "Something went wrong" path, unchanged
outage path:
  policy = policyFor(item)            // §5-3a table
  if policy === skip   → log.info, return
  if depth ≥ maxDepth  → deliver overflow notice (notify policy only), log.warn, return
  if item.meta?.outageReplay → store.release(itemId, outcome)   // §5-2g table — dispatcher writes the outcome
  else                       → store.enqueue(...)
  if policy === notify AND episodeTracker.firstForThread(provider, threadKey)
       → adapter.deliver({ text: notice, agentId, workItem: item, costUsd: 0, durationMs: 0 })   // error UNSET
         (delivery failure → existing retryQueue.enqueue, same as any message)
```

The second classification leg needs two additions beyond `stateFor`, both required to avoid over-matching (Finding 4, review round 1 — a tool-error `TurnResult` with the breaker merely *coincidentally* open would otherwise queue and later replay a partially-executed turn's side effects):
- the agent's provider in the dispatcher: expose `agentManager.providerFor(agentId)` (one-liner over `resolveProviderModel(config.model).provider`, both already in `agent-manager.ts` per KPR-306 §"wrap point") — additive, no contract change;
- KPR-306's exported classifier (`classifyTurnResult`, `HARD_FAULT_KINDS` — `src/agents/provider-adapters/error-classification.ts`). Per KPR-306 (§"Additive and optional"), `TurnResult`/the dispatcher's own `RunResult` carry no `timedOut`/`aborted` flags downstream — those stay internal to `AgentManager`'s breaker recording — so the dispatcher's call is `classifyTurnResult({ error: runResult.error })`; sufficient, since the flags only gate the timeout/aborted rules and this leg only ever runs where `runResult.error` is already set. Only a result that classifies into `HARD_FAULT_KINDS` (connect-fail/timeout/rate-limit/auth/server-error) takes the outage path; a `non-provider` classification (tool error, `error_max_turns`, etc.) while the breaker happens to be open follows the **legacy** "Something went wrong" path unchanged — it isn't a provider fault and its side effects should not be silently re-run.

**Post-turn success on a provider clears its episode — gated on `stateFor(provider)?.state !== "open"` at that moment** (Finding 3, review round 1). Without the gate, a turn issued before the trip that lands and succeeds *after* the breaker has already opened would clear the episode the very next tick starts a "new" one, doubling the notice mid-outage. The gate costs one extra `stateFor` read in the success-path hook.

Also required: the success path must mark this — a `TurnResult` with `errors[0]` set currently flows through the *success* branch as a delivered error result (`workResult.error = runResult.error`, `dispatcher.ts:225`, then `slack-adapter.ts:142` formats it). The probe-failure check therefore lives where `runResult.error` is inspected, not only in the catch. Implementation detail for the plan: one guard before the `WorkResult` build in both dispatch bodies.

**Disabled-agent drop is a third early-return the outcome table must cover** (Finding 2, review round 1). `activeList.length === 0` returns before the try/catch (`dispatcher.ts:149-157`), so a replayed item (`meta.outageReplay`) whose agent got disabled mid-outage would otherwise never resolve its `outage_queue` doc. Add one check at that return: if `item.meta?.outageReplay`, call `store.release(itemId, "expired", "agent disabled — will not be replayed")` before returning (§5-2g table).

**Dedup bypass** (Finding 1, review round 1): step 0 of `dispatch()` (`dispatcher.ts:104-109`) gains one condition — `if (this.recentMessageIds.has(item.id) && !item.meta?.outageReplay)`. Replay items keep the *original* `itemId`/`id` (no synthetic `replay:<attempt>:…` id — see Key Points and §7.4 step 3), since dedup no longer needs to be dodged by a fresh id.

### 7.3 `src/outage/outage-notices.ts`

Templates from §5-1b (exported constants so tests pin them), the episode tracker (`Map<provider, { episodeId, startedAt }>` + `Set<episodeId:adapterId:threadKey>` for notice dedup, in-memory, swept with the dispatcher's existing `sweep()`), and `policyFor(item)` (the §5-3a prefix table).

**Fan-out race (Finding 8, review round 1):** fanned-out agents run under `Promise.all` (conference mode `dispatcher.ts:167`, multi-agent fan-out `:182`), so each fanned agent's catch/outage-path runs concurrently on the same thread. `episodeTracker.firstForThread(provider, threadKey)` MUST be a synchronous test-and-set (a single `Set.has` + `Set.add` with no `await` between the check and the mark) or two agents fast-failing in the same tick would both observe "first" and double-notify one thread. The `Map`/`Set` design above is synchronous by construction — this is a normative constraint on the implementation, not a new data structure.

### 7.4 `src/outage/outage-replay-processor.ts`

Own 15s timer (`replayIntervalMs`), started/stopped in `src/index.ts` beside the scheduler — NOT a sweeper step (sweeper cadence is 5-min-class; recovery-to-replay latency should track the breaker's ≤60s probe cadence). Each tick, serially:

1. `expireOlderThan(now - maxAgeMs)` → for `notify`-policy expired docs, deliver one batched per-thread expiry notice (§5-2c-ii) via the source adapter.
2. `claimNext()`; if none, done.
3. Re-dispatch: `dispatcher.dispatch({ ...doc.workItem, text: replayWrap(doc), meta: { ...doc.workItem.meta, targetAgentId: doc.agentId, outageReplay: true } })` — **no id override** (Finding 1, review round 1). The first draft synthesized a fresh id (`"replay:" + doc.attempts + ":" + doc.itemId`) to dodge the 60s dedup map (`dispatcher.ts:104-109`), but §5-2g doesn't increment `attempts` on fast-fail, so during an open breaker the id would repeat (`replay:0:<itemId>`) on every 15s tick and the dedup map would silently drop every attempt after the first — the exact message-loss the ticket exists to prevent. Fixed design: keep the item's original `id`; `dispatch()` bypasses the dedup check when `item.meta?.outageReplay` is set (§7.2) instead — dedup exists for externally-duplicated deliveries, and a replay is engine-authored, so there's nothing to dedup against. `targetAgentId` pins agent resolution (step 0); original `source`/`meta.slackThreadTs` route the reply to the original thread through the normal delivery path.
4. Outcome: **written by the dispatcher itself, not inferred here** (Finding 2, review round 1) — `dispatcher.dispatch()` returns `Promise<void>` and never rethrows, so awaiting it tells the poller nothing about success vs. real-failure vs. fast-fail vs. a disabled-agent drop. The dispatcher's success path and outage-path helper both check `item.meta?.outageReplay` and call `store.release(itemId, outcome)` per the table in §5-2g: `done` (delivered, or non-response-suppressed), `expired` (all resolved agents disabled), `pending`/attempts-unchanged (fast-fail again — **no second notice**, episode dedup holds), or attempts+1/`failed` at cap (real failure). The processor's only job after `claimNext()` is to await the redispatch and move on; it does not decide the outcome itself.
5. On success of an item, loop to the next immediately (drain), yielding between items; stop draining on the first fast-fail.

The tick needs no breaker-state check: attempt-and-see is free while open (pre-router fast-fail) and IS the probe when the cooldown has elapsed. Re-entrancy is handled by the same-`itemId` design in step 3: the replay item's own fast-fail routes through §7.2, which recognizes `meta.outageReplay` and calls `store.release` on the existing doc (by `itemId`) rather than creating a duplicate or sending a second notice (the `noticeSent` flag holds regardless).

### 7.5 Replay prompt wrap

`replayWrap(doc)` = the §5-2d context note + original text. Human-sender items get the "acknowledge the delay" variant; `silent`-policy items get a minimal `[Replayed after an AI service outage; originally received <time>.]` note.

### 7.6 Config, telemetry, doctor, docs

- **Config** (`config.ts`, liberal-loader, all-optional `??` defaults — KPR-225 F3):
  ```yaml
  outageQueue:
    enabled: true          # false = no queueing/notices; fast-fails fall back to today's error path
    replayIntervalMs: 15000
    maxAgeHours: 4
    maxDepth: 500
    maxReplayAttempts: 3
  ```
- **Doctor** (informational, D4 — never flips exit code): new rows in a "Outage queue" section reading the collection **directly** (the queue is durable — unlike the breaker, no heartbeat proxy needed; mirror the short-lived-client pattern of `spawnCoordinatorStatsForDoctor`, `src/cli/doctor-checks.ts:331`): pending count, oldest pending age, expired/failed counts (24h), flagged `⚠` when pending > 0 with the breaker section showing closed (stuck-drain signal).
- **Logs** (sustained-condition discipline, mirrors KPR-306): `log.warn` on first enqueue per episode; `log.info` per notice, per drain start/end with counts; `log.error` on `failed`/overflow. No message text/previews (redaction convention) — notice templates are static strings, safe to log by name.
- **CLAUDE.md**: add `outage_queue` to the engine-written collections list; Common Gotchas note (honest-outage behavior + `outageQueue` hive.yaml section + "SMS/iMessage now send one outage text per episode instead of silently skipping").

## 8. Failure modes & edge cases

- **Restart mid-outage:** breaker resets (KPR-306 design); queue persists; poller's first attempt either re-trips the breaker (still down — item back to pending, free) or drains (recovered while restarting). `replaying` orphans revert on boot (§7.1).
- **Shadow mode (`circuitBreaker.enabled: false`):** `acquire` never throws → no `ProviderCircuitOpenError` → this ticket is dormant except the post-turn open-state check, which also never fires (shadow snapshots do report `state: "open"` — so gate the post-turn leg on `snapshot.enabled === true` to keep shadow mode fully observational). ⚠ Plan-level detail; flagged so it isn't missed.
- **`outageQueue.enabled: false`:** interception disabled entirely; behavior identical to post-KPR-306/pre-KPR-307 (raw error surfacing). Independent kill-switch from the breaker's.
- **Files on queued items:** `ProcessedFile.localPath` (`src/files/file-processor.ts:32-41`) points at temp files subject to the sweeper's `taskFileTtlMs`; a replay hours later may reference a deleted path. `textContent` (inlined) survives. Accepted v1 edge: replay proceeds, the agent's Read of a missing image fails like any missing file. Noted for the plan; not worth pinning file lifetimes to queue TTL.
- **Multi-provider instances:** episodes and the post-turn check are per-provider; a gemini outage never notices/queues claude-routed agents' turns. The queue is provider-tagged but the poller drains globally — a queued gemini item attempted during a separate claude outage just runs (its provider is fine). Correct without per-provider drain lanes.
- **Fan-out threads:** each fanned agent fast-fails separately; notice dedup is per-thread, so one notice despite N agents (the notice speaks as the first-failing agent — acceptable; a "system" voice variant is a wording option for the operator).
- **User keeps typing during outage:** each turn queues (silently after the first notice); replay drains in order into the same thread; session continuity comes from the thread's session resume as usual.
- **Notice delivery fails (e.g. combined WAN outage):** retryQueue handles it — and if Slack is dead but the app channel is up, KPR-308's diversion (if the agent is floor-critical) reroutes it. Degenerate total-outage case: notice is retried/dropped by the existing delivery machinery; the queued turn is unaffected.
- **Status queries** (`dispatcher.ts:112-135`) bypass the model and keep working — the operator can ask "status" mid-outage and get the health report.
- **Clock/ordering:** `enqueuedAt` from a single engine host; no cross-host ordering concerns.

## 9. Integration points (re-confirm at HEAD)

| File | Change |
|---|---|
| `src/outage/outage-queue-store.ts` | **new** — collection schema, enqueue/claim/release/expire |
| `src/outage/outage-notices.ts` | **new** — templates, episode tracker, `policyFor` |
| `src/outage/outage-replay-processor.ts` | **new** — 15s poller, drain loop, expiry notices |
| `src/channels/dispatcher.ts` | extract shared failure helper from `:258-275` + `:646-663`; outage classification (instanceof + post-turn open check gated by KPR-306's `classifyTurnResult`/`HARD_FAULT_KINDS`, incl. the success-branch error guard near `:207-226`); episode-clear on success gated on `stateFor(provider)?.state !== "open"`; dedup-check bypass for `item.meta?.outageReplay` (`:104-109`); disabled-agent early return (`:149-157`) resolves `outage_queue` for replay items; dispatcher writes the replay outcome directly (§5-2g table) instead of the poller inferring it; plain-text terminal-failure notice on `failed` for notify-policy channels |
| `src/agents/agent-manager.ts` | additive `providerFor(agentId)` helper (wraps existing `resolveProviderModel`) |
| `src/channels/voice/voice-adapter.ts` | catch `ProviderCircuitOpenError` → spoken outage text (§5-1b) |
| `src/config.ts` | `outageQueue` section (liberal, all-optional) |
| `src/index.ts` | construct store + processor (needs db, dispatcher, config); start after adapters, `stop()` in shutdown |
| `src/cli/doctor-checks.ts` / `src/cli/doctor.ts` | informational "Outage queue" section (direct collection read) |
| `CLAUDE.md` | collections list + gotchas (per §7.6) |

Untouched by design: `src/sweeper/retry-queue.ts`, `src/scheduler/scheduler.ts` (unless the operator picks the `meta.outagePolicy` variant in §5-3a), all adapter `deliver()` implementations, KPR-306's breaker files, KPR-306's `error-classification.ts` (imported/consumed only — `classifyTurnResult`/`HARD_FAULT_KINDS`, no changes).

## 10. Delegated assumptions (⚠)

- ⚠ Defaults: 15s replay tick, 4h TTL, depth 500, 3 real replay attempts, 7d terminal-doc TTL — operator-tunable, chosen for the 30-minute-outage profile.
- ⚠ Notice wording (§5-1b) — structure decided, copy editable at review.
- ⚠ SMS/iMessage behavior change (silence → one honest text per episode) — deliberate, called out because it is user-visible and costs one outbound SMS per sender per outage.
- ⚠ Mongo durability over in-memory (§5-2a) — reversible cheaply if ruled otherwise (the store interface is the seam).
- ⚠ Prefix-based source policy detection (§5-3a) vs. a `meta.outagePolicy` field — behaviorally identical for the default case; implementer/reviewer's choice. The cost balance shifted since review round 1: `meta.outageReplay` (Finding 1) is now load-bearing regardless of this choice, and the WS client-supplied-id caveat (Finding 7, §5-3a) is one more argument for `meta.outagePolicy` — `meta` plumbing is already touched at the enqueue/replay sites either way.
- ⚠ Batched expiry notice (§5-2c-ii) over silent expiry.
- ⚠ Voice honest-text-as-completion vs. 503 — confirm against Vapi behavior during rollout.
- ⚠ New `src/outage/` directory — first module with no obvious existing home (`sweeper/` is delivery-side, `agents/` is spawn-side; this straddles dispatch).

## 11. Testing outline (unit-heavy; no live providers, faked clock)

Vitest, colocated. Time via injected `now`; breaker via a stubbed `circuitBreakers` (`stateFor` fixture) and thrown `ProviderCircuitOpenError` literals; Mongo via the repo's existing in-memory/mocked collection patterns in `dispatcher.test.ts` precedents.

- `outage-queue-store.test.ts` — enqueue idempotency (unique itemId), claim ordering (oldest first), atomic claim (no double-claim), expiry grouping by thread, boot-recovery of stale `replaying`.
- `outage-notices.test.ts` — policy table (every §5-3a row, incl. prefix detection); episode lifecycle: open → notice once → repeat turns silent → success clears → next outage notices again; probe-cycle `openedAt` churn does NOT re-notice; per-sender key for SMS (`threadId ?? sender`).
- `dispatcher.test.ts` (extend) — instanceof path queues + delivers plain-text notice (assert `error` UNSET on the delivered WorkResult — the SMS-skip regression guard); post-turn open-state path (errored TurnResult + open snapshot + `HARD_FAULT_KINDS` classification → outage path; + `non-provider` classification while open → legacy error path, Finding 4; + closed snapshot → legacy error path; + shadow `enabled:false` open snapshot → legacy path); skip for `sched:`; silent-queue for `callback:`/`event:`/`team-`; overflow variant at maxDepth; `outageReplay` re-entrancy (no dup doc, no second notice, dedup bypass lets the same id redispatch, Finding 1); disabled-agent replay resolves to `expired` (Finding 2); episode cleared on success only when `stateFor(provider)?.state !== "open"` (Finding 3); fan-out single notice per thread via synchronous test-and-set (Finding 8); `failed` transition delivers a plain-text terminal notice on notify-policy channels, none on silent (Finding 6).
- `outage-replay-processor.test.ts` — drain order; fast-fail → pending, attempts unchanged, drain stops; real failure → attempts+1 → `failed` at cap; same `itemId`/dispatch id redispatched every tick without being silently dropped, via the `meta.outageReplay` dedup bypass (not a fresh per-attempt id — Finding 1); expiry → batched notice per thread; wrap text for notify vs silent policies; `enabled:false` no-ops.
- `voice-adapter.test.ts` (extend) — `ProviderCircuitOpenError` → spoken outage completion, not generic 503.
- `doctor.test.ts` / `doctor-checks.test.ts` (extend) — section renders counts; empty-queue message; exit code unaffected (D4 assertion).
- `config.test.ts` (extend) — absent section → defaults; partial → per-key `??`.

Gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.

## 12. Decision register note

Epic KPR-305 canon at draft time: Gate 1 rulings **D3** (KPR-308 LAN architecture — first canon), **D4** (doctor sections informational; identity-class only may fail — §7.6 complies), **D5** (KPR-306 scope), **D6** (audit artifact unrecoverable). Nothing here revisits them. KPR-306's **Open-Circuit Contract** is consumed as-frozen (fields used: `provider`, `openedAt` — with the episode caveat, `retryAfterMs` — deliberately NOT quoted to users, plus `stateFor()`/`snapshot.state`/`snapshot.enabled`); the one additive ask on the hive side is `agentManager.providerFor()`, which is KPR-307 code, not a contract change. The operator's rulings on §5 Decisions 1–3 become new canon entries for this epic.

## 13. Open questions

1. **[BLOCKING — Decision 1]** Notice repetition (recommend once-per-thread-per-episode) + content sign-off per channel (§5-1), including the SMS silence→one-text behavior change and the voice spoken-text approach.
2. **[BLOCKING — Decision 2]** Replay semantics package (§5-2): Mongo durability, serial oldest-first drain, 4h TTL with batched expiry notice, prompt-note presentation, no re-ask dedup, depth-500 overflow-with-honest-variant, 3-real-attempt cap.
3. **[BLOCKING — Decision 3]** Queueing scope (§5-3): the source policy table (cron skips; callbacks/events/team one-shots queue silently — note this un-vanishes callbacks, a behavior improvement beyond the ticket's literal text) and all-agents scope (no floor-critical coupling).
4. **[Non-blocking]** Prefix-detection vs `meta.outagePolicy` field for source policy (⚠ §10).
5. **[Non-blocking]** Fan-out notice voice: first-failing agent vs a neutral "system" voice (§8).
6. **[Non-blocking]** Should the overflow / expiry notice copy be operator-configurable in hive.yaml, or constants-only for v1 (recommended: constants)?
