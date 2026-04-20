import { registerArchetype } from "../registry.js";
import { validateConfig } from "./config.js";
import { systemPromptCard } from "./prompt-card.js";
import { preToolUseHooks } from "./hooks.js";
import { memoryScopes } from "./memory-scopes.js";
import { sessionOptions } from "./session-options.js";
import type { SoftwareEngineerConfig } from "./config.js";

registerArchetype<SoftwareEngineerConfig>({
  id: "software-engineer",
  description:
    "Owns codebases and ships production code through disciplined delivery (ticket → spec → PR → CI → close).",
  whenToUse:
    "Pick this when the agent's core job is writing, reviewing, or shipping production code. For product strategists, marketers, or anyone where code is incidental, use a plain agent.",
  configSchema: {
    workshop: {
      type: "string",
      required: true,
      description:
        "Absolute filesystem path — the engineer's bounded root directory (e.g. /Users/you/dev).",
    },
    workspaces: {
      type: "array",
      required: false,
      description:
        "Registered codebases inside the workshop. Do NOT prompt for these at creation time — workspace registration is a separate admin flow. Start with an empty array.",
    },
  },
  validateConfig,
  systemPromptCard,
  preToolUseHooks,
  memoryScopes,
  sessionOptions,
});
