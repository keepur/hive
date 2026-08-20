# KPR-371 — Grok (xAI) via Lane A passthrough — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** An operator sets an agent's `model` to `grok/grok-4.6`, sends SIGUSR1, and that agent runs on xAI's Anthropic-compatible endpoint through the existing Lane A passthrough — full hive runtime — authenticated by the machine's `grok login` session, with its own circuit breaker and outage queue.

**Architecture:** Grok joins `LaneAProviderId` / `AgentProviderId` as a third passthrough row. The single structural change is the credential source: `PassthroughProviderDef.authTokenKey: string` becomes a discriminated `credential` field (`env-key` for kimi/deepseek — byte-for-byte the current logic; `oauth-file` for grok). The `oauth-file` branch lives in a new self-contained module (`grok-oauth.ts`) that reads `~/.grok/auth.json`, refreshes a near-expiry token via a public-client OIDC grant under a per-path single-flight guard, and atomically writes the rotated pair back. No new execution path: the resolved token pins into `ANTHROPIC_AUTH_TOKEN` exactly as kimi's key does.

**Tech Stack:** TypeScript (strict), Node 22+, vitest, `node:fs` + global `fetch`, existing `TurnAssemblyError` classification.

**Spec:** [kpr-371-spec.md](./kpr-371-spec.md) — §D1–D7 are the normative source; every task below cites the section it implements.

**Baseline:** branch `kpr-371` @ `aaf5402`, rebased onto `origin/main` @ `3bbeeb1` (v0.11.3). All spec line references re-verified against this baseline and still hold.

---

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/agents/provider-adapters/grok-oauth.ts`, `src/agents/provider-adapters/passthrough-providers.ts`, `src/agents/provider-adapters/types.ts`
  - Reason: The OAuth refresh path is new, security-sensitive (it rewrites the operator's live credential file), and has five distinct failure modes with distinct operator-facing remediations. The table/predicate changes carry the spec's highest-risk silent-failure surface (`isLaneAProvider`).
  - Minimum assertions: table shape incl. the `credential` discriminant; `isLaneAProvider("grok") === true` asserted directly; model-resolution chain (route → configured → default); `buildPassthroughEnv` exact 11-key pin record for grok; unexpired token returns with **zero** network calls; near-expiry token triggers exactly one grant + write-back; write-back preserves unknown fields, persists the **rotated** refresh token, and leaves mode 0600; single-flight — N concurrent resolutions issue exactly one grant and all observe the refreshed value; missing file, unparseable file, rejected grant, network failure with an expired token, and write-back failure each raise `TurnAssemblyError`; a rejected grant re-reads once and succeeds when another process refreshed first; a network failure with a still-valid on-disk token warns and proceeds; the network-failure message is distinct from the `grok login` message.

- Integration: `required`
  - Scope: `AgentManager` spawn path — `src/agents/agent-manager.test.ts`
  - Reason: The four touch points the compiler cannot enforce (spec §D1) fail silently. Only a spawn-level test proves the route reaches `ClaudeAgentAdapter` with a `laneAPassthrough` bag rather than a Claude call with a garbage model id.
  - Harness: `existing` — the KPR-346 kimi block at `agent-manager.test.ts:3210-3360` is the direct template.
  - Minimum assertions: `providerFor("grok/grok-4.6") === "grok"`; a grok turn constructs `AgentRunner` with the `laneAPassthrough` bag and never calls `buildProviderPrompt` (no Lane B assembly); model default fallback (`grok/` → `grok-4.6`); `GROK_AGENT_MODEL` config override; a missing credential never trips the grok breaker; three hard faults open the **grok** breaker only, leaving claude and kimi closed; a session-handoff onto a grok turn uses the **CLAUDE** notice variant.

- E2E: `not-required` (see rationale) — replaced by the operator-run live validation in Task 7.

### Critical Flows

- Cold spawn with a valid unexpired token → turn runs, no network call to `auth.x.ai`.
- Cold spawn with a near-expiry/expired token → refresh grant → atomic write-back → turn runs → **the `grok` CLI still authenticates afterwards**.
- Concurrent spawns across threads on an expiring token → one grant, one write-back, no credential corruption.
- Missing/absent credential → `TurnAssemblyError` naming `grok login`, breaker untouched, turn surfaces the config fault.
- Three consecutive grok provider faults → grok breaker opens, claude and kimi agents keep running.

### Regression Surface

- kimi and deepseek spawns (the `env-key` branch must be behaviourally identical after the discriminant refactor).
- `resolvePassthroughSpawn` becoming `async` — its only production call site is `agent-manager.ts:572`, inside the already-async `createProviderAdapter`.
- `SESSION_SEMANTICS` exhaustiveness pins in `types.test.ts` and the fail-closed pin in `session-store.test.ts`.
- `credential-registry.test.ts` — must stay green with **no** grok entry (spec §D6 ruling).

### Commands

- Unit: `npx vitest run src/agents/provider-adapters/`
- Integration: `npx vitest run src/agents/agent-manager.test.ts`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- No live network in unit tests: `grok-oauth.ts` must expose a `fetchImpl` seam and a `now()` seam; filesystem tests use a `mkdtempSync` scratch dir, never the operator's real `~/.grok/auth.json`.
- Task 7 live validation only: a `grok login` session on the machine (present — `grok 1.0.4`, `~/.grok/auth.json` @ 0600, single entry keyed `https://auth.x.ai::<client_id>`).

### Non-Required Rationale

- E2E: hive has no automated end-to-end channel harness; the equivalent evidence is the operator-run live validation matrix in Task 7 (real spawn on a real subscription token, including the refresh path), which is how every prior provider child in KPR-345 was validated.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify** (house rule) the two credential-integrity tests — rotation persistence and single-flight: revert the source fix and confirm each test fails on pre-fix code before claiming them.

