#!/usr/bin/env npx tsx
/**
 * Hive Setup Wizard — interactive CLI to configure a new Hive instance.
 *
 * Usage:
 *   npm run setup
 *   npx tsx setup/setup-wizard.ts
 */

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { stringify as toYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal = ""): Promise<string> {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${question} (${hint})`, defaultYes ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}

function banner() {
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║            Hive Setup Wizard                 ║");
  console.log("║   Multi-Agent Slack Orchestration Framework  ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
}

function section(title: string) {
  console.log("");
  console.log(`── ${title} ${"─".repeat(Math.max(0, 44 - title.length))}`);
  console.log("");
}

async function main() {
  banner();

  console.log("This wizard will configure Hive for your business.");
  console.log("You'll need: a Slack workspace, an Anthropic API key,");
  console.log("and about 10 minutes.");
  console.log("");
  await ask("Press Enter to begin...");

  // ── Business Info ──────────────────────────────────────────────
  section("Your Business");

  const businessName = await ask("Business name");
  const businessDesc = await ask("What does your business do? (one sentence)");
  const businessLocation = await ask("Location (city, state)", "");
  const ownerName = await ask("Your name (or the primary user's name)");
  const ownerRole = await ask("Your role", "CEO");

  // ── Slack Setup ────────────────────────────────────────────────
  section("Slack App Setup");

  console.log("You need a Slack app with Socket Mode enabled.");
  console.log("");
  console.log("1. Go to: https://api.slack.com/apps");
  console.log('2. Click "Create New App" → "From a manifest"');
  console.log("3. Select your workspace");
  console.log("4. Choose YAML format and paste this manifest:");
  console.log("");
  console.log("─── Copy everything below this line ───");
  console.log(readFileSync(join(ROOT, "setup", "slack-manifest.yaml"), "utf-8"));
  console.log("─── Copy everything above this line ───");
  console.log("");
  console.log('5. Click "Create"');
  console.log('6. Go to "Install App" → Install to workspace');
  console.log("");

  await ask("Press Enter when your app is created and installed...");

  console.log("");
  console.log("Now collect your tokens:");
  console.log("");

  console.log('App-Level Token: Go to "Basic Information" → "App-Level Tokens"');
  console.log('  → "Generate Token and Scopes" → add scope "connections:write"');
  const slackAppToken = await ask("App-Level Token (xapp-...)");

  console.log("");
  console.log('Bot Token: Go to "OAuth & Permissions" → "Bot User OAuth Token"');
  const slackBotToken = await ask("Bot Token (xoxb-...)");

  console.log("");
  const wantSlackMcp = await confirm("Do you have a Slack MCP user token (xoxp-...)? (for Slack search)", false);
  const slackMcpToken = wantSlackMcp ? await ask("Slack MCP Token (xoxp-...)") : "";

  // Validate Slack tokens
  if (slackAppToken && slackBotToken) {
    try {
      const result = execSync(
        `curl -s -H "Authorization: Bearer ${slackBotToken}" https://slack.com/api/auth.test`,
        { encoding: "utf-8" },
      );
      const json = JSON.parse(result);
      if (json.ok) {
        console.log(`\n  ✓ Slack connected as: ${json.user} in ${json.team}`);
      } else {
        console.log(`\n  ⚠ Slack token test failed: ${json.error}`);
        console.log("  You can fix this in .env later.");
      }
    } catch {
      console.log("\n  ⚠ Could not validate Slack token (no network?)");
    }
  }

  // ── Anthropic API Key ──────────────────────────────────────────
  section("Anthropic API Key");

  console.log("Get your API key from: https://console.anthropic.com/settings/keys");
  console.log("");
  const anthropicKey = await ask("Anthropic API Key (sk-ant-...)");

  // ── Optional Integrations ──────────────────────────────────────
  section("Optional Integrations");

  // SMS via Quo
  const wantQuo = await confirm("Enable SMS via Quo (OpenPhone)?", false);
  let quoApiKey = "";
  let quoPhoneId = "";
  const smsLines: Array<{ id: string; label: string; number: string; slackChannel: string }> = [];
  const quoLines: Record<string, { id: string; number: string; label: string }> = {};

  if (wantQuo) {
    console.log("Get your API key from: Quo workspace settings → API tab");
    quoApiKey = await ask("Quo API Key");
    quoPhoneId = await ask("Default Phone Number ID (PNxxx)");

    const addLines = await confirm("Configure named phone lines?", false);
    if (addLines) {
      let more = true;
      while (more) {
        const lineName = await ask("Line name (e.g. main, personal)");
        const lineId = await ask("Phone Number ID (PNxxx)");
        const lineNumber = await ask("Phone number (e.g. (555) 123-4567)");
        const lineLabel = await ask("Label (e.g. Jane's Line)");
        const lineChannel = await ask("Slack channel for incoming SMS", `sms-${lineName}`);

        quoLines[lineName] = { id: lineId, number: lineNumber, label: lineLabel };
        smsLines.push({ id: lineId, label: lineLabel, number: lineNumber, slackChannel: lineChannel });

        more = await confirm("Add another line?", false);
      }
    }
  }

  // Google
  const wantGoogle = await confirm("Enable Google Gmail/Calendar integration?", false);
  let googleAccount = "";
  if (wantGoogle) {
    googleAccount = await ask("Google account email");
    console.log("  Note: You'll need the 'gog' CLI installed and authenticated.");
    console.log("  Install: brew install gog (or see https://github.com/jcfisher/gog)");
  }

  // Linear
  const wantLinear = await confirm("Enable Linear (project management) integration?", false);
  let linearKey = "";
  if (wantLinear) {
    linearKey = await ask("Linear API Key");
  }

  // ── Agent Selection ────────────────────────────────────────────
  section("Agent Selection");

  console.log("Hive comes with starter agents you can customize later.");
  console.log("Chief of Staff (default triage agent) is always included.\n");

  const wantRae = await confirm("Include Executive Assistant (task tracking, email, calendar)?", true);
  const wantRiver = await confirm("Include Marketing Manager (lead gen, content)?", false);

  // ── Memory Setup ───────────────────────────────────────────────
  section("Memory");

  const memoryPath = await ask("Local memory directory", `${process.env.HOME}/hive-memory`);
  const memoryRepo = await ask("GitHub repo for memory backup (leave empty to skip)", "");

  // ── Confirmation ───────────────────────────────────────────────
  section("Configuration Summary");

  console.log(`  Business:     ${businessName} — ${businessDesc}`);
  console.log(`  Location:     ${businessLocation || "(not set)"}`);
  console.log(`  Owner:        ${ownerName} (${ownerRole})`);
  console.log(`  Slack:        ${slackBotToken ? "✓ configured" : "⚠ missing"}`);
  console.log(`  Anthropic:    ${anthropicKey ? "✓ configured" : "⚠ missing"}`);
  console.log(`  SMS (Quo):    ${wantQuo ? `✓ ${smsLines.length} line(s)` : "disabled"}`);
  console.log(`  Google:       ${wantGoogle ? "✓ " + googleAccount : "disabled"}`);
  console.log(`  Linear:       ${wantLinear ? "✓ configured" : "disabled"}`);
  console.log(`  Agents:       Chief of Staff${wantRae ? ", Executive Assistant" : ""}${wantRiver ? ", Marketing Manager" : ""}`);
  console.log(`  Memory:       ${memoryPath}`);
  console.log("");

  const proceed = await confirm("Generate configuration and set up Hive?");
  if (!proceed) {
    console.log("Setup cancelled.");
    rl.close();
    return;
  }

  // ── Generate Files ─────────────────────────────────────────────
  section("Generating Configuration");

  // hive.yaml
  const hiveConfig: Record<string, any> = {
    business: {
      name: businessName,
      description: businessDesc,
      location: businessLocation || undefined,
      owner: { name: ownerName, role: ownerRole },
    },
    memory: {
      localPath: memoryPath,
      ...(memoryRepo ? { repo: memoryRepo } : {}),
    },
  };

  if (smsLines.length > 0) {
    hiveConfig.sms = { lines: smsLines };
  }
  if (Object.keys(quoLines).length > 0) {
    hiveConfig.quo = { lines: quoLines };
  }

  writeFileSync(join(ROOT, "hive.yaml"), toYaml(hiveConfig));
  console.log("  ✓ hive.yaml");

  // .env
  const envLines = [
    `SLACK_APP_TOKEN=${slackAppToken}`,
    `SLACK_BOT_TOKEN=${slackBotToken}`,
    slackMcpToken ? `SLACK_MCP_TOKEN=${slackMcpToken}` : "# SLACK_MCP_TOKEN=",
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    quoApiKey ? `QUO_API_KEY=${quoApiKey}` : "# QUO_API_KEY=",
    quoPhoneId ? `QUO_PHONE_NUMBER_ID=${quoPhoneId}` : "# QUO_PHONE_NUMBER_ID=",
    googleAccount ? `GOOGLE_ACCOUNT=${googleAccount}` : "# GOOGLE_ACCOUNT=",
    linearKey ? `LINEAR_API_KEY=${linearKey}` : "# LINEAR_API_KEY=",
  ];
  writeFileSync(join(ROOT, ".env"), envLines.join("\n") + "\n");
  console.log("  ✓ .env");

  // Generate agents from templates
  console.log("  Generating agents from templates...");

  // If user doesn't want certain agents, we need to handle that
  // For now, generate all, then remove unwanted
  execSync("npx tsx setup/generate-agents.ts", { cwd: ROOT, stdio: "inherit" });

  if (!wantRae) {
    execSync(`rm -rf ${join(ROOT, "agents", "executive-assistant")}`);
    console.log("  (removed executive-assistant — not selected)");
  }
  if (!wantRiver) {
    execSync(`rm -rf ${join(ROOT, "agents", "marketing-manager")}`);
    console.log("  (removed marketing-manager — not selected)");
  }

  // Generate launchd plist
  execSync("npx tsx setup/generate-plist.ts", { cwd: ROOT, stdio: "inherit" });

  // Initialize memory directory
  const resolvedMemPath = memoryPath.replace("~", process.env.HOME ?? "/tmp");
  if (!existsSync(resolvedMemPath)) {
    mkdirSync(resolvedMemPath, { recursive: true });
    execSync("git init", { cwd: resolvedMemPath, stdio: "pipe" });

    // Create initial structure
    for (const dir of ["agents/chief-of-staff", "shared", "status"]) {
      mkdirSync(join(resolvedMemPath, dir), { recursive: true });
    }

    // Write initial business context
    const contextMd = [
      `# Business Context\n`,
      `**Company:** ${businessName}`,
      `**About:** ${businessDesc}`,
      businessLocation ? `**Location:** ${businessLocation}` : "",
      `**Owner:** ${ownerName} (${ownerRole})`,
      "",
      "## Additional Context",
      "(Add more details about your business here — products, services, team, etc.)",
    ]
      .filter(Boolean)
      .join("\n");

    writeFileSync(join(resolvedMemPath, "shared", "business-context.md"), contextMd);

    execSync("git add -A && git commit -m 'Initial Hive memory setup'", {
      cwd: resolvedMemPath,
      stdio: "pipe",
    });

    if (memoryRepo) {
      try {
        execSync(`git remote add origin https://github.com/${memoryRepo}.git`, {
          cwd: resolvedMemPath,
          stdio: "pipe",
        });
        console.log(`  ✓ Memory repo linked to ${memoryRepo}`);
      } catch {
        console.log(`  ⚠ Could not add remote — set it up manually later`);
      }
    }
    console.log(`  ✓ Memory initialized at ${resolvedMemPath}`);
  } else {
    console.log(`  ✓ Memory directory already exists at ${resolvedMemPath}`);
  }

  // ── Build ──────────────────────────────────────────────────────
  section("Building");

  console.log("  Installing dependencies...");
  execSync("npm install", { cwd: ROOT, stdio: "pipe" });
  console.log("  ✓ Dependencies installed");

  console.log("  Compiling TypeScript...");
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
  console.log("  ✓ Build complete");

  // ── Service Installation ───────────────────────────────────────
  section("Service");

  const installService = await confirm("Install Hive as a system service (starts on boot)?");
  if (installService) {
    try {
      execSync("bash service/install.sh", { cwd: ROOT, stdio: "inherit" });
      console.log("  ✓ Service installed and started");
    } catch {
      console.log("  ⚠ Service installation failed — you can run manually with 'npm start'");
    }
  }

  // ── Done ───────────────────────────────────────────────────────
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║              Hive is ready!                  ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("Quick reference:");
  console.log("  Start:    npm start");
  console.log("  Dev mode: npm run dev");
  console.log("  Logs:     tail -f logs/stdout.log");
  console.log("  Update:   npm run update");
  console.log("");
  console.log("Your agents are in the agents/ directory.");
  console.log("Edit their system-prompt.md files to customize their behavior.");
  console.log("Changes are picked up automatically (hot-reload).");
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
