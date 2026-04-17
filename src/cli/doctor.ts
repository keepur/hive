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
import { hiveHome } from "../paths.js";

type HiveConfig = typeof import("../config.js").config;

async function tryLoadConfig(): Promise<{ config: HiveConfig | null; error: string | null }> {
  try {
    const mod = await import("../config.js");
    return { config: mod.config, error: null };
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) };
  }
}

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

  // Always read the source config.ts from the repo root. `src/` is preserved
  // in both dev (tsx) and deploy (cloned repo with dist/ alongside src/) so
  // `<dir>/../../src/config.ts` resolves correctly from both `src/cli/` and
  // `dist/cli/`.
  const requiredEnv = requiredEnvVarsFromConfig(resolve(import.meta.dirname, "../../src/config.ts"));

  // Config must be loaded lazily — it throws on missing required env vars at
  // module eval time, which is exactly the fresh-box failure mode `hive doctor`
  // is supposed to surface. A crash here would prevent the env checks below
  // from ever printing.
  const { config, error: configError } = await tryLoadConfig();

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
      name: "config loads (hive.yaml + required env)",
      group: "config",
      required: true,
      test: () => config !== null,
      remedy: configError
        ? `config.ts threw: ${configError}. Set missing env vars in ~/.hive/.env and ensure hive.yaml exists.`
        : "Check hive.yaml at the hive home and run `hive init` if missing.",
    },
    ...requiredEnv.map<Check>((key) => ({
      name: `env: ${key}`,
      group: "config",
      required: true,
      test: () => !!process.env[key],
      remedy: `Set ${key} in ~/.hive/.env`,
    })),
    // ── Agents ───────────────────────────────────────────────────────────
    // All agent checks short-circuit to false when config failed to load —
    // we can't know the Mongo URI or default-agent id without it. The config
    // group's own failure line explains why.
    {
      name: "MongoDB reachable",
      group: "agents",
      required: true,
      test: () => (config ? mongoReachable(config.mongo.uri, config.mongo.dbName) : false),
      remedy: "Start Mongo (`brew services start mongodb-community`) and verify MONGODB_URI.",
    },
    {
      name: "At least one agent exists",
      group: "agents",
      required: true,
      test: () => (config ? hasAnyAgent(config.mongo.uri, config.mongo.dbName) : false),
      remedy: "Run `npm run setup:seeds` to import plugin agent seeds.",
    },
    {
      name: `default agent exists${config ? ` (${config.defaultAgent})` : ""}`,
      group: "agents",
      required: true,
      test: () =>
        config ? defaultAgentExists(config.mongo.uri, config.mongo.dbName, config.defaultAgent) : false,
      remedy: config
        ? `Set DEFAULT_AGENT to an existing agent id or seed '${config.defaultAgent}'.`
        : "Config failed to load — see Config group.",
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
      remedy: (() => {
        const uid = process.getuid?.() ?? 0;
        return `launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/com.hive.agent.plist && launchctl kickstart -k gui/${uid}/com.hive.agent`;
      })(),
    },
    {
      name: "Slack auth.test",
      group: "services",
      required: true,
      test: () => (config ? slackAuthOk(config.slack.botToken) : false),
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
