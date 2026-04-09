import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { hiveHome } from "../paths.js";
import { installPrereqs } from "../cli/prereqs.js";

export async function runSetupWizard(pkgRoot: string): Promise<void> {
  console.log(`\nHive Setup Wizard`);
  console.log(`Home directory: ${hiveHome}\n`);

  mkdirSync(hiveHome, { recursive: true });

  await installPrereqs();

  const templatesDir = existsSync(resolve(pkgRoot, "templates"))
    ? resolve(pkgRoot, "templates")
    : resolve(pkgRoot, "setup", "templates");

  console.log(`\nSetup will write config to: ${hiveHome}`);
  console.log(`Templates from: ${templatesDir}\n`);

  process.env.HIVE_HOME = hiveHome;

  const { runWizard } = await import("./wizard.js");
  await runWizard(hiveHome, templatesDir);
}
