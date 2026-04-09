# npm Distribution Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Package Hive as `@keepur/hive` on npm — minified esbuild bundles, CLI-driven install, no source code visibility.

**Architecture:** Two-stage build (tsc → dist/, esbuild → pkg/). New `src/cli.ts` entry point with subcommands. Config resolution gains `HIVE_HOME` support (defaults to `~/.hive/`). Agent runner's ~24 `resolve("dist/...")` calls refactored to use `import.meta.dirname` for package-relative paths. Plugin MCP servers resolve from `~/.hive/plugins/`. Core ships one default agent seed (chief-of-staff).

**Tech Stack:** esbuild, Node 22+ `parseArgs`, launchd plists, `execFileSync` (DOD-212)

---

### Task 1: Config Resolution — HIVE_HOME Support

**Files:**
- Modify: `src/config.ts:1-31`
- Create: `src/paths.ts`
- Test: `src/tests/paths.test.ts`

This task adds `HIVE_HOME` resolution to config loading while preserving full backward compatibility with `HIVE_CONFIG`.

- [ ] **Step 1:** Create `src/paths.ts` — central path resolution module

```typescript
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const home = process.env.HOME ?? "/tmp";

/**
 * Resolve the Hive home directory.
 *
 * Priority:
 *   1. HIVE_HOME env var (explicit — always wins)
 *   2. ./hive.yaml in cwd (project-local / dev repo mode)
 *   3. ~/.hive/ (default for npm installs)
 */
export function resolveHiveHome(): string {
  if (process.env.HIVE_HOME) return resolve(process.env.HIVE_HOME);
  if (existsSync(resolve(process.cwd(), "hive.yaml"))) return process.cwd();
  return resolve(home, ".hive");
}

/**
 * Resolve config file path within a hive home.
 * HIVE_CONFIG selects the config file (e.g., hive-personal.yaml).
 */
export function resolveConfigFile(hiveHome: string): string {
  const configFile = process.env.HIVE_CONFIG || "hive.yaml";
  return resolve(hiveHome, configFile);
}

/**
 * Resolve .env file path matching the config file.
 * hive-personal.yaml → .env-personal, hive.yaml → .env
 */
export function resolveDotenvPath(hiveHome: string): string {
  const configFile = process.env.HIVE_CONFIG || "hive.yaml";
  const suffix = configFile.match(/^hive-(.+)\.yaml$/)?.[1];
  return resolve(hiveHome, suffix ? `.env-${suffix}` : ".env");
}

/** The resolved hive home directory (computed once at import time). */
export const hiveHome = resolveHiveHome();

// packageRoot not needed — agent-runner computes DIST_DIR from import.meta.dirname directly
```

- [ ] **Step 2:** Update `src/config.ts` to use `paths.ts`

Replace lines 1-31:

```typescript
import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { AUTONOMY_DEFAULTS } from "./agents/autonomy.js";
import { hiveHome, resolveConfigFile, resolveDotenvPath } from "./paths.js";

// Load .env from resolved hive home
const dotenvPath = resolveDotenvPath(hiveHome);
dotenv.config({ path: dotenvPath });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

// Load hive.yaml from resolved hive home
const hiveConfigPath = resolveConfigFile(hiveHome);
let hive: Record<string, any> = {};
if (existsSync(hiveConfigPath)) {
  hive = parseYaml(readFileSync(hiveConfigPath, "utf-8")) ?? {};
}

const home = process.env.HOME ?? "/tmp";
```

- [ ] **Step 3:** Write test for path resolution

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve } from "node:path";

describe("resolveHiveHome", () => {
  beforeEach(() => {
    vi.resetModules();  // Clear module cache so re-imports pick up env changes
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses HIVE_HOME env var when set", async () => {
    vi.stubEnv("HIVE_HOME", "/custom/hive");
    const { resolveHiveHome } = await import("../paths.js");
    expect(resolveHiveHome()).toBe("/custom/hive");
  });

  it("uses cwd when hive.yaml exists there", async () => {
    vi.stubEnv("HIVE_HOME", "");
    const fs = await import("node:fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const { resolveHiveHome } = await import("../paths.js");
    expect(resolveHiveHome()).toBe(process.cwd());
  });

  it("falls back to ~/.hive/", async () => {
    vi.stubEnv("HIVE_HOME", "");
    const fs = await import("node:fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const { resolveHiveHome } = await import("../paths.js");
    const home = process.env.HOME ?? "/tmp";
    expect(resolveHiveHome()).toBe(resolve(home, ".hive"));
  });
});

describe("resolveDotenvPath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns .env for default config", async () => {
    vi.stubEnv("HIVE_CONFIG", "");
    const { resolveDotenvPath } = await import("../paths.js");
    expect(resolveDotenvPath("/home/hive")).toBe("/home/hive/.env");
  });

  it("returns .env-personal for hive-personal.yaml", async () => {
    vi.stubEnv("HIVE_CONFIG", "hive-personal.yaml");
    const { resolveDotenvPath } = await import("../paths.js");
    expect(resolveDotenvPath("/home/hive")).toBe("/home/hive/.env-personal");
  });
});
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npx vitest run src/tests/paths.test.ts`
Expected: all tests pass

- [ ] **Step 5:** Commit

```bash
git add src/paths.ts src/config.ts src/tests/paths.test.ts
git commit -m "feat(config): add HIVE_HOME resolution with backward compat (#109)"
```

---

### Task 2: Agent Runner MCP Path Refactor

**Files:**
- Modify: `src/agents/agent-runner.ts:1-10,175-625,791-819`

Refactor all 24 `resolve("dist/...")` calls to use package-relative paths via `import.meta.dirname`. Also fix `brave-search-mcp` resolution to use `createRequire`, and plugin MCP + SDK plugin paths to support `~/.hive/plugins/`.

- [ ] **Step 1:** Add imports and path constants at top of `agent-runner.ts`

Add after existing imports:

```typescript
import { createRequire } from "node:module";
import { hiveHome } from "../paths.js";
```

Add a helper constant inside the `AgentRunner` class (or at module scope near the top of the file, after imports):

```typescript
/**
 * Base directory for built-in MCP server bundles.
 *
 * In dev mode (running from repo): <repo>/dist/
 * In npm package mode:             <package>/pkg/
 *
 * import.meta.dirname resolves to the directory of the compiled JS file:
 *   - Dev: <repo>/dist/agents/  → parent = <repo>/dist/
 *   - npm: <package>/pkg/       → server.min.js is in pkg/, so parent = <package>/pkg/../ but
 *     since the bundled server.min.js is at pkg/server.min.js, dirname = pkg/
 *
 * We detect mode by checking for pkg/mcp/ existence.
 */
