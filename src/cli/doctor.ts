import { execFileSync } from "node:child_process";

interface Check {
  name: string;
  required: boolean;
  test: () => boolean | Promise<boolean>;
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

/**
 * Probe an HTTP endpoint with a short timeout. Use for daemons that may run
 * via brew services, bare process, or any other mechanism — port-bound is
 * port-bound.
 */
async function httpProbe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [
    { name: "Node.js >= 22", required: true, test: () => parseInt(process.versions.node.split(".")[0]) >= 22 },
    { name: "Homebrew", required: true, test: () => commandExists("brew") },
    { name: "MongoDB", required: true, test: () => serviceRunning("mongodb-community") },
    { name: "Ollama", required: true, test: () => httpProbe("http://127.0.0.1:11434/api/tags") },
    { name: "Ollama models (bge-large, gemma4:e4b)", required: true, test: () => {
      if (!commandExists("ollama")) return false;
      try {
        const list = execFileSync("ollama", ["list"], { encoding: "utf-8" });
        return list.includes("bge-large") && list.includes("gemma4:e4b");
      } catch { return false; }
    }},
    { name: "Qdrant", required: true, test: () => httpProbe("http://127.0.0.1:6333/") },
    { name: "gh CLI", required: false, test: () => commandExists("gh") },
    { name: "gog CLI", required: false, test: () => commandExists("gog") },
    { name: "Xcode CLI Tools", required: true, test: () => {
      try { execFileSync("xcode-select", ["-p"], { encoding: "utf-8" }); return true; } catch { return false; }
    }},
  ];
  let allPassed = true;
  for (const check of checks) {
    const ok = await check.test();
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
