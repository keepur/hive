# Beekeeper Chat Resilience — Server-Side Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Close three protocol gaps between beekeeper and iOS client: relay AskUserQuestion as plain text, add non-destructive cancel, and send busy status instead of error.

**Architecture:** New `QuestionRelayer` class follows the existing `ToolGuardian` pattern — PreToolUse hook, Promise suspension, `setSendDelegate()` two-step init. Cancel adds a new client message type that calls `interrupt()` without destroying the session. Busy status is a one-line change from error to status message.

**Tech Stack:** TypeScript, Claude Agent SDK (PreToolUse hooks), WebSocket protocol

**Spec:** `docs/specs/2026-04-01-beekeeper-chat-resilience-design.md`
**Ticket:** #72

---

### Task 1: Type Changes

**Files:**
- Modify: `src/beekeeper/types.ts`

- [ ] **Step 1:** Add `cancel` to `ClientMessage` union and `"busy"` to status state

```typescript
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
  | { type: "ping" };

// Server → Client messages
export type ServerMessage =
  | { type: "message"; text: string; sessionId: string; final: boolean }
  | { type: "tool_approval"; toolUseId: string; tool: string; input: string; sessionId: string }
  | { type: "status"; state: "thinking" | "idle" | "tool_running" | "busy"; sessionId: string }
  | { type: "session_info"; sessionId: string; path: string }
  | { type: "session_list"; sessions: Array<{ sessionId: string; path: string; state: "idle" | "busy" }> }
  | { type: "session_cleared"; sessionId: string }
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
```

Two changes: `| { type: "cancel"; sessionId: string }` added before `ping`, and `"busy"` added to the status state union.

- [ ] **Step 2:** Verify types compile

Run: `cd ~/github/hive && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors (or only pre-existing ones unrelated to beekeeper)

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/types.ts
git commit -m "feat(beekeeper): add cancel message type and busy status state (#72)"
```

---

### Task 2: QuestionRelayer

**Files:**
- Create: `src/beekeeper/question-relayer.ts`

- [ ] **Step 1:** Create the QuestionRelayer class

```typescript
import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { ServerMessage } from "./types.js";

const log = createLogger("beekeeper-question-relayer");

interface PendingQuestion {
  resolve: (decision: HookJSONOutput) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  toolUseId: string;
}

export class QuestionRelayer {
  private pendingQuestions = new Map<string, PendingQuestion>();
  private sendDelegate: ((msg: ServerMessage) => void) | null = null;

  /**
   * Set the send delegate. Routes through SessionManager.send() which
   * broadcasts to all connected clients or buffers when none are connected.
   * Set once at startup — same pattern as ToolGuardian.
   */
  setSendDelegate(send: (msg: ServerMessage) => void): void {
    this.sendDelegate = send;
  }

  /**
   * Returns the hook callback for SDK PreToolUse registration.
   * Each callback is scoped to a specific session.
   */
  createHookCallback(sessionId: string): HookCallback {
    return async (
      input: HookInput,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PreToolUse") {
        return { decision: "approve" };
      }
      if (input.tool_name !== "AskUserQuestion") {
        return { decision: "approve" };
      }

      log.info("Intercepting AskUserQuestion", { toolUseId: input.tool_use_id, sessionId });

      if (!this.sendDelegate) {
        log.warn("No send delegate, blocking AskUserQuestion", { toolUseId: input.tool_use_id });
        return { decision: "block", reason: "No client connected to relay question" };
      }

      // Format questions as plain text
      const toolInput = input.tool_input as {
        questions?: Array<{
          question: string;
          multiSelect?: boolean;
          options?: Array<{ label: string; description?: string }>;
        }>;
      };
      const questions = toolInput?.questions ?? [];

      const lines: string[] = [];
      for (const q of questions) {
        lines.push(q.multiSelect ? `${q.question} (select multiple)` : q.question);
        if (q.options) {
          lines.push("");
          q.options.forEach((opt, i) => {
            const desc = opt.description ? ` — ${opt.description}` : "";
            lines.push(`${i + 1}. ${opt.label}${desc}`);
          });
        }
      }

      const text = lines.join("\n");
      this.sendDelegate({
        type: "message",
        text,
        sessionId,
        final: true,
      });

      // Supersede any existing pending question for this session
      const existing = this.pendingQuestions.get(sessionId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ decision: "block", reason: "Superseded by new question" });
        this.pendingQuestions.delete(sessionId);
        log.info("Superseded existing pending question", {
          sessionId,
          oldToolUseId: existing.toolUseId,
        });
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          log.warn("Question timed out", { toolUseId: input.tool_use_id, sessionId });
          this.pendingQuestions.delete(sessionId);
          resolve({ decision: "block", reason: "Question timed out (5m)" });
        }, 5 * 60_000);

        this.pendingQuestions.set(sessionId, {
          resolve,
          timer,
          sessionId,
          toolUseId: input.tool_use_id,
        });
      });
    };
  }

  /**
   * Resolve pending question with user's reply.
   */
  handleReply(sessionId: string, text: string): void {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) {
      log.warn("No pending question for reply", { sessionId });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingQuestions.delete(sessionId);
    log.info("Question answered", { sessionId, toolUseId: pending.toolUseId });
    pending.resolve({ decision: "block", reason: `User answered: ${text}` });
  }

  /**
   * Check if a question is pending for this session.
   */
  hasPending(sessionId: string): boolean {
    return this.pendingQuestions.has(sessionId);
  }

  /**
   * Clear one session's pending question (cancel/clear flow).
   */
  denyPending(sessionId: string, reason: string): void {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingQuestions.delete(sessionId);
    log.info("Denying pending question", { sessionId, toolUseId: pending.toolUseId, reason });
    pending.resolve({ decision: "block", reason });
  }

  /**
   * Clear ALL pending questions (shutdown flow).
   */
  denyAll(reason: string): void {
    for (const [sessionId, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      log.info("Auto-denying pending question", { sessionId, toolUseId: pending.toolUseId, reason });
      pending.resolve({ decision: "block", reason });
    }
    this.pendingQuestions.clear();
  }
}
```

