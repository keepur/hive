/**
 * KPR-307: honest-outage notice templates (§5-1b — ⚠ wording delegated,
 * structure decided; exported constants so tests pin them), the §5-3a source
 * policy table, and the outage-episode tracker (§7.3).
 */
import type { WorkItem, ChannelKind } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// Source policy (§5-3a), and — since KPR-454 (D7) — the ONE reserved-prefix
// table in the repository.
//
// Prefix-detected on engine-synthesized ids; the formats are fixed in
// scheduler.ts (sched:/callback:/event:/team-) and meeting-worker-pool.ts
// (worker:). Known caveat (KPR-307 spec Finding 7 r1, ⚠ §10): ws/app ids are
// client-supplied, so a client id colliding with a reserved prefix
// misclassifies. Accepted at spec time; the blast radius is one outage
// notice's policy and — post-KPR-454 — one event's `waiting`, hence one
// mis-selected subscription. The meta.outagePolicy variant remains the
// documented alternative.
//
// KPR-454 D7 / contract C6: `sourceOfId` is the ONLY function in this
// repository that tests a reserved WorkItem.id prefix, and both public
// answers are TOTAL maps from its bucket. That is what keeps them from
// drifting: adding a row to SOURCE_PREFIXES is a COMPILE ERROR until both
// projections classify the new source. A second startsWith chain anywhere
// else is a contract violation, guarded by
// src/ops/single-prefix-predicate.test.ts.
// ---------------------------------------------------------------------------

import type { Waiting } from "../ops/types.js";

export type OutageSourcePolicy = "notify" | "silent" | "skip";

/** The bucket a reserved WorkItem.id prefix names. Fallthrough is "human". */
export type WorkItemSource = "cron" | "callback" | "event" | "agent" | "worker" | "human";

/**
 * THE prefix table. Ordered: the first matching prefix wins, so a longer
 * prefix that shares a head with a shorter one must precede it. None do
 * today — the five are mutually non-prefixing — so this ordering rule is
 * currently UNEXERCISED by any test, and it is stated as contract for the
 * prefix someone adds later rather than as a verified property. (It is NOT
 * what keeps `scheduled:` out of the `sched:` bucket: `"scheduled:"` fails
 * `startsWith("sched:")` outright, at index 5.) Per-arm rationale lives on
 * the row it explains.
 */
const SOURCE_PREFIXES: ReadonlyArray<readonly [string, WorkItemSource]> = [
  ["sched:", "cron"], // cron re-fires at the next match — queueing would double-run
  ["callback:", "callback"], // one-shot, marked fired pre-dispatch — queue preserves it
  ["event:", "event"], // one-shot event delivery — queue preserves it
  ["team-", "agent"], // agent-to-agent traffic: another agent is blocked on it
  ["worker:", "worker"], // KPR-390: one-shot boss re-entry, claim already terminal
] as const;

/** THE reserved-prefix predicate (C6). Nothing else in the repo may test one. */
export function sourceOfId(id: string): WorkItemSource {
  for (const [prefix, source] of SOURCE_PREFIXES) {
    if (id.startsWith(prefix)) return source;
  }
  // Human channels: slack, sms, imessage, app/ws. NOT "team DM" — a `team-`
  // id returns "agent" above and can never reach here. (The pre-KPR-454
  // comment claimed otherwise; an implementer who trusted it mapped
  // agent-to-agent traffic to a human waiter, which is the misrouting the
  // KPR-451 epic exists to remove.)
  return "human";
}

const POLICY_BY_SOURCE: Record<WorkItemSource, OutageSourcePolicy> = {
  cron: "skip",
  callback: "silent",
  event: "silent",
  agent: "silent",
  worker: "silent",
  human: "notify",
};

const WAITING_BY_SOURCE: Record<WorkItemSource, Waiting> = {
  cron: "nobody",
  callback: "nobody",
  event: "nobody",
  agent: "agent",
  worker: "nobody",
  human: "human-now",
};

export function policyForId(id: string): OutageSourcePolicy {
  return POLICY_BY_SOURCE[sourceOfId(id)];
}

/** Unchanged behaviour, signature, return type and callers (dispatcher.ts:872, :1103). */
export function policyFor(item: WorkItem): OutageSourcePolicy {
  return policyForId(item.id);
}

/**
 * KPR-454 D7 / contract C6: the `waiting` attribute of an ops event, derived
 * from the SAME table as the outage policy — never a second predicate.
 *
 * An absent id ⇒ "nobody", fail-closed to the quietest value and TRUE rather
 * than a fudge: a detached worker or scribe execution has no WorkItem because
 * nobody is directly waiting on it (KPR-453 canon).
 *
 * `waiting: "obligation"` is NEVER derived here — D3 reserves it for KPR-456's
 * sweep, the only component that knows a deadline exists.
 *
 * D6's admissibility bound deliberately does NOT cascade into this function:
 * that bound governs STORAGE of an id, while `waiting` is derived from
 * whatever id the runtime holds, admissible or not. Re-classifying an honest
 * id whose only defect is an unstorable character would buy nothing (a hostile
 * `team-…` id passes the charset anyway).
 */
export function waitingFor(id?: string): Waiting {
  if (id === undefined) return "nobody";
  return WAITING_BY_SOURCE[sourceOfId(id)];
}

export function adapterKeyFor(item: WorkItem): string {
  return item.source.adapterId ?? item.source.kind;
}

/** SMS has no threads — notice dedup keys on `threadId ?? sender` (§5-1b). */
export function threadKeyFor(item: WorkItem): string {
  return item.threadId ?? item.sender;
}

