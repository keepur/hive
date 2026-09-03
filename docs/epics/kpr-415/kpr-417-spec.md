# KPR-417 — Delay-then-ack for long-running conference turns

**Epic:** KPR-415 (Meeting mode hardening) · **Child:** B1 · **Kind:** child spec · **Status:** spec-ready — approved spec-review/2/opus (tier-degraded, operator-override), clean
**Governing design:** `keepur/hive-docs` → `internal/specs/2026-08-28-meeting-mode-hardening-design.md`, §"Design — Child B1: delay-then-ack for long-running turns", §"Background" (trial observation 2), §"Testing expectation (epic-level)" (approved, spec-review/8/frontier, clean)
**Repo baseline:** `hive-KPR-415` worktree, branch `KPR-415` at `118bde4`. Every line citation below was re-verified against this tree.
**Revision:** r1 — spec-review round 1 (5 blocking + 6 advisory findings folded in). Changed since r0: Key Points bullet on replay/leg ack-freedom (the two paths fail to ack for *different* reasons — replays retain conference meta); §11's behavioral dependency re-stated as depending on KPR-416's *relocation*, not its predicate (T11's purpose corrected to match); §6.6 added (KPR-308 outage diversion — the fifth orphan shape); §9's fake-timer/drain reconciliation prescribed; `MEETING_ACK_TEXT` changed to `"On it — picked this up."` so the text and its honesty rationale agree during the lock-wait window.
**Blocked by:** KPR-416 (Child A) — merges first; see §11 for the shared hunk and the behavioral dependency.

---

## TL;DR

A round-0 conference responder that is still unresolved ~15s after dispatch posts one lightweight acknowledgment into the meeting thread, attributed to that agent; fast responders never reach the threshold and never ack. The ack is **operational chrome, not meeting content**: it is recognized by a stable content pattern (the `NON_RESPONSE_PATTERNS` precedent) and stripped at a **single** history-fetch point, which is what makes all five ingestion consumers — full injection, delta injection, the `meetingLastSeenTs` mark, the round-0 classifier's recency window, and the meeting scribe — ack-blind in one hunk instead of five. Round-1 turns are never acked (KPR-389 §D5's silent-kill contract), no ack is ever retracted, and the whole feature is behind `meetingWorkers.ackEnabled`.

---

## Key Points

- **Recognition mechanism (the epic's named open decision) — RESOLVED: a stable content pattern, plus a single strip point.** `ThreadMessage` (`slack-adapter.ts:19-29`) is built from `conversations.replies` and carries no hive-side channel for a `meta` flag, so option 1 would need Slack message-metadata plumbing (`include_all_metadata`, a new field on `ThreadMessage`, and a story for the split/file post paths). A ts-keyed registry (option 3) is **restart-fragile**: a meeting thread outlives an engine restart, and after one the registry is empty while the acks are still in Slack — the classifier-window regression the epic names would silently return. The content pattern is durable by construction, needs zero new state, and mirrors the mechanism the file already uses to recognize an engine-meaningful message by its bytes (`NON_RESPONSE_PATTERNS`, `dispatcher.ts:54-59`). ⚠ Its collision residual is named in §8.
- **All five exclusions collapse to one code change.** Every one of the five consumers reads the *same* `ThreadMessage[]` produced at exactly two sites (`dispatcher.ts:1576`, `:1932`). Replacing both with one private `fetchMeetingHistory` wrapper that strips acks makes the full arm, the delta arm, the high-water mark, `history.slice(-5)` (`:1578-1581`) and `noteActivity` (`:1601`, `:1954`) ack-blind with **no per-consumer edits**. The strip is deliberately **not** gated on `ackEnabled` — flipping the lever off must not un-hide acks already in the thread.
- **Prior art determination (`onProcessingStart`/`onProcessingEnd`) — NOT sufficient, and not adopted as a complement.** Both epic-design candidate reasons verified true in this tree, and the second is disqualifying on its own: `setThreadStatus(channel, threadTs, status)` (`slack-gateway.ts:292-298`) has **no agent dimension**, so N concurrent responders collapse into one slot; and `onProcessingEnd` clears unconditionally with no refcount (`slack-adapter.ts:166-173`), so in a 4-agent fan-out the 2-second finisher **erases the indicator while the 130s agent is still working** — it inverts the signal for precisely the case this epic exists to fix. Third, verified-in-code: the call targets Slack's *Assistant* thread surface and its failures are swallowed by a warn (`:295-297`), so on an ordinary `conf-*` channel thread a non-render is indistinguishable from success. Full derivation in §4.
- **Four failure paths, one uniform rule: the ack is never retracted and never followed by an engine-authored "never mind."** It is a true statement about dispatch state at the moment it was posted, and the ack wording is chosen to say exactly that rather than promise a reply (§5.3). Errored/thrown turns and deadline aborts already post their own visible resolution; the two paths that can end in *silence* are the 2nd..Nth agent of an outage episode (per-thread notice dedup, `dispatcher.ts:1003`) and the suppressed responder. Both are accepted, not mechanized — see §6 and the next bullet.
- **The fourth case is materially less bad than the epic design assumed, because of KPR-416.** Under Child A's delivery-time write a **suppressed** round-0 turn writes no reaction-exclusion, so an agent that acked and then said `"No response needed."` stays round-1-eligible and may still post a reaction to a slower peer on the same trigger. "Orphaned ack" therefore *can be* "ack, then a reaction two minutes later" rather than permanent silence — a real possibility, not a common outcome (§6.4 ground 2 bounds how narrow the population actually is). This weakens the case for a retraction mechanism that would itself be new meeting noise.
- **Round-0 gating is a contract, not a default.** `resolved.conferenceMode && resolved.conferenceRound === 0` only. KPR-389 §D5's goal 5 — *"A clamp-killed reaction never posts noise into the meeting channel"* (`kpr-389-spec.md:39`) — is violated the instant a round-1 turn acks and is then silently killed at `dispatcher.ts:1423-1434`. No round-1 retraction path is designed here; round-1 acking is out of scope for this child.
- **At most one ack per (agent, human trigger)** — and the two other legs that can carry a round-0 conference turn are ack-free for **different reasons, which must not be conflated.** *Outage replays keep their conference meta*: `meta.conferenceRound` survives onto the replayed item and is load-bearing elsewhere (it is the KPR-389 §D5b discriminator at `dispatcher.ts:370`, `conferenceRoundOf(item) === 1`, and the item KPR-416 reads `meta.meetingExclusionTs` off). A replay cannot ack because it runs `dispatch()`'s **single-dispatch leg**, which builds a bare `ResolvedAgent` with no `conferenceMode`/`conferenceRound` on it and has **no ack machinery wired to it at all** — the gate reads `resolved`, never `meta`, and there is nothing on that leg to fire. *KPR-402 continuation legs* are ack-free for the other reason: the KPR-413 blocklist at `:846-853` strips the four conference keys off the leg's meta, so the leg is not a conference turn on either surface. Total acks per trigger ≤ the number of round-0 selectees still unresolved at 15s, i.e. the grok-shaped population only.
- ⚠ **Delegated assumption (non-blocking) — the substitution itself.** The operator's literal ask was an *immediate* "got it" (epic design, Background/trial observation 2); this ships delay-then-ack instead, and the epic design flags that as wanting her confirmation. Recorded here as delegated under KPR-415's Gate 1 signoff (granted 2026-08-28), per the mature-playbook signoff model. Rollback if she disagrees is a one-line constant (`MEETING_ACK_DELAY_MS = 0` behaves as an immediate ack) — the mechanism does not need redesigning to honor the literal ask.
- ⚠ **Delegated assumption (non-blocking) — `ackEnabled` is independent of `meetingWorkers.enabled`,** deliberately diverging from `scribeEnabled`'s nesting under it. The scribe consumes `pool.runRoleTurn`/`hasCapacity`, so the worker master switch must kill it; the ack consumes no pool machinery at all. It lives in the `meetingWorkers` section for config locality (the epic design's explicit choice), not because it is a worker feature. §5.6.

---

## 1. Problem

Trial observation 2 (epic design, Background): during grok's ~130s "chairing" turn in dodi's meeting thread there was no signal in Slack that anything was happening. The operator could not distinguish "working on it" from "stuck," and asked for an acknowledgment plus periodic progress hints (the hints are Child B2, out of scope here).

