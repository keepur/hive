import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { memory: { hotBudgetTokens: 1000 } },
}));

import { buildVoiceSystemPrompt } from "./prompt-builder.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";

const fakeMemory = {
  read: vi.fn().mockResolvedValue(null),
  getHotTierPrompt: vi.fn().mockResolvedValue(null),
} as unknown as MemoryManager;

const agent = {
  id: "voice-pilot",
  soul: "You are a helpful voice agent.",
  systemPrompt: "Answer questions about orders.",
} as AgentConfig;

describe("buildVoiceSystemPrompt (KPR-324 C4 — spec §12.1 #8)", () => {
  it("contains the Voice-tools paragraph inside Voice Call Mode", async () => {
    const prompt = await buildVoiceSystemPrompt(agent, fakeMemory);
    expect(prompt).toContain("## Voice Call Mode");
    expect(prompt).toContain("You have your normal tools on this call");
    expect(prompt).toContain("do not apologize for it");
    expect(prompt).toContain("Never initiate another voice_call from a live call.");
  });

  it("still omits the toolkit dump and delegate catalog (S8)", async () => {
    const prompt = await buildVoiceSystemPrompt(agent, fakeMemory);
    expect(prompt).not.toContain("Your toolkit");
    expect(prompt).not.toContain("Delegate");
    expect(prompt).not.toContain("mcp__");
  });

  it("keeps the paragraph static (identical across calls, before goal/context)", async () => {
    const p1 = await buildVoiceSystemPrompt(agent, fakeMemory);
    const p2 = await buildVoiceSystemPrompt(agent, fakeMemory, { goal: "check PO 45021" });
    const staticEnd = p1.indexOf("Never initiate another voice_call");
    expect(p2.slice(0, staticEnd)).toBe(p1.slice(0, staticEnd));
    expect(p2.indexOf("## Call Goal")).toBeGreaterThan(p2.indexOf("Never initiate another voice_call"));
  });
});
