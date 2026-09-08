#!/usr/bin/env npx tsx
/**
 * Stage 2 build: bundle + minify dist/ → pkg/
 *
 * Prereq: npm run build (tsc → dist/)
 * Output: pkg/ (publish-ready minified bundles)
 */
import { build, type Plugin } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

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
    b.onLoad({ filter: /[\\/]@qdrant[\\/]js-client-rest[\\/]dist[\\/][^\\/]+[\\/]dispatcher\.js$/ }, () => ({
      contents:
        "export const createDispatcher = () => undefined;\n" +
        'createDispatcher.hiveStub = "hive-qdrant-dispatcher-stub";\n',
      loader: "js",
    }));
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
    "mcp/voice-livekit": "dist/voice/livekit-voice-mcp-server.js",
    "mcp/slack": "dist/slack/slack-mcp-server.js",
    "mcp/skill-author": "dist/skill-author/skill-author-mcp-server.js",
  },
});

// KPR-394 (§4.2) / KPR-407 (finding 1): ship the provider-abi type surface —
// and ONLY it. The barrel's .d.ts re-exports reach across the dist declaration
// tree, but the whole tree (213 files) is far more than the exports map needs
// and drags customer-facing JSDoc from unrelated engine modules into the
// tarball. Trace the transitive closure of relative import/export edges from
// provider-abi.d.ts instead and copy just those, preserving structure.
// Bare specifiers (mongodb, @slack/web-api, @anthropic-ai/claude-agent-sdk)
// are runtime deps — resolvable from the consumer's own node_modules.
// scripts/check-bundle-strings.mjs scans the result for forbidden strings.
const DIST_ROOT = resolve("dist");
const TYPES_ROOT = resolve(PKG_DIR, "types");
const ABI_ENTRY = resolve(DIST_ROOT, "agents/provider-adapters/provider-abi.d.ts");

// `from "…"` (import/export), inline `import("…")` type references, and
// bare side-effect imports (`import "./x.js";` — tsc emits these into
// declarations for module-augmenting modules, and a consumer resolves them).
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Resolve a relative specifier to a .d.ts on disk: `.js`→`.d.ts`, then `/index.d.ts`. */
function resolveDeclaration(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.endsWith(".js") ? base.slice(0, -3) + ".d.ts" : `${base}.d.ts`,
    resolve(base.endsWith(".js") ? base.slice(0, -3) : base, "index.d.ts"),
  ];
  return candidates.find((c) => existsSync(c));
}

if (!existsSync(ABI_ENTRY)) {
  throw new Error(`bundle: provider-abi declaration missing at ${ABI_ENTRY} — run 'npm run build' first`);
}

const abiClosure = new Set<string>();
const pending = [ABI_ENTRY];
while (pending.length > 0) {
  const file = pending.pop()!;
  if (abiClosure.has(file)) continue;
  abiClosure.add(file);
  const decl = readFileSync(file, "utf-8");
  for (const [, spec] of decl.matchAll(SPECIFIER_RE)) {
    if (!spec.startsWith(".")) continue;
    const target = resolveDeclaration(file, spec);
    if (!target) {
      throw new Error(
        `bundle: unresolvable relative type edge "${spec}" from dist/${relative(DIST_ROOT, file)} — ` +
          `the pkg/types closure would ship broken declarations`,
      );
    }
    // Containment: every resolved edge must stay under dist/ — tsc doesn't
    // emit rootDir-escaping relative specifiers today, but a loud failure
    // here (never a silent copy outside pkg/types/) is the point of the
    // whole closure-trace, so make it total rather than trust the input.
    if (!(target + sep).startsWith(DIST_ROOT + sep)) {
      throw new Error(
        `bundle: relative type edge "${spec}" from dist/${relative(DIST_ROOT, file)} resolves outside dist/ (${target}) — refusing to copy`,
      );
    }
    pending.push(target);
  }
}

for (const file of abiClosure) {
  const dest = resolve(TYPES_ROOT, relative(DIST_ROOT, file));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(file, dest);
}
console.log(`  pkg/types/ (${abiClosure.size} .d.ts files — provider-abi transitive closure)`);

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
writeFileSync(resolve(PKG_DIR, "required-env.json"), JSON.stringify({ requiredEnv: requiredEnvList }, null, 2) + "\n");
console.log(`  pkg/required-env.json (${requiredEnvList.length} keys: ${requiredEnvList.join(", ")})`);

console.log("\n✓ Bundle complete → pkg/");
