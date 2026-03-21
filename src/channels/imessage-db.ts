import Database from "better-sqlite3";
import { createLogger } from "../logging/logger.js";

const log = createLogger("imessage-db");

/** Apple Core Data epoch: 2001-01-01T00:00:00Z in Unix seconds */
const APPLE_EPOCH_OFFSET = 978307200;

/** Group chat style in chat.db */
const GROUP_CHAT_STYLE = 43;

export interface ChatMessage {
  rowId: number;
  text: string | null;
  attributedBody: Buffer | null;
  isFromMe: number;
  date: number;
  service: string;
  sender: string;
  handleRowId: number;
}

export interface ParsedMessage {
  rowId: number;
  text: string;
  sender: string;
  handleRowId: number;
  service: string;
  date: Date;
}

/**
 * Convert Apple Core Data timestamp (nanoseconds since 2001-01-01) to JS Date.
 */
export function appleTimestampToDate(ts: number): Date {
  const unixSeconds = ts / 1_000_000_000 + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

/**
 * Extract plain text from an NSKeyedArchiver-encoded NSAttributedString blob.
 *
 * The blob is a binary plist containing an archived NSAttributedString.
 * The plain text is stored as a UTF-8 string within the archive. We locate it
 * by scanning for the NSString marker pattern and extracting the associated data.
 *
 * This avoids full plist parsing and handles emoji, CJK, and multi-byte correctly
 * by working at the byte level rather than regex.
 */
export function extractTextFromAttributedBody(blob: Buffer): string | null {
  try {
    // Strategy: the plain text in NSKeyedArchiver format is typically stored
    // after a "NSString" or "NS.string" key reference. The actual string data
    // appears as a raw UTF-8 byte sequence.
    //
    // A more reliable approach: look for the streamtyped marker that precedes
    // the text content. The pattern is:
    // 1. Find "NSString" or "NS.string" reference
    // 2. The UTF-8 text follows, length-prefixed or null-terminated
    //
    // Simplified approach: scan for the text between known binary markers.
    // In practice, the attributedBody stores the string after a specific header
    // and before attribute data.

    // Look for "NS.string" key which references the plain text value
    const nsStringMarker = Buffer.from("NS.string");
    let idx = blob.indexOf(nsStringMarker);

    if (idx === -1) {
      // Try alternate marker used in some macOS versions
      const nsDataMarker = Buffer.from("NS.data");
      idx = blob.indexOf(nsDataMarker);
    }

    if (idx === -1) {
      // Fallback: try to find the streamtyped header and extract text after it
      const streamTyped = Buffer.from("streamtyped");
      const stIdx = blob.indexOf(streamTyped);
      if (stIdx === -1) return null;

      // After streamtyped header, scan forward for readable UTF-8 text
      // The text typically starts after the class definition bytes
      return extractTextAfterHeader(blob, stIdx + streamTyped.length);
    }

    // Move past the marker
    idx += nsStringMarker.length;

    // Skip any type/length encoding bytes (typically 1-3 bytes)
    // Look for the start of actual UTF-8 text content
    while (idx < blob.length && blob[idx] < 0x20 && blob[idx] !== 0x0a) {
      idx++;
    }

    // Read until we hit a null byte or non-text control sequence
    const textStart = idx;
    let textEnd = idx;

    while (textEnd < blob.length) {
      const byte = blob[textEnd];
      // Stop at null terminator or specific binary markers that indicate end of text
      if (byte === 0x00) break;
      // Stop at NSAttributedString attribute markers (typically start with high bytes after text)
      if (byte === 0x06 && textEnd > textStart + 1) break;
      textEnd++;
    }

    if (textEnd <= textStart) return null;

    const text = blob.subarray(textStart, textEnd).toString("utf-8").trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    log.warn("Failed to extract text from attributedBody", { error: String(err) });
    return null;
  }
}

/**
 * Fallback text extraction — scan past binary header for readable text.
 */
function extractTextAfterHeader(blob: Buffer, offset: number): string | null {
  // Skip past class definition bytes (look for a longer run of printable chars)
  let idx = offset;
  let bestStart = -1;
  let bestLen = 0;

  while (idx < blob.length - 1) {
    // Find runs of printable UTF-8
    if (isPrintableUtf8Start(blob[idx])) {
      const runStart = idx;
      let runLen = 0;
      while (idx < blob.length && isPrintableOrUtf8Continuation(blob[idx])) {
        runLen++;
        idx++;
      }
      // Keep the longest run (the actual message text is usually the longest string)
      if (runLen > bestLen && runLen > 4) {
        bestStart = runStart;
        bestLen = runLen;
      }
    } else {
      idx++;
    }
  }

  if (bestStart === -1) return null;

  const text = blob
    .subarray(bestStart, bestStart + bestLen)
    .toString("utf-8")
    .trim();
  return text.length > 0 ? text : null;
}

function isPrintableUtf8Start(byte: number): boolean {
  // ASCII printable (space through ~), or UTF-8 multi-byte start (0xC0+)
  return (byte >= 0x20 && byte <= 0x7e) || byte >= 0xc0;
}

function isPrintableOrUtf8Continuation(byte: number): boolean {
  // ASCII printable, newline/tab, or UTF-8 continuation byte (0x80-0xBF) or start byte (0xC0+)
  return (byte >= 0x20 && byte <= 0x7e) || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte >= 0x80;
}

/**
 * Thin wrapper around chat.db for reading iMessages.
 */
export class IMessageDb {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? `${process.env.HOME}/Library/Messages/chat.db`;
    this.db = new Database(path, { readonly: true });
  }

  /**
   * Fetch new inbound messages since lastSeenRowId, excluding group chats.
   */
  getNewMessages(lastSeenRowId: number): ParsedMessage[] {
    const rows = this.db
      .prepare(
        `
      SELECT m.ROWID AS rowId, m.text, m.attributedBody, m.is_from_me AS isFromMe,
             m.date, m.service, h.id AS sender, h.ROWID AS handleRowId
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ?
        AND m.is_from_me = 0
        AND m.is_empty = 0
        AND (c.style IS NULL OR c.style != ?)
      ORDER BY m.ROWID ASC
    `,
      )
      .all(lastSeenRowId, GROUP_CHAT_STYLE) as ChatMessage[];

    const results: ParsedMessage[] = [];

    for (const row of rows) {
      // Extract text — prefer text column, fall back to attributedBody blob
      let text = row.text;
      if (!text && row.attributedBody) {
        text = extractTextFromAttributedBody(row.attributedBody);
        if (!text) {
          log.warn("Could not extract text from attributedBody, skipping", { rowId: row.rowId });
          continue;
        }
      }
      if (!text) continue;

      results.push({
        rowId: row.rowId,
        text,
        sender: row.sender,
        handleRowId: row.handleRowId,
        service: row.service,
        date: appleTimestampToDate(row.date),
      });
    }

    return results;
  }

  /**
   * Get the current maximum ROWID in the message table.
   * Used to initialize lastSeenRowId on first run (skip historical messages).
   */
  getMaxRowId(): number {
    const row = this.db.prepare("SELECT MAX(ROWID) AS maxId FROM message").get() as { maxId: number | null };
    return row.maxId ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
