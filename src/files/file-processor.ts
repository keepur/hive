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
    // Download from Slack (requires auth)
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });

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

    // Images — saved locally, agent views via Read tool
    if (isImage) {
      return { name: file.name, mimetype: file.mimetype, size: file.size, localPath, textContent: null, isImage: true };
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

/** Format processed files as text to append to the agent prompt */
export function formatFilesForPrompt(files: ProcessedFile[]): string {
  if (files.length === 0) return "";

  const parts = files.map((f) => {
    const header = `📎 File: ${f.name} (${formatSize(f.size)}, ${f.mimetype})`;

    if (f.isImage) {
      return `${header}\n  Image saved at: ${f.localPath}\n  Use the Read tool to view this image.`;
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
