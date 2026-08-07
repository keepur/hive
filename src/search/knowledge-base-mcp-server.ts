#!/usr/bin/env node
/**
 * Knowledge Base MCP Server — RAG pipeline for document ingestion and retrieval.
 *
 * Tools:
 *   kb_ingest  — Ingest a file (PDF, DOCX, TXT, MD, etc.) into the knowledge base
 *   kb_search  — Semantic search over ingested documents
 *   kb_list    — List all documents in the knowledge base
 *   kb_delete  — Remove a document and all its chunks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KnowledgeBase } from "./knowledge-base.js";

const AGENT_ID = process.env.AGENT_ID;
if (!AGENT_ID) {
  process.stderr.write("knowledge-base: AGENT_ID env var is required\n");
  process.exit(1);
}

const server = new McpServer({ name: "knowledge-base", version: "1.0.0" });

// ── Lazy Init ────────────────────────────────────────────────────────────────

let kb: KnowledgeBase;
function ensureReady() {
  if (!kb) kb = new KnowledgeBase();
}

// ── Tool: kb_ingest ──────────────────────────────────────────────────────────

server.registerTool(
  "kb_ingest",
  {
    title: "KB Ingest",
    description:
      "Ingest a local file into the knowledge base. Extracts text, chunks it, embeds via bge-large, and stores in Qdrant for semantic retrieval. Supports PDF, DOCX, XLSX, TXT, MD, CSV, JSON, HTML, XML, YAML.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the file to ingest"),
      tags: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Optional tags for filtering (e.g. 'contract', 'spec', 'financial')"),
    },
  },
  async ({ filePath, tags }) => {
    try {
      ensureReady();
      const doc = await kb.ingest(filePath, AGENT_ID!, tags);
      const summary = [
        `✓ Ingested: ${doc.source}`,
        `  Document ID: ${doc.id}`,
        `  Chunks: ${doc.totalChunks}`,
        `  Size: ${formatSize(doc.sizeBytes)}`,
        `  Tags: ${doc.tags.length > 0 ? doc.tags.join(", ") : "(none)"}`,
      ].join("\n");
      return { content: [{ type: "text", text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Ingest failed: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: kb_ingest_text ─────────────────────────────────────────────────────

server.registerTool(
  "kb_ingest_text",
  {
    title: "KB Ingest Text",
    description:
      "Ingest raw text content into the knowledge base. Use when you have text content that isn't a file (e.g. pasted content, API responses, scraped web pages).",
    inputSchema: {
      text: z.string().describe("The text content to ingest"),
      sourceName: z
        .string()
        .describe("A name to identify this content (e.g. 'meeting-notes-2026-08-06', 'api-docs-v2')"),
      tags: z.array(z.string()).optional().default([]).describe("Optional tags for filtering"),
    },
  },
  async ({ text, sourceName, tags }) => {
    try {
      ensureReady();
      const doc = await kb.ingestText(text, sourceName, AGENT_ID!, tags);
      const summary = [
        `✓ Ingested: ${doc.source}`,
        `  Document ID: ${doc.id}`,
        `  Chunks: ${doc.totalChunks}`,
        `  Size: ${formatSize(doc.sizeBytes)}`,
        `  Tags: ${doc.tags.length > 0 ? doc.tags.join(", ") : "(none)"}`,
      ].join("\n");
      return { content: [{ type: "text", text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Ingest failed: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: kb_search ──────────────────────────────────────────────────────────

server.registerTool(
  "kb_search",
  {
    title: "KB Search",
    description:
      "Semantic search over the knowledge base. Returns the most relevant document chunks for a natural language query.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().default(5).describe("Maximum results to return (default 5)"),
      tags: z.array(z.string()).optional().describe("Filter results to documents with these tags"),
    },
  },
  async ({ query, limit, tags }) => {
    try {
      ensureReady();
      const results = await kb.search(query, AGENT_ID!, { limit, tags });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching documents found." }] };
      }

      const formatted = results
        .map((r, i) => {
          const tagStr = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
          return [
            `${i + 1}. ${r.source} (chunk ${r.chunkIndex + 1}/${r.totalChunks})${tagStr}`,
            `   Score: ${r.score.toFixed(4)}`,
            `   ---`,
            `   ${r.content}`,
          ].join("\n");
        })
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} results:\n\n${formatted}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Search failed: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: kb_list ────────────────────────────────────────────────────────────

server.registerTool(
  "kb_list",
  {
    title: "KB List",
    description: "List all documents in your knowledge base.",
    inputSchema: {},
  },
  async () => {
    try {
      ensureReady();
      const docs = await kb.list(AGENT_ID!);

      if (docs.length === 0) {
        return { content: [{ type: "text", text: "Knowledge base is empty." }] };
      }

      const formatted = docs
        .map((d, i) => {
          const tagStr = d.tags.length > 0 ? ` [${d.tags.join(", ")}]` : "";
          return `${i + 1}. ${d.source} — ${d.totalChunks} chunks, ${formatSize(d.sizeBytes)}${tagStr}\n   ID: ${d.documentId} | Ingested: ${d.ingestedAt}`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text: `${docs.length} document(s):\n\n${formatted}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `List failed: ${e.message}` }], isError: true };
    }
  },
);

// ── Tool: kb_delete ──────────────────────────────────────────────────────────

server.registerTool(
  "kb_delete",
  {
    title: "KB Delete",
    description: "Remove a document and all its chunks from the knowledge base.",
    inputSchema: {
      documentId: z.string().describe("Document ID to delete (from kb_list output)"),
    },
  },
  async ({ documentId }) => {
    try {
      ensureReady();
      await kb.delete(documentId, AGENT_ID!);
      return { content: [{ type: "text", text: `✓ Deleted document ${documentId}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Delete failed: ${e.message}` }], isError: true };
    }
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Connect and run ──────────────────────────────────────────────────────────

process.stderr.write("knowledge-base: starting\n");
const transport = new StdioServerTransport();
await server.connect(transport);