Two facts make this structural rather than incidental:

1. `dispatchToAgent` (`dispatcher.ts:1338-1513`) — the leg **every** conference fan-out turn uses — calls no `onProcessingStart`/`onProcessingEnd` at all. Only the single-dispatch leg does (`:327`, `:451`). So the one existing "something is happening" affordance is not merely inadequate for meetings; it is absent from the meeting code path.
2. Provider latency inside one round-0 cohort spans 25x+ (2-5s for gpt/fable/gemini vs ~130s for grok, mixed lanes). Any fixed per-provider ack table would be wrong for most turns; a delay threshold self-tunes.

## 2. Goals

- A round-0 conference turn still unresolved after `MEETING_ACK_DELAY_MS` (~15s) posts exactly one acknowledgment into the meeting thread, attributed to that agent.
- Fast turns never ack — no new noise for the 2-5s population.
- The ack is invisible to every consumer of meeting thread history: full injection, delta injection, the `meetingLastSeenTs` high-water mark, the round-0 classifier's recency window, and the meeting scribe.
- The ack never re-triggers dispatch on itself.
- Every failure path an acked turn can take is named, with the ack's interaction stated — and so is every non-failure shape that can still leave an ack without a companion in the thread (the ack's own delivery failure, and KPR-308 outage diversion of the answer). §6.
- An operator can turn the whole thing off without a deploy.

## 3. Non-goals

- **Round-1 acks** — excluded by the KPR-389 §D5 collision (§5.2). No retraction path is designed.
- **B2 progress hints.** Separate child; this ticket deliberately builds the one-shot ack plumbing B2 would later extend.
- **Extending `onProcessingStart`/`onProcessingEnd` to fan-out**, refcounting it, or aggregating a multi-agent status string. Ruled on in §4; a refcounted aggregate status is a different feature and is recorded there as a possible B2 building block, not adopted here.
- **Slack-native reaction/emoji signaling** — set aside by the epic's own Non-goals on stated operator preference. This is why "add a ✅/💤 reaction to the ack when the turn ends" is not proposed for the orphan case (§6.4).
- **Deleting or editing a posted ack** (`chat.delete` / `chat.update`). Rejected in §6.4.
- **Acking non-conference turns** — plain multi-agent fan-out, single-dispatch, worker re-entry, voice, SMS. The gate is `conferenceMode`, which is reachable only from `conf-*` Slack channels (`dispatcher.ts:1175-1177`).
- **A configurable delay.** Only `ackEnabled` ships (§5.6).

## 4. Prior-art determination — why extending the existing status hook is not sufficient

The epic design requires this child to state why extending `SlackAdapter.onProcessingStart`/`onProcessingEnd` to the fan-out leg would not do the job, and offers two candidate reasons. Both verified; a third found; determination below.

**Verified fact 1 — the status surface has no agent dimension.** `setThreadStatus(channel, threadTs, status)` (`slack-gateway.ts:292-298`) writes one status string per `(channel, thread)`. `onProcessingStart` (`slack-adapter.ts:157-164`) keys on `meta.slackThreadTs ?? meta.slackTs` and ignores its `agentId` argument entirely (`_agentId`). Four concurrent responders therefore share one slot; "which agent is slow" — the actual question the operator was asking — is not expressible.

**Verified fact 2 — first finisher clears it, and this inverts the signal.** `onProcessingEnd` (`:166-173`) sets `""` unconditionally, with no refcount. In the trial's own cohort — three agents finishing in 2-5s, one in ~130s — the first fast finisher would clear the indicator at ~2s and the thread would then look *idle* for the remaining ~128s while grok worked. That is worse than the status quo for exactly the population this epic exists to serve. **This fact alone is disqualifying.**

**Verified fact 3 — surface mismatch, and it fails silently.** The call is `web.assistant.threads.setStatus` — Slack's Assistant/AI-app thread surface — and any error is swallowed by a `log.warn` (`:295-297`). A `conf-*` channel thread is an ordinary channel thread, not an assistant thread, so a non-render here is indistinguishable from success at the call site. ⚠ Flagged for implementation-time confirmation against a live dodi meeting thread; **the determination does not rest on it** — facts 1 and 2 are dispositive on their own.

**Determination.** Extending the hook to `dispatchToAgent` is **not sufficient**, and is **not adopted** even as a complement. Making it useful would require (a) a refcounted clear so the last finisher wins, and (b) a per-thread aggregate string the dispatcher composes from the in-flight agent set — a new feature with its own state, whose output is still ephemeral UI rather than durable thread content, and which still cannot name a per-agent state. That is a reasonable B2 building block and is recorded here as one. B1 builds the message-posting ack instead.

## 5. Design

### 5.1 Mechanism — arm, fire, cancel

One helper wraps the turn await in `dispatchToAgent`, replacing the bare call at `:1400`:

```ts
const runResult = this.convertTurnResult(
  await this.runTurnWithMeetingAck(agentId, effectiveItem, resolved, adapter),
);
```

```ts
/** KPR-417: arm the delayed ack, run the turn, cancel on ANY settle. The
 *  cancel lives in this helper's finally — adjacent to the await — so the ack
 *  can never outlive the turn it describes. Do NOT relocate it to a finally
 *  around the whole dispatchToAgent body: delivery, the mark write and the
 *  outage/deadline gates all run after the turn settles, and a timer still
 *  armed across them can post "On it" AFTER the answer. */
private async runTurnWithMeetingAck(
  agentId: string,
  item: WorkItem,
  resolved: ResolvedAgent,
  adapter: ChannelAdapter | undefined,
): Promise<TurnResult> {
  const ack = this.scheduleMeetingAck(item, resolved, agentId, adapter);
  try {
    return await this.agentManager.runWorkItemTurn(agentId, item);
  } finally {
    ack?.cancel();
  }
}
```

`scheduleMeetingAck` returns `undefined` unless **all** hold: `this.meetingAckEnabled`, `resolved.conferenceMode === true`, `resolved.conferenceRound === 0`, and `adapter` is defined. Otherwise it arms a `setTimeout(…, MEETING_ACK_DELAY_MS)`, calls `.unref()` on the handle (existing precedent: `index.ts:593`, `outage-replay-processor.ts:44` — a pending ack must never hold the process open at shutdown), and returns `{ cancel }` where `cancel()` sets a `cancelled` latch **and** `clearTimeout`s. The fired handler re-checks `cancelled` before posting.

Fire-and-forget throughout: the timer callback is `void this.deliverMeetingAck(...)`, whose body is a single `try/catch` around `adapter.deliver` — never awaited by the turn, never able to reject into it.

**Constants** (module scope in `dispatcher.ts`, beside `NON_RESPONSE_PATTERNS`):

| Constant | Value | Rationale |
|---|---|---|
| `MEETING_ACK_DELAY_MS` | `15_000` | ~3x the observed fast band (2-5s), far below the ~130s case, and far below the round-1 clamp (`REACTION_TIMEOUT_MS = 120_000`) and any turn deadline. |
| `MEETING_ACK_TEXT` | `"On it — picked this up."` | §5.3. |

### 5.2 Round gating

Ack iff `resolved.conferenceMode === true && resolved.conferenceRound === 0`.

Round-1 is excluded because the two contracts are in direct collision, not merely awkward. `dispatcher.ts:1412-1422`'s in-code comment states KPR-389 §D5 verbatim — *"a killed reaction is silent — never post filler into the meeting"* — and the guard at `:1423-1434` returns without delivering anything for an aborted/timed-out/errored-empty round-1 turn. A round-1 reaction that is clamp-killed at 120s would, under an unguarded ack, have posted "On it" at 15s: the ack **is** the filler D5 forbids, already in the channel before the kill. D5 goal 5 (`kpr-389-spec.md:39`) would be broken by construction. Honoring round-1 would require an explicit retraction (delete or edit the ack) — rejected in §6.4 — so round-1 is simply out of scope.

Structural consequences, all following from the gate rather than needing their own guards:

