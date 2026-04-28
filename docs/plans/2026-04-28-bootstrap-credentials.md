# Bootstrap Third-Party Credentials Implementation Plan (KPR-73)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** During `hive setup`, walk a curated list of known-useful third-party MCP integrations and seed any keys the operator provides into Honeypot under `hive/<instanceId>/<KEY>`. Skipping is first-class. Add a `hive credentials` subcommand for late-binding add/list/remove post-bootstrap.

**Architecture:** A single registry (`src/setup/credential-registry.ts`) describes the curated MCPs, their env-var keys, descriptions, help URLs, and whether they need OAuth instead. Both the wizard stage and the `hive credentials` CLI consume it — one source of truth, no drift. Keys are written via `honeypot set <KEY> <value>` (instance-scoped via the script's auto-resolved prefix). `instance-capabilities.ts` already classifies servers by credential presence — no change required there because `config.ts` reads from env → Honeypot → fallback.

**Tech stack:** TypeScript (strict), Vitest, Node `readline`, `execFileSync`-based honeypot CLI.

**Spec reference:** Linear ticket KPR-73, parent epic KPR-74.

---

## Out of scope (explicit)

- Adding new MCP servers — engine list is fine.
- Cross-instance credential migration / sharing.
- Auto-fetching from external secret managers — Honeypot is the substrate.
- Google OAuth automation — wizard prompts the operator to run `gog auth login` themselves (existing flow already does this in the integration step). Registry entry for google is type `"oauth"` with instructions.
- CoS onboarding integration with `unconfigured` tools — that's KPR-71 / KPR-77.
- Interactive `tune-instance` — KPR-72.

---

## File Map

**Create:**
- `src/setup/credential-registry.ts` — curated registry + types
- `src/setup/credential-registry.test.ts` — registry shape invariants
- `src/setup/credentials-wizard.ts` — wizard stage that walks the registry
- `src/setup/credentials-wizard.test.ts` — flow tests
- `src/cli/credentials.ts` — `hive credentials` subcommand handler
- `src/cli/credentials.test.ts` — subcommand tests

**Modify:**
- `src/setup/wizard.ts` — invoke credentials stage after Optional Integrations
- `src/cli.ts` — register `credentials` subcommand + help line
- `CLAUDE.md` — note new wizard stage + CLI subcommand (one-liner)

---

## Task 1: Curated credential registry

**Files:**
- Create: `src/setup/credential-registry.ts`
- Create: `src/setup/credential-registry.test.ts`

- [ ] **Step 1:** Define the registry types and entries.

```typescript
// src/setup/credential-registry.ts

export type CredentialEntryKind = "secret" | "oauth";

export interface CredentialField {
  /** Honeypot key name (matches src/config.ts `optional("KEY", ...)` lookups) */
  key: string;
  /** Prompt label shown to the operator (e.g. "Linear API Key") */
  label: string;
  /** When true, prompt input is masked. Defaults to true. Set false for non-secret fields like FROM addresses. */
  secret?: boolean;
}

export interface CredentialEntry {
  /** MCP server name (matches SERVER_CATALOG keys) */
  server: string;
  /** Human-friendly title for the wizard prompt */
  title: string;
  /** One-line description shown above the prompt */
  description: string;
  /** Where the operator gets the key */
  helpUrl: string;
  /** Either a static API key/token (secret) or OAuth flow (manual instructions) */
  kind: CredentialEntryKind;
  /** For kind=secret: one or more fields to collect. For kind=oauth: empty (instructions only). */
  fields: CredentialField[];
  /** OAuth-only: instructions printed instead of a prompt */
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
    description: "GitHub issue tracking via the gh CLI / personal access token.",
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
    server: "hubspot-crm",
    title: "HubSpot CRM",
    description: "HubSpot CRM read/write (private app token).",
    helpUrl: "https://app.hubspot.com/ (Settings → Integrations → Private Apps)",
    kind: "secret",
    fields: [{ key: "HUBSPOT_API_KEY", label: "HubSpot Private App Token" }],
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
      "Google access uses OAuth, not an API key. After setup, run:\n" +
      "    gog auth add <your-account@gmail.com>\n" +
      "  to authenticate one or more accounts. Then set GOOGLE_ACCOUNT in .env or hive.yaml.",
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
```

- [ ] **Step 2:** Tests verify shape invariants.

```typescript
// src/setup/credential-registry.test.ts
import { describe, it, expect } from "vitest";
import { CREDENTIAL_REGISTRY, allCredentialKeys, findCredentialEntry, findCredentialEntryByKey } from "./credential-registry.js";
import { SERVER_CATALOG } from "../tools/server-catalog.js";

describe("CREDENTIAL_REGISTRY", () => {
  it("every secret entry has at least one field", () => {
    for (const entry of CREDENTIAL_REGISTRY) {
      if (entry.kind === "secret") {
        expect(entry.fields.length, `entry for ${entry.server} has no fields`).toBeGreaterThan(0);
      }
    }
  });

  it("every oauth entry has oauthInstructions and no fields", () => {
    for (const entry of CREDENTIAL_REGISTRY) {
      if (entry.kind === "oauth") {
        expect(entry.fields).toEqual([]);
        expect(entry.oauthInstructions, `${entry.server}`).toBeTruthy();
      }
    }
  });

  it("all credential keys are unique", () => {
    const keys = allCredentialKeys();
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it("server names point at known MCP servers (or known plugin servers)", () => {
    // hubspot-crm is a plugin server (not in core SERVER_CATALOG); allow these explicitly
    const pluginServers = new Set(["hubspot-crm"]);
    for (const entry of CREDENTIAL_REGISTRY) {
      if (pluginServers.has(entry.server)) continue;
      // gemini isn't an MCP server itself but it's a known config key — allow
      if (entry.server === "gemini") continue;
      expect(SERVER_CATALOG, `${entry.server} not in catalog`).toHaveProperty(entry.server);
    }
  });

  it("findCredentialEntry resolves by server name", () => {
    expect(findCredentialEntry("brave-search")?.title).toBe("Brave Search");
    expect(findCredentialEntry("nonexistent")).toBeUndefined();
  });

  it("findCredentialEntryByKey resolves by env var", () => {
    expect(findCredentialEntryByKey("LINEAR_API_KEY")?.server).toBe("linear");
    expect(findCredentialEntryByKey("NONEXISTENT_KEY")).toBeUndefined();
  });
});
```

**Verification:**
- [ ] `npx vitest run src/setup/credential-registry.test.ts` passes
- [ ] `npm run typecheck` passes

---

## Task 2: Wizard credentials stage

**Files:**
- Create: `src/setup/credentials-wizard.ts`
- Create: `src/setup/credentials-wizard.test.ts`

- [ ] **Step 1:** Implement a stage that walks the registry. It accepts an injected `ask`/`confirm` (so tests can drive it) and an injected `setSecret(key, value)` (so tests don't actually call `honeypot`). In production, the prod implementation calls `honeypot set <KEY> <value>` via `execFileSync`.

```typescript
// src/setup/credentials-wizard.ts
import { execFileSync } from "node:child_process";
import {
  CREDENTIAL_REGISTRY,
  type CredentialEntry,
  type CredentialField,
} from "./credential-registry.js";

export interface CredentialsWizardIO {
  ask: (q: string, defaultVal?: string) => Promise<string>;
  /** Same as ask but masks the value when read from terminal. Falls back to ask in test env. */
  askSecret: (q: string) => Promise<string>;
  confirm: (q: string, defaultYes?: boolean) => Promise<boolean>;
  log: (msg: string) => void;
  setSecret: (key: string, value: string) => void;
  /** Probe whether a key is already stored. Defaults to honeypot get. */
  hasSecret: (key: string) => boolean;
}

export interface CredentialsStageResult {
  configured: string[];
  skipped: string[];
}

/** Default IO that talks to the real terminal + honeypot CLI. */
export function defaultSetSecret(key: string, value: string): void {
  execFileSync("honeypot", ["set", key, value], { stdio: ["pipe", "pipe", "pipe"] });
}

export function defaultHasSecret(key: string): boolean {
  try {
    execFileSync("honeypot", ["get", key], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** Walk the registry. Skipping is first-class — never throws on user "no". */
export async function runCredentialsStage(io: CredentialsWizardIO): Promise<CredentialsStageResult> {
  const configured: string[] = [];
  const skipped: string[] = [];

  io.log("");
  io.log("These are optional integrations. You can add any/all of them later");
  io.log("with `hive credentials add <KEY>`. Skipping is fine.");
  io.log("");

  for (const entry of CREDENTIAL_REGISTRY) {
    io.log("");
    io.log(`── ${entry.title} ─────────────────────`);
    io.log(`  ${entry.description}`);
    io.log(`  Get a key: ${entry.helpUrl}`);

    if (entry.kind === "oauth") {
      io.log("");
      io.log(`  ${entry.oauthInstructions ?? ""}`);
      const ack = await io.confirm("Continue (skip this prompt)?", true);
      if (!ack) skipped.push(entry.server);
      else skipped.push(entry.server); // OAuth is not stored here either way
      continue;
    }

    const allPresent = entry.fields.every((f) => io.hasSecret(f.key));
    if (allPresent) {
      io.log("  ✓ already configured");
      const redo = await io.confirm("Replace existing value?", false);
      if (!redo) {
        configured.push(entry.server);
        continue;
      }
    }

    const provide = await io.confirm("Provide a key now?", false);
    if (!provide) {
      skipped.push(entry.server);
      continue;
    }

    let allCollected = true;
    for (const field of entry.fields) {
      const value = field.secret === false ? await io.ask(field.label) : await io.askSecret(field.label);
      if (!value) {
        io.log(`  ⚠ Empty value for ${field.key} — skipping ${entry.server}.`);
        allCollected = false;
        break;
      }
      io.setSecret(field.key, value);
    }

    if (allCollected) {
      configured.push(entry.server);
      io.log(`  ✓ ${entry.server} stored in Honeypot`);
    } else {
      skipped.push(entry.server);
    }
  }

  io.log("");
  io.log(`── Credentials summary ─────────────────────`);
  io.log(`  Configured (${configured.length}): ${configured.join(", ") || "(none)"}`);
  io.log(`  Skipped (${skipped.length}):    ${skipped.join(", ") || "(none)"}`);
  io.log(`  Run \`hive credentials list\` later to review, \`hive credentials add <KEY>\` to add more.`);

  return { configured, skipped };
}
```

- [ ] **Step 2:** Tests cover all-skip, partial fill, replace path, OAuth skip.

```typescript
// src/setup/credentials-wizard.test.ts
import { describe, it, expect, vi } from "vitest";
import { runCredentialsStage, type CredentialsWizardIO } from "./credentials-wizard.js";
import { CREDENTIAL_REGISTRY } from "./credential-registry.js";

