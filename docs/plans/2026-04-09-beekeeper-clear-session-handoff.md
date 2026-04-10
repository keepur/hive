# Beekeeper `/clear` Session Handoff Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Goal:** Make `/clear` atomically hand off a fresh session to the client by replacing `context_cleared` with a new `session_replaced` WS message and refactoring `newSession()` to return early on SDK init.

**Architecture:** Protocol-level change on the beekeeper WebSocket. `runQuery` gains an options object (`suppressClientSignals`, `onInit`) so `newSession()` can return the real session ID as soon as the SDK emits `init`, and `handleClear()` can emit a single atomic swap signal before any new-session events reach the client. The non-`/clear` `new_session` path is unchanged behaviorally.

**Tech Stack:** TypeScript, Node 24, `@anthropic-ai/claude-agent-sdk`, `ws`, Vitest.

**Spec:** `docs/specs/2026-04-09-beekeeper-clear-session-handoff-design.md`

**Ticket:** dodi-hq/hive#113

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/beekeeper/types.ts` | Modify | Remove `context_cleared`, add `session_replaced` |
| `src/beekeeper/session-manager.ts` | Modify | `runQuery` opts, `newSession` early-return, `handleClear` emit |
| `src/beekeeper/session-manager.test.ts` | Modify | Update existing `/clear` tests, add 3 new cases |

No new files.

---

## Task 1: Protocol + server refactor + test updates

This task ships as **one commit** because the protocol change, the server refactor, and the existing test assertions are all tightly coupled — splitting them leaves `npm run check` red.

**Files:**
- Modify: `src/beekeeper/types.ts` (lines 18–44)
- Modify: `src/beekeeper/session-manager.ts` (lines 121–149, 408–452, 457–504)
- Modify: `src/beekeeper/session-manager.test.ts` (all existing `/clear` assertions + the `context_cleared` mentions)

### Step 1.1: Update protocol types

- [ ] Edit `src/beekeeper/types.ts`. Replace the `context_cleared` union member with `session_replaced`:

```ts
  | { type: "session_cleared"; sessionId: string }
  | { type: "session_replaced"; oldSessionId: string; newSessionId: string; path: string }
  | { type: "browse_result"; path: string; entries: Array<{ name: string; isDirectory: boolean }> }
