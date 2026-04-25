import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";

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

  const routerModel = config.modelRouter.model;
  let q: Query | null = null;
  let resultText = "";
  let costUsd = 0;
  let durationMs = 0;

  const deadline = setTimeout(() => {
    if (q) {
      log.warn("Meeting classifier timed out", {
        timeoutMs: config.modelRouter.timeoutMs,
      });
      q.close();
    }
  }, config.modelRouter.timeoutMs);

  try {
    const userPrompt = `${buildRosterContext(roster, recentMessages)}\n\nMessage:\n${messageText}`;

    q = query({
      prompt: userPrompt,
      options: {
        model: routerModel,
        systemPrompt: CLASSIFIER_PROMPT,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        persistSession: false,
        disallowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Agent",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
        ],
        env: {
          ...process.env,
          ...(config.anthropic.apiKey
            ? { ANTHROPIC_API_KEY: config.anthropic.apiKey }
            : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined as unknown as string,
        },
      },
    });

    for await (const message of q) {
      const msg = message as SDKMessage;

      if (msg.type === "assistant") {
        // SDK SDKMessage union doesn't expose .message.content after type narrowing — runtime shape is correct
        const content = (msg as any).message?.content; // eslint-disable-line @typescript-eslint/no-explicit-any
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
    log.warn("Meeting classifier query failed, selecting all roster members", {
      error: String(err),
    });
    return {
      respondAgentIds: [...validIds],
      costUsd: 0,
      durationMs: 0,
    };
  } finally {
    clearTimeout(deadline);
    q = null;
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
