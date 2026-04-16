# Track 2: `hive init` Wizard — End-to-End for npm Global Install

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Make `npm i -g @keepur/hive && hive init` work as a complete end-to-end flow. A CEO runs one command and gets a working Hive with a Chief of Staff agent in Slack.

**Architecture:** The wizard (`src/setup/wizard.ts`) already handles the full setup flow: business info → Slack → Anthropic → integrations → agent seeding → constitution → memory → service. But it was built for dev-repo mode — several functions shell out to dev scripts (`npx tsx setup/setup-seeds.ts`), dynamically import files that don't ship (`setup/template-renderer.ts`), and run build/deploy steps that don't apply to npm installs. This plan fixes all bundle-incompatible paths while keeping dev mode working.

**Key insight:** The wizard needs to work in two modes:
- **Dev mode** — `npm run setup` from repo root. `pkgRoot` = repo root. Build/deploy steps apply.
- **Package mode** — `hive init` after `npm i -g`. `pkgRoot` = npm package root. No build/deploy.

Detection: `existsSync(resolve(pkgRoot, "pkg", "server.min.js"))` → package mode (consistent with `isBuildDone()` and `cli.ts`).

**Tech Stack:** TypeScript, MongoDB (MongoClient), YAML parsing

---

### Task 1: Move template-renderer into src/ for static bundling

**Files:**
- Create: `src/setup/template-renderer.ts`
- Modify: `src/setup/wizard.ts` (change dynamic import to static)

The wizard's `doMemory()` dynamically imports `setup/template-renderer.ts` at runtime:

```typescript
const rendererPath = join(DEV_ROOT, "setup", "template-renderer.ts");
const { render: renderTemplate } = (await import(rendererPath)) as {...};
```

This breaks in bundled mode because: (1) the file doesn't ship, (2) esbuild can't follow dynamic paths. Fix: create a copy in `src/setup/` and use a static import.

- [ ] **Step 1:** Create `src/setup/template-renderer.ts`

Copy `setup/template-renderer.ts` verbatim into `src/setup/template-renderer.ts`. Do NOT rewrite or simplify — copy the file as-is to avoid subtle divergence. It's a small file (~80 lines) with zero external deps (only `node:crypto`).

```typescript
/**
 * Template renderer — variable substitution and conditional blocks.
 *
 * Supports:
 *   {{key.sub-key}}                    – dot-path variable substitution
 *   {{#path.to.key}}...{{/path.to.key}} – conditional blocks (truthy = render)
 *   {{^path.to.key}}...{{/path.to.key}} – inverted blocks (falsy = render)
 */

import { createHash } from "node:crypto";

function resolvePath(ctx: Record<string, any>, path: string): any {
  const parts = path.split(".");
  let val: any = ctx;
  for (const p of parts) {
    val = val?.[p];
    if (val === undefined) return undefined;
  }
  return val;
}

function isTruthy(val: any): boolean {
  return val !== null && val !== undefined && val !== "" && val !== false;
}

export function render(template: string, ctx: Record<string, any>): string {
  let changed = true;
  while (changed) {
    changed = false;
    template = template.replace(
      /\{\{#([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (full, path, block) => {
        if (path === "sms_section") return full;
        changed = true;
        return isTruthy(resolvePath(ctx, path)) ? block : "";
      },
    );
    template = template.replace(
      /\{\{\^([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_full, path, block) => {
        changed = true;
        return !isTruthy(resolvePath(ctx, path)) ? block : "";
      },
    );
  }
  template = template.replace(/\{\{([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}/g, (match, path) => {
    const val = resolvePath(ctx, path);
    if (val === undefined) return match;
    return String(val);
  });
  return template;
}

export function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

- [ ] **Step 2:** In `src/setup/wizard.ts`, add static import at the top

Add after existing imports:

```typescript
import { render as renderTemplate } from "./template-renderer.js";
```

- [ ] **Step 3:** In `doMemory()`, remove the dynamic import of template-renderer

Find the block (around line 750-753):

```typescript
      // Dynamic import — template-renderer lives outside src/ rootDir
      const rendererPath = join(DEV_ROOT, "setup", "template-renderer.ts");
      const { render: renderTemplate } = (await import(rendererPath)) as {
        render: (tpl: string, ctx: Record<string, any>) => string;
      };
