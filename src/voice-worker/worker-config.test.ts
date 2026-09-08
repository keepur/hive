import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {},
  resolveSecretEnv: () => "",
}));

import { livekitServerAuth } from "./worker-config.js";

describe("livekitServerAuth (KPR-322)", () => {
  it("returns wsURL, apiKey, and apiSecret from the worker config", () => {
    expect(
      livekitServerAuth({
        livekitUrl: "wss://example.livekit.cloud",
        livekitApiKey: "k",
        livekitApiSecret: "s",
      }),
    ).toEqual({
      wsURL: "wss://example.livekit.cloud",
      apiKey: "k",
      apiSecret: "s",
    });
  });

  it("keeps an empty url empty (does not invent localhost)", () => {
    expect(
      livekitServerAuth({
        livekitUrl: "",
        livekitApiKey: "k",
        livekitApiSecret: "s",
      }),
    ).toEqual({
      wsURL: "",
      apiKey: "k",
      apiSecret: "s",
    });
  });
});
