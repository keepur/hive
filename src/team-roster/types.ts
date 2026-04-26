import type { ContactCategory } from "../contacts/contacts-mcp-server.js";

export type { ContactCategory };

/**
 * Team-member view returned by the team API. Joins humans (from contacts
 * collection where category === "team-human") with agents (from
 * agent_definitions). The `category` field on TeamMember includes
 * "team-agent" — a synthetic value NOT stored in any ContactDoc; only
 * humans persist a `category`.
 */
export interface TeamMember {
  kind: "human" | "agent";
  id: string; // human: contacts._id.toHexString(); agent: agent_definitions._id (string)
  name: string;
  email?: string;
  role?: string;
  pronouns?: string;
  category: "team-human" | "team-agent" | "archived";
  // Agent-only fields (undefined for humans):
  agentId?: string;
  slackChannel?: string; // mapped from AgentDefinition.homeBase
  model?: string;
  active?: boolean; // agents: !disabled; humans: category !== "archived"
}
