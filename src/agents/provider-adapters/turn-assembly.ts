/**
 * KPR-347 (§D1.4): the Lane B per-spawn assembly seam. Everything a native
 * provider adapter needs beyond the per-turn request is built here,
 * asynchronously, and passed at adapter construction. KPR-348 consumes
 * toolInventory + guardrailGate; KPR-349 swapped the pilot instruction stub
 * for the shared prompt builder (runner.buildProviderPrompt) and populated
 * memory/skillIndex — this file is the single seam both edit.
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import { getArchetype } from "../../archetypes/registry.js";
import type { AgentConfig } from "../../types/agent-config.js";
import type { AgentRunner, WorkItemContext } from "../agent-runner.js";
import type { GuardrailGate, LaneBProviderId } from "./types.js";
import { buildArchetypeGuardrailGate } from "./archetype-gate.js";
import {
  partitionInventoryForProvider,
  type HiveToolInventoryEntry,
  type OmittedToolRecord,
} from "./tool-transport.js";
import { TurnAssemblyError } from "./error-classification.js";

const log = createLogger("turn-assembly");

/**
 * KPR-349 populates both of the following; shapes are deliberately minimal
 * placeholders KPR-349's spec may refine ADDITIVELY (new optional fields
 * only — downstream children pin the existing fields).
 */
export interface ProviderMemoryBundle {
  /**
   * Rendered hot-tier memory block. Single-injection rule: it is ALREADY
   * folded into `instructions` by buildProviderInstructions — this field is
   * the raw carrier for consumers that want the block alone, and must never
   * be re-injected into the prompt on top of `instructions`.
   */
  hotTierPrompt?: string;
}

export interface ProviderSkillIndexEntry {
  name: string;
  description: string;
  /** Absolute path to SKILL.md — consumed by the load_skill function tool (KPR-348/349, epic §D5). */
  path: string;
}

/**
 * Everything a Lane B adapter needs beyond the per-turn request. Built
 * asynchronously per spawn by assembleProviderTurn(); passed at adapter
 * construction. INVARIANT this design rests on: adapters are per-spawn
 * (agent-manager.ts runOneSpawnAttempt), so construction-time ≡ turn-time.
 * If adapters ever become long-lived again, this object moves into
 * AgentProviderTurnRequest — that refactor is mechanical because nothing
 * else changes shape.
 */
export interface ProviderTurnAssembly {
  /**
   * Assembled system instructions — the full Lane B prompt from the shared
   * section helpers (buildProviderInstructions via runner.buildProviderPrompt):
   * soul → archetype card → systemPrompt → constitution → team summary →
   * memory → datetime, with the tool-dependent sections (toolkit, file-tier
   * guidance, skills) gated by TOOL_EXECUTING_PROVIDERS (§D3).
   */
  instructions: string;
  /** Bridgeable subset for the route provider — already partitioned. */
  toolInventory: HiveToolInventoryEntry[];
  /** R3 honesty record: what the partition removed, for logging/telemetry/matrix. */
  omittedTools: OmittedToolRecord[];
  guardrailGate: GuardrailGate;
  memory: ProviderMemoryBundle; // {hotTierPrompt} when the agent's hot tier rendered, else {}
  skillIndex: ProviderSkillIndexEntry[]; // derived per spawn; a non-empty index lights up the bridge's load_skill
  /**
   * KPR-348 (spec §D4): the SAME in-process McpServer instances the Claude
   * lane would run (same handlers, same *ContextRef closures) — the bridge
   * connects to them over InMemoryTransport. The inventory remains the
   * single source of WHICH servers the agent gets; this record is merely
   * the carrier for HOW. Built inside the TurnAssemblyError try: a Mongo
   * fault during factory construction classifies non-provider.
   */
  inProcessServers: Record<string, McpSdkServerConfigWithInstance>;
  /** KPR-348 (spec §D5-cwd): resolved per-spawn session cwd for the builtin executor. */
  sessionCwd: string;
}

/**
 * KPR-349 (§D3): tool-honesty gate. Only providers whose adapters actually
 * execute bridged tools get tool-dependent prompt sections (toolkit,
 * file-tier guidance, skills) and the memory block's tool-instruction
 * lines. KPR-353 added codex in the same commit as its adapter's zero-tools
 * flip; KPR-352 adds gemini the same way — the set and the flip are one
 * review surface (same one-line-per-provider growth pattern as
 * SESSION_SEMANTICS). Delete-candidate once all three Lane B providers
 * execute tools.
 */
