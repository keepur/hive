// src/channels/voice/conversation-prompt.test.ts
import { describe, it, expect } from "vitest";
import { renderConversationPrompt } from "./conversation-prompt.js";

describe("renderConversationPrompt", () => {
  it("filters out system messages", () => {
    const out = renderConversationPrompt([
      { role: "system", content: "you are an assistant" },
      { role: "user", content: "hi" },
    ]);
    expect(out).not.toContain("you are an assistant");
    expect(out).toContain("Caller: hi");
  });

  it("labels speakers as Caller and You", () => {
    const out = renderConversationPrompt([
      { role: "user", content: "hello?" },
      { role: "assistant", content: "hey there" },
      { role: "user", content: "who is this" },
    ]);
    expect(out).toContain("Caller: hello?");
    expect(out).toContain("You: hey there");
    expect(out).toContain("Caller: who is this");
  });

  it("ends with a respond-to-latest instruction", () => {
    const out = renderConversationPrompt([{ role: "user", content: "hi" }]);
    expect(out.toLowerCase()).toContain("respond to the caller");
  });

  it("handles empty / system-only conversations with a greet prompt", () => {
    expect(renderConversationPrompt([])).toMatch(/greet|connected/i);
    expect(renderConversationPrompt([{ role: "system", content: "x" }])).toMatch(/greet|connected/i);
  });

  it("skips tool messages without throwing", () => {
    const out = renderConversationPrompt([
      { role: "user", content: "what's my balance" },
      { role: "tool", content: "balance: $42" } as any,
      { role: "assistant", content: "you have $42" },
    ]);
    expect(out).not.toContain("balance: $42");
    expect(out).toContain("Caller: what's my balance");
    expect(out).toContain("You: you have $42");
  });
});
