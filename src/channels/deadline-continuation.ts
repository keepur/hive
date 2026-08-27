/**
 * KPR-402: deadline-abort continuation — cap, notice templates, wrap, and
 * per-leg id derivation for the dispatcher's `maybeHandleDeadlineAbort` arm.
 *
 * Lives in src/channels/ beside its sole consumer, NOT in src/outage/: the
 * arm is deliberately not outage machinery (spec ⚠A6 — it needs no store,
 * and `outageQueue.enabled: false` does not disable it). Wording follows the
 * KPR-307 delegation style — exported constants so tests pin them; the
 * SMS/iMessage variants drop the emoji and stay short (⚠A2).
 */
import type { ChannelKind } from "../types/work-item.js";

/**
 * Chain cap (⚠A1): at most 2 in-process continuations per chain — ≤3
 * deadlines of wall clock — then the terminal notice names the manual
 * "continue" escape hatch (real: the KPR-399 session row persists either
 * way, so the user's next message resumes the partial work with zero engine
 * help). Exported constant, no config knob (simplicity posture — no
 * preemptive levers).
 */
export const MAX_DEADLINE_CONTINUATIONS = 2;

export const DEADLINE_NOTICE_DEFAULT =
  "⏳ That's taking longer than my per-turn time limit — I've saved my progress and I'm picking up where I left off.";
export const DEADLINE_NOTICE_SMS =
  "Still working on your request — it needs more time than one pass allows. I'm continuing now.";
export const DEADLINE_TERMINAL_NOTICE_DEFAULT =
  "⏳ I ran out of time on this several times over. I've kept all my partial work — say \"continue\" and I'll pick it up again.";
export const DEADLINE_TERMINAL_NOTICE_SMS =
  'I couldn\'t finish your request in the time allowed. Reply "continue" to have me keep going.';
export const DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT =
  "⚠️ I couldn't get started on that within my time limit — please send it again.";
export const DEADLINE_ZERO_PROGRESS_NOTICE_SMS = "Your request timed out before I could start. Please re-send it.";

export function deadlineNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? DEADLINE_NOTICE_SMS : DEADLINE_NOTICE_DEFAULT;
}

export function deadlineTerminalNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? DEADLINE_TERMINAL_NOTICE_SMS : DEADLINE_TERMINAL_NOTICE_DEFAULT;
}

export function deadlineZeroProgressNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage"
    ? DEADLINE_ZERO_PROGRESS_NOTICE_SMS
    : DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT;
}

/**
 * The continuation wrap (spec §Design.4, Edge-12 resolution). Deterministic —
 * no timestamps. Safe under resume AND fresh: D26 makes resume the normal
 * case (the transcript holds the original prompt and all partial tool work;
 * the do-not-redo instruction is the guard Finding-4 needs, honorable
 * because side effects are visible IN the transcript); the embedded original
 * is the fresh-fallback belt for the two shapes where resume doesn't
 * materialize (⚠A4 persist-write race; KPR-399 §Edge-7 contender overwrite) —
 * without it a bare "continue" into a fresh session is a garbage turn. The
 * "No response needed." clause wires into the dispatcher's
 * NON_RESPONSE_PATTERNS suppression so a moved-on thread gets no zombie
 * answer.
 */
export function deadlineContinuationWrap(originalText: string, leg: number, totalLegs: number): string {
  const note =
    `[Continuation ${leg}/${totalLegs}: your previous turn on this request hit its wall-clock time limit ` +
    `and was cut off mid-work. Your session may already contain this request and your partial progress — ` +
    `continue from where you left off; do NOT redo completed work or re-run side-effectful actions that ` +
    `already ran. If the thread has moved on and no answer is needed, reply "No response needed." ` +
    `The original request follows for reference:]`;
  return `${note}\n\n${originalText}`;
}

/**
 * Strip one trailing `#dl<n>` so chain leg ids stay FLAT — leg 3 is `x#dl3`,
 * never `x#dl1#dl2#dl3` (⚠A11). Suffixing (not replacing) the origin id
 * keeps policyFor's prefix detection intact (`callback:x#dl1` is still
 * `callback:`-classed) and makes every leg's own outage enqueue a real
 * $setOnInsert insert under a fresh (itemId, agentId) key. Accepted residual
 * (⚠A11): a user/client-supplied id that genuinely ends in `#dl<k>` would be
 * mis-stripped — engine-synthesized ids never collide, and the misfire cost
 * is a wrong base-id string in a leg id, not a routing or policy change.
 */
export function deadlineBaseIdOf(id: string): string {
  return id.replace(/#dl\d+$/, "");
}
