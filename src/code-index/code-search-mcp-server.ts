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

    const must: { key: string; match: { value: string } }[] = [];
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
      const repoFilePairs = searchResults
        .filter((r) => r.repo && r.filePath)
        .map((r) => ({ repo: r.repo, filePath: r.filePath }));
      const fullRecords = repoFilePairs.length > 0 ? await collection.find({ $or: repoFilePairs }).toArray() : [];
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
    description:
      "Look up full index record for a specific file path. Returns summary, exports, dependencies, and role.",
    inputSchema: {
      filePath: z.string().describe("Relative file path, e.g. 'src/gateway/dispatcher.ts'"),
      repo: z.string().optional().describe("Which repo. Default: search both"),
    },
  },
  async ({ filePath, repo }) => {
    await ensureConnected();

    const query: Partial<Pick<CodeIndexRecord, "filePath" | "repo">> = { filePath };
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
