import { describe, it, expect } from "vitest";
import {
  OutageEpisodeTracker,
  policyFor,
  policyForId,
  sourceOfId,
  waitingFor,
  adapterKeyFor,
  threadKeyFor,
  outageNoticeFor,
  overflowNoticeFor,
  terminalFailureNotice,
  expiryNotice,
  replayWrap,
  OUTAGE_NOTICE_DEFAULT,
  OUTAGE_NOTICE_SMS,
} from "./outage-notices.js";
import type { WorkItem } from "../types/work-item.js";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hello",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    threadId: "t1",
    timestamp: new Date(),
    ...overrides,
  };
}

describe("policyFor (§5-3a source policy table)", () => {
  it("skips cron turns (sched: prefix — re-fires by design)", () => {
    expect(policyFor(item({ id: "sched:agent-a:daily:123" }))).toBe("skip");
  });
  it("queues system one-shots silently (callback:/event:/team- prefixes)", () => {
    expect(policyFor(item({ id: "callback:65a1b2" }))).toBe("silent");
    expect(policyFor(item({ id: "event:65a1b2:agent-a" }))).toBe("silent");
    expect(policyFor(item({ id: "team-65a1b2" }))).toBe("silent");
  });
  it("queues worker re-entry one-shots silently (worker: prefix — KPR-390)", () => {
    expect(policyFor(item({ id: "worker:65a1b2c3d4" }))).toBe("silent");
  });
  it("notifies human channels: slack, sms, imessage, app/ws, team DM", () => {
    expect(policyFor(item({ source: { kind: "slack", id: "C1", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "sms", id: "+1555", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "imessage", id: "+1555", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "app", id: "dev-1", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "team", id: "dm:agent-a", label: "x" } }))).toBe("notify");
  });

  // KPR-454 AC4: the pre-refactor value of every reserved prefix, stated once
  // as a table. This case is written BEFORE the D7 extraction and must pass
  // unchanged after it — that equality is the entire behaviour-preserving
  // claim. Negative-verify: break one row of SOURCE_PREFIXES and this fails.
  it("pins every reserved-prefix classification (pre/post-refactor identity)", () => {
    const cases: Array<[string, "skip" | "silent" | "notify"]> = [
      ["sched:agent-a:daily digest:1725465600000", "skip"],
      ["callback:65a1b2c3d4e5f60718293a4b", "silent"],
      ["event:65a1b2c3d4e5f60718293a4b:agent-a", "silent"],
      ["team-65a1b2c3d4e5f60718293a4b", "silent"],
      ["worker:65a1b2c3d4e5f60718293a4b", "silent"],
      ["1725465600.123456", "notify"],
      ["imsg-4471", "notify"],
      ["scheduled:not-a-reserved-prefix", "notify"],
    ];
    for (const [id, expected] of cases) {
      expect(policyFor(item({ id })), `policyFor(${id})`).toBe(expected);
    }
  });
});

describe("sourceOfId / waitingFor (KPR-454 D7, AC4)", () => {
  it("classifies all six buckets", () => {
    expect(sourceOfId("sched:a:b:1")).toBe("cron");
    expect(sourceOfId("callback:65a1")).toBe("callback");
    expect(sourceOfId("event:65a1:agent-a")).toBe("event");
    expect(sourceOfId("team-65a1")).toBe("agent");
    expect(sourceOfId("worker:65a1")).toBe("worker");
    expect(sourceOfId("1725465600.123456")).toBe("human");
  });

  it("maps every bucket to a waiting value — team- is `agent`, not `human-now`", () => {
    expect(waitingFor("team-65a1")).toBe("agent"); // the stale-comment trap, pinned
    expect(waitingFor("sched:a:b:1")).toBe("nobody");
    expect(waitingFor("callback:65a1")).toBe("nobody");
    expect(waitingFor("event:65a1:agent-a")).toBe("nobody");
    expect(waitingFor("worker:65a1")).toBe("nobody");
    expect(waitingFor("1725465600.123456")).toBe("human-now");
  });

  it("an absent id is `nobody` — the detached worker/scribe case, fail-closed and true", () => {
    expect(waitingFor(undefined)).toBe("nobody");
  });

  it("policyForId and waitingFor project from the same bucket", () => {
    // Not a tautology: it fails if EITHER projection ever acquires a private
    // prefix test instead of reading sourceOfId. Both are asserted against
    // LITERAL maps declared here, never against the production Records.
    const POLICY = {
      cron: "skip",
      callback: "silent",
      event: "silent",
      agent: "silent",
      worker: "silent",
      human: "notify",
    } as const;
    const WAITING = {
      cron: "nobody",
      callback: "nobody",
      event: "nobody",
      agent: "agent",
      worker: "nobody",
      human: "human-now",
    } as const;
    for (const id of ["sched:x", "callback:x", "event:x", "team-x", "worker:x", "plain-id"]) {
      const bucket = sourceOfId(id);
      expect(policyForId(id), `policyForId(${id})`).toBe(POLICY[bucket]);
      expect(waitingFor(id), `waitingFor(${id})`).toBe(WAITING[bucket]);
    }
  });

  it("KPR-402 continuation legs inherit their origin's bucket", () => {
    // dispatcher.ts:1038 mints `<baseId>#dl<n>`; the suffix is on the TAIL,
    // so prefix detection is unaffected.
    expect(waitingFor("team-x#dl1")).toBe("agent");
    expect(waitingFor("sched:x#dl1")).toBe("nobody");
    expect(waitingFor("1725465600.123456#dl2")).toBe("human-now");
  });
});

