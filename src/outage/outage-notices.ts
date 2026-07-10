/**
 * KPR-307: honest-outage notice templates (§5-1b — ⚠ wording delegated,
 * structure decided; exported constants so tests pin them), the §5-3a source
 * policy table, and the outage-episode tracker (§7.3).
 */
import type { WorkItem, ChannelKind } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// Source policy (§5-3a). Prefix-detected on engine-synthesized ids — formats
// are fixed in scheduler.ts (sched:/callback:/event:/team-). Known caveat
// (spec Finding 7 r1, ⚠ §10): ws/app ids are client-supplied; a client id
// that collides with a reserved prefix would misclassify. Accepted at spec
// time; the meta.outagePolicy variant remains the documented alternative.
// ---------------------------------------------------------------------------

export type OutageSourcePolicy = "notify" | "silent" | "skip";

export function policyFor(item: WorkItem): OutageSourcePolicy {
  const id = item.id;
  if (id.startsWith("sched:")) return "skip"; // cron re-fires at the next match — queueing would double-run
  if (id.startsWith("callback:")) return "silent"; // one-shot, marked fired pre-dispatch — queue preserves it
  if (id.startsWith("event:")) return "silent";
  if (id.startsWith("team-")) return "silent";
  return "notify"; // human channels: slack, sms, imessage, app/ws, team DM
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
 */
export function replayWrap(originalText: string, receivedAt: Date, policy: "notify" | "silent"): string {
  const note =
    policy === "notify"
      ? `[This message was received at ${formatNoticeTime(receivedAt)} during an AI service outage and is being replayed now. Acknowledge the delay briefly if a human sent it.]`
      : `[Replayed after an AI service outage; originally received ${formatNoticeTime(receivedAt)}.]`;
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