function makeIO(answers: { ask?: string[]; askSecret?: string[]; confirm?: boolean[] } = {}): CredentialsWizardIO & { stored: Record<string, string>; logs: string[] } {
  const ask = vi.fn();
  const askSecret = vi.fn();
  const confirm = vi.fn();
  const stored: Record<string, string> = {};
  const logs: string[] = [];

  let askIdx = 0;
  let askSecretIdx = 0;
  let confirmIdx = 0;
  ask.mockImplementation(async () => answers.ask?.[askIdx++] ?? "");
  askSecret.mockImplementation(async () => answers.askSecret?.[askSecretIdx++] ?? "");
  confirm.mockImplementation(async () => answers.confirm?.[confirmIdx++] ?? false);

  return {
    ask,
    askSecret,
    confirm,
    log: (m) => logs.push(m),
    setSecret: (k, v) => {
      stored[k] = v;
    },
    hasSecret: (k) => k in stored,
    stored,
    logs,
  };
}

describe("runCredentialsStage", () => {
  it("all-skip path produces no stored secrets", async () => {
    const io = makeIO({ confirm: new Array(CREDENTIAL_REGISTRY.length * 2).fill(false) });
    const result = await runCredentialsStage(io);
    expect(Object.keys(io.stored)).toEqual([]);
    expect(result.configured).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("provides keys for two entries when operator says yes + supplies values", async () => {
    // Confirm answers, in order:
    //   brave-search:  "provide?" yes
    //   linear:        "provide?" yes
    //   then no for all remaining (incl. oauth ack: no)
    const confirms: boolean[] = [true, true];
    while (confirms.length < CREDENTIAL_REGISTRY.length * 2) confirms.push(false);

    const io = makeIO({
      askSecret: ["brave-key-value", "linear-key-value"],
      confirm: confirms,
    });
    const result = await runCredentialsStage(io);

    expect(io.stored).toEqual({
      BRAVE_API_KEY: "brave-key-value",
      LINEAR_API_KEY: "linear-key-value",
    });
    expect(result.configured).toContain("brave-search");
    expect(result.configured).toContain("linear");
  });

  it("empty input skips that entry without aborting", async () => {
    const confirms: boolean[] = [true]; // say yes to brave provide
    while (confirms.length < CREDENTIAL_REGISTRY.length * 2) confirms.push(false);

    const io = makeIO({
      askSecret: [""], // empty value
      confirm: confirms,
    });
    const result = await runCredentialsStage(io);

    expect(io.stored).toEqual({});
    expect(result.skipped).toContain("brave-search");
  });

  it("oauth entries (google) record as skipped without asking for a value", async () => {
    const confirms: boolean[] = new Array(CREDENTIAL_REGISTRY.length * 2).fill(false);
    const io = makeIO({ confirm: confirms });
    const result = await runCredentialsStage(io);
    expect(result.skipped).toContain("google");
    expect(io.stored.GOOGLE_API_KEY).toBeUndefined();
  });

  it("already-configured + decline-replace keeps server as configured (not re-prompt)", async () => {
    // Pre-seed stored
    const io = makeIO({
      confirm: new Array(CREDENTIAL_REGISTRY.length * 2).fill(false),
    });
    io.stored.BRAVE_API_KEY = "existing";
    // hasSecret reads from stored, so brave-search is "already present"

    const result = await runCredentialsStage(io);
    expect(result.configured).toContain("brave-search");
    expect(io.stored.BRAVE_API_KEY).toBe("existing");
  });
});
```

**Verification:**
- [ ] `npx vitest run src/setup/credentials-wizard.test.ts` passes
- [ ] `npm run typecheck` passes

---

## Task 3: Wire credentials stage into the wizard

**Files:**
- Modify: `src/setup/wizard.ts`

- [ ] **Step 1:** Add an import + a stage call after Optional Integrations and before Plugins.

```typescript
// near the top of wizard.ts
import { runCredentialsStage, defaultSetSecret, defaultHasSecret } from "./credentials-wizard.js";
```

- [ ] **Step 2:** Add a section inside `runWizard()` after the existing Optional Integrations save. Provide an `askSecret` adapter that wraps `ask` (since the existing `ask` already reads from `readline`; in macOS Terminal we don't have a clean masked-prompt without bringing in another dep — accept the same UX as `honeypot set` which `read -s`-prompts inline). For now, use `ask` directly for the masked prompt — the existing wizard already does the same for SLACK_BOT_TOKEN etc. We log a warning that input is visible.

Insert after line ~378 (`saveHiveYaml(hive); console.log("\n  ✓ Configuration saved...")`) and before "── 4.5 Plugins":

```typescript
  // ── 4.6 Third-party Credentials (Honeypot) ─────────────────────────
  section("Third-Party Credentials");

  console.log("Hive can integrate with several third-party services (Linear, Brave Search,");
  console.log("ClickUp, Resend, etc.). Provide API keys now to seed them into the macOS");
  console.log("Keychain (Honeypot), or skip and add later via `hive credentials add <KEY>`.");

  await runCredentialsStage({
    ask: (q, def) => ask(q, def),
    askSecret: (q) => ask(q),
    confirm: (q, defaultYes) => confirm(q, defaultYes),
    log: (m) => console.log(m),
    setSecret: defaultSetSecret,
    hasSecret: defaultHasSecret,
  });
```

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (no `any` introduced)
- [ ] Manual smoke (read code path; no live wizard run per task instructions)

---

## Task 4: `hive credentials` subcommand

**Files:**
- Create: `src/cli/credentials.ts`
- Create: `src/cli/credentials.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1:** Implement `runCredentials`.

```typescript
// src/cli/credentials.ts
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  CREDENTIAL_REGISTRY,
  findCredentialEntryByKey,
  type CredentialEntry,
  type CredentialField,
} from "../setup/credential-registry.js";

export interface CredentialsCliIO {
  ask: (q: string) => Promise<string>;
  log: (msg: string) => void;
  setSecret: (key: string, value: string) => void;
  removeSecret: (key: string) => void;
  hasSecret: (key: string) => boolean;
}

export function defaultCliIO(): CredentialsCliIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => new Promise((res) => rl.question(`${q}: `, (a) => res(a.trim()))),
    log: (m) => console.log(m),
    setSecret: (k, v) => execFileSync("honeypot", ["set", k, v], { stdio: ["pipe", "pipe", "pipe"] }),
    removeSecret: (k) => execFileSync("honeypot", ["rm", k], { stdio: ["pipe", "pipe", "pipe"] }),
    hasSecret: (k) => {
      try {
        execFileSync("honeypot", ["get", k], { stdio: ["pipe", "pipe", "pipe"] });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function runCredentialsCommand(
  subcommand: string | undefined,
  args: string[],
  io: CredentialsCliIO = defaultCliIO(),
): Promise<number> {
  switch (subcommand) {
    case "list":
    case undefined:
      return listCredentials(io);
    case "add":
      return addCredential(args[0], io);
    case "remove":
    case "rm":
      return removeCredential(args[0], io);
    default:
      io.log(`Unknown subcommand: ${subcommand}`);
      io.log("Usage: hive credentials [list|add <KEY>|remove <KEY>]");
      return 1;
  }
}

function listCredentials(io: CredentialsCliIO): number {
  io.log("Third-party credentials (per the curated registry):\n");
  for (const entry of CREDENTIAL_REGISTRY) {
    if (entry.kind === "oauth") {
      io.log(`  -- ${entry.server}  (oauth — run \`gog auth add\` to set up)`);
      continue;
    }
    for (const field of entry.fields) {
      const present = io.hasSecret(field.key);
      const mark = present ? "ok" : "--";
      io.log(`  ${mark}  ${field.key}  (${entry.server})`);
    }
  }
  io.log("");
  io.log("Add or rotate: hive credentials add <KEY>");
  io.log("Remove:        hive credentials remove <KEY>");
  return 0;
}

