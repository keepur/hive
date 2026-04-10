// src/code-index/indexer.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { MongoClient, type Collection, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embedOllama } from "../search/embed-utils.js";
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
      // Create payload indexes for filtered searches
      await this.qdrant.createPayloadIndex(CODE_INDEX_COLLECTION, { field_name: "repo", field_schema: "keyword" });
      await this.qdrant.createPayloadIndex(CODE_INDEX_COLLECTION, { field_name: "role", field_schema: "keyword" });
      await this.qdrant.createPayloadIndex(CODE_INDEX_COLLECTION, { field_name: "language", field_schema: "keyword" });
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

    // Collect discovered files per repo — reused for both indexing and pruning (avoids double walk)
    const discoveredByRepo = new Map<string, DiscoveredFile[]>();

    for (const [repoName, repoConfig] of Object.entries(repos)) {
      if (!repoConfig) {
        console.warn(`Repo '${repoName}' not found in config, skipping`);
        continue;
      }
      console.log(`\n=== Indexing ${repoName} (${repoConfig.path}) ===`);
      const { indexed, skipped, failed, files } = await this.indexRepo(repoName, repoConfig);
      discoveredByRepo.set(repoName, files);
      totalIndexed += indexed;
      totalSkipped += skipped;
      totalFailed += failed;
      console.log(`  ${repoName}: indexed=${indexed} skipped=${skipped} failed=${failed}`);
    }

    // Clean up deleted files — uses already-discovered file lists
    await this.pruneDeletedFiles(discoveredByRepo);

    return { indexed: totalIndexed, skipped: totalSkipped, failed: totalFailed };
  }

  /** Index a single repo — returns discovered files for reuse in pruning */
  private async indexRepo(
    repoName: string,
    repoConfig: RepoConfig,
  ): Promise<{ indexed: number; skipped: number; failed: number; files: DiscoveredFile[] }> {
    const files = this.discoverFiles(repoName, repoConfig);
    console.log(`  Discovered ${files.length} files`);

    // Diff against last run
    const changed = this.options.forceFullReindex ? files : await this.filterChanged(files);
    console.log(`  ${changed.length} files need (re)indexing`);

    if (changed.length === 0) return { indexed: 0, skipped: files.length, failed: 0, files };

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

    return { indexed, skipped: files.length - changed.length, failed, files };
  }

  /** Walk repo for matching source files — uses git for SHAs (no file reads) */
  private discoverFiles(repoName: string, repoConfig: RepoConfig): DiscoveredFile[] {
    const repoPath = resolve(repoConfig.path.replace(/^~/, process.env.HOME ?? ""));
    const files: DiscoveredFile[] = [];

    // Use git ls-tree for SHA + path in one shot (no file reads needed for diffing)
    const treeOutput = execFileSync("git", ["ls-tree", "-r", "HEAD", "--format=%(objectname) %(path)"], {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });

    // Separately get line counts via git diff --stat (cheaper than reading files)
    // For line counts we'll defer to summarizeBatch which reads the file anyway
    for (const line of treeOutput.split("\n")) {
      const match = line.match(/^([0-9a-f]+) (.+)$/);
      if (!match) continue;
      const [, gitSha, filePath] = match;

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
      const language = ext === ".tsx" ? "tsx" : ext === ".ts" ? "typescript" : "javascript";

      // lineCount deferred — set to 0 here, computed in summarizeBatch when file is read
      files.push({ repo: repoName, filePath, absPath, gitSha, lineCount: 0, language });
    }

    return files;
  }

  /** Filter to only files whose SHA differs from stored SHA */
  private async filterChanged(files: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    if (files.length === 0) return [];

    const repo = files[0].repo;
    const existing = await this.collection.find({ repo }, { projection: { filePath: 1, gitSha: 1 } }).toArray();
    const shaMap = new Map(existing.map((r) => [r.filePath, r.gitSha]));

    return files.filter((f) => shaMap.get(f.filePath) !== f.gitSha);
  }

  /** Group files into batches by file size — reads files to determine size, populates lineCount */
  private batchFiles(files: DiscoveredFile[]): DiscoveredFile[][] {
    const small: DiscoveredFile[] = [];
    const large: DiscoveredFile[] = [];

    for (const f of files) {
      // Read file to determine line count (first read — content reused in summarizeBatch)
      try {
        const content = readFileSync(f.absPath, "utf-8");
        f.lineCount = content.split("\n").length;
      } catch {
        f.lineCount = 0; // will be skipped in summarizeBatch if unreadable
      }
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

  /** Call Gemma4 (local Ollama) to summarize a batch of files */
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

    const response = await fetch(`${this.options.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma4:e4b",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { num_ctx: 32768 },
      }),
    });

    if (!response.ok) throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { message?: { content?: string } };
    const text = body.message?.content ?? "";
    // Extract JSON from response (may be wrapped in ```json blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`No JSON array in Gemma response for batch starting with ${files[0].filePath}`);

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

      await this.collection.updateOne({ repo: file.repo, filePath: file.filePath }, { $set: record }, { upsert: true });

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

  /** Remove index entries for files that no longer exist — uses pre-discovered file lists */
  private async pruneDeletedFiles(discoveredByRepo: Map<string, DiscoveredFile[]>): Promise<void> {
    for (const [repoName, currentFiles] of discoveredByRepo.entries()) {
      const currentPaths = new Set(currentFiles.map((f) => f.filePath));

      const indexed = await this.collection
        .find({ repo: repoName }, { projection: { filePath: 1, qdrantPointId: 1 } })
        .toArray();
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
