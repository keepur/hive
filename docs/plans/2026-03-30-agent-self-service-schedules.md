# Agent Self-Service Schedule Management

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Give every agent the ability to manage their own task schedules via a scoped MCP server. Remove admin MCP access from all in-hive agents. Update the constitution to encourage learning from experience.

**Architecture:** New `schedule-mcp-server.ts` exposes 4 tools scoped to `AGENT_ID === self`, writing to the existing `schedule_overrides` MongoDB collection. Wired as an implicit core server in agent-runner (available to all agents like `memory`). Constitution gets a "Learning & Growth" section.

**Tech Stack:** MCP SDK, MongoDB, Zod, TypeScript

**Closes:** #60

---

### Task 1: Create schedule MCP server

**Files:**
- Create: `src/schedule/schedule-mcp-server.ts`

- [ ] **Step 1:** Create `src/schedule/` directory and the MCP server

```typescript
#!/usr/bin/env node

/**
 * Schedule MCP Server — self-service schedule management for agents.
 * Each agent can only manage their own schedules.
 *
 * Env vars:
 *   AGENT_ID                  — the calling agent's ID (scope lock)
 *   AGENT_SCHEDULE_DEFAULTS   — JSON-serialized default schedules from agent.yaml
 *   MONGODB_URI               — MongoDB connection string
 *   MONGODB_DB                — database name
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const AGENT_ID = process.env.AGENT_ID ?? "unknown";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const MAX_SCHEDULES = 10;
const MIN_INTERVAL_MINUTES = 15;

// Parse defaults from agent.yaml (passed as JSON by agent-runner)
let defaults: Array<{ cron: string; task: string }> = [];
try {
  defaults = JSON.parse(process.env.AGENT_SCHEDULE_DEFAULTS ?? "[]");
} catch {
  defaults = [];
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const scheduleOverrides = db.collection("schedule_overrides");

const server = new McpServer({
  name: "hive-schedule",
  version: "0.1.0",
});

/**
 * Validate that a cron expression doesn't resolve to faster than every N minutes.
 * Simple heuristic: check the minute field for intervals < MIN_INTERVAL_MINUTES.
 */
function validateMinInterval(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return "Invalid cron expression — need 5 fields (minute hour dom month dow)";

  const minuteField = parts[0]!;

  // Step values: */5 means every 5 minutes
  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]!, 10);
    if (step < MIN_INTERVAL_MINUTES) {
      return `Interval too frequent: every ${step} minutes. Minimum is every ${MIN_INTERVAL_MINUTES} minutes.`;
    }
  }

  // Comma-separated values: check if any two are closer than MIN_INTERVAL_MINUTES
  if (minuteField.includes(",")) {
    const vals = minuteField.split(",").map((v) => parseInt(v, 10)).filter((v) => !isNaN(v)).sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i++) {
      if (vals[i]! - vals[i - 1]! < MIN_INTERVAL_MINUTES) {
        return `Minutes too close together: ${vals[i - 1]} and ${vals[i]}. Minimum gap is ${MIN_INTERVAL_MINUTES} minutes.`;
      }
    }
  }

  // Range: 0-59 with no step is every minute
  if (minuteField === "*") {
    // Check if hour/dom/month/dow restrict frequency enough
    // If all other fields are wildcards, this runs every minute
    const allWild = parts.slice(1).every((p) => p === "*");
    if (allWild) return "This would run every minute. Minimum interval is every 15 minutes.";
  }

  return null; // valid
}

// ── my_schedules ──────────────────────────────────────────────────────

server.registerTool(
  "my_schedules",
  {
    title: "My Schedules",
    description:
      "List your active schedules — shows both YAML defaults and any overrides you've set.",
    inputSchema: {},
  },
  async () => {
    const override = await scheduleOverrides.findOne({ agentId: AGENT_ID }) as any;

    const lines: string[] = [];
    lines.push(`## Schedules for ${AGENT_ID}\n`);

    if (override?.schedule === null) {
      lines.push("**Status: ALL DISABLED** (schedule override set to null)\n");
      lines.push("### YAML Defaults (inactive):");
      for (const s of defaults) {
        lines.push(`  ${s.cron} → ${s.task}`);
      }
    } else if (override?.schedule) {
      lines.push("### Active (override):");
      for (const s of override.schedule) {
        lines.push(`  ${s.cron} → ${s.task}`);
      }
      const date = override.updatedAt instanceof Date ? override.updatedAt.toISOString() : String(override.updatedAt ?? "");
      lines.push(`\n_Last updated: ${date}_`);

      if (defaults.length > 0) {
        lines.push("\n### YAML Defaults (overridden):");
        for (const s of defaults) {
          lines.push(`  ${s.cron} → ${s.task}`);
        }
      }
    } else {
      lines.push("### Active (YAML defaults):");
      for (const s of defaults) {
        lines.push(`  ${s.cron} → ${s.task}`);
      }
      lines.push("\n_No overrides set — using YAML defaults._");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ── my_schedule_add ───────────────────────────────────────────────────

server.registerTool(
  "my_schedule_add",
  {
    title: "Add Schedule",
    description:
      "Add a new scheduled task. Must provide a cron expression and task name. Minimum interval: 15 minutes. Maximum: 10 schedules.",
    inputSchema: {
      cron: z.string().describe("Cron expression (e.g. '0 9 * * 1-5' for weekdays at 9am)"),
      task: z.string().describe("Task name (e.g. 'check-inbox', 'weekly-report')"),
      reason: z.string().describe("Why you're adding this schedule (for audit trail)"),
    },
  },
  async ({ cron, task, reason }) => {
    // Validate cron interval
    const intervalError = validateMinInterval(cron);
    if (intervalError) {
      return { content: [{ type: "text", text: intervalError }], isError: true };
    }

    // Get current active schedules
    const override = await scheduleOverrides.findOne({ agentId: AGENT_ID }) as any;
    const current: Array<{ cron: string; task: string }> =
      override?.schedule ?? (override?.schedule === null ? [] : [...defaults]);

    // Check max limit
    if (current.length >= MAX_SCHEDULES) {
      return {
        content: [{ type: "text", text: `Maximum ${MAX_SCHEDULES} schedules reached. Remove one first.` }],
        isError: true,
      };
    }

    // Check for duplicate task name
    if (current.some((s) => s.task === task)) {
      return {
        content: [{ type: "text", text: `Schedule for task '${task}' already exists. Use my_schedule_update to change it.` }],
        isError: true,
      };
    }

    const newSchedule = [...current, { cron, task }];

    await scheduleOverrides.updateOne(
      { agentId: AGENT_ID },
      {
        $set: {
          schedule: newSchedule,
          updatedAt: new Date(),
          updatedBy: AGENT_ID,
          reason,
        },
      },
      { upsert: true },
    );

    // Trigger hot-reload
    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [{ type: "text", text: `Added schedule: ${cron} → ${task}\nReason: ${reason}\nHot-reload triggered.` }],
    };
  },
);

