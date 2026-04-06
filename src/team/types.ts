// src/team/types.ts

export interface TeamChannel {
  _id: string; // "general", "production", "dm:<sortedA>:<sortedB>"
  type: "channel" | "dm";
  name: string;
  members: string[]; // agent IDs + device IDs
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
}

export interface TeamMessageFile {
  name: string;
  mimetype: string;
  size: number;
  storageKey: string;
  isImage: boolean;
}

export interface TeamMessage {
  _id?: string; // ObjectId string
  channelId: string;
  threadId?: string;
  senderId: string;
  senderType: "agent" | "person";
  senderName: string;
  text: string;
  files?: TeamMessageFile[];
  command?: { name: string; args: string[]; result?: string };
  createdAt: Date;
  editedAt?: Date;
}

export interface TeamCommandDef {
  name: string;
  source: "core" | "skill";
  pluginId?: string;
  description: string;
  args?: { name: string; required: boolean; description: string }[];
}

export interface TeamCommandHandler {
  def: TeamCommandDef;
  execute: (context: CommandContext) => Promise<string>;
}

export interface CommandContext {
  channelId: string;
  senderId: string;
  senderName: string;
  args: string[];
}

/** Helper: canonical DM channel ID from two participant IDs */
export function dmChannelId(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `dm:${sorted[0]}:${sorted[1]}`;
}

/** Helper: canonical internal channel ID for agent-to-agent */
export function internalChannelId(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `internal:${sorted[0]}:${sorted[1]}`;
}