---

## File Structure

**Create**
- `src/agents/provider-adapters/grok-oauth.ts` — the entire `oauth-file` credential source: read, expiry check, single-flight OIDC refresh, atomic write-back, typed failure modes. Zero knowledge of Lane A, spawns, or agents.
- `src/agents/provider-adapters/grok-oauth.test.ts` — unit tests for the above.

**Modify**
- `src/agents/provider-adapters/types.ts` — `AgentProviderId` union member; `SESSION_SEMANTICS.grok`.
- `src/agents/provider-adapters/passthrough-providers.ts` — `LaneAProviderId`; `PassthroughCredential` discriminant; table row; `isLaneAProvider` body; `resolvePassthroughSpawn` → async + credential branch.
- `src/agents/agent-manager.ts` — route union arm (`:184`), prefix arm (`:204-209`), passthrough gate (`:571`), adapter gate (`:587`), `await` on the resolver.
- `src/agents/agent-runner.ts:310` — comment-only: the Lane A route list.
- `src/config.ts` — `grok: { agentModel: optional("GROK_AGENT_MODEL", "") }`.
- `src/agents/provider-adapters/passthrough-providers.test.ts` — async migration + grok coverage.
- `src/agents/provider-adapters/types.test.ts` — six → seven provider ids.
- `src/agents/agent-manager.test.ts` — `appConfig` mock gains `grok`; new grok integration block.
- `docs/providers.md` — new `grok (Lane A)` column across all 17 rows + footnotes + History.
- `docs/architecture.md` — two Lane A sentences.
- `CLAUDE.md` — Lane A sentence in "Provider adapters".

**Explicitly NOT modified** (spec §D6 ruling): `src/setup/credential-registry.ts` — Grok has no paste-a-secret flow; the remediation surface is the `TurnAssemblyError` message. No new `hive doctor` check.

---

### Task 1: Credential discriminant refactor (kimi/deepseek only — zero behaviour change)

Spec §D2. Pure shape change so Task 3 lands purely additively. `resolvePassthroughSpawn` also becomes `async` here — it is the same mechanical ripple through the same call site and test file, and doing it once keeps the grok commit readable.

**Files:**
- Modify: `src/agents/provider-adapters/passthrough-providers.ts`
- Modify: `src/agents/agent-manager.ts:572`
- Test: `src/agents/provider-adapters/passthrough-providers.test.ts`

- [ ] **Step 1:** Replace `authTokenKey` with the discriminated `credential` field.

In `passthrough-providers.ts`, above `PassthroughProviderDef`:

```typescript
/**
 * KPR-371 (§D2): Lane A credential source. `authTokenKey: string` hardwired
 * "static key from env or Honeypot"; Grok authenticates with a subscription
 * OAuth token in a vendor-CLI-owned file that expires every 6h and whose
 * refresh token rotates on use. The discriminant keeps the kimi/deepseek
 * branch byte-for-byte unchanged while giving grok its own resolution path.
 */
export type PassthroughCredential =
  | { kind: "env-key"; key: string }
  | { kind: "oauth-file"; path: string };
```

Replace the `authTokenKey` member of `PassthroughProviderDef`:

```typescript
  /**
   * Credential source — resolved PER SPAWN, never boot-time.
   *  - env-key:    env → Keychain (Honeypot `hive/<instanceId>/<KEY>`).
   *  - oauth-file: vendor-CLI-owned OAuth file, refreshed + written back.
   */
  credential: PassthroughCredential;
```

Update both table rows:

```typescript
    credential: { kind: "env-key", key: "KIMI_API_KEY" },
```
```typescript
    credential: { kind: "env-key", key: "DEEPSEEK_API_KEY" },
```

- [ ] **Step 2:** Make `resolvePassthroughSpawn` async and route through a credential branch. Replace the function body (keep the existing doc comment, appending a `KPR-371` note):

