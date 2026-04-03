# Beekeeper Relay Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Build a standalone relay service that bridges an iOS app to Claude Code sessions via WebSocket, running independently of Hive on port 3099.

**Architecture:** Express + `ws` server on port 3099 manages a single Claude Code SDK session. WebSocket protocol bridges iOS client messages to SDK `query()` calls, streams responses back, and routes destructive tool approvals to the client via `PreToolUse` hooks.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, `ws`, `yaml`, Express (Node `http`), existing Hive logging.

**Spec:** `docs/specs/2026-03-28-beekeeper-relay-design.md`

---

### Task 1: Types and Config

**Files:**
- Create: `src/beekeeper/types.ts`
- Create: `src/beekeeper/config.ts`

- [ ] **Step 1:** Create `src/beekeeper/types.ts` — WebSocket protocol message types

```typescript
// Client → Server messages
export type ClientMessage =
  | { type: "message"; text: string; sessionId?: string }
  | { type: "new_session"; workspace?: string }
  | { type: "switch_workspace"; workspace: string }
  | { type: "approve"; toolUseId: string }
  | { type: "deny"; toolUseId: string }
  | { type: "ping" };

// Server → Client messages
export type ServerMessage =
  | { type: "message"; text: string; sessionId: string; final: boolean }
  | { type: "tool_approval"; toolUseId: string; tool: string; input: string }
  | { type: "status"; state: "thinking" | "idle" | "tool_running" | "session_ended" }
  | { type: "session_info"; sessionId: string; workspace: string }
  | { type: "error"; message: string }
  | { type: "pong" };

export interface BeekeeperConfig {
  port: number;
  defaultWorkspace: string;
  model: string;
  workspaces: Record<string, string>;
  confirmOperations: string[];
  authToken: string;
}
```

- [ ] **Step 2:** Create `src/beekeeper/config.ts` — load `beekeeper.yaml` + env vars

```typescript
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BeekeeperConfig } from "./types.js";

export function loadConfig(): BeekeeperConfig {
  const configPath = resolve(process.env.BEEKEEPER_CONFIG ?? "./beekeeper.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Beekeeper config not found: ${configPath}`);
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

  const authToken = process.env.BEEKEEPER_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("Missing required env var: BEEKEEPER_AUTH_TOKEN");
  }

  // Expand ~ in workspace paths
  const workspaces: Record<string, string> = {};
  const rawWorkspaces = (raw.workspaces ?? {}) as Record<string, string>;
  for (const [name, path] of Object.entries(rawWorkspaces)) {
    workspaces[name] = path.replace(/^~/, process.env.HOME ?? "");
  }

  return {
    port: (raw.port as number) ?? 3099,
    defaultWorkspace: (raw.default_workspace as string) ?? "hive",
    model: (raw.model as string) ?? "claude-opus-4-5-20250514",
    workspaces,
    confirmOperations: (raw.confirm_operations as string[]) ?? [
      "git push --force",
      "git branch -D",
      "rm -rf",
      "rm -r",
      "git reset --hard",
      "git checkout -- .",
      "git clean -f",
    ],
    authToken,
  };
}
```

- [ ] **Step 3:** Verify types compile

```bash
cd /Users/mokie/github/hive && npx tsc --noEmit src/beekeeper/types.ts src/beekeeper/config.ts
```
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/beekeeper/types.ts src/beekeeper/config.ts
git commit -m "feat(beekeeper): add protocol types and config loader"
```

---

### Task 2: Tool Guardian

**Files:**
- Create: `src/beekeeper/tool-guardian.ts`

- [ ] **Step 1:** Create `src/beekeeper/tool-guardian.ts` — PreToolUse hook with blocking-wait approval pattern

