import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runConfinementSelfTest, type ConfinementSelfTest } from "../deployment/confined-job.js";
import { selectPromotionMethod, type PromotionMethodSelection } from "../deployment/clone-promotion.js";

interface Prereq {
  name: string;
  required: boolean;
  check: () => boolean | Promise<boolean>;
  install: () => void;
}

const execOpts = { encoding: "utf-8" as const, stdio: "pipe" as const };

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], execOpts);
    return true;
  } catch {
    return false;
  }
}

function brewInstalled(formula: string): boolean {
  try {
    execFileSync("brew", ["list", formula], execOpts);
    return true;
  } catch {
    return false;
  }
}

function brewServiceRunning(name: string): boolean {
  try {
    const output = execFileSync("brew", ["services", "list"], execOpts);
    return output.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch {
    return false;
  }
}

/**
 * Probe an HTTP endpoint with a short timeout. Authoritative liveness check
 * for daemons that may run via brew services, bare process, or any other
 * mechanism — port-bound is port-bound.
 */
async function httpProbe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export interface ArtifactStagingPrerequisiteDeps {
  selfTest(options: Parameters<typeof runConfinementSelfTest>[0]): Promise<ConfinementSelfTest>;
  promotionMethod(options: Parameters<typeof selectPromotionMethod>[0]): Promise<PromotionMethodSelection>;
  scratchParent(): Promise<string>;
  /** Existing directory on the intended instance volume (HIVE_HOME's nearest ancestor, else HOME). */
  destinationParent(): Promise<string>;
  nodePath: string;
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return realpath(candidate);
}

const defaultStagingDeps: ArtifactStagingPrerequisiteDeps = {
  selfTest: runConfinementSelfTest,
  promotionMethod: selectPromotionMethod,
  scratchParent: async () => realpath(await mkdtemp(resolve(tmpdir(), "hive-confinement-preflight-"))),
  destinationParent: () => nearestExistingDirectory(process.env.HIVE_HOME ?? process.env.HOME ?? tmpdir()),
  nodePath: process.execPath,
};

export interface ArtifactStagingPrerequisites {
  selfTest: ConfinementSelfTest;
  promotion: PromotionMethodSelection;
}

/**
 * init/resume staging prerequisites (spec §4, chunk 5 Task 8 Step 1a.3): the
 * fail-closed Seatbelt self-test plus a usable promotion method. Reported by
 * name; never auto-installed. Ordinary rollback never consults this.
 */
export async function checkArtifactStagingPrerequisites(
  deps: ArtifactStagingPrerequisiteDeps = defaultStagingDeps,
): Promise<ArtifactStagingPrerequisites> {
  const scratch = await deps.scratchParent();
  try {
    const operationId = `prereq-${randomUUID()}`;
    const selfTest = await deps.selfTest({ canonicalInstanceHome: scratch, operationId, nodePath: deps.nodePath });
    const promotion = await deps.promotionMethod({
      sourceParent: resolve(scratch, ".hive-state", "jobs", operationId),
      destinationParent: await deps.destinationParent(),
    });
    return { selfTest, promotion };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export function artifactStagingPrereq(deps: ArtifactStagingPrerequisiteDeps = defaultStagingDeps): Prereq {
  let lastError = "not checked";
  return {
    name: "Artifact staging confinement (/usr/bin/sandbox-exec self-test, clone or full-copy promotion)",
    required: true,
    check: async () => {
      try {
        const result = await checkArtifactStagingPrerequisites(deps);
        console.log(
          `  · sandbox-exec self-test passed (macOS ${result.selfTest.macosVersion}); promotion: ${result.promotion.method}`,
        );
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    install: () => {
      throw new Error(
        `cannot be installed automatically (${lastError}); staging requires a working /usr/bin/sandbox-exec and a clone-capable or sufficiently free instance volume`,
      );
    },
  };
}

const prereqs: Prereq[] = [
  {
    name: "Xcode CLI Tools",
    required: true,
    check: () => {
      try {
        execFileSync("xcode-select", ["-p"], execOpts);
        return true;
      } catch {
        return false;
      }
    },
    install: () => {
      console.log("  Installing Xcode CLI Tools (this opens a system dialog)...");
      execFileSync("xcode-select", ["--install"], { stdio: "inherit" });
      console.log("  Complete the installation dialog, then re-run 'hive init'.");
      process.exit(0);
    },
  },
  {
    name: "Homebrew",
    required: true,
    check: () => commandExists("brew"),
    install: () => {
      console.log("  Installing Homebrew...");
      const tmpScript = resolve(tmpdir(), "brew-install.sh");
      const script = execFileSync(
        "curl",
        ["-fsSL", "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"],
        { encoding: "utf-8" },
      );
      writeFileSync(tmpScript, script, { mode: 0o755 });
      execFileSync("/bin/bash", [tmpScript], { stdio: "inherit" });
      unlinkSync(tmpScript);
    },
  },
  {
    name: "Node.js >= 22.19",
    required: true,
    // Floor is 22.19.0, not just major 22: undici 8 (a transitive dep) requires
    // >=22.19.0, and package.json `engines` was bumped to match.
    check: () => {
      const [major, minor] = process.versions.node.split(".").map((n) => parseInt(n, 10));
      return major > 22 || (major === 22 && minor >= 19);
    },
    install: () => {
      console.log("  Installing Node.js >= 22.19 (undici 8 floor) via Homebrew...");
      execFileSync("brew", ["install", "node"], { stdio: "inherit" });
    },
  },
  {
    name: "MongoDB",
    required: true,
    check: () => brewServiceRunning("mongodb-community"),
    install: () => {
      if (!brewInstalled("mongodb-community")) {
        console.log("  Tapping mongodb/brew...");
        execFileSync("brew", ["tap", "mongodb/brew"], { stdio: "inherit" });
        console.log("  Installing mongodb-community...");
        execFileSync("brew", ["install", "mongodb-community"], { stdio: "inherit" });
      }
      console.log("  Starting MongoDB...");
      execFileSync("brew", ["services", "start", "mongodb-community"], { stdio: "inherit" });
    },
  },
  {
    name: "Ollama",
    required: true,
    check: () => httpProbe("http://127.0.0.1:11434/api/tags"),
    install: () => {
      console.log("  Installing Ollama...");
      execFileSync("brew", ["install", "ollama"], { stdio: "inherit" });
      execFileSync("brew", ["services", "start", "ollama"], { stdio: "inherit" });
    },
  },
  {
    name: "Ollama models (bge-large, gemma4:e4b)",
    required: true,
    check: () => {
      if (!commandExists("ollama")) return false;
      try {
        const list = execFileSync("ollama", ["list"], execOpts);
        return list.includes("bge-large") && list.includes("gemma4:e4b");
      } catch {
        return false;
      }
    },
    install: () => {
      console.log("  ⚠ Pulling Ollama models — ~10 GB total, several minutes on first run.");
      console.log("  Pulling bge-large (~670 MB)...");
      execFileSync("ollama", ["pull", "bge-large"], { stdio: "inherit" });
      console.log("  Pulling gemma4:e4b (~9.6 GB)...");
      execFileSync("ollama", ["pull", "gemma4:e4b"], { stdio: "inherit" });
    },
  },
  {
    name: "Qdrant",
    required: true,
    check: () => httpProbe("http://127.0.0.1:6333/"),
    install: () => {
      if (!brewInstalled("qdrant")) {
        console.log("  Installing Qdrant...");
        execFileSync("brew", ["install", "qdrant/tap/qdrant"], { stdio: "inherit" });
      }
      console.log("  Starting Qdrant...");
      execFileSync("brew", ["services", "start", "qdrant"], { stdio: "inherit" });
    },
  },
  artifactStagingPrereq(),
  {
    name: "gh CLI",
    required: false,
    check: () => commandExists("gh"),
    install: () => {
      console.log("  Installing gh CLI...");
      execFileSync("brew", ["install", "gh"], { stdio: "inherit" });
    },
  },
];

export async function installPrereqs(): Promise<void> {
  console.log("Checking prerequisites...\n");
  let failures = 0;
  for (const prereq of prereqs) {
    const label = prereq.required ? "" : " (optional)";
    if (await prereq.check()) {
      console.log(`  ✓ ${prereq.name}${label}`);
      continue;
    }
    console.log(`  ✗ ${prereq.name}${label} — installing...`);
    try {
      prereq.install();
      if (await prereq.check()) {
        console.log(`  ✓ ${prereq.name} — installed`);
      } else if (prereq.required) {
        console.error(`  ✗ ${prereq.name} — install failed`);
        failures++;
      }
    } catch (err) {
      if (prereq.required) {
        console.error(`  ✗ ${prereq.name} — install failed: ${err}`);
        failures++;
      } else {
        console.log(`  ○ ${prereq.name} — skipped (install failed)`);
      }
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} required prerequisite(s) failed. Fix and re-run 'hive init'.`);
    process.exit(1);
  }
  console.log("\nAll prerequisites ready.");
}
