// scripts/check-bundle-strings.mjs
/**
 * Bundle string guardrail — fails CI if any forbidden plugin-specific string
 * appears in pkg/*.min.js. Spec: docs/specs/2026-04-14-plugin-architecture-design.md §11 step 10.
 *
 * The pkg/ directory is what gets shipped in the @keepur/hive npm tarball;
 * a customer running `hive doctor` should see zero references to dodi,
 * hubspot, or cabinet in their installed copy.
 *
 * KPR-407 (finding 1): the shipped surface is not only the minified bundles —
 * pkg/types/ carries the provider-abi .d.ts closure, and tsc preserves JSDoc
 * into declarations. Scan those too, so a future closure growth that pulls in
 * a tainted declaration fails the guard instead of shipping.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["dodi", "hubspot", "cabinet"];
const PKG_DIR = "pkg";

if (!existsSync(PKG_DIR)) {
  console.error(`error: ${PKG_DIR}/ not found — run 'npm run bundle' first`);
  process.exit(1);
}

function collectBySuffix(dir, suffix) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectBySuffix(full, suffix));
    } else if (entry.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

const bundleFiles = collectBySuffix(PKG_DIR, ".min.js");
if (bundleFiles.length === 0) {
  console.error(`error: no .min.js files found in ${PKG_DIR}/`);
  process.exit(1);
}

// KPR-407: the shipped provider-abi declaration closure. Presence of the
// barrel itself is check-bundle-pack.mjs's sentinel; here we only scan.
const TYPES_DIR = join(PKG_DIR, "types");
const typeFiles = existsSync(TYPES_DIR) ? collectBySuffix(TYPES_DIR, ".d.ts") : [];

let totalHits = 0;
for (const path of [...bundleFiles, ...typeFiles]) {
  const content = readFileSync(path, "utf8").toLowerCase();
  for (const term of FORBIDDEN) {
    const matches = content.split(term).length - 1;
    if (matches > 0) {
      console.error(`FAIL ${path}: ${matches} occurrence(s) of "${term}"`);
      totalHits += matches;
    }
  }
}

if (totalHits > 0) {
  console.error(`\nTotal: ${totalHits} forbidden string(s) in bundle. Customer-facing tarball is contaminated.`);
  console.error(`See docs/specs/2026-04-14-plugin-architecture-design.md §11 step 10.`);
  process.exit(1);
}

console.log(
  `OK: ${bundleFiles.length} bundle file(s) + ${typeFiles.length} declaration file(s) clean of forbidden strings (${FORBIDDEN.join(", ")})`,
);
