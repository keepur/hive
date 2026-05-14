import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  type Check,
  type CheckGroup,
  type PromptCacheRow,
  type PrefixCacheStatsRow,
  type SpawnCoordinatorRow,
  brewServiceRunning,
  cacheHitRatesForDoctor,
  commandExists,
  defaultAgentExists,
  formatHitRate,
  hasAnyAgent,
  httpProbe,
  launchctlPrint,
  mongoReachable,
  pidAlive,
  prefixCacheStatsForDoctor,
  requiredEnvVarsFromConfig,
  resolveServicePath,
  slackAuthOk,
  spawnCoordinatorStatsForDoctor,
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

/**
 * Render the "Prompt cache" doctor section. Exported so the unit test
 * doesn't need to invoke `runDoctor` (which runs every other doctor
 * check and may exit non-zero on a CI environment without brew/Node22).
 * Informational — does not affect exit code.
 */
/**
 * KPR-213: render the prefix-cache stats section. Reads the engine's
 * `telemetry.prefix_cache_stats` heartbeat (written every 30s).
 * Informational — does not affect exit code.
 */
export function renderPrefixCacheSection(
  row: PrefixCacheStatsRow | null,
  emit: (line: string) => void = console.log,
): void {
  emit("\nPrefix cache (live engine)");
  if (!row) {
    emit("  ○ no heartbeat yet — start the engine and re-check");
    return;
  }
  const total = row.hits + row.misses;
  const hitRate = total > 0 ? `${((row.hits / total) * 100).toFixed(1)}%` : "no data";
  const stale = row.staleSeconds === null ? "?" : `${row.staleSeconds}s ago`;
  emit(
    `  hits=${row.hits} misses=${row.misses} hit-rate=${hitRate} entries=${row.entryCount} p99-build=${row.lastBuildP99Ms}ms oldest=${Math.round(row.oldestEntryAgeMs / 1000)}s (heartbeat ${stale})`,
  );
  if (row.staleSeconds !== null && row.staleSeconds > 120) {
    emit("  ⚠ heartbeat is stale — engine may not be running, or stats writer is failing");
  }
  if (row.oldestEntryAgeMs > 24 * 60 * 60 * 1000) {
    emit("  ⚠ oldest entry > 24h — possible invalidation gap, file an issue if persistent");
  }
}

/**
 * KPR-220 Phase 11: render the spawn-coordinator section. Reads the
 * per-agent heartbeat documents and prints one row per agent with budget,
 * saturation, and stop flag. Uses the same staleness threshold (>120s) as
 * the prefix-cache section.
 */
export function renderSpawnCoordinatorSection(
  rows: SpawnCoordinatorRow[],
  emit: (line: string) => void = console.log,
): void {
  emit("\nSpawn coordinator (live engine, per agent)");
  if (rows.length === 0) {
    emit("  ○ no heartbeat yet — start the engine and re-check");
    return;
  }
  for (const r of rows) {
    const stale = r.staleSeconds === null ? "?" : `${r.staleSeconds}s ago`;
    const flags: string[] = [];
    if (r.stopped) flags.push("STOPPED");
    if (r.staleSeconds !== null && r.staleSeconds > 120) flags.push("stale-heartbeat");
    const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
    const lastSat =
      r.lastSaturationAt === null ? "never" : `${Math.round((Date.now() - r.lastSaturationAt) / 1000)}s ago`;
    emit(
      `  ${r.agentId}: active=${r.activeSpawns} budget=${r.budget} (source=${r.budgetSource}) saturations=${r.saturationCount} (last ${lastSat})${flagStr} (heartbeat ${stale})`,
    );
    if (r.lastError) {
      emit(`    last error: ${r.lastError}`);
    }
  }
}