```typescript
import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";
import { createLogger } from "../logging/logger.js";
import type { ServerMessage } from "./types.js";

const log = createLogger("beekeeper-guardian");

interface PendingApproval {
  resolve: (decision: HookJSONOutput) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ToolGuardian {
  private pendingApprovals = new Map<string, PendingApproval>();
  private confirmPatterns: string[];
  private client: WebSocket | null = null;

  constructor(confirmPatterns: string[]) {
    this.confirmPatterns = confirmPatterns;
  }

  setClient(ws: WebSocket | null): void {
    this.client = ws;
    // Auto-deny all pending approvals if client disconnects
    if (!ws) {
      this.denyAll("Client disconnected");
    }
  }

  /**
   * Returns the hook callback for SDK PreToolUse registration.
   */
  createHookCallback(): HookCallback {
    return async (
      input: HookInput,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      // Only handle PreToolUse events for Bash
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
        return { decision: "approve" };
      }

      const command = (input.tool_input as { command?: string })?.command ?? "";

      // Check if command matches any confirm pattern
      const needsApproval = this.confirmPatterns.some((pattern) => command.includes(pattern));
      if (!needsApproval) {
        return { decision: "approve" };
      }

      log.info("Tool requires approval", { toolUseId: input.tool_use_id, command });

      // If no client connected, auto-deny
      if (!this.client || this.client.readyState !== 1 /* OPEN */) {
        log.warn("No client connected, auto-denying", { toolUseId: input.tool_use_id });
        return { decision: "block", reason: "No client connected to approve" };
      }

      // Send approval request to client
      const approvalMsg: ServerMessage = {
        type: "tool_approval",
        toolUseId: input.tool_use_id,
        tool: "Bash",
        input: command,
      };
      this.client.send(JSON.stringify(approvalMsg));

      // Block until client responds or timeout
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          log.warn("Approval timed out, auto-denying", { toolUseId: input.tool_use_id });
          this.pendingApprovals.delete(input.tool_use_id);
          resolve({ decision: "block", reason: "Approval timed out (60s)" });
        }, 60_000);

        this.pendingApprovals.set(input.tool_use_id, { resolve, timer });
      });
    };
  }

  /**
   * Called when client sends approve/deny message.
   */
  handleApproval(toolUseId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(toolUseId);
    if (!pending) {
      log.warn("No pending approval found", { toolUseId });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingApprovals.delete(toolUseId);

    if (approved) {
      log.info("Tool approved by client", { toolUseId });
      pending.resolve({ decision: "approve" });
    } else {
      log.info("Tool denied by client", { toolUseId });
      pending.resolve({ decision: "block", reason: "User denied" });
    }
  }

  /**
   * Deny all pending approvals (called on client disconnect).
   */
  denyAll(reason: string): void {
    for (const [toolUseId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      log.info("Auto-denying pending approval", { toolUseId, reason });
      pending.resolve({ decision: "block", reason });
    }
    this.pendingApprovals.clear();
  }
}
```

- [ ] **Step 2:** Verify compiles

```bash
cd /Users/mokie/github/hive && npx tsc --noEmit src/beekeeper/tool-guardian.ts
```
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/tool-guardian.ts
git commit -m "feat(beekeeper): add tool guardian with PreToolUse blocking-wait approval"
```

---

### Task 3: Session Manager

**Files:**
- Create: `src/beekeeper/session-manager.ts`

- [ ] **Step 1:** Create `src/beekeeper/session-manager.ts` — manages Claude Code SDK session lifecycle

```typescript
import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";
import { createLogger } from "../logging/logger.js";
import { ToolGuardian } from "./tool-guardian.js";
import type { ServerMessage, BeekeeperConfig } from "./types.js";

const log = createLogger("beekeeper-session");

export class SessionManager {
  private sessionId: string | null = null;
  private workspace: string;
  private activeQuery: Query | null = null;
  private client: WebSocket | null = null;
  private guardian: ToolGuardian;
  private config: BeekeeperConfig;
  private outputBuffer: ServerMessage[] = [];