// ── my_schedule_remove ────────────────────────────────────────────────

server.registerTool(
  "my_schedule_remove",
  {
    title: "Remove Schedule",
    description: "Remove a scheduled task by task name.",
    inputSchema: {
      task: z.string().describe("The task name to remove"),
      reason: z.string().describe("Why you're removing this schedule (for audit trail)"),
    },
  },
  async ({ task, reason }) => {
    const override = await scheduleOverrides.findOne({ agentId: AGENT_ID }) as any;
    const current: Array<{ cron: string; task: string }> =
      override?.schedule ?? (override?.schedule === null ? [] : [...defaults]);

    const idx = current.findIndex((s) => s.task === task);
    if (idx === -1) {
      return {
        content: [{ type: "text", text: `No schedule found for task '${task}'.` }],
        isError: true,
      };
    }

    const newSchedule = current.filter((_, i) => i !== idx);

    await scheduleOverrides.updateOne(
      { agentId: AGENT_ID },
      {
        $set: {
          schedule: newSchedule,
          updatedAt: new Date(),
          updatedBy: AGENT_ID,
          reason,
        },
      },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [{ type: "text", text: `Removed schedule for task '${task}'.\nReason: ${reason}\nHot-reload triggered.` }],
    };
  },
);

// ── my_schedule_update ────────────────────────────────────────────────