export function renderPromptCacheSection(rows: PromptCacheRow[], emit: (line: string) => void = console.log): void {
  emit("\nPrompt cache (last 7 days)");
  if (rows.length === 0) {
    emit("  ○ no telemetry yet — let the hive run for a window and re-check");
    return;
  }
  for (const r of rows) {
    const ephemeralBreakdown =
      r.ephemeral5mTokens > 0 || r.ephemeral1hTokens > 0
        ? ` (5m=${r.ephemeral5mTokens}, 1h=${r.ephemeral1hTokens})`
        : "";
    emit(
      `  ${r.agentId}: hit=${formatHitRate(r.hitRate)} read=${r.cacheReadTokens} create=${r.cacheCreationTokens}${ephemeralBreakdown} input=${r.inputTokens} turns=${r.turns}`,
    );
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
  // is supposed to surface. tryLoadConfig wraps the import in try/catch and
  // returns `{ config: null, error }` on failure — safe to call eagerly here;
  // the Config group's "config loads" check below surfaces the real failure.
  //
  // KPR-229: moved BEFORE the service-path header so the header can use
  // `config.instance.id` to construct the per-instance LaunchAgent label.
  const { config, error: configError } = await tryLoadConfig();

  // Resolved service path header — spec: doctor inspects the deploy clone via
  // LaunchAgent, which may differ from the CWD. Print both up front.
  // KPR-229: construct the per-instance label `com.hive.<instanceId>.agent`
  // from config when available; fall back to the legacy literal only when
  // config failed to load (the Config-group check below reports the real
  // problem in that case).
  const serviceLabel = config ? `com.hive.${config.instance.id}.agent` : "com.hive.agent";
  const servicePath = resolveServicePath(serviceLabel);
  console.log(`hive doctor`);
  console.log(`  cwd:          ${process.cwd()}`);
  console.log(`  hive home:    ${hiveHome}`);
  console.log(`  service path: ${servicePath ?? "(LaunchAgent plist not found)"}`);
  console.log("");

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
      // KPR-229: drop the per-id check (was hardcoded to `config.defaultAgent`
      // which defaults to "chief-of-staff"; failed on every non-default
      // instance even when an agent was correctly flagged via `isDefault`).
      // Check the flag directly — it's the agent-definition mechanism for
      // "this is the instance's default agent."
      name: "default agent flagged (isDefault: true)",
      group: "agents",
      required: true,
      test: () => (config ? defaultAgentExists(config.mongo.uri, config.mongo.dbName) : false),
      remedy: config
        ? "Set `isDefault: true` on the instance's default agent via `admin_agent_update`."
        : "Config failed to load — see Config group.",
    },
    // ── Services ─────────────────────────────────────────────────────────
    {
      // KPR-229: construct `com.hive.<instanceId>.agent` from config rather
      // than hardcoding "com.hive.agent". Matches the actual LaunchAgent
      // label generated by `hive start --daemon` (e.g. `com.hive.keepur.agent`).
      name: config ? `LaunchAgent com.hive.${config.instance.id}.agent running` : "LaunchAgent running",
      group: "services",
      required: true,
      test: () => {
        if (!config) return false;
        const label = `com.hive.${config.instance.id}.agent`;
        const st = launchctlPrint(label);
        return st.loaded && st.state === "running" && st.pid !== null && pidAlive(st.pid);
      },
      remedy: (() => {
        const uid = process.getuid?.() ?? 0;
        const label = config ? `com.hive.${config.instance.id}.agent` : "com.hive.agent";
        return `launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${label}.plist && launchctl kickstart -k gui/${uid}/${label}`;
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

  // Prompt cache observability (KPR-140). Informational — does not
  // contribute to allPassed; missing telemetry never fails the doctor.
  if (config) {
    const rows = await cacheHitRatesForDoctor(config.mongo.uri, config.mongo.dbName);
    renderPromptCacheSection(rows);
    // KPR-213: prefix-cache stats from the engine heartbeat.
    const prefixStats = await prefixCacheStatsForDoctor(config.mongo.uri, config.mongo.dbName);
    renderPrefixCacheSection(prefixStats);
    // KPR-220 Phase 11: spawn-coordinator per-agent stats.
    const coordinatorRows = await spawnCoordinatorStatsForDoctor(config.mongo.uri, config.mongo.dbName);
    renderSpawnCoordinatorSection(coordinatorRows);
  } else {
    console.log("\nPrompt cache (last 7 days)");
    console.log("  ○ skipped: config not loaded");
    console.log("\nPrefix cache (live engine)");
    console.log("  ○ skipped: config not loaded");
    console.log("\nSpawn coordinator (live engine, per agent)");
    console.log("  ○ skipped: config not loaded");
  }

  if (!allPassed) {
    console.log("\nSome required checks failed. Run with --verbose for remedy hints.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}
