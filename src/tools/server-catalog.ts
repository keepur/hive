export interface ServerCatalogEntry {
  /** What this server does (shown in prompt) */
  description: string;
  /** When to use this server — guidance for the agent */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
  /**
   * Optional shorter blurb used by the runtime "Your toolkit" section
   * (KPR-87) where prompt budget is tight. Falls back to `description`
   * when unset. Keep ≤ ~100 chars — one line, no marketing prose.
   */
  toolkitBlurb?: string;
}

/**
 * Core server catalog — metadata for built-in MCP servers.
 * Plugin servers define their own metadata in plugin.yaml manifests.
 */
export const SERVER_CATALOG: Record<string, ServerCatalogEntry> = {
  clickup: {
    description: "Task management — tasks, lists, spaces, comments, custom fields",
    usage: "Creating and managing project tasks",
  },
  google: {
    description: "Email (Gmail), calendar, Google Drive files",
    usage: "Sending email, checking calendar events, reading Drive documents",
  },
  resend: {
    description: "Send outbound email with file attachments",
    usage: "Sending transactional or outreach email from your agent address",
    notFor: "Reading email — use google for inbox access",
  },
  "brave-search": {
    description: "Web search, news, local business lookup",
    usage: "Finding current information from the public web",
    notFor: "Internal data — use crm-search, code-search, or memory instead",
  },
  contacts: {
    description: "Contact lookups by name, email, or phone",
    usage: "Quick lookups of people in the contact directory",
    notFor: "Messaging another hive agent (use team) or CRM deal/company data (use a CRM plugin)",
  },
  team: {
    description: "Direct agent-to-agent messaging — peer hive agents, not Slack DMs",
    usage: "Sending a message or task to another agent in this hive",
    notFor: "Looking up people in the contact directory — use contacts instead",
    toolkitBlurb: "Direct messaging to peer hive agents (not Slack DMs)",
  },
  // team-roster is engine-auto-injected (see AgentRunner.autoInjectedServerNames()).
  // Without an entry here, the toolkit section renders "- team-roster — team-roster".
  "team-roster": {
    description: "Team directory lookups — list teammates, look up humans by name/email, look up agents by id/name",
    usage: "Routine teammate info: roles, emails, channels, model. Reach for this before admin.",
    notFor: "Editing agent definitions or version history — use admin instead",
    toolkitBlurb: "Look up team humans + agents (roles, emails, channels)",
  },
  linear: {
    description: "Issue tracking and project management",
    usage: "Creating, searching, and updating engineering issues",
  },
  "github-issues": {
    description: "GitHub issue tracking — create, search, update, comment on issues",
    usage: "Managing GitHub issues for engineering work",
  },
  quo: {
    description: "Send and receive SMS messages via OpenPhone",
    usage: "Texting customers or team members",
  },
  voice: {
    description: "Make outbound phone calls via Vapi",
    usage: "Calling customers, scheduling appointments, following up by phone",
  },
  tasks: {
    description: "Task management — create, update, and track agent tasks",
    usage: "Managing your own task queue",
  },
  "code-search": {
    description: "Semantic search over codebase file index — find where functionality lives, file roles, exports",
    usage: "Finding code by what it does, not just by filename",
    notFor: "Broad web search — use brave-search instead",
  },
  "code-task": {
    description: "Spawn Claude Code CLI sessions for coding tasks",
    usage: "Delegating implementation, debugging, or code analysis work",
  },
  memory: {
    description: "Read and write your personal agent memory",
    usage: "Storing and retrieving facts across conversations. Auto-managed — don't over-save",
  },
  // structured-memory is auto-paired infrastructure (injected when memory is present).
  // KPR-87: surfaces in the "Your toolkit" section under engine-provided.
  "structured-memory": {
    description: "Semantic + temporal memory tiers — recall, save, pin, forget",
    usage: "Use memory_recall to find prior facts; memory_save/_pin for durable notes",
    toolkitBlurb: "Semantic + temporal memory tiers (recall, save, pin)",
  },
  schedule: {
    description: "Self-service schedule management — view, add, update, remove your schedules",
    usage: "Managing your recurring or one-time scheduled tasks",
    toolkitBlurb: "Manage your scheduled tasks (recurring or one-time)",
  },
  "event-bus": {
    description: "Publish events to the cross-agent event bus",
    usage: "Notifying other agents about state changes or completed work",
  },
  workflow: {
    description: "Plan and task management — create plans, assign tasks, track dependencies",
    usage: "Coordinating multi-step work across agents and humans",
  },
  callback: {
    description: "Schedule future self-invocations",
    usage: "Reminding yourself to follow up on something later",
  },
  background: {
    description: "Spawn detached background processes",
    usage: "Running long-lived commands that outlive your current turn",
  },
  "conversation-search": {
    description: "Semantic search over past conversations",
    usage: "Finding what was discussed previously across threads",
  },
  browser: {
    description: "Browser automation via Playwright — navigate, click, fill forms, screenshot",
    usage: "Accessing web UIs that don't have APIs",
  },
  slack: {
    description: "Slack API — read channels, post messages, manage threads",
    usage: "Interacting with Slack channels and threads",
    toolkitBlurb: "Slack channels, messages, and threads",
  },
  recall: {
    description: "Meeting bot — join calls, get transcripts",
    usage: "Participating in or getting transcripts from video meetings",
  },
  admin: {
    description: "Agent management — list, view, update agent definitions",
    usage: "Viewing or modifying agent configurations",
  },
  keychain: {
    description: "Read secrets from macOS Keychain",
    usage: "Retrieving API keys or credentials stored in the system keychain",
  },
};

/** Format a catalog entry as a prompt line: "- name: description\n  → usage / notFor" */
export function formatCatalogEntry(name: string, entry: ServerCatalogEntry): string {
  let line = `- ${name}: ${entry.description}`;
  const hints: string[] = [];
  if (entry.usage) hints.push(`Use for: ${entry.usage}.`);
  if (entry.notFor) hints.push(`Not for: ${entry.notFor}.`);
  if (hints.length > 0) {
    line += `\n  → ${hints.join(" ")}`;
  }
  return line;
}
