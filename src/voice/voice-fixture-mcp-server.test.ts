import { describe, it, expect, vi } from "vitest";
import {
  clampFixtureDelay,
  buildFixtureResult,
  createVoiceFixtureMcpServer,
  VOICE_FIXTURE_DEFAULT_DELAY_MS,
  VOICE_FIXTURE_MAX_DELAY_MS,
} from "./voice-fixture-mcp-server.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("clampFixtureDelay (spec §7 / §11)", () => {
  it("defaults, clamps over-cap, floors, and never errors", () => {
    expect(clampFixtureDelay(undefined)).toBe(VOICE_FIXTURE_DEFAULT_DELAY_MS);
    expect(clampFixtureDelay(NaN)).toBe(VOICE_FIXTURE_DEFAULT_DELAY_MS);
    expect(clampFixtureDelay(99999)).toBe(VOICE_FIXTURE_MAX_DELAY_MS);
    expect(clampFixtureDelay(-5)).toBe(0);
    expect(clampFixtureDelay(1500.9)).toBe(1500);
  });
});

describe("buildFixtureResult (spec §6.2 orders_get template)", () => {
  it("is byte-stable with the default PO", () => {
    expect(buildFixtureResult()).toBe(
      "PO 45021 · Acme Hardware · Open\n" +
        "Ordered: Aug 1, 2026 · Promised: Aug 28, 2026 · Last receipt: Aug 12, 2026\n" +
        "Ship to: shop\n" +
        "Lines:\n" +
        "- 12 maple doors — 8 received, 4 open\n" +
        "- 6 drawer boxes — 0 received, 6 open\n" +
        "Notes: vendor quoted late Friday",
    );
  });
  it("echoes a caller-stated PO number without changing the data", () => {
    const out = buildFixtureResult("77-104");
    expect(out.startsWith("PO 77-104 · Acme Hardware · Open")).toBe(true);
    expect(out).toContain("maple doors");
  });
});

describe("createVoiceFixtureMcpServer", () => {
  it("constructs an in-process SDK server named voice-fixture", () => {
    const server = createVoiceFixtureMcpServer();
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("voice-fixture");
  });
});