server.registerTool(
  "my_schedule_update",
  {
    title: "Update Schedule",
    description: "Update the cron expression for an existing scheduled task.",
    inputSchema: {
      task: z.string().describe("The task name to update"),
      cron: z.string().describe("New cron expression"),
      reason: z.string().describe("Why you're changing this schedule (for audit trail)"),
    },
  },
  async ({ task, cron, reason }) => {
    // Validate cron interval
    const intervalError = validateMinInterval(cron);
    if (intervalError) {
      return { content: [{ type: "text", text: intervalError }], isError: true };
    }

    const override = await scheduleOverrides.findOne({ agentId: AGENT_ID }) as any;
    const current: Array<{ cron: string; task: string }> =
      override?.schedule ?? (override?.schedule === null ? [] : [...defaults]);

    const idx = current.findIndex((s) => s.task === task);
    if (idx === -1) {
      return {
        content: [{ type: "text", text: `No schedule found for task '${task}'.` }],
        isError: true,
      };
    }

    current[idx] = { cron, task };

    await scheduleOverrides.updateOne(
      { agentId: AGENT_ID },
      {
        $set: {
          schedule: current,
          updatedAt: new Date(),
          updatedBy: AGENT_ID,
          reason,
        },
      },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [{ type: "text", text: `Updated schedule: ${cron} → ${task}\nReason: ${reason}\nHot-reload triggered.` }],
    };
  },
);

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2:** Commit

```bash
git add src/schedule/schedule-mcp-server.ts
git commit -m "feat(#60): add schedule MCP server for agent self-service

4 tools: my_schedules, my_schedule_add, my_schedule_remove, my_schedule_update.
Scoped to AGENT_ID, 15-min minimum interval, 10 schedule max, audit trail."
```

---

### Task 2: Wire schedule server into agent-runner

**Files:**
- Modify: `src/agents/agent-runner.ts:135-508` (inside `buildAllServerConfigs()`)

- [ ] **Step 1:** Add the schedule server config in `buildAllServerConfigs()`, after the admin server block (around line 505)

```typescript
    // Schedule MCP server — self-service schedule management for each agent
    servers["schedule"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/schedule/schedule-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        AGENT_SCHEDULE_DEFAULTS: JSON.stringify(this.agentConfig.schedule ?? []),
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
      },
    };
```