- **Outage replays never ack — because of the leg, not because of the meta.** A replayed round-0 conference turn **keeps** `meta.conferenceMode`/`meta.conferenceRound` (KPR-389 §E4, verified: conference meta rides `item.meta`, never `resolved` — and that retained `conferenceRound` is exactly what `:370` and KPR-416's `meetingExclusionTs` read). It cannot ack because it takes `dispatch()`'s **single-dispatch leg** with a bare `ResolvedAgent` whose `conferenceMode` is falsy, and because that leg has no `runTurnWithMeetingAck` wrapper on it at all — the ack machinery lives only in `dispatchToAgent`.
- **KPR-402 continuation legs never ack — for a second, independent reason.** Same leg, *and* the leg's meta has been conference-stripped at `:846-853` (KPR-413), so it is not a conference turn on either surface. Do not collapse this with the replay case: replays retain conference meta and legs do not.
- **`worker:` boss re-entry never acks** — ordinary non-conference turns (KPR-390 canon C26).
- Therefore **≤ 1 ack per (agent, human trigger)**, with no chain and no duplicate across legs.

### 5.3 Ack text and delivery path

**Delivery** reuses the notice shape the file already has (`deliverOutageNotice`, `:1075-1092`), not `deliverAgentResult`:

```ts
private async deliverMeetingAck(item: WorkItem, agentId: string, adapter: ChannelAdapter): Promise<void> {
  const ack: WorkResult = { text: MEETING_ACK_TEXT, agentId, workItem: item, costUsd: 0, durationMs: 0 };
  try {
    await adapter.deliver(ack);
  } catch (err) {
    log.warn("Meeting ack delivery failed — dropped", { agentId, error: String(err) });
  }
}
```

Four deliberate properties:

- **`error` unset**, so `SlackAdapter.deliver` renders it through `formatResponse`, not `formatError` (`slack-adapter.ts:147`) — same rationale as `deliverOutageNotice`'s own comment.
- **`agentId` set**, so `deliver` picks up `agentConfig` and posts with the agent's `username`/`icon` identity and the `${icon} *${Name}*: ` text prefix (`:148-154` → `slack-gateway.ts:366-410`). Per-agent attribution costs nothing new.
- **Not `deliverAgentResult`** — that begins with `tryOutageDiversion` (`:521-563`, called at `:571`), and an ack diverted to a WS floor broadcast is meaningless. ⚠ The *symmetric* case — the ack posts to the thread and the turn's real **answer** is then diverted away from it — is a named residual, §6.6.
- **Never enqueued to the retry queue on failure.** A retried ack lands minutes later, potentially after the answer. A dropped ack is strictly better than a late one.

**Text.** `MEETING_ACK_TEXT = "On it — picked this up."` — verified to round-trip byte-identically through `markdownToMrkdwn` (`response-formatter.ts:6-22`: no header, bold, link, strikethrough or rule construct present), which the recognition pattern depends on.

⚠ **Wording is load-bearing, not cosmetic — and it is deliberately a receipt, not a progress report.** The ack must be true at every instant it can fire, including one the epic design does not name: the per-thread lock spin-waits **before** the breaker permit is acquired (`agent-manager.ts:1453-1458` precedes `:1175`), so an acked turn may be *queued behind a sibling turn on the same `agentId:threadId`* rather than generating anything. Any wording that asserts work is happening **right now** — "looking into this", "working on it", "generating" — is therefore false in that window. "Picked this up" claims only assignment, which is true from the moment the round-0 fan-out selected this agent and stays true through the lock wait, the breaker acquire and the model call alike. It is equally a statement of *state*, not a promise of a reply, which is what makes §6.4's "no retraction" ruling tolerable: silence after "On it — picked this up." is a turn that took the item and had nothing to add; silence after "On it — I'll get back to you shortly" would be a broken promise.

A bare `"On it."` was considered and is honest on the same grounds, but rejected on **collision surface**: a whole agent reply of exactly "On it." is plausible in a conference thread (a peer claiming a sub-task), while the two-clause sentence is not — see §5.4's residual, whose bound depends on the phrase being one no agent would author verbatim as its entire contribution.

### 5.4 Recognition mechanism — a stable content pattern

Beside `NON_RESPONSE_PATTERNS`:

```ts
/** KPR-417: the exact sentence B1 posts (§5.3). MEETING_ACK_PATTERNS below
 *  recognizes it back off the thread transcript — the two MUST change in
 *  lockstep, exactly as NON_RESPONSE_PATTERNS pins "No response needed."
 *  Exported (unlike NON_RESPONSE_PATTERNS, which is module-private and which
 *  the suite deliberately mirrors by hand at dispatcher-conference.test.ts:556
 *  / dispatcher.test.ts:283) because this constant sits on BOTH sides of a
 *  two-sided contract: T1 asserts these bytes were posted and T5 seeds a
 *  fixture message that these bytes must strip. A hand-mirrored copy would let
 *  T5 keep passing while the real posted text drifted away from it — the exact
 *  drift the strip exists to prevent. isMeetingAck is exported alongside it so
 *  the anchored-regex bound (a reply that merely BEGINS with the sentence is
 *  not an ack) is unit-assertable without routing through a full dispatch. */
export const MEETING_ACK_TEXT = "On it — picked this up.";

/** SlackAdapter.deliver prefixes agent posts with `${icon} *${Name}*: `
 *  (icon optional when the agent has none, absent entirely when the agent was
 *  deleted mid-turn). Mirrors the author-extraction regex at
 *  slack-adapter.ts:222, widened to make the icon optional. */
const AGENT_PREFIX_RE = /^(?:\S+\s+)?\*[^*]+\*:\s*/;
const MEETING_ACK_PATTERNS = [/^on it\s*—\s*picked this up\.?$/i];

export function isMeetingAck(m: ThreadMessage): boolean {
  if (!m.isBot) return false;
  return MEETING_ACK_PATTERNS.some((p) => p.test(m.text.replace(AGENT_PREFIX_RE, "").trim()));
}
```

Anchored `^…$` on the whole body, so a real reply that merely *begins* with the sentence is not stripped. `isBot` gates out any human typing it.

**Why not the other two candidates:**

- **A `meta` flag threaded through history-fetch.** `ThreadMessage` (`slack-adapter.ts:19-29`) is assembled from `conversations.replies`; there is no hive-side channel on it. Carrying a flag would mean Slack message metadata (`chat.postMessage` `metadata` + `include_all_metadata` on the replies read), a new `ThreadMessage` field, a story for `postSplit`/`postAsFile`, and a new scope/API surface — for a fact we can already read off bytes we authored. Rejected on cost, not on principle; if a future consumer needs richer per-message provenance, this is the option to revisit.
- **A ts-keyed ack registry (parallel to `outboundTsCache`).** Rejected on **restart fragility**, which is not hypothetical: meeting threads outlive engine restarts (deploys, `hive update`), `meeting_summaries` alone has a 7d TTL, and `OutboundTsCache`'s own TTL is 120s (`outbound-ts-cache.ts:16`). After a restart the registry is empty while every ack is still sitting in Slack, so the classifier-window regression the epic design names as "a functional regression, not just transcript bloat" comes back silently and with no signal. Making it durable means a Mongo collection and a new write on a hot path — strictly more machinery than a regex, for strictly less coverage.

⚠ **Collision residual, accepted:** an agent whose entire reply is exactly the ack sentence has that message stripped from meeting history. Impact is bounded to one near-contentless message; the identical hazard already exists and is accepted repo-wide for `NON_RESPONSE_PATTERNS`; and the meeting preamble steers agents toward `"No response needed."`, not toward this sentence. The bound depends on the phrase being one no agent would plausibly author verbatim as its *entire* contribution — which is why §5.3 keeps the two-clause form rather than a bare `"On it."`. Named, not fixed.

### 5.5 One strip point covers all five consumers

The five consumers the epic enumerates all read the same array, produced at exactly two sites. Both are replaced by:

```ts
/** KPR-417: the ONLY meeting history fetch. Acks are operational chrome, not
 *  meeting content — stripping here makes all five consumers ack-blind with no
 *  per-consumer edits: the full arm (formatThreadContext), the delta arm, the
 *  meetingLastSeenTs high-water calc (all three via buildConferenceContext),
 *  the round-0 classifier's history.slice(-5) recency window, and the scribe's
 *  noteActivity (novelty count + summary prompt). DELIBERATELY not gated on
 *  meetingAckEnabled: flipping the lever off must not un-hide acks that are
 *  already in the thread. Any new meeting-history read MUST come through here.
 */
private async fetchMeetingHistory(item: WorkItem, threadId: string): Promise<ThreadMessage[]> {
  if (!this.slackAdapter) return [];
  const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId;
  const history = await this.slackAdapter.fetchThreadHistory(item.source.id, threadTs);
  return history.filter((m) => !isMeetingAck(m));
}
```

Call sites: `resolveConferenceAgents` (`:1574-1576`) and `triggerConferenceReactions` (`:1930-1932`) — both already compute the identical `channelId`/`threadTs` pair, so the wrapper is an exact factoring, not a behavior change for non-ack messages.

**Why the strip is in the dispatcher, not in `fetchThreadHistory`.** "Is this an ack" is a meeting-domain fact; `SlackAdapter.fetchThreadHistory` is channel-domain and should keep returning what Slack has. Requirement: add a one-line pointer comment at `slack-adapter.ts:202` naming `Dispatcher.fetchMeetingHistory` as the meeting-side filter, so a future reader of the adapter is not surprised.

**Already-structural, no new guard needed:** the ack cannot re-trigger dispatch on itself. It posts through `adapter.deliver` → `gateway.postMessage` → `postSingle`, which registers the outbound ts (`slack-gateway.ts:410`, `:426`), and the inbound handler skips on it (`:117`). ⚠ This is a load-bearing dependency, not a nicety: the ack text embeds the agent's own name in its `*Name*:` prefix, and `resolveConferenceAgents` builds the roster with `findAllByName(item.text)` (`:1537`) — so an ack that leaked back through the inbound path would both add its own author to the roster and mint a fresh conference turn. Hence the §9 requirement that the ack be posted only through the adapter's `deliver` path, never a direct `web.chat.postMessage`.

**Also unaffected, verified:** `meetingRosters` is built from the human trigger's text only, never from history — so the roster is not a sixth consumer.

**Scope of "ack-blind," stated precisely:** the five consumers are the engine's own history-processing paths. An agent that reads the meeting channel through its **own `slack` MCP tool surface** bypasses this function entirely and sees the acks as the ordinary Slack messages they are. Deliberately out of scope — see §8.

**Timing note (from the epic design, re-verified):** `buildConferenceContext` runs inside `resolveConferenceAgents`, *before* any round-0 turn of the same trigger is dispatched — so an ack can never pollute a round-0 turn of its own trigger even without the filter. The filter is what covers everything after that: round-1 reaction context, the scribe, and every later trigger's round-0.

### 5.6 Config lever — `meetingWorkers.ackEnabled`

Three-file change, mirroring `scribeEnabled` exactly (KPR-409 §D6 precedent):

1. `src/workers/worker-pool-config.ts` — `ackEnabled: boolean` on `MeetingWorkersConfig`, `ackEnabled: true` in `DEFAULT_MEETING_WORKERS_CONFIG`, with the ⚠ doc comment recording independence from `enabled`.
2. `src/config.ts` `resolveMeetingWorkersConfig` — `ackEnabled: typeof r.ackEnabled === "boolean" ? r.ackEnabled : d.ackEnabled` (same liberal-loader idiom, no clamp interaction).
3. `src/index.ts` — `dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled)` immediately after `dispatcher.setMeetingScribe(meetingScribe)` (`:459`), i.e. **above** the spawn-capable boundary (`:466`), plus the flag on the adjacent `log.info`.

Dispatcher side: `private meetingAckEnabled = false;` — **fail-closed default**, so an unwired dispatcher (a test harness, or a mis-ordered boot) silently posts no acks rather than misbehaving.

⚠ **Independent of `enabled`.** `scribeEnabled` is nested under `enabled` because the scribe genuinely consumes pool machinery (`runRoleTurn`, `hasCapacity`), so the worker master switch must kill it. The ack consumes none. Gating it under `enabled` would mean an operator disabling fetch-workers silently loses an unrelated UX feature. It lives in this section for config locality only.

**Delay stays a constant.** Only `ackEnabled` ships, per the epic design. Adding `ackDelayMs` later is one liberal-loader line plus widening the setter to an options object; recorded so a future trial-driven tuning request is not a redesign.

**Boot order (KPR-414).** The flag is read per turn inside `dispatchToAgent`, so it is a spawn-read fact and its wiring belongs above the boundary. `src/boot-order.test.ts` must gain `dispatcher.setMeetingAckEnabled(` as an anchor in **all three** of its lists — (a) presence, (b) the `Math.max` wiring bound, and (c) the superset sweep's `wiringStart` — per that test's own "bound on the **latest** anchor" rule. Note this is belt-and-braces rather than load-bearing: conference dispatch is unreachable until `dispatcher.setSlackAdapter(slackAdapter)` at `:625`, well below the boundary, and the fail-closed default means a mis-wire degrades to "no acks" rather than to a fault.

## 6. Failure-path interactions — four turn-failure cases, plus two non-turn shapes

The uniform rule: **an ack is a true statement about dispatch state at the time it was posted, and is never retracted.** Applied to each path. §6.1-6.4 are the four ways an *acked turn* can end; §6.5-6.6 are the two shapes that are not turn failures at all but still leave an ack without a companion in the thread.

### 6.1 The turn errors (or throws)

- **Errored with text** (`runResult.error` set, non-empty text): falls into the `else` at `:1472`, `deliverAgentResult` posts, `SlackAdapter.deliver` renders it via `formatError`. Ack → error message. Visible resolution, no double-post of the *same* signal.
- **Thrown** (`runWorkItemTurn` rejects, `:1511-1512`): `handleTurnFailure` posts `Something went wrong: …` (`:616` → `:625`). Same shape. Reachable on this epic's hot path — a grok `TurnAssemblyError` from an unreadable `~/.grok/auth.json` throws here.
- **Errored with empty text**: delivers the `_No response._` placeholder. Ugly but pre-existing, and still a visible resolution.

In all three the cancel in `runTurnWithMeetingAck`'s `finally` runs before any of this, so a turn that errors *fast* never acks at all.

### 6.2 Circuit-open fast-fail (KPR-307)

Two sub-shapes:

- **Pre-turn `ProviderCircuitOpenError`.** Normally returns in well under 15s (the breaker permit is acquired at the top of the spawn), so no ack fires — the common case is structurally clean. **But it is not guaranteed:** `withSpawnTicket`'s per-thread lock spin-waits (`agent-manager.ts:1453-1458`) *before* the breaker acquire (`:1175`), so a turn queued behind a sibling on the same `agentId:threadId` can ack at 15s and only then fast-fail. Outcome: ack, then the honest outage notice — a coherent sequence.
- **Post-turn hard fault while the breaker is open** (`maybeHandlePostTurnOutage`, `:1404`): the turn ran for real, so the ack almost certainly fired. The turn is queued for replay (4h TTL) and the notice is issued.

⚠ **The silence case, named precisely:** the outage notice is deduped **once per (provider, adapterKey, threadKey) per episode** (`:1003`, `firstForThread`). In a 4-agent meeting on one provider, only the first agent's turn produces a notice; agents 2-4 queue silently. If those agents acked, their acks are followed by silence until the replay eventually delivers — possibly hours later, and via the single-dispatch leg, which fires no reaction pass (KPR-416 §3's named pre-existing scope bound).