```typescript
export async function resolvePassthroughSpawn(
  provider: LaneAProviderId,
  routeModel: string,
  opts: {
    /** appConfig.<provider>.agentModel — non-secret, boot-time config. */
    configuredModel: string;
    instanceId: string;
    /** Test seam only; defaults to env → Keychain. */
    resolveSecret?: (instanceId: string, key: string) => string;
    /** Test seam only (oauth-file providers); defaults to global fetch. */
    fetchImpl?: typeof fetch;
    /** Test seam only (oauth-file providers); defaults to Date.now. */
    now?: () => number;
  },
): Promise<PassthroughSpawnConfig> {
  const def = PASSTHROUGH_PROVIDERS[provider];
  const authToken =
    def.credential.kind === "env-key"
      ? resolveEnvKeyCredential(def.credential.key, opts)
      : await resolveOAuthFileToken(def.credential.path, { fetchImpl: opts.fetchImpl, now: opts.now });
  return {
    provider,
    model: routeModel || opts.configuredModel || def.defaultModel,
    baseUrl: def.baseUrl,
    authToken,
  };
}

function resolveEnvKeyCredential(
  key: string,
  opts: { instanceId: string; resolveSecret?: (instanceId: string, key: string) => string },
): string {
  const resolve =
    opts.resolveSecret ?? ((instanceId: string, k: string) => process.env[k] || fromKeychain(instanceId, k));
  const authToken = resolve(opts.instanceId, key);
  if (!authToken) {
    throw new TurnAssemblyError(
      `Passthrough credential missing (authentication): ${key} — seed it via \`hive credentials add ${key}\``,
    );
  }
  return authToken;
}
```

Add the import at the top of the file:

```typescript
import { resolveOAuthFileToken } from "./grok-oauth.js";
```

`resolveOAuthFileToken` does not exist until Task 2, so **do Task 2's Step 1 before this step** — then the tree compiles at every commit boundary and no stub is needed.

- [ ] **Step 3:** `await` the resolver at the single production call site, `src/agents/agent-manager.ts:572`:

```typescript
      laneAPassthrough = await resolvePassthroughSpawn(route.provider, route.model, {
```

- [ ] **Step 4:** Migrate the existing tests. In `passthrough-providers.test.ts`:

Table assertions — replace `authTokenKey: "KIMI_API_KEY",` with `credential: { kind: "env-key", key: "KIMI_API_KEY" },` (and the deepseek equivalent).

Every `resolvePassthroughSpawn(...)` call becomes `await resolvePassthroughSpawn(...)` inside an `async` test body. The three throw assertions become rejection assertions:

```typescript
    it("both empty → rejects with TurnAssemblyError naming the key and the remediation", async () => {
      mockFromKeychain.mockReturnValue("");
      const call = () => resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" });
      await expect(call()).rejects.toThrow(TurnAssemblyError);
      await expect(call()).rejects.toThrow(/Passthrough credential missing \(authentication\): KIMI_API_KEY/);
      await expect(call()).rejects.toThrow(/hive credentials add/);
    });
```

And the breaker-invisibility test's `try/catch` becomes:

```typescript
    let thrown: unknown;
    try {
      await resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst", resolveSecret: () => "" });
    } catch (err) {
      thrown = err;
    }
```

- [ ] **Step 5:** Verify

Run: `npx vitest run src/agents/provider-adapters/passthrough-providers.test.ts`
Expected: all existing tests pass, zero behavioural assertions changed (only shape + await).

Run: `npm run typecheck`
Expected: clean — no unhandled-promise or missing-await errors at `agent-manager.ts:572`.

- [ ] **Step 6:** Commit

```bash
git add src/agents/provider-adapters/passthrough-providers.ts src/agents/provider-adapters/passthrough-providers.test.ts src/agents/agent-manager.ts
git commit -m "refactor(providers): discriminated Lane A credential source + async resolver (KPR-371 §D2)"
```

---

### Task 2: `grok-oauth.ts` — the oauth-file credential source

Spec §D3. Self-contained: filesystem + OIDC only, no agent/spawn knowledge.

**Files:**
- Create: `src/agents/provider-adapters/grok-oauth.ts`
- Test: `src/agents/provider-adapters/grok-oauth.test.ts`

- [ ] **Step 1:** Create `src/agents/provider-adapters/grok-oauth.ts`:

```typescript
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../../logging/logger.js";
import { TurnAssemblyError } from "./error-classification.js";

const log = createLogger("grok-oauth");

/**
 * KPR-371 (§D3): resolve a Lane A access token from a vendor-CLI-owned OAuth
 * file (`~/.grok/auth.json`). The access token's TTL is 6h and the refresh
 * grant ROTATES the refresh token — spending the old one — so hive must
 * write the new pair back or it signs the operator's `grok` CLI out.
 *
 * Every failure raises TurnAssemblyError, which classifyThrown short-circuits
 * to `non-provider`: a credential fault is a config fault and must never count
 * toward the grok breaker's trip streak (§D3, matching the kimi contract).
 */

/** Refresh when less than this remains on the token (§D3 step 2). Sized well
 *  above any normal channel turn so mid-turn expiry cannot occur for turns
 *  shorter than an hour — the accepted residual is documented in §D3. */
export const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface OAuthFileEntry {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  /** §3.6: unknown fields MUST survive write-back untouched. */
  [field: string]: unknown;
}

export interface OAuthFileTokenOptions {
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to Date.now. */
  now?: () => number;
  refreshThresholdMs?: number;
  timeoutMs?: number;
}

/** Non-2xx from the token endpoint — distinct from a transport failure,
 *  because only this case means the refresh token itself is spent. */
class GrantRejectedError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`token endpoint returned ${status}`);
    this.name = "GrantRejectedError";
  }
}

/** Per-process OIDC discovery cache — refresh costs one round-trip, not two. */
const discoveryCache = new Map<string, string>();

/**
 * Per-credential-path single flight (§D3). The spawn budget defaults to 5 and
 * threads run in parallel; two spawns racing the rotation grant would spend
 * each other's refresh token and HARD-BREAK the credential. Losers await the
 * winner's promise and observe the refreshed value — they never issue a grant.
 */
const inFlightRefresh = new Map<string, Promise<string>>();

/** Test seam — reset per-process caches between cases. */
export function resetGrokOAuthStateForTests(): void {
  discoveryCache.clear();
  inFlightRefresh.clear();
}

export async function resolveOAuthFileToken(rawPath: string, opts: OAuthFileTokenOptions = {}): Promise<string> {
  const path = expandHome(rawPath);
  const now = opts.now ?? Date.now;
  const threshold = opts.refreshThresholdMs ?? REFRESH_THRESHOLD_MS;

  // Hot path: a comfortably-valid token costs one file read and no network.
  const { entry } = readCredentialFile(path);
  const expiresAtMs = parseExpiry(entry.expires_at);
  if (expiresAtMs !== null && expiresAtMs - now() > threshold) {
    return requireAccessToken(entry, path);
  }

  const existing = inFlightRefresh.get(path);
  if (existing) return existing;
  const flight = refreshCredential(path, opts).finally(() => inFlightRefresh.delete(path));
  inFlightRefresh.set(path, flight);
  return flight;
}

