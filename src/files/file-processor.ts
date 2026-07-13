/**
 * File processor — downloads Slack files and extracts text content.
 *
 * Supported types:
 *   - Images (png, jpg, gif, webp) — saved locally, path returned for multimodal
 *   - PDF — text extracted via pdf-parse
 *   - CSV/TSV/text/markdown/JSON — read as text
 *   - DOCX — text extracted via mammoth
 *   - XLSX — converted to CSV text via xlsx
 *   - Unsupported — metadata only, no content extraction
 */

import { createLogger } from "../logging/logger.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import type { LLMTaskRequest, LLMResult } from "../llm/types.js";
import { LLMProviderUnavailableError } from "../llm/errors.js";

const log = createLogger("file-processor");
const DOWNLOAD_DIR = join(tmpdir(), "hive-slack-files");
mkdirSync(DOWNLOAD_DIR, { recursive: true });

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

export interface ProcessedFile {
  name: string;
  mimetype: string;
  size: number;
  localPath: string;
  /** Extracted text content (null for images — agent uses Read tool) */
  textContent: string | null;
  /** Whether the file is an image the agent can view directly */
  isImage: boolean;
}

export const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"]);

const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image in detail. If it contains text, extract all of it. If it's a diagram, architecture drawing, or technical image, describe all labels, relationships, and structure. If it's a screenshot of messages or a conversation, transcribe everything. Be thorough.";

/** KPR-314: generous single-image bound (was: none on the raw fetch). */
const VISION_TIMEOUT_MS = 30_000;

/**
 * KPR-314 (PR #194's injection shape): the registry is injected rather than
 * imported — keeps this module unit-testable and import-cycle-free. The
 * vision task's model/provider knowledge lives in the registry catalog;
 * this module no longer knows Gemini exists.
 */
interface VisionLlmClient {
  generateForTask(task: "vision", request: LLMTaskRequest): Promise<LLMResult>;
}

let visionLlmClient: VisionLlmClient | undefined;

export function setVisionLlmClient(client: VisionLlmClient): void {
  visionLlmClient = client;
}

/** Test-only seam. */
export function resetVisionLlmClientForTests(): void {
  visionLlmClient = undefined;
}

export async function describeImage(buffer: Buffer, mimetype: string): Promise<string | null> {
  if (!visionLlmClient) return null;

  try {
    const result = await visionLlmClient.generateForTask("vision", {
      prompt: IMAGE_DESCRIPTION_PROMPT,
      images: [{ mimeType: mimetype, dataBase64: buffer.toString("base64") }],
      maxOutputTokens: 2048,
      temperature: 0,
      timeoutMs: VISION_TIMEOUT_MS,
    });
    if (!result.text) return null;
    log.info("Image described", {
      provider: result.provider,
      model: result.model,
      chars: result.text.length,
    });
    return result.text;
  } catch (e: unknown) {
    // Missing GEMINI_API_KEY ⇒ silent null — byte-identical to today's
    // key-less behavior (steady state ≠ incident). Everything else
    // (timeout / 429 / 5xx / capability misbinding) warns and degrades to
    // the metadata-only entry callers already handle.
    if (e instanceof LLMProviderUnavailableError) return null;
    log.warn("Image description failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
const TEXT_TYPES = new Set([
  "csv",
  "tsv",
  "txt",
  "text",
  "md",
  "markdown",
  "json",
  "xml",
  "html",
  "yaml",
  "yml",
  "log",
]);

/**
 * Extract text content from a buffer based on file type.
 * Shared by downloadAndProcess (Slack) and processFileBuffer (Team/WS).
 * Returns extracted text or null for unsupported types.
 */
export async function extractContent(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<{ textContent: string | null; isImage: false } | null> {
  const ext = extname(filename).slice(1).toLowerCase();

  // Text-based files
  if (TEXT_TYPES.has(ext) || mimetype.startsWith("text/")) {
    return { textContent: truncate(buffer.toString("utf-8")), isImage: false };
  }

  // PDF
  if (ext === "pdf" || mimetype === "application/pdf") {
    try {
      const pdfModule = await import("pdf-parse");
      const pdfParse = (pdfModule as any).default ?? pdfModule;
      const result = await pdfParse(buffer);
      return { textContent: truncate(result.text), isImage: false };
    } catch (e: any) {
      log.warn("PDF parse failed", { name: filename, error: e.message });
      return { textContent: "[PDF — could not extract text]", isImage: false };
    }
  }

  // DOCX
  if (ext === "docx" || mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return { textContent: truncate(result.value), isImage: false };
    } catch (e: any) {
      log.warn("DOCX parse failed", { name: filename, error: e.message });
      return { textContent: "[DOCX — could not extract text]", isImage: false };
    }
  }

  // XLSX
  if (ext === "xlsx" || ext === "xls" || mimetype.includes("spreadsheet")) {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
        return `--- Sheet: ${name} ---\n${csv}`;
      });
      return { textContent: truncate(sheets.join("\n\n")), isImage: false };
    } catch (e: any) {
      log.warn("XLSX parse failed", { name: filename, error: e.message });
      return { textContent: "[Spreadsheet — could not extract content]", isImage: false };
    }
  }

  // Unsupported
  return null;
}

