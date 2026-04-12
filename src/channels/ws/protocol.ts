/**
 * WebSocket protocol message types for native client adapters (iOS/macOS + Team layer).
 */

// ── Client → Server ─────────────────────────────────────────────────────

export interface ClientTextMessage {
  type: "message";
  text: string;
  id: string;
}

export interface ClientImageMessage {
  type: "image";
  data: string; // base64
  filename: string;
  id: string;
}

export interface ClientPing {
  type: "ping";
}

export interface ClientTeamMessage {
  type: "message";
  channelId: string;
  text: string;
  threadId?: string;
  id: string;
}

export interface ClientTeamImage {
  type: "image";
  channelId: string;
  data: string; // base64
  filename: string;
  id: string;
}

export interface ClientTeamFile {
  type: "file";
  channelId: string;
  data: string; // base64
  filename: string;
  mimetype: string;
  id: string;
}

export interface ClientJoin {
  type: "join";
  channelId: string;
  id: string;
}

export interface ClientLeave {
  type: "leave";
  channelId: string;
  id: string;
}

export interface ClientCommand {
  type: "command";
  channelId: string;
  name: string;
  args: string[];
  id: string;
}

export interface ClientCommandList {
  type: "command_list";
  id: string;
}

export interface ClientChannelList {
  type: "channel_list";
  id: string;
}

export interface ClientHistory {
  type: "history";
  channelId: string;
  before?: string;
  limit?: number;
  id: string;
}

export interface ClientAgentList {
  type: "agent_list";
  id: string;
}

export type ClientMessage =
  | ClientTextMessage
  | ClientImageMessage
  | ClientPing
  | ClientTeamMessage
  | ClientTeamImage
  | ClientTeamFile
  | ClientJoin
  | ClientLeave
  | ClientCommand
  | ClientCommandList
  | ClientChannelList
  | ClientHistory
  | ClientAgentList;

// ── Server → Client ─────────────────────────────────────────────────────

export interface ServerTextMessage {
  type: "message";
  text: string;
  agentId: string;
  agentName: string;
  replyTo?: string;
  channelId?: string; // present for Team messages, absent for legacy app messages
}

export interface ServerAck {
  type: "ack";
  id: string;
}

export interface ServerTyping {
  type: "typing";
  agentId: string;
}

export interface ServerError {
  type: "error";
  message: string;
}

export interface ServerChannelList {
  type: "channel_list";
  channels: { id: string; type: string; name: string; members: string[] }[];
  id: string;
}

export interface ServerCommandList {
  type: "command_list";
  commands: {
    name: string;
    description: string;
    args?: { name: string; required: boolean; description: string }[];
  }[];
  id: string;
}

export interface ServerHistory {
  type: "history";
  channelId: string;
  messages: {
    id: string;
    senderId: string;
    senderType: string;
    senderName: string;
    text: string;
    threadId?: string;
    createdAt: string;
  }[];
  hasMore: boolean;
  id: string;
}

export interface ServerChannelEvent {
  type: "channel_event";
  channelId: string;
  event: "created" | "joined" | "left" | "archived";
  detail: Record<string, unknown>;
  id: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  icon: string;
  title: string | null;
  model: string;
  status: "idle" | "processing" | "error" | "stopped";
  tools: string[];
  schedule: { cron: string; task: string }[];
  channels: string[];
  messagesProcessed: number;
  lastActivity: string | null; // ISO 8601, null when agent has never received a message
}

export interface ServerAgentList {
  type: "agent_list";
  agents: AgentInfo[];
  id: string;
}

// Phase 2 — defined now, added to ServerMessage union later
export interface ServerAgentStatus {
  type: "agent_status";
  agentId: string;
  status: "idle" | "processing" | "error" | "stopped";
  id: string;
}

export type ServerMessage =
  | ServerTextMessage
  | ServerAck
  | ServerTyping
  | ServerError
  | ServerChannelList
  | ServerCommandList
  | ServerHistory
  | ServerChannelEvent
  | ServerAgentList;

// ── Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse and validate an incoming JSON string as a ClientMessage.
 * Returns null if the payload is invalid or unrecognised.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const msg = parsed as Record<string, unknown>;

  switch (msg.type) {
    case "message":
      if (typeof msg.text !== "string" || typeof msg.id !== "string") return null;
      if (typeof msg.channelId === "string") {
        // Team message — has channelId
        return {
          type: "message",
          channelId: msg.channelId,
          text: msg.text,
          threadId: typeof msg.threadId === "string" ? msg.threadId : undefined,
          id: msg.id,
        } as ClientTeamMessage;
      }
      // Legacy app message — no channelId
      return { type: "message", text: msg.text, id: msg.id };

    case "image":
      if (typeof msg.data !== "string" || typeof msg.filename !== "string" || typeof msg.id !== "string") return null;
      if (typeof msg.channelId === "string") {
        return {
          type: "image",
          channelId: msg.channelId,
          data: msg.data,
          filename: msg.filename,
          id: msg.id,
        } as ClientTeamImage;
      }
      return { type: "image", data: msg.data, filename: msg.filename, id: msg.id };

    case "file":
      if (
        typeof msg.channelId === "string" &&
        typeof msg.data === "string" &&
        typeof msg.filename === "string" &&
        typeof msg.mimetype === "string" &&
        typeof msg.id === "string"
      ) {
        return {
          type: "file",
          channelId: msg.channelId,
          data: msg.data,
          filename: msg.filename,
          mimetype: msg.mimetype,
          id: msg.id,
        };
      }
      return null;

    case "ping":
      return { type: "ping" };

    case "join":
      if (typeof msg.channelId === "string" && typeof msg.id === "string") {
        return { type: "join", channelId: msg.channelId, id: msg.id };
      }
      return null;

    case "leave":
      if (typeof msg.channelId === "string" && typeof msg.id === "string") {
        return { type: "leave", channelId: msg.channelId, id: msg.id };
      }
      return null;

    case "command":
      if (
        typeof msg.channelId === "string" &&
        typeof msg.name === "string" &&
        Array.isArray(msg.args) &&
        typeof msg.id === "string"
      ) {
        return {
          type: "command",
          channelId: msg.channelId,
          name: msg.name,
          args: msg.args.map(String),
          id: msg.id,
        };
      }
      return null;

    case "command_list":
      if (typeof msg.id === "string") {
        return { type: "command_list", id: msg.id };
      }
      return null;

    case "channel_list":
      if (typeof msg.id === "string") {
        return { type: "channel_list", id: msg.id };
      }
      return null;

    case "history":
      if (typeof msg.channelId === "string" && typeof msg.id === "string") {
        return {
          type: "history",
          channelId: msg.channelId,
          before: typeof msg.before === "string" ? msg.before : undefined,
          limit: typeof msg.limit === "number" ? msg.limit : undefined,
          id: msg.id,
        };
      }
      return null;

    case "agent_list":
      if (typeof msg.id === "string") {
        return { type: "agent_list", id: msg.id };
      }
      return null;

    default:
      return null;
  }
}

/** Type guard: is this a Team content message (message/image/file with channelId)? */
export function isTeamMessage(msg: ClientMessage): msg is ClientTeamMessage | ClientTeamImage | ClientTeamFile {
  return (msg.type === "message" || msg.type === "image" || msg.type === "file") && "channelId" in msg;
}
