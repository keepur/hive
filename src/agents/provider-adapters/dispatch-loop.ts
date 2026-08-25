/**
 * KPR-391 (§4.2): runBoundedDispatchLoop — the shared bounded tool-dispatch
 * loop for raw-API Lane B adapters (codex + gemini today; grok's gateway
 * next). Owns: the round budget (`resourceLimits?.maxTurns ?? 10`, with 0
 * passing through ⇒ immediate error_max_turns and NO network call — the
 * codex/gemini-identical divergence pin; openai keeps handing 0 to its SDK),
 * the four abort checkpoints at their pre-extraction placements (pre-round /
 * post-stream-consume / pre-each-tool / post-loop — each resolving through
 * the scaffold's #407 interruption resolver via the harness, which is where a
 * deadline that expired inside a non-cancellable tool call is caught),
 * totals accumulation (the one-writer fold into the scaffold accumulator),
 * final-reply semantics (every round streams to onStream; text is the final
 * round's only), SEQUENTIAL tool execution (KPR-353 pin, carried verbatim),
 * optional call-id dedup, and the restart affordance (codex §D7
 * poisoned-replay heal — once-only guard lives in the provider hook).
 *
 * NOT in the loop: wire protocol, payload shapes, session chaining values,
 * error decoration — those live in the provider round driver.
 */
import type { AgentProviderTurnRequest } from "./types.js";
import type { LaneBTurnHarness, LaneBTurnOutcome, LaneBUsageDelta } from "./turn-scaffold.js";

/** Mirrors the openai SDK default both raw-API adapters pinned (§D2/§D1). */
export const DEFAULT_MAX_ROUNDS = 10;

export interface DispatchRoundResult<TRound> {
  state: TRound;
  usage: LaneBUsageDelta;
  providerRoundId?: string;
  /** This round's assistant text — the loop applies final-reply semantics. */
  text: string;
}

export type DispatchLoopErrorDecision =
  | { action: "restart-fresh" }
  | { action: "rethrow"; error: unknown };

export interface BoundedDispatchLoopDriver<TRound, TCall> {
  request: AgentProviderTurnRequest;
  harness: LaneBTurnHarness;
  /** One provider round: POST/create + stream consume + (provider-owned)
   *  next-input bookkeeping. Throws route through onRequestError (when
   *  present) and then out to the scaffold containment frame. */
  executeRound(round: number): Promise<DispatchRoundResult<TRound>>;
  /** Function-call harvest. Empty ⇒ the loop breaks with success. */
  harvest(state: TRound): TCall[];
  /** Optional call-id dedup (codex's seenCallIds guard; gemini's harvest
   *  dedups internally and omits this). */
  callId?(call: TCall): string;
  /** Runs after a non-empty harvest, before any execution — may throw
   *  (gemini's missing-interaction-id guard). */
  beforeExecuteCalls?(state: TRound, calls: TCall[]): void;
  /** Executes ONE call and appends the provider-shaped output to the next
   *  round's input. Sequential by design. */
  executeCall(call: TCall): Promise<void>;
  /** Runs after all calls executed — chain-state shaping (gemini's
   *  chainHead/input handoff). */
  afterCalls?(state: TRound, calls: TCall[]): void;
  /** Restart affordance (codex §D7): "restart-fresh" resets the round
   *  counter to 0 (the healed turn gets its full budget) after the hook has
   *  cleared provider state; "rethrow" substitutes a decorated error;
   *  undefined ⇒ the loop rethrows the original. */
  onRequestError?(error: unknown, round: number): Promise<DispatchLoopErrorDecision | undefined>;
}

export async function runBoundedDispatchLoop<TRound, TCall>(
  driver: BoundedDispatchLoopDriver<TRound, TCall>,
): Promise<LaneBTurnOutcome> {
  const { harness } = driver;
  // `??` passes 0 through ⇒ immediate error_max_turns without a network call.
  const maxRounds = driver.request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS;
  // Assigned by every round; the only path out of the loop to the success
  // return is the harvest-empty `break`, which is after the assignment.
  let finalText: string;
  let round = 0;
  for (;;) {
    round += 1;
    if (round > maxRounds) {
      // §D2: the SDK sentinel string, already pinned non-provider
      // (error-classification.ts). Accumulated totals survive (outcome error).
      return { kind: "error", error: "error_max_turns", sessionId: harness.interruptionSessionId() };
    }
    if (harness.isAborted()) return { kind: "interrupted" }; // pre-round checkpoint

    let result: DispatchRoundResult<TRound>;
    try {
      result = await driver.executeRound(round);
    } catch (error) {
      const decision = driver.onRequestError ? await driver.onRequestError(error, round) : undefined;
      if (decision?.action === "restart-fresh") {
        round = 0; // healed turn gets its full round budget
        continue;
      }
      if (decision?.action === "rethrow") throw decision.error;
      throw error;
    }

    harness.addUsage(result.usage); // one-writer fold (§4.1)
    if (result.providerRoundId) harness.setLastProviderRoundId(result.providerRoundId);
    finalText = result.text; // final-reply semantics

    if (harness.isAborted()) return { kind: "interrupted" }; // post-stream checkpoint

    let calls = driver.harvest(result.state);
    if (driver.callId) {
      const seen = new Set<string>();
      calls = calls.filter((call) => {
        const id = driver.callId!(call);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    if (calls.length === 0) break;
    driver.beforeExecuteCalls?.(result.state, calls);

    for (const call of calls) {
      if (harness.isAborted()) return { kind: "interrupted" }; // pre-tool checkpoint
      await driver.executeCall(call);
    }
    driver.afterCalls?.(result.state, calls);
  }

  if (harness.isAborted()) return { kind: "interrupted" }; // post-loop checkpoint
  return {
    kind: "success",
    text: finalText,
    // Both raw-API adapters' success formula: last provider round id, else
    // the per-provider fallback (codex fabricated / gemini "").
    sessionId: harness.lastProviderRoundId() ?? harness.fallbackSessionId,
  };
}