const DIST_DIR = existsSync(resolve(import.meta.dirname, "mcp"))
  ? import.meta.dirname                                    // npm: we're in pkg/
  : resolve(import.meta.dirname, "..");                    // dev: we're in dist/agents/, go up to dist/
```

- [ ] **Step 2:** Create an `mcpPath` helper function (module-level in agent-runner.ts)

Use an explicit mapping table instead of regex derivation — the bundle names don't always match
the source filenames (e.g., `conversation-search-mcp-server.js` → `search-conversation.min.js`).

```typescript
/**
 * Explicit mapping from dev subpaths to pkg bundle names.
 * Keys = dev-mode path relative to dist/, Values = bundle name under pkg/mcp/.
 * This avoids fragile regex-based name derivation.
 */
const MCP_BUNDLE_MAP: Record<string, string> = {
  "memory/memory-mcp-server.js": "memory.min.js",
  "memory/structured-memory-mcp-server.js": "structured-memory.min.js",
  "keychain/keychain-mcp-server.js": "keychain.min.js",
  "google/google-mcp-server.js": "google.min.js",
  "quo/quo-mcp-server.js": "quo.min.js",
  "voice/voice-mcp-server.js": "voice.min.js",
  "contacts/contacts-mcp-server.js": "contacts.min.js",
  "tasks/task-mcp-server.js": "task.min.js",
  "resend/resend-mcp-server.js": "resend.min.js",
  "linear/linear-mcp-server.js": "linear.min.js",
  "github/github-issues-mcp-server.js": "github-issues.min.js",
  "clickup/clickup-mcp-server.js": "clickup.min.js",
  "recall/recall-mcp-server.js": "recall.min.js",
  "background/background-task-mcp-server.js": "background-task.min.js",
  "callback/callback-mcp-server.js": "callback.min.js",
  "code-task/code-task-mcp-server.js": "code-task.min.js",
  "search/conversation-search-mcp-server.js": "search-conversation.min.js",
  "code-index/code-search-mcp-server.js": "code-search.min.js",
  "events/event-bus-mcp-server.js": "event-bus.min.js",
  "team/team-mcp-server.js": "team.min.js",
  "workflow/workflow-mcp-server.js": "workflow.min.js",
  "schedule/schedule-mcp-server.js": "schedule.min.js",
  "admin/admin-mcp-server.js": "admin.min.js",
};

/**
 * Resolve a built-in MCP server path.
 * Dev mode:  DIST_DIR = <repo>/dist/  → dist/memory/memory-mcp-server.js
 * npm mode:  DIST_DIR = <package>/pkg/ → pkg/mcp/memory.min.js
 */
function mcpPath(devSubpath: string): string {
  // Check for minified bundle first (npm package mode)
  const bundleName = MCP_BUNDLE_MAP[devSubpath];
  if (bundleName) {
    const pkgBundle = resolve(DIST_DIR, "mcp", bundleName);
    if (existsSync(pkgBundle)) return pkgBundle;
  }

  // Fall back to dev mode path
  return resolve(DIST_DIR, devSubpath);
}
```

- [ ] **Step 3:** Replace all 23 built-in `resolve("dist/...")` calls

Replace each `resolve("dist/<subdir>/<file>.js")` with `mcpPath("<subdir>/<file>.js")`. Full list:

| Line | Old | New |
|------|-----|-----|
| 192 | `resolve("dist/memory/memory-mcp-server.js")` | `mcpPath("memory/memory-mcp-server.js")` |
| 204 | `resolve("dist/memory/structured-memory-mcp-server.js")` | `mcpPath("memory/structured-memory-mcp-server.js")` |
| 220 | `resolve("dist/keychain/keychain-mcp-server.js")` | `mcpPath("keychain/keychain-mcp-server.js")` |
| 230 | `resolve("dist/google/google-mcp-server.js")` | `mcpPath("google/google-mcp-server.js")` |
| 245 | `resolve("dist/quo/quo-mcp-server.js")` | `mcpPath("quo/quo-mcp-server.js")` |
| 263 | `resolve("dist/voice/voice-mcp-server.js")` | `mcpPath("voice/voice-mcp-server.js")` |
| 278 | `resolve("dist/contacts/contacts-mcp-server.js")` | `mcpPath("contacts/contacts-mcp-server.js")` |
| 291 | `resolve("dist/tasks/task-mcp-server.js")` | `mcpPath("tasks/task-mcp-server.js")` |
| 322 | `resolve("dist/resend/resend-mcp-server.js")` | `mcpPath("resend/resend-mcp-server.js")` |
| 344 | `resolve("dist/linear/linear-mcp-server.js")` | `mcpPath("linear/linear-mcp-server.js")` |
| 360 | `resolve("dist/github/github-issues-mcp-server.js")` | `mcpPath("github/github-issues-mcp-server.js")` |
| 371 | `resolve("dist/clickup/clickup-mcp-server.js")` | `mcpPath("clickup/clickup-mcp-server.js")` |
| 383 | `resolve("dist/recall/recall-mcp-server.js")` | `mcpPath("recall/recall-mcp-server.js")` |
| 419 | `resolve("dist/background/background-task-mcp-server.js")` | `mcpPath("background/background-task-mcp-server.js")` |
| 438 | `resolve("dist/callback/callback-mcp-server.js")` | `mcpPath("callback/callback-mcp-server.js")` |
| 457 | `resolve("dist/code-task/code-task-mcp-server.js")` | `mcpPath("code-task/code-task-mcp-server.js")` |
| 483 | `resolve("dist/search/conversation-search-mcp-server.js")` | `mcpPath("search/conversation-search-mcp-server.js")` |
| 496 | `resolve("dist/code-index/code-search-mcp-server.js")` | `mcpPath("code-index/code-search-mcp-server.js")` |
| 557 | `resolve("dist/events/event-bus-mcp-server.js")` | `mcpPath("events/event-bus-mcp-server.js")` |
| 575 | `resolve("dist/team/team-mcp-server.js")` | `mcpPath("team/team-mcp-server.js")` |
| 591 | `resolve("dist/workflow/workflow-mcp-server.js")` | `mcpPath("workflow/workflow-mcp-server.js")` |
| 605 | `resolve("dist/schedule/schedule-mcp-server.js")` | `mcpPath("schedule/schedule-mcp-server.js")` |
| 617 | `resolve("dist/admin/admin-mcp-server.js")` | `mcpPath("admin/admin-mcp-server.js")` |

- [ ] **Step 4:** Fix `brave-search-mcp` to use `createRequire`

Replace line 304:
```typescript
// Before:
args: [resolve("node_modules/brave-search-mcp/dist/index.js")],

