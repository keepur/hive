/**
 * KPR-391 (§4.3): the Lane B provider-module contract — the construction
 * seam between the engine (agent-manager's two adapter-construction sites)
 * and a provider's adapter. DELIBERATELY SELF-CONTAINED: this interface is
 * the embryonic provider-plugin ABI (KPR-394 makes modules loadable through
 * it, gated on this contract surviving four in-tree consumers before
 * freezing), so it references only public adapter-surface types — no
 * AgentManager, registry, or dispatcher types — and `deps` is an explicit,
 * minimal, named-handle capability surface, never an
 * import-your-way-into-the-engine. The contract's transitive type closure
 * (RunResult, WorkItemContext, StreamCallback, ResourceLimits — reachable
 * via AgentProviderAdapter / ProviderTurnAssembly) stays type-only-imported
 * for now; re-homing or re-exporting those declarations is deferred to
 * KPR-394's ABI freeze (noted in the spec so it doesn't surprise).
 */
import type { AgentProviderAdapter, LaneBProviderId, ReasoningEffort } from "./types.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { TurnHistoryStore } from "../turn-history-store.js";

/**
 * Contract-owned route shape. The provider discriminant is deliberately
 * dropped — a module already knows its own provider. agent-manager's
 * ProviderModelRoute union stays module-private there; call sites project
 * `{ model, reasoningEffort }` into this shape.
 */
export interface ProviderModuleRoute {
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** Named engine handles a module may consume. */
export interface LaneBModuleDeps {
  /** Resolved per-provider config slices (appConfig.<provider>.agentModel /
   *  .apiKey) keyed by provider id — a module reads its own key only. */
  providerConfig: Partial<Record<LaneBProviderId, { agentModel?: string; apiKey?: string }>>;
  /** KPR-353 stateless-replay history store — consumed only by modules whose
   *  session strategy persists replay history, and only in primary context:
   *  the KPR-354 G4 guarantee (nested turns provably never touch
   *  provider_turn_history) is a MODULE RULE here, not a call-site omission. */
  turnHistoryStore?: TurnHistoryStore;
  /** Agent-definition id (the history-store key). The display name travels
   *  on LaneBAdapterConstructionArgs.name. */
  agentId?: string;
}

export interface LaneBAdapterConstructionArgs {
  /** Display name (primary: config.name; nested: `${config.name}:${delegate}`). */
  name: string;
  route: ProviderModuleRoute;
  assembly: ProviderTurnAssembly;
  /** primary = top-level spawn; nested = KPR-354 delegate turn. */
  context: "primary" | "nested";
  deps: LaneBModuleDeps;
}

export interface LaneBProviderModule {
  provider: LaneBProviderId;
  createAdapter(args: LaneBAdapterConstructionArgs): AgentProviderAdapter;
}
