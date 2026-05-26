# KPR-242 — Multi-Account Google MCP (per-call `account` parameter)

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Linear:** [KPR-242](https://linear.app/keepur/issue/KPR-242/multi-account-google-mcp-per-call-account-parameter)

**Goal:** Move the Google MCP from spawn-time single-account binding to a per-call `account` parameter so one agent (e.g. Mokie) can manage multiple Google accounts in a single MCP process.

**Architecture:**

- Single source of truth becomes `config.google.accounts: Record<string, string[]>` — value is normalized at config load (`string` → `[string]`, `string[]` → unchanged, missing → no Google MCP wired).
- `AgentRunner` reads the agent's list, skips Google entirely if missing, and passes `GOG_ACCOUNTS` (CSV) to the MCP at spawn.
- `google-mcp-server.ts` reads `GOG_ACCOUNTS`, derives `DEFAULT_ACCOUNT` (first entry) and `MULTI` (length > 1). A small `accountField` schema fragment is conditionally spread into every tool's `inputSchema`: empty `{}` when `MULTI === false`, `{ account: z.enum([...]).optional() }` when `MULTI === true`. Handlers resolve `const acc = account ?? DEFAULT_ACCOUNT;` and pass `acc` to helpers, which splice `-a <account>` per call.
- Legacy `google.account` global field is deleted from typed config + `GOOGLE_ACCOUNT` env path. Liberal-loader pattern: parsed YAML still loads if the field is present; a one-line deprecation warning is logged at config load. Setup wizard + credential-registry copy stop referencing it.

**Tech Stack:** TypeScript, Zod (MCP `inputSchema` shape), `@modelcontextprotocol/sdk`, Vitest.

## Testing Contract

### Required Test Groups

- Unit: required
  - Scope: `src/google/google-mcp-server.ts` (schema surface + handler dispatch), `src/config.ts` (loader normalization + deprecation warning).
  - Reason: schema-conditional behavior (param surfaces iff multi-account) is the load-bearing invariant for no-prompt-cache-churn; handler argv (`-a <account>`) is the load-bearing invariant for routing correctness. Both must be unit-locked.
  - Harness: existing — `src/google/google-mcp-server.test.ts` already mocks `execFileSync` and captures `registeredTools`. Extend it. Config loader unit test will need a new file `src/config.test.ts` (does not exist today) OR a focused test in an existing config-touching test — see Task 6 for placement.
  - Minimum assertions:
    - Single-account agent (`GOG_ACCOUNTS=a@x.com`): no `account` field in any registered tool's input schema; handler argv contains `-a a@x.com`; `gmail_send` response says `"Sent from a@x.com."`.
    - Multi-account agent (`GOG_ACCOUNTS=a@x.com,b@x.com,c@x.com`): every tool's input schema includes `account` as an optional Zod enum over the three accounts; calling without `account` routes to `a@x.com` (default); calling with `account: "b@x.com"` routes argv to `-a b@x.com`; `gmail_send` reflects the resolved account in the `"Sent from ..."` line.
    - Empty `GOG_ACCOUNTS`: handler argv contains no `-a` flag (preserves today's "use gog default" behavior for the no-config case, though that path is now reached only if the operator misconfigures `accounts[<agent>]` to an empty list — `AgentRunner` skips Google entirely if the entry is missing).
    - Config loader: hive.yaml with legacy `google.account: foo@x.com` loads successfully; deprecation warning is emitted once at load time; `config.google` exposes no `account` property; `config.google.accounts` is `Record<string, string[]>`.

- Integration: not-required
  - Scope: N/A — there is no integration boundary beyond the MCP `inputSchema` surface, which is unit-tested via the SDK mocks already in place.
  - Reason: the change is pure plumbing — no new I/O, no new DB writes, no new cross-module contract.

- E2E: not-required
  - Scope: N/A.
  - Reason: manual smoke (described below) is the right granularity for verifying the gog CLI subprocess actually accepts `-a <account>` for multiple authenticated accounts. Automating it would require live OAuth credentials.

### Critical Flows

- Single-account agent (Rae, Milo, Sige, etc.) sees byte-identical tool schemas to today after KPR-242 ships → prompt cache stays warm, no agent regressions.
- Multi-account agent (Mokie) can `gmail_send` from any of her three accounts in a single conversation turn, with each send response identifying the actual mailbox used.
- Agent with no `google.accounts[<id>]` entry has no Google MCP in their registered server list (today: silently inherited global; tomorrow: cleanly absent).

### Regression Surface

- Other call sites that read `config.google.account`: `src/agents/agent-runner.ts:504`, `src/tools/instance-capabilities.ts:45`, `src/tools/server-catalog.ts` (display copy only — no behavior), `src/setup/wizard.ts:88,343,346,350,353`, `src/setup/credential-registry.ts:124-126`. All must compile and behave sensibly after the field is removed.
- `src/agents/agent-runner.test.ts:92` and `src/tools/instance-capabilities.test.ts:7` carry the old `account: ""` fixture — must update so the test mocks match the new typed config.
- Prompt cache: KPR-213 invalidates on agent-def write, memory write, constitution edit, team-roster change, skill change. A schema-shape change in an MCP server is *not* in that list, but the toolkit string is rebuilt from the SDK's live tool inventory on each turn, so single-account agents *must* see byte-identical input schemas or their toolkit listing will diff and bust the prefix cache. The conditional spread (`...accountField` where `accountField === {}` when `!MULTI`) is the load-bearing trick here — locked in by the "single-account: no `account` field" unit assertion.

### Commands

- Unit: `npm run test -- src/google/google-mcp-server.test.ts src/config.test.ts` (the config test file is new — Task 6).
- Integration: not applicable.
- E2E: not applicable.
- Broader regression: `npm run check` (typecheck + lint + format + full vitest sweep).

### Harness Requirements

- None new. Existing vitest setup + the MCP SDK mock pattern in `google-mcp-server.test.ts` covers everything.

### Non-Required Rationale

- Integration: no integration boundary exists that isn't already covered by the schema-and-handler unit lens.
- E2E: live OAuth credentials cannot live in CI; manual smoke (operator runs `hive update`, asks Mokie to send from each of her three accounts, confirms the `"Sent from ..."` line) is the right granularity.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify regression**: after the deprecation-warning unit test in Task 6 is written and green, revert *just* the `console.warn(...)` line in `src/config.ts`, re-run that one test, and confirm it fails. Restore. Stronger evidence than "passes after fix."

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/config.ts` | Modify (lines 150–158) | Delete `account` field + `GOOGLE_ACCOUNT` env path; normalize `accounts` to `Record<string, string[]>`; log deprecation warning if `hive.google?.account` present in parsed YAML. Export `normalizeGoogleAccounts` + `warnIfLegacyGoogleAccount` for direct unit testing. |
| `src/agents/agent-runner.ts` | Modify (lines 502–517) | Replace `gogAccount` resolution with normalized list lookup; skip wiring Google MCP entirely if list is empty; pass `GOG_ACCOUNTS` CSV at spawn (drop `GOG_ACCOUNT`). |
| `src/google/google-mcp-server.ts` | Modify | Replace `ACCOUNT` constant with `ACCOUNTS` / `DEFAULT_ACCOUNT` / `MULTI`; build `accountField` schema fragment; spread into every tool's `inputSchema`; thread `account` through every handler; change `gog()` / `gogPlain()` to take explicit `account: string`. |
| `src/google/google-mcp-server.test.ts` | Modify | Add multi-account schema + handler-dispatch cases; update existing `gmail_send` identity case to match new helper signature; introduce a small helper to peek `registeredTools.get(name)?.inputSchema` (the existing mock captures only the handler — extend it). |
| `src/tools/instance-capabilities.ts` | Modify (line 45) | Drop the `\|\| !!config.google?.account` tail of the predicate — only `Object.keys(accounts).length > 0` matters now. |
| `src/tools/instance-capabilities.test.ts` | Modify (line 7) | Update fixture: remove `account: ""`, change `accounts` shape to the new `Record<string, string[]>`. |
| `src/agents/agent-runner.test.ts` | Modify (line 92) | Same fixture update — remove `account: ""`. |
| `src/setup/wizard.ts` | Modify (lines 88, 343–357) | Remove `GOOGLE_ACCOUNT` from the .env group list; rework the Google-setup prompt to verify gog auth without persisting `GOOGLE_ACCOUNT` to .env (or persist nothing — wizard tells operator to edit hive.yaml `google.accounts.<agent>` instead). |
| `src/setup/credential-registry.ts` | Modify (lines 124–126) | Update `oauthInstructions` to drop `GOOGLE_ACCOUNT` reference; point operator at `hive.yaml` `google.accounts.<agent-id>: <email>` (single) or `[<email>, ...]` (multi). |
| `src/config.test.ts` | Create | New unit-test file. Direct-tests the exported `normalizeGoogleAccounts` (string → 1-elem array, array preserved + ordered, whitespace trimmed, empties dropped, agents with no surviving accounts dropped) and `warnIfLegacyGoogleAccount` (warns iff `google.account` present). No module-graph isolation needed. |
| `docs/architecture.md` *(optional, see Task 9)* | Modify | Update Google MCP description if it mentions the spawn-time account binding. |

---

## Task 1: Config loader — normalize accounts, drop legacy field

**Files:**
- Modify: `src/config.ts:150-158`

- [ ] **Step 1:** Replace the `google` block in the typed config object.

Before (`src/config.ts:150-158`):

```ts
  google: {
    account: optional("GOOGLE_ACCOUNT", hive.google?.account ?? ""),
    client: optional("GOG_CLIENT", hive.google?.client ?? ""),
    accounts: (hive.google?.accounts ?? {}) as Record<string, string>,
    sharedFolder: optional(
      "DRIVE_SHARED_FOLDER",
      hive.google?.sharedFolder ?? hive.googleWorkspace?.sharedFolder ?? "",
    ),
  },
```

After:

```ts
  google: {
    client: optional("GOG_CLIENT", hive.google?.client ?? ""),
    accounts: normalizeGoogleAccounts(hive.google?.accounts),
    sharedFolder: optional(
      "DRIVE_SHARED_FOLDER",
      hive.google?.sharedFolder ?? hive.googleWorkspace?.sharedFolder ?? "",
    ),
  },
```

- [ ] **Step 2:** Add two **exported** helpers near the other top-level helpers in `src/config.ts` (above the typed config object — search for `function optional(`). Exporting both lets Task 6 unit-test them directly without module-graph isolation.

```ts
/**
 * Normalize `hive.google.accounts` to `Record<string, string[]>`.
 * Accepts string (single account) or string[] (multi-account) per agent.
 * Filters out falsy/empty values; preserves declaration order (first = default).
 * Explicitly rejects array inputs — YAML maps can't produce arrays at this
 * position, but the typed input is `unknown` so guard against stringly-keyed
 * garbage if a future caller hands us `[]` or `[["agent", "email"]]`.
 */
export function normalizeGoogleAccounts(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [agentId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) {
      out[agentId] = [val.trim()];
    } else if (Array.isArray(val)) {
      const list = val.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
      if (list.length > 0) out[agentId] = list;
    }
  }
  return out;
}

/**
 * KPR-242: warn once at config load if hive.yaml still carries the deprecated
 * `google.account` field. Exported so unit tests can exercise it directly.
 */
export function warnIfLegacyGoogleAccount(rawHive: Record<string, unknown> | undefined): void {
  const g = rawHive?.google;
  if (g && typeof g === "object" && "account" in g) {
    console.warn(
      "[config] `google.account` is deprecated and unused; " +
        "use `google.accounts.<agentId>` (string for single account, string[] for multi-account) to grant Google access per agent.",
    );
  }
}
```

- [ ] **Step 3:** Call the deprecation warning from the module body. Place it immediately after the `hive` YAML is parsed (after line 43 — search for `if (existsSync(hiveConfigPath))`). Confirm by `grep -n "console.warn" src/config.ts` that this matches the file's deprecation-warning convention.

```ts
warnIfLegacyGoogleAccount(hive);
```

- [ ] **Step 4:** Typecheck.

Run: `npm run typecheck`
Expected: passes. (Failures in this step will be from call sites referencing `config.google.account` — Tasks 2, 5, 7, 8 fix those.)

- [ ] **Step 5:** *Do not commit yet* — call sites in Tasks 2, 5, 7, 8 must compile before this lands. Continue.

---

## Task 2: AgentRunner — list lookup, skip-if-empty, CSV spawn env

**Files:**
- Modify: `src/agents/agent-runner.ts:502-517`

- [ ] **Step 1:** Replace the Google MCP wiring block.

Before (`src/agents/agent-runner.ts:502-517`):

```ts
    // Google MCP server — Gmail + Calendar via gog CLI
    // Per-agent account from google.accounts map, falls back to global google.account
    const gogAccount = config.google.accounts[this.agentConfig.id] || config.google.account;
    const gogClient = config.google.client;
    servers["google"] = {
      type: "stdio",
      command: "node",
      args: [mcpPath("google/google-mcp-server.js")],
      env: {
        ...(gogAccount ? { GOG_ACCOUNT: gogAccount } : {}),
        ...(gogClient ? { GOG_CLIENT: gogClient } : {}),
        DRIVE_SHARED_FOLDER: config.google.sharedFolder,
        INSTANCE_ID: config.instance.id,
        PATH: process.env.PATH ?? "",
      },
    };
```

After:

```ts
    // Google MCP server — Gmail + Calendar + Drive via gog CLI.
    // KPR-242: per-agent account list; if no entry, Google MCP isn't wired up for this agent.
    // First account in the list is the implicit default; the MCP surfaces `account` as a tool
    // parameter only when the list has 2+ entries (avoids prompt-cache churn for single-account agents).
    const gogAccounts = config.google.accounts[this.agentConfig.id] ?? [];
    if (gogAccounts.length > 0) {
      const gogClient = config.google.client;
      servers["google"] = {
        type: "stdio",
        command: "node",
        args: [mcpPath("google/google-mcp-server.js")],
        env: {
          GOG_ACCOUNTS: gogAccounts.join(","),
          ...(gogClient ? { GOG_CLIENT: gogClient } : {}),
          DRIVE_SHARED_FOLDER: config.google.sharedFolder,
          INSTANCE_ID: config.instance.id,
          PATH: process.env.PATH ?? "",
        },
      };
    }
```

- [ ] **Step 2:** Typecheck.

Run: `npm run typecheck`
Expected: passes. If `config.google.account` references remain elsewhere they will surface here — proceed to Task 5, 7, 8 as needed.

---

## Task 3: Google MCP server — module constants + helper signatures

**Files:**
- Modify: `src/google/google-mcp-server.ts:9-55`

- [ ] **Step 1:** Replace the header comment + module constants.

Before (`src/google/google-mcp-server.ts:9-13`):

```ts
 * Env vars:
 *   GOG_ACCOUNT — Google account email (optional, uses gog default if unset)
 *   GOG_CLIENT  — OAuth client name (optional, uses gog default if unset)
 *   GOG_PATH    — path to gog binary (optional, auto-detected if unset)
 */
```

After:

```ts
 * Env vars:
 *   GOG_ACCOUNTS — CSV of Google account emails (KPR-242). First entry is the implicit default.
 *                  When more than one is listed, every tool surfaces an `account` enum parameter.
 *   GOG_CLIENT   — OAuth client name (optional, uses gog default if unset)
 *   GOG_PATH     — path to gog binary (optional, auto-detected if unset)
 */
```

- [ ] **Step 2:** Replace the `ACCOUNT` constant and helper signatures (`src/google/google-mcp-server.ts:22-55`).

Before:

```ts
const ACCOUNT = process.env.GOG_ACCOUNT ?? "";
const CLIENT = process.env.GOG_CLIENT ?? "";
const GOG =
  process.env.GOG_PATH ??
  (() => {
    try {
      return execFileSync("which", ["gog"], { encoding: "utf-8" }).trim();
    } catch {
      return "gog";
    }
  })();

function gog(args: string[]): string {
  const fullArgs = [
    ...args,
    ...(ACCOUNT ? ["-a", ACCOUNT] : []),
    ...(CLIENT ? ["--client", CLIENT] : []),
    "--json",
    "--results-only",
    "--no-input",
  ];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function gogPlain(args: string[]): string {
  const fullArgs = [
    ...args,
    ...(ACCOUNT ? ["-a", ACCOUNT] : []),
    ...(CLIENT ? ["--client", CLIENT] : []),
    "--plain",
    "--no-input",
  ];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}
```

After:

```ts
const ACCOUNTS = (process.env.GOG_ACCOUNTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_ACCOUNT = ACCOUNTS[0] ?? "";
const MULTI = ACCOUNTS.length > 1;
const CLIENT = process.env.GOG_CLIENT ?? "";
const GOG =
  process.env.GOG_PATH ??
  (() => {
    try {
      return execFileSync("which", ["gog"], { encoding: "utf-8" }).trim();
    } catch {
      return "gog";
    }
  })();

/**
 * KPR-242: when MULTI is true, every tool's input schema gets this `account`
 * enum spread in. When false (the common single-account case), the spread is
 * `{}` and the registered tool schema is byte-identical to pre-KPR-242 —
 * critical for keeping the toolkit prefix prompt cache warm for Rae/Milo/Sige.
 */
const accountField = MULTI
  ? {
      account: z
        .enum(ACCOUNTS as [string, ...string[]])
        .optional()
        .describe(
          `Which Google account to use. Defaults to ${DEFAULT_ACCOUNT}. Available: ${ACCOUNTS.join(", ")}`,
        ),
    }
  : ({} as Record<string, never>);

function gog(account: string, args: string[]): string {
  const fullArgs = [
    ...args,
    ...(account ? ["-a", account] : []),
    ...(CLIENT ? ["--client", CLIENT] : []),
    "--json",
    "--results-only",
    "--no-input",
  ];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function gogPlain(account: string, args: string[]): string {
  const fullArgs = [
    ...args,
    ...(account ? ["-a", account] : []),
    ...(CLIENT ? ["--client", CLIENT] : []),
    "--plain",
    "--no-input",
  ];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}
```

- [ ] **Step 3:** Typecheck.

Run: `npm run typecheck`
Expected: every `gog(...)` / `gogPlain(...)` call site in the same file now fails compilation (missing first arg). Task 4 fixes them.

---

## Task 4: Google MCP server — thread `account` through every tool

**Files:**
- Modify: `src/google/google-mcp-server.ts:64-295` (all eleven tool registrations under Gmail + Calendar; Drive tools also reach `gog`/`gogPlain` and need the same treatment).

For each tool, the pattern is:

1. Spread `...accountField` into `inputSchema`.
2. Destructure `account` from the handler args.
3. Resolve `const acc = account ?? DEFAULT_ACCOUNT;` at the top of the handler.
4. Pass `acc` as the first arg to `gog(...)` or `gogPlain(...)`.
5. For `gmail_send`, replace the `ACCOUNT` reference in `sentFrom` with `acc`.

- [ ] **Step 1:** `gmail_search` (lines 64–83).

```ts
server.registerTool(
  "gmail_search",
  {
    title: "Search Email",
    description:
      "Search Gmail using Gmail query syntax (e.g. 'from:someone@example.com', 'is:unread newer_than:1d', 'subject:invoice'). Returns thread summaries.",
    inputSchema: {
      query: z.string().describe("Gmail search query"),
      max: z.number().optional().default(10).describe("Max results (default 10)"),
      ...accountField,
    },
  },
  async ({ query, max, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["gmail", "search", query, `--max=${max}`]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Search failed: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 2:** `gmail_get` (lines 85–102).

```ts
server.registerTool(
  "gmail_get",
  {
    title: "Read Email",
    description: "Read a specific email message by its message ID. Returns full message content.",
    inputSchema: {
      messageId: z.string().describe("Gmail message ID"),
      ...accountField,
    },
  },
  async ({ messageId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["gmail", "get", messageId]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to read message: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 3:** `gmail_thread` (lines 104–121).

```ts
server.registerTool(
  "gmail_thread",
  {
    title: "Read Email Thread",
    description: "Read an entire email thread by thread ID. Returns all messages in the conversation.",
    inputSchema: {
      threadId: z.string().describe("Gmail thread ID"),
      ...accountField,
    },
  },
  async ({ threadId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["gmail", "thread", "get", threadId]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to read thread: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 4:** `gmail_send` (lines 123–160) — includes the `sentFrom` identity line.

```ts
server.registerTool(
  "gmail_send",
  {
    title: "Send Email",
    description: "Send an email. Can also reply to an existing thread.",
    inputSchema: {
      to: z.string().describe("Recipient email addresses (comma-separated)"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      threadId: z.string().optional().describe("Thread ID to reply within"),
      ...accountField,
    },
  },
  async ({ to, subject, body, cc, threadId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gogPlain(acc, [
        "send",
        "--to",
        to,
        "--subject",
        subject,
        "--body",
        body,
        "--force",
        ...(cc ? ["--cc", cc] : []),
        ...(threadId ? ["--thread-id", threadId] : []),
      ]);
      // KPR-174 + KPR-242: surface the sending identity so the agent (and the
      // operator) can confirm which mailbox actually sent the message — now
      // reflecting the per-call account choice instead of a spawn-time const.
      const sentFrom = acc ? `Sent from ${acc}.` : "Email sent.";
      const text = result ? `${sentFrom}\n\n${result}` : sentFrom;
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to send: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 5:** `calendar_list` (lines 164–179).

```ts
server.registerTool(
  "calendar_list",
  {
    title: "List Calendars",
    description: "List all available Google calendars.",
    inputSchema: {
      ...accountField,
    },
  },
  async ({ account } = {} as { account?: string }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["cal", "calendars"]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to list calendars: ${e.message}` }], isError: true };
    }
  },
);
```

Note: `calendar_list` originally takes no args. With `accountField` empty (single-account), the spread yields `{}` and the handler still works because the destructure has a default. With `accountField` populated, `account` may be present. The `= {} as { account?: string }` default keeps the handler shape sound in both branches.

- [ ] **Step 6:** `calendar_events` (lines 181–214).

```ts
server.registerTool(
  "calendar_events",
  {
    title: "List Calendar Events",
    description:
      "List upcoming calendar events. Supports relative dates: 'today', 'tomorrow', 'monday', or RFC3339 timestamps.",
    inputSchema: {
      from: z.string().optional().describe("Start time (e.g. 'today', 'tomorrow', '2026-03-01')"),
      to: z.string().optional().describe("End time"),
      today: z.boolean().optional().describe("Show today's events only"),
      days: z.number().optional().describe("Show events for next N days"),
      max: z.number().optional().default(20).describe("Max results (default 20)"),
      calendarId: z.string().optional().describe("Calendar ID (default: primary)"),
      ...accountField,
    },
  },
  async ({ from, to, today, days, max, calendarId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const args: string[] = ["cal", "events"];
      if (calendarId) args.push(calendarId);
      args.push(
        ...(today
          ? ["--today"]
          : days
            ? [`--days=${days}`]
            : [...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])]),
      );
      args.push(`--max=${max}`);
      const result = gog(acc, args);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to list events: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 7:** `calendar_search` (lines 216–235).

```ts
server.registerTool(
  "calendar_search",
  {
    title: "Search Calendar",
    description: "Search calendar events by text query.",
    inputSchema: {
      query: z.string().describe("Search query"),
      from: z.string().optional().describe("Start time"),
      to: z.string().optional().describe("End time"),
      ...accountField,
    },
  },
  async ({ query, from, to, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, [
        "cal",
        "search",
        query,
        ...(from ? ["--from", from] : []),
        ...(to ? ["--to", to] : []),
      ]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `No events found or search failed: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 8:** `calendar_create` (lines 237–274).

```ts
server.registerTool(
  "calendar_create",
  {
    title: "Create Calendar Event",
    description: "Create a new calendar event.",
    inputSchema: {
      summary: z.string().describe("Event title"),
      from: z.string().describe("Start time (RFC3339 or relative like 'tomorrow 2pm')"),
      to: z.string().describe("End time (RFC3339 or relative)"),
      description: z.string().optional().describe("Event description"),
      location: z.string().optional().describe("Event location"),
      attendees: z.string().optional().describe("Attendee emails (comma-separated)"),
      calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
      ...accountField,
    },
  },
  async ({ summary, from, to, description, location, attendees, calendarId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gogPlain(acc, [
        "cal",
        "create",
        calendarId,
        "--summary",
        summary,
        "--from",
        from,
        "--to",
        to,
        "--force",
        ...(description ? ["--description", description] : []),
        ...(location ? ["--location", location] : []),
        ...(attendees ? ["--attendees", attendees] : []),
      ]);
      return { content: [{ type: "text", text: result || "Event created." }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to create event: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 9:** `calendar_freebusy` (lines 276–295).

```ts
server.registerTool(
  "calendar_freebusy",
  {
    title: "Check Free/Busy",
    description: "Check free/busy status for a time range.",
    inputSchema: {
      from: z.string().describe("Start time"),
      to: z.string().describe("End time"),
      calendarIds: z.string().optional().default("primary").describe("Calendar IDs (comma-separated)"),
      ...accountField,
    },
  },
  async ({ from, to, calendarIds, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["cal", "freebusy", calendarIds, "--from", from, "--to", to]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to check free/busy: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 10:** `drive_upload` (lines 304–347).

```ts
server.registerTool(
  "drive_upload",
  {
    title: "Upload File to Google Drive",
    description:
      "Upload a local file to the company shared Google Drive folder. " +
      "Returns a shareable link. Use this to share CSVs, reports, documents with the team. " +
      "The file must exist on the local filesystem (e.g. from permit_export_csv or other export tools).",
    inputSchema: {
      file_path: z.string().describe("Absolute path to the local file to upload"),
      name: z.string().optional().describe("Override the filename in Drive (defaults to local filename)"),
      ...accountField,
    },
  },
  async ({ file_path, name, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    if (!SHARED_FOLDER) {
      return {
        content: [{ type: "text", text: "Drive shared folder not configured (DRIVE_SHARED_FOLDER)." }],
        isError: true,
      };
    }

    if (!existsSync(file_path)) {
      return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
    }

    const fileName = name || basename(file_path);

    try {
      const result = gog(acc, ["drive", "upload", file_path, "--parent", SHARED_FOLDER, "--name", fileName]);
      const data = JSON.parse(result);

      const summary = [
        `Uploaded to Google Drive`,
        `  Name: ${data.name || fileName}`,
        ...(data.webViewLink ? [`  View: ${data.webViewLink}`] : []),
        ...(data.id ? [`  File ID: ${data.id}`] : []),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Upload failed: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 11:** `drive_download` (lines 349–400).

```ts
server.registerTool(
  "drive_download",
  {
    title: "Download File from Google Drive",
    description:
      "Download a file from Google Drive to the local filesystem for processing. " +
      "Provide either a file ID or a Drive URL. For Google Docs/Sheets/Slides, exports as text/CSV.",
    inputSchema: {
      file_id: z.string().optional().describe("Google Drive file ID"),
      url: z.string().optional().describe("Google Drive URL (file ID will be extracted)"),
      format: z.string().optional().describe("Export format (e.g. txt, csv, pdf). Only for Google-native files."),
      ...accountField,
    },
  },
  async ({ file_id, url, format, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    let id = file_id;

    if (!id && url) {
      const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/id=([a-zA-Z0-9_-]+)/);
      if (match) id = match[1];
    }

    if (!id) {
      return { content: [{ type: "text", text: "Provide either file_id or a Google Drive URL." }], isError: true };
    }

    try {
      const outPath = join(DOWNLOAD_DIR, id + (format ? `.${format}` : ""));
      const args = ["drive", "download", id, "--out", outPath];
      if (format) args.push("--format", format);
      gogPlain(acc, args);

      const textExtensions = new Set([".txt", ".csv", ".md", ".json", ".xml", ".html", ".tsv"]);
      const ext = outPath.includes(".") ? outPath.slice(outPath.lastIndexOf(".")) : "";
      if (existsSync(outPath) && textExtensions.has(ext)) {
        const content = readFileSync(outPath, "utf-8");
        const summary = [
          `Downloaded${format ? ` and exported as ${format}` : ""}`,
          `  Local path: ${outPath}`,
          ``,
          `--- Content ---`,
          content,
        ].join("\n");
        return { content: [{ type: "text", text: summary }] };
      }

      return { content: [{ type: "text", text: `Downloaded to ${outPath}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Download failed: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 12:** `drive_list` (lines 402–446).

```ts
server.registerTool(
  "drive_list",
  {
    title: "List Files in Shared Drive Folder",
    description:
      "List files in the company shared Drive folder. Useful to see what reports and documents have been shared.",
    inputSchema: {
      query: z.string().optional().describe("Search query to filter files (e.g. 'permits' or 'name contains report')"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
      ...accountField,
    },
  },
  async ({ query, limit, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    if (!SHARED_FOLDER) {
      return { content: [{ type: "text", text: "Drive shared folder not configured." }], isError: true };
    }

    try {
      const args = ["drive", "ls", "--parent", SHARED_FOLDER];
      if (query) args.push("--query", query);
      args.push(`--max=${limit ?? 20}`);
      const result = gog(acc, args);

      try {
        const files = JSON.parse(result);
        if (!Array.isArray(files) || files.length === 0) {
          return { content: [{ type: "text", text: "No files found." }] };
        }
        const lines = files.map((f: Record<string, unknown>) => {
          const name = (f.name as string) || "Untitled";
          const size = (f.size as string) || "—";
          const modified = (f.modifiedTime as string) ? new Date(f.modifiedTime as string).toLocaleDateString() : "—";
          const link = (f.webViewLink as string) || "";
          return `📄 ${name} — ${size} — ${modified}${link ? ` — ${link}` : ""}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch {
        return { content: [{ type: "text", text: result || "No files found." }] };
      }
    } catch (e: any) {
      return { content: [{ type: "text", text: `List failed: ${e.message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 13:** Typecheck.

Run: `npm run typecheck`
Expected: `src/google/google-mcp-server.ts` compiles clean. Errors elsewhere are fine for now (Tasks 5/7/8 handle them).

---

## Task 5: Update peripheral call sites to drop `google.account`

**Files:**
- Modify: `src/tools/instance-capabilities.ts:45`
- Modify: `src/tools/instance-capabilities.test.ts:7`
- Modify: `src/agents/agent-runner.test.ts:92`

- [ ] **Step 1:** `src/tools/instance-capabilities.ts:45` — drop the `|| !!config.google?.account` tail.

Before:

```ts
  google: () => Object.keys(config.google?.accounts ?? {}).length > 0 || !!config.google?.account,
```

After:

```ts
  google: () => Object.keys(config.google?.accounts ?? {}).length > 0,
```

- [ ] **Step 2:** `src/tools/instance-capabilities.test.ts:7` — update fixture.

Before:

```ts
    google: { accounts: { "user@example.com": "token" }, account: "" },
```

After:

```ts
    google: { accounts: { mokie: ["mokie@example.com"] } },
```

The original fixture had a semantically off shape — keyed by email, valued by token-shaped string. The new shape matches the actual `Record<string, string[]>` typing (key = agent id, value = list of accounts). The test only asserts on truthiness of `Object.keys(accounts).length > 0`, so any well-shaped fixture works; pick one that won't confuse the next reader.

- [ ] **Step 3:** `src/agents/agent-runner.test.ts:92` — update fixture.

Before:

```ts
    google: { account: "", accounts: {}, sharedFolder: "test-folder" },
```

After:

```ts
    google: { accounts: {}, sharedFolder: "test-folder" },
```

- [ ] **Step 4:** Typecheck.

Run: `npm run typecheck`
Expected: passes.

---

## Task 6: Config loader unit tests (new file)

**Files:**
- Create: `src/config.test.ts`
- Modify: `src/config.ts` (export `normalizeGoogleAccounts`; emit deprecation warning via an exported `warnIfLegacyGoogleAccount` helper called from the module body)

The normalization logic is pure and direct-testable. The deprecation warning is a module-load side effect — wrap that single line in a `warnIfLegacyGoogleAccount(rawHive)` helper so we can call it directly from a test without resetting the entire module graph. Avoids vitest module-isolation fights with `dotenv.config()` + `resolveDotenvPath(hiveHome)`.

This requires two tiny tweaks to Task 1: export both helpers from `src/config.ts`.

- [ ] **Step 1:** Confirm `src/config.test.ts` does not exist.

```bash
ls src/config.test.ts 2>&1
```

Expected: "No such file or directory."

- [ ] **Step 2:** Confirm `normalizeGoogleAccounts` and `warnIfLegacyGoogleAccount` are already exported (per Task 1 Step 2) and that the module body calls `warnIfLegacyGoogleAccount(hive)` after YAML parse (per Task 1 Step 3). No additional changes to `src/config.ts` in this task — Task 1 already laid the foundation; this task just consumes it from the test file.

- [ ] **Step 3:** Write `src/config.test.ts`.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeGoogleAccounts, warnIfLegacyGoogleAccount } from "./config.js";

describe("normalizeGoogleAccounts (KPR-242)", () => {
  it("returns an empty record for undefined or non-object input", () => {
    expect(normalizeGoogleAccounts(undefined)).toEqual({});
    expect(normalizeGoogleAccounts(null)).toEqual({});
    expect(normalizeGoogleAccounts("not an object")).toEqual({});
    expect(normalizeGoogleAccounts(42)).toEqual({});
  });

  it("returns an empty record for array input (typeof [] === 'object' edge case)", () => {
    // YAML maps can't produce arrays at this position, but the input is `unknown` —
    // lock the invariant defensively so a future caller can't smuggle in `[]`
    // or `[["agent", "email"]]` and get stringly-keyed garbage out.
    expect(normalizeGoogleAccounts([])).toEqual({});
    expect(normalizeGoogleAccounts([["agent", "a@x.com"]])).toEqual({});
  });

  it("normalizes a string-valued account entry to a one-element array", () => {
    expect(normalizeGoogleAccounts({ rae: "rae@dodihome.com" })).toEqual({
      rae: ["rae@dodihome.com"],
    });
  });

  it("preserves an array-valued account entry and its order", () => {
    const input = {
      mokie: ["may@dodihome.com", "may.huang@gmail.com", "may@keepur.io"],
    };
    expect(normalizeGoogleAccounts(input)).toEqual({
      mokie: ["may@dodihome.com", "may.huang@gmail.com", "may@keepur.io"],
    });
  });

  it("trims whitespace from string and array entries", () => {
    expect(normalizeGoogleAccounts({ rae: "  rae@dodihome.com  " })).toEqual({
      rae: ["rae@dodihome.com"],
    });
    expect(normalizeGoogleAccounts({ mokie: ["  a@x.com", "b@x.com  "] })).toEqual({
      mokie: ["a@x.com", "b@x.com"],
    });
  });

  it("drops empty strings and non-string array entries", () => {
    expect(normalizeGoogleAccounts({ rae: "" })).toEqual({});
    expect(normalizeGoogleAccounts({ mokie: ["", "  ", "a@x.com"] })).toEqual({
      mokie: ["a@x.com"],
    });
    expect(normalizeGoogleAccounts({ mokie: [null, 42, "a@x.com"] as unknown[] })).toEqual({
      mokie: ["a@x.com"],
    });
  });

  it("drops an agent whose array reduces to empty", () => {
    expect(normalizeGoogleAccounts({ mokie: ["", "  "] })).toEqual({});
  });
});

describe("warnIfLegacyGoogleAccount (KPR-242)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when legacy `google.account` is present", () => {
    warnIfLegacyGoogleAccount({ google: { account: "legacy@example.com" } });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("`google.account` is deprecated");
  });

  it("does not warn when `google.account` is absent", () => {
    warnIfLegacyGoogleAccount({ google: { accounts: { rae: "rae@x.com" } } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when `google` is absent entirely", () => {
    warnIfLegacyGoogleAccount({});
    warnIfLegacyGoogleAccount(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when `google` is non-object", () => {
    warnIfLegacyGoogleAccount({ google: "not an object" } as unknown as Record<string, unknown>);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4:** Run the new tests.

Run: `npm run test -- src/config.test.ts`
Expected: all cases pass (10 cases across the two describe blocks).

- [ ] **Step 5:** Negative-verify the deprecation warning case.

```bash
# In src/config.ts, comment out the console.warn(...) call inside warnIfLegacyGoogleAccount.
npm run test -- src/config.test.ts -t "warns when legacy"
# Expected: this test FAILS (warnSpy not called).
# Restore the console.warn(...) call.
npm run test -- src/config.test.ts -t "warns when legacy"
# Expected: passes again.
```

Stronger evidence than "passes after fix" — confirms the test is actually exercising the production line, not a tautology.

---

## Task 7: Google MCP server tests — schema surface + handler dispatch

**Files:**
- Modify: `src/google/google-mcp-server.test.ts`

The existing mock captures only the handler, not the input schema. Extend it.

- [ ] **Step 1:** Extend the registered-tools capture.

Before (`src/google/google-mcp-server.test.ts:18-27`):

```ts
type ToolHandler = (...args: any[]) => any;
const registeredTools = new Map<string, { handler: ToolHandler }>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((name: string, _opts: any, handler: ToolHandler) => {
      registeredTools.set(name, { handler });
    }),
    connect: vi.fn(),
  })),
}));
```

After:

```ts
type ToolHandler = (...args: any[]) => any;
const registeredTools = new Map<string, { handler: ToolHandler; inputSchema: Record<string, unknown> }>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((name: string, opts: { inputSchema?: Record<string, unknown> }, handler: ToolHandler) => {
      registeredTools.set(name, { handler, inputSchema: opts.inputSchema ?? {} });
    }),
    connect: vi.fn(),
  })),
}));
```

- [ ] **Step 2:** Update the existing `gmail_send` identity tests to use `GOG_ACCOUNTS` (singular accounts CSV) instead of `GOG_ACCOUNT`.

Before (`src/google/google-mcp-server.test.ts:273-307`):

```ts
  describe("gmail_send", () => {
    it("includes the sending identity (GOG_ACCOUNT) in the success response (KPR-174)", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNT: "jessica@dodihome.com",
      });
      // ...
      expect(result.content[0].text).toContain("Sent from jessica@dodihome.com");
      // gog's own output should still be included for full traceability
      expect(result.content[0].text).toContain("Message-ID:");
    });

    it("falls back to 'Email sent.' when GOG_ACCOUNT is unset", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog" });
      // ...
      expect(result.content[0].text).toBe("Email sent.");
    });
  });
```

After:

```ts
  describe("gmail_send", () => {
    it("includes the sending identity in the success response (KPR-174 + KPR-242)", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "jessica@dodihome.com",
      });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("send")) return "Message-ID: <abc@gmail.com>";
        return "";
      });
      const result = await callTool("gmail_send", {
        to: "customer@example.com",
        subject: "Re: order",
        body: "Thanks!",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Sent from jessica@dodihome.com");
      expect(result.content[0].text).toContain("Message-ID:");
    });

    it("falls back to 'Email sent.' when GOG_ACCOUNTS is unset", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog" });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("send")) return "";
        return "";
      });
      const result = await callTool("gmail_send", {
        to: "customer@example.com",
        subject: "Hi",
        body: "Hello",
      });
      expect(result.content[0].text).toBe("Email sent.");
    });
  });
```

- [ ] **Step 3:** Add multi-account schema + dispatch cases. Append to the `describe("google-mcp-server", ...)` block before its closing brace.

```ts
  describe("KPR-242 multi-account", () => {
    it("single-account: no `account` field appears in any tool's input schema", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "rae@dodihome.com",
      });
      for (const [name, t] of registeredTools.entries()) {
        expect(t.inputSchema, `tool "${name}" should not surface \`account\``).not.toHaveProperty("account");
      }
    });

    it("multi-account: every tool's input schema includes an `account` enum field", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "may@dodihome.com,may.huang@gmail.com,may@keepur.io",
      });
      for (const [name, t] of registeredTools.entries()) {
        expect(t.inputSchema, `tool "${name}" should surface \`account\``).toHaveProperty("account");
      }
    });

    it("multi-account: omitting `account` routes to the first account (default)", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "may@dodihome.com,may.huang@gmail.com,may@keepur.io",
      });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("search")) {
          capturedArgs = args;
          return "[]";
        }
        return "";
      });
      await callTool("gmail_search", { query: "is:unread", max: 5 });
      const aIdx = capturedArgs.indexOf("-a");
      expect(aIdx).toBeGreaterThan(-1);
      expect(capturedArgs[aIdx + 1]).toBe("may@dodihome.com");
    });

    it("multi-account: explicit `account` overrides the default", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "may@dodihome.com,may.huang@gmail.com,may@keepur.io",
      });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("search")) {
          capturedArgs = args;
          return "[]";
        }
        return "";
      });
      await callTool("gmail_search", { query: "is:unread", max: 5, account: "may@keepur.io" });
      const aIdx = capturedArgs.indexOf("-a");
      expect(aIdx).toBeGreaterThan(-1);
      expect(capturedArgs[aIdx + 1]).toBe("may@keepur.io");
    });

    it("multi-account: `gmail_send` identity line reflects the resolved per-call account", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "may@dodihome.com,may.huang@gmail.com,may@keepur.io",
      });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("send")) return "";
        return "";
      });
      const result = await callTool("gmail_send", {
        to: "x@y.com",
        subject: "Hi",
        body: "Hello",
        account: "may.huang@gmail.com",
      });
      expect(result.content[0].text).toBe("Sent from may.huang@gmail.com.");
    });

    it("single-account: argv carries `-a <only-account>` even without an explicit param", async () => {
      await loadServer({
        GOG_PATH: "/usr/local/bin/gog",
        GOG_ACCOUNTS: "rae@dodihome.com",
      });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("search")) {
          capturedArgs = args;
          return "[]";
        }
        return "";
      });
      await callTool("gmail_search", { query: "is:unread", max: 5 });
      const aIdx = capturedArgs.indexOf("-a");
      expect(aIdx).toBeGreaterThan(-1);
      expect(capturedArgs[aIdx + 1]).toBe("rae@dodihome.com");
    });

    it("no accounts: argv carries no `-a` flag (preserves legacy gog-default behavior)", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", GOG_ACCOUNTS: "" });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("search")) {
          capturedArgs = args;
          return "[]";
        }
        return "";
      });
      await callTool("gmail_search", { query: "is:unread", max: 5 });
      expect(capturedArgs).not.toContain("-a");
    });
  });
