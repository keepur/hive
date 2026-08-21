import { describe, expect, it } from "vitest";
import { applyInterruptionMarker, buildInterruptionMarker } from "./interruption-marker.js";

describe("interruption marker (KPR-322)", () => {
  it("returns the user text unchanged when nothing was interrupted", () => {
    expect(applyInterruptionMarker("hello", null)).toBe("hello");
  });

  it("prefixes only when interruptedSpokenText is set", () => {
    const marked = applyInterruptionMarker("next question", "I was saying something");
    expect(marked.startsWith("[caller interrupted you mid-sentence;")).toBe(true);
    expect(marked.endsWith(" next question")).toBe(true);
    expect(marked).toBe(`${buildInterruptionMarker("I was saying something")} next question`);
  });

  it("uses the last 15 words of the spoken prefix as the tail", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i + 1}`);
    const marker = buildInterruptionMarker(words.join(" "));
    const expectedTail = words.slice(-15).join(" ");
    expect(marker).toBe(`[caller interrupted you mid-sentence; they heard your reply only up to: "…${expectedTail}"]`);
    expect(marker).not.toContain("w1 ");
    expect(marker).toContain("w6");
    expect(marker).toContain("w20");
  });
});
