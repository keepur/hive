import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";

const log = createLogger("model-router");

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ResourceLimits {
  timeoutMs: number;
  maxTurns: number;
  budgetUsd: number;
}

/** Per-agent override map — only specified fields override the tier default */
export type ResourceTierOverrides = Partial<Record<ModelTier, Partial<ResourceLimits>>>;

/** Global defaults per tier — these fire when no per-agent override exists */
export const RESOURCE_TIER_DEFAULTS: Record<ModelTier, ResourceLimits> = {
  haiku:  { timeoutMs: 120_000,  maxTurns: 20,  budgetUsd: 1  },
  sonnet: { timeoutMs: 300_000,  maxTurns: 50,  budgetUsd: 5  },
  opus:   { timeoutMs: 600_000,  maxTurns: 200, budgetUsd: 50 },
};

/**
 * Resolve resource limits for a tier, applying per-agent overrides on top of global defaults.
 */
export function resolveResourceLimits(
  tier: ModelTier,
  agentOverrides?: ResourceTierOverrides,
): ResourceLimits {
  const defaults = RESOURCE_TIER_DEFAULTS[tier];
  const overrides = agentOverrides?.[tier];
  if (!overrides) return { ...defaults };
  return {
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    maxTurns: overrides.maxTurns ?? defaults.maxTurns,
    budgetUsd: overrides.budgetUsd ?? defaults.budgetUsd,
  };
}

/** Ordered from least to most capable */
const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** Map tier names to actual model IDs */
const TIER_MODELS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

/** Infer tier from a model ID string */
function modelToTier(model: string): ModelTier {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
}

const ROUTER_PROMPT = `You are a model router. Your job is to classify the complexity of a user message and decide which AI model tier should handle it.

Tiers:
- **haiku**: Greetings, simple factual questions, acknowledgments, status checks, yes/no answers, brief lookups, routine updates. Fast and cheap.
- **sonnet**: Multi-step tasks, drafting emails/messages, summarizing data, moderate analysis, tool-heavy workflows, most day-to-day business work. Balanced.
- **opus**: Complex reasoning, strategic planning, nuanced judgment calls, multi-faceted analysis, creative problem-solving, anything where getting it wrong has real consequences. Maximum intelligence.

Rules:
- When in doubt, pick sonnet — it handles most things well.
- Short messages are NOT automatically haiku — "fire the sales team" is short but definitely opus.
- Look at the TASK complexity, not the message length.
- Scheduled/cron tasks that say "execute your scheduled X task" are routine → haiku unless the task itself is complex.

Respond with ONLY a JSON object: { "tier": "haiku" | "sonnet" | "opus" }`;

function parseRouterOutput(text: string): ModelTier | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(text);
    if (parsed.tier && TIER_RANK[parsed.tier as ModelTier] !== undefined) {
      return parsed.tier as ModelTier;
    }
  } catch { /* fall through */ }

  // Try finding JSON in text
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
      if (parsed.tier && TIER_RANK[parsed.tier as ModelTier] !== undefined) {
        return parsed.tier as ModelTier;
      }
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Classify a message and return the recommended model tier.
 * The result is capped at `ceilingModel` — the agent's configured maximum.
 */
export async function routeModel(
  text: string,
  ceilingModel: string,
  resourceTierOverrides?: ResourceTierOverrides,
): Promise<ModelRouterResult> {
  const ceilingTier = modelToTier(ceilingModel);
  const routerModel = config.modelRouter.model;

  // If ceiling is already the cheapest tier, skip the call entirely
  if (ceilingTier === "haiku") {
    return { tier: "haiku", model: TIER_MODELS.haiku, costUsd: 0, durationMs: 0, resourceLimits: resolveResourceLimits("haiku", resourceTierOverrides) };
  }

  let q: Query | null = null;
  let resultText = "";
  let costUsd = 0;
  let durationMs = 0;

  const deadline = setTimeout(() => {
    if (q) {
      log.warn("Model router timed out", { timeoutMs: config.modelRouter.timeoutMs });
      q.close();
    }
  }, config.modelRouter.timeoutMs);

  try {
    q = query({
      prompt: text,
      options: {
        model: routerModel,
        systemPrompt: ROUTER_PROMPT,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        persistSession: false,
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebFetch", "WebSearch", "NotebookEdit"],
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined as unknown as string,
        },
      },
    });

    for await (const message of q) {
      const msg = message as SDKMessage;

      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              resultText = block.text;
            }
          }
        }
      }

      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        costUsd = result.total_cost_usd;
        durationMs = result.duration_ms;
        if (result.subtype === "success" && result.result) {
          resultText = result.result;
        }
      }
    }
  } catch (err) {
    log.warn("Model router query failed, defaulting to sonnet", { error: String(err) });
    const fallbackTier = TIER_RANK[ceilingTier] >= TIER_RANK.sonnet ? "sonnet" : ceilingTier;
    return { tier: fallbackTier, model: TIER_MODELS[fallbackTier], costUsd: 0, durationMs: 0, resourceLimits: resolveResourceLimits(fallbackTier, resourceTierOverrides) };
  } finally {
    clearTimeout(deadline);
    q = null;
  }

  const parsed = parseRouterOutput(resultText);
  if (!parsed) {
    log.warn("Model router parse failed, defaulting to sonnet", { rawText: resultText.slice(0, 200) });
    const fallbackTier = TIER_RANK[ceilingTier] >= TIER_RANK.sonnet ? "sonnet" : ceilingTier;
    return { tier: fallbackTier, model: TIER_MODELS[fallbackTier], costUsd: 0, durationMs: 0, resourceLimits: resolveResourceLimits(fallbackTier, resourceTierOverrides) };
  }

  // Cap at ceiling
  let finalTier = parsed;
  if (TIER_RANK[parsed] > TIER_RANK[ceilingTier]) {
    finalTier = ceilingTier;
    log.debug("Model router capped by ceiling", { requested: parsed, ceiling: ceilingTier });
  }

  log.info("Model router decision", {
    tier: finalTier,
    requested: parsed,
    ceiling: ceilingTier,
    costUsd,
    durationMs,
    textPreview: text.slice(0, 100),
  });

  return { tier: finalTier, model: TIER_MODELS[finalTier], costUsd, durationMs, resourceLimits: resolveResourceLimits(finalTier, resourceTierOverrides) };
}
