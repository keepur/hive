// Client → Server messages
export type ClientMessage =
  | { type: "message"; text: string; sessionId: string }
  | { type: "new_session"; path: string }
  | { type: "clear_session"; sessionId: string }
  | { type: "list_sessions" }
  | { type: "approve"; toolUseId: string }
  | { type: "deny"; toolUseId: string }
  | { type: "ping" };

// Server → Client messages
export type ServerMessage =
  | { type: "message"; text: string; sessionId: string; final: boolean }
  | { type: "tool_approval"; toolUseId: string; tool: string; input: string; sessionId: string }
  | { type: "status"; state: "thinking" | "idle" | "tool_running"; sessionId: string }
  | { type: "session_info"; sessionId: string; path: string }
  | { type: "session_list"; sessions: Array<{ sessionId: string; path: string; state: "idle" | "busy" }> }
  | { type: "session_cleared"; sessionId: string }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "pong" };

export interface BeekeeperConfig {
  port: number;
  model: string;
  confirmOperations: string[];
  jwtSecret: string;
  adminSecret: string;
  mongoUri: string;
  mongoDbName: string;
  plugins?: string[];
}
