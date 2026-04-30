import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
import { engineDir, hiveHome } from "../paths.js";

type HiveConfig = typeof import("../config.js").config;

async function tryLoadConfig(): Promise<{ config: HiveConfig | null; error: string | null }> {
  try {
    const mod = await import("../config.js");
    return { config: mod.config, error: null };
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Find the `required-env.json` shipped alongside the bundled doctor, or
 * fall back to scanning `src/config.ts` source for dev / source-checkout
 * runs where the JSON hasn't been built yet.
 *
 * Probe order matters — see the comment at the call site for layout
 * details. Returns the empty list if nothing resolves; doctor reports it
 * as a single failed check rather than throwing, so the rest of the
 * checks still run.
 */
export function resolveRequiredEnvVars(hereDir: string): string[] {
  const jsonCandidates = [
    resolve(hereDir, "required-env.json"), // bundled: pkg/ alongside cli.min.js
    resolve(hereDir, "..", "required-env.json"), // dist/ + pkg/ split layout
  ];
  for (const path of jsonCandidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { requiredEnv?: unknown };
      if (Array.isArray(parsed.requiredEnv) && parsed.requiredEnv.every((k) => typeof k === "string")) {
        return parsed.requiredEnv as string[];
      }
    } catch {
      // Fall through to the next candidate / source scan.
    }
  }
  // Source-checkout fallback. Walks two levels up from src/cli/ or
  // dist/cli/. Returns [] if even the source isn't reachable.
  const srcCandidate = resolve(hereDir, "..", "..", "src", "config.ts");
  if (existsSync(srcCandidate)) {
    return requiredEnvVarsFromConfig(srcCandidate);
  }
  return [];
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

  // Resolve the list of required env vars in this preference order:
  //   1) `<here>/required-env.json` — emitted by build/bundle.ts and shipped
  //      inside pkg/. This is the canonical path for npm-installed hives,
  //      where src/ is NOT in package.json#files and the historical
  //      "scan src/config.ts at runtime" approach ENOENTs.
  //   2) `<here>/../required-env.json` — same JSON sitting next to a `dist/`
  //      build (post-tsc, pre-bundle), in case future layouts split it.
  //   3) Scan `<here>/../../src/config.ts` — the dev/source-checkout path
  //      where pkg/ may not have been built yet but src/ is right there.
  const requiredEnv = resolveRequiredEnvVars(import.meta.dirname);

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
    {
      name: "Homebrew",
      group: "prereq",
      required: true,
      test: () => commandExists("brew"),
      remedy:
        'Install: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    },
    {
      name: "MongoDB (brew services)",
      group: "prereq",
      required: true,
      test: () => brewServiceRunning("mongodb-community"),
      remedy: "brew services start mongodb-community  # informational; live reachability is checked under Agents",
    },
    {
      name: "Ollama",
      group: "prereq",
      required: true,
      test: () => httpProbe("http://127.0.0.1:11434/api/tags"),
      remedy: "brew install ollama && brew services start ollama",
    },
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
    {
      name: "Qdrant",
      group: "prereq",
      required: true,
      test: () => httpProbe("http://127.0.0.1:6333/"),
      remedy: "brew install qdrant && brew services start qdrant",
    },
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
        ? `config.ts threw: ${configError}. Set missing env vars in <HIVE_HOME>/.env and ensure hive.yaml exists.`
        : "Check hive.yaml at the hive home and run `hive init` if missing.",
    },
    ...requiredEnv.map<Check>((key) => ({
      name: `env: ${key}`,
      group: "config",
      required: true,
      test: () => !!process.env[key],
      remedy: `Set ${key} in <HIVE_HOME>/.env`,
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
      test: () => (config ? defaultAgentExists(config.mongo.uri, config.mongo.dbName, config.defaultAgent) : false),
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
    {
      name: "live plist points at engine entry",
      group: "services",
      required: false,
      test: async () => {
        if (!config) return true; // Config group already reports the broken-config case
        const label = `com.hive.${config.instance.id}.agent`;
        const home = process.env.HOME ?? "";
        const plistPath = resolve(home, "Library/LaunchAgents", `${label}.plist`);
        if (!existsSync(plistPath)) return true; // No live plist = nothing to verify (not this check's job to create one)
        const plist = readFileSync(plistPath, "utf-8");
        const expectedEntry = resolve(engineDir, "dist", "index.js");
        const expectedMinified = resolve(engineDir, "pkg", "server.min.js");
        return plist.includes(expectedEntry) || plist.includes(expectedMinified);
      },
      remedy:
        "Live plist ProgramArguments does not reference <engineDir>/dist/index.js. Run `hive start --daemon` to regenerate the plist.",
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
