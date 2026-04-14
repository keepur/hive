#!/usr/bin/env npx tsx
/**
 * Stage 2 build: bundle + minify dist/ → pkg/
 *
 * Prereq: npm run build (tsc → dist/)
 * Output: pkg/ (publish-ready minified bundles)
 */
import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PKG_DIR = "pkg";

// Clean and recreate
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
mkdirSync(resolve(PKG_DIR, "mcp"), { recursive: true });
mkdirSync(resolve(PKG_DIR, "setup"), { recursive: true });

const external = [
  // Native modules — require compilation on target machine
  "better-sqlite3",
  // Large SDKs with dynamic internals
  "mongodb",
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "@slack/socket-mode",
  "@slack/web-api",
  "@linear/sdk",
  "@qdrant/js-client-rest",
  // File-processing libs with complex internal asset loading
  "pdf-parse",
  "mammoth",
  "xlsx",
  // Third-party MCP servers (resolved via createRequire at runtime)
  "brave-search-mcp",
];

const shared = {
  outdir: PKG_DIR,
  outExtension: { ".js": ".min.js" },
  bundle: true,
  minify: true,
  platform: "node" as const,
  target: "node22",
  format: "esm" as const,
  external,
  logLevel: "info" as const,
};

// CLI entry point (shebang preserved from source)
await build({
  ...shared,
  entryPoints: { cli: "dist/cli.js" },
});

// Main server
// TODO: Add "setup/wizard": "dist/setup/wizard.js" once src/setup/wizard.ts is created (Task 7)
await build({
  ...shared,
  entryPoints: {
    server: "dist/index.js",
  },
});

// MCP servers — each is a separate entry point (spawned as subprocess)
await build({
  ...shared,
  entryPoints: {
    "mcp/memory": "dist/memory/memory-mcp-server.js",
    "mcp/structured-memory": "dist/memory/structured-memory-mcp-server.js",
    "mcp/contacts": "dist/contacts/contacts-mcp-server.js",
    "mcp/admin": "dist/admin/admin-mcp-server.js",
    "mcp/callback": "dist/callback/callback-mcp-server.js",
    "mcp/schedule": "dist/schedule/schedule-mcp-server.js",
    "mcp/github-issues": "dist/github/github-issues-mcp-server.js",
    "mcp/linear": "dist/linear/linear-mcp-server.js",
    "mcp/clickup": "dist/clickup/clickup-mcp-server.js",
    "mcp/google": "dist/google/google-mcp-server.js",
    "mcp/keychain": "dist/keychain/keychain-mcp-server.js",
    "mcp/quo": "dist/quo/quo-mcp-server.js",
    "mcp/resend": "dist/resend/resend-mcp-server.js",
    "mcp/search-conversation": "dist/search/conversation-search-mcp-server.js",
    "mcp/background-task": "dist/background/background-task-mcp-server.js",
    "mcp/recall": "dist/recall/recall-mcp-server.js",
    "mcp/task": "dist/tasks/task-mcp-server.js",
    "mcp/event-bus": "dist/events/event-bus-mcp-server.js",
    "mcp/team": "dist/team/team-mcp-server.js",
    "mcp/code-search": "dist/code-index/code-search-mcp-server.js",
    "mcp/code-task": "dist/code-task/code-task-mcp-server.js",
    "mcp/workflow": "dist/workflow/workflow-mcp-server.js",
    "mcp/voice": "dist/voice/voice-mcp-server.js",
  },
});

// Copy non-JS assets to setup/
const setupAssets = ["setup/install-prereqs.sh", "setup/slack-manifest.yaml"];
for (const asset of setupAssets) {
  const src = resolve(asset);
  const dest = resolve(PKG_DIR, asset);
  if (existsSync(src)) copyFileSync(src, dest);
}

console.log("\n✓ Bundle complete → pkg/");
