# Beekeeper File Uploads — Design Spec

**Date:** 2026-04-08
**Repos:** hive (beekeeper server), keepur-ios (client)

## Problem

Keepur iOS now supports image/file selection in the UI, but beekeeper has no file handling — the protocol only accepts `{ type: "message", text, sessionId }`. When debugging UI issues, users need to send screenshots directly to their Claude Code session and have Claude see the actual image. Currently the only workaround is describing what's on screen in text.

## Solution

Add `image` and `file` message types to the beekeeper WebSocket protocol. Files are base64-encoded in the WebSocket message (matching the existing team protocol pattern). Beekeeper decodes the data, saves to disk, and references the file path in the prompt. Claude Code's native Read tool handles multimodal viewing — no Gemini preprocessing, no SDK refactor.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Encoding | Base64 in WebSocket JSON | Matches team protocol pattern, works within existing WS infra |
| Image handling | Save to disk, reference in prompt | Claude Code's Read tool is natively multimodal — sees actual pixels. Avoids complex SDK AsyncIterable refactor and Gemini middleman |
| Non-image files | Text-extract + inline in prompt | Reuse existing `processFileBuffer` from `file-processor.ts` — PDF, DOCX, XLSX, CSV, text all supported |
| File storage | `/tmp/bk-<timestamp>-<filename>` | Ephemeral, same pattern as existing `hive-slack-files` dir |
| Size limit | 10 MB per file | Reasonable for screenshots/docs |
| WS maxPayload | Add explicit 15 MB cap | Beekeeper WSS has no `maxPayload` set (defaults to 100 MB). Must add `maxPayload: 15 * 1024 * 1024`. Set higher than the 10 MB file limit to account for base64 overhead (~1.33x) plus JSON framing. The application-layer check (decoded bytes > 10 MB) enforces the actual file size limit |
| Message body limit | HTTP-only, no change | Current 16 KB `readBody` cap is HTTP-only, doesn't affect WS |

## Protocol Changes

### Client → Server (new message types)

```typescript
// Added to ClientMessage union in types.ts
| { type: "image"; sessionId: string; data: string; filename: string }
| { type: "file"; sessionId: string; data: string; filename: string; mimetype: string }
```

- `data`: base64-encoded file content
- `filename`: original filename (e.g. `screenshot.png`, `report.pdf`)
- `mimetype`: MIME type (required for `file`, inferred for `image` from extension)
- `sessionId`: target Claude Code session

### Server → Client (no changes)

No new server message types needed. The session processes the file and responds through the existing `message` stream. Validation errors (unknown session, missing filename, oversized file) surface via the existing `error` message type. If the session is busy, the client receives `{ type: "status", state: "busy" }` — same as text messages.

## Hive Implementation (beekeeper)

### 1. Protocol — `src/beekeeper/types.ts`

Add two new cases to the `ClientMessage` union type.

### 2. Message handling — `src/beekeeper/index.ts`

New cases in the WebSocket message switch:

```
case "image":
  decode base64 → save to /tmp/bk-*/ → sessionManager.sendMessage(sessionId, text + file reference)
case "file":
  decode base64 → processFileBuffer() → sessionManager.sendMessage(sessionId, text + inlined content)
```

### 3. File processing — `src/beekeeper/file-handler.ts` (new)

Small module with two functions:

```typescript
/** Save image to disk, return prompt text referencing the file path */
export async function handleImage(data: string, filename: string): Promise<string>

/** Process non-image file, return prompt text with extracted content.
 *  `extractContent` returns `null` (not `{ textContent: null }`) for unsupported types.
 *  When null, falls back to metadata-only prompt:
 *  "📎 File: data.bin (2.1 KB, application/octet-stream) — unsupported format, file saved at /tmp/bk-..." */
export async function handleFile(data: string, filename: string, mimetype: string): Promise<string>
```

**Image prompt format:**
```
The user attached an image: screenshot.png
Read this file before responding (it is an image): /tmp/bk-1712567890-screenshot.png
```

The directive phrasing ensures Claude Code calls the Read tool to view the image before responding, rather than ignoring the path and responding to text alone.

**Non-image prompt format** (uses `extractContent` from `file-processor.ts` for text extraction, exported for reuse; `file-handler.ts` handles its own disk writes to `/tmp/bk-*` — does NOT call `processFileBuffer` directly since that writes to `/tmp/hive-slack-files/team-*`):
```
📎 File: report.pdf (1.2 MB, application/pdf)
--- file content ---
[extracted text]
--- end file content ---
```