async function refreshCredential(path: string, opts: OAuthFileTokenOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  const threshold = opts.refreshThresholdMs ?? REFRESH_THRESHOLD_MS;

  // Re-read inside the flight: a caller that queued while ANOTHER PROCESS
  // (the interactive CLI, a second hive instance) refreshed sees the fresh
  // value here and skips the grant entirely.
  const { file, entryKey, entry } = readCredentialFile(path);
  const expiresAtMs = parseExpiry(entry.expires_at);
  if (expiresAtMs !== null && expiresAtMs - now() > threshold) {
    return requireAccessToken(entry, path);
  }

  const refreshToken = stringField(entry, "refresh_token");
  const clientId = stringField(entry, "oidc_client_id");
  const issuer = stringField(entry, "oidc_issuer");
  if (!refreshToken || !clientId || !issuer) {
    throw new TurnAssemblyError(missingCredentialMessage(path, "the entry is missing refresh/client/issuer fields"));
  }

  let grant: TokenGrant;
  try {
    const tokenEndpoint = await discoverTokenEndpoint(issuer, opts);
    grant = await requestRefreshGrant(tokenEndpoint, clientId, refreshToken, opts);
  } catch (err) {
    if (err instanceof GrantRejectedError) {
      // §D3: a rejected grant most often means someone else legitimately
      // refreshed first and rotated the token out from under us. Re-read once
      // before declaring the credential dead.
      const fresh = rereadUsableToken(path, now());
      if (fresh) {
        log.warn("Grok OAuth grant rejected, but a fresh token was found on disk — another process refreshed first", {
          path,
          status: err.status,
        });
        return fresh;
      }
      throw new TurnAssemblyError(
        `Grok OAuth refresh was rejected (authentication) [${err.status}] — the refresh token is spent or revoked; run \`grok login\` to sign in again`,
      );
    }
    // Transport/timeout. If the on-disk token is inside the threshold but not
    // yet dead, it still works — grounding every turn during an auth.x.ai blip
    // while holding a usable credential would be strictly worse (§D3).
    if (expiresAtMs !== null && expiresAtMs > now() && stringField(entry, "key")) {
      log.warn("Grok OAuth refresh failed transiently — proceeding with the still-valid on-disk token", {
        path,
        error: errorMessage(err),
        expiresAt: entry.expires_at,
      });
      return stringField(entry, "key");
    }
    throw new TurnAssemblyError(
      `Grok OAuth refresh could not reach the xAI auth server (${errorMessage(err)}) and the on-disk token has expired — this is an auth.x.ai connectivity failure, not a sign-in problem; retry shortly`,
    );
  }

  try {
    writeBack(path, file, entryKey, entry, grant, now());
  } catch (err) {
    // The grant already spent the old refresh token, so proceeding would just
    // defer the break. Fail HERE, where it is attributable (§D3).
    throw new TurnAssemblyError(
      `Grok OAuth token refreshed but write-back to ${path} failed (${errorMessage(err)}) — the previous refresh token is now spent; run \`grok login\` if the next turn also fails`,
    );
  }
  log.info("Grok OAuth token refreshed and written back", { path, expiresInSec: grant.expiresInSec ?? null });
  return grant.accessToken;
}

interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
}

async function discoverTokenEndpoint(issuer: string, opts: OAuthFileTokenOptions): Promise<string> {
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const cached = discoveryCache.get(normalizedIssuer);
  if (cached) return cached;
  const res = await fetchWithTimeout(`${normalizedIssuer}/.well-known/openid-configuration`, { method: "GET" }, opts);
  if (!res.ok) throw new Error(`OIDC discovery returned ${res.status}`);
  const doc = (await res.json()) as { token_endpoint?: unknown };
  if (typeof doc.token_endpoint !== "string" || !doc.token_endpoint) {
    throw new Error("OIDC discovery document carries no token_endpoint");
  }
  discoveryCache.set(normalizedIssuer, doc.token_endpoint);
  return doc.token_endpoint;
}

async function requestRefreshGrant(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  opts: OAuthFileTokenOptions,
): Promise<TokenGrant> {
  // Public-client refresh: token_endpoint_auth_methods_supported includes
  // "none", so client_id + refresh_token is the whole grant (§3.4).
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  const res = await fetchWithTimeout(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    },
    opts,
  );
  const text = await res.text();
  if (!res.ok) throw new GrantRejectedError(res.status, text.slice(0, 200));
  let parsed: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new GrantRejectedError(res.status, "grant response was not JSON");
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new GrantRejectedError(res.status, "grant response carried no access_token");
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    expiresInSec: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined,
  };
}

