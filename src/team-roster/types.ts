export type ContactCategory = "team-human" | "customer" | "vendor" | "partner" | "archived";

export interface TeamMember {
  kind: "human" | "agent";
  id: string;
  name: string;
  email?: string;
  role?: string;
  pronouns?: string;
  category: "team-human" | "team-agent" | "archived";
  /** Used by lookupHuman's most-recently-updated tiebreak. Humans only. */
  updatedAt?: Date;
  // Agent-only fields; undefined for humans:
  agentId?: string;
  slackChannel?: string;
  model?: string;
  aliases?: string[];
  active?: boolean;
}
