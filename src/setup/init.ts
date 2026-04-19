import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { resolveHiveHome } from "../paths.js";
import { installPrereqs } from "../cli/prereqs.js";

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

    const skeleton = {
      instance: { id: instanceId, type: "business" },
      ports: { ws: 3200, bgTask: 3201 },
      business: { name: businessName },
    };
    writeFileSync(join(hiveHome, "hive.yaml"), toYaml(skeleton));

    console.log(`\n✓ Created ${hiveHome}/hive.yaml (instance.id: ${instanceId})\n`);
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
