#!/usr/bin/env node

/**
 * Admin MCP Server — agent definition CRUD + version history.
 * Operates on `agent_definitions` and `agent_definition_versions` collections.
 *
 * Env vars:
 *   MONGODB_URI  — MongoDB connection string
 *   MONGODB_DB   — database name (default: "hive")
 *   AGENT_ID     — the calling agent's ID (used for audit trails)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";
import { statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";
import type { AutonomyFlags } from "../agents/autonomy.js";
import type { InstanceCapabilities } from "../tools/instance-capabilities.js";
import { getArchetype, listArchetypeIds } from "../archetypes/registry.js";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const AGENT_ID = process.env.AGENT_ID ?? "admin";

// MongoDB _id filter casts: AgentDefinition uses string _id but the MongoDB driver
// types filter._id as ObjectId. The `as any` casts on `{ _id: id as any }` throughout
// this file are required to bridge this typing mismatch.
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const agentDefs = db.collection<AgentDefinition>("agent_definitions");
const agentVersions = db.collection<AgentDefinitionVersion>("agent_definition_versions");

await agentVersions.createIndex({ agentId: 1, createdAt: -1 });

const server = new McpServer({ name: "hive-admin", version: "0.2.0" });

async function saveVersion(agentId: string, changedFields: string[]): Promise<void> {
  const current = await agentDefs.findOne({ _id: agentId as any });
  if (!current) return;
  await agentVersions.insertOne({
    agentId,
    snapshot: current as unknown as AgentDefinition,
    changedFields,
    createdAt: new Date(),
  });
}

// Change stream / polling picks up DB writes within 30s — no explicit reload needed
function triggerReload(): void {
  // Intentionally empty — the registry's change stream or polling timer
  // detects the updatedAt change and triggers reload automatically.
}

// ---------------------------------------------------------------------------
// agent_list
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_list",
  {
    title: "List Agents",
    description: "List all agent definitions with summary info (id, name, model, channels, disabled status).",
    inputSchema: {},
  },
  async () => {
    const docs = await agentDefs.find().toArray();
    if (docs.length === 0) {
      return { content: [{ type: "text", text: "No agent definitions found." }] };
    }

    const lines = docs.map((d) => {
      const status = d.disabled ? " [DISABLED]" : "";
      const channels = (d.channels ?? []).join(", ") || "(none)";
      return `${d._id}: ${d.name} | model=${d.model} | channels=[${channels}]${status}`;
    });

    return { content: [{ type: "text", text: `Agents (${docs.length}):\n${lines.join("\n")}` }] };
  },
);

// ---------------------------------------------------------------------------
// agent_get
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_get",
  {
    title: "Get Agent Definition",
    description:
      "Fetch full agent definition (admin). Use ONLY for editing or inspecting version history; for routine teammate info (roles, channel, model) prefer `team_lookup_agent`.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'rae', 'jasper')"),
    },
  },
  async ({ agent_id }) => {
    const doc = await agentDefs.findOne({ _id: agent_id as any });
    if (!doc) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    const lines: string[] = [`Agent: ${doc._id}`, `Name: ${doc.name}`, `Icon: ${doc.icon || "(none)"}`];
    lines.push(`Aliases: [${(doc.aliases ?? []).join(", ")}]`);
    lines.push(
      `Roles: ${doc.roles && doc.roles.length > 0 ? doc.roles.join(" / ") : "(not set — backfill via agent_update)"}`,
    );
    lines.push(`Model: ${doc.model}`);
    lines.push(`Channels: [${(doc.channels ?? []).join(", ")}]`);
    lines.push(`Passive Channels: [${(doc.passiveChannels ?? []).join(", ")}]`);
    lines.push(`Keywords: [${(doc.keywords ?? []).join(", ")}]`);
    lines.push(`Is Default: ${doc.isDefault ?? false}`);
    lines.push(`Core Servers: [${(doc.coreServers ?? []).join(", ")}]`);
    lines.push(`Delegate Servers: [${(doc.delegateServers ?? []).join(", ")}]`);
    if (doc.plugins?.length) lines.push(`Plugins: [${doc.plugins.join(", ")}]`);
    lines.push(`Schedule: ${JSON.stringify(doc.schedule ?? [])}`);
    if (doc.subscribe?.length) lines.push(`Subscribe: [${doc.subscribe.join(", ")}]`);
    lines.push(`Budget: $${doc.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd}`);
    lines.push(`Max Turns: ${doc.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns}`);
    lines.push(`Max Concurrent: ${doc.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent}`);
    lines.push(`Timeout: ${doc.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs}ms`);
    lines.push(`Disabled: ${doc.disabled ?? false}`);
    if (doc.slackBot) lines.push(`Slack Bot: ${doc.slackBot}`);
    lines.push(`\n--- Soul ---\n${doc.soul ?? "(not set)"}`);
    lines.push(`\n--- System Prompt ---\n${doc.systemPrompt ?? "(not set)"}`);
    const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? "");
    lines.push(`\nUpdated: ${updatedAt} by ${doc.updatedBy ?? "unknown"}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// agent_create
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_create",
  {
    title: "Create Agent",
    description:
      'Create a new agent definition. Required: _id, name, model, homeBase, roles. Roles is an array of concise role labels (e.g. ["VP Engineering"] or ["Production Support", "Bilingual liaison"]) — used by team_lookup_agent and the team summary in agent system prompts. Archetype is optional — pass it when the role is a discipline with shared infrastructure (see list_archetypes). Soul/systemPrompt shape the agent\'s voice and role; if omitted they default to empty strings. Additional tuning (channels, schedule, budget, autonomy, archetypeConfig, etc.) goes in `fields`.',
    inputSchema: {
      _id: z.string().describe("Agent ID (lowercase with hyphens, e.g. 'my-agent')"),
      name: z.string().describe("Display name for the agent"),
      roles: z
        .array(z.string())
        .min(1)
        .describe(
          'What this agent does — one or more concise role labels (e.g. ["VP Engineering"], or ["Production Support", "Bilingual liaison (Mandarin/English)"]). Surfaced via team_lookup_agent and team summary in system prompts.',
        ),
      aliases: z
        .array(z.string())
        .optional()
        .describe('Optional short names / nicknames for name-based routing (e.g. ["Sam"] for "Samantha").'),
      model: z.string().describe("Model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),
      homeBase: z
        .string()
        .describe(
          "Primary Slack channel for scheduler delivery and default identity (e.g. 'agent-<id>'). The channel must exist in Slack.",
        ),
      soul: z
        .string()
        .optional()
        .describe("Personality / voice / character definition (5-15 lines). Shapes how the agent talks."),
      systemPrompt: z
        .string()
        .optional()
        .describe(
          "Role definition and guardrails. Concise. Instance-specific flavor — archetype framing layers underneath.",
        ),
      archetype: z
        .string()
        .optional()
        .describe("Discipline id from list_archetypes (e.g. 'software-engineer'). Omit for plain unstructured agents."),
      title: z
        .string()
        .optional()
        .describe("Customer-facing title (e.g. 'VP Engineering'). Typically paired with archetype."),
      fields: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Additional fields (channels, passiveChannels, schedule, coreServers override, delegateServers, plugins, autonomy, archetypeConfig, budgetUsd, maxTurns, etc.)",
        ),
    },
  },
  async ({ _id, name, roles, aliases, model, homeBase, soul, systemPrompt, archetype, title, fields }) => {
    const existing = await agentDefs.findOne({ _id: _id as any });
    if (existing) {
      return {
        content: [{ type: "text", text: `Agent '${_id}' already exists. Use agent_update to modify it.` }],
        isError: true,
      };
    }

    if (!homeBase || homeBase.trim() === "") {
      return {
        content: [
          {
            type: "text",
            text: `Missing required field: homeBase (primary channel for scheduled delivery, e.g. 'agent-${_id}').`,
          },
        ],
        isError: true,
      };
    }

    if (archetype !== undefined && !getArchetype(archetype)) {
      const known = listArchetypeIds().join(", ") || "(none registered)";
      return {
        content: [{ type: "text", text: `Unknown archetype: "${archetype}". Known: ${known}.` }],
        isError: true,
      };
    }

    const f = fields ?? {};
    const now = new Date();
    const doc: AgentDefinition = {
      _id,
      name,
      aliases: aliases ?? (f.aliases as string[] | undefined),
      roles,
      model,
      icon: (f.icon as string) ?? AGENT_DEFINITION_DEFAULTS.icon,
      channels: (f.channels as string[]) ?? [],
      homeBase: homeBase.trim(),
      passiveChannels: (f.passiveChannels as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.passiveChannels],
      keywords: (f.keywords as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.keywords],
      isDefault: (f.isDefault as boolean) ?? false,
      coreServers: (f.coreServers as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.coreServers],
      delegateServers: (f.delegateServers as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.delegateServers],
      delegatePrompts: (f.delegatePrompts as Record<string, string>) ?? {
        ...AGENT_DEFINITION_DEFAULTS.delegatePrompts,
      },
      plugins: f.plugins as string[] | undefined,
      metadata: f.metadata as Record<string, unknown> | undefined,
      soul: soul ?? (f.soul as string) ?? "",
      systemPrompt: systemPrompt ?? (f.systemPrompt as string) ?? "",
      archetype,
      title,
      archetypeConfig: f.archetypeConfig as Record<string, unknown> | undefined,
      schedule: (f.schedule as Array<{ cron: string; task: string }>) ?? [...AGENT_DEFINITION_DEFAULTS.schedule],
      subscribe: f.subscribe as string[] | undefined,
      budgetUsd: (f.budgetUsd as number) ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
      maxTurns: (f.maxTurns as number) ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
      maxConcurrent: (f.maxConcurrent as number) ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
      timeoutMs: (f.timeoutMs as number) ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
      disabled: (f.disabled as boolean) ?? false,
      slackBot: f.slackBot as string | undefined,
      autonomy: f.autonomy as Partial<AutonomyFlags> | undefined,
      resourceTiers: f.resourceTiers as AgentDefinition["resourceTiers"],
      betas: f.betas as string[] | undefined,
      catches: f.catches as string[] | undefined,
      createdAt: now,
      updatedAt: now,
      updatedBy: AGENT_ID,
    };

    await agentDefs.insertOne(doc as any);
    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${_id}' (${name}) created with model ${model}${archetype ? ` — archetype ${archetype}` : ""}. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_update
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_update",
  {
    title: "Update Agent",
    description:
      "Update fields on an existing agent definition. Saves a version snapshot before mutation. Cannot change _id. Creation-boundary fields (homeBase, archetype, title, soul, systemPrompt) are promoted to top-level for discoverability; everything else goes in `fields`.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to update"),
      homeBase: z.string().optional().describe("Primary Slack channel for scheduler delivery."),
      soul: z.string().optional().describe("Personality / voice / character definition."),
      systemPrompt: z.string().optional().describe("Role definition and guardrails."),
      archetype: z
        .string()
        .optional()
        .describe(
          "Discipline id from list_archetypes. Pass null-style empty string to clear (note: fields.archetype: null also works via the fields bag).",
        ),
      title: z.string().optional().describe("Customer-facing title."),
      roles: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Replace the agent's roles array. Pass the full new array, not a delta. Cannot be empty."),
      aliases: z
        .array(z.string())
        .optional()
        .describe("Replace the agent's aliases array (pass [] to clear). Optional."),
      fields: z
        .record(z.string(), z.any())
        .optional()
        .describe("Additional fields (channels, schedule, autonomy, archetypeConfig, budgetUsd, model, etc.)"),
    },
  },
  async ({ agent_id, homeBase, soul, systemPrompt, archetype, title, roles, aliases, fields }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    const merged: Record<string, unknown> = { ...(fields ?? {}) };
    if (homeBase !== undefined) merged.homeBase = homeBase;
    if (soul !== undefined) merged.soul = soul;
    if (systemPrompt !== undefined) merged.systemPrompt = systemPrompt;
    if (archetype !== undefined) merged.archetype = archetype;
    if (title !== undefined) merged.title = title;
    if (roles !== undefined) merged.roles = roles;
    if (aliases !== undefined) merged.aliases = aliases;

    if ("_id" in merged) {
      return {
        content: [{ type: "text", text: "Cannot change _id. Create a new agent instead." }],
        isError: true,
      };
    }
    delete merged.createdAt;

    if (typeof merged.archetype === "string" && merged.archetype.length > 0 && !getArchetype(merged.archetype)) {
      const known = listArchetypeIds().join(", ") || "(none registered)";
      return {
        content: [{ type: "text", text: `Unknown archetype: "${merged.archetype}". Known: ${known}.` }],
        isError: true,
      };
    }

    const changedFields = Object.keys(merged);
    if (changedFields.length === 0) {
      return {
        content: [{ type: "text", text: `No fields to update for '${agent_id}'.` }],
        isError: true,
      };
    }
    await saveVersion(agent_id, changedFields);

    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { ...merged, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' updated: ${changedFields.join(", ")}. Version saved. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_delete
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_delete",
  {
    title: "Delete Agent",
    description: "Delete an agent definition. Saves a version snapshot before deletion. Requires confirm=true.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to delete"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
  },
  async ({ agent_id, confirm }) => {
    if (!confirm) {
      return {
        content: [{ type: "text", text: "Deletion not confirmed. Set confirm=true to proceed." }],
        isError: true,
      };
    }

    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    await saveVersion(agent_id, ["DELETED"]);
    await agentDefs.deleteOne({ _id: agent_id as any });
    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' deleted. Version snapshot saved. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_enable
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_enable",
  {
    title: "Enable Agent",
    description: "Bring a disabled agent back online (sets disabled=false).",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to enable"),
    },
  },
  async ({ agent_id }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    await saveVersion(agent_id, ["disabled"]);
    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { disabled: false, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );
    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' enabled. Version saved. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_disable
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_disable",
  {
    title: "Disable Agent",
    description:
      "Take an agent offline (sets disabled=true). The agent stops receiving messages and active sessions are aborted.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to disable"),
    },
  },
  async ({ agent_id }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    await saveVersion(agent_id, ["disabled"]);
    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { disabled: true, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );
    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' disabled. Version saved. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_history
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_history",
  {
    title: "Agent Version History",
    description: "List version history for an agent definition, sorted newest first.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      limit: z.number().optional().describe("Max entries to return (default 10)"),
    },
  },
  async ({ agent_id, limit }) => {
    const maxEntries = limit ?? 10;
    const versions = await agentVersions
      .find({ agentId: agent_id })
      .sort({ createdAt: -1 })
      .limit(maxEntries)
      .toArray();

    if (versions.length === 0) {
      return { content: [{ type: "text", text: `No version history for '${agent_id}'.` }] };
    }

    const lines = versions.map((v, i) => {
      const date = v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt);
      const fields = v.changedFields.join(", ");
      const by = v.snapshot?.updatedBy ? ` (by ${v.snapshot.updatedBy})` : "";
      return `[${i}] ${date} — changed: ${fields}${by}`;
    });

    return {
      content: [
        { type: "text", text: `Version history for '${agent_id}' (${versions.length} entries):\n${lines.join("\n")}` },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_rollback
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_rollback",
  {
    title: "Rollback Agent",
    description:
      "Rollback an agent definition to a previous version. Saves current state first, then replaces with the snapshot. Use agent_history to see available versions.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to rollback"),
      version_index: z.number().describe("Version index from agent_history (0 = most recent version)"),
    },
  },
  async ({ agent_id, version_index }) => {
    if (version_index < 0 || !Number.isInteger(version_index)) {
      return {
        content: [{ type: "text", text: "version_index must be a non-negative integer." }],
        isError: true,
      };
    }

    const versions = await agentVersions
      .find({ agentId: agent_id })
      .sort({ createdAt: -1 })
      .limit(version_index + 1)
      .toArray();

    if (versions.length <= version_index) {
      return {
        content: [
          {
            type: "text",
            text: `Version index ${version_index} not found for '${agent_id}'. Only ${versions.length} versions available.`,
          },
        ],
        isError: true,
      };
    }

    const target = versions[version_index];

    // Verify the agent still exists before rollback
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found — cannot rollback a deleted agent.` }],
        isError: true,
      };
    }

    // Save current state before rollback
    await saveVersion(agent_id, ["ROLLBACK"]);

    // Replace with snapshot
    const { _id, ...snapshotFields } = target.snapshot;
    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { ...snapshotFields, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    triggerReload();

    const date = target.createdAt instanceof Date ? target.createdAt.toISOString() : String(target.createdAt);
    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' rolled back to version from ${date}. Current state saved first. Change will take effect within 30 seconds.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// instance_capabilities
// ---------------------------------------------------------------------------

const FALLBACK_CAPABILITIES: InstanceCapabilities = {
  instanceId: "unknown",
  servers: { configured: [], unconfigured: [], broken: [] },
};

let instanceCapabilities: InstanceCapabilities = FALLBACK_CAPABILITIES;
try {
  if (process.env.INSTANCE_CAPABILITIES) {
    const parsed = JSON.parse(process.env.INSTANCE_CAPABILITIES);
    if (parsed && typeof parsed === "object" && "servers" in parsed) {
      instanceCapabilities = parsed as InstanceCapabilities;
    }
  }
} catch (err) {
  console.error("[hive-admin] Failed to parse INSTANCE_CAPABILITIES, using fallback:", err);
}

server.registerTool(
  "instance_capabilities",
  {
    title: "Instance Capabilities",
    description:
      "Report what servers, integrations, and channels are configured on this Hive instance. Use this before creating agents to check what capabilities are available.",
    inputSchema: {},
  },
  async () => {
    // Fetch channel list from DB (projection: only channels fields)
    const agents = await agentDefs.find({}, { projection: { channels: 1, passiveChannels: 1 } }).toArray();
    const allChannels = new Set<string>();
    for (const a of agents) {
      for (const ch of a.channels ?? []) allChannels.add(ch);
      for (const ch of a.passiveChannels ?? []) allChannels.add(ch);
    }

    // Older engine versions may have shipped INSTANCE_CAPABILITIES without a
    // `broken` field. Default to an empty list so legacy payloads don't crash.
    const brokenServers = instanceCapabilities.servers.broken ?? [];

    const lines: string[] = [
      `Instance: ${instanceCapabilities.instanceId}`,
      `Agents: ${agents.length}`,
      "",
      "## Configured Servers",
      ...instanceCapabilities.servers.configured.map((s: string) => `  ✓ ${s}`),
      "",
      "## Unconfigured Servers (missing credentials)",
      ...(instanceCapabilities.servers.unconfigured.length > 0
        ? instanceCapabilities.servers.unconfigured.map((s: string) => `  ✗ ${s}`)
        : ["  (none — all servers configured)"]),
      "",
      "## Broken Servers (declared but not runnable)",
      ...(brokenServers.length > 0 ? brokenServers.map((s) => `  ⚠ ${s.name} — ${s.reason}`) : ["  (none)"]),
      "",
      "## Active Channels",
      ...(allChannels.size > 0 ? [...allChannels].sort().map((ch) => `  #${ch}`) : ["  (no channels assigned)"]),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// list_archetypes
// ---------------------------------------------------------------------------

server.registerTool(
  "list_archetypes",
  {
    title: "List Archetypes",
    description:
      "List registered agent archetypes with self-descriptions. Use this to decide whether an agent you are creating is a discipline-bound archetype (e.g. software-engineer) or a plain unstructured agent.",
    inputSchema: {},
  },
  async () => {
    const ids = listArchetypeIds();
    const catalog = ids
      .map((id) => {
        const def = getArchetype(id);
        if (!def) return null;
        return {
          id: def.id,
          description: def.description ?? null,
          whenToUse: def.whenToUse ?? null,
          configSchema: def.configSchema ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return {
      content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// verify_path
// ---------------------------------------------------------------------------

server.registerTool(
  "verify_path",
  {
    title: "Verify Filesystem Path",
    description:
      "Check that an absolute filesystem path exists and is a directory. Used by the agent-builder skill to validate archetype-config paths (e.g. software-engineer `workshop`) before agent creation, so the caller catches typos at creation time instead of at agent-load time.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "Absolute filesystem path to verify. Must start with '/'. Tilde (~) is not expanded — callers must pre-expand.",
        ),
    },
  },
  async ({ path }) => {
    if (typeof path !== "string" || path.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ exists: false, isDirectory: false, error: "path must be a non-empty string" }),
          },
        ],
        isError: true,
      };
    }
    if (!isAbsolute(path)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              exists: false,
              isDirectory: false,
              error: `path must be absolute (start with '/'); got "${path}"`,
            }),
          },
        ],
        isError: true,
      };
    }
    const resolved = resolvePath(path);
    try {
      const st = statSync(resolved);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ exists: true, isDirectory: st.isDirectory(), resolved }),
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ exists: false, isDirectory: false, resolved }),
          },
        ],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Cleanup + transport
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
