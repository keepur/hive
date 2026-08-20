import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyThrown, TurnAssemblyError } from "./error-classification.js";
import { REFRESH_THRESHOLD_MS, resetGrokOAuthStateForTests, resolveOAuthFileToken } from "./grok-oauth.js";

/** Fixed clock — every expiry in these tests is relative to it. */
const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const now = () => NOW;

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

let dir: string;

function writeAuthFile(overrides: Record<string, unknown> = {}, entryKey = "https://auth.x.ai::client-abc"): string {
  const path = join(dir, "auth.json");
  const entry = {
    key: "old-access-token",
    refresh_token: "old-refresh-token",
    expires_at: new Date(NOW + 6 * 60 * 60 * 1000).toISOString(),
    auth_mode: "oidc",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "client-abc",
    email: "operator@example.com",
    team_id: "team-1",
    coding_data_retention_opt_out: true,
    ...overrides,
  };
  writeFileSync(path, JSON.stringify({ [entryKey]: entry }, null, 2), { mode: 0o600 });
  return path;
}

function readEntry(path: string): Record<string, unknown> {
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
  return file[Object.keys(file)[0]];
}

interface GrantOverrides {
  status?: number;
  body?: unknown;
  onTokenRequest?: () => void;
}

/** Routes discovery vs. token-endpoint calls; counts each. */
function makeFetch(overrides: GrantOverrides = {}) {
  const calls = { discovery: 0, token: 0 };
  const impl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href === DISCOVERY_URL) {
      calls.discovery += 1;
      return new Response(JSON.stringify({ token_endpoint: TOKEN_URL }), { status: 200 });
    }
    if (href === TOKEN_URL) {
      calls.token += 1;
      overrides.onTokenRequest?.();
      const status = overrides.status ?? 200;
      const body =
        overrides.body ??
        ({ access_token: "new-access-token", refresh_token: "rotated-refresh-token", expires_in: 21600 } as unknown);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }
    throw new Error(`unexpected fetch to ${href}`);
  });
  return { impl: impl as unknown as typeof fetch, calls, mock: impl };
}

beforeEach(() => {
  resetGrokOAuthStateForTests();
  dir = mkdtempSync(join(tmpdir(), "grok-oauth-"));
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("hot path — a comfortably-valid token costs no network (KPR-371 §D3 step 2)", () => {
  it("returns the on-disk access token without any fetch", async () => {
    const path = writeAuthFile();
    const { impl, mock } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).resolves.toBe("old-access-token");
    expect(mock).not.toHaveBeenCalled();
  });

  it("parses the CLI's microsecond-precision ISO expiry", async () => {
    // The real file writes e.g. 2026-08-17T05:29:50.226517Z — six fractional
    // digits. A parser that rejected it would refresh on every single spawn.
    const path = writeAuthFile({ expires_at: new Date(NOW + 6 * 60 * 60 * 1000).toISOString().replace("Z", "517Z") });
    const { impl, mock } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).resolves.toBe("old-access-token");
    expect(mock).not.toHaveBeenCalled();
  });

  it("a token inside the 60-minute threshold is NOT hot-pathed", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW + REFRESH_THRESHOLD_MS - 60_000).toISOString() });
    const { impl, calls } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).resolves.toBe("new-access-token");
    expect(calls.token).toBe(1);
  });
});

describe("refresh + write-back (§D3 steps 3-5)", () => {
  it("issues one grant and returns the new access token", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW + 30 * 60 * 1000).toISOString() });
    const { impl, calls } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).resolves.toBe("new-access-token");
    expect(calls.discovery).toBe(1);
    expect(calls.token).toBe(1);
  });

  it("persists the ROTATED refresh token, preserves unknown fields, and keeps mode 0600", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl } = makeFetch();
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });

    const entry = readEntry(path);
    expect(entry.key).toBe("new-access-token");
    // The old refresh token is SPENT — persisting it would break the next refresh.
    expect(entry.refresh_token).toBe("rotated-refresh-token");
    expect(entry.expires_at).toBe(new Date(NOW + 21600 * 1000).toISOString());
    // §3.6: every unknown field survives write-back untouched.
    expect(entry.email).toBe("operator@example.com");
    expect(entry.team_id).toBe("team-1");
    expect(entry.auth_mode).toBe("oidc");
    expect(entry.coding_data_retention_opt_out).toBe(true);
    expect(entry.oidc_client_id).toBe("client-abc");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keys off the FIRST entry rather than a hardcoded name, and preserves that key", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() }, "https://auth.x.ai::other-client");
    const { impl } = makeFetch();
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(file)).toEqual(["https://auth.x.ai::other-client"]);
  });

  it("keeps the prior refresh token when the grant omits a rotated one", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl } = makeFetch({ body: { access_token: "new-access-token", expires_in: 21600 } });
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });
    expect(readEntry(path).refresh_token).toBe("old-refresh-token");
  });

  it("caches OIDC discovery per process — two refreshes, one discovery round-trip", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    // expires_in of 60s lands the written-back token back inside the threshold,
    // so the second call refreshes again.
    const { impl, calls } = makeFetch({
      body: { access_token: "new-access-token", refresh_token: "rotated-refresh-token", expires_in: 60 },
    });
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });
    expect(calls.token).toBe(2);
    expect(calls.discovery).toBe(1);
  });
});

