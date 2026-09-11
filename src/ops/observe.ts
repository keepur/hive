import { createLogger } from "../logging/logger.js";
import { waitingFor } from "../outage/outage-notices.js";
import { classifyToolError, type ToolErrorSignals } from "./error-tokens.js";
import { admissibleIdOrUndefined } from "./ids.js";
import { opsPublisher } from "./publisher-singleton.js";
import { familyOf } from "./publisher.js";
import { HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED, REASON_TOOL_RECOVERED } from "./reasons.js";
import type { OpsDetail } from "./types.js";

const log = createLogger("ops-observe");

export type CaptureLane = "claude" | "laneB";

export interface ToolFailureObservation {
  /** The canonical tool name — mcp__<server>__<tool> or a builtin, BEFORE any provider-side sanitization. */
  tool: string;
  error: string;
  lane: CaptureLane;
  agentId?: string;
  workItemId?: string;
  threadId?: string;
  durationMs?: number;
  signals?: ToolErrorSignals;
}

/**
 * SYNCHRONOUS, NON-THROWING, returns void (D9). It composes the input,
 * enqueues one job and returns; the turn never awaits it and never sees a
 * fault. Precisely: `enqueue()` fires `void this.drain()`, which on the FAILURE
 * path reaches its first `await` only after the registry lookup, the bounds
 * checks and the zod parse — so those three run synchronously on the turn
 * thread. `evaluateMatches` does NOT: it is accept-path step 6, after
 * `await this.resolveGeneration(...)` at step 5. (On a RECOVERY publish
 * `generation` is 0 with no await, so there the match does run synchronously
 * too.) All are pure, in-memory and microsecond-scale, which is why this is stated
 * rather than fixed with a `queueMicrotask` kick. Chosen over an
 * unawaited promise on four counts: the failure path performs two indexed
 * reads and a write, which under a storm would open unbounded concurrent
 * Mongo work from inside a turn; the drainer serializes per-family epoch
 * resolution against the open-condition map; a bounded queue has a drop
 * policy and a counter where an unawaited promise has neither; and shutdown
 * has something to drain.
 *
 * C15: every call is wrapped so no throw escapes to the tool path. The Lane B
 * site sits inside the one method whose header promise is "structurally
 * cannot throw", and the Claude-lane sites sit in hook callbacks the SDK
 * awaits mid-turn.
 */
export function observeToolFailure(obs: ToolFailureObservation): void {
  try {
    const publisher = opsPublisher();
    if (!publisher) return;

    // D6: the capture-point admissibility bound. A value that fails it is
    // OMITTED, never rejected — the check lives HERE and not in the accept
    // path so the two mechanisms stay separate and each stays honest.
    const workItemId = admissibleIdOrUndefined(obs.workItemId);
    const threadId = admissibleIdOrUndefined(obs.threadId);
    if (
      (obs.workItemId !== undefined && workItemId === undefined) ||
      (obs.threadId !== undefined && threadId === undefined)
    ) {
      publisher.countIdOmitted();
    }

    const detail: OpsDetail = {
      tool: obs.tool,
      // The error text is classified HERE and DISCARDED. Nothing derived from
      // it is stored (C13).
      errorSig: classifyToolError(obs.error, obs.signals),
      lane: obs.lane,
      ...(obs.agentId !== undefined ? { agentId: obs.agentId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(workItemId !== undefined ? { workItemId } : {}),
      ...(obs.durationMs !== undefined ? { durationMs: obs.durationMs } : {}),
    };

    publisher.enqueueFailure({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      // D7. Derived from whatever id the runtime holds — NOT from the
      // admissibility-filtered one. That bound governs storage; re-classifying
      // an honest id whose only defect is an unstorable character would buy
      // nothing against policyFor's existing client-supplied-id caveat.
      waiting: waitingFor(obs.workItemId),
      subject: { kind: "tool", id: obs.tool },
      detail,
      // D6: this producer's ENTIRE `kind` vocabulary is "workItem". `[]` when
      // the id is absent or inadmissible — the detached worker/scribe case and
      // the untrusted-id case deliberately land in the same shape. threadId is
      // NOT mirrored here: it is a filterable attribute of the condition and
      // belongs in detail, whereas evidence points at the record a responder
      // would open next.
      evidence: workItemId !== undefined ? [{ kind: "workItem", id: workItemId }] : [],
    });
  } catch (err) {
    // Never reaches the turn. Not published (D10 invariant (a)).
    log.warn("observeToolFailure threw — contained", { error: String(err) });
  }
}

/** The recovery half. Two arguments and no others — the same closed pair on both lanes. */
export function observeToolSuccess(obs: { tool: string; lane: CaptureLane }): void {
  try {
    const publisher = opsPublisher();
    if (!publisher) return;
    const family = familyOf({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      subject: { kind: "tool", id: obs.tool },
    });
    publisher.enqueueRecoveryIfOpen(family, (clears) => ({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_RECOVERED,
      // D8: a FIXED value, not a derived one. The succeeding turn is an
      // arbitrary later turn with nothing to do with the turn that failed, so
      // waitingFor would attribute a stranger's waiter to a recovery — and
      // worse, it would let an `informational` recovery be selected by a
      // subscription filtering waiting: "human-now". `nobody` is also simply
      // true: a recovery blocks no one.
      waiting: "nobody",
      subject: { kind: "tool", id: obs.tool },
      detail: { tool: obs.tool, lane: obs.lane },
      evidence: [], // always — the succeeding turn's work item is a stranger's record
      clears,
    }));
  } catch (err) {
    log.warn("observeToolSuccess threw — contained", { error: String(err) });
  }
}
