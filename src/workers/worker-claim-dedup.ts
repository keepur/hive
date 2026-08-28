/**
 * KPR-390 §A2: best-effort semantic dedup for meeting worker claims.
 * One classifier-grade sidecar call before insert; EVERY failure path
 * (no key, transport error, parse failure, non-open id) degrades to
 * "unique" — fail-open to duplicate work, never to a blocked dispatch
 * (ticket-explicit). The exact-key partial-unique index backstops
 * identical text regardless.
 */
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { getLLMRegistry } from "../llm/registry.js";

const log = createLogger("worker-claim-dedup");

const DEDUP_SYSTEM_PROMPT =
  'You deduplicate research tasks dispatched during a meeting. Decide whether the NEW task would substantially duplicate any OPEN task\'s work — near-equivalent data fetches count as duplicates; different targets or clearly different deliverables do not. Reply with JSON only: {"duplicateOf": "<open task id>"} if a duplicate, {"duplicateOf": null} otherwise.';

const DEDUP_SCHEMA = {
  type: "object",
  properties: { duplicateOf: { type: ["string", "null"] } },
  required: ["duplicateOf"],
  additionalProperties: false,
};

/** Open claims are capped at 10 by the caller; enforced here too (belt-and-braces). */
const MAX_COMPARED = 10;

export interface OpenClaimSummary {
  claimId: string;
  taskText: string;
}

export interface ClaimDedupVerdict {
  /** null = unique (including every fail-open path). */
  duplicateOfClaimId: string | null;
  costUsd: number;
}

export async function classifyClaimDedup(newTask: string, openClaims: OpenClaimSummary[]): Promise<ClaimDedupVerdict> {
  if (openClaims.length === 0) return { duplicateOfClaimId: null, costUsd: 0 };
  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) return { duplicateOfClaimId: null, costUsd: 0 };
  const open = openClaims.slice(0, MAX_COMPARED);
  try {
    const prompt = `OPEN tasks:\n${open.map((c) => `- [${c.claimId}] ${c.taskText}`).join("\n")}\n\nNEW task:\n${newTask}`;
    const result = await registry.generateForTask("workerClaimDedup", {
      prompt,
      systemPrompt: DEDUP_SYSTEM_PROMPT,
      jsonSchema: DEDUP_SCHEMA,
      maxOutputTokens: 128,
      temperature: 0,
      timeoutMs: config.modelRouter.timeoutMs,
    });
    let parsed: unknown = result.parsed;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = undefined;
      }
    }
    const dup =
      parsed && typeof parsed === "object" && typeof (parsed as { duplicateOf?: unknown }).duplicateOf === "string"
        ? (parsed as { duplicateOf: string }).duplicateOf
        : null;
    // Non-open id returned ⇒ fail-open to unique (spec §A2).
    const valid = dup && open.some((c) => c.claimId === dup) ? dup : null;
    return { duplicateOfClaimId: valid, costUsd: result.costUsd ?? 0 };
  } catch (err) {
    log.warn("workerClaimDedup call failed — treating task as unique (fail-open)", { error: String(err) });
    return { duplicateOfClaimId: null, costUsd: 0 };
  }
}