```

- [ ] **Step 4:** Run the file.

Run: `npm run test -- src/google/google-mcp-server.test.ts`
Expected: all existing + new cases pass.

---

## Task 8: Setup wizard + credential-registry cleanup

**Files:**
- Modify: `src/setup/wizard.ts:88,343-357`
- Modify: `src/setup/credential-registry.ts:124-126`

- [ ] **Step 1:** Remove `GOOGLE_ACCOUNT` from the .env group list in `src/setup/wizard.ts:88`.

Before:

```ts
    { header: "# Google", keys: ["GOOGLE_ACCOUNT"] },
```

After:

```ts
    // KPR-242: Google account assignment now lives in hive.yaml under `google.accounts.<agent>`.
    // No env keys to write here, but the Google setup block (below) still runs gog auth verification.
```

(Leaving the comment + dropping the line is fine; the surrounding `groups` array is the source of truth.)

- [ ] **Step 2:** Rework the Google-setup prompt in `src/setup/wizard.ts:343-357`. The prompt currently writes `env.GOOGLE_ACCOUNT`; since that env var is no longer read, replace the write with a hive.yaml hint.

Before:

```ts
      // Set primary account
      env.GOOGLE_ACCOUNT = await ask("Primary Google account for Hive", env.GOOGLE_ACCOUNT || "");

      // Verify it works
      if (env.GOOGLE_ACCOUNT) {
        try {
          execFileSync(
            "gog",
            ["gmail", "search", "is:unread", "-a", env.GOOGLE_ACCOUNT, "--json", "--results-only", "--no-input"],
            { encoding: "utf-8", timeout: 15_000 },
          );
          console.log(`  ✓ Gmail access verified for ${env.GOOGLE_ACCOUNT}`);
        } catch {
          console.log(`  ⚠ Could not verify Gmail access — check authentication later`);
        }
      }
