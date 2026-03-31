// Client → Server messages
export type ClientMessage =
  | { type: "message"; text: string; sessionId?: string }
  | { type: "new_session"; workspace?: string }
  | { type: "switch_workspace"; workspace: string }
  | { type: "approve"; toolUseId: string }
  | { type: "deny"; toolUseId: string }
  | { type: "ping" }
  | { type: "browse" };

// Server → Client messages
export type ServerMessage =
  | { type: "message"; text: string; sessionId: string; final: boolean }
  | { type: "tool_approval"; toolUseId: string; tool: string; input: string }
  | { type: "status"; state: "thinking" | "idle" | "tool_running" | "session_ended" }
  | { type: "session_info"; sessionId: string; workspace: string; workspaces: string[] }
  | { type: "error"; message: string }
  | { type: "pong" };

export interface BeekeeperConfig {
  port: number;
  defaultWorkspace: string;
  model: string;
  workspaces: Record<string, string>;
  confirmOperations: string[];
  jwtSecret: string;
  adminSecret: string;
  mongoUri: string;
  mongoDbName: string;
  plugins?: string[];
}
