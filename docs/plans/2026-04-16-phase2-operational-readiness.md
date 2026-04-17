# Phase 2 — Operational Readiness Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Seed `keepur/hive-plugins` with three real installable plugins (google, linear, github) and complete `hive doctor` with config / agents / services check groups so day-one install is self-diagnosable.

**Architecture:** Track 8 publishes three standalone npm packages — each wraps an in-tree MCP server source file, declares env pass-through via `plugin.yaml`, and is installable via existing `hive plugin add` plumbing from #159. Track 11 extends `src/cli/doctor.ts` with a grouped `Check` interface (`prereq | config | agents | services`), a `--verbose` flag, programmatic required-env derivation from `src/config.ts`, structured `launchctl print` parsing, live Mongo reachability, and Slack `auth.test` probing.

**Tech Stack:** TypeScript, Node `child_process` (`execFileSync`), `mongodb` driver (already a dep), `@slack/web-api` (already a dep), `yaml`, vitest.

**Spec:** `docs/specs/2026-04-16-phase2-operational-readiness-design.md`

---

## File Map

### Track 8 (external — `keepur/hive-plugins` org repos)

| Repo | Responsibility |
|------|----------------|
| `keepur/hive-plugins` (meta) | README listing default registry contents; CI token-gated publish |
| `keepur/hive-plugin-google` (npm: `@keepur/hive-plugin-google`) | Standalone npm package wrapping `google-mcp-server.ts` |
| `keepur/hive-plugin-linear` (npm: `@keepur/hive-plugin-linear`) | Standalone npm package wrapping `linear-mcp-server.ts` + `linear-client.ts` |
| `keepur/hive-plugin-github` (npm: `@keepur/hive-plugin-github`) | Standalone npm package wrapping `github-issues-mcp-server.ts` |

### Track 11 (in-repo)

| File | Responsibility |
|------|----------------|
| `src/cli/doctor.ts` | **Rewrite** — grouped checks, new config/agents/services groups, verbose flag, resolved service path header |
| `src/cli/doctor-checks.ts` | **Create** — each check's `test` fn exported individually for unit testing |
| `src/cli/doctor-checks.test.ts` | **Create** — unit tests with mocked subprocess/HTTP/Mongo/Slack |
| `src/cli.ts` | **Modify** — parseArgs: add `verbose` option; pass to `runDoctor` |
| `docs/runbooks/fresh-install-doctor-smoke.md` | **Create** — fresh-box manual runbook |

---

## Track 8 — Default plugin registry content

Track 8 is **external to this repo**. Each plugin is its own git repo + npm package. Work is done by creating the repos, committing the standard layout, and publishing to npm (public scope: `@keepur`).

**Package layout (identical for all three):**

```
<repo-root>/
  package.json          # name, version, files: ["dist","plugin.yaml","README.md"]
  plugin.yaml           # hiveApi + mcpServers (see per-plugin below)
  tsconfig.json         # targets Node 22, outDir dist/
  src/<server>.ts       # copied from hive main repo, unmodified
  README.md             # env-var setup instructions
  .github/workflows/publish.yml  # npm publish on tag
```

`plugin.yaml` `entry:` points at `dist/<server>.js` (shipped artifact, not src). No agent seeds — these plugins only contribute an MCP server.

### Task 8.1: Create `keepur/hive-plugin-google`

**Files (external repo `keepur/hive-plugin-google`):**
- Create: `package.json`, `plugin.yaml`, `tsconfig.json`, `src/google-mcp-server.ts`, `README.md`, `.github/workflows/publish.yml`

- [ ] **Step 1:** Create repo on GitHub under the `keepur` org (private → public when ready).

```bash
gh repo create keepur/hive-plugin-google --public --description "Hive plugin: Gmail + Calendar via gog CLI"
git clone git@github.com:keepur/hive-plugin-google.git
cd hive-plugin-google
```

- [ ] **Step 2:** Add `package.json`.

```json
{
  "name": "@keepur/hive-plugin-google",
  "version": "0.1.0",
  "description": "Hive plugin: Gmail + Calendar via gog CLI",
  "type": "module",
  "files": ["dist", "plugin.yaml", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^22.0.0"
  },
  "engines": { "node": ">=22" },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 3:** Add `plugin.yaml`.

```yaml
name: "@keepur/hive-plugin-google"
description: "Gmail + Calendar access via the gog CLI"
hiveApi: "^1.0.0"
mcp-servers:
  google:
    entry: dist/google-mcp-server.js
    description: "Gmail send/search/read + Calendar event CRUD"
    usage: "Per-agent Google account access"
    env: [GOG_ACCOUNT, GOG_CLIENT]
