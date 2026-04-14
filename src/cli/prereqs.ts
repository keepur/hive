import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

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
    name: "Node.js >= 22",
    required: true,
    check: () => parseInt(process.versions.node.split(".")[0]) >= 22,
    install: () => {
      console.log("  Installing Node.js via Homebrew...");
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
