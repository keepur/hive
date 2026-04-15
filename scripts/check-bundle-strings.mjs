// scripts/check-bundle-strings.mjs
/**
 * Bundle string guardrail — fails CI if any forbidden plugin-specific string
 * appears in pkg/*.min.js. Spec: docs/specs/2026-04-14-plugin-architecture-design.md §11 step 10.
 *
 * The pkg/ directory is what gets shipped in the @keepur/hive npm tarball;
 * a customer running `hive doctor` should see zero references to dodi,
 * hubspot, or cabinet in their installed copy.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["dodi", "hubspot", "cabinet"];
const PKG_DIR = "pkg";

if (!existsSync(PKG_DIR)) {
  console.error(`error: ${PKG_DIR}/ not found — run 'npm run bundle' first`);
  process.exit(1);
}

const bundleFiles = readdirSync(PKG_DIR).filter((f) => f.endsWith(".min.js"));
if (bundleFiles.length === 0) {
  console.error(`error: no .min.js files found in ${PKG_DIR}/`);
  process.exit(1);
}

let totalHits = 0;
for (const file of bundleFiles) {
  const path = join(PKG_DIR, file);
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

console.log(`OK: ${bundleFiles.length} bundle file(s) clean of forbidden strings (${FORBIDDEN.join(", ")})`);