```

(Delete the line `| { type: "context_cleared"; oldSessionId: string; sessionId: string }`.)

### Step 1.2: Add `createDeferred` helper and `RunQueryOptions` interface

- [ ] In `src/beekeeper/session-manager.ts`, add a file-scope helper just above the `SessionManager` class (after the `CommandDef` interface, around line 30):

```ts
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RunQueryOptions {
  /**
   * When true, suppress the initial `status(thinking)` emit and the
   * `session_info` emit on SDK init. Used by /clear to avoid leaking
   * intermediate new-session signals to the client before session_replaced.
   */
  suppressClientSignals?: boolean;
  /**
   * Called synchronously when the SDK's `system/init` message arrives,
   * carrying the real session_id. Used by newSession() to return early.
   */
  onInit?: (realSessionId: string) => void;
}
```

### Step 1.3: Refactor `runQuery` to accept options

- [ ] In `src/beekeeper/session-manager.ts`, change the `runQuery` signature from:

```ts
private async runQuery(slot: SessionSlot, text: string): Promise<string> {
```

to:

```ts
private async runQuery(slot: SessionSlot, text: string, opts?: RunQueryOptions): Promise<string> {
```

- [ ] Gate the initial `status(thinking)` emit (line 459) on `!opts?.suppressClientSignals`:

```ts
  private async runQuery(slot: SessionSlot, text: string, opts?: RunQueryOptions): Promise<string> {
    slot.state = "busy";
    if (!opts?.suppressClientSignals) {
      this.send({ type: "status", state: "thinking", sessionId: slot.sessionId });
    }

    const guardianCallback = this.guardian.createHookCallback(slot.sessionId);
```

- [ ] Inside the `for await` loop, update the `system/init` branch to gate the `session_info` emit and fire `onInit`:

```ts
        if (msg.type === "system" && (msg as any).subtype === "init") {
          resolvedSessionId = (msg as any).session_id;
          slot.sessionId = resolvedSessionId;
          if (!opts?.suppressClientSignals) {
            this.send({
              type: "session_info",
              sessionId: resolvedSessionId,
              path: slot.cwd,
            });
          }
          opts?.onInit?.(resolvedSessionId);
        }
```

### Step 1.4: Refactor `newSession()` to return early on init

- [ ] Replace the body of `newSession()` (`src/beekeeper/session-manager.ts:124-149`) with:

```ts
  /**
   * Create a new session in the given cwd. Spawns SDK and returns as soon as
   * the `system/init` event fires (carrying the real session_id). The welcome
   * query continues streaming in the background.
   *
   * When called from /clear, pass `suppressClientSignals: true` so the
   * bootstrap query does not leak `status(thinking)` or `session_info` to the
   * client before handleClear can emit session_replaced.
   */
  async newSession(cwd: string, opts?: { suppressClientSignals?: boolean }): Promise<string> {
    log.info("Creating new session", { cwd });
    const pendingId = `pending-${randomUUID()}`;
    const slot: SessionSlot = {
      sessionId: pendingId,
      cwd,
      activeQuery: null,
      state: "idle",
      outputBuffer: [],
    };

    // Register immediately so the session is visible during the inaugural query
    this.sessions.set(pendingId, slot);

    const initDeferred = createDeferred<string>();
    let initFired = false;

    const donePromise = this.runQuery(slot, "You are now connected. Briefly acknowledge readiness.", {
      suppressClientSignals: opts?.suppressClientSignals,
      onInit: (realId) => {
        initFired = true;
        initDeferred.resolve(realId);
      },
    });

    // If runQuery settles without init ever firing, reject the init deferred
    // so newSession() doesn't hang forever. Covers both:
    //   - SDK throws/errors before init (donePromise rejects)
    //   - SDK returns a `result` before emitting `system/init` (donePromise resolves)
    donePromise.finally(() => {
      if (!initFired) {
        initDeferred.reject(
          new Error("Session never initialized (SDK completed without init event)"),
        );
      }
    });
    // Swallow any unhandled rejection on donePromise itself. runQuery has a
    // top-level try/catch that normally converts errors to error-message sends
    // and a normal return, so this is defensive. In the init-never-fires path
    // the caller awaits initDeferred.promise (which we rejected above), and
    // nothing else awaits donePromise in that path — avoid the unhandled
    // rejection warning.
    donePromise.catch(() => {});

    slot.queryDone = donePromise;

    const realId = await initDeferred.promise;

    // Swap the map key from pending to real. Welcome stream continues in the
    // background and now routes via this slot's outputBuffer when offline.
    this.sessions.delete(pendingId);
    slot.sessionId = realId;
    this.sessions.set(realId, slot);
    this.persistSessions();
    log.info("Session created", { sessionId: realId, cwd });
    return realId;
  }
```

### Step 1.5: Refactor `handleClear()` to emit `session_replaced`

- [ ] Replace the body of `handleClear()` (`src/beekeeper/session-manager.ts:393-452`) with:

```ts
  /**
   * /clear — destroy the current session and create a fresh one, then emit
   * a single atomic session_replaced message so the client can swap sessions
   * without ambiguity.
   *
   * Flow:
   * 1. Tear down old session inline (interrupt if busy, await, remove from map)
   * 2. Create fresh session with suppressClientSignals so no intermediate
   *    status/session_info reaches the client before session_replaced
   * 3. Emit session_replaced { oldSessionId, newSessionId, path }
   * 4. Welcome stream continues in the background and lands on the client
   *    naturally under the new sessionId
   *
   * On newSession() failure (including the init-never-fires case), emit an
   * error and do NOT emit session_replaced. Client stays in its loading state
   * and the user can retry manually.
   *
   * Guarded by slot.clearing to prevent concurrent /clear calls from
   * creating duplicate sessions.
   */
  private async handleClear(sessionId: string, slot: SessionSlot): Promise<void> {
    // Guard against concurrent /clear calls on the same session
    if (slot.clearing) return;
    slot.clearing = true;

    const cwd = slot.cwd;
    const oldSessionId = sessionId;

    // 1. Tear down old session inline
    slot.cleared = true;
    if (slot.activeQuery) {
      try {
        await slot.activeQuery.interrupt();
      } catch (err) {
        log.error("Failed to interrupt session during /clear", { sessionId, error: String(err) });
      }
    }
    // Await queryDone independently — activeQuery is nulled in runQuery's finally
    // block before queryDone resolves, so the guard must be separate to avoid a race.
    if (slot.queryDone) {
      try {
        await slot.queryDone;
      } catch {
        // Already handled inside runQuery
      }
    }
    this.sessions.delete(sessionId);
    this.persistSessions();
    log.info("Session torn down for /clear", { sessionId });

    // 2. Create fresh session with client signals suppressed so nothing about
    //    the new session reaches the client before session_replaced.
    let newSessionId: string;
    try {
      newSessionId = await this.newSession(cwd, { suppressClientSignals: true });
    } catch (err) {
      log.error("Failed to create new session after /clear", { cwd, error: String(err) });
      this.send({
        type: "error",
        message: `Context cleared but failed to start new session: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // 3. Emit the atomic swap signal. The welcome stream continues in the
    //    background and lands under newSessionId, which the client has now
    //    adopted.
    this.send({
      type: "session_replaced",
      oldSessionId,
      newSessionId,
      path: cwd,
    });
  }
```

### Step 1.6: Update existing `/clear` tests

- [ ] In `src/beekeeper/session-manager.test.ts`, find every assertion referencing `context_cleared` and update it to assert `session_replaced` instead. The existing tests are:

  1. `"/clear sends context_cleared, destroys session, creates new one"` (around line 484) — rename test description to `"/clear sends session_replaced, destroys session, creates new one"`. Update assertions:

     ```ts
     // OLD:
     // expect(sent[0]).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });
     // NEW:
     const replaced = sent.find((m: Record<string, unknown>) => m.type === "session_replaced");
     expect(replaced).toBeDefined();
     expect(replaced.oldSessionId).toBe(sessionId);
     expect(replaced.newSessionId).toBe("sess-fresh");
     expect(replaced.path).toBeDefined();

     // Assert context_cleared is NOT emitted anymore:
     expect(sent.find((m: Record<string, unknown>) => m.type === "context_cleared")).toBeUndefined();
     ```

  2. `"/clear is case-insensitive"` (around line 607) — the existing assertion is `expect(sent[0]).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId })`. Replace with field-level assertions because the new shape has no `sessionId` field:

     ```ts
     const replaced = sent.find((m: Record<string, unknown>) => m.type === "session_replaced");
     expect(replaced).toBeDefined();
     expect(replaced.oldSessionId).toBe(sessionId);
     expect(typeof replaced.newSessionId).toBe("string");
     expect(replaced.path).toBeDefined();
     ```

  3. `"/clear works when session is busy — interrupts active query"` (around line 633) — same pattern as (2). Do NOT use `toEqual({ type: "context_cleared", ... })`; use the `find` + field-level assertions above.

  4. `"/clear when interrupt() throws — logs error but still creates new session"` (around line 833) — same pattern as (2).

  5. `"/clear when newSession() SDK fails — sends error, does not throw"` (around line 898) — assert an `error` message is present **and** no `session_replaced` is present:

     ```ts
     expect(sent.find((m: Record<string, unknown>) => m.type === "error")).toBeDefined();
     expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();
     ```

     **Note:** under the new flow, the client may see *two* `error` messages in this path: one from `runQuery`'s internal try/catch (wrapping the SDK error, e.g. `"Query failed: SDK connection failed"`) and one from `handleClear`'s wrapper (`"Context cleared but failed to start new session: ..."`). The `find(type === "error")` assertion is satisfied by either. Do not use `filter(...).toHaveLength(1)` here — it will fail.

  6. `"concurrent /clear calls — second call is a no-op"` (around line 934) — assert exactly one `session_replaced` across both calls:

     ```ts
     const replacedMessages = sent.filter((m: Record<string, unknown>) => m.type === "session_replaced");
     expect(replacedMessages).toHaveLength(1);
     ```

  7. `'"/ clear" (space after slash) falls through to SDK'` (around line 783) — the existing assertion already checks that `context_cleared` is NOT present. Update to check `session_replaced` is not present instead.

- [ ] Also search for any remaining `"context_cleared"` references in the test file and delete/update:

  Use the Grep tool: pattern `context_cleared`, path `src/beekeeper/session-manager.test.ts`.
  Expected: no results after the update.

- [ ] For test (1) above, the mock SDK iterator for the new session (already set up in the test) uses `session_id: "sess-fresh"`. Because `runQuery` now gates `session_info` behind `suppressClientSignals: true`, the test should no longer expect a `session_info` emit between the old session teardown and the `session_replaced` message. Remove any assertion that expects `session_info` with the new sessionId in the clear flow.

### Step 1.7: Verify

- [ ] Run the test suite for the beekeeper module:

  Run: `npm run test -- src/beekeeper/session-manager.test.ts`
  Expected: all tests pass, no `context_cleared` references remain.

- [ ] Run typecheck:

  Run: `npm run typecheck`
  Expected: clean, no errors.

### Step 1.8: Commit

```bash
git add src/beekeeper/types.ts src/beekeeper/session-manager.ts src/beekeeper/session-manager.test.ts
git commit -m "$(cat <<'EOF'
HIVE-113: replace context_cleared with atomic session_replaced

Refactor runQuery to accept suppressClientSignals + onInit options.
newSession now returns early on SDK init via a Deferred, with a
.finally() guard against init-never-fires. handleClear uses the
suppressed bootstrap path so no intermediate new-session signals
reach the client before the session_replaced swap signal.

Updates existing /clear tests to assert the new protocol.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: New test coverage

Add the three new test cases the spec calls for.

**Files:**
- Modify: `src/beekeeper/session-manager.test.ts`

### Step 2.1: Add "session_replaced fires before any new-session signals reach the client"

- [ ] Inside the `describe("slash commands", ...)` block (or wherever the existing `/clear` tests live), add:

```ts
    it("/clear: session_replaced fires before any new-session signals reach the client", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Fresh session mock: init event, then a text delta from the welcome stream, then result.
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-new" },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Ready." },
            },
            session_id: "sess-new",
          },
          {
            type: "result",
            subtype: "success",
            result: "Ready.",
            session_id: "sess-new",
            total_cost_usd: 0.001,
            duration_ms: 10,
          },
        ]),
      );

      ws.send.mockClear();
      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // (a) session_replaced must appear on the wire
      const replacedIdx = sent.findIndex((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replacedIdx).toBeGreaterThanOrEqual(0);

      // (b) No session_info or status(thinking) for the new sessionId is ever emitted (suppressed)
      const newSessionInfo = sent.find(
        (m: Record<string, unknown>) => m.type === "session_info" && m.sessionId === "sess-new",
      );
      expect(newSessionInfo).toBeUndefined();

      const newThinking = sent.find(
        (m: Record<string, unknown>) =>
          m.type === "status" && m.state === "thinking" && m.sessionId === "sess-new",
      );
      expect(newThinking).toBeUndefined();

      // (c) Every welcome-stream message for the new sessionId arrives AFTER session_replaced.
      //     Ordering is deterministic because onInit resolves the init deferred synchronously
      //     from inside runQuery's for-await loop, which queues newSession's continuation
      //     (and therefore handleClear's session_replaced emit) as a microtask BEFORE the
      //     for-await loop's next iteration is scheduled.
      const newSessionMessageIndices = sent
        .map((m: Record<string, unknown>, idx: number) => ({ m, idx }))
        .filter(({ m }: { m: Record<string, unknown> }) => m.type === "message" && m.sessionId === "sess-new")
        .map(({ idx }: { idx: number }) => idx);
      expect(newSessionMessageIndices.length).toBeGreaterThan(0);
      for (const idx of newSessionMessageIndices) {
        expect(idx).toBeGreaterThan(replacedIdx);
      }
    });
```

### Step 2.2: Add "SDK completes without emitting init"

**Note on acceptable leakage:** Under this pathological path, before `newSession()` rejects, `runQuery` will process the result message and then hit its post-loop empty-final-message emit (`src/beekeeper/session-manager.ts:578-585`). That emit carries the pathological `session_id` from the SDK result. This is a known, minor leak for the init-never-fires edge case and is acceptable — the client already needs to ignore messages for unknown sessions during the `/clear` window, and the subsequent `error` message is the authoritative signal. The test below does **not** assert against this leak; it only asserts the error surfaces and `session_replaced` does not.

- [ ] Add immediately after the previous test:

```ts
    it("/clear: when SDK completes without emitting init, sends error and does not hang", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Pathological mock: SDK yields a result without ever emitting system/init.
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "result",
            subtype: "error",
            result: "",
            session_id: "never-initialized",
            total_cost_usd: 0,
            duration_ms: 5,
          },
        ]),
      );

      ws.send.mockClear();
      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // An error message must be emitted
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect((errorMsg.message as string)).toMatch(/failed to start new session/i);

      // No session_replaced was emitted
      expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();
    });
