import type { HookCallbackMatcher, Options as SdkQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types/agent-config.js";
import type { WorkItemContext } from "../agents/agent-runner.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("archetypes");

/** Memory scope metadata returned by an archetype. */
export interface MemoryScope {
  /** Scope identifier: "self" | "workshop" | `workspace:<name>` | archetype-defined */
  id: string;
  /** Backing store. "mongo" for AGENT_ID-scoped MongoDB (legacy self), "filesystem" for auto-memory. */
  backing: "mongo" | "filesystem";
  /** Absolute filesystem directory for `backing: "filesystem"`. Ignored otherwise. */
  dir?: string;
}

export interface ArchetypePromptContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

export interface ArchetypeHookContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

export interface ArchetypeMemoryContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
}

export interface ArchetypeSessionContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

/** Shape describing one archetypeConfig field for skill discovery. */
export interface ArchetypeConfigFieldSchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  description: string;
}

/** Self-description surfaced by list_archetypes. All fields optional for back-compat. */
export interface ArchetypeDescription {
  description?: string;
  whenToUse?: string;
  configSchema?: Record<string, ArchetypeConfigFieldSchema>;
}

export interface ArchetypeDefinition<Config = unknown> extends ArchetypeDescription {
  /** Stable discipline id, e.g. "software-engineer". */
  id: string;

  /** Validate the raw archetypeConfig blob. Throws on invalid. Returns typed config. */
  validateConfig(config: unknown): Config;

  /** Return the system-prompt card (rendered once per session). */
  systemPromptCard(ctx: ArchetypePromptContext<Config>): string;

  /** Return PreToolUse hook matchers. Merged into agent-runner's hook set. */
  preToolUseHooks(ctx: ArchetypeHookContext<Config>): HookCallbackMatcher[];

  /** Declare the memory scopes this archetype exposes to the memory MCP server. */
  memoryScopes(ctx: ArchetypeMemoryContext<Config>): MemoryScope[];

  /** Return partial SDK query options merged into agent-runner's query() call. */
  sessionOptions(ctx: ArchetypeSessionContext<Config>): Partial<SdkQueryOptions>;
}

const registry = new Map<string, ArchetypeDefinition>();

export function registerArchetype<C>(def: ArchetypeDefinition<C>): void {
  if (registry.has(def.id)) {
    // Idempotent re-registration (module reload) is allowed but logged.
    log.warn("Archetype already registered — overwriting", { id: def.id });
  }
  registry.set(def.id, def as ArchetypeDefinition);
  log.info("Registered archetype", { id: def.id });
}

export function getArchetype(id: string): ArchetypeDefinition | undefined {
  return registry.get(id);
}

export function listArchetypeIds(): string[] {
  return Array.from(registry.keys());
}

/** Test-only helper. Do not call from production code. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
