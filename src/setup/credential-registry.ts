/**
 * Curated registry of third-party MCP credentials that the bootstrap wizard
 * collects (KPR-73). Both the wizard stage and the `hive credentials` CLI
 * consume this — single source of truth, no drift.
 *
 * Keys map 1:1 to env-var lookups in `src/config.ts` (`optional("KEY", ...)`)
 * which already falls back through env → Honeypot Keychain → fallback. So
 * seeding a value into Honeypot under `hive/<instanceId>/<KEY>` is sufficient
 * for the runtime to pick it up — no other engine wiring needed.
 */

export type CredentialEntryKind = "secret" | "oauth";

export interface CredentialField {
  /** Honeypot key name (matches `optional("KEY", ...)` lookups in src/config.ts). */
  key: string;
  /** Prompt label shown to the operator (e.g. "Linear API Key"). */
  label: string;
  /**
   * When false, prompt input is shown un-masked (e.g. for non-secret fields
   * like FROM addresses). Defaults to true (treat as secret).
   */
  secret?: boolean;
}

export interface CredentialEntry {
  /** MCP server name (matches keys in `SERVER_CATALOG` for core servers, plugin server name for plugins). */
  server: string;
  /** Human-friendly title for the wizard prompt. */
  title: string;
  /** One-line description shown above the prompt. */
  description: string;
  /** Where the operator gets the key. */
  helpUrl: string;
  /** Either a static API key/token (`secret`) or an OAuth flow we can't automate (`oauth`). */
  kind: CredentialEntryKind;
  /** For kind=secret: one or more fields to collect. For kind=oauth: empty (instructions only). */
  fields: CredentialField[];
  /** OAuth-only: instructions printed instead of a prompt. */
  oauthInstructions?: string;
}

export const CREDENTIAL_REGISTRY: CredentialEntry[] = [
  {
    server: "brave-search",
    title: "Brave Search",
    description: "Web search via the Brave Search API (free tier available).",
    helpUrl: "https://api.search.brave.com/",
    kind: "secret",
    fields: [{ key: "BRAVE_API_KEY", label: "Brave API Key" }],
  },
  {
    server: "linear",
    title: "Linear",
    description: "Issue tracking and project management.",
    helpUrl: "https://linear.app/settings/api",
    kind: "secret",
    fields: [{ key: "LINEAR_API_KEY", label: "Linear Personal API Key" }],
  },
  {
    server: "github-issues",
    title: "GitHub",
    description: "GitHub issue tracking (gh CLI / personal access token).",
    helpUrl: "https://github.com/settings/tokens",
    kind: "secret",
    fields: [{ key: "GH_TOKEN", label: "GitHub Personal Access Token" }],
  },
  {
    server: "clickup",
    title: "ClickUp",
    description: "ClickUp task management.",
    helpUrl: "https://app.clickup.com/settings/apps",
    kind: "secret",
    fields: [{ key: "CLICKUP_API_TOKEN", label: "ClickUp API Token" }],
  },
  {
    server: "quo",
    title: "Quo (OpenPhone) SMS",
    description: "Send and receive SMS via OpenPhone / Quo.",
    helpUrl: "https://www.openphone.com/ (Settings → API)",
    kind: "secret",
    fields: [{ key: "QUO_API_KEY", label: "Quo API Key" }],
  },
  {
    server: "voice",
    title: "Vapi (Voice)",
    description: "Outbound phone calls via Vapi.ai.",
    helpUrl: "https://dashboard.vapi.ai/account/api-keys",
    kind: "secret",
    fields: [{ key: "VAPI_API_KEY", label: "Vapi API Key" }],
  },
  {
    server: "recall",
    title: "Recall.ai",
    description: "Meeting bot — join calls, get transcripts.",
    helpUrl: "https://www.recall.ai/ (Dashboard → API Keys)",
    kind: "secret",
    fields: [{ key: "RECALL_API_KEY", label: "Recall API Key" }],
  },
  {
    server: "resend",
    title: "Resend (Email)",
    description: "Send outbound email with attachments.",
    helpUrl: "https://resend.com/api-keys",
    kind: "secret",
    fields: [{ key: "RESEND_API_KEY", label: "Resend API Key" }],
  },
  {
    server: "gemini",
    title: "Gemini (Image OCR)",
    description: "Google Gemini API for image OCR / vision (used by file ingestion).",
    helpUrl: "https://aistudio.google.com/apikey",
    kind: "secret",
    fields: [{ key: "GEMINI_API_KEY", label: "Gemini API Key" }],
  },
  {
    server: "google",
    title: "Google (Gmail / Calendar / Drive)",
    description: "Gmail, Calendar, and Drive access. Uses OAuth via the gog CLI — not a static API key.",
    helpUrl: "https://github.com/keepur/gog",
    kind: "oauth",
    fields: [],
    oauthInstructions:
      "Google access uses OAuth, not an API key. After setup, run `gog auth add <your-account@gmail.com>` " +
      "to authenticate one or more accounts, then assign them in hive.yaml under " +
      "`google.accounts.<agent-id>` — a string for a single account, a list for multi-account agents " +
      "(first entry is the default).",
  },
];

export function findCredentialEntry(server: string): CredentialEntry | undefined {
  return CREDENTIAL_REGISTRY.find((e) => e.server === server);
}

export function findCredentialEntryByKey(key: string): CredentialEntry | undefined {
  return CREDENTIAL_REGISTRY.find((e) => e.fields.some((f) => f.key === key));
}

/** All collectable secret keys across the registry — used by `hive credentials list/add/remove`. */
export function allCredentialKeys(): string[] {
  return CREDENTIAL_REGISTRY.flatMap((e) => e.fields.map((f) => f.key));
}