// After:
args: [(() => {
  const require = createRequire(import.meta.url);
  return require.resolve("brave-search-mcp/dist/index.js");
})()],
```

- [ ] **Step 5:** Fix plugin MCP server path resolution

Replace the plugin path resolution (line 514):
```typescript
// Before:
const compiledPath = resolve(
  `dist/plugins/${plugin.name}/${serverDef.entry.replace(/\.ts$/, ".js")}`,
);

// After — support both dev mode (dist/plugins/) and npm mode (~/.hive/plugins/)
const devPath = resolve(DIST_DIR, `plugins/${plugin.name}/${serverDef.entry.replace(/\.ts$/, ".js")}`);
const npmPath = resolve(hiveHome, "plugins", "node_modules", plugin.name, "dist", "mcp",
  serverDef.entry.replace(/\.ts$/, ".min.js").replace(/^.*\//, ""));
const compiledPath = existsSync(npmPath) ? npmPath : devPath;
```

- [ ] **Step 6:** Fix SDK plugin path resolution (buildSdkPlugins, line 796)

```typescript
// Before:
const pluginsDir = resolve("plugins/claude-code");

// After:
const pluginsDir = resolve(DIST_DIR, "..", "plugins", "claude-code");
```

- [ ] **Step 7:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npm run dev` (start in dev mode, verify a message triggers agent runner with correct MCP paths)
Expected: MCP servers spawn successfully (check logs for "Starting MCP server" lines)

- [ ] **Step 8:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "refactor(agent-runner): resolve MCP paths from package root, not cwd (#109)"
```

---

### Task 3: CLI Entry Point

**Files:**
- Create: `src/cli.ts`

New CLI entry point using Node's built-in `parseArgs`. Subcommands: init, start, stop, status, update, doctor, plugin.

- [ ] **Step 1:** Create `src/cli.ts`

```typescript
#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    daemon: { type: "boolean", default: false },
    config: { type: "string" },
    version: { type: "boolean", short: "v", default: false },
  },
});

const command = positionals[0];

if (values.version) {
  const pkg = JSON.parse(
    (await import("node:fs")).readFileSync(
      resolve(import.meta.dirname, "..", "package.json"),
      "utf-8",
    ),
  );
  console.log(`hive v${pkg.version}`);
  process.exit(0);
}

if (values.help || !command) {
  console.log(`
hive — AI agent platform

Usage:
  hive <command> [options]

Commands:
  init              Setup wizard (prereqs + config)
  start             Start Hive (foreground)
  start --daemon    Install + start as LaunchAgent
  stop              Stop LaunchAgent
  status            Health check
  update            Stop → update package → restart
  doctor            Check prereqs, services, agent health
  plugin add <pkg>  Install a plugin package
  plugin list       List installed plugins
  plugin remove     Uninstall a plugin

Options:
  --config <path>   Path to hive.yaml
  -v, --version     Show version
  -h, --help        Show this help
`);
  process.exit(0);
}

/**
 * Package root — computed once here where import.meta.dirname is reliable.
 * In npm mode: cli.min.js is in pkg/, so dirname = <package>/pkg/, parent = <package>/
 * In dev mode: cli.js is in dist/, so dirname = <repo>/dist/, parent = <repo>/
 */
const PKG_ROOT = resolve(import.meta.dirname, "..");

// Set HIVE_HOME from --config if provided
if (values.config) {
  const configPath = resolve(values.config);
  if (existsSync(configPath)) {
    // If it's a file, use its parent directory as HIVE_HOME
    const stat = (await import("node:fs")).statSync(configPath);
    process.env.HIVE_HOME = stat.isDirectory() ? configPath : resolve(configPath, "..");
  } else {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }
}

switch (command) {
  case "init": {
    const { runSetupWizard } = await import("./setup/init.js");
    await runSetupWizard(PKG_ROOT);
    break;
  }

  case "start": {
    if (values.daemon) {
      const { startDaemon } = await import("./cli/daemon.js");
      await startDaemon(PKG_ROOT);
    } else {
      // Foreground mode — spawn server as subprocess (not import, which esbuild would inline)
      const { execFileSync } = await import("node:child_process");
      const serverPath = existsSync(resolve(PKG_ROOT, "pkg", "server.min.js"))
        ? resolve(PKG_ROOT, "pkg", "server.min.js")
        : resolve(PKG_ROOT, "dist", "index.js");
      execFileSync(process.execPath, [serverPath], {
        stdio: "inherit",
        env: { ...process.env, HIVE_HOME: process.env.HIVE_HOME ?? "" },
      });
    }
    break;
  }

  case "stop": {
    const { stopDaemon } = await import("./cli/daemon.js");
    await stopDaemon();
    break;
  }

  case "status": {
    const { showStatus } = await import("./cli/status.js");
    await showStatus();
    break;
  }

  case "update": {
    const { runUpdate } = await import("./cli/update.js");
    await runUpdate();
    break;
  }

  case "doctor": {
    const { runDoctor } = await import("./cli/doctor.js");
    await runDoctor();
    break;
  }

  case "plugin": {
    const subcommand = positionals[1];
    const target = positionals[2];
    const { runPlugin } = await import("./cli/plugin.js");
    await runPlugin(subcommand, target);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "hive --help" for usage.');
    process.exit(1);
}
```

- [ ] **Step 2:** Create `src/cli/daemon.ts` — LaunchAgent management

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { hiveHome } from "../paths.js";

function getInstanceId(): string {
  const configPath = resolve(hiveHome, process.env.HIVE_CONFIG ?? "hive.yaml");
  if (!existsSync(configPath)) return "hive";
  const config = parseYaml(readFileSync(configPath, "utf-8")) ?? {};
  return (config.instance?.id as string) ?? "hive";
}

function getLabel(): string {
  return `com.hive.${getInstanceId()}.agent`;
}

function getPlistPath(): string {
  return resolve(hiveHome, "service", `${getLabel()}.plist`);
}

function getLaunchAgentLink(): string {
  const home = process.env.HOME ?? "/tmp";
  return resolve(home, "Library", "LaunchAgents", `${getLabel()}.plist`);
}

export async function startDaemon(pkgRoot: string): Promise<void> {
  const label = getLabel();
  const plistPath = getPlistPath();
  const linkPath = getLaunchAgentLink();
  const serviceDir = resolve(hiveHome, "service");
  const logsDir = resolve(hiveHome, "logs");

  // Ensure directories
  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  // Detect paths
  const nodePath = execFileSync("which", ["node"], { encoding: "utf-8" }).trim();
  // Find the server entry point — either pkg/server.min.js (npm) or dist/index.js (dev)
  const serverPath = existsSync(resolve(pkgRoot, "pkg", "server.min.js"))
    ? resolve(pkgRoot, "pkg", "server.min.js")
    : resolve(pkgRoot, "dist", "index.js");

  const home = process.env.HOME ?? "/tmp";
  const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${hiveHome}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_HOME</key>
    <string>${hiveHome}</string>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${logsDir}/hive.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/hive.err</string>
</dict>
</plist>
`;

  writeFileSync(plistPath, plist);
  console.log(`Generated plist: ${plistPath}`);

  // Symlink into ~/Library/LaunchAgents/
  if (existsSync(linkPath)) unlinkSync(linkPath);
  symlinkSync(plistPath, linkPath);

  // Load the agent
  try {
    execFileSync("launchctl", ["load", linkPath], { stdio: "inherit" });
    console.log(`Started ${label}`);
  } catch {
    console.error(`Failed to start ${label}. Check: launchctl list | grep hive`);
    process.exit(1);
  }
}

