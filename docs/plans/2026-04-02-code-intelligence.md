# Code Intelligence — Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Goal:** Give agents persistent code understanding via a searchable codebase index and automatic session knowledge capture.

**Architecture:** New `src/code-index/` module with nightly indexer, Qdrant-backed search MCP server, and a prefetcher that injects context into code_task prompts. New `src/code-task/knowledge-extractor.ts` extracts insights post-completion. Both use existing Ollama/Qdrant/MongoDB infra.

**Tech Stack:** TypeScript, MCP SDK, Qdrant, Ollama bge-large, Claude Haiku (summaries), MongoDB, zod

**Spec:** `docs/specs/2026-04-02-code-intelligence-design.md`

---

### Task 1: Config Section

**Files:**
- Modify: `src/config.ts`

Add the `codeIndex` config section, following the `memory:` block pattern.

- [ ] **Step 1:** Add codeIndex config after the `memory` block (after line 234)

```typescript
// In src/config.ts, after the memory: { ... } block and before events: { ... }

  codeIndex: {
    enabled: hive.codeIndex?.enabled === true || process.env.CODE_INDEX_ENABLED === "true",
    scoreThreshold: parseFloat(optional("CODE_INDEX_SCORE_THRESHOLD", String(hive.codeIndex?.scoreThreshold ?? 0.65))),
    prefetchLimit: parseInt(optional("CODE_INDEX_PREFETCH_LIMIT", String(hive.codeIndex?.prefetchLimit ?? 8)), 10),
    sessionKnowledge: {
      enabled:
        (hive.codeIndex?.sessionKnowledge?.enabled ?? true) &&
        process.env.CODE_INDEX_SESSION_KNOWLEDGE !== "false",
    },
    repos: (hive.codeIndex?.repos as Record<string, { path: string; include: string[]; extensions: string[]; exclude: string[] }>) ?? {},
  },
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/config.ts
git commit -m "feat(code-index): add codeIndex config section"
```

---

### Task 2: Types and Utilities

**Files:**
- Create: `src/code-index/code-index-types.ts`

Shared types, UUIDv5 helper, and constants. No external deps beyond Node crypto.

- [ ] **Step 1:** Create the types module

```typescript
// src/code-index/code-index-types.ts
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

// ── Qdrant collection name ──
export const CODE_INDEX_COLLECTION = "code_index";

// ── MongoDB document ──
export interface CodeIndexRecord {
  _id?: ObjectId;
  repo: string;
  filePath: string;
  gitSha: string;
  summary: string;
  exports: string[];
  dependencies: string[];
  role: string;
  language: string;
  lineCount: number;
  qdrantPointId: string;
  indexedAt: Date;
  indexVersion: number;
}

// ── Qdrant payload (denormalized for filter+display) ──
export interface CodeIndexPayload {
  [key: string]: unknown;
  repo: string;
  filePath: string;
  role: string;
  language: string;
  summary: string;
}

// ── Haiku extraction output per file ──
export interface FileSummary {
  filePath: string;
  summary: string;
  exports: string[];
  dependencies: string[];
  role: string;
}

// ── Search result ──
export interface CodeSearchResult {
  filePath: string;
  repo: string;
  summary: string;
  exports: string[];
  role: string;
  score: number;
}

// ── Deterministic UUIDv5 from repo:filePath ──
// Uses DNS namespace (6ba7b810-9dad-11d1-80b4-00c04fd430c8)
const UUID_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

export function deterministicUUID(input: string): string {
  const hash = createHash("sha1").update(Buffer.concat([UUID_NAMESPACE, Buffer.from(input)])).digest();
  // Set version 5 (bits 4-7 of byte 6)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // Set variant (bits 6-7 of byte 8)
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const INDEX_VERSION = 1;

// ── File role classification hint for Haiku prompt ──
export const ROLE_OPTIONS = ["entry", "config", "model", "service", "handler", "util", "test", "type-defs", "component", "hook", "middleware", "migration", "script", "other"] as const;
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-index/code-index-types.ts
git commit -m "feat(code-index): add shared types and UUIDv5 helper"
```

---

### Task 3: Indexer Core

**Files:**
- Create: `src/code-index/indexer.ts`

The main indexing pipeline: discover files, diff against last run, summarize via Haiku, embed via Ollama, store in Qdrant + MongoDB. This is a library module — the CLI entry point wraps it.

- [ ] **Step 1:** Create the indexer module