export async function downloadAndProcess(file: SlackFile, botToken: string): Promise<ProcessedFile | null> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    log.warn("No download URL for file", { id: file.id, name: file.name });
    return null;
  }

  try {
    // Download from Slack — don't auto-follow redirects (auth header gets stripped)
    // Instead, follow manually without the auth header on the redirect target
    log.info("Downloading file", { id: file.id, url: url.slice(0, 80), mimetype: file.mimetype });
    let res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      redirect: "manual",
    });

    // Follow redirect to CDN (no auth needed on the redirect URL)
    if (res.status === 302 || res.status === 301) {
      const redirectUrl = res.headers.get("location");
      if (redirectUrl) {
        log.info("Following redirect", { id: file.id });
        res = await fetch(redirectUrl);
      }
    }

    if (!res.ok) {
      log.error("Failed to download file", { id: file.id, status: res.status });
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Detect Slack error responses returned as 200 with text body
    // (e.g., "The requested file could not be found.") — typically auth scope or expired file
    if (buffer.length < 100 && buffer.length > 0) {
      const text = buffer.toString("utf-8").trim();
      if (text.includes("requested") && text.includes("file") && text.includes("not found")) {
        log.error("Slack file error response", {
          id: file.id,
          name: file.name,
          errorText: text,
          bufferSize: buffer.length,
        });
        return null;
      }
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const localPath = join(DOWNLOAD_DIR, `${file.id}-${safeName}`);
    writeFileSync(localPath, buffer);

    const ext = extname(file.name).slice(1).toLowerCase();
    const isImage = IMAGE_TYPES.has(ext) || file.mimetype.startsWith("image/");

    // Images — describe via Gemini vision, fall back to metadata only
    if (isImage) {
      const description = await describeImage(buffer, file.mimetype);
      return {
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
        localPath,
        textContent: description ?? "[Image — could not extract description]",
        isImage: true,
      };
    }

    // Non-image content extraction (text, PDF, DOCX, XLSX)
    const extracted = await extractContent(buffer, file.name, file.mimetype);
    if (extracted) {
      return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, ...extracted };
    }

    // Unsupported type
    log.info("Unsupported file type", { name: file.name, ext, mimetype: file.mimetype });
    return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: null, isImage: false };
  } catch (e: any) {
    log.error("File processing failed", { id: file.id, name: file.name, error: e.message });
    return null;
  }
}

/** Process a raw image buffer (e.g. from WebSocket) into a ProcessedFile */
export async function processImageBuffer(buffer: Buffer, filename: string, mimetype: string): Promise<ProcessedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(DOWNLOAD_DIR, `ws-${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);

  const description = await describeImage(buffer, mimetype);
  return {
    name: filename,
    mimetype,
    size: buffer.length,
    localPath,
    textContent: description ?? "[Image — could not extract description]",
    isImage: true,
  };
}

/** Process a raw file buffer (non-image) into a ProcessedFile — PDF, DOCX, XLSX, text, etc. */
export async function processFileBuffer(buffer: Buffer, filename: string, mimetype: string): Promise<ProcessedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(DOWNLOAD_DIR, `team-${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);

  const ext = extname(filename).slice(1).toLowerCase();
  const isImage = IMAGE_TYPES.has(ext) || mimetype.startsWith("image/");

  // Images — use processImageBuffer instead
  if (isImage) {
    return processImageBuffer(buffer, filename, mimetype);
  }

  // Non-image content extraction (text, PDF, DOCX, XLSX)
  const extracted = await extractContent(buffer, filename, mimetype);
  if (extracted) {
    return { name: filename, mimetype, size: buffer.length, localPath, ...extracted };
  }

  // Unsupported
  return { name: filename, mimetype, size: buffer.length, localPath, textContent: null, isImage: false };
}

/** Format processed files as text to append to the agent prompt */
export function formatFilesForPrompt(files: ProcessedFile[]): string {
  if (files.length === 0) return "";

  const parts = files.map((f) => {
    const header = `📎 File: ${f.name} (${formatSize(f.size)}, ${f.mimetype})`;

    if (f.isImage) {
      if (f.textContent) {
        return `${header}\n--- image description ---\n${f.textContent}\n--- end image description ---`;
      }
      return `${header}\n  [Image received but could not be processed]`;
    }

    if (f.textContent) {
      return `${header}\n--- file content ---\n${f.textContent}\n--- end file content ---`;
    }

    return `${header}\n  Saved at: ${f.localPath}\n  (Content could not be extracted — file available for download)`;
  });

  return "\n\n" + parts.join("\n\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text: string, maxChars = 50_000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[... truncated at ${formatSize(maxChars)} — full file at local path]`;
}