export async function stopDaemon(): Promise<void> {
  const linkPath = getLaunchAgentLink();
  const label = getLabel();

  if (!existsSync(linkPath)) {
    console.log(`No LaunchAgent found for ${label}`);
    return;
  }

  try {
    execFileSync("launchctl", ["unload", linkPath], { stdio: "inherit" });
    console.log(`Stopped ${label}`);
  } catch {
    console.error(`Failed to stop ${label}`);
  }
}
```

- [ ] **Step 3:** Create `src/cli/status.ts`

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { hiveHome } from "../paths.js";

export async function showStatus(): Promise<void> {
  console.log(`Hive home: ${hiveHome}`);

  const configPath = resolve(hiveHome, process.env.HIVE_CONFIG ?? "hive.yaml");
  if (!existsSync(configPath)) {
    console.log("Status: not initialized (run 'hive init')");
    return;
  }

  const config = parseYaml(readFileSync(configPath, "utf-8")) ?? {};
  const instanceId = (config.instance?.id as string) ?? "hive";
  const label = `com.hive.${instanceId}.agent`;

  console.log(`Instance: ${instanceId}`);

  // Check if LaunchAgent is running
  try {
    const output = execFileSync("launchctl", ["list"], { encoding: "utf-8" });
    const running = output.split("\n").find((line) => line.includes(label));
    if (running) {
      const parts = running.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      console.log(`Service: running (PID ${pid}, last exit ${exitCode})`);
    } else {
      console.log("Service: not running");
    }
  } catch {
    console.log("Service: unknown (could not query launchctl)");
  }

  // Check MongoDB
  try {
    execFileSync("mongosh", ["--eval", "db.runCommand({ping:1})", "--quiet"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    console.log("MongoDB: connected");
  } catch {
    console.log("MongoDB: not reachable");
  }
}
```

- [ ] **Step 4:** Create `src/cli/update.ts`

```typescript
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { stopDaemon, startDaemon } from "./daemon.js";

export async function runUpdate(): Promise<void> {
  console.log("Stopping Hive...");
  await stopDaemon();

  console.log("Updating @keepur/hive...");
  try {
    execFileSync("npm", ["update", "-g", "@keepur/hive"], { stdio: "inherit" });
    console.log("Update complete.");
  } catch {
    console.error("Update failed.");
    process.exit(1);
  }

  // After update, the package root may have changed — re-resolve from npm global root
  const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
  const updatedPkgRoot = resolve(npmRoot, "@keepur", "hive");

  console.log("Restarting Hive...");
  await startDaemon(updatedPkgRoot);
}
```

- [ ] **Step 5:** Create `src/cli/doctor.ts`

```typescript
import { execFileSync } from "node:child_process";

interface Check {
  name: string;
  required: boolean;
  test: () => boolean;
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function serviceRunning(name: string): boolean {
  try {
    const output = execFileSync("brew", ["services", "list"], { encoding: "utf-8" });
    return output.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [
    { name: "Node.js >= 22", required: true, test: () => {
      const major = parseInt(process.versions.node.split(".")[0]);
      return major >= 22;
    }},
    { name: "Homebrew", required: true, test: () => commandExists("brew") },
    { name: "MongoDB", required: true, test: () => serviceRunning("mongodb-community") },
    { name: "Ollama", required: false, test: () => serviceRunning("ollama") },
    { name: "Qdrant", required: false, test: () => serviceRunning("qdrant") },
    { name: "gh CLI", required: false, test: () => commandExists("gh") },
    { name: "gog CLI", required: false, test: () => commandExists("gog") },
    { name: "Xcode CLI Tools", required: true, test: () => {
      try {
        execFileSync("xcode-select", ["-p"], { encoding: "utf-8" });
        return true;
      } catch { return false; }
    }},
  ];

  let allPassed = true;
  for (const check of checks) {
    const ok = check.test();
    const icon = ok ? "✓" : (check.required ? "✗" : "○");
    const label = check.required ? "" : " (optional)";
    console.log(`  ${icon} ${check.name}${label}`);
    if (!ok && check.required) allPassed = false;
  }

  if (!allPassed) {
    console.log("\nSome required checks failed. Run 'hive init' to install prerequisites.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}
```

- [ ] **Step 6:** Create `src/cli/plugin.ts`

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hiveHome } from "../paths.js";

const pluginsDir = resolve(hiveHome, "plugins");

