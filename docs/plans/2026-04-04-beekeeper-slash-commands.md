# Beekeeper Slash Commands Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add server-side slash command detection (`/clear`, `/help`, `/status`) so iOS clients can manage sessions inline, replacing the cosmetic "clear context" pattern with real session teardown and fresh creation.

**Architecture:** Command detection hooks into `SessionManager.sendMessage()` before the busy check. A `Map<string, CommandDef>` registry populated in the constructor routes known commands to handlers. Unknown `/foo` falls through to the SDK as normal text. `/clear` sends `context_cleared` to the client first, tears down the old session inline, then calls `newSession()`.

**Tech Stack:** TypeScript, vitest, `@anthropic-ai/claude-agent-sdk`

**Out of scope:** iOS client changes (`WSMessage.swift`, `ChatViewModel.swift`) — the `.unknown` decoder fallback means older clients won't crash. iOS support for `context_cleared` will be a separate task.

---

### Task 1: Add `context_cleared` to ServerMessage

**Files:**
- Modify: `src/beekeeper/types.ts:40` (after `session_cleared` line 28)

- [ ] **Step 1:** Add the new union member to `ServerMessage`

In `src/beekeeper/types.ts`, add the `context_cleared` type to the `ServerMessage` union. Insert it after the `session_cleared` line (line 28):

```typescript
// In types.ts, line 28 currently reads:
//   | { type: "session_cleared"; sessionId: string }
// Add after it:
  | { type: "context_cleared"; oldSessionId: string; sessionId: string }
```

The full edit — replace:
```
  | { type: "session_cleared"; sessionId: string }
  | { type: "browse_result"; path: string; entries: Array<{ name: string; isDirectory: boolean }> }
```
with:
```
  | { type: "session_cleared"; sessionId: string }
  | { type: "context_cleared"; oldSessionId: string; sessionId: string }
  | { type: "browse_result"; path: string; entries: Array<{ name: string; isDirectory: boolean }> }
```

**Why `sessionId`?** The `send()` method uses `"sessionId" in msg` to route buffered messages to the correct per-session buffer. Without `sessionId`, `context_cleared` would fall into `globalBuffer` and get replayed to reconnecting clients for a session that no longer exists. The `sessionId` field is set to the old session ID (same as `oldSessionId`) so it routes correctly. iOS client should use `oldSessionId` for clearing logic.

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/types.ts
git commit -m "feat(beekeeper): add context_cleared to ServerMessage type"
```

---

### Task 2: Add command registry and detection to SessionManager

**Files:**
- Modify: `src/beekeeper/session-manager.ts:14-41` (SessionSlot interface area + constructor)

- [ ] **Step 1:** Add `CommandDef` interface after the `SessionSlot` export (line 24)

After the closing `}` of `SessionSlot` (line 24), add:

```typescript
interface CommandDef {
  description: string;
  handler: (sessionId: string, args: string[], slot: SessionSlot) => Promise<void>;
}
```

Note: intentionally not exported — `CommandDef` is an internal implementation detail of `SessionManager`.

- [ ] **Step 2:** Add `commands` Map field to `SessionManager`

In the `SessionManager` class, after line 34 (`private globalBuffer: ServerMessage[] = [];`), add:

```typescript
  private commands = new Map<string, CommandDef>();
```

- [ ] **Step 3:** Populate the command registry at the end of the constructor

In the constructor (after line 40 `this.sessionsFile = join(config.dataDir, "sessions.json");`), add command registrations:

```typescript
    // Register slash commands
    this.commands.set("clear", {
      description: "Reset context and start a fresh session",
      handler: (sessionId, _args, slot) => this.handleClear(sessionId, slot),
    });
    this.commands.set("help", {
      description: "Show available commands",
      handler: (sessionId) => this.handleHelp(sessionId),
    });
    this.commands.set("status", {
      description: "Show current session info",
      handler: (sessionId, _args, slot) => this.handleStatus(sessionId, slot),
    });
