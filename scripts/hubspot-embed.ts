#!/usr/bin/env npx tsx
/**
 * Compatibility shim for older Hive crontabs.
 *
 * The active HubSpot embed job lives in the marketing repo and writes from
 * local HubSpot staging MongoDB to local Qdrant.
 */

import { spawn } from "node:child_process";

const cwd = "/Users/mokie/github/marketing/projects/hubspot-pipeline";
const child = spawn("npm", ["run", "embed:qdrant"], {
  cwd,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

