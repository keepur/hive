/**
 * Admin MCP Server — agent definition CRUD + version history.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Tool handlers close over
 * the shared engine Db and the precomputed instance-capabilities JSON. The
 * bundled-server stdio shim at the bottom is preserved for the publish-ready
 * artifact.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";
import { statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";
import type { AutonomyFlags } from "../agents/autonomy.js";
import type { InstanceCapabilities } from "../tools/instance-capabilities.js";
import { getArchetype, listArchetypeIds } from "../archetypes/registry.js";
import { IN_PROCESS_PORTED_SERVERS } from "../agents/in-process-servers.js";

/**
 * KPR-184: returns an error message if `delegateServers` references any
 * KPR-122-ported in-process server, or null if the list is clean (or
 * undefined / empty). The 10 ported servers can't be delegated because the
 * SDK's `AgentDefinition.mcpServers` type doesn't accept in-process configs.
 */
function checkDelegateServers(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const invalid = value.filter((s): s is string => typeof s === "string" && IN_PROCESS_PORTED_SERVERS.has(s));
  if (invalid.length === 0) return null;
  return (
    `delegateServers cannot include in-process-ported servers: ${invalid.join(", ")}. ` +
    `These are core-only post-KPR-122 (the SDK's AgentDefinition type doesn't accept ` +
    `in-process configs). Move to coreServers or remove. Ported servers: ` +
    `${[...IN_PROCESS_PORTED_SERVERS].join(", ")}.`
  );
}

/**
 * KPR-221: returns an error message if `delegateServers` references any
 * context-dependent MCP server, or null if the list is clean (or undefined
 * / empty). Context-dependent servers embed channel/thread env vars and
 * cannot work as sub-agents — sub-agents spawn without that context. The
 * registry hard-rejects on load (defense in depth); the admin tool rejects
 * at write time so operators see the error immediately, following the
 * same precedent as KPR-184.
 */
const CONTEXT_DEPENDENT_SERVERS = new Set<string>([
  "callback",
  "background",
  "code-task",
  "recall",
  "structured-memory",
  "memory",
]);

function checkDelegateContextDependent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const invalid = value.filter((s): s is string => typeof s === "string" && CONTEXT_DEPENDENT_SERVERS.has(s));
  if (invalid.length === 0) return null;
  return (
    `delegateServers cannot include context-dependent servers: ${invalid.join(", ")}. ` +
    `These embed channel/thread env vars and won't work as sub-agents (sub-agents spawn ` +
    `without that context). Move to coreServers or remove. Context-dependent: ` +
    `${[...CONTEXT_DEPENDENT_SERVERS].join(", ")}.`
  );
}

const FALLBACK_CAPABILITIES: InstanceCapabilities = {
  instanceId: "unknown",
  servers: { configured: [], unconfigured: [], broken: [] },
};

export interface AdminToolDeps {
  db: Db;
  agentId: string;
  /**
   * JSON-encoded `InstanceCapabilities`. Constructor-stable on AgentRunner —
   * derived from `buildInstanceCapabilities(plugins)` once per runner.
   */
  instanceCapabilitiesJson: string;
}

