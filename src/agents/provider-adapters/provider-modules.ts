/**
 * KPR-391 (§4.3): the static in-engine provider-module table. One
 * construction entry per Lane B provider, consumed by BOTH agent-manager
 * construction sites (top-level createProviderAdapter tail + the nested
 * KPR-354 delegateTurnRunner) so the two can never drift. KPR-394 makes
 * entries loadable via `hive plugin add`; until then this Record is the
 * whole registry. Model default chains moved here verbatim from the
 * pre-KPR-391 call sites.
 */
import { CodexSubscriptionAdapter } from "./codex-subscription-adapter.js";
import { GeminiInteractionsAdapter } from "./gemini-interactions-adapter.js";
import { OpenAIAgentsAdapter } from "./openai-agents-adapter.js";
import type { LaneBProviderId } from "./types.js";
import type { LaneBProviderModule } from "./provider-module.js";

const codexModule: LaneBProviderModule = {
  provider: "codex",
  createAdapter: (args) =>
    new CodexSubscriptionAdapter({
      name: args.name,
      model: args.route.model || args.deps.providerConfig?.agentModel,
      reasoningEffort: args.route.reasoningEffort,
      assembly: args.assembly,
      // KPR-353 §D3 wiring in PRIMARY context only. The KPR-354 G4
      // guarantee — nested turns provably never touch provider_turn_history —
      // is a module rule: nested constructions omit both keys entirely.
      ...(args.context === "primary"
        ? { historyStore: args.deps.turnHistoryStore, agentId: args.deps.agentId }
        : {}),
    }),
};

const openaiModule: LaneBProviderModule = {
  provider: "openai",
  createAdapter: (args) =>
    new OpenAIAgentsAdapter({
      name: args.name,
      model: args.route.model || args.deps.providerConfig?.agentModel || "gpt-5.4-mini",
      assembly: args.assembly,
      // reasoningEffort deliberately not passed: parsed-but-not-delivered
      // (docs/providers.md row — the options type has no such field).
    }),
};

const geminiModule: LaneBProviderModule = {
  provider: "gemini",
  createAdapter: (args) =>
    new GeminiInteractionsAdapter({
      name: args.name,
      // KPR-352 plan-time pin: Interactions-supported default.
      model: args.route.model || args.deps.providerConfig?.agentModel || "gemini-3.6-flash",
      apiKey: args.deps.providerConfig?.apiKey,
      reasoningEffort: args.route.reasoningEffort,
      assembly: args.assembly,
      // Nested turns are session-less by construction (§D6): no sessionId
      // flows into the nested runTurn, so the nested turn starts a fresh
      // chain and the D5.7 shaping discards the final id — nothing persists.
    }),
};

export const LANE_B_PROVIDER_MODULES: Record<LaneBProviderId, LaneBProviderModule> = {
  codex: codexModule,
  openai: openaiModule,
  gemini: geminiModule,
};