```

After:

```ts
      // KPR-242: Google access is per-agent via hive.yaml `google.accounts.<agent-id>`.
      // The wizard verifies gog auth for one account but does not persist it to .env.
      const verifyAccount = await ask(
        "Primary Google account to verify gog auth (you'll wire per-agent assignments in hive.yaml later)",
        "",
      );
      if (verifyAccount) {
        try {
          execFileSync(
            "gog",
            ["gmail", "search", "is:unread", "-a", verifyAccount, "--json", "--results-only", "--no-input"],
            { encoding: "utf-8", timeout: 15_000 },
          );
          console.log(`  ✓ Gmail access verified for ${verifyAccount}`);
          console.log(
            `  → Next: add this account to hive.yaml under \`google.accounts.<agent-id>\` for any agent that should reach it.`,
          );
        } catch {
          console.log(`  ⚠ Could not verify Gmail access — check authentication later`);
        }
      }
```

- [ ] **Step 3:** Update `src/setup/credential-registry.ts:124-126` `oauthInstructions`.

Before:

```ts
    oauthInstructions:
      "Google access uses OAuth, not an API key. After setup, run `gog auth add <your-account@gmail.com>` " +
      "to authenticate one or more accounts, then set `GOOGLE_ACCOUNT` (or `google.accounts.<agent-id>` " +
      "in hive.yaml) so agents know which mailbox to use.",
