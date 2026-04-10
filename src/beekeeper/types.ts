// Client → Server messages
export type ClientMessage =
  | { type: "message"; text: string; sessionId: string }
  | { type: "new_session"; path: string }
  | { type: "clear_session"; sessionId: string }
  | { type: "list_sessions" }
  | { type: "approve"; toolUseId: string }
  | { type: "deny"; toolUseId: string }
  | { type: "browse"; path?: string }
  | { type: "list_workspace_sessions"; path: string }
  | { type: "resume_session"; sessionId: string; path: string }
  | { type: "cancel"; sessionId: string }
  | { type: "image"; sessionId: string; data: string; filename: string }
  | { type: "file"; sessionId: string; data: string; filename: string; mimetype: string }
  | { type: "ping" };

// Server → Client messages
export type ServerMessage =
  | { type: "message"; text: string; sessionId: string; final: boolean }
  | { type: "tool_approval"; toolUseId: string; tool: string; input: string; sessionId: string }
  | {
      type: "status";
      state: "thinking" | "idle" | "tool_running" | "tool_starting" | "busy";
      sessionId: string;
      toolName?: string;
    }
  | { type: "tool_output"; toolName: string; output: string; toolUseId: string; sessionId: string }
  | { type: "session_info"; sessionId: string; path: string }
  | { type: "session_list"; sessions: Array<{ sessionId: string; path: string; state: "idle" | "busy" }> }
  | { type: "session_cleared"; sessionId: string }
  | { type: "session_replaced"; oldSessionId: string; newSessionId: string; path: string }
  | { type: "browse_result"; path: string; entries: Array<{ name: string; isDirectory: boolean }> }
  | {
      type: "workspace_session_list";
      path: string;
      sessions: Array<{
        sessionId: string;
        lastActiveAt: string;
        preview: string;
        active: boolean;
      }>;
    }
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
  dataDir: string;
  plugins?: string[];
}
