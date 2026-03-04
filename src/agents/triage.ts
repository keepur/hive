import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import { config } from "../config.js";

const log = createLogger("triage");

export interface TriageResult {
  response: string;
  action: "done" | "continue";
  costUsd: number;
  durationMs: number;
}

interface TriageOutput {
  response: string;
  action: "done" | "continue";
}

function buildTriagePrompt(agentConfig: AgentConfig, isThread: boolean): string {
  const threadNote = isThread
    ? "\nThis message is in an existing conversation thread. Default to \"continue\" unless it's clearly standalone (like \"thanks\", \"ok\", \"got it\")."
    : "";

  return `You are triaging messages for ${agentConfig.name}.

${agentConfig.soul}

Respond with ONLY a JSON object, no markdown fences, no explanation.

{ "response": "<your reply>", "action": "done" } when:
- Greetings, thanks, confirmations, yes/no, chit-chat you can handle in character

{ "response": "<brief ack>", "action": "continue" } when:
- Questions requiring lookups, tool use, research, or multi-step work
- Task requests, analysis, anything involving external data or memory
- If unsure, default to "continue"

Keep "continue" ack responses under 15 words, natural, in character.
Keep "done" responses brief and natural.${threadNote}`;
}

function parseTriageOutput(text: string): TriageOutput | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(text);
    if (parsed.response && (parsed.action === "done" || parsed.action === "continue")) {
      return { response: parsed.response, action: parsed.action };
    }
  } catch { /* fall through */ }

  // Try extracting from markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed.response && (parsed.action === "done" || parsed.action === "continue")) {
        return { response: parsed.response, action: parsed.action };
      }
    } catch { /* fall through */ }
  }

  // Try finding JSON boundaries
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
      if (parsed.response && (parsed.action === "done" || parsed.action === "continue")) {
        return { response: parsed.response, action: parsed.action };
      }
    } catch { /* fall through */ }
  }

  return null;
}

export async function triage(
  text: string,
  agentConfig: AgentConfig,
  context: { isThread: boolean },
): Promise<TriageResult> {
  const model = agentConfig.triageModel ?? config.triage.model;
  const systemPrompt = buildTriagePrompt(agentConfig, context.isThread);
  const timeoutMs = config.triage.timeoutMs;

  let q: Query | null = null;
  let resultText = "";
  let costUsd = 0;
  let durationMs = 0;

  const deadline = setTimeout(() => {
    if (q) {
      log.warn("Triage timed out", { agent: agentConfig.id, timeoutMs });
      q.close();
    }
  }, timeoutMs);

  try {
    q = query({
      prompt: text,
      options: {
        model,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        persistSession: false,
        thinking: { type: "disabled" },
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebFetch", "WebSearch", "NotebookEdit"],
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined as unknown as string,
        },
      },
    });

    for await (const message of q) {
      const msg = message as SDKMessage;

      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
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
    log.warn("Triage query failed", { agent: agentConfig.id, error: String(err) });
    return { response: "On it...", action: "continue", costUsd: 0, durationMs: 0 };
  } finally {
    clearTimeout(deadline);
    q = null;
  }

  // Parse structured output
  const parsed = parseTriageOutput(resultText);
  if (parsed) {
    log.info("Triage complete", {
      agent: agentConfig.id,
      action: parsed.action,
      costUsd,
      durationMs,
      responsePreview: parsed.response.slice(0, 80),
    });
    return { response: parsed.response, action: parsed.action, costUsd, durationMs };
  }

  // Fallback: couldn't parse, default to continue
  log.warn("Triage JSON parse failed, defaulting to continue", {
    agent: agentConfig.id,
    rawText: resultText.slice(0, 200),
  });
  return { response: resultText || "On it...", action: "continue", costUsd, durationMs };
}
