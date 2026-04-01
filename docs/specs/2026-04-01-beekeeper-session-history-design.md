# Beekeeper Session History & Resume

**Date**: 2026-04-01
**Status**: Draft
**Scope**: Server-side (hive) + client protocol

## Problem

When a user browses to a workspace in the iOS app, they can only see active (in-memory) sessions. Claude Code persists full session history to `~/.claude/projects/` on disk, but Beekeeper doesn't expose it. Users want to see and resume past sessions — the same way the Claude Code CLI lets you pick from prior conversations in a project.

## Design

### Session File Layout

Claude Code stores sessions at:
```
~/.claude/projects/{project-key}/{session-id}.jsonl
```

**Project key** is the absolute path with `/` replaced by `-`:
```
/Users/mokie/github/hive  →  -Users-mokie-github-hive
```

Each `.jsonl` file contains one JSON object per line. The first user message appears within the first ~10 lines (after queue-operation and system entries) and has the shape:
```json
{ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "..." }] } }
```

### Protocol Changes

#### Client → Server

**`list_workspace_sessions`** — Request session history for a workspace path.

```json
{
  "type": "list_workspace_sessions",
  "path": "/Users/mokie/github/hive"
}
```

**`resume_session`** — Resume a past session by ID.

```json
{
  "type": "resume_session",
  "sessionId": "0361ee25-c5f0-4834-a3f4-ef779c50a182",
  "path": "/Users/mokie/github/hive"
}
```

#### Server → Client

**`workspace_session_list`** — Session history for a workspace.

```json
{
  "type": "workspace_session_list",
  "path": "/Users/mokie/github/hive",
  "sessions": [
    {
      "sessionId": "0361ee25-c5f0-4834-a3f4-ef779c50a182",
      "lastActiveAt": "2026-04-01T01:12:19.756Z",
      "preview": "You are now connected. Briefly acknowledge readiness.",
      "active": false
    },
    {
      "sessionId": "113115ab-bfd2-4020-ba96-7d7861424947",
      "lastActiveAt": "2026-03-31T15:34:00.000Z",
      "preview": "Add workspace browsing to beekeeper",
      "active": true
    }
  ]
}
```

Fields:
- `sessionId` — UUID, also the JSONL filename (minus extension)
- `lastActiveAt` — ISO timestamp, from file mtime
- `preview` — First user message text, truncated to 200 chars. Falls back to `"(no preview)"` if unreadable.
- `active` — `true` if this session is currently in the active sessions map (i.e., already loaded in memory)

Sessions are sorted by `lastActiveAt` descending (most recent first). Capped at **50** entries to keep the response lean.

### Resume Flow

`resume_session` works like `new_session` but skips the inaugural "acknowledge readiness" query. Instead:

1. Validate `path` via `validatePath()`
2. Create `SessionSlot` with the provided `sessionId` (not a pending ID)
3. Register in sessions map
4. Send `session_info` immediately — the session is ready for messages
5. Client sends the first `message` when the user types something
6. That `message` call passes `resume: sessionId` to the SDK, which loads the prior conversation

This avoids an unnecessary SDK round-trip on resume. The session is "warm" — it only hits the SDK when the user actually sends a message.

### Error Cases

| Scenario | Response |
|----------|----------|
| Invalid/outside-home path | `{ type: "error", message: "Path is outside home directory: ..." }` |
| No `.claude/projects/` dir for path | `{ type: "workspace_session_list", path, sessions: [] }` |
| Session ID not found on disk during resume | Resume still works — SDK creates a new session with that ID |
| Session already active | Return existing session via `session_info` (don't create duplicate slot) |

### Implementation (Server)

**New utility**: `src/beekeeper/session-history.ts`

```typescript
interface WorkspaceSession {
  sessionId: string;
  lastActiveAt: string;   // ISO timestamp
  preview: string;
}

function pathToProjectKey(absolutePath: string): string
function listWorkspaceSessions(absolutePath: string, activeSessionIds: Set<string>): Promise<WorkspaceSession[]>
```

`listWorkspaceSessions` does:
1. Derive project key from path
2. Read `~/.claude/projects/{key}/` directory
3. For each `*.jsonl` file: stat for mtime, read first ~10 lines for user message preview
4. Sort by mtime desc, cap at 50
5. Mark sessions that are in the active set

**Session manager additions**:
- `resumeSession(sessionId: string, cwd: string)` — register slot, send `session_info`
- `listWorkspaceSessions(path: string)` — calls utility, sends response

**Type additions** in `types.ts`:
- Two new `ClientMessage` variants
- One new `ServerMessage` variant

### Not in Scope

- Deleting old sessions from disk
- Full conversation history replay (just the preview)
- Searching across sessions
