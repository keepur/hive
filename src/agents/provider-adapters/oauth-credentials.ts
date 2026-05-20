import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodexOAuthOptions {
  authPath?: string;
  minTtlSeconds?: number;
  refreshCommand?: string;
  env?: NodeJS.ProcessEnv;
}

export interface GoogleVertexOAuthConfig {
  project: string;
  location: string;
}

export interface GoogleOAuthOptions {
  credentialsPath?: string;
  project?: string;
  location?: string;
  env?: NodeJS.ProcessEnv;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
  };
}

interface JwtPayload {
  exp?: number;
  aud?: string | string[];
}

const OPENAI_API_AUDIENCE = "https://api.openai.com/v1";
const DEFAULT_MIN_TTL_SECONDS = 60;
const DEFAULT_VERTEX_LOCATION = "us-central1";

export function createCodexOpenAITokenProvider(
  options: CodexOAuthOptions = {},
): (() => Promise<string>) | null {
  const authPath = options.authPath ?? defaultCodexAuthPath(options.env);
  if (!readCodexAccessToken(authPath)) return null;

  return async () => {
    const minTtlSeconds = options.minTtlSeconds ?? DEFAULT_MIN_TTL_SECONDS;
    const current = readUsableCodexOpenAIToken(authPath, minTtlSeconds);
    if (current) return current;

    refreshCodexSession(options);

    const refreshed = readUsableCodexOpenAIToken(authPath, minTtlSeconds);
    if (refreshed) return refreshed;
    throw new Error("Codex OAuth session is missing a usable OpenAI API access token");
  };
}

export function resolveGoogleVertexOAuthConfig(
  options: GoogleOAuthOptions = {},
): GoogleVertexOAuthConfig | null {
  const env = options.env ?? process.env;
  const credentialsPath = options.credentialsPath ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultGoogleAdcPath(env);
  if (!credentialsPath || !existsSync(credentialsPath)) return null;

  const project =
    options.project ??
    env.GOOGLE_CLOUD_PROJECT ??
    env.GOOGLE_PROJECT_ID ??
    env.GCLOUD_PROJECT ??
    readGoogleAdcProject(credentialsPath);
  if (!project) return null;

  const location =
    options.location ??
    env.GOOGLE_CLOUD_LOCATION ??
    env.GOOGLE_CLOUD_REGION ??
    env.GOOGLE_REGION ??
    DEFAULT_VERTEX_LOCATION;

  return { project, location };
}

export function isProviderAuthError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const maybeStatus = (error as { status?: unknown }).status;
    if (maybeStatus === 401 || maybeStatus === 403) return true;
  }
  return /401|403|auth|credential|permission|scope|unauthori[sz]ed|api key|oauth/i.test(errorMessage(error));
}

export function envValue(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[key]?.trim() ?? "";
}

function readUsableCodexOpenAIToken(authPath: string, minTtlSeconds: number): string | null {
  const token = readCodexAccessToken(authPath);
  if (!token) return null;

  const payload = decodeJwtPayload(token);
  if (!payload) return token;
  if (!hasOpenAIAudience(payload)) return null;

  if (typeof payload.exp === "number") {
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp - now <= minTtlSeconds) return null;
  }

  return token;
}

function readCodexAccessToken(authPath: string): string | null {
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthFile;
    return auth.tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const [, rawPayload] = token.split(".");
  if (!rawPayload) return null;
  try {
    const normalized = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
}

function hasOpenAIAudience(payload: JwtPayload): boolean {
  const aud = payload.aud;
  if (!aud) return true;
  return Array.isArray(aud) ? aud.includes(OPENAI_API_AUDIENCE) : aud === OPENAI_API_AUDIENCE;
}

function refreshCodexSession(options: CodexOAuthOptions): void {
  const command = options.refreshCommand ?? defaultCodexCommand();
  try {
    execFileSync(command, ["login", "status"], {
      env: options.env,
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // The caller can still fall back to API-key auth.
  }
}

function defaultCodexCommand(): string {
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  return existsSync(bundled) ? bundled : "codex";
}

function defaultCodexAuthPath(env?: NodeJS.ProcessEnv): string {
  return join(env?.HOME ?? process.env.HOME ?? "", ".codex", "auth.json");
}

function defaultGoogleAdcPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? process.env.HOME ?? "", ".config", "gcloud", "application_default_credentials.json");
}

function readGoogleAdcProject(credentialsPath: string): string {
  try {
    const adc = JSON.parse(readFileSync(credentialsPath, "utf8")) as { quota_project_id?: string; project_id?: string };
    return adc.quota_project_id ?? adc.project_id ?? "";
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
