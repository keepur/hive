import { describe, it, expect, vi, afterEach } from "vitest";
import { preflightBotScopes, REQUIRED_BOT_SCOPES } from "./slack-scope-preflight.js";

const warnSpy = vi.fn();
const infoSpy = vi.fn();

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => infoSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeResponse(body: object, scopeHeader?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (scopeHeader !== undefined) {
    headers["x-oauth-scopes"] = scopeHeader;
  }
  return new Response(JSON.stringify(body), { headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  warnSpy.mockClear();
  infoSpy.mockClear();
});

describe("preflightBotScopes", () => {
  it("resolves and logs info when all required scopes are present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, REQUIRED_BOT_SCOPES.join(","))));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      "Slack scope preflight passed",
      expect.objectContaining({ required: expect.any(Array) }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves when granted scopes include extra scopes beyond the required set", async () => {
    const allScopes = [...REQUIRED_BOT_SCOPES, "reactions:read", "files:read"].join(",");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, allScopes)));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT require chat:write.public — least-privilege default for Hive", async () => {
    expect(REQUIRED_BOT_SCOPES).not.toContain("chat:write.public");
    // Sanity: the kept scopes are still strict enough to surface a token without chat:write
    const partial = "chat:write.customize,channels:history,channels:read,users:read";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, partial)));
    await preflightBotScopes("xoxb-token");
    expect(warnSpy).toHaveBeenCalledWith(
      "Slack bot token missing recommended scopes — some features may degrade silently",
      expect.objectContaining({ missing: ["chat:write"] }),
    );
  });

  it("WARNS instead of throwing when scopes are missing — hive must not crash for an optional Slack feature", async () => {
    // Provide only a subset; the rest should appear in the warn payload
    const partial = "chat:write,channels:history";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, partial)));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Slack bot token missing recommended scopes — some features may degrade silently",
      expect.objectContaining({
        missing: expect.arrayContaining(["chat:write.customize", "channels:read", "users:read"]),
      }),
    );
    // Scopes that were granted should NOT appear in the missing list
    const callPayload = warnSpy.mock.calls[0][1] as { missing: string[] };
    expect(callPayload.missing).not.toContain("channels:history");
    expect(callPayload.missing).not.toContain("chat:write");
  });

  it("WARNS instead of throwing when body.ok is false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: false, error: "invalid_auth" }, "chat:write")));
    await expect(preflightBotScopes("xoxb-bad-token")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("Slack auth.test failed — skipping scope preflight", {
      error: "invalid_auth",
    });
  });

  it("WARNS with 'unknown' error when body.ok is false and no error field is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: false }, "chat:write")));
    await preflightBotScopes("xoxb-bad-token");
    expect(warnSpy).toHaveBeenCalledWith("Slack auth.test failed — skipping scope preflight", { error: "unknown" });
  });

  it("warns (does not throw) when x-oauth-scopes header is absent — every required scope flagged as missing", async () => {
    // No scopeHeader arg → header is not set at all
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true })));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    const callPayload = warnSpy.mock.calls[0][1] as { missing: string[] };
    for (const scope of REQUIRED_BOT_SCOPES) {
      expect(callPayload.missing).toContain(scope);
    }
  });

  it("warns when x-oauth-scopes header is empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, "")));
    await preflightBotScopes("xoxb-token");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("accepts a custom required list and only checks those scopes", async () => {
    const custom = ["chat:write", "channels:read"] as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, "chat:write,channels:read")));
    await expect(preflightBotScopes("xoxb-token", custom)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("trims whitespace from scope header entries", async () => {
    const spacedScopes = REQUIRED_BOT_SCOPES.map((s) => `  ${s}  `).join(",");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, spacedScopes)));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