```

After:

```ts
    oauthInstructions:
      "Google access uses OAuth, not an API key. After setup, run `gog auth add <your-account@gmail.com>` " +
      "to authenticate one or more accounts, then assign them in hive.yaml under " +
      "`google.accounts.<agent-id>` — a string for a single account, a list for multi-account agents " +
      "(first entry is the default).",
```

- [ ] **Step 4:** Typecheck + run setup-related tests if any.

Run:

```bash
npm run typecheck
grep -rln "wizard\|credential-registry" src/ --include="*.test.ts" | xargs -r npm run test --
```

Expected: typecheck passes; any existing tests against these files still pass.

---

## Task 9: Architecture docs (light touch)

**Files:**
- Modify: `docs/architecture.md` (only if it mentions the spawn-time account binding)

- [ ] **Step 1:** Search for relevant lines.

```bash
grep -n "GOG_ACCOUNT\|google\.account\b\|spawn-time account\|single account at MCP-server-spawn" docs/architecture.md 2>/dev/null
```

Expected: either no matches (nothing to do, skip) or a few. If matches, update the description to say "per-call `account` parameter; first entry in `google.accounts.<agent>` is the implicit default" and keep the diff small.

- [ ] **Step 2:** Skip CLAUDE.md edits — the file does not reference Google MCP account binding and the change is too narrow to warrant a top-level entry.

---

## Task 10: Quality gate + manual smoke

- [ ] **Step 1:** Full check.

Run: `npm run check`
Expected: typecheck + lint + format + vitest all green.

- [ ] **Step 2:** Bundle (since the runtime engine runs from `pkg/server.min.js`).

Run: `npm run bundle`
Expected: passes.

- [ ] **Step 3:** Manual smoke against the dodi instance (operator-driven, after merge + deploy):

1. Edit `~/services/hive/dodi/hive.yaml` to give Mokie multi-account:
   ```yaml
   google:
     accounts:
       rae: may@dodihome.com
       mokie:
         - may@dodihome.com
         - may.huang@gmail.com
         - may@keepur.io
   ```
2. `hive update` (engine swap) then `launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent`.
3. In Slack, ask Mokie to `gmail_send` from each of the three accounts. Confirm `"Sent from <expected>."` in each response.
4. Confirm Rae still receives email with no schema-shape change visible in her toolkit prompt (sanity: `gmail_search` from Rae should not show an `account` arg in any visible toolkit listing).

- [ ] **Step 4:** Commit.

```bash
git add src/config.ts src/agents/agent-runner.ts src/google/google-mcp-server.ts \
        src/google/google-mcp-server.test.ts src/tools/instance-capabilities.ts \
        src/tools/instance-capabilities.test.ts src/agents/agent-runner.test.ts \
        src/setup/wizard.ts src/setup/credential-registry.ts src/config.test.ts
git commit -m "feat(google-mcp): per-call account parameter, drop legacy google.account (KPR-242)"
```

(Optionally split into two commits if Task 9 touches `docs/architecture.md` — keep the docs commit separate from code.)

---

## Out of scope (per spec)

- OAuth flow changes — `gog` already keys credentials by account.
- New Google scopes or tool capabilities.
- Operator UX for managing multi-account assignments (beekeeper CLI etc.) — hive.yaml edit only for now.
- `src/tools/instance-capabilities.test.ts` fixture quality cleanup beyond the minimum compile-fix (the file's `google` fixture has been semantically off for a while; not the place to fix that today).

## Refs

- Memory: `feedback_agents_use_own_name`, `feedback_no_per_tool_prompt_awareness`, `feedback_negative_verify_regression_tests`.
- Files: `src/google/google-mcp-server.ts`, `src/agents/agent-runner.ts:502-517`, `src/config.ts:150-158`.