async function addCredential(key: string | undefined, io: CredentialsCliIO): Promise<number> {
  if (!key) {
    io.log("Usage: hive credentials add <KEY>");
    return 1;
  }
  const entry = findCredentialEntryByKey(key);
  if (!entry) {
    io.log(`Unknown key: ${key}.`);
    io.log("Run \`hive credentials list\` for known keys.");
    return 1;
  }
  if (entry.kind === "oauth") {
    io.log(`${entry.server} uses OAuth, not a static API key.`);
    io.log(entry.oauthInstructions ?? "");
    return 1;
  }
  const field = entry.fields.find((f) => f.key === key) as CredentialField;
  io.log(`${entry.title} — ${entry.description}`);
  io.log(`Get one: ${entry.helpUrl}`);
  const value = await io.ask(field.label);
  if (!value) {
    io.log("Empty value — aborting.");
    return 1;
  }
  io.setSecret(key, value);
  io.log(`✓ ${key} stored in Honeypot.`);
  return 0;
}

function removeCredential(key: string | undefined, io: CredentialsCliIO): number {
  if (!key) {
    io.log("Usage: hive credentials remove <KEY>");
    return 1;
  }
  if (!io.hasSecret(key)) {
    io.log(`${key} is not set — nothing to remove.`);
    return 1;
  }
  io.removeSecret(key);
  io.log(`- ${key} removed from Honeypot.`);
  return 0;
}
```

- [ ] **Step 2:** Tests with injected IO.

```typescript
// src/cli/credentials.test.ts
import { describe, it, expect, vi } from "vitest";
import { runCredentialsCommand, type CredentialsCliIO } from "./credentials.js";