export const TOOL_EXECUTING_PROVIDERS: ReadonlySet<LaneBProviderId> = new Set(["openai", "codex"]);

/**
 * KPR-347 (§D1.5): default fail-closed guardrail gate — the mirror of the
 * buildHooks posture (agent-runner.ts). Predicate is the identical two-part
 * presence check buildHooks uses (archetypeDef && archetypeConfig):
 *  - both present → real archetype PreToolUse evaluation (KPR-348 canon 6 —
 *    a port of buildHooks' semantics; the deny-all placeholder body is gone);
 *  - otherwise → allow-all, exactly the Claude lane (no PreToolUse hooks
 *    unless both parts resolve). Registry sanitization strips unresolvable
 *    archetype ids at load time, so the mixed state is unreachable for any
 *    registry-loaded agent.
 *
 * KPR-348 (canon 6): predicate, allow-all branch, location, and export are
 * preserved; the signature gains one optional trailing param so matcher
 * production takes the turn's context, exactly as buildHooks(context) does.
 */
export function buildDefaultGuardrailGate(
  config: AgentConfig,
  workItemContext?: WorkItemContext,
): GuardrailGate {
  const archetypeDef = config.archetype ? getArchetype(config.archetype) : undefined;
  if (archetypeDef && config.archetypeConfig) {
    // KPR-348 (canon 6): real archetype PreToolUse evaluation — ports
    // buildHooks' semantics (the deny-all placeholder body is gone).
    return buildArchetypeGuardrailGate(config, archetypeDef, workItemContext);
  }
  return async () => ({ behavior: "allow" });
}

/**
 * Build the per-spawn assembly for a Lane B provider. Every throw inside —
 * inventory build, partition, gate construction — is wrapped in
 * TurnAssemblyError so classifyThrown short-circuits it to non-provider
 * (§D6): a Mongo ECONNREFUSED during assembly must never pattern-match
 * connect-fail and trip a healthy foreign provider's breaker.
 */
export async function assembleProviderTurn(input: {
  runner: AgentRunner;
  config: AgentConfig;
  provider: LaneBProviderId;
  workItemContext?: WorkItemContext;
}): Promise<ProviderTurnAssembly> {
  try {
    const inventory = input.runner.buildToolTransportInventory(input.workItemContext);
    const { bridgeable, omitted } = partitionInventoryForProvider(inventory, input.provider);
    // R3 honesty surface: once per spawn, names + compatibility reasons ONLY
    // (never configs). The operator's day-1 answer to "why doesn't my
    // reassigned agent have X" until the parity matrix ships (child 10).
    log.info("Lane B inventory partition", {
      agentId: input.config.id,
      provider: input.provider,
      bridgeable: bridgeable.length,
      omitted: omitted.map((o) => `${o.name}:${o.compatibility}`),
    });
    // KPR-349 (§D1/§D3): the real system prompt — shared section helpers via
    // the runner; skill derivation + memory fold-in run INSIDE this try, so
    // a Mongo blip classifies non-provider (§D9, T7).
    const toolsExecutable = TOOL_EXECUTING_PROVIDERS.has(input.provider);
    const { instructions, hotTierPrompt, skillEntries } = await input.runner.buildProviderPrompt({
      toolInventory: bridgeable,
      toolsExecutable,
    });
    const guardrailGate = buildDefaultGuardrailGate(input.config, input.workItemContext);
    // KPR-348 (§D4): *ContextRef.current is set here with the turn's context —
    // per-spawn adapters make construction-time ≡ turn-time (canon 4).
    const inProcessServers = input.runner.buildInProcessServers(input.workItemContext);
    const sessionCwd = input.runner.resolveTurnCwd(input.workItemContext);
    return {
      instructions,
      toolInventory: bridgeable,
      omittedTools: omitted,
      guardrailGate,
      memory: hotTierPrompt === undefined ? {} : { hotTierPrompt },
      skillIndex: skillEntries,
      inProcessServers,
      sessionCwd,
    };
  } catch (err) {
    throw new TurnAssemblyError(
      `Lane B turn assembly failed for agent ${input.config.id} (provider ${input.provider}): ${String(err)}`,
      { cause: err },
    );
  }
}
