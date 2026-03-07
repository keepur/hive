/**
 * WebSocket protocol message types for the Shop Floor Mobile App adapter.
 */

// Client -> Server message types

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

export type ClientMessage = ClientTextMessage | ClientImageMessage | ClientPing;

// Server -> Client message types

export interface ServerTextMessage {
  type: "message";
  text: string;
  agentId: string;
  agentName: string;
  replyTo?: string;
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

export type ServerMessage = ServerTextMessage | ServerAck | ServerTyping | ServerError;

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
      if (typeof msg.text === "string" && typeof msg.id === "string") {
        return { type: "message", text: msg.text, id: msg.id };
      }
      return null;

    case "image":
      if (
        typeof msg.data === "string" &&
        typeof msg.filename === "string" &&
        typeof msg.id === "string"
      ) {
        return { type: "image", data: msg.data, filename: msg.filename, id: msg.id };
      }
      return null;

    case "ping":
      return { type: "ping" };

    default:
      return null;
  }
}