function writeBack(
  path: string,
  file: Record<string, OAuthFileEntry>,
  entryKey: string,
  entry: OAuthFileEntry,
  grant: TokenGrant,
  nowMs: number,
): void {
  if (grant.expiresInSec === undefined) {
    log.warn("Grok OAuth grant omitted expires_in — recording the token as immediately due for refresh", { path });
  }
  // Spread-first: every unknown field (profile, team, retention flags) survives.
  const updated: OAuthFileEntry = {
    ...entry,
    key: grant.accessToken,
    refresh_token: grant.refreshToken ?? entry.refresh_token,
    expires_at: new Date(nowMs + (grant.expiresInSec ?? 0) * 1000).toISOString(),
  };
  const next: Record<string, OAuthFileEntry> = { ...file, [entryKey]: updated };
  const tmp = join(dirname(path), `.auth.json.hive-${process.pid}-${nowMs}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path); // atomic replace within the same directory
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function readCredentialFile(path: string): {
  file: Record<string, OAuthFileEntry>;
  entryKey: string;
  entry: OAuthFileEntry;
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new TurnAssemblyError(missingCredentialMessage(path, "the file is absent or unreadable"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TurnAssemblyError(missingCredentialMessage(path, "the file is not valid JSON"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TurnAssemblyError(missingCredentialMessage(path, "the file is not a credential object"));
  }
  const file = parsed as Record<string, OAuthFileEntry>;
  // §3.6: a single top-level entry keyed `<issuer>::<client_id>`. Key off the
  // FIRST entry — never a hardcoded string, which would break on re-login.
  const entryKey = Object.keys(file)[0];
  const entry = entryKey ? file[entryKey] : undefined;
  if (!entryKey || !entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TurnAssemblyError(missingCredentialMessage(path, "the file carries no credential entry"));
  }
  return { file, entryKey, entry };
}

function rereadUsableToken(path: string, nowMs: number): string {
  try {
    const { entry } = readCredentialFile(path);
    const expiresAtMs = parseExpiry(entry.expires_at);
    if (expiresAtMs !== null && expiresAtMs > nowMs) return stringField(entry, "key");
  } catch {
    /* fall through to the caller's hard failure */
  }
  return "";
}

function requireAccessToken(entry: OAuthFileEntry, path: string): string {
  const token = stringField(entry, "key");
  if (!token) throw new TurnAssemblyError(missingCredentialMessage(path, "the entry carries no access token"));
  return token;
}

/** ISO-8601 Z with microsecond precision, as the CLI writes it. */
function parseExpiry(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function stringField(entry: OAuthFileEntry, field: string): string {
  const value = entry[field];
  return typeof value === "string" ? value : "";
}

function missingCredentialMessage(path: string, reason: string): string {
  return `Grok OAuth credential unavailable (authentication) at ${path} — ${reason}; run \`grok login\` to sign in`;
}

async function fetchWithTimeout(url: string, init: RequestInit, opts: OAuthFileTokenOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  return doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) });
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 2:** Create `src/agents/provider-adapters/grok-oauth.test.ts`. Use a real scratch directory (`mkdtempSync(join(tmpdir(), "grok-oauth-"))`), never the operator's `~/.grok`. Fixture helper:

```typescript
function writeAuthFile(dir: string, overrides: Record<string, unknown> = {}): string {
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
    ...overrides,
  };
  writeFileSync(path, JSON.stringify({ "https://auth.x.ai::client-abc": entry }, null, 2), { mode: 0o600 });
  return path;
}
```

Required cases (each `resetGrokOAuthStateForTests()` in `beforeEach`):

1. **Hot path, no network.** `expires_at` = NOW + 6h → returns `"old-access-token"`; `fetchImpl` mock never called.
2. **Microsecond ISO parses.** `expires_at: "2026-08-17T05:29:50.226517Z"` (the real CLI format) with `now` pinned before it → hot path, no fetch.
3. **Near-expiry triggers a grant.** `expires_at` = NOW + 30min (inside the 60min threshold) → discovery + token fetch called once each; returns the new access token.
4. **Write-back persists the rotated pair and preserves unknown fields.** After (3), re-read the file: `key` = new access token, `refresh_token` = the **rotated** value (never the old one), `expires_at` ≈ NOW + `expires_in`, and `email`/`team_id`/`auth_mode` survive verbatim. Assert `statSync(path).mode & 0o777 === 0o600`. Assert the top-level entry key is unchanged. **← negative-verify this one.**
5. **Single flight.** `expires_at` in the past; fire 5 concurrent `resolveOAuthFileToken` calls; assert the token-endpoint mock was called **exactly once** and all 5 resolve to the same new token. **← negative-verify this one.**
6. **Discovery cached.** Two sequential refreshes → discovery fetched once, token endpoint twice.
7. **Missing file** → rejects `TurnAssemblyError` matching `/run `grok login`/`.
8. **Unparseable file** → same class, message names invalid JSON.
9. **Empty credential object** (`{}`) → rejects with the no-entry message.
10. **Rejected grant, nothing fresher on disk** → 400 from the token endpoint → rejects with `/refresh was rejected \(authentication\) \[400\]/` and `/grok login/`.
11. **Rejected grant, another process already refreshed** → the token-endpoint mock rewrites the file with a fresh unexpired entry *before* returning 400 → resolves with the on-disk token, no throw.
12. **Network failure, token still valid** → `fetchImpl` rejects; `expires_at` = NOW + 30min → resolves with `"old-access-token"` and logs a warning.
13. **Network failure, token expired** → `fetchImpl` rejects; `expires_at` in the past → rejects with a message matching `/auth.x.ai connectivity failure/` and **not** matching `/grok login/` (assert both — this is the misdirection guard).
14. **Write-back failure** → make the directory read-only (`chmodSync(dir, 0o500)`) after a successful grant → rejects with `/write-back to .* failed/`; restore the mode in `afterEach`.
15. **Breaker invisibility** → `classifyThrown(caught)` is `{ outcome: "fault", kind: "non-provider" }` for the missing-file case, while `classifyThrown(new Error(sameMessage))` is `{ kind: "auth" }` — the same control the kimi test uses to prove the typed wrapper is load-bearing.

- [ ] **Step 3:** Verify

Run: `npx vitest run src/agents/provider-adapters/grok-oauth.test.ts`
Expected: 15+ passing, zero real network calls (no `fetch` without `fetchImpl`).

- [ ] **Step 4:** Negative-verify cases 4 and 5 (house rule). For 4: temporarily change `writeBack` to omit `refresh_token: grant.refreshToken ?? entry.refresh_token` (leave the old token) — case 4 must fail. For 5: temporarily delete the `inFlightRefresh` map usage in `resolveOAuthFileToken` — case 5 must fail with a call count of 5. Restore both; record the observed failure output in the ticket.

- [ ] **Step 5:** Commit

