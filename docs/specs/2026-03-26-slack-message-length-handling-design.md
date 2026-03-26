# Slack Message Length Handling — Design Spec

**Date**: 2026-03-26
**Status**: Draft
**Scope**: Systemic handling of oversized Slack messages at the gateway level

## Problem

Slack collapses messages longer than ~4,000 characters behind a "show more" button. The full text is preserved in the API (Slack's actual API limit is ~40,000 chars), but the reader experience degrades — long responses require clicking to expand, and the collapsed preview often cuts mid-sentence. Agent responses regularly exceed 4K — detailed analyses, status reports, specs, code explanations. This has been a recurring UX issue.

## Design

### Strategy: Hybrid (split or file)

All messages posted via `SlackGateway.postMessage` are checked for length:

| Message Length | Action |
|---------------|--------|
| ≤ 3,900 chars | Post normally (single message) |
| 3,901 – 8,000 chars | Split into multiple messages on paragraph/line boundaries |
| > 8,000 chars | Upload as `.md` file snippet + short summary message |

### Threshold Constants

```typescript
const SLACK_MAX_CHARS = 3900;       // below Slack's ~4K collapse threshold
const SPLIT_MAX_CHARS = 8000;       // above this, use file upload instead of splitting
const SUMMARY_LENGTH = 200;         // chars of original text to include in file upload summary
```

### Split Logic (3,901 – 8,000 chars)

Break the message into chunks of ≤ `SLACK_MAX_CHARS` characters. Split on the best available boundary in priority order:

1. Double newline (`\n\n`) — paragraph break
2. Single newline (`\n`) — line break
3. Space — word boundary
4. Hard cut at `SLACK_MAX_CHARS` — last resort

Each chunk is posted as a separate `chat.postMessage` call, **sequentially awaited** (each call completes before the next starts). This guarantees message ordering — Slack timestamps are assigned by server-receive time, and sequential awaits ensure the order is correct without relying on timing heuristics.

**Agent attribution on continuation chunks**: The text passed to `postMessage` already includes the agent signature prefix (e.g., `:wrench: *Remy*: ...`) prepended by the Slack adapter's `deliver()`. For split messages, only the first chunk contains this prefix. Chunks 2+ get a continuation marker prepended: `_(cont.)_ ` — lightweight, doesn't re-attribute (the thread context makes authorship clear).

### File Upload Logic (> 8,000 chars)

1. **Post summary message first** via `chat.postMessage`: first `SUMMARY_LENGTH` chars of the original text, trimmed to the last complete sentence or line break, plus `\n\n_(full response attached)_`. This provides context before the file appears.
2. **Upload the full text** as a `.md` file via Slack's `files.uploadV2`:
   - Filename: `{agent-name}-{timestamp}.md` (e.g., `remy-2026-03-26T18-30-45.md`)
   - Title: `{agent-name} response`
   - `channel_id`: same channel (note: `files.uploadV2` uses `channel_id`, not `channel`)
   - `thread_ts`: same thread (if threaded) — `files.uploadV2` supports `thread_ts` via `FileThreadDestinationArgument`
3. **Fallback**: if `files.uploadV2` fails, fall back to split logic (better to get chunked messages than nothing)

### Where It Lives

**`src/slack/slack-gateway.ts` — inside `postMessage()`**

The length check wraps the existing `chat.postMessage` calls. All callers benefit automatically: agent responses, triage acks, status messages, audit logs, error messages.

```typescript
async postMessage(channel, text, threadTs, identity): Promise<string | undefined> {
  if (text.length <= SLACK_MAX_CHARS) {
    return this.postSingle(channel, text, threadTs, identity);
  }

  if (text.length <= SPLIT_MAX_CHARS) {
    return this.postSplit(channel, text, threadTs, identity);
  }

  return this.postAsFile(channel, text, threadTs, identity);
}
```

The existing `postMessage` body moves into `postSingle()` (private). Two new private methods: `postSplit()` and `postAsFile()`.

### Agent Name for File Naming

`postMessage` receives an `identity` parameter with `name` and `icon`. However, **the Slack adapter's `deliver()` currently does not pass `identity` to `postMessage`** (line 141 — only 3 args). The adapter prepends the agent signature into the text itself.

**Fix required in `slack-adapter.ts`**: Pass `identity` as the 4th arg to `postMessage` in `deliver()`:

```typescript
const identity = agentConfig ? { name: agentConfig.name, icon: agentConfig.icon } : undefined;
await this.gateway.postMessage(channel, text, replyThread, identity);
```

This gives the gateway access to the agent name for file naming. For callers that don't pass identity (system messages, status queries), the file falls back to `"hive"` as the name prefix.

## Files to Change

| File | Change |
|------|--------|
| `src/slack/slack-gateway.ts` | Refactor `postMessage` into `postSingle`/`postSplit`/`postAsFile`; add length-based routing |
| `src/channels/slack-adapter.ts` | Pass `identity` to `postMessage` in `deliver()` |

## Not In Scope

- Agent-side message length awareness (agents don't need to know about this — the gateway handles it transparently)
- SMS/iMessage length handling (different adapters, different constraints)
- Slack Block Kit formatting (could improve rendering but adds complexity — plain text + file upload is sufficient for V1)
- Configurable thresholds (hardcoded constants are fine — Slack's collapse behavior doesn't change often)