**Considered and rejected: gate the ack at fire time on breaker state.** A `circuitBreakers.stateFor(providerFor(agentId))?.state === "open"` check in the timer handler is cheap and available (precedent at `:1060`). Rejected because (i) it covers only the lock-contended sub-shape — during an open episode ordinary fast-fails already return long before 15s, so the population it removes is tiny; (ii) it does nothing for the post-turn shape, where the breaker is closed at 15s and trips later; and (iii) it makes the ack rule conditional on cross-module state for partial coverage. Revisit trigger: trial logs showing acks correlated with outage episodes at a rate the operator notices.

### 6.3 Deadline abort (KPR-402)

- **With progress** (`classifyTurnResult` kind `turn-deadline`): conference items are `policy === "notify"` (`outage-notices.ts:18-26` — a Slack conference item's id is the Slack ts, matching no prefix class), so the first abort posts `deadlineNoticeFor(...)` (`:789`) and a continuation leg is dispatched. The leg carries no conference meta (`:846-853`) and re-enters the single-dispatch leg, so **it does not ack again**. Sequence: ack at 15s → "taking longer than expected, continuing" at the deadline → the leg's answer, or the terminal notice at the cap. This is a coherent progression, not a redundant double-post.
- **Zero progress**: notice only (`:734`), no leg. Ack → notice. Visible resolution.
- **Cap exhausted**: terminal notice naming the manual "continue" hatch (`:797`). Visible resolution.

### 6.4 The turn succeeds but suppresses — the fourth case

The round-0 responder returns `"No response needed."`, `isNonResponse` is true (`:1468-1470`), nothing is delivered, and no reaction pass fires. Under delay-then-ack this requires the suppressor to *also* be slow, which narrows it to the grok-shaped population — but the epic design is right that it is not exotic: the meeting preamble actively instructs the decline (`:1857`), and three of four round-0 responders suppressed in the trial.

**Ruling: accept the orphaned ack. No retraction, no resolution message, no reaction marker.** Four grounds:

1. **The wording already carries it.** "On it — picked this up." followed by nothing reads as *took the item, had nothing to add* — which is exactly what happened. Nothing was promised, and no active work was claimed (§5.3).
2. **KPR-416 materially changes this case.** Child A writes reaction-exclusion at delivery time, on the non-suppressed branch only, so a **suppressed** round-0 turn writes nothing and the agent stays round-1-eligible for that trigger (KPR-416 §4, §11). The acked-then-suppressed agent may therefore still post a real round-1 reaction to a slower peer minutes later. The epic design's framing of this case — written before A's write site was chosen — assumed the ack was followed by permanent silence; it **need not be**. ⚠ Deliberately not stronger than that: the acked-and-suppressed population is by construction made of *slow* suppressors, and for one of them to earn a round-1 reaction an even **slower** peer must deliver real content on the same trigger. The escape hatch is real but narrow, and this ground is the weakest of the four — the ruling stands on grounds 1, 3 and 4 regardless of how often ground 2 fires.
3. **Every mechanized alternative is worse.** `chat.delete` needs new gateway surface, races the very consumers §5.5 exists to protect (a round-1 turn dispatched in between may already have injected the ack), and mutates thread history under readers. `chat.update` to a terminal line is the same surface cost plus a second visible state change. A ✅/💤 reaction is Slack-native reaction signaling, which the epic's Non-goals set aside on stated operator preference. A "…had nothing to add" follow-up message doubles the noise this feature is already spending, for the least informative outcome.
4. **The population is small and bounded** — only round-0 selectees still unresolved at 15s that then decline.

**Revisit trigger** (for the epic, not this child): if a post-deploy trial shows the operator reading orphaned acks as stuck agents, the cheapest next step is an ack **edit** (`chat.update` on the ts `postMessage` already returns, `slack-gateway.ts:371`) — not a delete, not a new message. Recorded so a follow-on does not restart cold.

### 6.5 Not a turn failure: the ack's own delivery fails

Swallowed with a warn (`deliverMeetingAck`'s catch), never enqueued for retry, never observable by the turn. The turn's own outcome is unaffected in every case.

### 6.6 Not a turn failure: the answer is diverted away from the thread (KPR-308 outage diversion)

⚠ **Residual, accepted and named.** `deliverAgentResult` opens with `tryOutageDiversion` (`:521-563`), which redirects a **successful** turn's result to a WS floor broadcast instead of the source adapter when three conditions hold together: outage state is active (`:534`), the agent is `floorCritical` (`:537`), and at least one device is connected (`:538-546`). Slack-sourced items are explicitly in scope (`:536`). So a round-0 conference turn can ack into the meeting thread at 15s, succeed at 90s, and have its **answer** delivered to the app floor — leaving the ack sitting in the meeting thread with no visible resolution *there*, even though the turn resolved perfectly and the operator saw the answer somewhere else.

This is the fifth orphan shape and it is materially different from §6.2/§6.4: nothing failed, and the "missing" content exists — it was routed elsewhere by a deliberate, pre-existing engine behavior. It is accepted unchanged, on the same grounds and by the same precedent as KPR-416's own micro-residual at its write site:

- The ack remains true — the agent did pick the item up, and did answer it.
- Every mechanism that would close it is the retraction machinery §6.4 already rejected (delete/edit/follow-up), now made *worse* by having to reason about a second delivery surface.
- The population is the intersection of three narrow conditions (open outage episode × `floorCritical` agent × connected device) with the already-narrow ">15s round-0 responder" set.
- Diversion is itself an outage-time behavior, so a thread in this state is already showing the §6.2 outage notice for the episode's first agent.

**Not a required test case.** Reproducing it needs the outage-state provider, a `floorCritical` registry entry and a broadcast-capable WS adapter stubbed together purely to assert an *absence* — cost far above the residual's weight. Named here so a future reader does not file it as an ack bug. Revisit trigger is the same as §6.4's: operator-observed confusion in a live trial.

## 7. Integration points

| Surface | Interaction |
|---|---|
| `dispatcher.ts` `dispatchToAgent` (`:1400`) | turn await wrapped by `runTurnWithMeetingAck`; nothing else in the body moves |
| `dispatcher.ts` module scope (`:54-59` neighborhood) | `MEETING_ACK_TEXT`, `MEETING_ACK_DELAY_MS`, `MEETING_ACK_PATTERNS`, `isMeetingAck` |
| `dispatcher.ts` `resolveConferenceAgents` (`:1574-1576`) | fetch replaced by `fetchMeetingHistory` |
| `dispatcher.ts` `triggerConferenceReactions` (`:1930-1932`) | fetch replaced by `fetchMeetingHistory` |
| `dispatcher.ts` `buildConferenceContext` (`:1713-1793`) | **unchanged** — receives ack-free history |
| `dispatcher.ts` scribe seams (`:1601`, `:1954`) | **unchanged** — receive ack-free history |
| `slack-adapter.ts` `fetchThreadHistory` (`:202`) | pointer comment only; no behavior change |
| `slack-adapter.ts` `deliver` (`:135-155`) | **unchanged** — reused as-is for identity + threading |
| `slack-gateway.ts` `postSingle` / `outboundTsCache` | **unchanged** — echo suppression already covers the ack |
| `worker-pool-config.ts` / `config.ts` / `index.ts` | `ackEnabled` (§5.6) |
| `boot-order.test.ts` | new wiring anchor in all three lists (§5.6) |
| KPR-389 §D5 round-1 kill guard (`:1423-1434`) | **unchanged** — preserved by the round-0 gate, never worked around |
| KPR-402 / KPR-413 continuation legs | **unchanged** — structurally ack-free (§5.2) |
| KPR-307 outage machinery | **unchanged** — notices and the ack are independent (§6.2) |
| KPR-308 `tryOutageDiversion` (`:521-563`) | **unchanged** — the ack never routes through it (§5.3); a diverted *answer* is a named residual (§6.6) |
| KPR-416 `markReactionExclusion` + `meetingExclusionTs` | **unchanged** — different statements in the same function; see §11 |
| `CLAUDE.md` Meeting-mode bullet | must name `ackEnabled` and its independence from `enabled`, alongside `scribeEnabled` |

**Files touched:** `src/channels/dispatcher.ts`, `src/channels/slack-adapter.ts` (comment only), `src/workers/worker-pool-config.ts`, `src/config.ts`, `src/index.ts`, plus tests (`dispatcher-conference.test.ts`, `config.test.ts`, `boot-order.test.ts`) and `CLAUDE.md`. No schema, no new collection, no new Slack scope.

## 8. Edge cases and assumptions

- **Cancel-vs-in-flight-post race.** `cancel()` cannot unpost. If the turn settles inside the window between the timer firing and `adapter.deliver` resolving (~one Slack round trip), the ack posts anyway. ⚠ Accepted: the answer's own delivery begins strictly after the turn settles, i.e. after the ack post already started, so Slack ordering places the ack first in essentially every realization. Worst case is an ack immediately followed by its answer — mildly redundant, never contradictory.
- **Ack ordering vs. the answer, generally.** The ack fires at 15s; the answer at turn end (>15s by construction, since a faster turn cancels). Ordering is therefore correct by construction, not by luck.
- **Agent deleted mid-turn.** `deliver` finds no `agentConfig`, posts without the `*Name*:` prefix and without identity. `AGENT_PREFIX_RE` is optional, so recognition still holds.
- **Long threads.** `truncateHistory` (`:1699-1701`) caps at first-5 + last-100 *after* the strip, so acks do not consume transcript budget.
- **`ackEnabled: false` mid-meeting.** New acks stop; existing acks stay stripped (§5.5). Verified as a required test (§9 T6).
- **Non-Slack conference surfaces.** None exist — `conferenceMode` is reachable only from `kind === "slack"` + `conf-*` label (`:1175-1177`). Stated so a future surface knows the ack path assumes Slack delivery semantics.
- **Test-harness safety.** `.unref()` on the timer plus the fail-closed `meetingAckEnabled = false` default means no existing test can acquire a stray 15s timer.
- **Agents reading the channel with their own Slack tools still see acks — deliberately.** The five consumers of §5.5 are all *engine-internal history-processing paths*; the strip lives in the dispatcher, not in Slack. An agent holding the `slack` MCP server that calls `conversations.replies` on a `conf-*` thread reads real Slack messages and will see the acks verbatim, and may quote them. This is out of scope by construction — closing it would mean filtering at the vendor-API boundary for every agent, which is neither desirable (the acks *are* real messages the operator can see) nor achievable from the dispatcher. Named so a future "why did the agent quote the ack" report is recognized as expected behavior, not a strip-point leak.
- ⚠ **Assumption:** an ack is engine chrome and must never be meeting content — the same class of judgment KPR-416 §4 makes about engine-authored notices. If a future reviewer disagrees, the affected surfaces are the five consumers of §5.5.
- ⚠ **Assumption (delegated, non-blocking):** delay-then-ack substitutes for the operator's literal immediate "got it" — see Key Points.
- ⚠ **Residual (accepted):** content-pattern collision, §5.4.
- ⚠ **Residual (accepted):** orphaned ack in the outage-silence and suppression cases, §6.2 / §6.4.
- ⚠ **Residual (accepted):** orphaned ack when a *successful* turn's answer is diverted to the WS floor by KPR-308 outage diversion, §6.6. The fifth orphan shape; not a failure, and not a required test case.
- ⚠ **Unverified-at-spec-time (non-blocking):** whether `assistant.threads.setStatus` renders at all on a `conf-*` channel thread, §4 fact 3. The prior-art determination does not depend on it.

## 9. Testing contract

Home: `src/channels/dispatcher-conference.test.ts` (existing harness already provides everything needed — `adapter.deliver` is a `vi.fn()` recording every post, `mockSlackAdapter.fetchThreadHistory` is seedable, `runWorkItemTurn` is a settle-controllable mock). Config-resolver cases go in `src/config.test.ts`; the boot anchor in `src/boot-order.test.ts`.

**Two harness preconditions, stated once so they are not rediscovered case by case.**

**(1) The lever must be armed.** `meetingAckEnabled` defaults to **`false`** on the dispatcher (§5.6, fail-closed), and the conference harness does not wire `index.ts`. So **every** case that expects an ack to actually post — T1, T8, T9(b)(c), T10, T11 — must call `dispatcher.setMeetingAckEnabled(true)` in setup. Put it in the ack describe-block's `beforeEach`; the negative-lever cases (T6, T7a) override it to `false` in-test. (T5 seeds an ack-*shaped* fixture message rather than posting one, so it is lever-independent by design — which is precisely what T6 pins.) A missing call makes every positive case pass vacuously as "no ack posted" — exactly the failure mode T1's negative-verify exists to catch.

**(2) Fake timers and the suite's existing drain idiom must be reconciled — use the async advancement API, exclusively.** The ack needs a 15s fake-clock jump, but several required cases *also* need the suite's fire-and-forget reaction/continuation drain, and that drain is real-timer-based: `settleReactions = () => new Promise((r) => setTimeout(r, 0))` (`dispatcher-conference.test.ts:623`, with the explicit note at `:613-622` that `vi.waitFor` alone is insufficient), plus the bare `await new Promise((r) => setTimeout(r, 0))` pair at `:457-458`. Under `vi.useFakeTimers()` those `setTimeout(…, 0)` calls are themselves captured by the fake clock and **never resolve** without advancement — so a naive `vi.useFakeTimers()` + `settleReactions()` combination deadlocks. Affected at minimum: T5(2), T9(c), T10's continuation-leg arm, and T11's round-1 companion.

**Prescription:**

- Install fake timers **scoped to the ack describe-block only** — `vi.useFakeTimers()` in its `beforeEach`, `vi.useRealTimers()` in its `afterEach` — so the rest of `dispatcher-conference.test.ts` keeps its real-timer `settleReactions` untouched and no existing test changes.
- Inside that block use **only** the async advancement API, never the synchronous `vi.advanceTimersByTime`: `await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS)` to fire the ack, and `await vi.advanceTimersByTimeAsync(0)` **everywhere the suite would otherwise `await settleReactions()`**. `advanceTimersByTimeAsync` drains the microtask queue between ticks, which is precisely the macrotask boundary `settleReactions` provides per its own comment at `:613-622` — so the drain semantics the existing tests rely on are preserved, not approximated.
- Define one local alias in the block so the intent stays legible against the existing idiom: `const settleAcked = () => vi.advanceTimersByTimeAsync(0);`, commented with a pointer to `:623` saying it is the fake-timer equivalent of `settleReactions`, not a second mechanism.
- Sequence for a timing case is therefore: arm (dispatch with a manually-settled `runWorkItemTurn` promise) → `await vi.advanceTimersByTimeAsync(15_000)` → assert the ack → settle the turn → `await settleAcked()` → assert the downstream (answer, notice, leg, or reaction).

If a specific case still proves stubborn under this recipe, the sanctioned fallback is `vi.useFakeTimers({ shouldAdvanceTime: true })` for that case alone — do **not** fall back to real timers with a literal 15s wait, and do not lower `MEETING_ACK_DELAY_MS` for tests.

### Negative-verify obligation — scoped to T1 and T5 only

Per `feedback_negative_verify_regression_tests` and the scoping precedent of `kpr-387-spec.md:159` / `kpr-416-spec.md` §10: revert the source hunks and confirm **T1 and T5** fail on pre-fix code. Every other case below is coverage that passes on both old and new code — most of them **vacuously** pre-fix (no ack exists, so "no ack was posted" is trivially true), and each is labeled as such below so a reviewer does not mistake a vacuous pass for a guarantee.

**T5 must additionally guard against a vacuous pass** (the `kpr-387-spec.md:155` hazard): its fixture history must contain at least one **non-ack** message, and the test must assert that message *is* present in each consumer's payload, so "everything got filtered" cannot pass as "acks got filtered."

- **T1 — the primary mechanism (NEGATIVE-VERIFY).** A round-0 conference turn whose `runWorkItemTurn` has not settled at t=15s ⇒ exactly one `adapter.deliver` call carrying `MEETING_ACK_TEXT`, with `agentId` set to that agent and `error` unset. Then settle the turn ⇒ the answer delivers, and no second ack. **Fails pre-fix** (nothing is posted).
- **T5 — the non-interaction guarantee, all five consumers (NEGATIVE-VERIFY).** Seed `fetchThreadHistory` with `[human, ack-shaped bot message, peer reply]`. Assert, in one test or five siblings sharing a fixture:
  1. **full arm** — the injected `threadContext` contains the peer reply and **not** the ack text;
  2. **delta arm** — with a seeded resumable session + mark below the ack's ts, the delta contains the peer reply and not the ack;
  3. **mark** — `setMeetingMark` is called with a ts that is **not** the ack's ts (i.e. the high-water calc never saw it);
  4. **classifier recency window** — the `recentMessages` string passed to `classifyMeetingMessage` contains the peer reply and not the ack;
  5. **scribe** — the `history` handed to `noteActivity` contains no ack-shaped entry.
  **Fails pre-fix** for every sub-assertion (nothing strips it).
- **T2 — fast turns never ack.** A round-0 conference turn settling at t=2s (fake timers advanced past 15s afterward) ⇒ no ack in `adapter.deliver`'s calls. *Coverage; vacuous pre-fix.*
- **T3 — round-0 gating / KPR-389 §D5.** A round-1 reaction turn still unsettled at t=15s ⇒ **no** ack. Companion: that turn then returns `aborted: true` ⇒ the D5 guard's existing silence holds and the channel saw **zero** posts for it. Comment the test with the D5 goal-5 citation so a future "just ack round-1 too" edit fails loudly. *Coverage; vacuous pre-fix — but the load-bearing guard for the one contract this feature could break.*
- **T4 — non-conference turns never ack.** Two cases doing **different** amounts of work; keep both, but do not conflate their purposes.
  - **(a) plain multi-agent fan-out** — goes through `dispatchToAgent` (so the ack wrapper *is* on the code path) with a bare `resolved` object carrying no `conferenceMode` ⇒ no ack even when unsettled past 15s. **This is the case that actually exercises the gate**, and it is the one that would fail if someone widened the gate to read `item.meta`.
  - **(b) an outage-replay item carrying `meta.conferenceRound: 0`** ⇒ no ack. ⚠ Structurally **vacuous by construction**: the replay takes the single-dispatch leg, which has no `runTurnWithMeetingAck` wrapper on it at all, so there is no gate there to evaluate. It pins the *leg-level* absence (§5.2) — a regression where the ack wrapper is later added to the single-dispatch leg — not the meta-vs-`resolved` gate. Comment it as such so a future reader does not read it as gate coverage.
  *Coverage; vacuous pre-fix.*
- **T6 — the strip is not gated on the lever.** With `setMeetingAckEnabled(false)`, an ack-shaped message already in the seeded history is **still** stripped from all five consumers, and no new ack is posted. *Coverage; the "still stripped" half is genuinely new behavior and fails pre-fix for the same reason T5 does — it may be folded into T5 as a parameterized case rather than duplicated.*
- **T7 — config lever.** (a) dispatcher-level: `ackEnabled` false ⇒ no ack on an unsettled round-0 turn; (b) `resolveMeetingWorkersConfig` unit cases in `config.test.ts`: absent section ⇒ `true`; `{ ackEnabled: false }` ⇒ `false`; `{ ackEnabled: "no" }` (non-boolean) ⇒ default `true`; and — pinning §5.6's independence ruling — `{ enabled: false }` alone ⇒ `ackEnabled` still `true`. *Coverage.*
- **T8 — failure path 1 (§6.1).** Unsettled past 15s, then (a) the turn resolves with `error` + text, and (b) `runWorkItemTurn` rejects. Both: exactly two `deliver` calls, the ack first and the error second, and **no** retraction/edit/delete of the ack. *Coverage.*
- **T9 — failure path 2 (§6.2).** (a) An immediate `ProviderCircuitOpenError` rejection ⇒ no ack (fast-fail beats the threshold). (b) A rejection delayed past 15s ⇒ ack, then exactly one honest outage notice; assert the ack is not repeated. (c) Two agents in the same thread and episode ⇒ two acks, **one** notice — the orphaned-ack residual of §6.2, commented as accepted behavior with a pointer to that section. *Coverage.*
- **T10 — failure path 3 (§6.3).** A round-0 conference turn unsettled past 15s that then returns `timedOut && aborted` with progress ⇒ ack, then the first-abort notice, then a continuation leg dispatched; assert the leg carries no conference meta (reusing the KPR-413 pin) and that **the leg itself posts no ack**. Companion: the zero-progress arm ⇒ ack + notice only, no leg, no second ack. *Coverage.*
- **T11 — failure path 4 (§6.4).** A round-0 turn unsettled past 15s that then returns `"No response needed."` ⇒ the ack is the **only** post from that agent for that turn; assert no retraction, no follow-up, no `_No response._`. Companion (depends on KPR-416 having landed, §11): the same agent is still selected and dispatched as a round-1 reactor when a slower peer delivers, and its reaction posts — pinning that the orphan **can** resolve. ⚠ Its purpose is precise: it is a tripwire for a **revert of Child A's relocation of the exclusion write from selection time to delivery time** — not for a change to A's write *predicate*. Under either predicate A considered, a suppressed turn writes nothing (it sits in the `isNonResponse` branch with no real content either way), so this test is predicate-insensitive; it fails only if the write moves back to selection time, where every selected round-0 agent is excluded regardless of outcome and the orphan becomes permanent by construction. Comment it with that framing plus a pointer to KPR-416 §11. *Coverage.*
- **T12 — containment of the ack's own failure (§6.5).** `adapter.deliver` rejects on the ack call ⇒ warn logged, **no** `retryQueue.enqueue`, and the turn's own delivery still happens normally. *Coverage.*
- **T13 — structural pins (drift-catching).** (a) `dispatcher.ts` contains exactly **one** `fetchThreadHistory(` call site — a third meeting-history read added later without going through `fetchMeetingHistory` fails here. (b) The `ack?.cancel()` statement appears inside `runTurnWithMeetingAck`, not in a `finally` around the whole `dispatchToAgent` body. Same posture and same escape hatch as KPR-416's T5: if a source-scan assertion is judged too brittle for this suite, the accepted substitute is a structural comment at each site naming the requirement and pointing at §5.1/§5.5, and T13 is dropped — do **not** substitute a timing-based test. *Coverage.*
- **T14 — boot order.** `boot-order.test.ts` gains `dispatcher.setMeetingAckEnabled(` in all three anchor lists; the suite must stay green with the new anchor participating in the `Math.max` bound. Per that file's own warning, this edit deserves an adversarial pass, not a skim. *Coverage.*

**Suite-level:** `npm run check` green (`SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test`). This change touches **no prompt bytes** — the KPR-387 byte-exact prompt pin, the KPR-388 delta pins, the KPR-389 D4/C4 escape-phrase guard, the KPR-409 summary pins and the KPR-413 continuation-leg pins must all stay green with zero edits. Any test that currently seeds `fetchThreadHistory` keeps passing unchanged, since non-ack messages are untouched by the filter.

## 10. Rollback

**Config lever, not code revert** — the epic design's explicit departure from Child A's posture, and the right call here: B1 changes *visible meeting output* (up to N messages per trigger), so an operator must be able to silence it without a deploy.

`meetingWorkers.ackEnabled: false` + restart ⇒ no new acks. The recognition filter deliberately keeps running (§5.5), so acks already in a live thread stay out of meeting context — flipping the lever is clean at both ends.

Per-instance blast radius if the lever is never flipped: acks per human trigger ≤ the number of round-0 selectees still unresolved at 15s, bounded by roster size, and zero for the 2-5s population that dominates. Observable on the existing KPR-389 §C5 surfaces plus the ack's own delivery log line.

Full code revert remains available and is a clean single-hunk removal (helper + constants + one wrapper + three config lines).

## 11. Relationship to KPR-416 (Child A)

**Sequencing.** A lands first, per the epic design's own note. The shared function is `dispatchToAgent`: A adds `markReactionExclusion` immediately before `deliverAgentResult` (`:1481`) and stamps `meetingExclusionTs` in the conference meta block (`:1373-1382` — the same range KPR-416's own spec cites; verified against this tree, the block opens at `meta: {` on `:1373` and closes on `:1382`); B1 wraps the turn await at `:1400` and adds module-scope helpers. **The two edits are in different statements and do not overlap** — the rebase is mechanical — but merging A first keeps the diff review honest.

**Behavioral dependency (the reason Linear blocks B1 on A) — it is on A's *relocation*, not on A's *predicate*.** What §6.4's ruling actually consumes is that A moved the reaction-exclusion write from **selection time** to **delivery time**. At delivery time a suppressed round-0 turn takes the `isNonResponse` branch and writes no exclusion, so the acked-then-suppressed agent stays round-1-eligible.

That property is **invariant across both write predicates A considered.** Under branch position (`!isNonResponse`) and under the narrower "genuinely non-empty non-errored content," a suppressed turn writes nothing either way — it is in the `isNonResponse` branch by definition, and it has no real content to satisfy the narrower test. §6.4 ground 2 therefore holds identically under either. (If anything the narrower predicate is *more* favourable: it would also leave **errored** turns unexcluded, making orphaned acks less permanent, not more.) So a predicate change is **not** a tripwire for this spec, and §6.4 does not need re-deriving on one.

**What would break §6.4 is a revert of the relocation** — moving the write back to selection time, where every agent selected for round 0 is excluded from round 1 regardless of how its turn ended. Under that shape the acked-and-suppressed agent is permanently silent by construction and ground 2 evaporates entirely. T11's companion assertion is the tripwire for exactly that revert, and is stated that way in §9.

**No conflict in the other direction:** A's tracker and meta key are read by nothing this child adds, and B1's ack is engine chrome that never delivers agent text, so it can never mark reaction-exclusion under A's rule ("handed text to delivery" — the ack is delivered by `deliverMeetingAck`, which is not a turn result and touches neither of A's three write sites).

