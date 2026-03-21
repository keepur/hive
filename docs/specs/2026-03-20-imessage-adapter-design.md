# iMessage Adapter — Design Spec

**Date**: 2026-03-20
**Status**: Draft

## Problem

Hive needs an iMessage channel so the personal VA can send and receive iMessages. The Mac Mini has its own Apple ID, so the agent sends as herself. All conversations are mirrored to a `#imessage` Slack channel for the user's visibility.

## Design

### Architecture

```
iMessage (Messages.app / chat.db)
  → iMessage Adapter (poll chat.db for inbound, AppleScript for outbound)
  → Dispatcher (routing, dedup)
  → Agent
  → Response → iMessage Adapter → AppleScript → Messages.app → recipient
              → Slack mirror (#imessage thread)
```

The adapter implements the `ChannelAdapter` interface, same pattern as `SmsAdapter`.

### Inbound — Polling chat.db

Messages.app stores all messages in `~/Library/Messages/chat.db` (SQLite). The adapter polls this database for new messages using `better-sqlite3` (synchronous, read-only).

**New dependency:** `better-sqlite3` + `@types/better-sqlite3`

**Database access:** Open read-only (`{ readonly: true }`). Messages.app uses WAL mode, which allows concurrent readers automatically — no pragma needed.

**Key tables:**
- `message` — all messages (ROWID, text, attributedBody, is_from_me, handle_id, date, service)
- `handle` — contacts (ROWID, id = phone/email, service = iMessage/SMS)
- `chat_message_join` — links messages to chats
- `chat` — conversation metadata (chat_identifier, style)

**Query for new messages:**
```sql
SELECT m.ROWID, m.text, m.attributedBody, m.is_from_me, m.date,
       m.service, h.id AS sender, h.ROWID AS handle_rowid
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.ROWID > :lastSeenRowId
  AND m.is_from_me = 0
  AND m.is_empty = 0
ORDER BY m.ROWID ASC
```

