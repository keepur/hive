import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { extractJsonObjectText, getLLMRegistry } from "../llm/index.js";

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

const CLASSIFIER_PROMPT = `You are a meeting facilitator. Given a message and a list of meeting participants, decide which participants should respond.

Rules:
- If someone is addressed by name, they MUST be in the respond list.
- Pick participants whose expertise is directly relevant to the message.
- Fewer is better — don't trigger everyone for a question only one person can answer.
- If the message is clearly directed at one person, return only that person.
- If the message is a general question to the room, pick 2-3 most relevant.
- For "what does everyone think?" style questions, include all participants.

Respond with ONLY a JSON object: { "respond": ["agent-id-1", "agent-id-2"] }`;

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

  const jsonText = extractJsonObjectText(text);
  if (jsonText) {
    const nested = extract(jsonText);
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

  let resultText = "";
  let costUsd = 0;
  let durationMs = 0;

  try {
    const userPrompt = `${buildRosterContext(roster, recentMessages)}\n\nMessage:\n${messageText}`;

    const result = await getLLMRegistry().generateForTask("meetingClassifier", {
      prompt: userPrompt,
      systemPrompt: CLASSIFIER_PROMPT,
      responseFormat: "json",
      maxOutputTokens: 256,
      temperature: 0,
      timeoutMs: config.modelRouter.timeoutMs,
    });
    resultText = result.text;
    costUsd = result.costUsd ?? 0;
    durationMs = result.durationMs;
  } catch (err) {
    log.warn("Meeting classifier query failed, selecting all roster members", {
      error: String(err),
    });
    return {
      respondAgentIds: [...validIds],
      costUsd: 0,
      durationMs: 0,
    };
  }

  const parsed = parseClassifierOutput(resultText, validIds);
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
