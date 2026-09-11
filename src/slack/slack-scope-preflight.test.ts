import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { preflightBotScopes, PREFLIGHT_TIMEOUT_MS, REQUIRED_BOT_SCOPES } from "./slack-scope-preflight.js";

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
      expect.objectContaining({ missing: ["chat:write", "im:write", "users:read.email"] }),
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

describe("REQUIRED_BOT_SCOPES (KPR-492 D4)", () => {
  it("carries im:write and users:read.email", () => {
    expect(REQUIRED_BOT_SCOPES).toContain("im:write");
    expect(REQUIRED_BOT_SCOPES).toContain("users:read.email");
  });

  it("still does NOT carry im:history — the manifest grants it, the engine does not depend on it (§3, §5.3)", () => {
    expect(REQUIRED_BOT_SCOPES).not.toContain("im:history");
  });
});

describe("setup/slack-manifest.yaml ⊇ REQUIRED_BOT_SCOPES (KPR-492 D11 drift guard)", () => {
  it("every scope the engine declares is granted by the manifest every fresh install pastes", () => {
    // The real file, not a fixture — resolved relative to THIS test, never cwd.
    // Fails at 46d3d9d (users:read.email absent); passes after the D11 edit.
    // Negative-verify (i) in Task 11 reverts that one line and expects this red.
    const manifestPath = fileURLToPath(new URL("../../setup/slack-manifest.yaml", import.meta.url));
    const manifest = parseYaml(readFileSync(manifestPath, "utf8")) as {
      oauth_config?: { scopes?: { bot?: string[] } };
    };
    const granted = manifest.oauth_config?.scopes?.bot ?? [];
    expect(granted.length).toBeGreaterThan(0); // a parse that yields nothing must not pass vacuously
    for (const scope of REQUIRED_BOT_SCOPES) {
      expect(granted, `manifest bot: block is missing ${scope}`).toContain(scope);
    }
  });
});

describe("preflightBotScopes — transport guard (KPR-492 D10)", () => {
  it("warns and resolves when fetch REJECTS (the crash-loop guard)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND slack.com")));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Slack auth.test unreachable — skipping scope preflight",
      expect.objectContaining({ error: expect.stringContaining("ENOTFOUND") }),
    );
  });

  it("warns and resolves when the body is not JSON (the second bare await)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 })));
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Slack auth.test unreachable — skipping scope preflight",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("bounds a fetch that never settles: the TimeoutError lands in the same catch (the hang guard)", async () => {
    // Driven through D10's `timeoutMs` seam with a REAL 20 ms bound — not fake
    // timers: AbortSignal.timeout() schedules on Node's internal timer machinery
    // and makes zero calls to globalThis.setTimeout, so vi.useFakeTimers() can
    // never advance it (round-5 spec reviewer, Node 26.7.0). And not a spy on
    // AbortSignal.timeout either — the seam is the version-independent form.
    //
    // The mock settles ONLY on abort. That is the discriminator: with the signal
    // removed from the implementation (negative-verify (d)), nothing ever aborts,
    // the promise never settles, and this test fails by vitest's 10 s testTimeout.
    // A mock that resolved on its own would pass against the unguarded code.
    let seenSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        seenSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
        });
      }),
    );

    await expect(preflightBotScopes("xoxb-token", REQUIRED_BOT_SCOPES, 20)).resolves.toBeUndefined();
    // Present — a mock that never inspects the signal proves nothing.
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    // Fired, and fired for the right reason.
    expect(seenSignal?.aborted).toBe(true);
    expect((seenSignal?.reason as DOMException).name).toBe("TimeoutError");
    // …and landed in the SAME catch as the rejecting-fetch case above.
    expect(warnSpy).toHaveBeenCalledWith(
      "Slack auth.test unreachable — skipping scope preflight",
      expect.objectContaining({ error: expect.stringContaining("TimeoutError") }),
    );
  });

  it("the one-argument production call still passes a signal, bounded by PREFLIGHT_TIMEOUT_MS = 10 s", async () => {
    // The seam test above exercises the three-argument form. This pins that the
    // default path index.ts actually uses is bounded too (an implementation that
    // attached the signal only when timeoutMs was passed would pass the test
    // above and hang boot), and that the production constant is the spec's 10 s.
    expect(PREFLIGHT_TIMEOUT_MS).toBe(10_000);
    let seenSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        seenSignal = init?.signal;
        return Promise.resolve(makeResponse({ ok: true }, REQUIRED_BOT_SCOPES.join(",")));
      }),
    );
    await expect(preflightBotScopes("xoxb-token")).resolves.toBeUndefined();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