- [ ] **Step 2:** Verify types compile

Run: `cd ~/github/hive && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/question-relayer.ts
git commit -m "feat(beekeeper): add QuestionRelayer for AskUserQuestion relay (#72)"
```

---

### Task 3: SessionManager Changes

**Files:**
- Modify: `src/beekeeper/session-manager.ts`

Six changes in this file. Apply them in order.

- [ ] **Step 1:** Add import for QuestionRelayer and add `interrupted` to SessionSlot

At line 7, add the import:

```typescript
import type { ToolGuardian } from "./tool-guardian.js";
import type { QuestionRelayer } from "./question-relayer.js";
```

Add `interrupted` to the `SessionSlot` interface:

```typescript
export interface SessionSlot {
  sessionId: string;
  cwd: string;
  activeQuery: Query | null;
  state: "idle" | "busy";
  cleared?: boolean;
  interrupted?: boolean;
  /** Resolves when runQuery finishes after a clear/interrupt */
  queryDone?: Promise<string>;
  outputBuffer: ServerMessage[];
}
```

- [ ] **Step 2:** Accept QuestionRelayer in constructor

```typescript
export class SessionManager {
  private sessions = new Map<string, SessionSlot>();
  private clients = new Map<string, WebSocket>();
  private guardian: ToolGuardian;
  private questionRelayer: QuestionRelayer;
  private config: BeekeeperConfig;
  private sessionsFile: string;
  /** Global buffer for messages sent when no clients are connected */
  private globalBuffer: ServerMessage[] = [];

  constructor(config: BeekeeperConfig, guardian: ToolGuardian, questionRelayer: QuestionRelayer) {
    this.config = config;
    this.guardian = guardian;
    this.questionRelayer = questionRelayer;
    this.sessionsFile = join(config.dataDir, "sessions.json");
  }
```

- [ ] **Step 3:** In `sendMessage`, check pending question before busy guard, and change busy error to status

Replace the entire `sendMessage` method:

```typescript
  /**
   * Send a message to a specific session.
   */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) {
      this.send({ type: "error", message: `Unknown session: ${sessionId}`, sessionId });
      return;
    }
    // Check if this reply answers a pending question
    if (this.questionRelayer.hasPending(sessionId)) {
      this.questionRelayer.handleReply(sessionId, text);
      return;
    }
    if (slot.state === "busy") {
      this.send({ type: "status", state: "busy", sessionId });
      return;
    }
    const done = this.runQuery(slot, text);
    slot.queryDone = done;
    await done;
  }
```

