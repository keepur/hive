# Beekeeper Session Persistence Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Persist the beekeeper session map to disk so sessions survive server restarts without requiring client-side changes.

**Architecture:** A JSON file (`sessions.json`) stores the `sessionId → cwd` mapping. On startup, sessions are restored as lazy slots via the existing `resumeSession()` path. Persist is called at every map mutation point.

**Tech Stack:** TypeScript, Node.js fs, JSON

---

### Task 1: Add `dataDir` to Config

**Files:**
- Modify: `src/beekeeper/types.ts`
- Modify: `src/beekeeper/config.ts`

- [ ] **Step 1:** Add `dataDir: string` to `BeekeeperConfig` interface

```typescript
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
```

- [ ] **Step 2:** Import `homedir` and resolve `dataDir` in `loadConfig()`

Add to imports:
```typescript
import { homedir } from "node:os";
```

Add to return object:
```typescript
dataDir: process.env.BEEKEEPER_DATA_DIR ?? (raw.data_dir as string) ?? join(homedir(), ".beekeeper", "data"),
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: clean exit, no errors

- [ ] **Step 4:** Commit

```bash
git add src/beekeeper/types.ts src/beekeeper/config.ts
git commit -m "feat: add dataDir to beekeeper config

Adds configurable data directory for beekeeper state persistence.
Resolves from BEEKEEPER_DATA_DIR env, beekeeper.yaml data_dir, or
defaults to ~/.beekeeper/data."
```

---

### Task 2: Add Persist/Restore to SessionManager

**Files:**
- Modify: `src/beekeeper/session-manager.ts`

- [ ] **Step 1:** Add fs imports and `sessionsFile` field

Add to imports:
```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
```

Add field and constructor init:
```typescript
private sessionsFile: string;

constructor(config: BeekeeperConfig, guardian: ToolGuardian) {
  this.config = config;
  this.guardian = guardian;
  this.sessionsFile = join(config.dataDir, "sessions.json");
}
```

- [ ] **Step 2:** Add `persistSessions()` method

```typescript
persistSessions(): void {
  try {
    const dir = join(this.sessionsFile, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = Array.from(this.sessions.values())
      .filter((s) => !s.sessionId.startsWith("pending-"))
      .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
    writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2));
    log.info("Persisted sessions", { count: data.length, path: this.sessionsFile });
  } catch (err) {
    log.error("Failed to persist sessions", { error: String(err) });
  }
}
```

- [ ] **Step 3:** Add `restoreSessions()` method

```typescript
restoreSessions(): void {
  if (!existsSync(this.sessionsFile)) {
    log.info("No sessions file to restore", { path: this.sessionsFile });
    return;
  }
  try {
    const raw = readFileSync(this.sessionsFile, "utf-8");
    const entries = JSON.parse(raw) as Array<{ sessionId: string; cwd: string }>;
    for (const entry of entries) {
      if (this.sessions.has(entry.sessionId)) continue;
      this.resumeSession(entry.sessionId, entry.cwd);
    }
    log.info("Restored sessions from disk", { count: entries.length });
  } catch (err) {
    log.error("Failed to restore sessions", { error: String(err) });
  }
}
```

- [ ] **Step 4:** Add `persistSessions()` calls at mutation points

In `newSession()`, after real ID is set:
```typescript
this.sessions.set(realId, slot);
this.persistSessions();
```

In `clearSession()`, after delete:
```typescript
this.sessions.delete(sessionId);
this.persistSessions();
```

In `resumeSession()`, after set:
```typescript
this.sessions.set(sessionId, slot);
this.persistSessions();
```

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit`
Expected: clean exit, no errors

- [ ] **Step 6:** Commit

```bash
git add src/beekeeper/session-manager.ts
git commit -m "feat: persist/restore beekeeper session map to disk

Adds persistSessions() and restoreSessions() methods. Sessions are
written to ~/.beekeeper/data/sessions.json on every map mutation.
On restore, sessions are lazily re-registered via resumeSession()."
```

---

### Task 3: Wire Up Startup Restore and Shutdown Persist

**Files:**
- Modify: `src/beekeeper/index.ts`

- [ ] **Step 1:** Call `restoreSessions()` after SessionManager construction

```typescript
const sessionManager = new SessionManager(config, guardian);
sessionManager.restoreSessions();
```

- [ ] **Step 2:** Call `persistSessions()` before `stopAll()` in shutdown handler

```typescript
const shutdown = async () => {
  log.info("Shutting down");
  sessionManager.persistSessions();
  await sessionManager.stopAll();
  // ...
};
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: clean exit, no errors

- [ ] **Step 4:** Commit

```bash
git add src/beekeeper/index.ts
git commit -m "feat: restore sessions on startup, persist on shutdown

Calls restoreSessions() immediately after SessionManager construction
so sessions are available before any client connects. Calls
persistSessions() before stopAll() during graceful shutdown."
```

---

### Task 4: Fix Test Fixture

**Files:**
- Modify: `src/beekeeper/session-manager.test.ts`

- [ ] **Step 1:** Add `dataDir` to `makeConfig()` helper

```typescript
function makeConfig(overrides: Partial<BeekeeperConfig> = {}): BeekeeperConfig {
  return {
    port: 3099,
    model: "claude-sonnet-4-5",
    confirmOperations: [],
    jwtSecret: "test-jwt-secret",
    adminSecret: "test-admin-secret",
    mongoUri: "mongodb://localhost:27017",
    mongoDbName: "test-db",
    dataDir: "/tmp/beekeeper-test-data",
    ...overrides,
  };
}
```

- [ ] **Step 2:** Verify

Run: `npm test`
Expected: all tests pass (413 tests, 27 test files)

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/session-manager.test.ts
git commit -m "test: add dataDir to beekeeper test config fixture"
```
