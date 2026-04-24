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

describe("describeImage", () => {
  beforeEach(() => {
    resetVisionLlmClientForTests();
  });

  it("uses the configured vision LLM task when available", async () => {
    const client = {
      generateForTask: vi.fn().mockResolvedValue({
        text: "image description",
        model: "vision-model",
        provider: "vision-provider",
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
      }),
    );
  });

  it("returns null when no vision client is configured", async () => {
    const result = await describeImage(Buffer.from("x"), "image/png");
    expect(result).toBeNull();
  });

  it("returns null when the LLM call throws", async () => {
    const client = {
      generateForTask: vi.fn().mockRejectedValue(new Error("boom")),
    };
    setVisionLlmClient(client);
    const result = await describeImage(Buffer.from("x"), "image/png");
    expect(result).toBeNull();
  });
});
