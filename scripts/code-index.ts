#!/usr/bin/env npx tsx
// scripts/code-index.ts — Codebase indexer CLI
// Usage:
//   npx tsx scripts/code-index.ts                  # incremental, all repos
//   npx tsx scripts/code-index.ts --repo hive      # hive only
//   npx tsx scripts/code-index.ts --repo dodi_v2   # dodi only
//   npx tsx scripts/code-index.ts --full           # force full re-index

import dotenv from "dotenv";
dotenv.config();

import { CodeIndexer, type RepoConfig } from "../src/code-index/indexer.js";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required");
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
const repoFilter = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
const forceFullReindex = args.includes("--full");

// Default repo configs — can be overridden via hive.yaml but scripts run standalone.
// Operators with private plugin repos (e.g. business-specific MCP servers) should
// add them to their hive.yaml's codeIndex.repos rather than editing this file.
const defaultRepos: Record<string, RepoConfig> = {
  hive: {
    path: "~/github/hive",
    include: ["src/"],
    extensions: [".ts"],
    exclude: ["*.test.ts", "*.spec.ts", "dist/"],
  },
};

async function main(): Promise<void> {
  console.log(`Code Index — ${new Date().toISOString()}`);
  console.log(`  Mode: ${forceFullReindex ? "full" : "incremental"}`);
  if (repoFilter) console.log(`  Repo filter: ${repoFilter}`);

  // Pre-flight: check Ollama
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`Ollama not reachable at ${OLLAMA_URL}: ${err}`);
    process.exit(1);
  }

  // Pre-flight: check Qdrant
  try {
    const res = await fetch(`${QDRANT_URL}/collections`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`Qdrant not reachable at ${QDRANT_URL}: ${err}`);
    process.exit(1);
  }

  const indexer = new CodeIndexer({
    mongoUri: MONGODB_URI!,
    dbName: MONGODB_DB,
    qdrantUrl: QDRANT_URL,
    ollamaUrl: OLLAMA_URL,
    repos: defaultRepos,
    forceFullReindex,
    repoFilter,
  });

  await indexer.init();
  const start = Date.now();

  try {
    const result = await indexer.run();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\nDone in ${elapsed}s — indexed=${result.indexed} skipped=${result.skipped} failed=${result.failed}`);
  } finally {
    await indexer.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