  constructor(config: BeekeeperConfig, guardian: ToolGuardian) {
    this.config = config;
    this.guardian = guardian;
    this.workspace = config.defaultWorkspace;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getWorkspace(): string {
    return this.workspace;
  }

  setClient(ws: WebSocket | null): void {
    this.client = ws;
    // Drain buffered output to new client
    if (ws && this.outputBuffer.length > 0) {
      log.info("Draining buffered output", { count: this.outputBuffer.length });
      for (const msg of this.outputBuffer) {
        ws.send(JSON.stringify(msg));
      }
      this.outputBuffer = [];
    }
  }

  /**
   * Send a message to the client, or buffer if disconnected.
   */
  private send(msg: ServerMessage): void {
    if (this.client && this.client.readyState === 1 /* OPEN */) {
      this.client.send(JSON.stringify(msg));
    } else {
      this.outputBuffer.push(msg);
    }
  }

  /**
   * Resolve workspace name to absolute path.
   */
  private resolveWorkspace(name?: string): string {
    const wsName = name ?? this.config.defaultWorkspace;
    const path = this.config.workspaces[wsName];
    if (!path) {
      throw new Error(`Unknown workspace: ${wsName}. Available: ${Object.keys(this.config.workspaces).join(", ")}`);
    }
    return path;
  }

  /**
   * Start a new session in the given workspace.
   */
  async newSession(workspaceName?: string): Promise<void> {
    // Stop existing session
    await this.stopSession();

    const wsName = workspaceName ?? this.config.defaultWorkspace;
    this.workspace = wsName;
    const workspacePath = this.resolveWorkspace(wsName);

    log.info("Starting new session", { workspace: wsName, path: workspacePath });

    this.send({ type: "status", state: "session_ended" });
    this.sessionId = null;
    // session_info is sent when the first sendMessage() processes the SDK init event
  }

  /**
   * Send a message to the Claude Code session and stream the response.
   */
  async sendMessage(text: string): Promise<void> {
    const workspacePath = this.resolveWorkspace(this.workspace);

    this.send({ type: "status", state: "thinking" });

    const guardianCallback = this.guardian.createHookCallback();

    try {
      const q = query({
        prompt: text,
        options: {
          model: this.config.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          cwd: workspacePath,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          hooks: {
            PreToolUse: [
              {
                hooks: [guardianCallback],
              },
            ],
          },
          env: {
            ...process.env,
            CLAUDECODE: undefined,
          },
        },
      });

      this.activeQuery = q;

      let resultText = "";

      for await (const message of q) {
        const msg = message as SDKMessage;

        // Capture session ID from init
        if (msg.type === "system" && (msg as any).subtype === "init") {
          this.sessionId = (msg as any).session_id;
          this.send({
            type: "session_info",
            sessionId: this.sessionId!,
            workspace: this.workspace,
          });
        }

        // Stream text chunks
        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            this.send({
              type: "message",
              text: event.delta.text,
              sessionId: this.sessionId ?? "unknown",
              final: false,
            });
          }
        }

        // Tool progress
        if (msg.type === "tool_progress") {
          this.send({ type: "status", state: "tool_running" });
        }

        // Assistant message — capture session ID
        if (msg.type === "assistant") {
          if ((msg as any).session_id) {
            this.sessionId = (msg as any).session_id;
          }
        }

        // Result message
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          this.sessionId = result.session_id;

          if (result.subtype === "success" && result.result) {
            resultText = result.result;
          } else if (result.subtype !== "success") {
            this.send({
              type: "error",
              message: `Session ended: ${result.subtype}`,
            });
          }

          log.info("Query complete", {
            sessionId: this.sessionId,
            cost: result.total_cost_usd,
            durationMs: result.duration_ms,
          });
        }
      }

