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
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
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
    const onDiskToken = stringField(entry, "key");
    if (expiresAtMs !== null && expiresAtMs > now() && onDiskToken) {
      log.warn("Grok OAuth refresh failed transiently — proceeding with the still-valid on-disk token", {
        path,
        error: errorMessage(err),
        expiresAt: entry.expires_at,
      });
      return onDiskToken;
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