```

- [ ] **Step 4:** Add command detection to `sendMessage()` — before the busy check

Replace the current `sendMessage()` method (lines 131-144):

```typescript
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) {
      this.send({ type: "error", message: `Unknown session: ${sessionId}`, sessionId });
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

with:

```typescript
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) {
      this.send({ type: "error", message: `Unknown session: ${sessionId}`, sessionId });
      return;
    }

    // Slash command detection — runs BEFORE busy check
    if (text.startsWith("/")) {
      const parts = text.trimEnd().split(/\s+/);
      const name = parts[0].slice(1).toLowerCase();
      const cmd = this.commands.get(name);
      if (cmd) {
        log.info("Executing slash command", { sessionId, command: name });
        await cmd.handler(sessionId, parts.slice(1), slot);
        return;
      }
      // Unknown command — fall through to SDK as normal text
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

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit`
Expected: Errors about missing `handleClear`, `handleHelp`, `handleStatus` methods (we add those next). That's expected — don't commit yet.

---

### Task 3: Implement `/help` handler

**Files:**
- Modify: `src/beekeeper/session-manager.ts` (add private method before `runQuery`)

- [ ] **Step 1:** Add `handleHelp` private method

Insert before the `private async runQuery(...)` method (line 340):

```typescript
  /**
   * /help — list available slash commands.
   */
  private async handleHelp(sessionId: string): Promise<void> {
    const lines = ["Available commands:"];
    for (const [name, def] of this.commands) {
      lines.push(`  /${name}  — ${def.description}`);
    }
    this.send({ type: "message", text: lines.join("\n"), sessionId, final: true });
  }
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Still errors for `handleClear` and `handleStatus` — that's fine.

---

### Task 4: Implement `/status` handler

**Files:**
- Modify: `src/beekeeper/session-manager.ts` (add private method after `handleHelp`)

- [ ] **Step 1:** Add `handleStatus` private method

Insert right after `handleHelp`:

```typescript
  /**
   * /status — show session metadata.
   */
  private async handleStatus(sessionId: string, slot: SessionSlot): Promise<void> {
    const lines = [
      `Session: ${slot.sessionId}`,
      `Workspace: ${slot.cwd}`,
      `State: ${slot.state}`,
    ];
    this.send({ type: "message", text: lines.join("\n"), sessionId, final: true });
  }
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Still error for `handleClear` — one more to go.

---

### Task 5: Implement `/clear` handler

**Files:**
- Modify: `src/beekeeper/session-manager.ts` (add private method after `handleStatus`)

- [ ] **Step 1:** Fix `newSession()` to set `queryDone` (pre-existing gap)

In `newSession()` (around line 117), the `runQuery` result is awaited directly but `slot.queryDone` is never set. This means if `/clear` fires during the inaugural greeting query, `handleClear` can't await it. Fix:

Replace:
```typescript
    const realId = await this.runQuery(slot, "You are now connected. Briefly acknowledge readiness.");
```
with:
```typescript
    const done = this.runQuery(slot, "You are now connected. Briefly acknowledge readiness.");
    slot.queryDone = done;
    const realId = await done;
```

- [ ] **Step 2:** Add `handleClear` private method

Insert right after `handleStatus`:

```typescript
  /**
   * /clear — destroy the current session and create a fresh one.
   *
   * Flow:
   * 1. Send context_cleared to client FIRST (so it can wipe the chat view)
   * 2. Tear down the old session inline (interrupt if busy, remove from map)
   * 3. Call newSession(cwd) — spawns fresh SDK session
   *
   * Does NOT call clearSession() — that emits session_cleared which would
   * create confusing duplicate signals for the client.
   */
  private async handleClear(sessionId: string, slot: SessionSlot): Promise<void> {
    const cwd = slot.cwd;

    // 1. Notify client to wipe the chat view
    this.send({ type: "context_cleared", oldSessionId: sessionId, sessionId });

    // 2. Tear down old session inline
    slot.cleared = true;
    if (slot.activeQuery) {
      try {
        await slot.activeQuery.interrupt();
      } catch (err) {
        log.error("Failed to interrupt session during /clear", { sessionId, error: String(err) });
      }
      if (slot.queryDone) {
        try {
          await slot.queryDone;
        } catch {
          // Already handled inside runQuery
        }
      }
    }
    this.sessions.delete(sessionId);
    this.persistSessions();
    log.info("Session torn down for /clear", { sessionId });

    // 3. Create fresh session on same workspace
    await this.newSession(cwd);
  }
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

- [ ] **Step 3:** Commit all SessionManager changes

```bash
git add src/beekeeper/session-manager.ts
git commit -m "feat(beekeeper): add slash command registry with /clear, /help, /status"
```

---

### Task 6: Add tests for slash commands

**Files:**
- Modify: `src/beekeeper/session-manager.test.ts` (add new describe block)

- [ ] **Step 1:** Add a `describe("slash commands")` block after the last `describe` block (after line 421, before the closing `});` of the root describe)

Insert before the final `});` at line 422:

```typescript
  describe("slash commands", () => {
    // Helper: create a session and return its ID + cleared ws mock
    async function setupSession(manager: SessionManager, ws: ReturnType<typeof makeMockWs>) {
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-cmd" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );
      const sessionId = await manager.newSession("/tmp/test");
      ws.send.mockClear();
      return sessionId;
    }

    it("/help sends command list as message", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      await manager.sendMessage(sessionId, "/help");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const helpMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
      );
      expect(helpMsg).toBeDefined();
      expect(helpMsg.text).toContain("/clear");
      expect(helpMsg.text).toContain("/help");
      expect(helpMsg.text).toContain("/status");
      expect(helpMsg.final).toBe(true);
    });

    it("/status sends session metadata as message", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      await manager.sendMessage(sessionId, "/status");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const statusMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Session:"),
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.text).toContain("sess-cmd");
      expect(statusMsg.text).toContain("/tmp/test");
      expect(statusMsg.text).toContain("idle");
      expect(statusMsg.final).toBe(true);
    });

    it("/clear sends context_cleared, destroys session, creates new one", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Mock for the new session created by /clear
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-fresh" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-fresh",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // context_cleared should be the FIRST message sent
      expect(sent[0]).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });

      // New session_info should appear
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.sessionId).toBe("sess-fresh");

      // Old session should be gone
      ws.send.mockClear();
      await manager.sendMessage(sessionId, "after clear");
      const errorSent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = errorSent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg?.message).toContain("Unknown session");
    });

    it("unknown /command falls through to SDK as normal text", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Mock for the SDK query that receives the unknown command as text
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "I don't know that command" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/unknown foo bar");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      // Should NOT see context_cleared or any command response
      expect(sent.find((m: Record<string, unknown>) => m.type === "context_cleared")).toBeUndefined();
      // Should see the SDK response streamed through
      const textMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && m.text === "I don't know that command",
      );
      expect(textMsg).toBeDefined();
    });

    it("/help works even when session is busy", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Make the session busy
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      const queryPromise = manager.sendMessage(sessionId, "Make me busy");
      await new Promise((r) => setTimeout(r, 10));

      ws.send.mockClear();

      // /help should work despite busy state
      await manager.sendMessage(sessionId, "/help");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const helpMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
      );
      expect(helpMsg).toBeDefined();

      // Clean up
      resolveQuery?.();
      await queryPromise;
    });

    it("/clear is case-insensitive", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-fresh2" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-fresh2",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/CLEAR");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      expect(sent[0]).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });
    });

    it("/clear works when session is busy — interrupts active query", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Make the session busy with a hanging query
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(() => {
          resolveQuery?.();
        }),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      const queryPromise = manager.sendMessage(sessionId, "Make me busy");
      await new Promise((r) => setTimeout(r, 10));

      ws.send.mockClear();

      // Mock for the new session created by /clear
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-cleared" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cleared",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      // /clear should work despite busy state
      await manager.sendMessage(sessionId, "/clear");

      // Wait for the hanging query to finish
      await queryPromise;

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // interrupt() should have been called
      expect(hangingIterable.interrupt).toHaveBeenCalled();

      // context_cleared should appear
      const cleared = sent.find((m: Record<string, unknown>) => m.type === "context_cleared");
      expect(cleared).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });

      // New session should exist
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.sessionId).toBe("sess-cleared");
    });

    it("text not starting with / goes to SDK normally", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi!" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "Hello there");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const textMsg = sent.find((m: Record<string, unknown>) => m.type === "message" && m.text === "Hi!");
      expect(textMsg).toBeDefined();
    });
  });
```

- [ ] **Step 2:** Verify tests pass

Run: `npx vitest run src/beekeeper/`
Expected: All tests pass (existing + new slash command tests)

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/session-manager.test.ts
git commit -m "test(beekeeper): add slash command tests — /clear, /help, /status, fallback"
```

---

### Task 7: Build and final verification

**Files:** (none — verification only)

- [ ] **Step 1:** Typecheck

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 2:** Full test suite

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3:** Build

Run: `npm run build`
Expected: Clean build, no errors