```bash
git add src/agents/provider-adapters/grok-oauth.ts src/agents/provider-adapters/grok-oauth.test.ts
git commit -m "feat(providers): grok OAuth credential source — single-flight refresh + atomic write-back (KPR-371 §D3)"
```

---

### Task 3: Grok joins the Lane A table

Spec §D1. Four of these five edits are compile-forced; `isLaneAProvider` is not, and is the spec's flagged highest-risk omission.

**Files:**
- Modify: `src/agents/provider-adapters/types.ts:4`, `:69-83`
- Modify: `src/agents/provider-adapters/passthrough-providers.ts`
- Test: `src/agents/provider-adapters/passthrough-providers.test.ts`, `src/agents/provider-adapters/types.test.ts`

- [ ] **Step 1:** `types.ts` — union member and session semantics.

```typescript
export type AgentProviderId = "claude" | "openai" | "gemini" | "codex" | "kimi" | "deepseek" | "grok";
```

In `SESSION_SEMANTICS`, after `deepseek`:

```typescript
  // KPR-371 (§D1): Lane A — same client-transcript semantics as kimi/deepseek.
  grok: "client-transcript",
```

Also extend the Lane A mention in the `LaneBProviderId` doc comment to read `(kimi/deepseek/grok — Lane A)`.

- [ ] **Step 2:** `passthrough-providers.ts` — union, table row, predicate.

```typescript
export type LaneAProviderId = "kimi" | "deepseek" | "grok";
```

Table row (after `deepseek`):

```typescript
  grok: {
    id: "grok",
    displayName: "Grok (xAI)",
    baseUrl: "https://api.x.ai",
    // KPR-371 (§D2/§R5): subscription OAuth, shared with the `grok` CLI.
    // Hive reads AND writes this file — the refresh token rotates on use.
    credential: { kind: "oauth-file", path: "~/.grok/auth.json" },
    // §3.5: the subscription session exposes only grok-4.6 / grok-4.5; the
    // API's wider catalogue is not reachable under this auth.
    defaultModel: "grok-4.6",
  },
```

**The high-risk edit** — `isLaneAProvider`'s hand-written body:

```typescript
export function isLaneAProvider(p: AgentProviderId): p is LaneAProviderId {
  return p === "kimi" || p === "deepseek" || p === "grok";
}
```

Miss this and there is **no compile error and no runtime error**: `agent-manager.ts:1663` degrades the session-handoff notice to the Lane B variant and `:1674` silently drops `:effort` instead of clamping it (spec §D1).

- [ ] **Step 3:** Extend the `PASSTHROUGH_PROVIDERS` doc comment's "adding the next compat vendor is…" list to mention the credential discriminant, so the next vendor sees both shapes.

- [ ] **Step 4:** Tests.

`types.test.ts` — add `["grok", true]` to the `persistsResumableHandle` table, and change the exhaustiveness assertion to seven ids (`claude, codex, deepseek, gemini, grok, kimi, openai` — sorted).

`passthrough-providers.test.ts` — add:

```typescript
    expect(PASSTHROUGH_PROVIDERS.grok).toEqual({
      id: "grok",
      displayName: "Grok (xAI)",
      baseUrl: "https://api.x.ai",
      credential: { kind: "oauth-file", path: "~/.grok/auth.json" },
      defaultModel: "grok-4.6",
    });
```

Add `["grok", true]` to the `isLaneAProvider` table (the spec calls this out as a directly-asserted requirement, not an incidental one).

Add a grok `resolvePassthroughSpawn` describe block, mocking `./grok-oauth.js` so the table/model-chain assertions stay filesystem-free:

```typescript
vi.mock("./grok-oauth.js", () => ({ resolveOAuthFileToken: vi.fn(async () => "grok-oauth-token") }));
```

Assert: the model chain (`grok/grok-4.5` route wins → configured `GROK_AGENT_MODEL` → `grok-4.6` default); `authToken` is the OAuth-resolved value; `resolveOAuthFileToken` was called with `"~/.grok/auth.json"`; `resolveSecret` is **never** consulted for grok; and a rejection from `resolveOAuthFileToken` propagates as-is (the branch adds no wrapping).

Add a `buildPassthroughEnv` grok case asserting the exact 11-key record with `ANTHROPIC_BASE_URL: "https://api.x.ai"` and every model pin set to `grok-4.6`.

- [ ] **Step 5:** Verify

Run: `npx vitest run src/agents/provider-adapters/`
Expected: all green.

Run: `npm run typecheck`
Expected: clean — note that this is where an omitted `SESSION_SEMANTICS.grok` or route-union arm would surface.

- [ ] **Step 6:** Commit

```bash
git add src/agents/provider-adapters/
git commit -m "feat(providers): add grok to the Lane A table, union, and session semantics (KPR-371 §D1)"
```

---

### Task 4: Route wiring in `AgentManager`

Spec §D1 — the four non-compile-forced sites plus the two compile-forced ones.

**Files:**
- Modify: `src/agents/agent-manager.ts:184`, `:204-209`, `:571`, `:587`
- Modify: `src/config.ts:286-289`
- Test: `src/agents/agent-manager.test.ts`

- [ ] **Step 1:** `src/config.ts` — add after the `deepseek` block:

```typescript
  grok: {
    /** KPR-371: Lane A passthrough default-model override (non-secret).
     *  There is deliberately NO secret entry — the credential is a
     *  subscription OAuth file resolved per spawn (§D6), never a paste-able
     *  key, which is also why grok is absent from the credential registry. */
    agentModel: optional("GROK_AGENT_MODEL", ""),
  },
```

- [ ] **Step 2:** `agent-manager.ts:184` — route union arm:

```typescript
  | { provider: "kimi" | "deepseek" | "grok"; model: string; reasoningEffort?: CodexReasoningEffort };
```

- [ ] **Step 3:** `agent-manager.ts` — prefix arm, after the `deepseek` arm:

```typescript
  if (provider === "grok") {
    return { provider: "grok", model: providerModel, reasoningEffort };
  }
```

- [ ] **Step 4:** `agent-manager.ts:571` and `:587` — both gates:

```typescript
    if (route.provider === "kimi" || route.provider === "deepseek" || route.provider === "grok") {
```

Omitting `:571` yields a `ClaudeAgentAdapter` with no passthrough env — a grok model id sent to Anthropic's endpoint. Omitting `:587` is a compile error (the route narrows into `assembleProviderTurn`, typed `LaneBProviderId`), so it cannot silently pass.

- [ ] **Step 5:** Comment-only accuracy edit — `src/agents/agent-runner.ts:310` currently reads "Set by AgentManager.createProviderAdapter for kimi/deepseek routes". Update it to name all three Lane A routes. No code change; the runner takes the config opaquely.

- [ ] **Step 6:** `agent-manager.test.ts` — add `grok: { agentModel: "" }` to the `appConfig` mock at `:62`, then add a grok block modelled on the KPR-346 kimi block at `:3210-3360`. Mock `./provider-adapters/grok-oauth.js` at the module level so no filesystem or network is touched:

```typescript
vi.mock("./provider-adapters/grok-oauth.js", () => ({
  resolveOAuthFileToken: vi.fn(async () => "test-grok-oauth-token"),
}));
```

