import { registerArchetype } from "../registry.js";
import { validateConfig } from "./config.js";
import { systemPromptCard } from "./prompt-card.js";
import { preToolUseHooks } from "./hooks.js";
import { memoryScopes } from "./memory-scopes.js";
import { sessionOptions } from "./session-options.js";
import type { SoftwareEngineerConfig } from "./config.js";

registerArchetype<SoftwareEngineerConfig>({
  id: "software-engineer",
  validateConfig,
  systemPromptCard,
  preToolUseHooks,
  memoryScopes,
  sessionOptions,
});