describe("single flight (§D3) — concurrent spawns must never race the rotation grant", () => {
  it("N concurrent resolutions issue exactly ONE grant and all observe the refreshed value", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl, calls } = makeFetch();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveOAuthFileToken(path, { fetchImpl: impl, now })),
    );

    // Two grants would spend each other's refresh token and hard-break the credential.
    expect(calls.token).toBe(1);
    expect(results).toEqual(Array.from({ length: 5 }, () => "new-access-token"));
    expect(readEntry(path).refresh_token).toBe("rotated-refresh-token");
  });

  it("releases the flight so a later expiry refreshes again", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl, calls } = makeFetch({
      body: { access_token: "new-access-token", refresh_token: "rotated-refresh-token", expires_in: 60 },
    });
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });
    await resolveOAuthFileToken(path, { fetchImpl: impl, now });
    expect(calls.token).toBe(2);
  });
});

describe("failure modes (§D3) — all breaker-invisible, each with its own remediation", () => {
  it("missing file → TurnAssemblyError naming `grok login`", async () => {
    const { impl } = makeFetch();
    const call = () => resolveOAuthFileToken(join(dir, "nope.json"), { fetchImpl: impl, now });
    await expect(call()).rejects.toThrow(TurnAssemblyError);
    await expect(call()).rejects.toThrow(/absent or unreadable/);
    await expect(call()).rejects.toThrow(/run `grok login`/);
  });

  it("unparseable file → TurnAssemblyError naming invalid JSON", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const { impl } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).rejects.toThrow(/not valid JSON/);
  });

  it("empty credential object → TurnAssemblyError naming the missing entry", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, "{}", { mode: 0o600 });
    const { impl } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).rejects.toThrow(/carries no credential entry/);
  });

  it("entry missing refresh/client/issuer → TurnAssemblyError, no grant attempted", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString(), refresh_token: undefined });
    const { impl, calls } = makeFetch();
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).rejects.toThrow(
      /missing refresh\/client\/issuer/,
    );
    expect(calls.token).toBe(0);
  });

  it("rejected grant with nothing fresher on disk → distinct message directing to `grok login`", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl } = makeFetch({ status: 400, body: { error: "invalid_grant" } });
    const call = () => resolveOAuthFileToken(path, { fetchImpl: impl, now });
    await expect(call()).rejects.toThrow(/refresh was rejected \(authentication\) \[400\]/);
    await expect(call()).rejects.toThrow(/run `grok login`/);
  });

  it("rejected grant BUT another process already refreshed → re-reads once and proceeds", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl } = makeFetch({
      status: 400,
      body: { error: "invalid_grant" },
      // Simulate the interactive CLI (or a second hive instance) winning the
      // rotation between our read and our grant.
      onTokenRequest: () => {
        writeAuthFile({
          key: "someone-elses-fresh-token",
          refresh_token: "someone-elses-refresh",
          expires_at: new Date(NOW + 6 * 60 * 60 * 1000).toISOString(),
        });
      },
    });
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).resolves.toBe("someone-elses-fresh-token");
  });

  it("network failure with a still-valid token → warns and proceeds with it", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW + 30 * 60 * 1000).toISOString() });
    const failing = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await expect(resolveOAuthFileToken(path, { fetchImpl: failing, now })).resolves.toBe("old-access-token");
  });

  it("network failure with an EXPIRED token → distinct message that must NOT say `grok login`", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const failing = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const call = () => resolveOAuthFileToken(path, { fetchImpl: failing, now });
    await expect(call()).rejects.toThrow(/auth\.x\.ai connectivity failure/);
    // Misdirection guard: an auth-server blip must not send the operator to
    // re-run a login that is not the problem.
    await expect(call()).rejects.not.toThrow(/grok login/);
  });

  it("write-back failure → distinct message, surfaced at the moment the file went stale", async () => {
    const path = writeAuthFile({ expires_at: new Date(NOW - 1000).toISOString() });
    const { impl } = makeFetch();
    chmodSync(dir, 0o500); // owner cannot create the temp file
    await expect(resolveOAuthFileToken(path, { fetchImpl: impl, now })).rejects.toThrow(/write-back to .* failed/);
  });
});

describe("breaker invisibility (§D3)", () => {
  it("the typed wrapper — not the message — short-circuits to non-provider", async () => {
    const { impl } = makeFetch();
    let thrown: unknown;
    try {
      await resolveOAuthFileToken(join(dir, "nope.json"), { fetchImpl: impl, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAssemblyError);
    expect(classifyThrown(thrown)).toMatchObject({ outcome: "fault", kind: "non-provider" });
    // Control: the SAME message as a plain Error matches the auth row, proving
    // the instanceof short-circuit is load-bearing.
    expect(classifyThrown(new Error((thrown as Error).message))).toMatchObject({ outcome: "fault", kind: "auth" });
  });
});
