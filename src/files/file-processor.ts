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

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

let geminiApiKey = "";
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";

/** Set the Gemini API key for image processing */
export function setGeminiApiKey(key: string): void {
  geminiApiKey = key;
}

export async function describeImageWithGemini(buffer: Buffer, mimetype: string): Promise<string | null> {
  if (!geminiApiKey) return null;

  try {
    const base64 = buffer.toString("base64");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimetype, data: base64 } },
              { text: "Describe this image in detail. If it contains text, extract all of it. If it's a diagram, architecture drawing, or technical image, describe all labels, relationships, and structure. If it's a screenshot of messages or a conversation, transcribe everything. Be thorough." },
            ],
          }],
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      log.warn("Gemini vision error", { status: res.status, error: err.slice(0, 200) });
      return null;
    }

    const data = await res.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      log.info("Image described via Gemini", { model: GEMINI_MODEL, chars: text.length });
    }
    return text || null;
  } catch (e: any) {
    log.warn("Gemini vision failed", { error: e.message });
    return null;
  }
}
const TEXT_TYPES = new Set(["csv", "tsv", "txt", "text", "md", "markdown", "json", "xml", "html", "yaml", "yml", "log"]);

export async function downloadAndProcess(
  file: SlackFile,
  botToken: string,
): Promise<ProcessedFile | null> {
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
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const localPath = join(DOWNLOAD_DIR, `${file.id}-${safeName}`);
    writeFileSync(localPath, buffer);

    const ext = extname(file.name).slice(1).toLowerCase();
    const isImage = IMAGE_TYPES.has(ext) || file.mimetype.startsWith("image/");

    // Images — describe via Gemini vision, fall back to metadata only
    if (isImage) {
      const description = await describeImageWithGemini(buffer, file.mimetype);
      return {
        name: file.name, mimetype: file.mimetype, size: file.size, localPath,
        textContent: description ?? "[Image — could not extract description]",
        isImage: true,
      };
    }

    // Text-based files
    if (TEXT_TYPES.has(ext) || file.mimetype.startsWith("text/")) {
      const text = buffer.toString("utf-8");
      return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: truncate(text), isImage: false };
    }

    // PDF
    if (ext === "pdf" || file.mimetype === "application/pdf") {
      try {
        const pdfModule = await import("pdf-parse");
        const pdfParse = (pdfModule as any).default ?? pdfModule;
        const result = await pdfParse(buffer);
        return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: truncate(result.text), isImage: false };
      } catch (e: any) {
        log.warn("PDF parse failed", { name: file.name, error: e.message });
        return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: "[PDF — could not extract text]", isImage: false };
      }
    }

    // DOCX
    if (ext === "docx" || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: truncate(result.value), isImage: false };
      } catch (e: any) {
        log.warn("DOCX parse failed", { name: file.name, error: e.message });
        return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: "[DOCX — could not extract text]", isImage: false };
      }
    }

    // XLSX
    if (ext === "xlsx" || ext === "xls" || file.mimetype.includes("spreadsheet")) {
      try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheets = workbook.SheetNames.map((name) => {
          const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
          return `--- Sheet: ${name} ---\n${csv}`;
        });
        return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: truncate(sheets.join("\n\n")), isImage: false };
      } catch (e: any) {
        log.warn("XLSX parse failed", { name: file.name, error: e.message });
        return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: "[Spreadsheet — could not extract content]", isImage: false };
      }
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
export async function processImageBuffer(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<ProcessedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(DOWNLOAD_DIR, `ws-${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);

  const description = await describeImageWithGemini(buffer, mimetype);
  return {
    name: filename,
    mimetype,
    size: buffer.length,
    localPath,
    textContent: description ?? "[Image — could not extract description]",
    isImage: true,
  };
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