- [ ] **Step 4:** Add `cancelQuery` method

Add after `clearSession`:

```typescript
  /**
   * Cancel (interrupt without destroying) a specific session's active query.
   */
  async cancelQuery(sessionId: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot || !slot.activeQuery) return;

    // Clear pending question FIRST — closes reply-intercept window
    this.questionRelayer.denyPending(sessionId, "Operation cancelled");

    // Set interrupted flag BEFORE interrupt to suppress spurious empty final message
    slot.interrupted = true;

    // Then interrupt the SDK query
    try {
      await slot.activeQuery.interrupt();
    } catch (err) {
      log.error("Failed to interrupt session during cancel", { sessionId, error: String(err) });
    }
    // State transition handled by runQuery's finally block
  }
```

- [ ] **Step 5:** Also clear pending question in `clearSession` (before interrupt)

In `clearSession`, add `denyPending` call right after setting `slot.cleared = true`:

```typescript
  async clearSession(sessionId: string): Promise<boolean> {
    const slot = this.sessions.get(sessionId);
    if (!slot) return false;

    slot.cleared = true;
    this.questionRelayer.denyPending(sessionId, "Session cleared");
    if (slot.activeQuery) {
```

The rest of clearSession stays the same.

- [ ] **Step 6:** In `runQuery`, register both PreToolUse hooks, suppress final message when interrupted, clear interrupted in finally

Replace the `runQuery` method:

```typescript
  /**
   * Run a query in a session slot.
   */
  private async runQuery(slot: SessionSlot, text: string): Promise<string> {
    slot.state = "busy";
    this.send({ type: "status", state: "thinking", sessionId: slot.sessionId });

    const guardianCallback = this.guardian.createHookCallback(slot.sessionId);
    const questionCallback = this.questionRelayer.createHookCallback(slot.sessionId);

    try {
      const q = query({
        prompt: text,
        options: {
          model: this.config.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          cwd: slot.cwd,
          plugins: this.config.plugins?.map((p) => ({ type: "local" as const, path: p })),
          ...(slot.sessionId.startsWith("pending-") ? {} : { resume: slot.sessionId }),
          hooks: {
            PreToolUse: [
              {
                hooks: [guardianCallback],
              },
              {
                hooks: [questionCallback],
              },
            ],
          },
          env: this.cleanEnv(),
        },
      });

      slot.activeQuery = q;
      let resolvedSessionId = slot.sessionId;

      for await (const message of q) {
        const msg = message as SDKMessage;

        if (msg.type === "system" && (msg as any).subtype === "init") {
          resolvedSessionId = (msg as any).session_id;
          slot.sessionId = resolvedSessionId;
          this.send({
            type: "session_info",
            sessionId: resolvedSessionId,
            path: slot.cwd,
          });
        }

        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            this.send({
              type: "message",
              text: event.delta.text,
              sessionId: resolvedSessionId,
              final: false,
            });
          }
        }

        if (msg.type === "tool_progress") {
          this.send({ type: "status", state: "tool_running", sessionId: resolvedSessionId });
        }

        if (msg.type === "assistant") {
          if ((msg as any).session_id) {
            resolvedSessionId = (msg as any).session_id;
            slot.sessionId = resolvedSessionId;
          }
        }

        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          resolvedSessionId = result.session_id;
          slot.sessionId = resolvedSessionId;

          if (result.subtype !== "success") {
            this.send({
              type: "error",
              message: `Session ended: ${result.subtype}`,
              sessionId: resolvedSessionId,
            });
          }

          log.info("Query complete", {
            sessionId: resolvedSessionId,
            cost: result.total_cost_usd,
            durationMs: result.duration_ms,
          });
        }
      }

      // Suppress empty final message after interrupt — prevents empty bubble on client
      if (!slot.interrupted) {
        this.send({
          type: "message",
          text: "",
          sessionId: resolvedSessionId,
          final: true,
        });
      }

      return resolvedSessionId;
    } catch (err) {
      log.error("Query failed", { sessionId: slot.sessionId, error: String(err) });
      this.send({
        type: "error",
        message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
        sessionId: slot.sessionId,
      });
      return slot.sessionId;
    } finally {
      slot.activeQuery = null;
      slot.state = "idle";
      slot.interrupted = false;
      // Suppress status messages for cleared sessions — session_cleared is the terminal event
      if (!slot.cleared) {
        this.send({ type: "status", state: "idle", sessionId: slot.sessionId });
      }
    }
  }
```