// ---------------------------------------------------------------------------
// Notice templates. Plain-text WorkResults with `error` UNSET — result.error
// triggers formatError on Slack, a delivery SKIP on SMS/iMessage, and a raw
// Error frame on WS. No retry-time promises (retryAfterMs is probe cadence,
// not a recovery ETA).
// ---------------------------------------------------------------------------

export const OUTAGE_NOTICE_DEFAULT =
  "⚠️ I can't reach my AI service right now (provider outage). Your message is saved — I'll answer it automatically as soon as service is back.";
export const OUTAGE_NOTICE_SMS =
  "Our AI assistant is temporarily down. Your message is saved and you'll get a reply when service returns.";
export const OUTAGE_OVERFLOW_NOTICE_DEFAULT =
  "⚠️ I can't reach my AI service right now — and I can't even save your message right now. Please re-send it later.";
export const OUTAGE_OVERFLOW_NOTICE_SMS =
  "Our AI assistant is temporarily down and your message could not be saved. Please re-send it later.";
/** §5-1b voice: spoken as a normal completion — never a bare 500/503 (dead air to Vapi). */
export const VOICE_OUTAGE_SPOKEN_NOTICE =
  "I'm having trouble reaching my AI service right now — please try again in a few minutes.";

export function outageNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? OUTAGE_NOTICE_SMS : OUTAGE_NOTICE_DEFAULT;
}

export function overflowNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? OUTAGE_OVERFLOW_NOTICE_SMS : OUTAGE_OVERFLOW_NOTICE_DEFAULT;
}

/** §5-2g terminal failure — plain text (the normal error path is swallowed by SMS/iMessage). */
export function terminalFailureNotice(enqueuedAt: Date): string {
  return `I still can't reach my AI service after several tries — your message from ${formatNoticeTime(enqueuedAt)} could not be answered. Please re-send it.`;
}

/**
 * §5-2c-ii batched per-thread expiry notice, delivered at drain time. No
 * recovery claim: `expireOlderThan` runs on every poller tick regardless of
 * breaker state, so a message can age out (past `maxAgeHours`) and get this
 * notice while the outage is still ongoing — "service is back" would be a lie.
 */
export function expiryNotice(count: number): string {
  return `It's been a while since your message — I couldn't get to ${count} earlier message${count === 1 ? "" : "s"} sent during the outage. Please re-send anything still needed if it's still relevant.`;
}

/**
 * §5-2d replayed-turn presentation: prompt-note, not hard text prefix — the
 * model handles phrasing, staleness, and the re-ask-dedup case in its own voice.
 *
 * KPR-402 (⚠A7 — KPR-399 §Edge-12 closure): both variants carry one static
 * resume-aware sentence. Post-KPR-399 a post-turn-fault doc's replay resumes
 * the aborted session, whose transcript already contains this very message
 * and partial work on it — without the sentence the model would restart.
 * Safe when no session resumes (the normal fast-fail-class case — nothing to
 * falsely reference), materially better when one does. Static text only; no
 * processor logic, no store reads.
 */
export function replayWrap(originalText: string, receivedAt: Date, policy: "notify" | "silent"): string {
  const resumeNote =
    "If your session already contains this message and partial work on it, continue from where you left off instead of restarting.";
  const note =
    policy === "notify"
      ? `[This message was received at ${formatNoticeTime(receivedAt)} during an AI service outage and is being replayed now. Acknowledge the delay briefly if a human sent it. ${resumeNote}]`
      : `[Replayed after an AI service outage; originally received ${formatNoticeTime(receivedAt)}. ${resumeNote}]`;
  return `${note}\n\n${originalText}`;
}

function formatNoticeTime(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Episode tracker (§7.3). Outage episode ≠ breaker openedAt — openedAt
// advances on every failed probe (~every 15-60s), so keying notice dedup on
// it would re-notify every probe cycle. In-memory; restart worst case = one
// repeated notice per thread.
// ---------------------------------------------------------------------------

export class OutageEpisodeTracker {
  private episodes = new Map<string, number>(); // provider → episodeId
  private noticed = new Set<string>(); // `${provider}:${episodeId}:${adapterKey}:${threadKey}`
  private nextEpisodeId = 1;

  /** Begin (or join) the provider's episode. Returns true when this call began it. */
  begin(provider: string): boolean {
    if (this.episodes.has(provider)) return false;
    this.episodes.set(provider, this.nextEpisodeId++);
    return true;
  }

  /**
   * True exactly once per (provider-episode, adapter, thread). SYNCHRONOUS
   * test-and-set — a single has+add with no await between check and mark:
   * fanned-out agents fast-fail concurrently under Promise.all, and two
   * "first" observations would double-notify one thread (Finding 8 r1;
   * normative constraint, spec §7.3).
   */
  firstForThread(provider: string, adapterKey: string, threadKey: string): boolean {
    let episode = this.episodes.get(provider);
    if (episode === undefined) {
      episode = this.nextEpisodeId++;
      this.episodes.set(provider, episode);
    }
    const key = `${provider}:${episode}:${adapterKey}:${threadKey}`;
    if (this.noticed.has(key)) return false;
    this.noticed.add(key);
    return true;
  }

  hasActiveEpisode(provider: string): boolean {
    return this.episodes.has(provider);
  }

  /**
   * Episode end (caller gates on `stateFor(provider)?.state !== "open"` at
   * the moment the successful turn completes — Finding 3 r1). Prunes the
   * ended episode's notice keys, so growth is bounded by threads-per-episode.
   */
  clear(provider: string): void {
    const episode = this.episodes.get(provider);
    if (episode === undefined) return;
    this.episodes.delete(provider);
    const prefix = `${provider}:${episode}:`;
    for (const key of this.noticed) {
      if (key.startsWith(prefix)) this.noticed.delete(key);
    }
  }
}