```typescript
// src/code-index/indexer.ts
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import Anthropic from "@anthropic-ai/sdk";
import { embedOllama, EMBED_MODEL } from "../search/embed-utils.js";
import {
  type CodeIndexRecord,
  type CodeIndexPayload,
  type FileSummary,
  CODE_INDEX_COLLECTION,
  deterministicUUID,
  INDEX_VERSION,
  ROLE_OPTIONS,
} from "./code-index-types.js";

export interface RepoConfig {
  path: string;
  include: string[];
  extensions: string[];
  exclude: string[];
}

export interface IndexerOptions {
  mongoUri: string;
  dbName: string;
  qdrantUrl: string;
  ollamaUrl: string;
  repos: Record<string, RepoConfig>;
  forceFullReindex?: boolean;
  repoFilter?: string; // only index this repo
}

interface DiscoveredFile {
  repo: string;
  filePath: string; // relative to repo root
  absPath: string;
  gitSha: string;
  lineCount: number;
  language: string;
}

export class CodeIndexer {
  private mongo!: MongoClient;
  private db!: Db;
  private collection!: Collection<CodeIndexRecord>;
  private qdrant!: QdrantClient;
  private anthropic!: Anthropic;
  private collectionReady = false;

  constructor(private options: IndexerOptions) {}

  async init(): Promise<void> {
    this.mongo = new MongoClient(this.options.mongoUri);
    await this.mongo.connect();
    this.db = this.mongo.db(this.options.dbName);
    this.collection = this.db.collection<CodeIndexRecord>("code_index");

    // Ensure indexes
    await this.collection.createIndex({ repo: 1, filePath: 1 }, { unique: true });
    await this.collection.createIndex({ repo: 1, role: 1 });
    await this.collection.createIndex({ indexedAt: 1 });

    this.qdrant = new QdrantClient({ url: this.options.qdrantUrl });
    this.anthropic = new Anthropic();
  }

  async close(): Promise<void> {
    await this.mongo.close();
  }

  /** Ensure Qdrant collection exists */
  private async ensureQdrantCollection(): Promise<void> {
    if (this.collectionReady) return;
    const { collections } = await this.qdrant.getCollections();
    if (!collections.some((c) => c.name === CODE_INDEX_COLLECTION)) {
      const testVector = await embedOllama(this.options.ollamaUrl, "test");
      await this.qdrant.createCollection(CODE_INDEX_COLLECTION, {
        vectors: { size: testVector.length, distance: "Cosine" },
      });
      console.log(`Created Qdrant collection '${CODE_INDEX_COLLECTION}' (dim=${testVector.length})`);
    }
    this.collectionReady = true;
  }

  /** Main entry point */
  async run(): Promise<{ indexed: number; skipped: number; failed: number }> {
    await this.ensureQdrantCollection();

    let totalIndexed = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    const repos = this.options.repoFilter
      ? { [this.options.repoFilter]: this.options.repos[this.options.repoFilter] }
      : this.options.repos;

    for (const [repoName, repoConfig] of Object.entries(repos)) {
      if (!repoConfig) {
        console.warn(`Repo '${repoName}' not found in config, skipping`);
        continue;
      }
      console.log(`\n=== Indexing ${repoName} (${repoConfig.path}) ===`);
      const { indexed, skipped, failed } = await this.indexRepo(repoName, repoConfig);
      totalIndexed += indexed;
      totalSkipped += skipped;
      totalFailed += failed;
      console.log(`  ${repoName}: indexed=${indexed} skipped=${skipped} failed=${failed}`);
    }

    // Clean up deleted files
    await this.pruneDeletedFiles(repos);

    return { indexed: totalIndexed, skipped: totalSkipped, failed: totalFailed };
  }

  /** Index a single repo */
  private async indexRepo(
    repoName: string,
    repoConfig: RepoConfig,
  ): Promise<{ indexed: number; skipped: number; failed: number }> {
    const files = this.discoverFiles(repoName, repoConfig);
    console.log(`  Discovered ${files.length} files`);

    // Diff against last run
    const changed = this.options.forceFullReindex ? files : await this.filterChanged(files);
    console.log(`  ${changed.length} files need (re)indexing`);

    if (changed.length === 0) return { indexed: 0, skipped: files.length, failed: 0 };

    // Batch summarize
    let indexed = 0;
    let failed = 0;
    const batches = this.batchFiles(changed);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`  Batch ${i + 1}/${batches.length} (${batch.length} files)`);
      try {
        const summaries = await this.summarizeBatch(batch);
        await this.storeBatch(batch, summaries);
        indexed += batch.length;
      } catch (err) {
        // Retry individually on batch failure
        console.warn(`  Batch failed, retrying ${batch.length} files individually`);
        for (const file of batch) {
          try {
            const summaries = await this.summarizeBatch([file]);
            await this.storeBatch([file], summaries);
            indexed++;
          } catch (fileErr) {
            console.error(`  Failed to index ${file.repo}:${file.filePath}: ${fileErr}`);
            failed++;
          }
        }
      }
    }

    return { indexed, skipped: files.length - changed.length, failed };
  }

  /** Walk repo for matching source files */
  private discoverFiles(repoName: string, repoConfig: RepoConfig): DiscoveredFile[] {
    const repoPath = resolve(repoConfig.path.replace(/^~/, process.env.HOME ?? ""));
    const files: DiscoveredFile[] = [];

    // Use git ls-files for .gitignore-aware file listing
    const gitOutput = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });

    for (const line of gitOutput.split("\n")) {
      const filePath = line.trim();
      if (!filePath) continue;

      // Check include patterns (simple prefix match)
      const matchesInclude = repoConfig.include.some((inc) => {
        const prefix = inc.replace(/\*\*.*$/, "");
        return filePath.startsWith(prefix);
      });
      if (!matchesInclude) continue;

      // Check extension
      const ext = extname(filePath);
      if (!repoConfig.extensions.includes(ext)) continue;

      // Check exclude patterns
      const excluded = repoConfig.exclude.some((exc) => {
        if (exc.startsWith("*.")) return filePath.endsWith(exc.slice(1));
        return filePath.includes(exc.replace(/\/$/, ""));
      });
      if (excluded) continue;

      const absPath = resolve(repoPath, filePath);
      let content: string;
      try {
        content = readFileSync(absPath, "utf-8");
      } catch {
        continue; // file might have been deleted between ls-files and read
      }

      const gitSha = createHash("sha1").update(content).digest("hex");
      const lineCount = content.split("\n").length;
      const language = ext === ".tsx" ? "tsx" : ext === ".ts" ? "typescript" : "javascript";

      files.push({ repo: repoName, filePath, absPath, gitSha, lineCount, language });
    }

    return files;
  }

  /** Filter to only files whose SHA differs from stored SHA */
  private async filterChanged(files: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    if (files.length === 0) return [];

    const repo = files[0].repo;
    const existing = await this.collection
      .find({ repo }, { projection: { filePath: 1, gitSha: 1 } })
      .toArray();
    const shaMap = new Map(existing.map((r) => [r.filePath, r.gitSha]));

    return files.filter((f) => shaMap.get(f.filePath) !== f.gitSha);
  }

  /** Group files into batches: small files (<=200 lines) batched 5-10, large files alone */
  private batchFiles(files: DiscoveredFile[]): DiscoveredFile[][] {
    const small: DiscoveredFile[] = [];
    const large: DiscoveredFile[] = [];

    for (const f of files) {
      if (f.lineCount <= 200) small.push(f);
      else large.push(f);
    }

    const batches: DiscoveredFile[][] = [];

    // Batch small files in groups of 8
    for (let i = 0; i < small.length; i += 8) {
      batches.push(small.slice(i, i + 8));
    }

    // Large files go alone
    for (const f of large) {
      batches.push([f]);
    }

    return batches;
  }

  /** Call Haiku to summarize a batch of files */
  private async summarizeBatch(files: DiscoveredFile[]): Promise<Map<string, FileSummary>> {
    const fileContents = files.map((f) => {
      let content = readFileSync(f.absPath, "utf-8");
      // Truncate large files to first 300 lines
      const lines = content.split("\n");
      const truncated = lines.length > 300;
      if (truncated) content = lines.slice(0, 300).join("\n");
      return `### ${f.repo}:${f.filePath} (${f.language}, ${f.lineCount} lines${truncated ? ", TRUNCATED" : ""})\n\`\`\`\n${content}\n\`\`\``;
    });

    const prompt = `Analyze each source file below. For each file, output a JSON object with these fields:
- filePath: string (the relative path as given)
- summary: string (one sentence describing what this file does)
- exports: string[] (names of exported functions, classes, constants, types)
- dependencies: string[] (imported project modules — skip node_modules/external packages)
- role: string (one of: ${ROLE_OPTIONS.join(", ")})

Return a JSON array of objects. Only JSON, no other text.

${fileContents.join("\n\n")}`;

    const response = await this.anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // Extract JSON from response (may be wrapped in ```json blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`No JSON array in Haiku response for batch starting with ${files[0].filePath}`);

    const parsed: FileSummary[] = JSON.parse(jsonMatch[0]);
    const map = new Map<string, FileSummary>();
    for (const s of parsed) map.set(s.filePath, s);
    return map;
  }

  /** Store summaries to MongoDB + Qdrant */
  private async storeBatch(files: DiscoveredFile[], summaries: Map<string, FileSummary>): Promise<void> {
    for (const file of files) {
      const summary = summaries.get(file.filePath) ?? summaries.get(`${file.repo}:${file.filePath}`);
      if (!summary) {
        console.warn(`  No summary returned for ${file.filePath}, skipping`);
        continue;
      }

      const pointId = deterministicUUID(`${file.repo}:${file.filePath}`);

      // Embed summary text
      const embedText = `${file.filePath}: ${summary.summary}. Exports: ${summary.exports.join(", ")}. Role: ${summary.role}`;
      const vector = await embedOllama(this.options.ollamaUrl, embedText);

      // Upsert MongoDB
      const record: Omit<CodeIndexRecord, "_id"> = {
        repo: file.repo,
        filePath: file.filePath,
        gitSha: file.gitSha,
        summary: summary.summary,
        exports: summary.exports,
        dependencies: summary.dependencies,
        role: summary.role,
        language: file.language,
        lineCount: file.lineCount,
        qdrantPointId: pointId,
        indexedAt: new Date(),
        indexVersion: INDEX_VERSION,
      };

      await this.collection.updateOne(
        { repo: file.repo, filePath: file.filePath },
        { $set: record },
        { upsert: true },
      );

      // Upsert Qdrant
      const payload: CodeIndexPayload = {
        repo: file.repo,
        filePath: file.filePath,
        role: summary.role,
        language: file.language,
        summary: summary.summary,
      };

      await this.qdrant.upsert(CODE_INDEX_COLLECTION, {
        points: [{ id: pointId, vector, payload }],
      });
    }
  }

  /** Remove index entries for files that no longer exist in the repo */
  private async pruneDeletedFiles(repos: Record<string, RepoConfig | undefined>): Promise<void> {
    for (const [repoName, repoConfig] of Object.entries(repos)) {
      if (!repoConfig) continue;
      const currentFiles = this.discoverFiles(repoName, repoConfig);
      const currentPaths = new Set(currentFiles.map((f) => f.filePath));

      const indexed = await this.collection.find({ repo: repoName }, { projection: { filePath: 1, qdrantPointId: 1 } }).toArray();
      const toDelete = indexed.filter((r) => !currentPaths.has(r.filePath));

      if (toDelete.length > 0) {
        console.log(`  Pruning ${toDelete.length} deleted files from ${repoName}`);
        const ids = toDelete.map((r) => r._id!);
        await this.collection.deleteMany({ _id: { $in: ids } });
        // Remove from Qdrant
        const pointIds = toDelete.map((r) => r.qdrantPointId);
        await this.qdrant.delete(CODE_INDEX_COLLECTION, { points: pointIds });
      }
    }
  }
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-index/indexer.ts
git commit -m "feat(code-index): add indexer pipeline with Haiku summaries and Qdrant storage"
```

---

### Task 4: CLI Entry Script

**Files:**
- Create: `scripts/code-index.ts`

Standalone CLI wrapper for the indexer. Reads config from env/.env, parses CLI args.

- [ ] **Step 1:** Create the entry script

```typescript
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