- [ ] **Step 7:** Verify types compile

Run: `cd ~/github/hive && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: error in `index.ts` (constructor now requires 3 args) — that's expected, fixed in Task 4

- [ ] **Step 8:** Commit

```bash
git add src/beekeeper/session-manager.ts
git commit -m "feat(beekeeper): wire QuestionRelayer, cancelQuery, busy status in SessionManager (#72)"
```

---

### Task 4: Index Wiring

**Files:**
- Modify: `src/beekeeper/index.ts`

- [ ] **Step 1:** Add QuestionRelayer import

At line 8, add:

```typescript
import { QuestionRelayer } from "./question-relayer.js";
```

- [ ] **Step 2:** Instantiate QuestionRelayer and pass to SessionManager

Replace the guardian/sessionManager construction block (lines 21–23):

```typescript
  const guardian = new ToolGuardian(config.confirmOperations);
  const questionRelayer = new QuestionRelayer();
  const sessionManager = new SessionManager(config, guardian, questionRelayer);
  sessionManager.restoreSessions();
```

- [ ] **Step 3:** Wire QuestionRelayer send delegate

Add one line after the existing `guardian.setSendDelegate(...)` call (line 33). The guardian line already exists — only add the questionRelayer line:

```typescript
  questionRelayer.setSendDelegate((msg) => sessionManager.send(msg));
```

- [ ] **Step 4:** Add `cancel` case to the WebSocket message switch

Add between `clear_session` and `list_sessions` cases:

```typescript
          case "cancel":
            await sessionManager.cancelQuery(msg.sessionId);
            break;
```

- [ ] **Step 5:** Deny pending questions when all clients disconnect

In the `ws.on("close")` handler, after removing the client, check if no clients remain and deny all pending questions. This prevents a 5-minute stuck session when the user disconnects mid-question.

Replace the existing close handler:

```typescript
    ws.on("close", () => {
      // Guard: only remove if this specific ws is still the registered client.
      // A stale close from an old socket must not evict a newer connection.
      if (connectedClients.get(device._id) === ws) {
        connectedClients.delete(device._id);
        sessionManager.removeClient(device._id);
      }
      log.info("Client disconnected", { deviceId: device._id, remainingClients: connectedClients.size });
      // If no clients remain, deny all pending questions — no one can answer them
      if (connectedClients.size === 0) {
        questionRelayer.denyAll("All clients disconnected");
      }
      // Sessions stay in memory — any device can reconnect and resume
    });
```

- [ ] **Step 6:** Deny pending questions on shutdown

In the shutdown handler, add `questionRelayer.denyAll` before `stopAll`:

```typescript
  const shutdown = async () => {
    log.info("Shutting down");
    sessionManager.persistSessions();
    questionRelayer.denyAll("Server shutting down");
    await sessionManager.stopAll();
    wss.close();
    server.close();
    await deviceRegistry.close();
    process.exit(0);
  };
```

- [ ] **Step 7:** Verify full build

Run: `cd ~/github/hive && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: no errors

Run: `cd ~/github/hive && npm run build 2>&1 | tail -10`
Expected: clean build

- [ ] **Step 8:** Commit

```bash
git add src/beekeeper/index.ts
git commit -m "feat(beekeeper): wire QuestionRelayer, cancel, and disconnect cleanup in index (#72)"
```

---

### Task 5: Build Verification

- [ ] **Step 1:** Full build

Run: `cd ~/github/hive && npm run build 2>&1 | tail -20`
Expected: clean build, no errors

- [ ] **Step 2:** Lint check (if configured)

Run: `cd ~/github/hive && npm run lint 2>&1 | tail -20`
Expected: no new errors in beekeeper files

- [ ] **Step 3:** Verify no regressions — existing types still match

Run: `cd ~/github/hive && npx tsc --noEmit --pretty 2>&1 | tail -20`
Expected: clean
