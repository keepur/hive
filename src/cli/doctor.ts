import { execFileSync } from "node:child_process";

interface Check {
  name: string;
  required: boolean;
  test: () => boolean;
}

function commandExists(cmd: string): boolean {
  try { execFileSync("which", [cmd], { encoding: "utf-8" }); return true; } catch { return false; }
}

function serviceRunning(name: string): boolean {
  try {
    const output = execFileSync("brew", ["services", "list"], { encoding: "utf-8" });
    return output.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch { return false; }
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [
    { name: "Node.js >= 22", required: true, test: () => parseInt(process.versions.node.split(".")[0]) >= 22 },
    { name: "Homebrew", required: true, test: () => commandExists("brew") },
    { name: "MongoDB", required: true, test: () => serviceRunning("mongodb-community") },
    { name: "Ollama", required: true, test: () => serviceRunning("ollama") },
    { name: "Ollama models (bge-large, gemma4:e4b)", required: true, test: () => {
      if (!commandExists("ollama")) return false;
      try {
        const list = execFileSync("ollama", ["list"], { encoding: "utf-8" });
        return list.includes("bge-large") && list.includes("gemma4:e4b");
      } catch { return false; }
    }},
    { name: "Qdrant", required: true, test: () => serviceRunning("qdrant") },
    { name: "gh CLI", required: false, test: () => commandExists("gh") },
    { name: "gog CLI", required: false, test: () => commandExists("gog") },
    { name: "Xcode CLI Tools", required: true, test: () => {
      try { execFileSync("xcode-select", ["-p"], { encoding: "utf-8" }); return true; } catch { return false; }
    }},
  ];
  let allPassed = true;
  for (const check of checks) {
    const ok = check.test();
    const icon = ok ? "✓" : (check.required ? "✗" : "○");
    const label = check.required ? "" : " (optional)";
    console.log(`  ${icon} ${check.name}${label}`);
    if (!ok && check.required) allPassed = false;
  }
  if (!allPassed) {
    console.log("\nSome required checks failed. Run 'hive init' to install prerequisites.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}
