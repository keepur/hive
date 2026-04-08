# Beekeeper File Uploads — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Enable keepur-ios users to send screenshots and files to beekeeper Claude Code sessions, with images viewed natively via Claude's Read tool and non-image files text-extracted and inlined.

**Architecture:** Client sends base64-encoded files over WebSocket → beekeeper decodes, saves to `/tmp/bk-*`, produces prompt text → session manager passes prompt to SDK. Images get a directive prompt pointing Claude to the file path; non-image files get text content extracted and inlined.

**Tech Stack:** TypeScript (hive/beekeeper), Swift/SwiftUI (keepur-ios), vitest (tests)

**Spec:** `docs/specs/2026-04-08-beekeeper-file-uploads-design.md`

---

### Task 1: Export `extractContent` from file-processor

**Files:**
- Modify: `src/files/file-processor.ts:115`

- [ ] **Step 1:** Add `export` keyword to `extractContent`

```typescript
// Before (line 115):
async function extractContent(

// After:
export async function extractContent(
```

- [ ] **Step 2:** Verify build

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/files/file-processor.ts
git commit -m "refactor: export extractContent from file-processor for reuse"
```

---

### Task 2: Add `image` and `file` to beekeeper `ClientMessage`

**Files:**
- Modify: `src/beekeeper/types.ts:2-13`

- [ ] **Step 1:** Add two new union members to `ClientMessage`

```typescript
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
```

- [ ] **Step 2:** Verify build

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/beekeeper/types.ts
git commit -m "feat: add image and file message types to beekeeper protocol"
```

---

### Task 3: Create `file-handler.ts`

**Files:**
- Create: `src/beekeeper/file-handler.ts`
- Create: `src/beekeeper/file-handler.test.ts`

- [ ] **Step 1:** Create `src/beekeeper/file-handler.ts`

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../logging/logger.js";
import { extractContent } from "../files/file-processor.js";

const log = createLogger("beekeeper-file-handler");

const DOWNLOAD_DIR = join(tmpdir(), "bk-files");
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB decoded

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"]);

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate and decode a base64-encoded file payload.
 * Returns the decoded buffer, or throws with a user-facing error message.
 */
export function decodeAndValidate(
  data: string,
  filename: string,
): { buffer: Buffer; safeName: string } {
  if (!filename) {
    throw new Error("Missing required field: filename");
  }
  const safeName = sanitizeFilename(filename);

  let buffer: Buffer;
  try {
    buffer = Buffer.from(data, "base64");
  } catch {
    throw new Error("Invalid base64 data");
  }

  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${formatSize(buffer.length)} (max ${formatSize(MAX_FILE_SIZE)})`);
  }

  return { buffer, safeName };
}

/**
 * Save an image to disk and return prompt text that directs Claude to read it.
 */
export async function handleImage(data: string, filename: string): Promise<string> {
  const { buffer, safeName } = decodeAndValidate(data, filename);
  const localPath = join(DOWNLOAD_DIR, `${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);
  log.info("Image saved", { filename: safeName, size: buffer.length, path: localPath });

  return `The user attached an image: ${filename}\nRead this file before responding (it is an image): ${localPath}`;
}

/**
 * Process a non-image file: extract text content and return formatted prompt text.
 * Falls back to metadata-only prompt for unsupported types.
 */
