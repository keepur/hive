#!/usr/bin/env npx tsx
// scripts/bench-prefix-cache.ts — KPR-213 hermetic bench
//
// Measures cold and cached buildPrefix latency over 100 iterations against
// a representative agent fixture (chief-of-staff seed shape). Asserts that
// p99 of the cached path is ≤ 100ms.
//
// Hermetic: stubs MemoryManager + TeamRoster so the script doesn't need
// Mongo or any other live dep. The cache is the system under test —
// what we want to measure is "given a cold build, does the second call
// return in the noise floor?".

import { buildPrefix } from "../src/agents/prefix-builder.js";
import { PrefixCache } from "../src/agents/prefix-cache.js";
import type { AgentConfig } from "../src/types/agent-config.js";

const ITERATIONS = 100;
const P99_BUDGET_MS = 100;

// ── Fixtures ──────────────────────────────────────────────────────────

function makeAgentFixture(): AgentConfig {
  return {
    id: "bench-agent",
    name: "BenchAgent",
    model: "claude-sonnet-4-5",
    channels: ["agent-bench"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    icon: "",
    coreServers: ["memory", "structured-memory", "schedule", "team", "team-roster", "slack", "skill-author"],
    delegateServers: [],
    soul:
      "You are BenchAgent. " +
      "You are calm, direct, and prefer evidence over speculation. ".repeat(20),
    systemPrompt:
      "Role: representative system prompt for benchmark. " +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40),
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
  };
}

function makeStubbedMemoryManager() {
  // Fake constitution body — sized roughly like the real one.
  const constitution = "## Constitution\n" + "Each line is approximately representative.\n".repeat(60);
  const hotTier = "## Your Memory\n" + "- [2026-05-09] Memory entry. (high)\n".repeat(20);

  return {
    read: async (path: string): Promise<string | null> => {
      if (path === "shared/constitution.md") return constitution;
      return null;
    },
    list: async (): Promise<string[]> => [],
    getHotTierPrompt: async (): Promise<string | null> => hotTier,
  };
}

function makeStubbedTeamRoster() {
  const summary = "## Team\n" + "- person@example.com — role description. ".repeat(20);
  return {
    teamSummary: async (): Promise<string> => summary,
  };
}

const AUTO_INJECTED = new Set(["schedule", "team", "team-roster", "slack", "skill-author"]);

// ── Bench ─────────────────────────────────────────────────────────────

function p(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function summarize(label: string, samples: number[]): void {
  const p50 = p(samples, 0.5);
  const p99 = p(samples, 0.99);
  const max = Math.max(...samples);
  const min = Math.min(...samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `${label}: n=${samples.length} min=${min.toFixed(2)}ms p50=${p50.toFixed(2)}ms mean=${mean.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
  );
}

async function main(): Promise<void> {
  const agentConfig = makeAgentFixture();
  const memoryManager = makeStubbedMemoryManager();
  const teamRoster = makeStubbedTeamRoster();

  const ctx = {
    coreServerNames: agentConfig.coreServers,
    activeDelegateNames: [] as string[],
    memoryManager: memoryManager as any,
    teamRoster: teamRoster as any,
    plugins: [],
    skillIndex: new Map(),
    prefetcher: undefined,
    eventSubscribersJson: "{}",
    autoInjectedServers: AUTO_INJECTED,
  };

  // Cold builds — invalidate before each call so every iteration is a miss.
  const coldCache = new PrefixCache();
  const coldDurations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    coldCache.invalidateAll("bench-cold");
    const start = performance.now();
    await coldCache.getOrBuild(agentConfig.id, () => buildPrefix(agentConfig, ctx));
    coldDurations.push(performance.now() - start);
  }

  // Cached builds — single warm-up, then repeated hits.
  const warmCache = new PrefixCache();
  await warmCache.getOrBuild(agentConfig.id, () => buildPrefix(agentConfig, ctx));
  const cachedDurations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await warmCache.getOrBuild(agentConfig.id, () => buildPrefix(agentConfig, ctx));
    cachedDurations.push(performance.now() - start);
  }

  console.log("\nKPR-213 prefix-cache bench");
  console.log(`Iterations: ${ITERATIONS}`);
  console.log("");
  summarize("cold (full assembly each iter)", coldDurations);
  summarize("cached (read-through hit)     ", cachedDurations);

  const cachedP99 = p(cachedDurations, 0.99);
  console.log("");
  if (cachedP99 > P99_BUDGET_MS) {
    console.error(`FAIL: cached p99 ${cachedP99.toFixed(2)}ms exceeds budget ${P99_BUDGET_MS}ms`);
    process.exit(1);
  }
  console.log(`PASS: cached p99 ${cachedP99.toFixed(2)}ms ≤ budget ${P99_BUDGET_MS}ms`);
}

main().catch((err) => {
  console.error("bench failed:", err);
  process.exit(1);
});
