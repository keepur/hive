import { describe, expect, it } from "vitest";
import { detectIntentTrailer } from "./intent-trailer.js";

// KPR-393 §D2. Positives seed from the two real failure archetypes the
// spec documents (intra-turn plan-narration; cross-turn contingent
// promise); negatives from the real zero-tool-but-correct shapes
// ("No response needed", discussion verdicts, completed reports).

describe("detectIntentTrailer — positives (Sol transcript shapes)", () => {
  it.each([
    // intra-turn archetype: plan narrated as the final message
    "Understood. I'll own the follow-up edit. First step is to inspect the current draft and existing feedback, then I'll post the exact proposed delta.",
    // cross-turn contingent promise
    "Yes. I'll lead rev 2 and give first review. Send the base commit and paths; I'll draft from there.",
    // bare acknowledgment closers
    "Got it — on it.",
    "On it.",
    // curly-apostrophe variant
    "Understood. I’ll check the deploy logs and report back.",
    "Good question. I'm going to pull the actual numbers before answering.",
    "Let me inspect the current artifact first.",
    "I will follow up with the vendor tomorrow.",
  ])("flags %j", (text) => {
    expect(detectIntentTrailer(text)).toBe(true);
  });
});

describe("detectIntentTrailer — negatives", () => {
  it.each([
    // meeting-rules-mandated reply (spec §Edge cases, fixture-pinned)
    "No response needed.",
    // substantive discussion verdict, no tools required
    "Verdict: ship it as-is. The deadline semantics are unchanged and the risk is contained to the new adapter.",
    // completed-work report
    "Done — the fix is deployed and the check passed.",
    // "on it" as substring / mid-clause (anchor guard)
    "The decision was based on it, so nothing changes.",
    "The team is still working on it and expects Friday.",
    // reader-directed closer, not a self-commitment
    "Here's the summary you asked for. Let me know if you want the longer version.",
    // empty / whitespace (reflection or aborted turns)
    "",
    "   \n  ",
  ])("does not flag %j", (text) => {
    expect(detectIntentTrailer(text)).toBe(false);
  });
});

describe("detectIntentTrailer — tail window", () => {
  it("a promise more than ~300 chars before the end does not flag (completed-report tail)", () => {
    const text =
      "I'll check the logs first. " +
      "The results follow. ".repeat(20) +
      "All checks passed; nothing further is required.";
    expect(text.length).toBeGreaterThan(400); // the promise sits outside the 300-char tail
    expect(detectIntentTrailer(text)).toBe(false);
  });

  it("a promise inside the final 300 chars flags even with long preceding text", () => {
    const text = "Analysis complete. ".repeat(30) + "Next, I'll draft the migration plan.";
    expect(detectIntentTrailer(text)).toBe(true);
  });
});
