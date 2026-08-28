import { describe, it, expect } from "vitest";
import {
  MAX_DEADLINE_CONTINUATIONS,
  DEADLINE_NOTICE_DEFAULT,
  DEADLINE_NOTICE_SMS,
  DEADLINE_TERMINAL_NOTICE_DEFAULT,
  DEADLINE_TERMINAL_NOTICE_SMS,
  DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT,
  DEADLINE_ZERO_PROGRESS_NOTICE_SMS,
  deadlineNoticeFor,
  deadlineTerminalNoticeFor,
  deadlineZeroProgressNoticeFor,
  deadlineContinuationWrap,
  deadlineBaseIdOf,
} from "./deadline-continuation.js";
import { policyFor } from "../outage/outage-notices.js";
import type { WorkItem } from "../types/work-item.js";

function item(id: string): WorkItem {
  return {
    id,
    text: "hello",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    timestamp: new Date(),
  };
}

describe("deadline-continuation templates + constants (KPR-402, T12)", () => {
  it("cap is exactly 2 continuations (≤3 deadlines of wall clock) — exported constant, no config knob (⚠A1/⚠A6)", () => {
    expect(MAX_DEADLINE_CONTINUATIONS).toBe(2);
  });

  it("every exported notice string is pinned verbatim (⚠A2 — wording is a contract once shipped)", () => {
    expect(DEADLINE_NOTICE_DEFAULT).toBe(
      "⏳ That's taking longer than my per-turn time limit — I've saved my progress and I'm picking up where I left off.",
    );
    expect(DEADLINE_NOTICE_SMS).toBe(
      "Still working on your request — it needs more time than one pass allows. I'm continuing now.",
    );
    expect(DEADLINE_TERMINAL_NOTICE_DEFAULT).toBe(
      "⏳ I ran out of time on this several times over. I've kept all my partial work — say \"continue\" and I'll pick it up again.",
    );
    expect(DEADLINE_TERMINAL_NOTICE_SMS).toBe(
      'I couldn\'t finish your request in the time allowed. Reply "continue" to have me keep going.',
    );
    expect(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT).toBe(
      "⚠️ I couldn't get started on that within my time limit — please send it again.",
    );
    expect(DEADLINE_ZERO_PROGRESS_NOTICE_SMS).toBe("Your request timed out before I could start. Please re-send it.");
  });

  it("selectors: SMS/iMessage get the short no-emoji variants; everything else the default (KPR-307 pattern)", () => {
    expect(deadlineNoticeFor("sms")).toBe(DEADLINE_NOTICE_SMS);
    expect(deadlineNoticeFor("imessage")).toBe(DEADLINE_NOTICE_SMS);
    expect(deadlineNoticeFor("slack")).toBe(DEADLINE_NOTICE_DEFAULT);
    expect(deadlineNoticeFor("app")).toBe(DEADLINE_NOTICE_DEFAULT);
    expect(deadlineTerminalNoticeFor("sms")).toBe(DEADLINE_TERMINAL_NOTICE_SMS);
    expect(deadlineTerminalNoticeFor("slack")).toBe(DEADLINE_TERMINAL_NOTICE_DEFAULT);
    expect(deadlineZeroProgressNoticeFor("imessage")).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_SMS);
    expect(deadlineZeroProgressNoticeFor("team")).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT);
  });

  it("terminal notices name the manual escape hatch — the KPR-399 session row persists, 'continue' resumes it", () => {
    expect(DEADLINE_TERMINAL_NOTICE_DEFAULT).toContain('"continue"');
    expect(DEADLINE_TERMINAL_NOTICE_SMS).toContain('"continue"');
  });

  it("continuation wrap: deterministic, Edge-12-safe both ways (do-not-redo guard + embedded original + no-op exit)", () => {
    const wrap = deadlineContinuationWrap("summarize the repo", 1, 3);
    expect(wrap).toBe(deadlineContinuationWrap("summarize the repo", 1, 3)); // no timestamps — byte-deterministic
    expect(wrap.startsWith("[Continuation 1/3:")).toBe(true);
    expect(wrap).toContain("do NOT redo completed work");
    expect(wrap).toContain("re-run side-effectful actions");
    expect(wrap).toContain('reply "No response needed."'); // wires into NON_RESPONSE_PATTERNS suppression
    expect(wrap.endsWith("\n\nsummarize the repo")).toBe(true); // fresh-fallback belt: the original rides along
    expect(deadlineContinuationWrap("x", 2, 3).startsWith("[Continuation 2/3:")).toBe(true);
  });

  it("deadlineBaseIdOf strips exactly one trailing #dl<n> — leg ids stay flat (⚠A11)", () => {
    expect(deadlineBaseIdOf("x")).toBe("x");
    expect(deadlineBaseIdOf("x#dl1")).toBe("x");
    expect(deadlineBaseIdOf("x#dl12")).toBe("x");
    expect(deadlineBaseIdOf("callback:abc#dl2")).toBe("callback:abc");
    // Never produced by the chain (every leg re-derives from the base), but
    // the single-suffix strip is the documented contract:
    expect(deadlineBaseIdOf("x#dl1#dl2")).toBe("x#dl1");
  });

  it("per-leg suffix preserves policyFor's prefix classes — no policy plumbing (spec §Design.2)", () => {
    expect(policyFor(item("callback:x#dl1"))).toBe("silent");
    expect(policyFor(item("event:x#dl2"))).toBe("silent");
    expect(policyFor(item("team-x#dl1"))).toBe("silent");
    expect(policyFor(item("sched:x#dl1"))).toBe("skip");
    expect(policyFor(item("1699999999.000100#dl1"))).toBe("notify");
  });
});
