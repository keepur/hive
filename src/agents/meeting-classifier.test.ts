import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateForTask, mockHasProvider, mockWarn } = vi.hoisted(() => ({
  mockGenerateForTask: vi.fn(),
  mockHasProvider: vi.fn(() => true),
  mockWarn: vi.fn(),
}));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../config.js", () => ({
  config: { modelRouter: { model: "claude-haiku-4-5-20251001", timeoutMs: 4000 } },
}));

vi.mock("../llm/registry.js", () => ({
  getLLMRegistry: () => ({
    generateForTask: mockGenerateForTask,
    hasProvider: mockHasProvider,
  }),
}));

import {
  classifyMeetingMessage,
  parseClassifierOutput,
  __resetMeetingClassifierStateForTests,
  type RosterMember,
} from "./meeting-classifier.js";

describe("parseClassifierOutput", () => {
  const validIds = new Set(["jasper", "river", "jessica"]);

  it("parses valid JSON response", () => {
    const result = parseClassifierOutput(
      '{ "respond": ["jasper", "river"] }',
      validIds,
    );
    expect(result).toEqual(["jasper", "river"]);
  });

  it("extracts JSON from surrounding text", () => {
    const result = parseClassifierOutput(
      'Here is my answer: { "respond": ["jasper"] } hope that helps',
      validIds,
    );
    expect(result).toEqual(["jasper"]);
  });

  it("filters out invalid agent IDs", () => {
    const result = parseClassifierOutput(
      '{ "respond": ["jasper", "nonexistent"] }',
      validIds,
    );
    expect(result).toEqual(["jasper"]);
  });

  it("returns null for unparseable text", () => {
    const result = parseClassifierOutput(
      "I think jasper should respond",
      validIds,
    );
    expect(result).toBeNull();
  });

  it("returns null for empty text", () => {
    const result = parseClassifierOutput("", validIds);
    expect(result).toBeNull();
  });

  it("handles respond field that is not an array", () => {
    const result = parseClassifierOutput('{ "respond": "jasper" }', validIds);
    expect(result).toBeNull();
  });

  it("returns empty array when all IDs are invalid", () => {
    const result = parseClassifierOutput(
      '{ "respond": ["nonexistent"] }',
      validIds,
    );
    expect(result).toEqual([]);
  });
});

describe("classifyMeetingMessage (KPR-314 — registry transport)", () => {
  const roster: RosterMember[] = [
    { agentId: "jasper", name: "Jasper", role: "VP Engineering" },
    { agentId: "river", name: "River", role: "Marketing Manager" },
    { agentId: "jessica", name: "Jessica", role: "Customer Success" },
  ];

  function makeResult(overrides: Record<string, unknown> = {}) {
    return {
      text: '{"respond":["jasper"]}',
      parsed: { respond: ["jasper"] },
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic" as const,
      durationMs: 9,
      usage: { inputTokens: 400, outputTokens: 12 },
      costUsd: 0.00046,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasProvider.mockReturnValue(true);
    __resetMeetingClassifierStateForTests();
    mockGenerateForTask.mockResolvedValue(makeResult());
  });

  it("happy path: parsed respond list honored, cost/duration passed through", async () => {
    const r = await classifyMeetingMessage("jasper, thoughts?", roster);
    expect(r).toEqual({ respondAgentIds: ["jasper"], costUsd: 0.00046, durationMs: 9 });
  });

  it("request shape: meetingClassifier task, schema, 256 tokens, temp 0, borrowed router timeout", async () => {
    await classifyMeetingMessage("hello all", roster, "recent context");
    const [task, req] = mockGenerateForTask.mock.calls[0]!;
    expect(task).toBe("meetingClassifier");
    expect(req.jsonSchema).toBeDefined();
    expect(req.maxOutputTokens).toBe(256);
    expect(req.temperature).toBe(0);
    expect(req.timeoutMs).toBe(4000);
    expect(req.prompt).toContain("jasper (Jasper");
    expect(req.prompt).toContain("Recent thread context:\nrecent context");
    expect(req.systemPrompt).toContain("meeting facilitator");
    expect(req.systemPrompt).not.toContain("Respond with ONLY a JSON object");
  });

  it("id-allowlist filter still applies over parsed output (belt-and-braces)", async () => {
    mockGenerateForTask.mockResolvedValueOnce(
      makeResult({ parsed: { respond: ["jasper", "not-a-real-agent"] } }),
    );
    const r = await classifyMeetingMessage("q", roster);
    expect(r.respondAgentIds).toEqual(["jasper"]);
  });

  it("no parsed output: falls back to brace-scanning the text", async () => {
    mockGenerateForTask.mockResolvedValueOnce(
      makeResult({ parsed: undefined, text: 'Sure! { "respond": ["river"] } hope that helps' }),
    );
    const r = await classifyMeetingMessage("q", roster);
    expect(r.respondAgentIds).toEqual(["river"]);
  });

  it("registry throw → all-roster with costUsd 0 (today's failure path)", async () => {
    mockGenerateForTask.mockRejectedValueOnce(new Error("timeout"));
    const r = await classifyMeetingMessage("q", roster);
    expect(new Set(r.respondAgentIds)).toEqual(new Set(["jasper", "river", "jessica"]));
    expect(r.costUsd).toBe(0);
  });

  it("parse failure → all-roster, but the call's real cost is kept", async () => {
    mockGenerateForTask.mockResolvedValueOnce(
      makeResult({ parsed: undefined, text: "no json here at all" }),
    );
    const r = await classifyMeetingMessage("q", roster);
    expect(new Set(r.respondAgentIds)).toEqual(new Set(["jasper", "river", "jessica"]));
    expect(r.costUsd).toBe(0.00046);
  });

  it("no-key: all-roster via pre-check — generateForTask NEVER called, warn fired once across calls", async () => {
    mockHasProvider.mockReturnValue(false);
    const r1 = await classifyMeetingMessage("q", roster);
    const r2 = await classifyMeetingMessage("q again", roster);
    expect(new Set(r1.respondAgentIds)).toEqual(new Set(["jasper", "river", "jessica"]));
    expect(r2.respondAgentIds.length).toBe(3);
    expect(mockGenerateForTask).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("roster 0/1 short-circuits never touch the registry", async () => {
    expect(await classifyMeetingMessage("q", [])).toEqual({
      respondAgentIds: [],
      costUsd: 0,
      durationMs: 0,
    });
    expect(await classifyMeetingMessage("q", [roster[0]])).toEqual({
      respondAgentIds: ["jasper"],
      costUsd: 0,
      durationMs: 0,
    });
    expect(mockGenerateForTask).not.toHaveBeenCalled();
    expect(mockHasProvider).not.toHaveBeenCalled();
  });
});