agent-seeds: []
```

- [ ] **Step 4:** Add `tsconfig.json`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 5:** Copy `src/google-mcp-server.ts` from the hive main repo **verbatim** (no edits). Path in main repo: `/Users/mokie/github/hive-157/src/google/google-mcp-server.ts`. Target path in plugin repo: `src/google-mcp-server.ts`.

```bash
cp /Users/mokie/github/hive-157/src/google/google-mcp-server.ts src/google-mcp-server.ts
```

- [ ] **Step 6:** Add `README.md` with env-var setup.

````markdown
# @keepur/hive-plugin-google

Gmail + Calendar access for Hive agents via the [`gog`](https://github.com/dodi-hq/gog) CLI.

## Install

```bash
hive plugin add @keepur/hive-plugin-google
```

## Env vars

Add to `~/.hive/.env`:

```
GOG_ACCOUNT=you@example.com      # default Google account
GOG_CLIENT=personal              # gog OAuth client name
```

## Prereqs

- `gog` CLI installed and authenticated (`gog auth login <account>`).

## Curation

This plugin is maintained by the Keepur team and distributed via the default
`keepur/hive-plugins` registry. Third-party plugins should use their own
registries.
````

- [ ] **Step 7:** Add `.github/workflows/publish.yml`.

```yaml
name: publish
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          registry-url: "https://registry.npmjs.org"
      - run: npm ci || npm install
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 8:** Verify local build.

```bash
npm install
npm run build
ls dist/google-mcp-server.js
```

Expected: `dist/google-mcp-server.js` exists.

- [ ] **Step 9:** Commit + tag + push.

```bash
git add -A
git commit -m "feat: initial @keepur/hive-plugin-google"
git tag v0.1.0
git push origin main --tags
```

- [ ] **Step 10:** Verify npm publish succeeded.

```bash
npm view @keepur/hive-plugin-google version
```

Expected: `0.1.0`.

### Task 8.2: Create `keepur/hive-plugin-linear`

**Files (external repo `keepur/hive-plugin-linear`):**
- Create: `package.json`, `plugin.yaml`, `tsconfig.json`, `src/linear-mcp-server.ts`, `src/linear-client.ts`, `README.md`, `.github/workflows/publish.yml`

- [ ] **Step 1:** Repeat the 10-step flow from Task 8.1 with these differences:
  - `package.json#name`: `@keepur/hive-plugin-linear`.
  - `package.json#description`: `"Hive plugin: Linear issue tracking"`.
  - Copy **both** `src/linear/linear-mcp-server.ts` AND `src/linear/linear-client.ts` from hive main into the plugin's `src/`. The server imports `./linear-client.js` — the relative import resolves after the copy without modification.
  - `plugin.yaml`:

```yaml
name: "@keepur/hive-plugin-linear"
description: "Linear issue tracking (teams, issues, states, cycles)"
hiveApi: "^1.0.0"
mcp-servers:
  linear:
    entry: dist/linear-mcp-server.js
    description: "Linear teams, issues, workflow states, cycles"
    usage: "Issue tracking on Linear"
    env: [LINEAR_API_KEY, LINEAR_TEAM_ID]
agent-seeds: []
```

  - `README.md` env section:

```
LINEAR_API_KEY=lin_api_...    # required
LINEAR_TEAM_ID=...            # optional — agents can discover via linear_list_teams
```

- [ ] **Step 2:** Verify.

```bash
npm view @keepur/hive-plugin-linear version
```

Expected: `0.1.0`.

### Task 8.3: Create `keepur/hive-plugin-github`

**Files (external repo `keepur/hive-plugin-github`):**
- Create: `package.json`, `plugin.yaml`, `tsconfig.json`, `src/github-issues-mcp-server.ts`, `README.md`, `.github/workflows/publish.yml`

- [ ] **Step 1:** Repeat the Task 8.1 flow with:
  - `package.json#name`: `@keepur/hive-plugin-github`.
  - Copy `src/github/github-issues-mcp-server.ts` verbatim.
  - `plugin.yaml`:

