// scripts/check-bundle-qdrant-stub.mjs
/**
 * KPR-344 guard: @qdrant/js-client-rest must be BUNDLED with its per-request
 * undici dispatcher stubbed out. If the marker is missing — or the package
 * has silently gone external again — Node 26 hives lose memory recall/forget
 * (per-request undici v6 dispatchers are incompatible with Node 26's internal
 * fetch, in both directions; see KPR-344).
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKER = "hive-qdrant-dispatcher-stub";
const MUST_CONTAIN = ["pkg/server.min.js", "pkg/mcp/search-conversation.min.js"];
const EXTERNAL_SIGNATURES = ['from"@qdrant/js-client-rest"', 'require("@qdrant/js-client-rest")'];

let failed = false;

// Marker presence: every known qdrant-carrying bundle ships the stub.
for (const path of MUST_CONTAIN) {
  if (!existsSync(path)) {
    console.error(`FAIL ${path}: bundle missing — run 'npm run bundle' first`);
    failed = true;
    continue;
  }
  if (!readFileSync(path, "utf8").includes(MARKER)) {
    console.error(`FAIL ${path}: qdrant dispatcher stub marker missing`);
    failed = true;
  }
}

// External-reference absence: scan ALL bundles (same walk as
// check-bundle-strings.mjs) so a future entry point that imports the qdrant
// client and silently goes external cannot evade the guard.
function collectMinJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectMinJs(full));
    } else if (entry.endsWith(".min.js")) {
      out.push(full);
    }
  }
  return out;
}
for (const path of collectMinJs("pkg")) {
  const content = readFileSync(path, "utf8");
  for (const sig of EXTERNAL_SIGNATURES) {
    if (content.includes(sig)) {
      console.error(`FAIL ${path}: external reference to @qdrant/js-client-rest remains`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`OK: qdrant dispatcher stub present in ${MUST_CONTAIN.length} bundle(s); no external qdrant references`);