```

Delete these four lines entirely — `renderTemplate` is now a top-level import and available in scope.

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: passes

- [ ] **Step 5:** Commit

```bash
git add src/setup/template-renderer.ts src/setup/wizard.ts
git commit -m "refactor(wizard): static import template-renderer for bundle compatibility"
```

---

### Task 2: Replace DEV_ROOT with pkgRoot parameter

**Files:**
- Modify: `src/setup/wizard.ts` (signature change + all DEV_ROOT references)
- Modify: `src/setup/init.ts` (pass pkgRoot)

`DEV_ROOT = resolve(import.meta.dirname, "../..")` resolves correctly in dev mode (src/setup/../../ = repo root) but goes one level too high in bundle mode (pkg/../../ = parent of package). Fix: accept `pkgRoot` as parameter and use it everywhere.

- [ ] **Step 1:** Change `runWizard` signature and remove `isMain` block + `DEV_ROOT`

In `src/setup/wizard.ts`, change the signature:

```typescript
export async function runWizard(
  targetDir: string = DEV_ROOT,
  templatesDir: string = resolve(DEV_ROOT, "setup", "templates"),
): Promise<void> {
```

to:

```typescript
export async function runWizard(
  targetDir: string,
  templatesDir: string,
  pkgRoot: string,
): Promise<void> {
```

**In the same step**, remove the `DEV_ROOT` const (line 23):

```typescript
const DEV_ROOT = resolve(import.meta.dirname, "../..");
```

And remove the backward-compat `isMain` block at the bottom of the file (lines 851-858):

```typescript
// Backward compat — run directly if executed as main
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runWizard().catch((err) => {
    console.error("Setup failed:", err);
    rl.close();
    process.exit(1);
  });
}
```

These must all happen together — the signature change removes defaults, the `isMain` block calls `runWizard()` with no args, and `DEV_ROOT` is now unused. Removing them in separate steps would cause typecheck failures between steps.

- [ ] **Step 2:** Add bundled mode detection at the top of `runWizard()`

After the existing `ENV_PATH = ...` / `HIVE_YAML_PATH = ...` lines, add:

```typescript
  const isBundled = existsSync(resolve(pkgRoot, "pkg", "server.min.js"));
```

- [ ] **Step 3:** Update `init.ts` to pass `pkgRoot`

In `src/setup/init.ts`, change line 24:

```typescript
  await runWizard(hiveHome, templatesDir);
```

to:

```typescript
  await runWizard(hiveHome, templatesDir, pkgRoot);
```

- [ ] **Step 4:** Replace all `DEV_ROOT` references in wizard.ts

There are multiple references to `DEV_ROOT` throughout the file. Replace each:

**In `doSlack()`** — Slack manifest path (line 546):

```typescript
  console.log(readFileSync(join(DEV_ROOT, "setup", "slack-manifest.yaml"), "utf-8"));
```

→

```typescript
  const manifestPath = existsSync(resolve(pkgRoot, "pkg", "setup", "slack-manifest.yaml"))
    ? resolve(pkgRoot, "pkg", "setup", "slack-manifest.yaml")
    : resolve(pkgRoot, "setup", "slack-manifest.yaml");
  console.log(readFileSync(manifestPath, "utf-8"));
```

**In `doAgent()`** — setup-seeds call (line 649):

```typescript
  execFileSync("npx", ["tsx", "setup/setup-seeds.ts"], { cwd: DEV_ROOT, stdio: "inherit" });
```

This will be fully replaced in Task 3 (inline seeding). For now, mark it with a TODO comment:

```typescript
  // TODO: replaced in Task 3 — inline seed
  execFileSync("npx", ["tsx", "setup/setup-seeds.ts"], { cwd: pkgRoot, stdio: "inherit" });
```

**In `doBuild()`** — build cwd (line 783):

```typescript
  execFileSync("npm", ["run", "build"], { cwd: DEV_ROOT, stdio: "pipe" });
```

→

```typescript
  execFileSync("npm", ["run", "build"], { cwd: pkgRoot, stdio: "pipe" });
```

**In `doDeploy()`** — multiple references:

Replace all `DEV_ROOT` with `pkgRoot` in `doDeploy()`. There are references at:
- Line 800 (git remote get-url)
- Line 822 (.env source path)
- Line 830 (hive.yaml source path)
- Line 839 (dist/ source path)

Also in the final "Done" section output lines (~488-495) — replace `DEV_ROOT` with `pkgRoot` in the console.log messages.

Also in the service install section (~473) — replace `DEV_ROOT` with `pkgRoot`.

**Important:** `doSlack`, `doAgent`, `doBuild`, `doDeploy`, and the service section all need `pkgRoot` and `isBundled` access. Since these are module-level functions, either:
- Make them closures that capture `pkgRoot`/`isBundled` from `runWizard`, or
- Add `pkgRoot`/`isBundled` as parameters

The cleanest approach: add parameters. For each section function that uses `DEV_ROOT`, add `pkgRoot: string` and `isBundled: boolean` parameters. Update call sites in `runWizard()`.

Functions that need pkgRoot:
- `doSlack(env, pkgRoot)` — manifest path
- `doAgent(hive, pkgRoot, isBundled)` — seed path (Task 3)
- `doBuild(pkgRoot)` — cwd
- `doDeploy(deployDir, pkgRoot)` — multiple paths

Functions that don't need it:
- `doBusiness(hive)` — only writes hive.yaml
- `doAnthropic(env)` — only writes .env
- `doConstitution(hive)` — only writes hive.yaml
- `doMemory(hive, templatesDir)` — uses templatesDir (already parameterized)

- [ ] **Step 5:** Update `npm run setup` script in `package.json`

The `setup` script (if present) calls `wizard.ts` directly via tsx, which no longer works without the `isMain` block. Change it to route through the CLI:

In `package.json`, find any `"setup"` script that references `setup-wizard.ts` or `wizard.ts` and change it to:

```json
"setup": "npx tsx src/cli.ts init",
```

If no such script exists, skip this step.

- [ ] **Step 6:** Verify

Run: `npm run typecheck`
Expected: passes

- [ ] **Step 7:** Commit

```bash
git add src/setup/wizard.ts src/setup/init.ts package.json
git commit -m "refactor(wizard): replace DEV_ROOT with pkgRoot parameter for bundle compat"
```

---

### Task 3: Inline agent seeding in doAgent()

**Files:**
- Modify: `src/setup/wizard.ts` (rewrite doAgent)

Currently `doAgent()` shells out to `npx tsx setup/setup-seeds.ts` — a dev script that reads plugin seeds, imports `AgentDefinition` types, etc. For package mode, this script doesn't exist. Instead, read the CoS seed YAML directly and insert into MongoDB.

- [ ] **Step 1:** Add `seedsDir` import in wizard.ts

At the top of the file, add to existing path imports:

```typescript
import { seedsDir } from "../paths.js";
```

- [ ] **Step 2:** Rewrite `doAgent()` to seed directly from YAML

Replace the entire `doAgent` function with:

```typescript
async function doAgent(hive: Record<string, any>): Promise<void> {
  section("Chief of Staff Agent");

  console.log("Hive starts with a Chief of Staff — your primary agent.");
  console.log("Additional agents are created through it as needed.\n");

  const agentName = await ask("Name your Chief of Staff", "Mokie");
  const channelName = await ask("Slack channel for your CoS", `agent-${agentName.toLowerCase()}`);

  // Store in hive.yaml for constitution rendering
  if (!hive.agents) hive.agents = {};
  hive.agents["chief-of-staff"] = { name: agentName };
  saveHiveYaml(hive);

  // Read seed YAML
  const seedPath = resolve(seedsDir, "chief-of-staff", "agent.yaml");
  if (!existsSync(seedPath)) {
    console.log(`  ⚠ Seed not found: ${seedPath}`);
    console.log("  You can seed the agent manually later.");
    return;
  }

  const raw = parseYaml(readFileSync(seedPath, "utf-8")) as Record<string, any>;

  // Customize from user input
  raw.name = agentName;
  raw.channels = [channelName];

  // Insert into MongoDB
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const hiveConfig = loadHiveYaml();
  const instanceId = (hiveConfig.instance?.id as string) ?? "hive";
  const mongoDb = process.env.MONGODB_DB || `hive_${instanceId}`;

  try {
    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db(mongoDb);
    const agentDefs = db.collection("agent_definitions");

    const existing = await agentDefs.findOne({ _id: raw._id });
    if (existing) {
      console.log(`  Agent "${raw._id}" already exists in DB — updating name and channel.`);
      await agentDefs.updateOne(
        { _id: raw._id },
        { $set: { name: agentName, channels: [channelName], updatedAt: new Date(), updatedBy: "setup-wizard" } },
      );
    } else {
      const now = new Date();
      await agentDefs.insertOne({
        ...raw,
        createdAt: now,
        updatedAt: now,
        updatedBy: "setup-wizard",
      });
    }

    await client.close();
    console.log(`  ✓ ${agentName} (Chief of Staff) seeded to MongoDB`);
  } catch (err) {
    console.log(`  ⚠ Failed to seed agent: ${err}`);
    console.log("  Make sure MongoDB is running (brew services start mongodb-community)");
  }
}
```

- [ ] **Step 3:** Verify `doAgent` call sites in `runWizard()` are unchanged

The `doAgent(hive)` calls (both the initial call and the "redo" path) keep the same signature — no `pkgRoot` needed since seed paths come from `seedsDir` (imported from `paths.ts`).

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: passes

- [ ] **Step 5:** Commit

```bash
git add src/setup/wizard.ts
git commit -m "feat(wizard): inline CoS agent seeding with user-customizable name and channel"
```

---

### Task 4: Conditional build/deploy + daemon-based service install

**Files:**
- Modify: `src/setup/wizard.ts` (steps 8, 9, 10 in the wizard flow)

In package mode (installed via npm), there's no source to build, no deploy dir to clone, and service install should use `daemon.ts` instead of `bash service/install.sh`.

- [ ] **Step 1:** Conditionally skip build step

In `runWizard()`, change the build section (step 8, around line 426):

```typescript
  // ── 8. Build ──────────────────────────────────────────────────────
  if (!isBundled) {
    section("Build");

    if (isBuildDone(targetDir)) {
      console.log("Build output exists.");
      const rebuild = await confirm("Rebuild?", true);
      if (!rebuild) {
        console.log("  ✓ Skipped");
      } else {
        await doBuild(pkgRoot);
      }
    } else {
      await doBuild(pkgRoot);
    }
  }
```

- [ ] **Step 2:** Conditionally skip deploy step

Change the deploy section (step 9, around line 441):

```typescript
  // ── 9. Deploy ──────────────────────────────────────────────────────
  if (!isBundled) {
    section("Deploy");

    const deployDir = join(process.env.HOME ?? "/tmp", "services", "hive");
    const deployExists = existsSync(join(deployDir, "package.json"));

    if (deployExists) {
      console.log(`Deploy directory exists: ${deployDir}`);
      const redeploy = await confirm("Sync latest build and config?", true);
      if (redeploy) {
        await doDeploy(deployDir, pkgRoot);
      } else {
        console.log("  ✓ Skipped");
      }
    } else {
      console.log("Hive runs from a separate deploy directory (not this dev repo).");
      console.log(`  Dev:    ${pkgRoot}`);
      console.log(`  Deploy: ${deployDir}`);
      console.log("");
      const setupDeploy = await confirm("Set up the deploy directory now?", true);
      if (setupDeploy) {
        await doDeploy(deployDir, pkgRoot);
      }
    }
  }
```

- [ ] **Step 3:** Replace service install with daemon.ts

Change the service section (step 10, around line 466):

```typescript
  // ── 10. Service ───────────────────────────────────────────────────
  section("Service");

  const installService = await confirm("Install Hive as a LaunchAgent (starts on login)?");
  if (installService) {
    try {
      const { startDaemon } = await import("../cli/daemon.js");
      await startDaemon(pkgRoot);
    } catch (err) {
      console.log(`  ⚠ Service installation failed: ${err}`);
      console.log(`     You can start manually: hive start`);
    }
  }
```

- [ ] **Step 4:** Update the "Done" banner for package mode

Change the final output section. Replace the existing done block with:

```typescript
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║              Hive is ready!                  ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("Quick reference:");
  console.log(`  Config dir:  ${targetDir}`);
  console.log(`  Start:       hive start`);
  console.log(`  Daemon:      hive start --daemon`);
  console.log(`  Stop:        hive stop`);
  console.log(`  Health:      hive doctor`);
  if (!isBundled) {
    console.log(`  Dev mode:    npm run dev  (from ${pkgRoot})`);
  }
  console.log("");
  console.log("Your chief-of-staff agent is stored in the agent_definitions collection.");
  console.log("Additional agents can be created through the chief of staff.");
  console.log("");
```

- [ ] **Step 5:** Verify

Run: `npm run typecheck`
Expected: passes

- [ ] **Step 6:** Commit

```bash
git add src/setup/wizard.ts
git commit -m "feat(wizard): skip build/deploy in package mode, use daemon.ts for service install"
```

---

### Task 5: Instance defaults and hive.yaml bootstrapping

**Files:**
- Modify: `src/setup/wizard.ts` (add instance config section early in flow)

Fresh npm installs have no `hive.yaml`. The wizard creates one through the business info section, but it needs instance metadata (ID, ports) for MongoDB database naming and the LaunchAgent label.

**Critical ordering:** This must run BEFORE the resume-detection block, because `isAgentDone()` uses `MONGODB_DB` to find the right database. If we bootstrap instance config after the resume check, the agent-done check will look in the wrong database.

- [ ] **Step 1:** Add instance config bootstrapping BEFORE the resume check in `runWizard()`

Place this immediately after `const hive = loadHiveYaml();` and BEFORE the `completedSections` block:

```typescript
  // ── Instance defaults (must run before resume detection) ──────────
  if (!hive.instance?.id) {
    hive.instance = {
      id: "hive",
      type: "business",
    };
    hive.ports = hive.ports ?? {
      ws: 3200,
      bgTask: 3201,
    };
    saveHiveYaml(hive);
  }

  // Set MongoDB database name for all downstream operations
  const instanceId = (hive.instance?.id as string) ?? "hive";
  if (!process.env.MONGODB_DB) {
    process.env.MONGODB_DB = `hive_${instanceId}`;
  }
```

Note: The `MONGODB_DB` env var set is OUTSIDE the `if (!hive.instance?.id)` guard — it must run on every invocation (including resume) so that `isAgentDone()` and `doMemory()` use the correct database.

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: passes

- [ ] **Step 3:** Commit

```bash
git add src/setup/wizard.ts
git commit -m "feat(wizard): bootstrap instance config defaults for fresh installs"
```

---

### Task 6: End-to-end verification

No files to modify — this task validates everything works.

- [ ] **Step 1:** Run full check suite

Run: `npm run check`
Expected: typecheck, lint, format, tests all pass.

- [ ] **Step 2:** Run bundle check

Run: `npm run check:bundle`
Expected: all three guardrails pass. The wizard code must bundle successfully — the static template-renderer import should be inlined by esbuild.

- [ ] **Step 3:** Verify template-renderer is bundled

Run: `grep -c "resolvePath" pkg/cli.min.js`
Expected: at least 1 match (the function is inlined into the bundle)

- [ ] **Step 4:** Verify the wizard loads from bundled CLI without import errors

Run: `echo "" | timeout 5 node pkg/cli.min.js init 2>&1 | head -10 || true`
Expected: Should show the wizard banner or prompt — NOT a "Cannot find module" or "ERR_MODULE_NOT_FOUND" error for template-renderer. The `init` command has no `--help` flag, so we pipe empty stdin and timeout to avoid blocking.

- [ ] **Step 5:** Commit only if fixups needed
