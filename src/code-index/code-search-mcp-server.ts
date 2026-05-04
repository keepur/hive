/**
 * Code Search MCP Server — semantic search over the codebase index.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Tool handlers close over
 * the shared engine Db plus a lazily-constructed Qdrant client. No per-turn
 * context.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Collection, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embedOllama } from "../search/embed-utils.js";
import { CODE_INDEX_COLLECTION, type CodeIndexRecord, type CodeSearchResult } from "./code-index-types.js";

export interface CodeSearchToolDeps {
  db: Db;
  qdrantUrl?: string;
  ollamaUrl?: string;
}

export function buildCodeSearchTools(deps: CodeSearchToolDeps) {
  const collection: Collection<CodeIndexRecord> = deps.db.collection<CodeIndexRecord>("code_index");
  const qdrantUrl = deps.qdrantUrl ?? process.env.QDRANT_URL ?? "http://localhost:6333";
  const ollamaUrl = deps.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const qdrant = new QdrantClient({ url: qdrantUrl });

  return [
    tool(
      "code_search",
      "Semantic search over the codebase index. Returns matching source files with summaries, exports, and relevance scores. Use to find where specific functionality lives.",
      {
        query: z.string().describe("Natural language query, e.g. 'where is agent routing handled?'"),
        repo: z
          .string()
          .optional()
          .describe(
            "Filter to a specific repo by name (matches the `repo` field on indexed records). Default: search all indexed repos.",
          ),
        role: z.string().optional().describe("Filter by file role: entry, config, model, service, handler, util, etc."),
        limit: z.number().min(1).max(50).optional().describe("Max results. Default: 10"),
      },
      async ({ query, repo, role, limit }) => {
        try {
          const queryVector = await embedOllama(ollamaUrl, query);
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
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `code_search error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "code_lookup",
      "Look up full index record for a specific file path. Returns summary, exports, dependencies, and role.",
      {
        filePath: z.string().describe("Relative file path, e.g. 'src/gateway/dispatcher.ts'"),
        repo: z.string().optional().describe("Which repo. Default: search both"),
      },
      async ({ filePath, repo }) => {
        try {
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
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `code_lookup error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createCodeSearchMcpServer(deps: CodeSearchToolDeps) {
  return createSdkMcpServer({
    name: "code-search",
    version: "0.1.0",
    tools: buildCodeSearchTools(deps),
  });
}

// Stdio shim for the publish-ready bundle path.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await (async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { MongoClient } = await import("mongodb");

    const MONGODB_URI = process.env.MONGODB_URI ?? "";
    const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(MONGODB_DB);

    const tools = buildCodeSearchTools({
      db,
      qdrantUrl: process.env.QDRANT_URL,
      ollamaUrl: process.env.OLLAMA_URL,
    });

    const server = new McpServer({ name: "code-search", version: "0.1.0" });
    for (const t of tools) {
      const def = t as unknown as {
        name: string;
        description: string;
        inputSchema: Record<string, z.ZodTypeAny>;
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      };
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: def.inputSchema },
        def.handler as never,
      );
    }

    const cleanup = (): void => {
      void client.close();
      process.exit(0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