      // Send final message
      this.send({
        type: "message",
        text: resultText,
        sessionId: this.sessionId ?? "unknown",
        final: true,
      });
    } catch (err) {
      log.error("Query failed", { error: String(err) });
      this.send({
        type: "error",
        message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.activeQuery = null;
      this.send({ type: "status", state: "idle" });
    }
  }

  /**
   * Stop the current session.
   */
  async stopSession(): Promise<void> {
    if (this.activeQuery) {
      log.info("Stopping active query", { sessionId: this.sessionId });
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }
}
```

- [ ] **Step 2:** Verify compiles

```bash
cd /Users/mokie/github/hive && npx tsc --noEmit src/beekeeper/session-manager.ts
```
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/session-manager.ts
git commit -m "feat(beekeeper): add session manager with SDK query, streaming, and resume"
```

---

### Task 4: Relay Server (Entry Point)

**Files:**
- Create: `src/beekeeper/index.ts`

- [ ] **Step 1:** Create `src/beekeeper/index.ts` — HTTP server + WebSocket with auth, message routing, health check

```typescript
import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import { createLogger } from "../logging/logger.js";
import { loadConfig } from "./config.js";
import { ToolGuardian } from "./tool-guardian.js";
import { SessionManager } from "./session-manager.js";
import type { ClientMessage, ServerMessage } from "./types.js";

const log = createLogger("beekeeper");

const config = loadConfig();
const guardian = new ToolGuardian(config.confirmOperations);
const sessionManager = new SessionManager(config, guardian);

// HTTP server for health check
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        sessionId: sessionManager.getSessionId(),
        workspace: sessionManager.getWorkspace(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// WebSocket server with auth on upgrade
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const token = url.searchParams.get("token") ?? req.headers.authorization?.replace("Bearer ", "");

  if (token !== config.authToken) {
    log.warn("WebSocket auth failed");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

// Single client connection management
let activeClient: WebSocket | null = null;

wss.on("connection", (ws: WebSocket) => {
  log.info("Client connected");

  // Replace previous client if any
  if (activeClient && activeClient.readyState === WebSocket.OPEN) {
    log.info("Replacing existing client connection");
    activeClient.close(1000, "Replaced by new connection");
  }

  activeClient = ws;
  guardian.setClient(ws);
  sessionManager.setClient(ws);

  // Send current session info or start new session
  const sessionId = sessionManager.getSessionId();
  if (sessionId) {
    const msg: ServerMessage = {
      type: "session_info",
      sessionId,
      workspace: sessionManager.getWorkspace(),
    };
    ws.send(JSON.stringify(msg));
  }

  ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      switch (msg.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;

        case "message":
          await sessionManager.sendMessage(msg.text);
          break;

        case "new_session":
          await sessionManager.newSession(msg.workspace);
          break;

        case "switch_workspace":
          await sessionManager.newSession(msg.workspace);
          break;

        case "approve":
          guardian.handleApproval(msg.toolUseId, true);
          break;

        case "deny":
          guardian.handleApproval(msg.toolUseId, false);
          break;

        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown message type` }));
      }
    } catch (err) {
      log.error("Error handling message", { type: msg.type, error: String(err) });
      ws.send(
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  ws.on("close", () => {
    log.info("Client disconnected");
    if (activeClient === ws) {
      activeClient = null;
      guardian.setClient(null);
      sessionManager.setClient(null);
    }
  });

  ws.on("error", (err) => {
    log.error("WebSocket error", { error: String(err) });
  });
});

// Start server
server.listen(config.port, () => {
  log.info("Beekeeper is running", { port: config.port });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log.info("Shutting down");
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("Shutting down");
  wss.close();
  server.close();
  process.exit(0);
});
```

- [ ] **Step 2:** Verify full build

```bash
cd /Users/mokie/github/hive && npm run build
```
Expected: compiles with no errors, `dist/beekeeper/index.js` exists

- [ ] **Step 3:** Smoke test — start server and hit health endpoint

```bash
# Create a minimal test config
cat > /tmp/beekeeper-test.yaml << 'EOF'
port: 3099
default_workspace: hive
model: claude-opus-4-5-20250514
workspaces:
  hive: ~/github/hive
confirm_operations:
  - "git push --force"
EOF

# Start server (will fail gracefully if no BEEKEEPER_AUTH_TOKEN, that's fine)
BEEKEEPER_AUTH_TOKEN=test-token BEEKEEPER_CONFIG=/tmp/beekeeper-test.yaml timeout 5 node dist/beekeeper/index.js &
sleep 2
curl -s http://localhost:3099/health | head -1
kill %1 2>/dev/null
```
Expected: `{"status":"ok","sessionId":null,"workspace":"hive"}`

- [ ] **Step 4:** Commit

```bash
git add src/beekeeper/index.ts
git commit -m "feat(beekeeper): add relay server — Express + WebSocket entry point"
```

---

### Task 5: Deploy Integration

**Files:**
- Create: `service/com.hive.beekeeper.plist`
- Modify: `service/deploy.sh`
- Modify: `.gitignore`

- [ ] **Step 1:** Create LaunchAgent plist at `service/com.hive.beekeeper.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hive.beekeeper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/mokie/services/hive/dist/beekeeper/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/mokie/services/hive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/mokie</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>BEEKEEPER_CONFIG</key>
    <string>beekeeper.yaml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/mokie/services/hive/logs-beekeeper/beekeeper.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mokie/services/hive/logs-beekeeper/beekeeper.err</string>
