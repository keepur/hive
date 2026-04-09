import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../logging/logger.js";
import { extractContent, IMAGE_TYPES } from "../files/file-processor.js";

const log = createLogger("beekeeper-file-handler");

const DOWNLOAD_DIR = join(tmpdir(), "bk-files");
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB decoded

let fileCounter = 0;
function uniqueSuffix(): string {
  fileCounter = (fileCounter + 1) % 1_000_000;
  return `${Date.now()}-${fileCounter}`;
}

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
export function decodeAndValidate(data: string, filename: string): { buffer: Buffer; safeName: string } {
  if (!filename) {
    throw new Error("Missing required field: filename");
  }
  const safeName = sanitizeFilename(filename);

  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("Invalid base64 data");
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
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
  const localPath = join(DOWNLOAD_DIR, `${uniqueSuffix()}-${safeName}`);
  writeFileSync(localPath, buffer);
  log.info("Image saved", { filename: safeName, size: buffer.length, path: localPath });

  return `The user attached an image: ${filename}\nRead this file before responding (it is an image): ${localPath}`;
}

/**
 * Process a non-image file: extract text content and return formatted prompt text.
 * Falls back to metadata-only prompt for unsupported types.
 */
export async function handleFile(data: string, filename: string, mimetype: string): Promise<string> {
  const { buffer, safeName } = decodeAndValidate(data, filename);
  const localPath = join(DOWNLOAD_DIR, `${uniqueSuffix()}-${safeName}`);
  writeFileSync(localPath, buffer);
  log.info("File saved", { filename: safeName, mimetype, size: buffer.length, path: localPath });

  // Check if this is actually an image sent via the "file" type
  const ext = extname(filename).slice(1).toLowerCase();
  if (IMAGE_TYPES.has(ext) || mimetype.startsWith("image/")) {
    return `The user attached an image: ${filename}\nRead this file before responding (it is an image): ${localPath}`;
  }

  // Try text extraction
  const extracted = await extractContent(buffer, filename, mimetype);

  if (extracted && extracted.textContent) {
    const header = `📎 File: ${filename} (${formatSize(buffer.length)}, ${mimetype})`;
    return `${header}\n--- file content ---\n${extracted.textContent}\n--- end file content ---`;
  }

  // Unsupported type — metadata only
  return `📎 File: ${filename} (${formatSize(buffer.length)}, ${mimetype}) — unsupported format, content not extracted`;
}