describe("keys", () => {
  it("adapterKeyFor prefers adapterId over kind", () => {
    expect(adapterKeyFor(item({ source: { kind: "sms", id: "x", label: "x", adapterId: "sms-line-2" } }))).toBe(
      "sms-line-2",
    );
    expect(adapterKeyFor(item())).toBe("slack");
  });
  it("threadKeyFor falls back to sender (SMS has no threads — per-sender key)", () => {
    expect(threadKeyFor(item({ threadId: undefined, sender: "+15551234" }))).toBe("+15551234");
    expect(threadKeyFor(item())).toBe("t1");
  });
});

describe("templates", () => {
  it("selects SMS/iMessage vs default variants", () => {
    expect(outageNoticeFor("sms")).toBe(OUTAGE_NOTICE_SMS);
    expect(outageNoticeFor("imessage")).toBe(OUTAGE_NOTICE_SMS);
    expect(outageNoticeFor("slack")).toBe(OUTAGE_NOTICE_DEFAULT);
    expect(outageNoticeFor("app")).toBe(OUTAGE_NOTICE_DEFAULT);
    expect(overflowNoticeFor("sms")).toContain("could not be saved");
    expect(overflowNoticeFor("slack")).toContain("can't even save");
  });
  it("terminal + expiry notices carry the operative facts", () => {
    expect(terminalFailureNotice(new Date())).toContain("could not be answered");
    expect(expiryNotice(1)).toContain("1 earlier message sent");
    expect(expiryNotice(3)).toContain("3 earlier messages sent");
    // No false recovery claim — expiry can fire mid-outage (§5-2c-ii).
    expect(expiryNotice(1)).not.toContain("Service is back");
  });
  it("replayWrap: notify variant asks for a delay acknowledgment; silent variant is minimal", () => {
    const notify = replayWrap("original question", new Date(), "notify");
    expect(notify).toMatch(/^\[This message was received at .* during an AI service outage/);
    expect(notify).toContain("Acknowledge the delay briefly");
    expect(notify.endsWith("original question")).toBe(true);
    const silent = replayWrap("do the thing", new Date(), "silent");
    expect(silent).toMatch(/^\[Replayed after an AI service outage/);
    expect(silent).not.toContain("Acknowledge");
  });
});

describe("OutageEpisodeTracker (§7.3)", () => {
  it("episode lifecycle: notice once per thread → silent repeats → clear → next outage notices again", () => {
    const tracker = new OutageEpisodeTracker();
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true);
    // Repeat turns during the same episode — including across breaker probe
    // cycles (the tracker never reads openedAt, so probe churn can't re-notice).
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(false);
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(false);
    // A different thread in the same episode gets its own single notice.
    expect(tracker.firstForThread("claude", "slack", "t2")).toBe(true);

    tracker.clear("claude");
    expect(tracker.hasActiveEpisode("claude")).toBe(false);
    // Next outage = new episode → notices again.
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true);
  });

  it("synchronous test-and-set: two immediate calls yield exactly one true (fan-out race)", () => {
    const tracker = new OutageEpisodeTracker();
    const results = [tracker.firstForThread("claude", "slack", "t1"), tracker.firstForThread("claude", "slack", "t1")];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("episodes are per-provider; clear only prunes the cleared provider's keys", () => {
    const tracker = new OutageEpisodeTracker();
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true);
    expect(tracker.firstForThread("gemini", "slack", "t1")).toBe(true);
    tracker.clear("claude");
    expect(tracker.firstForThread("gemini", "slack", "t1")).toBe(false); // gemini episode intact
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true); // fresh claude episode
  });

  it("begin() reports episode start exactly once", () => {
    const tracker = new OutageEpisodeTracker();
    expect(tracker.begin("claude")).toBe(true);
    expect(tracker.begin("claude")).toBe(false);
    tracker.clear("claude");
    expect(tracker.begin("claude")).toBe(true);
  });
});

describe("replayWrap resume-aware sentence (KPR-402 ⚠A7 — KPR-399 §Edge-12 closure)", () => {
  it("both policy variants carry the static sentence inside the note; the original still ends the wrap verbatim", () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix replayWrap carries no
    // resume sentence — both toContain assertions fail.
    const notify = replayWrap("original question", new Date(), "notify");
    const silent = replayWrap("do the thing", new Date(), "silent");
    const sentence =
      "If your session already contains this message and partial work on it, continue from where you left off instead of restarting.";
    expect(notify).toContain(sentence);
    expect(silent).toContain(sentence);
    // The sentence lives INSIDE the bracketed note — shape pins hold.
    // (r1 NIT-3: `toContain` alone would still pass if the sentence were
    // appended AFTER the note's closing bracket, i.e. bled into the user's
    // own text. The first `]` in the wrap closes the note, and neither the
    // sentence nor these fixtures contain a bracket, so an index comparison
    // is an exact inside-the-bracket pin.)
    expect(notify.indexOf(sentence)).toBeLessThan(notify.indexOf("]"));
    expect(silent.indexOf(sentence)).toBeLessThan(silent.indexOf("]"));
    expect(notify.endsWith("original question")).toBe(true);
    expect(silent.endsWith("do the thing")).toBe(true);
  });
});
