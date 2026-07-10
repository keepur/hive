import { describe, it, expect } from "vitest";
import {
  OutageEpisodeTracker,
  policyFor,
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
  it("notifies human channels: slack, sms, imessage, app/ws, team DM", () => {
    expect(policyFor(item({ source: { kind: "slack", id: "C1", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "sms", id: "+1555", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "imessage", id: "+1555", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "app", id: "dev-1", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "team", id: "dm:agent-a", label: "x" } }))).toBe("notify");
  });
});

describe("keys", () => {
  it("adapterKeyFor prefers adapterId over kind", () => {
    expect(adapterKeyFor(item({ source: { kind: "sms", id: "x", label: "x", adapterId: "sms-line-2" } }))).toBe("sms-line-2");
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
    expect(expiryNotice(1)).toContain("1 earlier message from");
    expect(expiryNotice(3)).toContain("3 earlier messages from");
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
    const results = [
      tracker.firstForThread("claude", "slack", "t1"),
      tracker.firstForThread("claude", "slack", "t1"),
    ];
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