### 4. Session manager — `src/beekeeper/session-manager.ts`

`sendMessage()` signature stays `(sessionId: string, text: string)` — no changes needed. The file handler produces prompt text that gets passed as the `text` argument.

### 5. WebSocket server — `src/beekeeper/index.ts`

- Add `maxPayload: 15 * 1024 * 1024` to `new WebSocketServer()` constructor (15 MB frame limit covers 10 MB file + base64 overhead)
- Update the `log.info("WS message received", ...)` line to not log raw base64 data for image/file messages — log `{ type, sessionId, filename }` instead
- Add `image` and `file` cases to the message switch

### 6. Validation (order matters)

1. Reject if `sessionId` is missing or unknown — **before** decoding base64 or writing to disk
2. Reject if `filename` is missing
3. Sanitize filename (strip path separators, special chars) — same `safeName` pattern as `file-processor.ts` — **before** any disk write
4. Decode base64, reject if decoded size > 10 MB
5. Write to disk

## Keepur iOS Implementation

### 1. Protocol — `Models/WSMessage.swift`

Add to `WSOutgoing`:

```swift
case image(sessionId: String, data: String, filename: String)
case file(sessionId: String, data: String, filename: String, mimetype: String)
```

Encoding:
```swift
case .image(let sessionId, let data, let filename):
    dict = ["type": "image", "sessionId": sessionId, "data": data, "filename": filename]
case .file(let sessionId, let data, let filename, let mimetype):
    dict = ["type": "file", "sessionId": sessionId, "data": data, "filename": filename, "mimetype": mimetype]
```

### 2. Attachment UI — `Views/ChatView.swift`

Add an attachment button (paperclip or + icon) next to the text input. Tap opens a menu:
- **Photo Library** — `PhotosPicker` (PhotosUI framework)
- **Camera** — `UIImagePickerController` with `.camera` source (iPhone only)
- **Files** — `UIDocumentPickerViewController` for arbitrary files

### 3. ViewModel — `ViewModels/ChatViewModel.swift`

New method:

```swift
func sendAttachment(_ data: Data, filename: String, mimetype: String) {
    guard let sessionId = currentSessionId else { return }
    // Attachments are silently dropped when busy — unlike text, they are not queued
    guard statusFor(sessionId) == "idle" else { return }
    
    let base64 = data.base64EncodedString()
    let isImage = mimetype.hasPrefix("image/")
    
    if isImage {
        ws.send(.image(sessionId: sessionId, data: base64, filename: filename))
    } else {
        ws.send(.file(sessionId: sessionId, data: base64, filename: filename, mimetype: mimetype))
    }
    
    // Add local message bubble showing the attachment
}
```

### 4. Local display

Show a thumbnail for images or a file icon + name for documents in the chat bubble. The attachment is displayed immediately (optimistic) — no server acknowledgment needed since errors come via the existing error message type.

### 5. Image compression

Before base64-encoding, resize images to max 2048px on the longest edge and compress as JPEG (quality 0.8) for photos. Screenshots (PNG) sent as-is to preserve text clarity. This keeps payloads reasonable without losing detail Claude needs for UI debugging.

## What's NOT in scope

- **Multiple files per message** — send one at a time. Can batch later.
- **File upload progress** — base64 in a single WS frame, no chunking. Files are small enough.
- **Server-side file persistence** — files are ephemeral in `/tmp`. No database storage.
- **Bidirectional file transfer** — Claude can't send files back to the client. Text responses only.
- **Drag and drop on macOS** — future enhancement for the macOS target.
- **Paste from clipboard** — future enhancement.

## File inventory

### Hive (this repo)

| File | Action |
|------|--------|
| `src/files/file-processor.ts` | Modify — export `extractContent` for reuse by beekeeper file handler |
| `src/beekeeper/types.ts` | Modify — add `image` and `file` to `ClientMessage` |
| `src/beekeeper/index.ts` | Modify — add `maxPayload`, fix log for binary messages, add image/file cases to WS switch |
| `src/beekeeper/file-handler.ts` | Create — image/file processing for beekeeper |
| `src/beekeeper/file-handler.test.ts` | Create — unit tests |

### Keepur iOS (separate repo)

| File | Action |
|------|--------|
| `Models/WSMessage.swift` | Modify — add `image` and `file` to `WSOutgoing` |
| `ViewModels/ChatViewModel.swift` | Modify — add `sendAttachment` method |
| `Views/ChatView.swift` | Modify — add attachment button + pickers |
| `Views/Components/AttachmentBubble.swift` | Create — thumbnail/file display in chat |
