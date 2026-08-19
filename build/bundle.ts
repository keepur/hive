#!/usr/bin/env npx tsx
/**
 * Stage 2 build: bundle + minify dist/ → pkg/
 *
 * Prereq: npm run build (tsc → dist/)
 * Output: pkg/ (publish-ready minified bundles)
 */
import { build, type Plugin } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  // File-processing libs with complex internal asset loading
  "pdf-parse",
  "mammoth",
  "xlsx",
  // Third-party MCP servers (resolved via createRequire at runtime)
  "brave-search-mcp",
];

// KPR-344: neutralize @qdrant/js-client-rest's per-request undici dispatcher.
// Per-request dispatchers have no cross-undici-major compat (its v6 Agent
// breaks fetch on Node 26 internals; a v8 Agent breaks on Node 22/24), so no
// version pin can satisfy the whole support matrix. Plain global fetch works
// on every major and still pools through the KPR-252 global keep-alive agent.
// The marker property survives minification (side effect on a used symbol)
// and is asserted by scripts/check-bundle-qdrant-stub.mjs.
const qdrantDispatcherStub: Plugin = {
  name: "qdrant-dispatcher-stub",
  setup(b) {
    b.onLoad(
      { filter: /[\\/]@qdrant[\\/]js-client-rest[\\/]dist[\\/][^\\/]+[\\/]dispatcher\.js$/ },
      () => ({
        contents:
          "export const createDispatcher = () => undefined;\n" +
          'createDispatcher.hiveStub = "hive-qdrant-dispatcher-stub";\n',
        loader: "js",
      }),
    );
  },
};

const shared = {
  outdir: PKG_DIR,
  outExtension: { ".js": ".min.js" },
  bundle: true,
  minify: true,
  platform: "node" as const,
  target: "node22",
  format: "esm" as const,
  external,
  plugins: [qdrantDispatcherStub],
  logLevel: "info" as const,
  banner: {
    js: "import { createRequire as __hiveCreateRequire } from 'module'; const require = __hiveCreateRequire(import.meta.url);",
  },
};

// CLI entry point (shebang preserved from source)
await build({
  ...shared,
  entryPoints: { cli: "dist/cli.js" },
});

// Main server (wizard is bundled into cli.min.js via dynamic imports)
await build({
  ...shared,
  entryPoints: {
    server: "dist/index.js",
  },
});

// MCP servers — each is a separate entry point (spawned as subprocess).
// KPR-183: the 10 KPR-122-ported in-process servers (memory, structured-memory,
// contacts, admin, callback, schedule, event-bus, team, code-search, workflow)
// no longer ship per-server bundles — they only run in-process via
// createSdkMcpServer wired in agent-runner.send(). Their stdio shims were
// removed (they raced with pkg/server.min.js's entry-point check and crashed
// the engine at boot).
await build({
  ...shared,
  entryPoints: {
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
    "mcp/code-task": "dist/code-task/code-task-mcp-server.js",
    "mcp/voice": "dist/voice/voice-mcp-server.js",
    "mcp/slack": "dist/slack/slack-mcp-server.js",
    "mcp/skill-author": "dist/skill-author/skill-author-mcp-server.js",
  },
});

// Copy non-JS assets to setup/
const setupAssets = ["setup/slack-manifest.yaml"];
for (const asset of setupAssets) {
  const src = resolve(asset);
  const dest = resolve(PKG_DIR, asset);
  if (existsSync(src)) copyFileSync(src, dest);
}

// Emit required-env.json for `hive doctor`. Pre-bundle the list of
// `required("KEY")` calls in src/config.ts so doctor can read it from a
// shipped artifact instead of trying to reach back into src/ at runtime
// — src/ is not in package.json#files, so that path doesn't exist on
// npm-installed hives. This is the canonical source-of-truth for which
// env vars the config loader treats as required at startup.
const configSrc = readFileSync(resolve("src/config.ts"), "utf-8");
const requiredEnv = new Set<string>();
for (const m of configSrc.matchAll(/\brequired\(\s*"([A-Z0-9_]+)"\s*\)/g)) {
  requiredEnv.add(m[1]);
}
const requiredEnvList = [...requiredEnv].sort();
writeFileSync(
  resolve(PKG_DIR, "required-env.json"),
  JSON.stringify({ requiredEnv: requiredEnvList }, null, 2) + "\n",
);
console.log(`  pkg/required-env.json (${requiredEnvList.length} keys: ${requiredEnvList.join(", ")})`);

console.log("\n✓ Bundle complete → pkg/");