</dict>
</plist>
```

- [ ] **Step 2:** Add `beekeeper.yaml` to `.gitignore`

Add after the existing `hive.yaml` / `hive-personal.yaml` entries:
```
beekeeper.yaml
```

- [ ] **Step 3:** Add Beekeeper restart phase to `service/deploy.sh`

Add after the instance deploy loop (Phase 2) and before the report phase (Phase 3). Find the comment or section that starts the report/notification and insert before it:

```bash
# ── Phase 2b: Beekeeper ───────────────────────────
echo "==> Restarting Beekeeper..."
mkdir -p "$DEPLOY_DIR/logs-beekeeper"

# Install plist if not present
BEEKEEPER_PLIST="$HOME/Library/LaunchAgents/com.hive.beekeeper.plist"
if [ ! -f "$BEEKEEPER_PLIST" ]; then
  cp "$DEPLOY_DIR/service/com.hive.beekeeper.plist" "$BEEKEEPER_PLIST"
  launchctl bootstrap "gui/$(id -u)" "$BEEKEEPER_PLIST"
else
  launchctl kickstart -k "gui/$(id -u)/com.hive.beekeeper"
fi

# Health check
BEEKEEPER_OK=false
for _ in $(seq 1 15); do
  sleep 1
  if curl -sf http://localhost:3099/health >/dev/null 2>&1; then
    BEEKEEPER_OK=true
    break
  fi
done

if [ "$BEEKEEPER_OK" = true ]; then
  echo "  ✓ Beekeeper healthy"
else
  echo "  ✗ Beekeeper health check failed"
fi
```

- [ ] **Step 4:** Verify deploy script syntax

```bash
bash -n /Users/mokie/github/hive/service/deploy.sh
```
Expected: no syntax errors

- [ ] **Step 5:** Manual — Add Cloudflare Tunnel route

In the Cloudflare dashboard, add a route to the existing `dodi-shop` tunnel:
- Hostname: `beekeeper.dodihome.com`
- Service: `http://localhost:3099`
- Optional: add a Cloudflare Access policy restricting to May's email

- [ ] **Step 6:** Commit

```bash
git add service/com.hive.beekeeper.plist service/deploy.sh .gitignore
git commit -m "feat(beekeeper): add LaunchAgent plist and deploy integration"
```

---

### Task 6: End-to-End Test

**Files:** None (manual verification)

- [ ] **Step 1:** Create a `beekeeper.yaml` in the dev directory for local testing

```bash
cat > /Users/mokie/github/hive/beekeeper.yaml << 'EOF'
port: 3099
default_workspace: hive
model: claude-opus-4-5-20250514

workspaces:
  hive: ~/github/hive
  ios: ~/github/dodi-shop-ios
  dodi: ~/dev/dodi_v2
  marketing: ~/github/marketing

confirm_operations:
  - "git push --force"
  - "git branch -D"
  - "rm -rf"
  - "rm -r"
  - "git reset --hard"
  - "git checkout -- ."
  - "git clean -f"
EOF
```

- [ ] **Step 2:** Generate an auth token and add to `.env`

```bash
TOKEN=$(openssl rand -hex 32)
echo "BEEKEEPER_AUTH_TOKEN=$TOKEN" >> /Users/mokie/github/hive/.env
echo "Token: $TOKEN"
```

- [ ] **Step 3:** Build and start Beekeeper locally

```bash
cd /Users/mokie/github/hive && npm run build && node dist/beekeeper/index.js
```
Expected: `Beekeeper is running {"port":3099}`

- [ ] **Step 4:** Test WebSocket connection with wscat (in a separate terminal)

```bash
# Install wscat if needed: npm install -g wscat
wscat -c "ws://localhost:3099?token=<TOKEN>"
```

Then send test messages:
```json
{"type":"ping"}
```
Expected: `{"type":"pong"}`

```json
{"type":"message","text":"What files are in the current directory? Just list the first 5."}
```
Expected: streaming message chunks followed by a final message with `final: true`

```json
{"type":"new_session","workspace":"hive"}
```
Expected: `session_ended` status, then `session_info` with new session ID

- [ ] **Step 5:** Verify tool guardian by requesting a dangerous command

```json
{"type":"message","text":"Run: git push --force origin main"}
```
Expected: `tool_approval` message with the command, waiting for approve/deny

```json
{"type":"deny","toolUseId":"<id from tool_approval>"}
```
Expected: Claude responds acknowledging the command was blocked

- [ ] **Step 6:** Commit any final fixes from testing

```bash
git add -u
git commit -m "fix(beekeeper): adjustments from end-to-end testing"
```