export function buildAdminTools(deps: AdminToolDeps) {
  const { db, agentId, instanceCapabilitiesJson } = deps;
  const agentDefs = db.collection<AgentDefinition>("agent_definitions");
  const agentVersions = db.collection<AgentDefinitionVersion>("agent_definition_versions");

  // Lazy index creation — first call to a handler triggers it. Avoids hard
  // requirements on Mongo at module import (test harnesses, dry runs).
  let indexInit: Promise<void> | null = null;
  function ensureIndexes(): Promise<void> {
    if (!indexInit) {
      indexInit = agentVersions
        .createIndex({ agentId: 1, createdAt: -1 })
        .then(() => undefined)
        .catch(() => undefined);
    }
    return indexInit;
  }

  let instanceCapabilities: InstanceCapabilities = FALLBACK_CAPABILITIES;
  try {
    const parsed = JSON.parse(instanceCapabilitiesJson);
    if (parsed && typeof parsed === "object" && "servers" in parsed) {
      instanceCapabilities = parsed as InstanceCapabilities;
    }
  } catch {
    // keep fallback
  }

  async function saveVersion(targetAgentId: string, changedFields: string[]): Promise<void> {
    const current = await agentDefs.findOne({ _id: targetAgentId as never });
    if (!current) return;
    await agentVersions.insertOne({
      agentId: targetAgentId,
      snapshot: current as unknown as AgentDefinition,
      changedFields,
      createdAt: new Date(),
    });
  }

  return [
    tool(
      "agent_list",
      "List all agent definitions with summary info (id, name, model, channels, disabled status).",
      {},
      async () => {
        try {
          await ensureIndexes();
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
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_list error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_get",
      "Fetch full agent definition (admin). Use ONLY for editing or inspecting version history; for routine teammate info (roles, channel, model) prefer `team_lookup_agent`.",
      {
        agent_id: z.string().describe("The agent ID (e.g. 'rae', 'jasper')"),
      },
      async ({ agent_id }) => {
        try {
          const doc = await agentDefs.findOne({ _id: agent_id as never });
          if (!doc) {
            return { isError: true, content: [{ type: "text", text: `Agent '${agent_id}' not found.` }] };
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
          // KPR-220 Phase 4: spawnBudget is the live field; maxConcurrent is
          // retained as a deprecated fallback for legacy docs.
          {
            const resolved = doc.spawnBudget ?? doc.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent;
            const source =
              doc.spawnBudget != null
                ? "spawnBudget"
                : doc.maxConcurrent != null
                  ? "maxConcurrent (deprecated)"
                  : "default";
            lines.push(`Spawn Budget: ${resolved} (source: ${source})`);
          }
          lines.push(`Timeout: ${doc.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs}ms`);
          lines.push(`Disabled: ${doc.disabled ?? false}`);
          if (doc.slackBot) lines.push(`Slack Bot: ${doc.slackBot}`);
          lines.push(`\n--- Soul ---\n${doc.soul ?? "(not set)"}`);
          lines.push(`\n--- System Prompt ---\n${doc.systemPrompt ?? "(not set)"}`);
          const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? "");
          lines.push(`\nUpdated: ${updatedAt} by ${doc.updatedBy ?? "unknown"}`);

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_get error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_create",
      'Create a new agent definition. Required: _id, name, model, homeBase, roles. Roles is an array of concise role labels (e.g. ["VP Engineering"] or ["Production Support", "Bilingual liaison"]) — used by team_lookup_agent and the team summary in agent system prompts. Archetype is optional — pass it when the role is a discipline with shared infrastructure (see list_archetypes). Soul/systemPrompt shape the agent\'s voice and role; if omitted they default to empty strings. Additional tuning (channels, schedule, budget, autonomy, archetypeConfig, etc.) goes in `fields`.',
      {
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
          .describe(
            "Discipline id from list_archetypes (e.g. 'software-engineer'). Omit for plain unstructured agents.",
          ),
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
      async ({ _id, name, roles, aliases, model, homeBase, soul, systemPrompt, archetype, title, fields }) => {
        try {
          const existing = await agentDefs.findOne({ _id: _id as never });
          if (existing) {
            return {
              isError: true,
              content: [{ type: "text", text: `Agent '${_id}' already exists. Use agent_update to modify it.` }],
            };
          }

          if (!homeBase || homeBase.trim() === "") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Missing required field: homeBase (primary channel for scheduled delivery, e.g. 'agent-${_id}').`,
                },
              ],
            };
          }

          if (archetype !== undefined && !getArchetype(archetype)) {
            const known = listArchetypeIds().join(", ") || "(none registered)";
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown archetype: "${archetype}". Known: ${known}.` }],
            };
          }

          const f = fields ?? {};

          // KPR-184: reject in-process-ported MCPs in delegateServers.
          const delegateError = checkDelegateServers(f.delegateServers);
          if (delegateError) {
            return { isError: true, content: [{ type: "text", text: delegateError }] };
          }
          // KPR-221: reject context-dependent servers in delegateServers.
          const contextError = checkDelegateContextDependent(f.delegateServers);
          if (contextError) {
            return { isError: true, content: [{ type: "text", text: contextError }] };
          }
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
            // KPR-220 Phase 13: writes canonicalize to spawnBudget. New docs
            // do NOT carry maxConcurrent. Legacy caller supplying maxConcurrent
            // (in fields bag) is translated. Reads use the spawnBudgetFor
            // fallback chain to keep existing docs working unchanged.
            spawnBudget:
              (f.spawnBudget as number | undefined) ??
              (f.maxConcurrent as number | undefined) ??
              AGENT_DEFINITION_DEFAULTS.spawnBudget,
            timeoutMs: (f.timeoutMs as number) ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
            disabled: (f.disabled as boolean) ?? false,
            slackBot: f.slackBot as string | undefined,
            autonomy: f.autonomy as Partial<AutonomyFlags> | undefined,
            resourceTiers: f.resourceTiers as AgentDefinition["resourceTiers"],
            betas: f.betas as string[] | undefined,
            catches: f.catches as string[] | undefined,
            createdAt: now,
            updatedAt: now,
            updatedBy: agentId,
          };

          await agentDefs.insertOne(doc as never);

          return {
            content: [
              {
                type: "text",
                text: `Agent '${_id}' (${name}) created with model ${model}${archetype ? ` — archetype ${archetype}` : ""}. Change will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_create error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_update",
      "Update fields on an existing agent definition. Saves a version snapshot before mutation. Cannot change _id. Creation-boundary fields (homeBase, archetype, title, soul, systemPrompt) are promoted to top-level for discoverability; everything else goes in `fields`.",
      {
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
      async ({ agent_id, homeBase, soul, systemPrompt, archetype, title, roles, aliases, fields }) => {
        try {
          const existing = await agentDefs.findOne({ _id: agent_id as never });
          if (!existing) {
            return { isError: true, content: [{ type: "text", text: `Agent '${agent_id}' not found.` }] };
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
              isError: true,
              content: [{ type: "text", text: "Cannot change _id. Create a new agent instead." }],
            };
          }
          delete merged.createdAt;

          if (typeof merged.archetype === "string" && merged.archetype.length > 0 && !getArchetype(merged.archetype)) {
            const known = listArchetypeIds().join(", ") || "(none registered)";
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown archetype: "${merged.archetype}". Known: ${known}.` }],
            };
          }

          // KPR-184: reject in-process-ported MCPs in delegateServers.
          if ("delegateServers" in merged) {
            const delegateError = checkDelegateServers(merged.delegateServers);
            if (delegateError) {
              return { isError: true, content: [{ type: "text", text: delegateError }] };
            }
            // KPR-221: reject context-dependent servers in delegateServers.
            const contextError = checkDelegateContextDependent(merged.delegateServers);
            if (contextError) {
              return { isError: true, content: [{ type: "text", text: contextError }] };
            }
          }

          // KPR-220 Phase 13: canonicalize legacy maxConcurrent → spawnBudget
          // before write. Existing docs keep their maxConcurrent until the
          // next explicit update touches the field; reads use spawnBudgetFor.
          if (merged.maxConcurrent !== undefined && merged.spawnBudget === undefined) {
            merged.spawnBudget = merged.maxConcurrent;
          }
          delete merged.maxConcurrent;

          const changedFields = Object.keys(merged);
          if (changedFields.length === 0) {
            return {
              isError: true,
              content: [{ type: "text", text: `No fields to update for '${agent_id}'.` }],
            };
          }
          await saveVersion(agent_id, changedFields);

          await agentDefs.updateOne(
            { _id: agent_id as never },
            { $set: { ...merged, updatedAt: new Date(), updatedBy: agentId } },
          );

          return {
            content: [
              {
                type: "text",
                text: `Agent '${agent_id}' updated: ${changedFields.join(", ")}. Version saved. Change will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_update error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_delete",
      "Delete an agent definition. Saves a version snapshot before deletion. Requires confirm=true.",
      {
        agent_id: z.string().describe("The agent ID to delete"),
        confirm: z.boolean().describe("Must be true to confirm deletion"),
      },
      async ({ agent_id, confirm }) => {
        try {
          if (!confirm) {
            return {
              isError: true,
              content: [{ type: "text", text: "Deletion not confirmed. Set confirm=true to proceed." }],
            };
          }

          const existing = await agentDefs.findOne({ _id: agent_id as never });
          if (!existing) {
            return { isError: true, content: [{ type: "text", text: `Agent '${agent_id}' not found.` }] };
          }

          await saveVersion(agent_id, ["DELETED"]);
          await agentDefs.deleteOne({ _id: agent_id as never });

          return {
            content: [
              {
                type: "text",
                text: `Agent '${agent_id}' deleted. Version snapshot saved. Change will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_delete error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_enable",
      "Bring a disabled agent back online (sets disabled=false).",
      {
        agent_id: z.string().describe("The agent ID to enable"),
      },
      async ({ agent_id }) => {
        try {
          const existing = await agentDefs.findOne({ _id: agent_id as never });
          if (!existing) {
            return { isError: true, content: [{ type: "text", text: `Agent '${agent_id}' not found.` }] };
          }

          await saveVersion(agent_id, ["disabled"]);
          await agentDefs.updateOne(
            { _id: agent_id as never },
            { $set: { disabled: false, updatedAt: new Date(), updatedBy: agentId } },
          );

          return {
            content: [
              {
                type: "text",
                text: `Agent '${agent_id}' enabled. Version saved. Change will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_enable error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_disable",
      "Take an agent offline (sets disabled=true). The agent stops receiving messages and active sessions are aborted.",
      {
        agent_id: z.string().describe("The agent ID to disable"),
      },
      async ({ agent_id }) => {
        try {
          const existing = await agentDefs.findOne({ _id: agent_id as never });
          if (!existing) {
            return { isError: true, content: [{ type: "text", text: `Agent '${agent_id}' not found.` }] };
          }

          await saveVersion(agent_id, ["disabled"]);
          await agentDefs.updateOne(
            { _id: agent_id as never },
            { $set: { disabled: true, updatedAt: new Date(), updatedBy: agentId } },
          );

          return {
            content: [
              {
                type: "text",
                text: `Agent '${agent_id}' disabled. Version saved. Change will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_disable error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_history",
      "List version history for an agent definition, sorted newest first.",
      {
        agent_id: z.string().describe("The agent ID"),
        limit: z.number().optional().describe("Max entries to return (default 10)"),
      },
      async ({ agent_id, limit }) => {
        try {
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
              {
                type: "text",
                text: `Version history for '${agent_id}' (${versions.length} entries):\n${lines.join("\n")}`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_history error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "agent_rollback",
      "Rollback an agent definition to a previous version. Saves current state first, then replaces with the snapshot. Use agent_history to see available versions.",
      {
        agent_id: z.string().describe("The agent ID to rollback"),
        version_index: z.number().describe("Version index from agent_history (0 = most recent version)"),
      },
      async ({ agent_id, version_index }) => {
        try {
          if (version_index < 0 || !Number.isInteger(version_index)) {
            return {
              isError: true,
              content: [{ type: "text", text: "version_index must be a non-negative integer." }],
            };
          }

          const versions = await agentVersions
            .find({ agentId: agent_id })
            .sort({ createdAt: -1 })
            .limit(version_index + 1)
            .toArray();

          if (versions.length <= version_index) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Version index ${version_index} not found for '${agent_id}'. Only ${versions.length} versions available.`,
                },
              ],
            };
          }

          const target = versions[version_index]!;

          const existing = await agentDefs.findOne({ _id: agent_id as never });
          if (!existing) {
            return {
              isError: true,
              content: [{ type: "text", text: `Agent '${agent_id}' not found — cannot rollback a deleted agent.` }],
            };
          }

          await saveVersion(agent_id, ["ROLLBACK"]);

          const { _id: _ignored, ...snapshotFields } = target.snapshot;
          await agentDefs.updateOne(
            { _id: agent_id as never },
            { $set: { ...snapshotFields, updatedAt: new Date(), updatedBy: agentId } },
          );

          const date = target.createdAt instanceof Date ? target.createdAt.toISOString() : String(target.createdAt);
          return {
            content: [
              {
                type: "text",
                text: `Agent '${agent_id}' rolled back to version from ${date}. Current state saved first. Change will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `agent_rollback error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "instance_capabilities",
      "Report what servers, integrations, and channels are configured on this Hive instance. Use this before creating agents to check what capabilities are available.",
      {},
      async () => {
        try {
          const agents = await agentDefs.find({}, { projection: { channels: 1, passiveChannels: 1 } }).toArray();
          const allChannels = new Set<string>();
          for (const a of agents) {
            for (const ch of a.channels ?? []) allChannels.add(ch);
            for (const ch of a.passiveChannels ?? []) allChannels.add(ch);
          }

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
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `instance_capabilities error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "list_archetypes",
      "List registered agent archetypes with self-descriptions. Use this to decide whether an agent you are creating is a discipline-bound archetype (e.g. software-engineer) or a plain unstructured agent.",
      {},
      async () => {
        try {
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
          return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `list_archetypes error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "verify_path",
      "Check that an absolute filesystem path exists and is a directory. Used by the agent-builder skill to validate archetype-config paths (e.g. software-engineer `workshop`) before agent creation, so the caller catches typos at creation time instead of at agent-load time.",
      {
        path: z
          .string()
          .describe(
            "Absolute filesystem path to verify. Must start with '/'. Tilde (~) is not expanded — callers must pre-expand.",
          ),
      },
      async ({ path }) => {
        if (typeof path !== "string" || path.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ exists: false, isDirectory: false, error: "path must be a non-empty string" }),
              },
            ],
          };
        }
        if (!isAbsolute(path)) {
          return {
            isError: true,
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
          };
        }
        const resolved = resolvePath(path);
        try {
          const st = statSync(resolved);
          return {
            content: [
              { type: "text", text: JSON.stringify({ exists: true, isDirectory: st.isDirectory(), resolved }) },
            ],
          };
        } catch {
          return {
            content: [{ type: "text", text: JSON.stringify({ exists: false, isDirectory: false, resolved }) }],
          };
        }
      },
    ),
  ];
}

export function createAdminMcpServer(deps: AdminToolDeps) {
  return createSdkMcpServer({
    name: "admin",
    version: "0.2.0",
    tools: buildAdminTools(deps),
  });
}
