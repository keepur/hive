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

import { classifyClaimDedup, type OpenClaimSummary } from "./worker-claim-dedup.js";

const OPEN: OpenClaimSummary[] = [
  { claimId: "claim-a", taskText: "pull Q3 revenue from the CRM" },
  { claimId: "claim-b", taskText: "check the shipping ETA for order 8812" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockHasProvider.mockReturnValue(true);
});

describe("classifyClaimDedup (KPR-390 §A2 — fail-open by construction)", () => {
  it("short-circuits with no open claims and never calls the sidecar", async () => {
    const verdict = await classifyClaimDedup("anything", []);
    expect(verdict).toEqual({ duplicateOfClaimId: null, costUsd: 0 });
    expect(mockGenerateForTask).not.toHaveBeenCalled();
  });

  it("fails open when the anthropic provider is not constructed (pre-check)", async () => {
    mockHasProvider.mockReturnValue(false);
    const verdict = await classifyClaimDedup("pull Q3 revenue", OPEN);
    expect(verdict).toEqual({ duplicateOfClaimId: null, costUsd: 0 });
    expect(mockGenerateForTask).not.toHaveBeenCalled();
  });

  it("pins the sidecar request shape", async () => {
    mockGenerateForTask.mockResolvedValue({ text: "{}", parsed: { duplicateOf: null } });
    await classifyClaimDedup("pull Q3 revenue", OPEN);
    expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
    const [task, req] = mockGenerateForTask.mock.calls[0];
    expect(task).toBe("workerClaimDedup");
    expect(req.jsonSchema).toBeDefined();
    expect(req.maxOutputTokens).toBe(128);
    expect(req.temperature).toBe(0);
    expect(req.timeoutMs).toBe(4000);
    expect(req.systemPrompt).toContain("duplicateOf");
    expect(req.prompt).toContain("[claim-a]");
    expect(req.prompt).toContain("NEW task:");
  });

  it("returns the duplicate id and passes costUsd through", async () => {
    mockGenerateForTask.mockResolvedValue({
      text: '{"duplicateOf":"claim-b"}',
      parsed: { duplicateOf: "claim-b" },
      costUsd: 0.00042,
    });
    const verdict = await classifyClaimDedup("what is the ETA on order 8812?", OPEN);
    expect(verdict).toEqual({ duplicateOfClaimId: "claim-b", costUsd: 0.00042 });
  });

  it("returns null for an explicit non-duplicate verdict", async () => {
    mockGenerateForTask.mockResolvedValue({ text: '{"duplicateOf":null}', parsed: { duplicateOf: null } });
    const verdict = await classifyClaimDedup("draft the follow-up email", OPEN);
    expect(verdict.duplicateOfClaimId).toBeNull();
  });

  it("fails open when the model returns an id that is not an open claim", async () => {
    mockGenerateForTask.mockResolvedValue({ text: "{}", parsed: { duplicateOf: "claim-zzz" }, costUsd: 0.0001 });
    const verdict = await classifyClaimDedup("pull Q3 revenue", OPEN);
    expect(verdict.duplicateOfClaimId).toBeNull();
    expect(verdict.costUsd).toBe(0.0001);
  });

  it("fails open and warns when the sidecar call rejects", async () => {
    mockGenerateForTask.mockRejectedValue(new Error("provider unavailable"));
    const verdict = await classifyClaimDedup("pull Q3 revenue", OPEN);
    expect(verdict).toEqual({ duplicateOfClaimId: null, costUsd: 0 });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(String(mockWarn.mock.calls[0][0])).toContain("fail-open");
  });

  it("falls back to parsing text, and fails open on unparsable text", async () => {
    mockGenerateForTask.mockResolvedValue({ text: '{"duplicateOf":"claim-a"}', costUsd: 0 });
    expect((await classifyClaimDedup("revenue for Q3", OPEN)).duplicateOfClaimId).toBe("claim-a");

    mockGenerateForTask.mockResolvedValue({ text: "sure, that looks like a dupe", costUsd: 0 });
    expect((await classifyClaimDedup("revenue for Q3", OPEN)).duplicateOfClaimId).toBeNull();
  });

  it("compares at most 10 open claims", async () => {
    mockGenerateForTask.mockResolvedValue({ text: "{}", parsed: { duplicateOf: null } });
    const many: OpenClaimSummary[] = Array.from({ length: 14 }, (_, i) => ({
      claimId: `claim-${i}`,
      taskText: `task number ${i}`,
    }));
    await classifyClaimDedup("a new task", many);
    const { prompt } = mockGenerateForTask.mock.calls[0][1];
    expect(prompt).toContain("[claim-9]");
    expect(prompt).not.toContain("[claim-10]");
    expect(prompt.match(/^- \[claim-/gm)).toHaveLength(10);
  });

  it("ignores a duplicate id that only matches a claim beyond the 10-claim window", async () => {
    mockGenerateForTask.mockResolvedValue({ text: "{}", parsed: { duplicateOf: "claim-12" } });
    const many: OpenClaimSummary[] = Array.from({ length: 14 }, (_, i) => ({
      claimId: `claim-${i}`,
      taskText: `task number ${i}`,
    }));
    const verdict = await classifyClaimDedup("a new task", many);
    expect(verdict.duplicateOfClaimId).toBeNull();
  });
});