Cases (mirroring T1/T3/T6/T7 from the kimi block):
- `providerFor("agent-grok")` → `"grok"` for `model: "grok/grok-4.6"`; `grock/grok-5` still falls back to `"claude"` (pre-existing behaviour, spec follow-up #3 — pin it so the follow-up has a baseline).
- A grok turn constructs `AgentRunner` with `laneAPassthrough` = `{ provider: "grok", model: "grok-4.6", baseUrl: "https://api.x.ai", authToken: "test-grok-oauth-token" }` and `buildProviderPrompt` is never called.
- `model: "grok/"` → falls back to `grok-4.6`; with `appConfig.grok.agentModel = "grok-4.5"` → resolves `grok-4.5`.
- A rejecting `resolveOAuthFileToken` (`new TurnAssemblyError(...)`) leaves `circuitBreakers.stateFor("grok")` closed across three attempts, then a restored resolver produces a successful turn.
- Three hard provider faults open the **grok** breaker; a claude agent and a kimi agent on the same manager stay closed.
- A `claude`-tagged session row + a grok turn produces the **CLAUDE** handoff notice variant (this is the assertion that catches a missed `isLaneAProvider` edit).

- [ ] **Step 7:** Verify

Run: `npx vitest run src/agents/agent-manager.test.ts`
Expected: all green, including the pre-existing kimi block untouched.

- [ ] **Step 8:** Commit

```bash
git add src/agents/agent-manager.ts src/agents/agent-runner.ts src/config.ts src/agents/agent-manager.test.ts
git commit -m "feat(agents): route grok/ through the Lane A passthrough spawn path (KPR-371 §D1)"
```

---

### Task 5: Documentation

Spec §D7. The parity matrix is a hard requirement for any provider-behaviour change (`docs/providers.md` House rule, KPR-355).

**Files:**
- Modify: `docs/providers.md`
- Modify: `docs/architecture.md:25`, `:41`
- Modify: `CLAUDE.md` ("Provider adapters" section)

- [ ] **Step 1:** `docs/providers.md` — the Lane A prose paragraph gains `grok/...`, and the matrix gains a **separate** `grok (Lane A)` column (not a merge into the kimi/deepseek cell — grok's auth, model menu, and validation status all differ). Insert it immediately after the kimi/deepseek column in the header, the separator row, and all 17 body rows.

Cells that differ from the kimi/deepseek column:
- **Row 16 (Auth & credentials):** `full` — subscription OAuth [^16] — no API key in the loop.
- **Row 17 (Validation status):** the honest state at merge — `live-validated (subscription OAuth)` once Task 7's matrix passes; `live-unvalidated` if it does not. Do not write the optimistic value ahead of the evidence.
- **Row 5:** same `caveat(no server-side tools)`.
- **Rows 12:** `caveat({low,medium,high} only)` — plus a footnote-12 sentence that Grok's native `xhigh` is **not expressible** through Lane A's clamp.
- Every other row: the same value as the kimi/deepseek column ("`full` — unchanged", etc.).

- [ ] **Step 2:** Footnote edits — extend, do not duplicate:
- `[^5]`, `[^6]`, `[^10]`, `[^11]`, `[^15]` — reword "Lane A" mentions to cover three providers where they currently imply two.
- `[^12]` — add the `xhigh`-not-expressible sentence for grok.
- `[^16]` — add a Grok paragraph: subscription OAuth read from the `grok` CLI's own credential file; hive refreshes and writes the rotated pair back under a single-flight guard, so a stale credential self-heals but a revoked one requires `grok login`; the once-per-machine `grok login` prerequisite; the subscription session exposes only `grok-4.6`/`grok-4.5`; no `XAI_API_KEY` path; a missing or dead credential is a config fault that never touches the breaker; grok is deliberately absent from `hive credentials`.
- `[^15]` — Grok inherits Lane A's nominal `costUsd`. Add the open cost-attribution question from the spec (whether subscription-token traffic on `api.x.ai` bills the subscription pool or an API-credit balance) to the **Revisit triggers** list, not to a footnote as if it were settled.

- [ ] **Step 3:** History entry:

```markdown
2026-08-XX — Grok (xAI) added as a third Lane A passthrough provider (KPR-371): `grok/...` on `https://api.x.ai`, default `grok-4.6`, authenticated by the machine's `grok login` subscription OAuth session rather than an API key. Rows 16 and 17 differ from the kimi/deepseek column; every other row tracks it.
```

- [ ] **Step 4:** `docs/architecture.md` — both Lane A sentences (`:25`, `:41`) gain `grok/...`.

- [ ] **Step 5:** `CLAUDE.md` — in "Provider adapters", the Lane A passthrough paragraph gains grok: the route, the `~/.grok/auth.json` credential source (read **and write** — refresh token rotates), the `grok login` prerequisite, `GROK_AGENT_MODEL`, and the no-`hive credentials`-entry note. Also add `grok` to the first paragraph's list of `<provider>/<model>` prefixes.

- [ ] **Step 6:** Verify

Run:

```bash
awk '/^\| Capability/,/^\| 17\./ { n=gsub(/\|/,"|"); print n, $0 }' docs/providers.md | awk '{print $1}' | sort -u
```

Expected: a single number — every matrix row (header, separator, all 17 body rows) has the same cell count.

- [ ] **Step 7:** Commit

```bash
git add docs/providers.md docs/architecture.md CLAUDE.md
git commit -m "docs(providers): Grok column across the parity matrix + Lane A prose (KPR-371 §D7)"
```

---

### Task 6: Quality gate

- [ ] **Step 1:** Run the full gate:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck clean, lint clean, format check clean, full vitest suite green.

- [ ] **Step 2:** Confirm the deliberate omission is intact:

```bash
grep -rn "grok" src/setup/credential-registry.ts || echo "OK — grok deliberately absent (§D6)"
```

Expected: `OK — grok deliberately absent (§D6)`.

- [ ] **Step 3:** Confirm no test reaches the real credential file:

```bash
grep -rn "\.grok/auth\.json" src/ | grep -v "passthrough-providers.ts"
```

Expected: no test-file hits (only the table row and, if asserted, the mocked-path assertion string).

---

### Task 7: Live validation (operator-run, real subscription)

Lane A providers are validated live, not in CI. Run from a built tree against the real `grok login` session on this machine.

⚠ **Pre-state on this machine:** `~/.grok/auth.json` currently carries `expires_at: 2026-08-17T05:29:50Z` — already past. The very first resolution therefore exercises the **refresh path**, not the hot path. If the on-disk refresh token has also been spent, the expected result is the rejected-grant `TurnAssemblyError`; recovery is `grok login`. Confirm the CLI still works (`grok models`) **before** starting, and re-confirm it works **after** the first hive-driven refresh — that round trip is the core R5 acceptance criterion.

- [ ] **V1 — CLI unaffected.** `grok models` before and after the first hive spawn; both succeed, and the second run is not prompted to log in.
- [ ] **V2 — Hot path.** With a freshly refreshed token, spawn a turn and confirm no `auth.x.ai` request is made (no `grok-oauth` refresh log line).
- [ ] **V3 — Refresh path.** Hand-edit a **copy** of the credential (or wait out the TTL) so `expires_at` is inside the hour; spawn; confirm one `Grok OAuth token refreshed and written back` log line, a rotated `refresh_token` on disk, and a successful turn.
- [ ] **V4 — Full runtime parity.** On a real agent pinned to `grok/grok-4.6`: MCP tool call, skill load, memory recall, and a delegate subagent all work.
- [ ] **V5 — `:effort` clamp.** `grok/grok-4.6:xhigh` logs the Lane A clamp warning once and the turn still runs.
- [ ] **V6 — Breaker isolation.** Force three faults (e.g. temporarily point `baseUrl` at an unroutable host in a scratch build, or pull the network) and confirm `hive doctor` shows the **grok** breaker open with claude closed.
- [ ] **V7 — Cost attribution.** Record whether the turn's usage appears against the subscription pool or an API-credit balance in the xAI console — the spec's flagged unknown. Record the observation in the ticket either way; it changes no code.

Record every result in the ticket before `dodi-dev:review`.

---

## Ruled-out alternatives (do not re-litigate during implementation)

- **Read-only credential sharing** (seed the token, never write back) — signs the operator's CLI out on first refresh (§3.4). Rejected empirically.
- **Shelling the `grok` CLI to refresh** (the codex precedent in `oauth-credentials.ts`) — `grok login` exposes no refresh/token subcommand and a live `grok models` leaves `expires_at` untouched; there is no headless refresh trigger to shell (§D3).
- **Decoding the JWT `exp`** — `expires_at` in the file is authoritative and cheaper (§D3 step 2).
- **Mid-turn refresh** — would require mutating a live spawn's pinned env, which Lane A's design forbids; the 60-minute threshold plus breaker/outage self-healing is the accepted answer (§D3).
- **Hardcoding the token endpoint** — derive it from `oidc_issuer` via OIDC discovery (§D3 step 3).
- **Adding grok to `hive credentials` / a new doctor check** — §D6 ruling; filed as a follow-up.
- **A Lane B ACP adapter** — §7 follow-up, not this ticket.

## Follow-ups to file after merge (spec §7)

1. Lane B ACP adapter for Grok Build (`grok agent stdio`, JSON-RPC 2.0) — hedge if the compat endpoint closes; hive's first ACP integration.
2. Table-drive `resolveProviderModel` — its Lane A arms are hand-written string comparisons duplicating what the table and `isLaneAProvider()` already hold. Grok makes it a third.
3. Fail closed on unknown provider prefixes — `grock/grok-5` currently becomes a Claude call with a garbage model id.
4. A `hive doctor` Grok-credential line (presence + expiry), informational only per KPR-296.