```yaml
name: "@keepur/hive-plugin-github"
description: "GitHub Issues tracking via gh CLI"
hiveApi: "^1.0.0"
mcp-servers:
  github:
    entry: dist/github-issues-mcp-server.js
    description: "GitHub Issues CRUD + label management"
    usage: "Issue tracking on GitHub"
    env: [GITHUB_REPO, GH_TOKEN]
agent-seeds: []
```

  Note: spec lists only `GH_TOKEN`; `GITHUB_REPO` is also required by the server (`process.exit(1)` if missing). Declaring both keeps doctor/env inspection honest.

  - `README.md` env section:

```
GITHUB_REPO=owner/repo         # required
GH_TOKEN=ghp_...               # optional if gh CLI is already authed
```

- [ ] **Step 2:** Verify.

```bash
npm view @keepur/hive-plugin-github version
```

Expected: `0.1.0`.

### Task 8.4: Create `keepur/hive-plugins` meta repo

**Files (external repo `keepur/hive-plugins`):**
- Create: `README.md`, `plugins.json`

- [ ] **Step 1:** Create repo.

```bash
gh repo create keepur/hive-plugins --public --description "Default plugin registry for Hive"
```

- [ ] **Step 2:** Add `plugins.json` (index consumed by future `hive plugin search`; fine to ship as static JSON now).

```json
{
  "plugins": [
    { "name": "@keepur/hive-plugin-google", "description": "Gmail + Calendar via gog CLI" },
    { "name": "@keepur/hive-plugin-linear", "description": "Linear issue tracking" },
    { "name": "@keepur/hive-plugin-github", "description": "GitHub Issues tracking" }
  ]
}
```

- [ ] **Step 3:** Add `README.md`.

```markdown
# keepur/hive-plugins

Default plugin registry for [Hive](https://github.com/keepur/hive).

## Plugins

- `@keepur/hive-plugin-google` — Gmail + Calendar via gog CLI
- `@keepur/hive-plugin-linear` — Linear issue tracking
- `@keepur/hive-plugin-github` — GitHub Issues tracking

## Curation

This is a **write-gated** registry — only dodi-hq maintainers push to it.
Third-party plugins should use their own registries or raw-URL dev-mode install;
they will not land here. See CLAUDE.md security posture for rationale.
```

- [ ] **Step 4:** Commit + push.

```bash
git add -A && git commit -m "feat: initial keepur/hive-plugins registry" && git push origin main
```

### Task 8.5: End-to-end install verification

- [ ] **Step 1:** On a fresh hive dev instance, install the google plugin.

```bash
hive plugin add @keepur/hive-plugin-google
```

Expected output: `Installing @keepur/hive-plugin-google...` → `✓ Updated hive.yaml` → `✓ Installed @keepur/hive-plugin-google (v0.1.0, hiveApi ^1.0.0)`.

- [ ] **Step 2:** Verify manifest + list.

```bash
hive plugin list
ls ~/.hive/plugins/node_modules/@keepur/hive-plugin-google/plugin.yaml
```

Expected: `@keepur/hive-plugin-google  v0.1.0  (hiveApi ^1.0.0)`; manifest file exists.

- [ ] **Step 3:** Repeat for linear and github.

```bash
hive plugin add @keepur/hive-plugin-linear
hive plugin add @keepur/hive-plugin-github
hive plugin list
```

- [ ] **Step 4:** Assign the new google server to an agent (via admin MCP or REST) and confirm agent can call a google tool end-to-end on the dev instance.

