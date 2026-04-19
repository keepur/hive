import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { resolveHiveHome } from "../paths.js";
import { installPrereqs } from "../cli/prereqs.js";

/** Ports allocated per instance starting at portBase. Must match config.ts port offsets. */
const PORTS_PER_INSTANCE = 10;

/**
 * Check whether a TCP port has a LISTEN-ing process on loopback. Uses lsof.
 * Returns true if busy, false if free. If lsof is missing (ENOENT), returns
 * false so callers fall back to yaml-only behavior.
 */
function isPortBusy(port: number): boolean {
  try {
    const out = execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.trim().length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // lsof missing — treat as "free" so we don't block the picker
      return false;
    }
    // Non-zero exit = no LISTENers found, which is what we want (free)
    return false;
  }
}

/**
 * Scan sibling hive installs for used portBase values and return the next free
 * 100-slot starting at 3100. Prevents collisions between instances on one machine.
 */
function pickPortBase(home: string): number {
  const used = new Set<number>();
  const servicesRoot = resolve(home, "services", "hive");
  if (existsSync(servicesRoot)) {
    for (const dir of readdirSync(servicesRoot)) {
      const yamlPath = join(servicesRoot, dir, "hive.yaml");
      if (!existsSync(yamlPath)) continue;
      try {
        const parsed = parseYaml(readFileSync(yamlPath, "utf-8")) ?? {};
        const pb = parsed?.instance?.portBase;
        // Treat a missing portBase as the implicit default 3100 (see config.ts).
        used.add(typeof pb === "number" ? pb : 3100);
      } catch {
        // ignore unreadable siblings
      }
    }
  }
  for (let base = 3100; base < 3900; base += 100) {
    // Cheap yaml-scan filter first
    if (used.has(base)) continue;
    // Confirm with lsof — env-var overrides (e.g. WS_PORT=3200) are invisible to yaml scan
    let anyBusy = false;
    for (let offset = 0; offset < PORTS_PER_INSTANCE; offset++) {
      if (isPortBusy(base + offset)) {
        anyBusy = true;
        break;
      }
    }
    if (!anyBusy) return base;
  }
  return 3100;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultVal = ""): Promise<string> {
  const q = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((res) => rl.question(q, (a) => res(a.trim() || defaultVal)));
}

/**
 * Ask user where to install and what to call this hive — before any files are written.
 * Returns the chosen home directory. Writes a skeleton hive.yaml with business.name and instance.id.
 */
async function chooseHomeAndInstance(home: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("── Where to install ────────────────────────────\n");

    const businessName = await prompt(rl, "Business name (e.g. your company)");
    if (!businessName) {
      console.error("Business name is required.");
      process.exit(1);
    }

    const suggestedId = slugify(businessName) || "hive";
    const instanceId = await prompt(rl, "Instance ID (short slug, used for the mongo db name)", suggestedId);

    const suggestedHome = resolve(home, "services", "hive", instanceId);
    const hiveHome = resolve(await prompt(rl, "Install location", suggestedHome));

    if (existsSync(join(hiveHome, "hive.yaml"))) {
      console.error(`\nAn existing hive install was found at ${hiveHome}. Aborting to avoid clobbering.`);
      console.error(`If you want to reconfigure that instance, run: hive init --config ${hiveHome}/hive.yaml`);
      process.exit(1);
    }

    mkdirSync(hiveHome, { recursive: true });

    const portBase = pickPortBase(home);
    const skeleton = {
      instance: { id: instanceId, type: "business", portBase },
      business: { name: businessName },
    };
    writeFileSync(join(hiveHome, "hive.yaml"), toYaml(skeleton));

    console.log(`\n✓ Created ${hiveHome}/hive.yaml (instance.id: ${instanceId}, portBase: ${portBase})\n`);
    return hiveHome;
  } finally {
    rl.close();
  }
}

/**
 * If the resolved home has an existing hive.yaml, treat this as a resume and return it.
 * Otherwise return null to signal we need to prompt.
 */
function existingInstall(): string | null {
  // HIVE_HOME env set → always wins, use as-is
  if (process.env.HIVE_HOME) {
    const h = resolve(process.env.HIVE_HOME);
    return existsSync(join(h, "hive.yaml")) ? h : h; // use even if empty — user was explicit
  }
  // ./hive.yaml in cwd (dev repo mode)
  if (existsSync(resolve(process.cwd(), "hive.yaml"))) return process.cwd();
  // default ~/.hive only if it already has a hive.yaml (existing install)
  const defaultHome = resolveHiveHome();
  if (existsSync(join(defaultHome, "hive.yaml"))) return defaultHome;
  return null;
}

export async function runSetupWizard(pkgRoot: string): Promise<void> {
  console.log(`\nHive Setup Wizard\n`);

  await installPrereqs();

  console.log("");
  const existing = existingInstall();
  const home = process.env.HOME ?? "/tmp";
  const hiveHome = existing ?? (await chooseHomeAndInstance(home));

  const templatesDir = existsSync(resolve(pkgRoot, "templates"))
    ? resolve(pkgRoot, "templates")
    : resolve(pkgRoot, "setup", "templates");

  console.log(`Setup will write config to: ${hiveHome}`);
  console.log(`Templates from: ${templatesDir}\n`);

  // Sanity: make sure instance.id exists (required by wizard + mongo db name)
  const hivePath = join(hiveHome, "hive.yaml");
  if (existsSync(hivePath)) {
    const parsed = parseYaml(readFileSync(hivePath, "utf-8")) ?? {};
    if (!parsed.instance?.id) {
      console.error(`Error: ${hivePath} is missing instance.id. Delete it and run 'hive init' again.`);
      process.exit(1);
    }
  }

  process.env.HIVE_HOME = hiveHome;

  const { runWizard } = await import("./wizard.js");
  await runWizard(hiveHome, templatesDir, pkgRoot);
}