## 12. Canon (to lift into KPR-415's Decision Register when it opens)

KPR-415 is a pre-register epic with no register section yet; recorded here per the same convention KPR-416 §13 used.

- **New:** *acks are operational chrome, never meeting content* — recognized by a stable content pattern, stripped at exactly one history-fetch point, and that strip is never gated on the feature's own lever.
- **New:** *≤ 1 ack per (agent, human trigger)* — replays, KPR-402 continuation legs and worker re-entry are structurally ack-free because the gate reads `resolved`, never `meta`.
- **New:** *an ack is never retracted* — no delete, no edit, no follow-up, no reaction marker. The wording is a statement of state, not a promise of a reply, and that is what makes the rule liveable.
- **Preserves KPR-389 §D5 (goal 5)** in full — the round-0 gate is the mechanism, and T3 is its guard.
- **Preserves KPR-413** — continuation legs stay conference-stripped and gain no ack behavior.
- **Depends on KPR-416's *relocation* of the reaction-exclusion write to delivery time** — not on which write predicate A chose — for §6.4's reasoning (§11).

---

## 13. Post-merge addendum — coherence review of `2499a57` (2026-08-29)

*Appended by the KPR-415 coherence seam after this child merged (`2499a57`, PR #437). Verdict: **ALIGNED**, with one **`GATE1_AMENDMENT`** pending the operator's ruling. Added rather than edited in place, so the pre-merge artifact stays legible — same precedent as `kpr-416-spec.md` §14.*

### 13.1 §8's ordering claim is falsified — the merged code is right, this spec is stale

`:334` states:

> **Ack ordering vs. the answer, generally.** The ack fires at 15s; the answer at turn end (>15s by construction, since a faster turn cancels). Ordering is therefore **correct by construction, not by luck**.

**That is a bound on post *start*, not on post *landing*, and Slack does not preserve the two.** The pre-PR review adjudicated this by reading `@slack/web-api`'s retry semantics out of `node_modules` rather than from memory, and found the concern *stronger* than first stated: `WebClient` 429 handling **pauses the shared request queue**, delays, then restarts it and re-throws to retry — so a 429'd ack is silently re-queued **behind whatever entered the queue during the pause**, which can include that agent's own answer. `chat.postMessage` is ~1/sec per channel and `maxRequestConcurrency` defaults to 100, so in an N-agent cohort every unresolved responder really does fire its ack into one channel simultaneously.

The merged code says the right thing (`dispatcher.ts`, `runTurnWithMeetingAck`'s doc comment): the guarantee is on start order, the effect is harmless (the ack is stripped from history either way and "picked this up" stays true whenever it lands), it is **distinct** from §8's accepted *cancel-vs-in-flight-post* race — that one is about `cancel()` failing to unpost — and the tempting fix is warned off, because awaiting the ack would put up to thirty minutes of Slack retry latency on the turn's critical path.

The coherence seat tightened the population bound further than the in-code comment: the reordering window is roughly turns settling within (N−1) seconds of the threshold, **narrower** than "exactly the multi-agent population this feature targets". Whoever revisits should carry the tighter bound. Now canon as **KPR-415/C16**.

### 13.2 The three canon entries in §12 were not lifted verbatim, deliberately

§12 parked three entries "to lift into KPR-415's Decision Register when it opens". The register **had** opened (at KPR-416's coherence seam), and plan Task 10 says lift verbatim — but the driver declined and handed them to this seat instead. The seat upheld that call, and found **entry 2 was not merely under-scoped but mis-reasoned**:

- **Entry 2 conflated what this very spec forbids conflating.** It said replays, KPR-402 legs and worker re-entry are ack-free *"because the gate reads `resolved`, never `meta`"*. Key Points and §5.2 are emphatic these are ack-free for **different** reasons: a replay **retains** its conference meta and is ack-free because the single-dispatch leg **carries no ack wrapper at all**; a KPR-402 leg is ack-free because KPR-413 stripped the four keys. "The gate reads `resolved`" explains the **plain fan-out** case only — which is exactly why T4b is labelled vacuous-by-construction in its own comment. Lifting verbatim would have canonized the conflation this spec spent a Key Point preventing, and left T4b's real invariant ("never add the ack wrapper to the single-dispatch leg") unstated anywhere.
- **Entry 1 over-claimed** ("never meeting content" holds only for the five *engine-internal* consumers) and omitted the Dispatcher-not-adapter domain-boundary call and the §5.4 residual whose eaten set is wider than §5.4's own prose.
- **Entry 3 was over-tight** — "never retracted" as an absolute drops §6.4's recorded revisit trigger (an ack **edit**, not a delete).
- **Three consequential decisions were absent entirely:** the `ackEnabled`/`enabled` independence, the rollback asymmetry with KPR-416, and the `MEETING_ACK_TEXT`↔recognizer lockstep.

All corrected as **KPR-415/C11–C16**. **Root cause worth recording for sibling children, and the same one KPR-416 hit:** a child that supersedes or extends canon should quote the target entry **in full** before writing its own.

### 13.3 The pending Gate-1 amendment

Gate 1's work-queue item 3, approved verbatim, required *"confirmation that the delay-then-ack substitutes acceptably for the operator's literal 'immediate ack' ask (flagged in the design doc as needing confirmation, **not assumed**)"*. `:26` resolves this as *delegated under the Gate 1 signoff* — **circular**, because that signoff is the instrument that recorded the confirmation as still owed.

The design implemented is the approved design; only the approval checkpoint was skipped. It is flagged `GATE1_AMENDMENT` on the epic, **deliberately not canonized**, and the epic is parked until the operator rules. If she prefers the literal immediate ack, the change is one line (`MEETING_ACK_DELAY_MS` → `0`) on the epic branch, and **T2 must be retired rather than repaired** — it is the only case encoding the delay's existence.

### 13.4 Follow-up not taken at this seat

**T13a's guard is narrower than the canon claim it protects.** C11 asserts "exactly one history-fetch point", verified **repo-wide**; T13a scans `dispatcher.ts` **only**, so a future `slackAdapter.fetchThreadHistory(...)` in another module escapes it silently. Not hypothetical: **the scribe is a named C11 consumer whose ack-blindness rests entirely on being *handed* the array rather than fetching its own**, and `meeting-scribe.ts` is the likeliest place a future reader adds one. Either widen the scan to `src/` (excluding the adapter's own definition) or narrow the canon claim; both the coherence seat and the driver would widen. Deliberately not done here — the epic is parking, and a post-gate test change no gate prescribed should get its own round.

Also trivial, mentioned only: `:179` cites the author-extraction regex at `slack-adapter.ts:222`; post-KPR-416 it is `:228`. The merged code comment is already correct.

Full reasoning: the `# Decision Register Entry` comment keyed to `2499a57` on KPR-415, and that epic's `## Decision Register — Canon` section.

### 13.5 C18 ruling — the substitution is ratified (2026-08-29)

*Appended by KPR-420 (folded-in mechanical fix, `kpr-420-spec.md` §5.5). Added rather than edited in place — the same append-only convention as §13 itself; the superseded lines above stay as written.*

§13.3's pending `GATE1_AMENDMENT` is **resolved**: May Huang ratified the delay-then-ack substitution at the 15s threshold **directly**, via `rule-coherence` on `2499a57` (2026-08-29, ruling session `rule-kpr415-20260829T045458Z`) — now canon **KPR-415/C18**. Consequences for this document:

- The Key Points bullet at `:26` and its §8 assumption-ledger restatement at `:342`, which present the substitution as *delegated under the Gate 1 signoff*, are **superseded wherever that framing appears** — C18's register text names both lines. The circular delegated-from-the-signoff reasoning §13.3 dissected is retired as precedent and must not be cited by future children.
- §13.3's park condition is lifted; Gate 1 item 3's confirmation requirement is satisfied retroactively.
- `MEETING_ACK_DELAY_MS` stays a non-configurable module constant; `0` remains the recorded one-line path to the literal immediate ack if ever revisited (in which case T2 is retired, not repaired — §13.3's instruction stands).