export async function runPlugin(subcommand?: string, target?: string): Promise<void> {
  switch (subcommand) {
    case "add": {
      if (!target) {
        console.error("Usage: hive plugin add <package-name>");
        process.exit(1);
      }
      mkdirSync(pluginsDir, { recursive: true });

      // Initialize a package.json in the plugins dir if needed
      const pkgJsonPath = resolve(pluginsDir, "package.json");
      if (!existsSync(pkgJsonPath)) {
        execFileSync("npm", ["init", "-y"], { cwd: pluginsDir, stdio: "pipe" });
      }

      console.log(`Installing ${target}...`);
      execFileSync("npm", ["install", target], { cwd: pluginsDir, stdio: "inherit" });
      console.log(`Installed ${target}`);
      break;
    }

    case "list": {
      if (!existsSync(pluginsDir)) {
        console.log("No plugins installed.");
        return;
      }
      const pkgJsonPath = resolve(pluginsDir, "package.json");
      if (!existsSync(pkgJsonPath)) {
        console.log("No plugins installed.");
        return;
      }
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const deps = pkg.dependencies ?? {};
      if (Object.keys(deps).length === 0) {
        console.log("No plugins installed.");
        return;
      }
      console.log("Installed plugins:");
      for (const [name, version] of Object.entries(deps)) {
        console.log(`  ${name}@${version}`);
      }
      break;
    }

    case "remove": {
      if (!target) {
        console.error("Usage: hive plugin remove <package-name>");
        process.exit(1);
      }
      if (!existsSync(pluginsDir)) {
        console.error("No plugins directory found.");
        process.exit(1);
      }
      console.log(`Removing ${target}...`);
      execFileSync("npm", ["uninstall", target], { cwd: pluginsDir, stdio: "inherit" });
      console.log(`Removed ${target}`);
      break;
    }

    default:
      console.error("Usage: hive plugin <add|list|remove> [package]");
      process.exit(1);
  }
}
```

- [ ] **Step 7:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npx tsx src/cli.ts --help`
Expected: prints help text

Run: `npx tsx src/cli.ts --version`
Expected: prints `hive v0.1.0`

