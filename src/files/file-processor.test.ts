import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { describeImage, resetVisionLlmClientForTests, setVisionLlmClient } from "./file-processor.js";
import { LLMProviderUnavailableError } from "../llm/errors.js";

describe("describeImage (KPR-314)", () => {
  beforeEach(() => {
    resetVisionLlmClientForTests();
  });

  it("uses the configured vision LLM task when available", async () => {
    const client = {
      generateForTask: vi.fn().mockResolvedValue({
        text: "image description",
        model: "gemini-2.5-flash",
        provider: "gemini",
        durationMs: 1,
      }),
    };
    setVisionLlmClient(client);

    const result = await describeImage(Buffer.from("image-bytes"), "image/png");

    expect(result).toBe("image description");
    expect(client.generateForTask).toHaveBeenCalledWith(
      "vision",
      expect.objectContaining({
        images: [{ mimeType: "image/png", dataBase64: Buffer.from("image-bytes").toString("base64") }],
        maxOutputTokens: 2048,
        temperature: 0,
        timeoutMs: 30_000,
      }),
    );
  });

  it("returns null when no vision client is configured", async () => {
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });

  it("returns null when the LLM call throws", async () => {
    const client = { generateForTask: vi.fn().mockRejectedValue(new Error("boom")) };
    setVisionLlmClient(client);
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });

  it("returns null silently on provider-unavailable (key-less steady state — byte-identical to today)", async () => {
    const client = {
      generateForTask: vi.fn().mockRejectedValue(new LLMProviderUnavailableError("gemini", "vision")),
    };
    setVisionLlmClient(client);
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });

  it("returns null on empty text", async () => {
    const client = {
      generateForTask: vi.fn().mockResolvedValue({
        text: "",
        model: "gemini-2.5-flash",
        provider: "gemini",
        durationMs: 1,
      }),
    };
    setVisionLlmClient(client);
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });
});