// Default repo configs — can be overridden via hive.yaml but scripts run standalone
const defaultRepos: Record<string, RepoConfig> = {
  hive: {
    path: "~/github/hive",
    include: ["src/", "plugins/dodi/"],
    extensions: [".ts"],
    exclude: ["*.test.ts", "*.spec.ts", "dist/"],
  },
  dodi_v2: {
    path: "~/dev/dodi_v2",
    include: ["src/modules/", "src/apps/", "src/services/"],
    extensions: [".ts", ".tsx", ".js"],
    exclude: ["*.test.", "*.spec.", "node_modules/", ".meteor/", "dist/", "build/"],
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
```

- [ ] **Step 2:** Make executable

Run: `chmod +x scripts/code-index.ts`

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation (the script imports from src/ which is fine for tsx)

- [ ] **Step 4:** Commit

```bash
git add scripts/code-index.ts
git commit -m "feat(code-index): add CLI entry script for codebase indexer"
```

---

### Task 5: Code Search MCP Server

**Files:**
- Create: `src/code-index/code-search-mcp-server.ts`

Stdio MCP server exposing `code_search` and `code_lookup` tools. Follows the conversation-search pattern.

- [ ] **Step 1:** Create the MCP server

```typescript
#!/usr/bin/env node
// src/code-index/code-search-mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient, type Collection } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embedOllama } from "../search/embed-utils.js";
import { CODE_INDEX_COLLECTION, type CodeIndexRecord, type CodeSearchResult } from "./code-index-types.js";

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

let mongo: MongoClient;
let collection: Collection<CodeIndexRecord>;
let qdrant: QdrantClient;

async function ensureConnected(): Promise<void> {
  if (!mongo) {
    mongo = new MongoClient(MONGODB_URI);
    await mongo.connect();
    collection = mongo.db(MONGODB_DB).collection<CodeIndexRecord>("code_index");
    qdrant = new QdrantClient({ url: QDRANT_URL });
  }
}

const server = new McpServer({ name: "code-search", version: "0.1.0" });

server.registerTool(
  "code_search",
  {
    title: "Code Search",
    description:
      "Semantic search over the codebase index. Returns matching source files with summaries, exports, and relevance scores. Use to find where specific functionality lives.",
    inputSchema: {
      query: z.string().describe("Natural language query, e.g. 'where is agent routing handled?'"),
      repo: z.enum(["hive", "dodi_v2"]).optional().describe("Filter to a specific repo. Default: search both"),
      role: z.string().optional().describe("Filter by file role: entry, config, model, service, handler, util, etc."),
      limit: z.number().min(1).max(50).optional().describe("Max results. Default: 10"),
    },
  },
  async ({ query, repo, role, limit }) => {
    await ensureConnected();

    const queryVector = await embedOllama(OLLAMA_URL, query);
    const searchLimit = limit ?? 10;

    const must: any[] = [];
    if (repo) must.push({ key: "repo", match: { value: repo } });
    if (role) must.push({ key: "role", match: { value: role } });

    const results = await qdrant.search(CODE_INDEX_COLLECTION, {
      vector: queryVector,
      limit: searchLimit,
      with_payload: true,
      filter: must.length > 0 ? { must } : undefined,
    });

    const searchResults: CodeSearchResult[] = results.map((r) => ({
      filePath: (r.payload?.filePath as string) ?? "",
      repo: (r.payload?.repo as string) ?? "",
      summary: (r.payload?.summary as string) ?? "",
      exports: [],
      role: (r.payload?.role as string) ?? "",
      score: r.score,
    }));

    // Enrich with full data from MongoDB for top results
    if (searchResults.length > 0) {
      const repoFilePairs = searchResults.map((r) => ({ repo: r.repo, filePath: r.filePath }));
      const fullRecords = await collection.find({ $or: repoFilePairs }).toArray();
      const recordMap = new Map(fullRecords.map((r) => [`${r.repo}:${r.filePath}`, r]));

      for (const result of searchResults) {
        const full = recordMap.get(`${result.repo}:${result.filePath}`);
        if (full) result.exports = full.exports;
      }
    }

    if (searchResults.length === 0) {
      return { content: [{ type: "text", text: "No matching files found in the code index." }] };
    }

    const text = searchResults
      .map(
        (r) =>
          `**${r.repo}:${r.filePath}** (${r.role}, score: ${r.score.toFixed(3)})\n${r.summary}${r.exports.length > 0 ? `\nExports: ${r.exports.join(", ")}` : ""}`,
      )
      .join("\n\n");

    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "code_lookup",
  {
    title: "Code Lookup",
    description: "Look up full index record for a specific file path. Returns summary, exports, dependencies, and role.",
    inputSchema: {
      filePath: z.string().describe("Relative file path, e.g. 'src/gateway/dispatcher.ts'"),
      repo: z.string().optional().describe("Which repo. Default: search both"),
    },
  },
  async ({ filePath, repo }) => {
    await ensureConnected();

    const query: any = { filePath };
    if (repo) query.repo = repo;

    const record = await collection.findOne(query);

    if (!record) {
      return { content: [{ type: "text", text: `File '${filePath}' is not in the code index.` }] };
    }

    const text = [
      `**${record.repo}:${record.filePath}** (${record.language}, ${record.lineCount} lines)`,
      `**Role:** ${record.role}`,
      `**Summary:** ${record.summary}`,
      `**Exports:** ${record.exports.join(", ") || "(none)"}`,
      `**Dependencies:** ${record.dependencies.join(", ") || "(none)"}`,
      `**Last indexed:** ${record.indexedAt.toISOString()} (SHA: ${record.gitSha.slice(0, 8)})`,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  },
);

function cleanup(): void {
  if (mongo) mongo.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-index/code-search-mcp-server.ts
git commit -m "feat(code-index): add code-search MCP server with code_search and code_lookup tools"
```

---

### Task 6: Prefetcher

**Files:**
- Create: `src/code-index/prefetcher.ts`

Standalone class that queries both the code index and agent memory for relevant context. Injected into CodeTaskManager.

- [ ] **Step 1:** Create the prefetcher

```typescript
// src/code-index/prefetcher.ts
import { QdrantClient } from "@qdrant/js-client-rest";
import { MongoClient, type Collection } from "mongodb";
import { embedOllama } from "../search/embed-utils.js";
import { CODE_INDEX_COLLECTION, type CodeIndexRecord } from "./code-index-types.js";

export interface PrefetcherOptions {
  mongoUri: string;
  dbName: string;
  qdrantUrl: string;
  ollamaUrl: string;
  scoreThreshold?: number;
  prefetchLimit?: number;
}

export class CodeIndexPrefetcher {
  private mongo!: MongoClient;
  private collection!: Collection<CodeIndexRecord>;
  private qdrant!: QdrantClient;
  private connected = false;
  private scoreThreshold: number;
  private prefetchLimit: number;

  constructor(private options: PrefetcherOptions) {
    this.scoreThreshold = options.scoreThreshold ?? 0.65;
    this.prefetchLimit = options.prefetchLimit ?? 8;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    this.mongo = new MongoClient(this.options.mongoUri);
    await this.mongo.connect();
    this.collection = this.mongo.db(this.options.dbName).collection<CodeIndexRecord>("code_index");
    this.qdrant = new QdrantClient({ url: this.options.qdrantUrl });
    this.connected = true;
  }

  /**
   * Get pre-fetched codebase context for a code_task prompt.
   * Returns a markdown block to prepend, or empty string if nothing relevant.
   */
  async getContext(prompt: string, agentId?: string): Promise<string> {
    try {
      await this.ensureConnected();
    } catch (err) {
      // Degrade gracefully — don't block task spawn
      return "";
    }

    const sections: string[] = [];

    // 1. Query code index
    try {
      const queryVector = await embedOllama(this.options.ollamaUrl, prompt);

      const codeResults = await this.qdrant.search(CODE_INDEX_COLLECTION, {
        vector: queryVector,
        limit: this.prefetchLimit,
        with_payload: true,
      });

      const relevant = codeResults.filter((r) => r.score >= this.scoreThreshold);
      if (relevant.length > 0) {
        const lines = relevant.map((r) => {
          const p = r.payload as Record<string, unknown>;
          return `- **${p.repo}:${p.filePath}** — ${p.summary} (${p.role})`;
        });
        sections.push("**Relevant files:**\n" + lines.join("\n"));
      }
    } catch {
      // Qdrant/Ollama down — skip code index
    }

    // 2. Query agent memory for code knowledge
    // Note: Qdrant doesn't support prefix matching on payload fields without a text index.
    // We filter by agentId in Qdrant and post-filter by topic prefix in application code.
    if (agentId) {
      try {
        const queryVector = await embedOllama(this.options.ollamaUrl, prompt);

        const memResults = await this.qdrant.search("agent_memory", {
          vector: queryVector,
          limit: 15, // fetch extra to account for post-filter
          with_payload: true,
          filter: {
            must: [
              { key: "agentId", match: { value: agentId } },
            ],
          },
        });

        const relevant = memResults
          .filter((r) => r.score >= this.scoreThreshold)
          .filter((r) => typeof r.payload?.topic === "string" && (r.payload.topic as string).startsWith("code:"));
        if (relevant.length > 0) {
          // Fetch full content from MongoDB
          const mongoIds = relevant.map((r) => r.payload?.mongoId as string).filter(Boolean);
          if (mongoIds.length > 0) {
            const memCollection = this.mongo.db(this.options.dbName).collection("agent_memory");
            const { ObjectId } = await import("mongodb");
            const records = await memCollection
              .find({ _id: { $in: mongoIds.map((id) => new ObjectId(id)) } })
              .toArray();

            if (records.length > 0) {
              const lines = records.map((r: any) => `- ${r.topic.replace(/^code:/, "")}: ${r.content}`);
              sections.push("**Previous session insights:**\n" + lines.join("\n"));
            }
          }
        }
      } catch {
        // Memory search failed — skip
      }
    }

    if (sections.length === 0) return "";

    return [
      "## Codebase Context (auto-retrieved)",
      ...sections,
      "",
      "_Results may be stale — verify by reading files._",
    ].join("\n");
  }

  async close(): Promise<void> {
    if (this.connected) await this.mongo.close();
  }
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-index/prefetcher.ts
git commit -m "feat(code-index): add CodeIndexPrefetcher for code_task context injection"
```

---

### Task 7: Knowledge Extractor

**Files:**
- Create: `src/code-task/knowledge-extractor.ts`

Post-completion Haiku extraction that persists code insights to the memory system.

- [ ] **Step 1:** Create the knowledge extractor

```typescript
// src/code-task/knowledge-extractor.ts
import Anthropic from "@anthropic-ai/sdk";
import { MongoClient, type Collection, type Db, ObjectId } from "mongodb";
import { MemoryStore } from "../memory/memory-store.js";
import { MemoryEmbedder } from "../memory/memory-embedder.js";
import type { MemoryRecordInput } from "../memory/memory-types.js";
import type { ClaudeCodeOutput } from "./output-parser.js";

export interface KnowledgeExtractorOptions {
  mongoUri: string;
  dbName: string;
  qdrantUrl: string;
  ollamaUrl: string;
}

interface ExtractedInsight {
  filePath: string;
  repo: string;
  insight: string;
  wasModified: boolean;
}

export class KnowledgeExtractor {
  private anthropic: Anthropic;
  private memoryStore: MemoryStore;
  private memoryEmbedder: MemoryEmbedder;

  constructor(private options: KnowledgeExtractorOptions) {
    this.anthropic = new Anthropic();
    this.memoryStore = new MemoryStore(options.mongoUri, options.dbName);
    this.memoryEmbedder = new MemoryEmbedder(options.qdrantUrl, options.ollamaUrl);
  }

  async init(): Promise<void> {
    await this.memoryStore.init();
  }

  async close(): Promise<void> {
    await this.memoryStore.close();
  }

  /**
   * Extract code insights from a completed code_task output and save to memory.
   * Fire-and-forget safe — logs errors, never throws.
   */
  async extract(agentId: string, output: ClaudeCodeOutput | null): Promise<number> {
    if (!output?.result) return 0;

    // Truncate very long outputs to stay within Haiku context
    const resultText = output.result.length > 30000 ? output.result.slice(0, 30000) + "\n[...truncated]" : output.result;

    const response = await this.anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `Extract code insights from this completed coding session. For each source file the session read or modified, note:
- filePath: the relative file path
- repo: which repo (hive or dodi_v2), infer from the working directory or file paths
- insight: what was learned — what the file does, key patterns, gotchas, architectural decisions. Be specific and useful for a future session working on the same code.
- wasModified: true if the file was created or edited, false if only read

Return a JSON array. Only include files where the session gained meaningful understanding — skip trivial reads (package.json, tsconfig, etc). Only JSON, no other text.

Session output:
${resultText}`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    let insights: ExtractedInsight[];
    try {
      insights = JSON.parse(jsonMatch[0]);
    } catch {
      return 0;
    }

    let saved = 0;
    for (const insight of insights) {
      if (!insight.filePath || !insight.insight) continue;

      const topic = `code:${insight.repo ?? "unknown"}:${insight.filePath}`;

      try {
        // Delete-before-save: find prior records FIRST, then clean up Qdrant, then delete from MongoDB
        const memCollection = this.memoryStore.getCollection();
        const priorRecords = await memCollection.find({ agentId, topic, pinned: { $ne: true } }).toArray();

        // Remove their Qdrant vectors before deleting from MongoDB
        for (const rec of priorRecords) {
          if (rec.qdrantPointId) {
            await this.memoryEmbedder.remove(rec.qdrantPointId).catch(() => {});
          }
        }

        // Now delete from MongoDB
        if (priorRecords.length > 0) {
          await memCollection.deleteMany({ _id: { $in: priorRecords.map((r) => r._id!) } });
        }

        // Save new record
        const input: MemoryRecordInput = {
          content: insight.insight,
          type: "fact",
          topic,
          importance: insight.wasModified ? "high" : "medium",
        };

        const pointId = crypto.randomUUID();
        const record = await this.memoryStore.save(agentId, input, pointId);

        // Embed
        await this.memoryEmbedder.upsert(pointId, insight.insight, {
          agentId,
          mongoId: record._id!.toString(),
          type: "fact",
          topic,
          tier: "hot",
          importance: input.importance,
          createdAt: Date.now(),
        });

        saved++;
      } catch (err) {
        console.error(`Knowledge extractor: failed to save insight for ${topic}:`, err);
      }
    }

    return saved;
  }
}
```

- [ ] **Step 2:** Add `getCollection()` accessor to MemoryStore

The knowledge extractor needs direct collection access for `deleteMany`. Add a public accessor to `src/memory/memory-store.ts`:

```typescript
// Add to MemoryStore class in src/memory/memory-store.ts, after the init() method:

  /** Expose collection for advanced queries (e.g., knowledge extractor delete-before-save) */
  getCollection(): Collection<MemoryRecord> {
    return this.collection;
  }
```

Note: `close()` already exists in `MemoryStore` (line 233). Do NOT add a duplicate.

- [ ] **Step 3:** Add `remove()` method to MemoryEmbedder

Add to `src/memory/memory-embedder.ts`:

```typescript
  /** Remove a point from Qdrant by ID */
  async remove(pointId: string): Promise<void> {
    await this.ensureCollection();
    await this.getClient().delete(COLLECTION, { points: [pointId] });
  }
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 5:** Commit

```bash
git add src/code-task/knowledge-extractor.ts src/memory/memory-store.ts src/memory/memory-embedder.ts
git commit -m "feat(code-index): add KnowledgeExtractor for post-completion session insight capture"
```

---

### Task 8: Wire into CodeTaskManager

**Files:**
- Modify: `src/code-task/code-task-manager.ts`
- Modify: `src/index.ts`

Integrate the prefetcher (context injection on spawn) and knowledge extractor (post-completion).

- [ ] **Step 1:** Extend `CodeTaskManagerOptions` in code-task-manager.ts

```typescript
// At top of file, add imports:
import { CodeIndexPrefetcher } from "../code-index/prefetcher.js";
import { KnowledgeExtractor } from "./knowledge-extractor.js";

// Extend the interface:
export interface CodeTaskManagerOptions {
  cliBin?: string;
  prefetcher?: CodeIndexPrefetcher;
  knowledgeExtractor?: KnowledgeExtractor;
}
```

Also store options as a class property. In the class field declarations, add:

```typescript
private options: CodeTaskManagerOptions;
```

And in the constructor body, replace the existing `this.cliBin = options?.cliBin ?? "claude"` with:

```typescript
this.options = options ?? {};
this.cliBin = this.options.cliBin ?? "claude";
```

- [ ] **Step 2:** Add prefetch call in `spawnTask()`

In the `spawnTask` method, before the quality-gate append (before the line that appends "IMPORTANT: After completing implementation..."), add:

```typescript
    // Pre-fetch codebase context if available
    if (this.options?.prefetcher) {
      try {
        const context = await this.options.prefetcher.getContext(
          body.prompt,
          body.context.agentId,
        );
        if (context) {
          body.prompt = context + "\n\n---\n\n" + body.prompt;
        }
      } catch (err) {
        // Don't block task spawn on prefetch failure
        log.warn(`Prefetch failed for task, proceeding without context: ${err}`);
      }
    }
```

- [ ] **Step 3:** Add knowledge extraction call in `fireCompletion()`

Inside `fireCompletion()`, after the `this.onComplete(completionItem)` call (inside the `.then()` block), add:

```typescript
        // Extract and persist code knowledge (fire-and-forget)
        if (this.options?.knowledgeExtractor && task.status === "completed" && output) {
          this.options.knowledgeExtractor
            .extract(task.context.agentId, output)
            .then((count) => {
              if (count > 0) log.info(`Extracted ${count} code insights from task ${task.id}`);
            })
            .catch((err) => {
              log.warn(`Knowledge extraction failed for task ${task.id}: ${err}`);
            });
        }
```

- [ ] **Step 4:** Wire in `src/index.ts`

Before the CodeTaskManager construction, add:

```typescript
  // Code index prefetcher + knowledge extractor (optional — only when codeIndex enabled)
  let prefetcher: CodeIndexPrefetcher | undefined;
  let knowledgeExtractor: KnowledgeExtractor | undefined;

  if (config.codeIndex.enabled) {
    const { CodeIndexPrefetcher } = await import("./code-index/prefetcher.js");
    const { KnowledgeExtractor } = await import("./code-task/knowledge-extractor.js");

    prefetcher = new CodeIndexPrefetcher({
      mongoUri: config.mongo.uri,
      dbName: config.mongo.dbName,
      qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
      ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
      scoreThreshold: config.codeIndex.scoreThreshold,
      prefetchLimit: config.codeIndex.prefetchLimit,
    });

    if (config.codeIndex.sessionKnowledge.enabled) {
      knowledgeExtractor = new KnowledgeExtractor({
        mongoUri: config.mongo.uri,
        dbName: config.mongo.dbName,
        qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
        ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
      });
      await knowledgeExtractor.init();
    }

    log.info("Code index integration enabled", {
      prefetch: true,
      sessionKnowledge: config.codeIndex.sessionKnowledge.enabled,
    });
  }
```

Then update the CodeTaskManager construction to pass options:

```typescript
  const codeTaskManager = new CodeTaskManager(
    config.codeTask.port,
    config.codeTask.authToken,
    config.codeTask.pluginDir,
    config.codeTask.maxConcurrent,
    config.tasksDir.code,
    (item) =>
      dispatcher.dispatch(item).catch((err) => {
        log.error("Code task completion dispatch failed", { error: String(err) });
      }),
    { prefetcher, knowledgeExtractor },
  );
```

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 6:** Commit

```bash
git add src/code-task/code-task-manager.ts src/index.ts
git commit -m "feat(code-index): wire prefetcher and knowledge extractor into CodeTaskManager"
```

---

### Task 9: Wire code-search MCP Server into Agent Runner

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify: `plugins/dodi/agent-seeds/vp-engineering.yaml`
- Modify: `plugins/dodi/agent-seeds/product-manager.yaml`

- [ ] **Step 1:** Add `code-search` server config in `buildAllServerConfigs()`

In `agent-runner.ts`, after the `conversation-search` server block (after the `servers["conversation-search"] = { ... }` assignment), add:

```typescript
    // ── Code Search ──────────────────────────────────────────────
    // Semantic search over codebase file index (Qdrant + MongoDB)
    servers["code-search"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/code-index/code-search-mcp-server.js")],
      env: {
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
        OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
      },
    };
```

- [ ] **Step 2:** Add `code-search` to Jasper's coreServers in seed file

In `plugins/dodi/agent-seeds/vp-engineering.yaml`, add `code-search` to the `coreServers` list:

```yaml
coreServers:
  - memory
  - conversation-search
  - code-search
  - slack
  - keychain
  - background
```

- [ ] **Step 3:** Add `code-search` to Chloe's coreServers in seed file

In `plugins/dodi/agent-seeds/product-manager.yaml`, add `code-search` to the `coreServers` list:

```yaml
coreServers:
  - memory
  - slack
  - contacts
  - crm-search
  - product-search
  - code-search
```

- [ ] **Step 4:** Regenerate agent directories from seeds

Run: `npm run setup:agents`
Expected: agents/ directory updated with new coreServers

- [ ] **Step 5:** Update live DB records

Run the following to add `code-search` to the live agent definitions in MongoDB:

```bash
mongosh --eval '
  db = db.getSiblingDB("hive");
  // Jasper (vp-engineering)
  db.agent_definitions.updateOne(
    { id: "vp-engineering" },
    { $addToSet: { coreServers: "code-search" } }
  );
  // Chloe (product-manager)
  db.agent_definitions.updateOne(
    { id: "product-manager" },
    { $addToSet: { coreServers: "code-search" } }
  );
  print("Updated agent definitions");
'
```

Note: Mokie lives in the personal instance — see Post-Merge manual steps for update command.

- [ ] **Step 6:** Verify

Run: `npx tsc --noEmit`
Expected: clean compilation

- [ ] **Step 7:** Commit

```bash
git add src/agents/agent-runner.ts plugins/dodi/agent-seeds/vp-engineering.yaml plugins/dodi/agent-seeds/product-manager.yaml
git commit -m "feat(code-index): wire code-search MCP server into agent-runner and enable for Jasper/Chloe"
```

---

### Task 10: Quality Gate

- [ ] **Step 1:** Build

Run: `npm run build`
Expected: clean build, no errors

- [ ] **Step 2:** Typecheck

Run: `npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 3:** Lint (if configured)

Run: `npm run check` (or `npm run lint` if available)
Expected: clean

- [ ] **Step 4:** Verify new files are included in build output

Run: `ls dist/code-index/`
Expected: `code-index-types.js`, `code-search-mcp-server.js`, `indexer.js`, `prefetcher.js`

- [ ] **Step 5:** Smoke test — dry run the indexer (check connectivity)

Run: `npx tsx scripts/code-index.ts --repo hive 2>&1 | head -20`
Expected: should connect to MongoDB/Qdrant/Ollama and start discovering files (or fail with clear connectivity error if services aren't running)

---

### Post-Merge: Manual Steps

These are not automated — do after the PR merges and deploys:

1. **Add crontab entry:**
```bash
crontab -e
# Add:
0 5 * * *  cd /Users/mokie/github/hive && npx tsx scripts/code-index.ts >> logs/code-index.log 2>&1
```

2. **Add to hive.yaml (both dev and deploy):**
```yaml
codeIndex:
  enabled: true
  repos:
    hive:
      path: ~/github/hive
      include: ["src/", "plugins/dodi/"]
      extensions: [".ts"]
      exclude: ["*.test.ts", "*.spec.ts", "dist/"]
    dodi_v2:
      path: ~/dev/dodi_v2
      include: ["src/modules/", "src/apps/", "src/services/"]
      extensions: [".ts", ".tsx", ".js"]
      exclude: ["*.test.", "*.spec.", "node_modules/", ".meteor/", "dist/", "build/"]
  sessionKnowledge:
    enabled: true
```

3. **Run initial full index:**
```bash
npx tsx scripts/code-index.ts --full
```

4. **Update Mokie (personal instance):**
```bash
mongosh --eval '
  db = db.getSiblingDB("hive_personal");
  db.agent_definitions.updateOne(
    { id: "chief-of-staff" },
    { $addToSet: { coreServers: "code-search" } }
  );
  print("Updated Mokie");
'
```

5. **Restart Hive** (both dodi and personal instances) to pick up the new MCP server and config.

6. **Calibrate score threshold** — after first index, run a few test queries via `code_search` and adjust `codeIndex.scoreThreshold` in hive.yaml if results are too noisy or too sparse.
