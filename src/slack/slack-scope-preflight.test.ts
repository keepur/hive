import { describe, it, expect, vi, afterEach } from "vitest";
import { preflightBotScopes, REQUIRED_BOT_SCOPES } from "./slack-scope-preflight.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
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
  vi.restoreAllMocks();
});

describe("preflightBotScopes", () => {
  it("resolves without error when all required scopes are present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, REQUIRED_BOT_SCOPES.join(","))));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
  });

  it("resolves when granted scopes include extra scopes beyond the required set", async () => {
    const allScopes = [...REQUIRED_BOT_SCOPES, "reactions:read", "files:read"].join(",");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, allScopes)));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
  });

  it("throws listing all missing scopes in a single error when some are absent from the header", async () => {
    // Provide only a subset of the required scopes — the rest should appear in one error
    const partial = "chat:write,channels:history";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, partial)));
    const err = await preflightBotScopes("xoxb-token").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/missing required scopes:/);
    expect(msg).toContain("chat:write.public");
    expect(msg).toContain("channels:read");
    expect(msg).toContain("users:read");
    // Scopes that were granted should NOT appear in the error
    expect(msg).not.toContain("channels:history");
  });

  it("throws with the Slack error when body.ok is false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: false, error: "invalid_auth" }, "chat:write")));
    await expect(preflightBotScopes("xoxb-bad-token")).rejects.toThrow("Slack auth.test failed: invalid_auth");
  });

  it("throws with 'unknown' error when body.ok is false and no error field is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: false }, "chat:write")));
    await expect(preflightBotScopes("xoxb-bad-token")).rejects.toThrow("Slack auth.test failed: unknown");
  });

  it("fails closed when x-oauth-scopes header is absent (treats every scope as missing)", async () => {
    // No scopeHeader arg → header is not set at all
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true })));
    const err = await preflightBotScopes("xoxb-token").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/missing required scopes:/);
    // All required scopes should appear in the error message
    for (const scope of REQUIRED_BOT_SCOPES) {
      expect(msg).toContain(scope);
    }
  });

  it("fails closed when x-oauth-scopes header is empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, "")));
    await expect(preflightBotScopes("xoxb-token")).rejects.toThrow(/missing required scopes:/);
  });

  it("accepts a custom required list and only checks those scopes", async () => {
    const custom = ["chat:write", "channels:read"] as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, "chat:write,channels:read")));
    await expect(preflightBotScopes("xoxb-token", custom)).resolves.toBeUndefined();
  });

  it("trims whitespace from scope header entries", async () => {
    const spacedScopes = REQUIRED_BOT_SCOPES.map((s) => `  ${s}  `).join(",");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ ok: true }, spacedScopes)));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
  });
});