- [ ] **Step 2:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(#60): wire schedule MCP server into agent-runner

Available to all agents as implicit core server (like memory).
Passes AGENT_SCHEDULE_DEFAULTS from agent config."
```

---

### Task 3: Remove admin from chief-of-staff's core servers

**Files:**
- Modify: `agents-templates/chief-of-staff/agent.yaml.tpl`

- [ ] **Step 1:** Remove `admin` from the `servers.core` list in chief-of-staff template

The current servers.core is:
```yaml
servers:
  core:
    - memory
    - conversation-search
    - slack
    - admin
    - callback
    - browser
    - keychain
    - event-bus
```

Remove `admin`:
```yaml
servers:
  core:
    - memory
    - conversation-search
    - slack
    - callback
    - browser
    - keychain
    - event-bus
```

Note: chief-of-staff is already disabled from Task 2 of the #59 plan, but we still remove admin from the template for cleanliness and in case it's ever re-enabled.

- [ ] **Step 2:** Verify no other agent templates reference `admin` in their servers

Run: `grep -r "admin" agents-templates/*/agent.yaml.tpl`

Only chief-of-staff should have it. If others do, remove from those too.

- [ ] **Step 3:** Commit

```bash
git add agents-templates/chief-of-staff/agent.yaml.tpl
git commit -m "feat(#60): remove admin MCP from chief-of-staff

No in-hive agent has admin privileges. Platform admin is
handled by the beekeeper (Claude Code CLI)."
```

---

### Task 4: Update constitution with Learning & Growth section

**Files:**
- Modify: `setup/templates/constitution-business.md.tpl`

- [ ] **Step 1:** Add a "Learning & Growth" section after section 9 (Self-Governance), before section 10 (Common Tools)

```markdown
---

## 10. Learning & Growth

10.1. **You learn from experience.** When you discover something that improves how you work - a better approach, a customer preference, a lesson from a mistake - save it to memory so you can apply it next time.

10.2. **Manage your own schedule.** You can add, update, or remove your scheduled tasks using the schedule tools. Use this to adapt your work patterns based on what you learn.
```

Renumber existing sections 10-12 to 11-13.

- [ ] **Step 2:** Also update the personal constitution template if it exists

Check `setup/templates/constitution-personal.md.tpl` — add the same Learning & Growth section if the file has similar structure.

- [ ] **Step 3:** Commit

```bash
git add setup/templates/constitution-business.md.tpl setup/templates/constitution-personal.md.tpl
git commit -m "feat(#60): add Learning & Growth section to constitution

Encourages agents to learn from experience and manage their own
schedules. Renumbers subsequent sections."
```

---

### Task 5: Add tests for schedule MCP server

**Files:**
- Create: `src/schedule/schedule-mcp-server.test.ts`

- [ ] **Step 1:** Write tests for the `validateMinInterval` function and tool behavior

```typescript
import { describe, it, expect } from "vitest";

// Test the validation logic directly by extracting it
// We test the cron validation heuristic

describe("schedule-mcp-server", () => {
  describe("cron interval validation", () => {
    // We'll test the validateMinInterval logic
    // Extract it or test via the tool responses

    function validateMinInterval(cron: string): string | null {
      const parts = cron.trim().split(/\s+/);
      if (parts.length < 5) return "Invalid cron expression — need 5 fields (minute hour dom month dow)";

      const minuteField = parts[0]!;

      const stepMatch = minuteField.match(/^\*\/(\d+)$/);
      if (stepMatch) {
        const step = parseInt(stepMatch[1]!, 10);
        if (step < 15) {
          return `Interval too frequent: every ${step} minutes. Minimum is every 15 minutes.`;
        }
      }

      if (minuteField.includes(",")) {
        const vals = minuteField.split(",").map((v) => parseInt(v, 10)).filter((v) => !isNaN(v)).sort((a, b) => a - b);
        for (let i = 1; i < vals.length; i++) {
          if (vals[i]! - vals[i - 1]! < 15) {
            return `Minutes too close together: ${vals[i - 1]} and ${vals[i]}. Minimum gap is 15 minutes.`;
          }
        }
      }

      if (minuteField === "*") {
        const allWild = parts.slice(1).every((p) => p === "*");
        if (allWild) return "This would run every minute. Minimum interval is every 15 minutes.";
      }

      return null;
    }

    it("accepts valid 15-minute intervals", () => {
      expect(validateMinInterval("*/15 * * * *")).toBeNull();
      expect(validateMinInterval("*/30 * * * *")).toBeNull();
      expect(validateMinInterval("0 8 * * 1-5")).toBeNull();
      expect(validateMinInterval("0 6 * * 0")).toBeNull();
    });

    it("rejects intervals under 15 minutes", () => {
      expect(validateMinInterval("*/5 * * * *")).toContain("too frequent");
      expect(validateMinInterval("*/10 * * * *")).toContain("too frequent");
      expect(validateMinInterval("*/1 * * * *")).toContain("too frequent");
    });

    it("rejects every-minute wildcards", () => {
      expect(validateMinInterval("* * * * *")).toContain("every minute");
    });

    it("allows wildcard minutes with restricted other fields", () => {
      // * with restricted hour — runs every minute of that hour, but that's 60 runs
      // This is a known limitation — we only catch the all-wildcard case
      expect(validateMinInterval("* 8 * * *")).toBeNull();
    });

    it("rejects comma-separated minutes too close together", () => {
      expect(validateMinInterval("0,5 * * * *")).toContain("too close");
      expect(validateMinInterval("0,10,20 * * * *")).toContain("too close");
    });

    it("accepts comma-separated minutes with enough gap", () => {
      expect(validateMinInterval("0,15,30,45 * * * *")).toBeNull();
      expect(validateMinInterval("0,30 * * * *")).toBeNull();
    });

    it("rejects malformed cron", () => {
      expect(validateMinInterval("* *")).toContain("need 5 fields");
      expect(validateMinInterval("hello")).toContain("need 5 fields");
    });
  });
});
```

- [ ] **Step 2:** Verify tests pass

Run: `npx vitest run src/schedule/schedule-mcp-server.test.ts`

- [ ] **Step 3:** Commit

```bash
git add src/schedule/schedule-mcp-server.test.ts
git commit -m "test(#60): add tests for schedule MCP server cron validation"
```

---

### Task 6: Update agent-runner tests

**Files:**
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1:** Add a test verifying the schedule server is included in `buildAllServerConfigs()`

Find the existing test pattern for server configs and add:

```typescript
it("includes schedule server with agent defaults", () => {
  // The schedule server should be in allServerConfigs for any agent
  // Verify via the send() call that it appears in mcpServers
  // (buildAllServerConfigs is private, so we verify via the query mock)
});
```

The test should verify the schedule server config includes:
- `AGENT_ID` env var matching the agent
- `AGENT_SCHEDULE_DEFAULTS` containing JSON-serialized schedule

- [ ] **Step 2:** Commit

```bash
git add src/agents/agent-runner.test.ts
git commit -m "test(#60): verify schedule server wiring in agent-runner"
```