```

### Step 2.3: Add "non-clear new_session path still emits session_info and status on init"

- [ ] Add a regression test inside the existing `describe("newSession(cwd)", ...)` block (starts at line 77), immediately after the existing `"eagerly spawns a session..."` test:

```ts
    it("non-clear path still emits status(thinking) and session_info on init", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-plain" },
          {
            type: "result",
            subtype: "success",
            result: "Ready",
            session_id: "sess-plain",
            total_cost_usd: 0.001,
            duration_ms: 10,
          },
        ]),
      );

      // Call newSession WITHOUT suppressClientSignals (the non-clear path).
      await manager.newSession("/tmp/test");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // status(thinking) is emitted
      expect(
        sent.find((m: Record<string, unknown>) => m.type === "status" && m.state === "thinking"),
      ).toBeDefined();

      // session_info for the new sessionId is emitted
      const sessionInfo = sent.find(
        (m: Record<string, unknown>) => m.type === "session_info" && m.sessionId === "sess-plain",
      );
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.path).toBe("/tmp/test");
    });
```

### Step 2.4: Verify

- [ ] Run the full test file:

  Run: `npm run test -- src/beekeeper/session-manager.test.ts`
  Expected: all existing tests plus three new cases pass.

### Step 2.5: Commit

```bash
git add src/beekeeper/session-manager.test.ts
git commit -m "$(cat <<'EOF'
HIVE-113: add tests for /clear ordering, init-never-fires, and non-clear regression

Covers:
- session_replaced fires before any new-session signals reach the client
  (verifies suppression of status + session_info, and welcome stream still flows)
- /clear when SDK completes without emitting init sends error, does not hang
- non-clear newSession() path still emits status(thinking) and session_info

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Full quality gate

### Step 3.1: Run the quality gate

- [ ] Run the full check:

  Run: `npm run check`
  Expected: typecheck + lint + format + test all green.

- [ ] If anything fails, fix in place and re-run. Do not commit a broken state.

### Step 3.2: Final push

- [ ] Push the branch:

  Run: `git push`
  Expected: branch `113` updated on origin.

---

## Out of Scope (from spec)

- iOS client implementation — separate PR in `keepur-ios`
- Retry logic on `newSession()` failure
- Fixing the pre-existing pending-id leak in `status(thinking)` on the non-clear path
- Any changes to `/help`, `/status`, or other slash commands
