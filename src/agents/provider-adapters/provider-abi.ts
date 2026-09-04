/**
 * KPR-394 (§4.2/§4.7): the Lane B provider-plugin ABI surface — the ONE
 * documented import point for plugin authors (`@keepur/hive/provider-abi`,
 * a types-only subpath export consumed as a devDependency; types erase at
 * build, so a plugin carries no runtime dependency on the engine) and the
 * home of the ABI version constant.
 *
 * Declarations are RE-EXPORTED from their canonical homes, not moved (this
 * discharges the KPR-391 §4.3 "re-homing deferred to KPR-394's ABI freeze"
 * note). Every name reachable from this barrel is frozen ABI under C6
 * governance: any breaking change to a re-exported contract or to a kit
 * member's behavior bumps LANE_B_PROVIDER_ABI_VERSION (exact-integer
 * handshake, §4.7 — additive, non-breaking growth does not bump; bumps are
 * themselves registered decisions).
 */
import type { LaneBTurnScaffold } from "./turn-scaffold.js";
import type { runBoundedDispatchLoop } from "./dispatch-loop.js";
import type { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";
import type { createLogger } from "../../logging/logger.js";

/**
 * §4.7: the manifest's `abi:` integer must EXACTLY equal this. Mismatch in
 * either direction ⇒ declared-broken with a reason naming both numbers.
 * Exact integer, not semver: the ABI is one frozen contract, and
 * "compatible range" semantics invite the silent-drift class the freeze
 * exists to prevent.
 *
 * ⚠ PLUGIN AUTHORS: do NOT import this constant at runtime. It is a value
 * living behind a **types-only** subpath export (`@keepur/hive/provider-abi`
 * maps to a `.d.ts` only), so `import { LANE_B_PROVIDER_ABI_VERSION }` in
 * plugin code typechecks and then throws ERR_PACKAGE_PATH_NOT_EXPORTED when
 * Node loads the module. Declare the version statically as `abi:` in
 * plugin.yaml (the engine handshake reads it from there), and read
 * `kit.abiVersion` inside `createProviderModule(kit)` if you need it at
 * runtime.
 */
export const LANE_B_PROVIDER_ABI_VERSION = 1;

/**
 * §4.2 (R1): the engine-injected provider kit, handed to
 * `createProviderModule(kit)` at activation. Runtime injection hands the
 * plugin the RUNNING engine's shared implementation layer by reference —
 * a plugin cannot `import` it (the engine package is not resolvable from
 * `<hiveHome>/plugins/node_modules/`, and a bundled private copy would
 * re-create the clone problem KPR-391 killed). Member list is the spec
 * floor — scaffold, loop, sse framing, logger — and every member is frozen
 * surface: resist growth.
 */
export interface LaneBProviderKit {
  /** === LANE_B_PROVIDER_ABI_VERSION — belt-and-braces runtime assertion. */
  abiVersion: number;
  /** Abstract per-turn lifecycle base (KPR-391) — EXTEND IT: deadline,
   *  containment, ToolBridge lifecycle, usage accounting come free.
   *  - KPR-432: `harness.request.prompt` already ends with the engine's datetime
   *    trailer for primary assemblies (`datetimeInTurnInput`); plugin adapters
   *    must not append their own. Additive optional field — no ABI version bump. */
  LaneBTurnScaffold: typeof LaneBTurnScaffold;
  /** The shared bounded tool-dispatch loop (codex/gemini/grok template). */
  runBoundedDispatchLoop: typeof runBoundedDispatchLoop;
  /** Generic SSE framing (KPR-391 §4.3 / C9) — event interpretation stays
   *  provider-side. */
  sse: {
    splitSseEvents: typeof splitSseEvents;
    parseSseEvent: typeof parseSseEvent;
    isSseDone: typeof isSseDone;
  };
  /** Engine logging with the engine's redaction conventions. */
  createLogger: typeof createLogger;
}

// ── The contract and its transitive type closure (type-only, re-exported) ──
export type {
  LaneBProviderModule,
  LaneBAdapterConstructionArgs,
  LaneBModuleDeps,
  ProviderModuleRoute,
} from "./provider-module.js";
export type {
  AgentProviderAdapter,
  AgentProviderTurnRequest,
  SessionSemantics,
  ReasoningEffort,
  GuardrailGate,
  GuardrailToolCall,
  GuardrailDecision,
} from "./types.js";
export type {
  LaneBTurnScaffold,
  LaneBTurnHarness,
  LaneBTurnTotals,
  LaneBUsageDelta,
  LaneBTurnOutcome,
  LaneBSessionPolicyState,
} from "./turn-scaffold.js";
export type {
  BoundedDispatchLoopDriver,
  DispatchRoundResult,
  DispatchLoopErrorDecision,
} from "./dispatch-loop.js";
export type { SseEvent } from "./sse.js";
export type {
  ProviderTurnAssembly,
  DelegateTurnRunner,
  ProviderMemoryBundle,
  ProviderSkillIndexEntry,
} from "./turn-assembly.js";
export type {
  HiveToolInventoryEntry,
  HiveToolSchemaEntry,
  HiveToolTransportDescriptor,
  ProviderToolCompatibility,
  HiveToolTransportKind,
  OmittedToolRecord,
} from "./tool-transport.js";
export type { RunResult, StreamCallback, WorkItemContext } from "../agent-runner.js";
export type { ResourceLimits } from "../model-router.js";
export type { TurnHistoryStore } from "../turn-history-store.js";