- [ ] **Step 5:** Commit any `hive.yaml` changes (if this instance's config lives in git; otherwise none).

---

## Track 11 — `hive doctor` completion

### Task 11.1: Extract check definitions into a testable module

**Files:**
- Create: `src/cli/doctor-checks.ts`

- [ ] **Step 1:** Create `src/cli/doctor-checks.ts`. Export the `Check` type plus a factory per group. Each `test` fn is exported individually so tests can call it with injected mocks via `vi.mock`.

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CheckGroup = "prereq" | "config" | "agents" | "services";

export interface Check {
  name: string;
  group: CheckGroup;
  required: boolean;
  test: () => boolean | Promise<boolean>;
  remedy?: string;
}

// ── helpers ─────────────────────────────────────────────────────────────

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function brewServiceRunning(name: string): boolean {
  try {
    const out = execFileSync("brew", ["services", "list"], { encoding: "utf-8" });
    return out.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch {
    return false;
  }
}

export async function httpProbe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ── required-env derivation from config.ts source ──────────────────────

/**
 * Scan src/config.ts source for `required("KEY")` call sites so the doctor's
 * env check mirrors the config loader exactly. Spec #157: do not hardcode —
 * `ANTHROPIC_API_KEY`, `MONGODB_URI`, `BG_TASK_AUTH_TOKEN` are optional-with-
 * fallback and must not false-positive.
 */
export function requiredEnvVarsFromConfig(configTsPath: string): string[] {
  const src = readFileSync(configTsPath, "utf-8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/\brequired\(\s*"([A-Z0-9_]+)"\s*\)/g)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

// ── launchctl print parsing ─────────────────────────────────────────────

export interface LaunchdState {
  loaded: boolean;
  state: "running" | "not running" | "unknown";
  pid: number | null;
}

export function launchctlPrint(label: string): LaunchdState {
  const uid = process.getuid?.();
  if (uid === undefined) return { loaded: false, state: "unknown", pid: null };
  try {
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stateMatch = out.match(/state\s*=\s*(\S+)/);
    const pidMatch = out.match(/pid\s*=\s*(\d+)/);
    const state =
      stateMatch?.[1] === "running" ? "running" : stateMatch?.[1] === "not running" ? "not running" : "unknown";
    return {
      loaded: true,
      state,
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
    };
  } catch {
    return { loaded: false, state: "unknown", pid: null };
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── live checks ────────────────────────────────────────────────────────

export async function mongoReachable(uri: string, dbName: string, timeoutMs = 2000): Promise<boolean> {
  // Dynamic import so unit tests can mock without pulling the driver at module load.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function hasAnyAgent(uri: string, dbName: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const count = await client.db(dbName).collection("agent_definitions").estimatedDocumentCount();
    return count > 0;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function defaultAgentExists(uri: string, dbName: string, defaultAgent: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const doc = await client.db(dbName).collection("agent_definitions").findOne({ id: defaultAgent });
    return doc !== null;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function slackAuthOk(botToken: string): Promise<boolean> {
  if (!botToken) return false;
  const { WebClient } = await import("@slack/web-api");
  try {
    const res = await new WebClient(botToken).auth.test();
    return res.ok === true;
  } catch {
    return false;
  }
}

// ── resolved paths ─────────────────────────────────────────────────────

/** Expand ~ in a path. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, process.env.HOME ?? "");
}

/** Resolve the service path that the LaunchAgent actually points at by reading
 *  the plist WorkingDirectory. Returns null if the plist cannot be read. */
export function resolveServicePath(label = "com.hive.agent"): string | null {
  const plist = expandHome(`~/Library/LaunchAgents/${label}.plist`);
  if (!existsSync(plist)) return null;
  const raw = readFileSync(plist, "utf-8");
  const m = raw.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? resolve(expandHome(m[1])) : null;
}
```

- [ ] **Step 2:** Verify compile.

```bash
npx tsc --noEmit
```

Expected: no errors.

### Task 11.2: Rewrite `src/cli/doctor.ts` to use grouped checks

**Files:**
- Modify: `src/cli/doctor.ts`

- [ ] **Step 1:** Replace the entire file with the grouped version. Preserves prereq check list verbatim, adds config/agents/services, accepts `{ verbose }` options, prints resolved service path, exits non-zero on required failure.

```typescript
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  type Check,
  type CheckGroup,
  brewServiceRunning,
  commandExists,
  defaultAgentExists,
  hasAnyAgent,
  httpProbe,
  launchctlPrint,
  mongoReachable,
  pidAlive,
  requiredEnvVarsFromConfig,
  resolveServicePath,
  slackAuthOk,
} from "./doctor-checks.js";
import { config } from "../config.js";
import { hiveHome } from "../paths.js";

const GROUP_TITLES: Record<CheckGroup, string> = {
  prereq: "Prereqs",
  config: "Config",
  agents: "Agents",
  services: "Services",
};

export async function runDoctor(opts: { verbose?: boolean } = {}): Promise<void> {
  const verbose = !!opts.verbose;

  // Resolved service path header — spec: doctor inspects the deploy clone via
  // LaunchAgent, which may differ from the CWD. Print both up front.
  const servicePath = resolveServicePath("com.hive.agent");
  console.log(`hive doctor`);
  console.log(`  cwd:          ${process.cwd()}`);
  console.log(`  hive home:    ${hiveHome}`);
  console.log(`  service path: ${servicePath ?? "(LaunchAgent plist not found)"}`);
  console.log("");

  const requiredEnv = requiredEnvVarsFromConfig(resolve(import.meta.dirname, "../config.ts"));

  const checks: Check[] = [
    // ── Prereqs (preserved from existing doctor) ─────────────────────────
    {
      name: "Node.js >= 22",
      group: "prereq",
      required: true,
      test: () => parseInt(process.versions.node.split(".")[0]) >= 22,
      remedy: "Install Node 22+: brew install node@22 && brew link --overwrite node@22",
    },
    { name: "Homebrew", group: "prereq", required: true, test: () => commandExists("brew"),
      remedy: "Install: /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" },
    { name: "MongoDB (brew services)", group: "prereq", required: true, test: () => brewServiceRunning("mongodb-community"),
      remedy: "brew services start mongodb-community  # informational; live reachability is checked under Agents" },
    { name: "Ollama", group: "prereq", required: true, test: () => httpProbe("http://127.0.0.1:11434/api/tags"),
      remedy: "brew install ollama && brew services start ollama" },
    {
      name: "Ollama models (bge-large, gemma4:e4b)",
      group: "prereq",
      required: true,
      test: () => {
        if (!commandExists("ollama")) return false;
        try {
          const list = execFileSync("ollama", ["list"], { encoding: "utf-8" });
          return list.includes("bge-large") && list.includes("gemma4:e4b");
        } catch {
          return false;
        }
      },
      remedy: "ollama pull bge-large && ollama pull gemma4:e4b",
    },
    { name: "Qdrant", group: "prereq", required: true, test: () => httpProbe("http://127.0.0.1:6333/"),
      remedy: "brew install qdrant && brew services start qdrant" },
    { name: "gh CLI", group: "prereq", required: false, test: () => commandExists("gh") },
    { name: "gog CLI", group: "prereq", required: false, test: () => commandExists("gog") },
    {
      name: "Xcode CLI Tools",
      group: "prereq",
      required: true,
      test: () => {
        try {
          execFileSync("xcode-select", ["-p"], { encoding: "utf-8" });
          return true;
        } catch {
          return false;
        }
      },
      remedy: "xcode-select --install",
    },
    // ── Config ───────────────────────────────────────────────────────────
    {
      name: "hive.yaml loads",
      group: "config",
      required: true,
      // If we got here, `import { config }` already succeeded. Use a trivial
      // truthy check — schema validation is performed by config.ts on import.
      test: () => typeof config.instance?.id === "string" && config.instance.id.length > 0,
      remedy: "Check hive.yaml at the hive home and run `hive init` if missing.",
    },
    ...requiredEnv.map<Check>((key) => ({
      name: `env: ${key}`,
      group: "config",
      required: true,
      test: () => !!process.env[key],
      remedy: `Set ${key} in ~/.hive/.env`,
    })),
    // ── Agents ───────────────────────────────────────────────────────────
    {
      name: "MongoDB reachable",
      group: "agents",
      required: true,
      test: () => mongoReachable(config.mongo.uri, config.mongo.dbName),
      remedy: "Start Mongo (`brew services start mongodb-community`) and verify MONGODB_URI.",
    },
    {
      name: "At least one agent exists",
      group: "agents",
      required: true,
      test: () => hasAnyAgent(config.mongo.uri, config.mongo.dbName),
      remedy: "Run `npm run setup:seeds` to import plugin agent seeds.",
    },
    {
      name: `default agent exists (${config.defaultAgent})`,
      group: "agents",
      required: true,
      test: () => defaultAgentExists(config.mongo.uri, config.mongo.dbName, config.defaultAgent),
      remedy: `Set DEFAULT_AGENT to an existing agent id or seed '${config.defaultAgent}'.`,
    },
    // ── Services ─────────────────────────────────────────────────────────
    {
      name: "LaunchAgent com.hive.agent running",
      group: "services",
      required: true,
      test: () => {
        const st = launchctlPrint("com.hive.agent");
        return st.loaded && st.state === "running" && st.pid !== null && pidAlive(st.pid);
      },
      remedy: "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hive.agent.plist && launchctl kickstart -k gui/$(id -u)/com.hive.agent",
    },
    {
      name: "Slack auth.test",
      group: "services",
      required: true,
      test: () => slackAuthOk(config.slack.botToken),
      remedy: "Verify SLACK_BOT_TOKEN in .env and that the token still has the expected scopes.",
    },
  ];

  let allPassed = true;
  let currentGroup: CheckGroup | null = null;
  for (const check of checks) {
    if (check.group !== currentGroup) {
      console.log(`\n${GROUP_TITLES[check.group]}`);
      currentGroup = check.group;
    }
    const ok = await check.test();
    const icon = ok ? "✓" : check.required ? "✗" : "○";
    const label = check.required ? "" : " (optional)";
    console.log(`  ${icon} ${check.name}${label}`);
    if (!ok && verbose && check.remedy) {
      console.log(`      → ${check.remedy}`);
    }
    if (!ok && check.required) allPassed = false;
  }

  if (!allPassed) {
    console.log("\nSome required checks failed. Run with --verbose for remedy hints.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}
```

- [ ] **Step 2:** Verify compile.

```bash
npx tsc --noEmit
```

Expected: no errors.

### Task 11.3: Wire `--verbose` into `src/cli.ts`

**Files:**
- Modify: `src/cli.ts:6-14` (parseArgs options), `src/cli.ts:109-113` (doctor case)

- [ ] **Step 1:** Add a `verbose` option.

Replace the `options` block in `parseArgs`:

```typescript
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    daemon: { type: "boolean", default: false },
    config: { type: "string" },
    version: { type: "boolean", short: "v", default: false },
    verbose: { type: "boolean", default: false },
  },
});
```

- [ ] **Step 2:** Pass `verbose` into `runDoctor`.

Replace the doctor case:

```typescript
  case "doctor": {
    const { runDoctor } = await import("./cli/doctor.js");
    await runDoctor({ verbose: !!values.verbose });
    break;
  }
```

- [ ] **Step 3:** Verify wiring.

```bash
npm run build && node dist/cli.js doctor --verbose 2>&1 | head -20
```

Expected: section headers `Prereqs`, `Config`, `Agents`, `Services` appear; any failure line is followed by `→ <remedy>`.

### Task 11.4: Unit tests for check modules

**Files:**
- Create: `src/cli/doctor-checks.test.ts`

- [ ] **Step 1:** Write tests covering each check's pass/fail path with mocks. Tests do not hit real Mongo, Slack, or launchctl.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  launchctlPrint,
  pidAlive,
  requiredEnvVarsFromConfig,
  resolveServicePath,
} from "./doctor-checks.js";

// execFileSync and fetch are mocked per-test via vi.mock for subprocess checks.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});
import { execFileSync } from "node:child_process";
const execMock = vi.mocked(execFileSync);

describe("requiredEnvVarsFromConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("extracts only required() keys, ignoring optional()", () => {
    const p = join(dir, "config.ts");
    writeFileSync(p, `
      const a = required("SLACK_APP_TOKEN");
      const b = required("SLACK_BOT_TOKEN");
      const c = optional("ANTHROPIC_API_KEY", "");
      const d = optional("MONGODB_URI", "mongodb://localhost:27017");
    `);
    expect(requiredEnvVarsFromConfig(p)).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  });
});

describe("launchctlPrint", () => {
  beforeEach(() => execMock.mockReset());

  it("parses running + pid", () => {
    execMock.mockReturnValueOnce(`{
      state = running
      pid = 12345
    }` as unknown as Buffer);
    const st = launchctlPrint("com.hive.agent");
    expect(st).toEqual({ loaded: true, state: "running", pid: 12345 });
  });

  it("parses not-running state", () => {
    execMock.mockReturnValueOnce(`{
      state = not running
    }` as unknown as Buffer);
    expect(launchctlPrint("com.hive.agent")).toEqual({ loaded: true, state: "not running", pid: null });
  });

  it("returns loaded:false when launchctl fails (agent not bootstrapped)", () => {
    execMock.mockImplementationOnce(() => { throw new Error("Could not find service"); });
    expect(launchctlPrint("com.hive.agent")).toEqual({ loaded: false, state: "unknown", pid: null });
  });
});

describe("pidAlive", () => {
  it("returns true for live pid (self)", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
  it("returns false for dead pid", () => {
    expect(pidAlive(999999)).toBe(false);
  });
});

describe("resolveServicePath", () => {
  it("returns null when plist is missing", () => {
    // LaunchAgent plist path is constant, just expect a non-throw.
    const p = resolveServicePath("com.hive.nonexistent.agent");
    expect(p).toBeNull();
  });
});

// ── mongoReachable / hasAnyAgent / defaultAgentExists ────────────────────

vi.mock("mongodb", () => {
  const ping = vi.fn();
  const estimatedDocumentCount = vi.fn();
  const findOne = vi.fn();
  const collection = vi.fn(() => ({ estimatedDocumentCount, findOne }));
  const command = vi.fn((cmd: unknown) => ping(cmd));
  const db = vi.fn(() => ({ command, collection }));
  const connect = vi.fn();
  const close = vi.fn();
  const MongoClient = vi.fn(() => ({ connect, db, close }));
  return { MongoClient, __mocks: { connect, close, ping, estimatedDocumentCount, findOne } };
});

import * as mongodb from "mongodb";
const mongoMocks = (mongodb as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
import { mongoReachable, hasAnyAgent, defaultAgentExists } from "./doctor-checks.js";

describe("mongoReachable", () => {
  beforeEach(() => {
    mongoMocks.connect.mockReset();
    mongoMocks.close.mockReset().mockResolvedValue(undefined);
    mongoMocks.ping.mockReset();
  });

  it("returns true when ping succeeds", async () => {
    mongoMocks.connect.mockResolvedValue(undefined);
    mongoMocks.ping.mockResolvedValue({ ok: 1 });
    await expect(mongoReachable("mongodb://x", "hive_test")).resolves.toBe(true);
  });

  it("returns false when connect throws", async () => {
    mongoMocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(mongoReachable("mongodb://x", "hive_test")).resolves.toBe(false);
  });
});

describe("hasAnyAgent / defaultAgentExists", () => {
  beforeEach(() => {
    mongoMocks.connect.mockReset().mockResolvedValue(undefined);
    mongoMocks.close.mockReset().mockResolvedValue(undefined);
    mongoMocks.estimatedDocumentCount.mockReset();
    mongoMocks.findOne.mockReset();
  });

  it("hasAnyAgent true when count>0", async () => {
    mongoMocks.estimatedDocumentCount.mockResolvedValue(3);
    await expect(hasAnyAgent("mongodb://x", "hive_test")).resolves.toBe(true);
  });
  it("hasAnyAgent false when count=0", async () => {
    mongoMocks.estimatedDocumentCount.mockResolvedValue(0);
    await expect(hasAnyAgent("mongodb://x", "hive_test")).resolves.toBe(false);
  });
  it("defaultAgentExists true when doc found", async () => {
    mongoMocks.findOne.mockResolvedValue({ id: "chief-of-staff" });
    await expect(defaultAgentExists("mongodb://x", "hive_test", "chief-of-staff")).resolves.toBe(true);
  });
  it("defaultAgentExists false when doc missing", async () => {
    mongoMocks.findOne.mockResolvedValue(null);
    await expect(defaultAgentExists("mongodb://x", "hive_test", "ghost")).resolves.toBe(false);
  });
});

// ── slackAuthOk ─────────────────────────────────────────────────────────

vi.mock("@slack/web-api", () => {
  const test = vi.fn();
  const WebClient = vi.fn(() => ({ auth: { test } }));
  return { WebClient, __test: test };
});
import * as slack from "@slack/web-api";
const slackTest = (slack as unknown as { __test: ReturnType<typeof vi.fn> }).__test;
import { slackAuthOk } from "./doctor-checks.js";

describe("slackAuthOk", () => {
  beforeEach(() => slackTest.mockReset());

  it("returns false when token is empty (skips HTTP)", async () => {
    await expect(slackAuthOk("")).resolves.toBe(false);
    expect(slackTest).not.toHaveBeenCalled();
  });
  it("returns true when auth.test ok", async () => {
    slackTest.mockResolvedValue({ ok: true });
    await expect(slackAuthOk("xoxb-x")).resolves.toBe(true);
  });
  it("returns false when auth.test ok=false", async () => {
    slackTest.mockResolvedValue({ ok: false });
    await expect(slackAuthOk("xoxb-x")).resolves.toBe(false);
  });
  it("returns false when auth.test throws", async () => {
    slackTest.mockRejectedValue(new Error("invalid_auth"));
    await expect(slackAuthOk("xoxb-x")).resolves.toBe(false);
  });
});
```

- [ ] **Step 2:** Run tests.

```bash
npx vitest run src/cli/doctor-checks.test.ts
```

Expected: all tests pass.

### Task 11.5: Fresh-install runbook

**Files:**
- Create: `docs/runbooks/fresh-install-doctor-smoke.md`

- [ ] **Step 1:** Write the runbook.

````markdown
# Fresh-install `hive doctor` smoke test

Manually executed before merging #157. Confirms each required check in
`hive doctor` produces the expected failure and remedy on a clean box.

## Setup

1. Create a fresh Mac user account (or a sandbox account with empty HOME).
2. Clone hive at `~/github/hive`.
3. **Do not** install prereqs, create `.env`, or start services.
4. `npm install && npm run build`.

## Procedure

Run each step, confirm the listed output appears, then fix before moving on.

| Step | State | Expected failing checks (with `--verbose`) |
|------|-------|-------------------------------------------|
| 1 | Nothing installed | Node ≥22 (if system Node is old), Homebrew, MongoDB, Ollama, Ollama models, Qdrant, Xcode CLI tools |
| 2 | brew + services installed, no `.env` | `hive.yaml loads` ✗, all `env: *` lines ✗ |
| 3 | `.env` populated with required keys, no Mongo yet | `MongoDB reachable` ✗ with its remedy |
| 4 | Mongo running, empty DB | `At least one agent exists` ✗, `default agent exists` ✗ |
| 5 | `npm run setup:seeds` run | Agents group green; `LaunchAgent com.hive.agent running` ✗ |
| 6 | `hive start --daemon` | `LaunchAgent` green; `Slack auth.test` ✗ if SLACK_BOT_TOKEN invalid |
| 7 | Valid Slack token | All green |

For each ✗ row, verify the `--verbose` remedy text matches the remedy
registered in `src/cli/doctor.ts`.

## Sign-off

Record the operator name + date at the bottom of the PR description before merging.
````

- [ ] **Step 2:** No automated verification — this is a manual runbook referenced by the PR description.

### Task 11.6: Full quality gate

- [ ] **Step 1:** Run the repo's check suite.

```bash
npm run check
```

Expected: typecheck + lint + format + tests all pass.

- [ ] **Step 2:** Dev-instance smoke.

```bash
node dist/cli.js doctor
node dist/cli.js doctor --verbose
```

Expected on a healthy dev box: every group green, exit 0. With `--verbose`, no remedy lines (nothing failed).

- [ ] **Step 3:** Deploy-instance smoke.

```bash
cd ~/services/hive
node dist/cli.js doctor
```

Expected: header prints `service path: /Users/mokie/services/hive`; all groups green.

- [ ] **Step 4:** Execute the fresh-install runbook (Task 11.5) and record operator/date.

### Task 11.7: Commit

- [ ] **Step 1:** Commit Track 11 in-repo work.

```bash
git add src/cli/doctor.ts src/cli/doctor-checks.ts src/cli/doctor-checks.test.ts src/cli.ts docs/runbooks/fresh-install-doctor-smoke.md
git commit -m "feat(doctor): config/agents/services check groups + verbose remedies (#157)"
```

- [ ] **Step 2:** Open the PR referencing #157 and the spec; include the fresh-install runbook sign-off in the PR description.

---

## Done-when (from spec)

- [ ] `keepur/hive-plugins` meta repo exists; three `@keepur/hive-plugin-*` packages installable via `hive plugin add` on a fresh instance
- [ ] `hive doctor` on a healthy box is all green; each required failure path is confirmed via the fresh-install runbook with its expected remedy
- [ ] Unit tests cover each new check's failure modes with mocked side effects
- [ ] `npm run check` passes
- [ ] Manual smoke on dev + deploy instances