function makeIO(answers: string[] = []): CredentialsCliIO & { stored: Record<string, string>; logs: string[] } {
  const stored: Record<string, string> = {};
  const logs: string[] = [];
  let i = 0;
  return {
    ask: vi.fn(async () => answers[i++] ?? ""),
    log: (m) => logs.push(m),
    setSecret: (k, v) => {
      stored[k] = v;
    },
    removeSecret: (k) => {
      delete stored[k];
    },
    hasSecret: (k) => k in stored,
    stored,
    logs,
  };
}

describe("runCredentialsCommand list", () => {
  it("shows registry entries with present/absent marks", async () => {
    const io = makeIO();
    io.stored.LINEAR_API_KEY = "abc";
    const code = await runCredentialsCommand("list", [], io);
    expect(code).toBe(0);
    const joined = io.logs.join("\n");
    expect(joined).toContain("LINEAR_API_KEY");
    expect(joined).toMatch(/ok\s+LINEAR_API_KEY/);
    expect(joined).toMatch(/--\s+BRAVE_API_KEY/);
  });

  it("defaults to list when subcommand is omitted", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand(undefined, [], io);
    expect(code).toBe(0);
    expect(io.logs.join("\n")).toContain("BRAVE_API_KEY");
  });
});

describe("runCredentialsCommand add", () => {
  it("stores a known key", async () => {
    const io = makeIO(["super-secret"]);
    const code = await runCredentialsCommand("add", ["BRAVE_API_KEY"], io);
    expect(code).toBe(0);
    expect(io.stored.BRAVE_API_KEY).toBe("super-secret");
  });

  it("rejects unknown keys", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("add", ["NOT_A_REAL_KEY"], io);
    expect(code).toBe(1);
    expect(io.stored).toEqual({});
  });

  it("rejects empty input", async () => {
    const io = makeIO([""]);
    const code = await runCredentialsCommand("add", ["BRAVE_API_KEY"], io);
    expect(code).toBe(1);
    expect(io.stored).toEqual({});
  });

  it("declines OAuth servers", async () => {
    // google has no static key in the registry
    const io = makeIO();
    const code = await runCredentialsCommand("add", ["GOOGLE_API_KEY"], io);
    expect(code).toBe(1); // unknown key (since google has no fields)
  });
});

