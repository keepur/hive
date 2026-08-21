import { describe, expect, it } from "vitest";
import { serializeTranscript } from "./chat-ctx.js";

describe("serializeTranscript (KPR-322)", () => {
  it("preserves the full transcript in order every turn", () => {
    expect(
      serializeTranscript([
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
        { role: "user", text: "more" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "more" },
    ]);
  });

  it("drops empty and whitespace-only turns", () => {
    expect(
      serializeTranscript([
        { role: "user", text: "  " },
        { role: "assistant", text: "" },
        { role: "user", text: "keep" },
        { role: "assistant", text: "\n\t" },
      ]),
    ).toEqual([{ role: "user", content: "keep" }]);
  });

  it("never emits a system role (engine owns the prompt)", () => {
    const msgs = serializeTranscript([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
    expect(msgs.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    expect(msgs.some((m) => (m as { role: string }).role === "system")).toBe(false);
  });
});
