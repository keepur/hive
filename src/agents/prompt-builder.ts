import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { config } from "../config.js";

/**
 * Build a system prompt for voice calls.
 *
 * Assembly order: soul → systemPrompt → constitution → voice instructions → call goal/context → agent memory → date/time (last).
 * Matches the main buildSystemPrompt's static prefix but omits tool summaries and
 * delegate descriptions (those are handled by Vapi's tool layer, not inline prompting).
 */
export async function buildVoiceSystemPrompt(
  agentConfig: AgentConfig,
  memoryManager: MemoryManager,
  callContext?: { goal?: string; context?: string },
): Promise<string> {
  const parts: string[] = [];

  // --- Static prefix ---

  if (agentConfig.soul) {
    parts.push(agentConfig.soul);
  }

  parts.push(agentConfig.systemPrompt);

  // Constitution — non-negotiable team rules
  const constitution = await memoryManager.read("shared/constitution.md");
  if (constitution) {
    parts.push(constitution);
  }

  // Voice-specific instructions
  parts.push(
    `## Voice Call Mode\n\n` +
    `You are currently on a live phone call. Keep responses conversational and concise — ` +
    `you are speaking out loud, not writing text. Avoid markdown, bullet points, or long lists. ` +
    `Speak naturally as a human would on the phone. Identify yourself at the start of the call.`,
  );

  // Call-specific goal/context (injected from voice_call tool)
  if (callContext?.goal) {
    parts.push(`## Call Goal\n\n${callContext.goal}`);
  }
  if (callContext?.context) {
    parts.push(`## Call Context\n\n${callContext.context}`);
  }

  // --- Dynamic suffix ---

  // Memory injection — prefer structured records, fall back to legacy blob
  const hotTierPrompt = await memoryManager.getHotTierPrompt(
    agentConfig.id,
    config.memory.hotBudgetTokens,
  );
  if (hotTierPrompt) {
    parts.push(hotTierPrompt);
  } else {
    const memoryDir = `agents/${agentConfig.id}`;
    const memory = await memoryManager.read(`${memoryDir}/memory.md`);
    if (memory) {
      parts.push(`## Your Memory\n${memory}`);
    }
  }

  // Date/time last — changes every minute, preserves static prefix for caching
  const now = new Date();
  const pacific = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  parts.push(`**Current date/time**: ${pacific} (Pacific Time)`);

  return parts.join("\n\n---\n\n");
}