describe("runCredentialsCommand remove", () => {
  it("removes a stored key", async () => {
    const io = makeIO();
    io.stored.LINEAR_API_KEY = "abc";
    const code = await runCredentialsCommand("remove", ["LINEAR_API_KEY"], io);
    expect(code).toBe(0);
    expect(io.stored.LINEAR_API_KEY).toBeUndefined();
  });

  it("returns nonzero when key absent", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("remove", ["LINEAR_API_KEY"], io);
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 3:** Wire into `src/cli.ts`. Add a case for `credentials` and a help line.

```typescript
// in the help string, add a line:
//   credentials       Manage third-party API credentials (Honeypot)
//
// Add a case in the switch:
case "credentials": {
  const subcommand = positionals[1];
  const args = positionals.slice(2);
  const { runCredentialsCommand } = await import("./cli/credentials.js");
  const code = await runCredentialsCommand(subcommand, args);
  process.exit(code);
}
```

**Verification:**
- [ ] `npx vitest run src/cli/credentials.test.ts` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `node pkg/cli.min.js credentials list` (after build) prints the registry — manual smoke

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] Add a one-liner to the Commands section:
  - `hive credentials` — list / add / remove third-party API keys (Honeypot)

---

## Test plan

- Unit: registry shape (Task 1), wizard flow with all-skip / partial / replace / oauth (Task 2), CLI list/add/remove (Task 4).
- Smoke: `npm run check` clean.
- No live wizard run against any instance. KPR-77 owns end-to-end install rehearsal.

## File list (for review)

```
docs/plans/2026-04-28-bootstrap-credentials.md       # this plan
src/setup/credential-registry.ts                     # new
src/setup/credential-registry.test.ts                # new
src/setup/credentials-wizard.ts                      # new
src/setup/credentials-wizard.test.ts                 # new
src/cli/credentials.ts                               # new
src/cli/credentials.test.ts                          # new
src/setup/wizard.ts                                  # +stage call
src/cli.ts                                           # +subcommand
CLAUDE.md                                            # +one-liner
```