Run: `npx tsx src/cli.ts doctor`
Expected: prints checks (some may fail on dev machine — that's fine)

- [ ] **Step 8:** Commit

```bash
git add src/cli.ts src/cli/daemon.ts src/cli/status.ts src/cli/update.ts src/cli/doctor.ts src/cli/plugin.ts
git commit -m "feat(cli): add hive CLI entry point with subcommands (#109)"
```

---

### Task 4: esbuild Bundle Pipeline

**Files:**
- Create: `build/bundle.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1:** Install esbuild as a dev dependency

Run: `npm install -D esbuild`

- [ ] **Step 2:** Create `build/bundle.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Stage 2 build: bundle + minify dist/ → pkg/
 *
 * Prereq: npm run build (tsc → dist/)
 * Output: pkg/ (publish-ready minified bundles)
 */
import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PKG_DIR = "pkg";

// Clean and recreate
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
mkdirSync(resolve(PKG_DIR, "mcp"), { recursive: true });
mkdirSync(resolve(PKG_DIR, "setup"), { recursive: true });

const external = [
  // Native modules — require compilation on target machine
  "better-sqlite3",
  // Large SDKs with dynamic internals
  "mongodb",
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "@slack/socket-mode",
  "@slack/web-api",
  "@linear/sdk",
  "@qdrant/js-client-rest",
  // File-processing libs with complex internal asset loading
  "pdf-parse",
  "mammoth",
  "xlsx",
  // Third-party MCP servers (resolved via createRequire at runtime)
  "brave-search-mcp",
];

const shared = {
  outdir: PKG_DIR,
  outExtension: { ".js": ".min.js" },
  bundle: true,
  minify: true,
  platform: "node" as const,
  target: "node22",
  format: "esm" as const,
  external,
  logLevel: "info" as const,
};

// CLI entry point — gets shebang banner
await build({
  ...shared,
  entryPoints: { cli: "dist/cli.js" },
  banner: { js: "#!/usr/bin/env node" },
});

// Main server + setup wizard
await build({
  ...shared,
  entryPoints: {
    server: "dist/index.js",
    "setup/wizard": "dist/setup/wizard.js",
  },
});

// MCP servers — each is a separate entry point (spawned as subprocess)
await build({
  ...shared,
  entryPoints: {
    "mcp/memory": "dist/memory/memory-mcp-server.js",
    "mcp/structured-memory": "dist/memory/structured-memory-mcp-server.js",
    "mcp/contacts": "dist/contacts/contacts-mcp-server.js",
    "mcp/admin": "dist/admin/admin-mcp-server.js",
    "mcp/callback": "dist/callback/callback-mcp-server.js",
    "mcp/schedule": "dist/schedule/schedule-mcp-server.js",
    "mcp/github-issues": "dist/github/github-issues-mcp-server.js",
    "mcp/linear": "dist/linear/linear-mcp-server.js",
    "mcp/clickup": "dist/clickup/clickup-mcp-server.js",
    "mcp/google": "dist/google/google-mcp-server.js",
    "mcp/keychain": "dist/keychain/keychain-mcp-server.js",
    "mcp/quo": "dist/quo/quo-mcp-server.js",
    "mcp/resend": "dist/resend/resend-mcp-server.js",
    "mcp/search-conversation": "dist/search/conversation-search-mcp-server.js",
    "mcp/background-task": "dist/background/background-task-mcp-server.js",
    "mcp/recall": "dist/recall/recall-mcp-server.js",
    "mcp/task": "dist/tasks/task-mcp-server.js",
    "mcp/event-bus": "dist/events/event-bus-mcp-server.js",
    "mcp/team": "dist/team/team-mcp-server.js",
    "mcp/code-search": "dist/code-index/code-search-mcp-server.js",
    "mcp/code-task": "dist/code-task/code-task-mcp-server.js",
    "mcp/workflow": "dist/workflow/workflow-mcp-server.js",
    "mcp/voice": "dist/voice/voice-mcp-server.js",
  },
});

// Copy non-JS assets to setup/
const setupAssets = [
  "setup/install-prereqs.sh",
  "setup/slack-manifest.yaml",
];
for (const asset of setupAssets) {
  const src = resolve(asset);
  const dest = resolve(PKG_DIR, asset);
  if (existsSync(src)) copyFileSync(src, dest);
}

console.log("\n✓ Bundle complete → pkg/");
```

- [ ] **Step 3:** Add npm scripts to `package.json`

Add to the `"scripts"` section:
```json
"bundle": "npm run build && npx tsx build/bundle.ts",
"prepublishOnly": "npm run bundle"
```

- [ ] **Step 4:** Add `pkg/` to `.gitignore`

Append to `.gitignore`:
```
pkg/
```

- [ ] **Step 5:** Verify

Run: `npm run bundle`
Expected: `pkg/` directory created with `cli.min.js`, `server.min.js`, `mcp/*.min.js`, `setup/wizard.min.js`

Run: `ls pkg/mcp/ | wc -l`
Expected: 23 files

Run: `node pkg/cli.min.js --version`
Expected: prints version (confirms shebang + basic execution)

- [ ] **Step 6:** Commit

```bash
git add build/bundle.ts package.json .gitignore
git commit -m "feat(build): add esbuild bundle pipeline, dist/ → pkg/ (#109)"
```

---

### Task 5: package.json for npm Publish

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Update package.json fields for npm distribution

Make these changes:

```json
{
  "name": "@keepur/hive",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "hive": "pkg/cli.min.js"
  },
  "files": [
    "pkg/",
    "seeds/",
    "templates/"
  ],
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Specifically:
- Change `"name"` from `"hive"` to `"@keepur/hive"`
- Remove `"private": true`
- Add `"bin"` field
- Add `"files"` whitelist
- Add `"engines"` field

- [ ] **Step 2:** Create `seeds/chief-of-staff/` — default agent seed shipping with core

Create `seeds/chief-of-staff/agent.yaml`:
```yaml
_id: chief-of-staff
name: Mokie
model: opus
icon: ":bee:"
channels:
  - agent-mokie
passiveChannels: []
keywords: []
isDefault: false
budgetUsd: 5
maxTurns: 200
maxConcurrent: 3
timeoutMs: 600000
disabled: false
coreServers:
  - memory
  - structured-memory
  - admin
  - schedule
  - contacts
  - keychain
  - event-bus
delegateServers: []
plugins: []
soul: |
  You are the Chief of Staff — a senior advisor and coordinator.
  You help the owner manage the team of AI agents, troubleshoot issues,
  and handle strategic decisions that don't fit a specific agent's domain.
systemPrompt: |
  You are the Chief of Staff agent. Your role:
  - Coordinate across agents when needed
  - Handle administrative tasks
  - Advise the owner on agent team management
  - Troubleshoot agent issues

  Always be direct, concise, and actionable.
```

- [ ] **Step 3:** Copy constitution template for distribution

Create `templates/constitution.md.tpl` — copy from `setup/templates/constitution-business.md.tpl` (this ships with the core package so `hive init` can find it without relying on repo structure).

- [ ] **Step 4:** Verify

Run: `npm pack --dry-run 2>&1 | head -40`
Expected: shows only files under `pkg/`, `seeds/`, `templates/`, and `package.json`/`README.md`. No `src/`, `dist/`, `plugins/`, `tsconfig`, or test files.

- [ ] **Step 5:** Commit

```bash
git add package.json seeds/ templates/
git commit -m "feat(package): configure @keepur/hive for npm publish (#109)"
```

---

### Task 6: Expanded Prerequisites Installer

**Files:**
- Create: `src/cli/prereqs.ts`
- Modify: `setup/install-prereqs.sh` (keep for backward compat, but add new prereqs)

- [ ] **Step 1:** Create `src/cli/prereqs.ts` — TypeScript prereqs installer (DOD-212 compliant)

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

interface Prereq {
  name: string;
  required: boolean;
  check: () => boolean;
  install: () => void;
}

const execOpts = { encoding: "utf-8" as const, stdio: "pipe" as const };

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], execOpts);
    return true;
  } catch {
    return false;
  }
}

function brewInstalled(formula: string): boolean {
  try {
    execFileSync("brew", ["list", formula], execOpts);
    return true;
  } catch {
    return false;
  }
}

function brewServiceRunning(name: string): boolean {
  try {
    const output = execFileSync("brew", ["services", "list"], execOpts);
    return output.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch {
    return false;
  }
}

const prereqs: Prereq[] = [
  {
    name: "Xcode CLI Tools",
    required: true,
    check: () => {
      try {
        execFileSync("xcode-select", ["-p"], execOpts);
        return true;
      } catch { return false; }
    },
    install: () => {
      console.log("  Installing Xcode CLI Tools (this opens a system dialog)...");
      execFileSync("xcode-select", ["--install"], { stdio: "inherit" });
      console.log("  Complete the installation dialog, then re-run 'hive init'.");
      process.exit(0);
    },
  },
  {
    name: "Homebrew",
    required: true,
    check: () => commandExists("brew"),
    install: () => {
      console.log("  Installing Homebrew...");
      // Download installer to temp file, then execute — avoids shell interpolation (DOD-212)
      const tmpScript = resolve(tmpdir(), "brew-install.sh");
      const script = execFileSync("curl", ["-fsSL",
        "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"],
        { encoding: "utf-8" });
      writeFileSync(tmpScript, script, { mode: 0o755 });
      execFileSync("/bin/bash", [tmpScript], { stdio: "inherit" });
      unlinkSync(tmpScript);
    },
  },
  {
    name: "Node.js >= 22",
    required: true,
    check: () => parseInt(process.versions.node.split(".")[0]) >= 22,
    install: () => {
      console.log("  Installing Node.js via Homebrew...");
      execFileSync("brew", ["install", "node"], { stdio: "inherit" });
    },
  },
  {
    name: "MongoDB",
    required: true,
    check: () => brewServiceRunning("mongodb-community"),
    install: () => {
      if (!brewInstalled("mongodb-community")) {
        console.log("  Tapping mongodb/brew...");
        execFileSync("brew", ["tap", "mongodb/brew"], { stdio: "inherit" });
        console.log("  Installing mongodb-community...");
        execFileSync("brew", ["install", "mongodb-community"], { stdio: "inherit" });
      }
      console.log("  Starting MongoDB...");
      execFileSync("brew", ["services", "start", "mongodb-community"], { stdio: "inherit" });
    },
  },
  {
    name: "Ollama",
    required: false,
    check: () => commandExists("ollama"),
    install: () => {
      console.log("  Installing Ollama...");
      execFileSync("brew", ["install", "ollama"], { stdio: "inherit" });
      execFileSync("brew", ["services", "start", "ollama"], { stdio: "inherit" });
    },
  },
  {
    name: "Ollama models (bge-large, qwen2.5:3b)",
    required: false,
    check: () => {
      if (!commandExists("ollama")) return false;
      try {
        const list = execFileSync("ollama", ["list"], execOpts) as string;
        return list.includes("bge-large") && list.includes("qwen2.5:3b");
      } catch { return false; }
    },
    install: () => {
      console.log("  Pulling bge-large...");
      execFileSync("ollama", ["pull", "bge-large"], { stdio: "inherit" });
      console.log("  Pulling qwen2.5:3b...");
      execFileSync("ollama", ["pull", "qwen2.5:3b"], { stdio: "inherit" });
    },
  },
  {
    name: "Qdrant",
    required: false,
    check: () => brewServiceRunning("qdrant"),
    install: () => {
      if (!brewInstalled("qdrant")) {
        console.log("  Installing Qdrant...");
        execFileSync("brew", ["install", "qdrant/tap/qdrant"], { stdio: "inherit" });
      }
      console.log("  Starting Qdrant...");
      execFileSync("brew", ["services", "start", "qdrant"], { stdio: "inherit" });
    },
  },
  {
    name: "gh CLI",
    required: false,
    check: () => commandExists("gh"),
    install: () => {
      console.log("  Installing gh CLI...");
      execFileSync("brew", ["install", "gh"], { stdio: "inherit" });
    },
  },
];

export async function installPrereqs(): Promise<void> {
  console.log("Checking prerequisites...\n");

  let failures = 0;

  for (const prereq of prereqs) {
    const label = prereq.required ? "" : " (optional)";
    if (prereq.check()) {
      console.log(`  ✓ ${prereq.name}${label}`);
      continue;
    }

    console.log(`  ✗ ${prereq.name}${label} — installing...`);
    try {
      prereq.install();
      if (prereq.check()) {
        console.log(`  ✓ ${prereq.name} — installed`);
      } else if (prereq.required) {
        console.error(`  ✗ ${prereq.name} — install failed`);
        failures++;
      }
    } catch (err) {
      if (prereq.required) {
        console.error(`  ✗ ${prereq.name} — install failed: ${err}`);
        failures++;
      } else {
        console.log(`  ○ ${prereq.name} — skipped (install failed)`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} required prerequisite(s) failed. Fix and re-run 'hive init'.`);
    process.exit(1);
  }

  console.log("\nAll prerequisites ready.");
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/cli/prereqs.ts
git commit -m "feat(prereqs): add TypeScript prereqs installer with Ollama/Qdrant (#109)"
```

---

### Task 7: Setup Wizard Init Command

**Files:**
- Create: `src/setup/init.ts`

Wire `hive init` to run prereqs + the setup wizard. The wizard writes to `hiveHome` (defaulting to `~/.hive/`) instead of assuming repo root.

- [ ] **Step 1:** Create `src/setup/init.ts`

```typescript
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { hiveHome } from "../paths.js";
import { installPrereqs } from "../cli/prereqs.js";

export async function runSetupWizard(pkgRoot: string): Promise<void> {
  console.log(`\nHive Setup Wizard`);
  console.log(`Home directory: ${hiveHome}\n`);

  // Ensure hive home exists
  mkdirSync(hiveHome, { recursive: true });

  // Step 1: Prerequisites
  await installPrereqs();

  // Step 2: Run the interactive setup wizard
  // In npm mode, templates resolve from the package's templates/ dir
  const templatesDir = existsSync(resolve(pkgRoot, "templates"))
    ? resolve(pkgRoot, "templates")
    : resolve(pkgRoot, "setup", "templates");

  console.log(`\nSetup will write config to: ${hiveHome}`);
  console.log(`Templates from: ${templatesDir}\n`);

  // Delegate to existing wizard with hiveHome override
  // The wizard import is deferred because it loads config.ts which reads .env
  // We need prereqs done first (especially MongoDB)
  process.env.HIVE_HOME = hiveHome;

  // Dynamic import to pick up HIVE_HOME change
  const { runWizard } = await import("./wizard.js");
  await runWizard(hiveHome, templatesDir);
}
```

**Important:** `setup/setup-wizard.ts` lives outside `src/` and is NOT compiled by tsc into `dist/`. The dynamic import `../../setup/setup-wizard.js` from `dist/setup/init.js` will fail at runtime. Two options:

1. **Move the wizard into `src/`** — e.g., `src/setup/wizard.ts` — so tsc compiles it to `dist/setup/wizard.js`. This is cleaner but requires updating the `npm run setup` script path.
2. **Add a separate tsc config** for `setup/` that outputs to `dist/setup/`.

**Recommended: Option 1.** Move `setup/setup-wizard.ts` → `src/setup/wizard.ts`. Update `package.json` scripts to point to the new path (`npx tsx src/setup/wizard.ts`). The import from `init.ts` becomes `./wizard.js` (same directory). This also means the esbuild entry `"setup/wizard": "dist/setup/wizard.js"` works correctly.

The implementer should move the file, fix all internal imports (the wizard imports from `setup/templates/` which become relative to the new location), and update the npm script.

- [ ] **Step 2:** Add `runWizard` export to the wizard (now at `src/setup/wizard.ts`)

Refactor the main execution:

```typescript
// Existing: the script runs setup directly when executed as main
// New: export a function that accepts configurable paths

export async function runWizard(
  targetDir: string = ROOT,
  templatesDir: string = resolve(ROOT, "setup", "templates"),
): Promise<void> {
  // Move the body of the existing main() here
  // Replace all uses of ROOT with targetDir
  // Replace template path resolution to use templatesDir
}

// Keep backward compat for direct execution
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runWizard().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
```

The implementer should move the existing main flow into `runWizard()`, parameterizing `ROOT` → `targetDir` and template paths → `templatesDir`. This is a mechanical refactor — no logic changes.

- [ ] **Step 3:** Fix `isAgentDone()` and `isBuildDone()` for npm mode

The wizard has two completion checks that assume repo structure:
- `isAgentDone()` checks for `agents/chief-of-staff/agent.yaml` on disk — agents are in MongoDB now
- `isBuildDone()` checks for `dist/index.js` — doesn't exist in `~/.hive/`

Replace `isAgentDone()` with a MongoDB query:
```typescript
async function isAgentDone(): Promise<boolean> {
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27017");
    await client.connect();
    const db = client.db(process.env.MONGODB_DB ?? "hive");
    const agent = await db.collection("agent_definitions").findOne({ _id: "chief-of-staff" });
    await client.close();
    return !!agent;
  } catch {
    return false;
  }
}
```

Replace `isBuildDone()` — in npm mode it's always true (the package is already built):
```typescript
function isBuildDone(targetDir: string): boolean {
  // npm mode: package is pre-built, no dist/ check needed
  if (existsSync(resolve(import.meta.dirname, "..", "pkg", "server.min.js"))) return true;
  // Dev mode: check for tsc output
  return existsSync(resolve(targetDir, "dist", "index.js"));
}
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npx tsx src/cli.ts init --help` (confirm it doesn't crash)

- [ ] **Step 5:** Commit

```bash
git add src/setup/init.ts src/setup/wizard.ts
git commit -m "feat(setup): wire hive init to prereqs + wizard with configurable hiveHome (#109)"
```

---

### Task 8: Setup Wizard DOD-212 Compliance

**Files:**
- Modify: `setup/setup-wizard.ts` (14 `execSync` calls → `execFileSync`)

Convert all shell-string `execSync` calls to `execFileSync(binary, argsArray)` per DOD-212. This is a security requirement — the Slack token shell interpolation (line 546) is the worst offender.

- [ ] **Step 1:** Replace all 14 `execSync` calls

Each replacement follows the pattern: `execSync("cmd arg1 arg2")` → `execFileSync("cmd", ["arg1", "arg2"])`.

| Line | Before | After |
|------|--------|-------|
| 267 | `execSync("which gog", ...)` | `execFileSync("which", ["gog"], ...)` |
| 275 | `execSync("brew install gog", ...)` | `execFileSync("brew", ["install", "gog"], ...)` |
| 284 | `execSync("gog auth list 2>&1", ...)` | `execFileSync("gog", ["auth", "list"], ...)` (drop redirect — stderr goes to pipe anyway with `stdio: "pipe"`) |
| 300 | `execSync('gog auth add "${email}"', ...)` | `execFileSync("gog", ["auth", "add", email], ...)` |
| 314 | `execSync('gog gmail search "is:unread" -a "${env.GOOGLE_ACCOUNT}" --json --results-only --no-input 2>&1', ...)` | `execFileSync("gog", ["gmail", "search", "is:unread", "-a", env.GOOGLE_ACCOUNT, "--json", "--results-only", "--no-input"], { encoding: "utf-8", timeout: 15_000 })` |
| 452 | `execSync('HIVE_DEPLOY_DIR="${deployDir}" bash service/install.sh', ...)` | `execFileSync("bash", ["service/install.sh"], { ...opts, env: { ...process.env, HIVE_DEPLOY_DIR: deployDir } })` |
| 546-548 | `execSync('curl -s -H "Authorization: Bearer ${env.SLACK_BOT_TOKEN}" ...', ...)` | `execFileSync("curl", ["-s", "-H", `Authorization: Bearer ${env.SLACK_BOT_TOKEN}`, url], ...)` |
| 589 | `execSync("npx tsx setup/setup-seeds.ts", ...)` | `execFileSync("npx", ["tsx", "setup/setup-seeds.ts"], ...)` |
| 719 | `execSync("npm run build", ...)` | `execFileSync("npm", ["run", "build"], ...)` |
| 736 | `execSync("git remote get-url origin", ...)` | `execFileSync("git", ["remote", "get-url", "origin"], ...)` |
| 737 | `execSync('git clone "${remoteUrl}" "${deployDir}"', ...)` | `execFileSync("git", ["clone", remoteUrl, deployDir], ...)` |
| 743 | `execSync("git pull --ff-only", ...)` | `execFileSync("git", ["pull", "--ff-only"], ...)` |
| 751 | `execSync("npm install --omit=dev", ...)` | `execFileSync("npm", ["install", "--omit=dev"], ...)` |
| 776 | `execSync('rsync -a --delete "${distSrc}/" "${join(deployDir, "dist")}/"', ...)` | `execFileSync("rsync", ["-a", "--delete", `${distSrc}/`, `${join(deployDir, "dist")}/`], { stdio: "pipe" })` |

Also update the import at the top of the file:
```typescript
// Before:
import { execSync } from "node:child_process";
// After:
import { execFileSync } from "node:child_process";
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npm run lint`
Expected: no new errors

- [ ] **Step 3:** Commit

```bash
git add setup/setup-wizard.ts
git commit -m "security(setup): convert all execSync to execFileSync for DOD-212 (#109)"
```

---

### Task 9: Dry-Run Publish Validation

**Files:**
- No new files — this is a verification task

- [ ] **Step 1:** Run the full build + bundle pipeline

Run: `npm run bundle`
Expected: `pkg/` directory populated with all bundles

- [ ] **Step 2:** Verify package contents

Run: `npm pack --dry-run 2>&1`
Expected output should show ONLY:
- `package.json`
- `README.md` (if it exists)
- `pkg/cli.min.js`
- `pkg/server.min.js`
- `pkg/mcp/*.min.js` (23 files)
- `pkg/setup/wizard.min.js`
- `pkg/setup/install-prereqs.sh`
- `seeds/chief-of-staff/agent.yaml`
- `templates/constitution.md.tpl`

Must NOT contain: `src/`, `dist/`, `plugins/`, `tsconfig*`, `tests/`, `.env*`, `hive.yaml`, `node_modules/`

- [ ] **Step 3:** Verify bundle execution

Run: `node pkg/cli.min.js --version`
Expected: prints version

Run: `node pkg/cli.min.js --help`
Expected: prints help text

Run: `node pkg/cli.min.js doctor`
Expected: prints prereq check results

- [ ] **Step 4:** Verify server bundle can at least parse

Run: `node -e "import('./pkg/server.min.js')" 2>&1 | head -5`
Expected: may error on missing config/MongoDB, but should NOT error on missing modules (which would indicate a missing external)

- [ ] **Step 5:** Check bundle sizes

Run: `du -sh pkg/`
Expected: reasonable total (< 5MB for all bundles combined — most deps are external)

Run: `ls -la pkg/mcp/*.min.js | awk '{print $5, $9}' | sort -n`
Expected: individual MCP bundles should be small (< 200KB each). If any are > 500KB, investigate — probably a dep that should be external.

- [ ] **Step 6:** Commit (if any fixes were needed)

```bash
git add -A
git commit -m "fix(bundle): adjust externals and bundle config from dry-run validation (#109)"
```

---

## Execution Notes

**Task dependencies:**
- Task 1 (config) must be done first — Tasks 2, 3, 6, 7 depend on `src/paths.ts`
- Task 2 (agent-runner) and Task 3 (CLI) are independent of each other
- Task 4 (esbuild) depends on Tasks 1-3 being committed (it bundles everything)
- Task 5 (package.json) depends on Task 4
- Task 6 (prereqs) is independent — can parallel with Tasks 2-3
- Task 7 (init command) depends on Tasks 3 + 6
- Task 8 (DOD-212) is independent — can be done anytime
- Task 9 (dry-run) is the final validation after everything else

**Parallel groups:**
1. Task 1 (config)
2. Tasks 2 + 3 + 6 + 8 (parallel)
3. Task 4 (esbuild)
4. Tasks 5 + 7 (parallel)
5. Task 9 (validation)
