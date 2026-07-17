import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { getLLMRegistry } from "../llm/registry.js";

const log = createLogger("meeting-classifier");

export interface RosterMember {
  agentId: string;
  name: string;
  title?: string;
  role: string; // first line of soul
}

export interface ClassifyResult {
  respondAgentIds: string[];
  costUsd: number;
  durationMs: number;
}

// KPR-314: the "Respond with ONLY a JSON object" plea is gone — structured
// outputs enforce the shape (same evolution 312 made for the router prompt).
const CLASSIFIER_PROMPT = `You are a meeting facilitator. Given a message and a list of meeting participants, decide which participants should respond.

Rules:
- If someone is addressed by name, they MUST be in the respond list.
- Pick participants whose expertise is directly relevant to the message.
- Fewer is better — don't trigger everyone for a question only one person can answer.
- If the message is clearly directed at one person, return only that person.
- If the message is a general question to the room, pick 2-3 most relevant.
- For "what does everyone think?" style questions, include all participants.`;

/** { respond: string[] } — kills the brace-scan on the happy path (spec §3.3). */
const RESPOND_SCHEMA = {
  type: "object",
  properties: {
    respond: { type: "array", items: { type: "string" } },
  },
  required: ["respond"],
  additionalProperties: false,
} as const;

export function parseClassifierOutput(
  text: string,
  validIds: Set<string>,
): string[] | null {
  const extract = (raw: string): string[] | null => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.respond)) {
        return parsed.respond.filter((id: string) => validIds.has(id));
      }
    } catch {
      /* fall through */
    }
    return null;
  };

  // Try direct parse
  const direct = extract(text);
  if (direct) return direct;

  // Try finding JSON in text
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    const nested = extract(text.slice(braceStart, braceEnd + 1));
    if (nested) return nested;
  }

  return null;
}

function buildRosterContext(
  roster: RosterMember[],
  recentMessages?: string,
): string {
  const participants = roster
    .map(
      (r) =>
        `- ${r.agentId} (${r.name}${r.title ? `, ${r.title}` : ""}): ${r.role}`,
    )
    .join("\n");

  let prompt = `Participants:\n${participants}`;
  if (recentMessages) {
    prompt += `\n\nRecent thread context:\n${recentMessages}`;
  }
  return prompt;
}

// KPR-314: no-key is a steady state, not an incident (312's distinction) —
// warn once per process, not once per meeting message.
let noKeyWarned = false;

/** Test-only seam. */
export function __resetMeetingClassifierStateForTests(): void {
  noKeyWarned = false;
}

export async function classifyMeetingMessage(
  messageText: string,
  roster: RosterMember[],
  recentMessages?: string,
): Promise<ClassifyResult> {
  const validIds = new Set(roster.map((r) => r.agentId));

  if (roster.length === 0) {
    return { respondAgentIds: [], costUsd: 0, durationMs: 0 };
  }

  // If only one participant, skip the classifier
  if (roster.length === 1) {
    return { respondAgentIds: [roster[0].agentId], costUsd: 0, durationMs: 0 };
  }

  // KPR-314: no-key pre-check — all-roster directly, never a thrown-and-caught
  // error per message (spec §3.3). Doctor + boot log carry the standing notice.
  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) {
    if (!noKeyWarned) {
      noKeyWarned = true;
      log.warn(
        "Meeting classifier has no ANTHROPIC_API_KEY — selecting all roster members for every meeting message",
      );
    }
    return { respondAgentIds: [...validIds], costUsd: 0, durationMs: 0 };
  }

  let resultText = "";
  let parsedOutput: unknown;
  let costUsd = 0;
  let durationMs = 0;

  try {
    const userPrompt = `${buildRosterContext(roster, recentMessages)}\n\nMessage:\n${messageText}`;

    // KPR-314: one registry call replaces the per-message Claude Code CLI
    // subprocess (query(), $0.01 cap, setTimeout→q.close() deadline, env
    // surgery). Model: the same classifier-grade entry the router uses
    // (preserves today's config.modelRouter.model coupling); timeout keeps
    // the borrowed knob — no new config (spec §3.3).
    const result = await registry.generateForTask("meetingClassifier", {
      prompt: userPrompt,
      systemPrompt: CLASSIFIER_PROMPT,
      jsonSchema: RESPOND_SCHEMA,
      maxOutputTokens: 256,
      temperature: 0,
      timeoutMs: config.modelRouter.timeoutMs,
    });
    resultText = result.text;
    parsedOutput = result.parsed;
    costUsd = result.costUsd ?? 0;
    durationMs = result.durationMs;
  } catch (err) {
    // Timeout / 429 / 5xx / capability error — today's catch → all-roster path.
    log.warn("Meeting classifier call failed, selecting all roster members", {
      error: String(err),
    });
    return {
      respondAgentIds: [...validIds],
      costUsd: 0,
      durationMs: 0,
    };
  }

  // Belt-and-braces (spec §3.3): parseClassifierOutput over parsed ?? text —
  // the valid-id allowlist filter is business logic, not parse scaffolding.
  const candidate =
    parsedOutput !== undefined ? JSON.stringify(parsedOutput) : resultText;
  const parsed = parseClassifierOutput(candidate, validIds);
  if (!parsed) {
    log.warn("Meeting classifier parse failed, selecting all roster members", {
      rawText: resultText.slice(0, 200),
    });
    return { respondAgentIds: [...validIds], costUsd, durationMs };
  }

  log.info("Meeting classifier decision", {
    respond: parsed,
    rosterSize: roster.length,
    costUsd,
    durationMs,
  });

  return { respondAgentIds: parsed, costUsd, durationMs };
}