Track `lastSeenRowId` (highest ROWID processed). Simpler and more reliable than timestamp-based polling — ROWID is monotonically increasing. Persist `lastSeenRowId` to disk (a small JSON file in the instance's tmp dir) so it survives restarts.

**Filtering out group chats:** Join through `chat_message_join` → `chat` and skip rows where `chat.style = 43` (group conversation).

**Text extraction:** Newer macOS versions store message text only in the `attributedBody` blob (NSKeyedArchiver binary plist format). The `text` column is often NULL.

Extraction approach:
1. If `message.text` is not null, use it directly.
2. Otherwise, parse `attributedBody`:
   - The blob is a binary plist (`bplist00` header) containing an NSKeyedArchiver-encoded NSAttributedString.
   - The plain text is stored as a UTF-8 NSString object within the archive.
   - Extract by scanning the raw buffer for the UTF-8 string payload: look for a length-prefixed string following the `NSString` class marker. The pattern is: locate the `NSString` reference, then read the associated data object which contains the raw UTF-8 bytes.
   - Use `biplist` or manual binary plist parsing — avoid naive regex which breaks on emoji, CJK, and multi-byte characters.
   - **Fallback:** If extraction fails, log a warning with the ROWID and skip the message. Do not crash.
   - Must be tested against multiple macOS versions (Ventura, Sonoma, Sequoia) as the archive format can vary.

### Adaptive Polling

Two polling speeds to balance responsiveness with efficiency:

| State | Interval | Trigger |
|-------|----------|---------|
| Hot | 10 seconds | Any contact with a message in the last 5 minutes |
| Cold | 5 minutes | No recent activity from any contact |

Implementation:
- A single `setInterval` runs at the hot interval (10s).
- Each tick, compare `Date.now()` against `lastMessageAt` (wall-clock timestamp of last received message from any contact).
- If `Date.now() - lastMessageAt > hotWindowMs` AND `Date.now() - lastColdPoll < coldIntervalMs`, skip the poll.
- When a new message arrives, `lastMessageAt` updates automatically.

Wall-clock comparison (not tick counting) ensures correct behavior across restarts and slow polls.

### Outbound — AppleScript

Send messages via Messages.app using a multi-line AppleScript passed to `osascript` via stdin or a temp file:

```applescript
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${recipient}" of targetService
  send "${escapedText}" to targetBuddy
end tell
```

Execute via:
```typescript
execFileSync("osascript", ["-e", script]);
```

If the multi-statement form doesn't work in a single `-e`, use multiple `-e` flags (one per statement) or write to a temp `.applescript` file and pass the path.

**Escaping:** Message text must be escaped for AppleScript string literals — double quotes (`"` → `\"`), backslashes (`\` → `\\`), and special characters.

**Fallback:** If Messages.app can't reach the recipient via iMessage, it may fall back to SMS (depending on macOS settings). This is acceptable — the message still gets delivered.

**Rate limiting:** Add a 500ms delay between consecutive sends to avoid overwhelming Messages.app.

**Error handling:** Wrap in try/catch with one retry. If both attempts fail, log the error and report delivery failure.

### Threading

Each contact (handle) gets its own thread:

```
threadId: imessage:<handle_id>
```

Where `handle_id` is the contact identifier from the `handle` table (phone number or email). This maps 1:1 to iMessage conversations.

Group chats: Not in scope for v1. Group messages (`chat.style = 43`) are skipped.

### Slack Mirroring

All iMessage conversations are mirrored to a single `#imessage` Slack channel. Each contact gets its own Slack thread.

When a new message arrives from a contact:
1. Look up existing Slack thread for this contact (by `threadId`) in MongoDB (`imessage_threads` collection).
2. If no thread exists, post a new message: `iMessage from +15551234567 (John)` — this becomes the thread parent. Save the mapping `{ handleId, slackThreadTs }` to MongoDB.
3. Post the message content as a thread reply.
4. Agent responses are also posted to the same thread.

**Persistence:** Thread mappings stored in MongoDB (`imessage_threads` collection) to survive restarts. Without this, every restart would create duplicate Slack threads for existing contacts.

Contact name resolution: Use `handle.id` (phone/email). If the Hive contacts collection has a match, use the display name. Otherwise, show the raw identifier.

### Configuration

In `hive.yaml`:

```yaml
imessage:
  enabled: true
  slackChannel: imessage          # Slack channel for mirroring
  hotWindowMs: 300000             # 5 minutes — how long a contact stays "hot"
  coldIntervalMs: 300000          # 5 minutes — poll interval when idle
  hotIntervalMs: 10000            # 10 seconds — poll interval when active
```

### WorkItem Shape

```typescript
const workItem: WorkItem = {
  id: `imsg-${message.ROWID}`,
  text: extractedText,
  source: {
    kind: "imessage",
    id: "imessage",
    label: "imessage",              // routes to #imessage channel
  },
  sender: handle.id,                // phone number or email
  threadId: `imessage:${handle.id}`,
  timestamp: appleTimestampToDate(message.date),
  meta: {
    messageRowId: message.ROWID,
    service: message.service,       // "iMessage" or "SMS"
  },
};
```

### Apple Timestamp Conversion

Messages.app uses Apple Core Data timestamps — nanoseconds since 2001-01-01T00:00:00Z.

```typescript
function appleTimestampToDate(ts: number): Date {
  // Apple epoch is 978307200 seconds after Unix epoch
  const unixSeconds = ts / 1_000_000_000 + 978307200;
  return new Date(unixSeconds * 1000);
}
```

### Prerequisites

- **Full Disk Access**: The process reading `chat.db` needs Full Disk Access in System Preferences → Privacy & Security. The `node` binary (or Terminal.app if running from terminal) must be granted this permission.
- **Messages.app running**: Must be running for AppleScript outbound to work. Can be launched headless.
- **Apple ID signed in**: Messages.app must be signed into the Mac Mini's Apple ID.

## Files Changed

### New Dependencies

- `better-sqlite3` — synchronous SQLite3 driver for reading chat.db
- `@types/better-sqlite3` — TypeScript types (dev dependency)

### New Files

| File | Purpose |
|------|---------|
| `src/channels/imessage-adapter.ts` | iMessage channel adapter — polling, text extraction, AppleScript delivery |
| `src/channels/imessage-db.ts` | SQLite query helpers and NSAttributedString text extraction |

### Modified

| File | Change |
|------|--------|
| `src/config.ts` | Add `imessage` config section |
| `src/index.ts` | Wire up iMessage adapter when enabled |
| `src/types/work-item.ts` | Add `"imessage"` to `ChannelKind` union (prerequisite — must be done first or TypeScript won't compile) |
| `src/channels/dispatcher.ts` | Add `"imessage"` to `isInteractive` check so iMessage gets triage (same as Slack and SMS) |
| `package.json` | Add `better-sqlite3` dependency |

### Unchanged

| File | Why |
|------|-----|
| `src/channels/slack-adapter.ts` | Slack mirroring uses existing thread posting — no adapter changes |

## Verification

1. **Receive**: Send an iMessage to the Mac Mini's Apple ID from another device. Verify it appears in Slack `#imessage` and triggers an agent response.
2. **Reply**: Agent response is delivered back via iMessage to the sender.
3. **Adaptive polling**: Send a message, verify 10s polling activates. Wait 5+ minutes, verify it drops to 5-minute intervals.
4. **Text extraction**: Test with plain text, emoji, CJK characters, and long messages. Verify NSAttributedString blob parsing works correctly.
5. **Threading**: Multiple contacts messaging simultaneously get separate Slack threads and separate agent conversations.
6. **Restart persistence**: Restart Hive, verify existing Slack threads are reused (not duplicated) and `lastSeenRowId` resumes correctly.
7. **Triage**: Verify simple iMessage queries get fast Haiku triage, same as Slack/SMS.

## Risks

- **Full Disk Access**: If the node process doesn't have FDA, `chat.db` reads will fail silently or throw. The adapter should check access on startup and log a clear error.
- **chat.db locking**: Messages.app uses WAL mode. Opening read-only (`{ readonly: true }` in better-sqlite3) allows concurrent reads automatically. Do not issue any write pragmas.
- **AppleScript fragility**: `osascript` can fail if Messages.app is unresponsive or the recipient isn't reachable. Wrap in try/catch with retry (max 2 attempts).
- **NSAttributedString format changes**: Apple may change the blob format across macOS versions. The text extractor should have a fallback (log warning, skip message) rather than crashing. Must be tested on the target macOS version.
- **better-sqlite3 native module**: Requires compilation on install. If Node version changes, may need rebuild (`npm rebuild better-sqlite3`). Consider pinning in package.json.