export async function handleFile(
  data: string,
  filename: string,
  mimetype: string,
): Promise<string> {
  const { buffer, safeName } = decodeAndValidate(data, filename);
  const localPath = join(DOWNLOAD_DIR, `${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);
  log.info("File saved", { filename: safeName, mimetype, size: buffer.length, path: localPath });

  // Check if this is actually an image sent via the "file" type
  const ext = extname(filename).slice(1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || mimetype.startsWith("image/")) {
    return `The user attached an image: ${filename}\nRead this file before responding (it is an image): ${localPath}`;
  }

  // Try text extraction
  const extracted = await extractContent(buffer, filename, mimetype);

  if (extracted && extracted.textContent) {
    const header = `📎 File: ${filename} (${formatSize(buffer.length)}, ${mimetype})`;
    return `${header}\n--- file content ---\n${extracted.textContent}\n--- end file content ---`;
  }

  // Unsupported type — metadata only
  return `📎 File: ${filename} (${formatSize(buffer.length)}, ${mimetype}) — unsupported format, file saved at ${localPath}`;
}
```

- [ ] **Step 2:** Create `src/beekeeper/file-handler.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { decodeAndValidate, handleImage, handleFile } from "./file-handler.js";

describe("decodeAndValidate", () => {
  it("decodes valid base64 and sanitizes filename", () => {
    const data = Buffer.from("hello world").toString("base64");
    const result = decodeAndValidate(data, "test file (1).txt");
    expect(result.buffer.toString()).toBe("hello world");
    expect(result.safeName).toBe("test_file__1_.txt");
  });

  it("throws on missing filename", () => {
    const data = Buffer.from("hello").toString("base64");
    expect(() => decodeAndValidate(data, "")).toThrow("Missing required field: filename");
  });

  it("throws on oversized file", () => {
    // Create a buffer just over 10 MB
    const bigBuffer = Buffer.alloc(10 * 1024 * 1024 + 1);
    const data = bigBuffer.toString("base64");
    expect(() => decodeAndValidate(data, "big.bin")).toThrow("File too large");
  });
});

describe("handleImage", () => {
  it("saves image to disk and returns directive prompt", async () => {
    const imageData = Buffer.from("fake-png-data").toString("base64");
    const result = await handleImage(imageData, "screenshot.png");

    expect(result).toContain("The user attached an image: screenshot.png");
    expect(result).toContain("Read this file before responding (it is an image):");
    expect(result).toContain(join(tmpdir(), "bk-files"));

    // Verify file was written
    const pathMatch = result.match(/: (\/.*\.png)$/m);
    expect(pathMatch).toBeTruthy();
    if (pathMatch) {
      expect(existsSync(pathMatch[1])).toBe(true);
      expect(readFileSync(pathMatch[1]).toString()).toBe("fake-png-data");
    }
  });
});

describe("handleFile", () => {
  it("extracts text from a .txt file", async () => {
    const textData = Buffer.from("Hello, this is a text file.").toString("base64");
    const result = await handleFile(textData, "notes.txt", "text/plain");

    expect(result).toContain("📎 File: notes.txt");
    expect(result).toContain("text/plain");
    expect(result).toContain("Hello, this is a text file.");
    expect(result).toContain("--- file content ---");
  });

  it("falls back to metadata for unsupported types", async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02]).toString("base64");
    const result = await handleFile(binaryData, "data.bin", "application/octet-stream");

    expect(result).toContain("📎 File: data.bin");
    expect(result).toContain("unsupported format");
    expect(result).toContain("file saved at");
  });

  it("treats image sent via file type as image", async () => {
    const imageData = Buffer.from("fake-image").toString("base64");
    const result = await handleFile(imageData, "photo.jpg", "image/jpeg");

    expect(result).toContain("The user attached an image: photo.jpg");
    expect(result).toContain("Read this file before responding");
  });

  it("extracts CSV content", async () => {
    const csvData = Buffer.from("name,age\nAlice,30\nBob,25").toString("base64");
    const result = await handleFile(csvData, "data.csv", "text/csv");

    expect(result).toContain("📎 File: data.csv");
    expect(result).toContain("Alice,30");
  });
});
```

- [ ] **Step 3:** Verify tests pass

Run: `npx vitest run src/beekeeper/file-handler.test.ts`
Expected: All tests pass

- [ ] **Step 4:** Commit

```bash
git add src/beekeeper/file-handler.ts src/beekeeper/file-handler.test.ts
git commit -m "feat: add beekeeper file handler for image and file uploads"
```

---

### Task 4: Wire file handling into beekeeper `index.ts`

**Depends on:** Task 2 (types) and Task 3 (file-handler) must be completed first.

**Files:**
- Modify: `src/beekeeper/index.ts:374` (maxPayload)
- Modify: `src/beekeeper/index.ts:435` (log line)
- Modify: `src/beekeeper/index.ts:438-556` (switch statement)

- [ ] **Step 1:** Add `maxPayload` to WebSocket server constructor

```typescript
// Before (line 374):
const wss = new WebSocketServer({ noServer: true });

// After:
const wss = new WebSocketServer({ noServer: true, maxPayload: 15 * 1024 * 1024 });
```

- [ ] **Step 2:** Fix log line to not dump base64 data

```typescript
// Before (line 435):
log.info("WS message received", { type: msg.type, raw: raw.toString().slice(0, 200) });

// After:
const logMeta: Record<string, unknown> = { type: msg.type };
if (msg.type === "image" || msg.type === "file") {
  logMeta.sessionId = (msg as { sessionId?: string }).sessionId;
  logMeta.filename = (msg as { filename?: string }).filename;
} else {
  logMeta.raw = raw.toString().slice(0, 200);
}
log.info("WS message received", logMeta);
```

- [ ] **Step 3:** Add import for file handler at top of file

```typescript
import { handleImage, handleFile } from "./file-handler.js";
```

- [ ] **Step 4:** Add `image` and `file` cases to the switch statement. Insert before the `default` case:

```typescript
          case "image": {
            if (!msg.sessionId || typeof msg.sessionId !== "string") {
              ws.send(JSON.stringify({ type: "error", message: "Missing required field: sessionId" }));
              break;
            }
            try {
              const prompt = await handleImage(msg.data, msg.filename);
              await sessionManager.sendMessage(msg.sessionId, prompt);
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                  sessionId: msg.sessionId,
                }),
              );
            }
            break;
          }
          case "file": {
            if (!msg.sessionId || typeof msg.sessionId !== "string") {
              ws.send(JSON.stringify({ type: "error", message: "Missing required field: sessionId" }));
              break;
            }
            try {
              const prompt = await handleFile(msg.data, msg.filename, msg.mimetype);
              await sessionManager.sendMessage(msg.sessionId, prompt);
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                  sessionId: msg.sessionId,
                }),
              );
            }
            break;
          }
```

- [ ] **Step 5:** Verify build and existing tests

Run: `npx tsc --noEmit && npx vitest run src/beekeeper/`
Expected: No type errors, all beekeeper tests pass

- [ ] **Step 6:** Commit

```bash
git add src/beekeeper/index.ts
git commit -m "feat: wire image and file uploads into beekeeper WebSocket handler"
```

---

### Task 5: iOS — Protocol and ViewModel (keepur-ios repo)

**Files:**
- Modify: `/Users/mokie/github/keepur-ios/Models/WSMessage.swift`
- Modify: `/Users/mokie/github/keepur-ios/ViewModels/ChatViewModel.swift`

- [ ] **Step 1:** Add `image` and `file` cases to `WSOutgoing` enum in `WSMessage.swift`

Add before the `ping` case:

```swift
case image(sessionId: String, data: String, filename: String)
case file(sessionId: String, data: String, filename: String, mimetype: String)
```

- [ ] **Step 2:** Add encoding cases in the `encode()` switch in `WSMessage.swift`

Add before the `case .ping:` branch:

```swift
case .image(let sessionId, let data, let filename):
    dict = ["type": "image", "sessionId": sessionId, "data": data, "filename": filename]
case .file(let sessionId, let data, let filename, let mimetype):
    dict = ["type": "file", "sessionId": sessionId, "data": data, "filename": filename, "mimetype": mimetype]
```

- [ ] **Step 3:** Add `sendAttachment` method to `ChatViewModel.swift`

Add after the existing `sendMessage` method:

```swift
func sendAttachment(_ data: Data, filename: String, mimetype: String) {
    guard let sessionId = currentSessionId,
          let context = modelContext else { return }
    // Attachments are silently dropped when busy — unlike text, they are not queued
    guard statusFor(sessionId) == "idle" else { return }
    
    let base64 = data.base64EncodedString()
    let isImage = mimetype.hasPrefix("image/")
    
    if isImage {
        ws.send(.image(sessionId: sessionId, data: base64, filename: filename))
    } else {
        ws.send(.file(sessionId: sessionId, data: base64, filename: filename, mimetype: mimetype))
    }
    
    // Add local attachment message (same pattern as sendText)
    let message = Message(
        sessionId: sessionId,
        text: isImage ? "📷 \(filename)" : "📎 \(filename)",
        role: "user"
    )
    context.insert(message)
    try? context.save()
}
```

- [ ] **Step 4:** Verify build

Run: `cd /Users/mokie/github/keepur-ios && xcodebuild -scheme Keeper -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`

- [ ] **Step 5:** Commit

```bash
cd /Users/mokie/github/keepur-ios
git add Models/WSMessage.swift ViewModels/ChatViewModel.swift
git commit -m "feat: add image and file upload protocol support"
```

---

### Task 6: iOS — Attachment UI (keepur-ios repo)

**Files:**
- Modify: `/Users/mokie/github/keepur-ios/Views/ChatView.swift`

This task adds a `+` button next to the text input that opens a menu with Photo Library and Files options. Camera is skipped for v1 (requires UIKit bridge).

- [ ] **Step 1:** Add `PhotosUI` import at the top of `ChatView.swift`

```swift
import PhotosUI
```

- [ ] **Step 2:** Add state properties for the photo and file pickers

Add as stored properties on `ChatView`, alongside the existing `@State` declarations (before `var body`):

```swift
@State private var showingAttachmentMenu = false
@State private var showingPhotoPicker = false
@State private var selectedPhotoItem: PhotosPickerItem?
@State private var showingFilePicker = false
```

- [ ] **Step 3:** Add the attachment button next to the text input

In the input bar HStack, add a `+` button before the TextField:

```swift
Button {
    showingAttachmentMenu = true
} label: {
    Image(systemName: "plus.circle.fill")
        .font(.title2)
        .foregroundStyle(.secondary)
}
.confirmationDialog("Attach", isPresented: $showingAttachmentMenu) {
    Button("Photo Library") {
        // PhotosPicker is triggered via selectedPhotoItem binding below
        showingPhotoPicker = true
    }
    Button("File") {
        showingFilePicker = true
    }
    Button("Cancel", role: .cancel) {}
}
```

Note: The exact placement depends on the current ChatView layout. Insert the button inside the existing input HStack, before the TextField.

- [ ] **Step 4:** Add PhotosPicker and file picker sheet modifiers

Add these modifiers to the view:

```swift
.photosPicker(isPresented: $showingPhotoPicker, selection: $selectedPhotoItem, matching: .images)
.onChange(of: selectedPhotoItem) { _, newItem in
    guard let item = newItem else { return }
    Task {
        if let data = try? await item.loadTransferable(type: Data.self) {
            let filename = "photo-\(Date.now.timeIntervalSince1970).jpg"
            // Compress photos as JPEG; screenshots would ideally stay PNG
            // but PhotosPicker doesn't distinguish — JPEG at 0.8 is fine for debugging
            if let uiImage = UIImage(data: data),
               let compressed = uiImage.jpegData(compressionQuality: 0.8) {
                viewModel.sendAttachment(compressed, filename: filename, mimetype: "image/jpeg")
            } else {
                viewModel.sendAttachment(data, filename: filename, mimetype: "image/jpeg")
            }
        }
        selectedPhotoItem = nil
    }
}
.sheet(isPresented: $showingFilePicker) {
    DocumentPickerView { url in
        guard let data = try? Data(contentsOf: url) else { return }
        let filename = url.lastPathComponent
        let mimetype = url.mimeType ?? "application/octet-stream"
        viewModel.sendAttachment(data, filename: filename, mimetype: mimetype)
    }
}
```

- [ ] **Step 5:** Add `DocumentPickerView` UIKit bridge and `URL.mimeType` helper

Create a small UIKit wrapper (can be added at the bottom of ChatView.swift or as a separate file):

```swift
struct DocumentPickerView: UIViewControllerRepresentable {
    let onPick: (URL) -> Void
    
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item])
        picker.delegate = context.coordinator
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}
    
    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }
    
    class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        init(onPick: @escaping (URL) -> Void) { self.onPick = onPick }
        
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return }
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            onPick(url)
        }
    }
}

extension URL {
    var mimeType: String? {
        guard let utType = try? self.resourceValues(forKeys: [.contentTypeKey]).contentType else { return nil }
        return utType.preferredMIMEType
    }
}
```

- [ ] **Step 6:** Verify build

Run: `cd /Users/mokie/github/keepur-ios && xcodebuild -scheme Keeper -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`

- [ ] **Step 7:** Commit

```bash
cd /Users/mokie/github/keepur-ios
git add Views/ChatView.swift
git commit -m "feat: add attachment button with photo and file pickers"
```

---

### Deferred: `AttachmentBubble.swift`

The spec lists `Views/Components/AttachmentBubble.swift` for image thumbnails and file icons in chat bubbles. For v1, attachments display as plain text messages (`📷 filename` / `📎 filename`). The dedicated bubble component is a UI polish follow-up — not blocking functionality.

---

### Task 7: Hive quality gate

- [ ] **Step 1:** Run full check suite

Run: `cd /Users/mokie/github/hive && npm run check`
Expected: All pass (typecheck + lint + format + test)

- [ ] **Step 2:** Fix any lint/format issues

Run: `npm run format -- --write` if format issues found.
