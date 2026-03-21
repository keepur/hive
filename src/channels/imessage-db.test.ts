import { describe, it, expect, vi, beforeEach } from "vitest";
import { appleTimestampToDate, extractTextFromAttributedBody } from "./imessage-db.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockAll = vi.fn();
const mockGet = vi.fn();
const mockPrepare = vi.fn(() => ({ all: mockAll, get: mockGet }));
const mockClose = vi.fn();

vi.mock("better-sqlite3", () => ({
  default: vi.fn(() => ({
    prepare: mockPrepare,
    close: mockClose,
  })),
}));

// ---------------------------------------------------------------------------
// appleTimestampToDate
// ---------------------------------------------------------------------------

describe("appleTimestampToDate", () => {
  it("converts Apple Core Data nanosecond timestamp to JS Date", () => {
    // 2024-01-01T00:00:00Z in Apple epoch nanoseconds:
    // Unix seconds for 2024-01-01: 1704067200
    // Apple seconds: 1704067200 - 978307200 = 725760000
    // Apple nanoseconds: 725760000 * 1e9
    const appleNs = 725760000 * 1_000_000_000;
    const date = appleTimestampToDate(appleNs);
    expect(date.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("handles Apple epoch start (2001-01-01)", () => {
    const date = appleTimestampToDate(0);
    expect(date.toISOString()).toBe("2001-01-01T00:00:00.000Z");
  });

  it("handles sub-second precision", () => {
    // 500ms after epoch
    const appleNs = 500_000_000;
    const date = appleTimestampToDate(appleNs);
    expect(date.getTime()).toBe(new Date("2001-01-01T00:00:00.500Z").getTime());
  });
});

// ---------------------------------------------------------------------------
// extractTextFromAttributedBody
// ---------------------------------------------------------------------------

describe("extractTextFromAttributedBody", () => {
  it("returns null for empty buffer", () => {
    expect(extractTextFromAttributedBody(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for buffer with no recognizable markers", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(extractTextFromAttributedBody(buf)).toBeNull();
  });

  it("extracts text after NS.string marker", () => {
    // Build a buffer: some prefix bytes + "NS.string" + length byte + "Hello world" + null terminator
    const prefix = Buffer.from([0x00, 0x01, 0x02]);
    const marker = Buffer.from("NS.string");
    const lengthByte = Buffer.from([0x0b]); // control byte < 0x20, skipped
    const text = Buffer.from("Hello world");
    const terminator = Buffer.from([0x00]);
    const buf = Buffer.concat([prefix, marker, lengthByte, text, terminator]);

    expect(extractTextFromAttributedBody(buf)).toBe("Hello world");
  });

  it("extracts text with emoji after NS.string marker", () => {
    const prefix = Buffer.from([0x00]);
    const marker = Buffer.from("NS.string");
    const lengthByte = Buffer.from([0x05]);
    const text = Buffer.from("Hey there 👋");
    const terminator = Buffer.from([0x00]);
    const buf = Buffer.concat([prefix, marker, lengthByte, text, terminator]);

    expect(extractTextFromAttributedBody(buf)).toBe("Hey there 👋");
  });

  it("returns null when text region is empty after NS.string marker", () => {
    const marker = Buffer.from("NS.string");
    const terminator = Buffer.from([0x00]);
    const buf = Buffer.concat([marker, terminator]);

    expect(extractTextFromAttributedBody(buf)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IMessageDb
// ---------------------------------------------------------------------------

describe("IMessageDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // We need to dynamically import after mocks are set up
  async function createDb() {
    const { IMessageDb } = await import("./imessage-db.js");
    return new IMessageDb("/fake/chat.db");
  }

  describe("getNewMessages", () => {
    it("returns parsed messages with text column", async () => {
      mockAll.mockReturnValue([
        {
          rowId: 101,
          text: "Hello there",
          attributedBody: null,
          isFromMe: 0,
          date: 725760000 * 1_000_000_000, // 2024-01-01
          service: "iMessage",
          sender: "+15551234567",
          handleRowId: 5,
        },
      ]);

      const db = await createDb();
      const messages = db.getNewMessages(100);

      expect(messages).toHaveLength(1);
      expect(messages[0].rowId).toBe(101);
      expect(messages[0].text).toBe("Hello there");
      expect(messages[0].sender).toBe("+15551234567");
      expect(messages[0].service).toBe("iMessage");
      expect(messages[0].date).toBeInstanceOf(Date);
    });

    it("skips messages with null text and null attributedBody", async () => {
      mockAll.mockReturnValue([
        {
          rowId: 102,
          text: null,
          attributedBody: null,
          isFromMe: 0,
          date: 0,
          service: "iMessage",
          sender: "+15551234567",
          handleRowId: 5,
        },
      ]);

      const db = await createDb();
      const messages = db.getNewMessages(100);

      expect(messages).toHaveLength(0);
    });

    it("falls back to attributedBody when text is null", async () => {
      // Build a buffer with NS.string marker and extractable text
      const marker = Buffer.from("NS.string");
      const lengthByte = Buffer.from([0x05]);
      const text = Buffer.from("Extracted text");
      const terminator = Buffer.from([0x00]);
      const blob = Buffer.concat([marker, lengthByte, text, terminator]);

      mockAll.mockReturnValue([
        {
          rowId: 103,
          text: null,
          attributedBody: blob,
          isFromMe: 0,
          date: 0,
          service: "iMessage",
          sender: "+15559876543",
          handleRowId: 6,
        },
      ]);

      const db = await createDb();
      const messages = db.getNewMessages(100);

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Extracted text");
    });

    it("skips message when attributedBody extraction fails", async () => {
      // Buffer with no recognizable markers
      const badBlob = Buffer.from([0x00, 0x01, 0x02]);

      mockAll.mockReturnValue([
        {
          rowId: 104,
          text: null,
          attributedBody: badBlob,
          isFromMe: 0,
          date: 0,
          service: "iMessage",
          sender: "+15551111111",
          handleRowId: 7,
        },
      ]);

      const db = await createDb();
      const messages = db.getNewMessages(100);

      expect(messages).toHaveLength(0);
    });

    it("passes lastSeenRowId to the query", async () => {
      mockAll.mockReturnValue([]);

      const db = await createDb();
      db.getNewMessages(500);

      expect(mockAll).toHaveBeenCalledWith(500, 43); // 43 = GROUP_CHAT_STYLE
    });
  });

  describe("getMaxRowId", () => {
    it("returns max ROWID from message table", async () => {
      mockGet.mockReturnValue({ maxId: 12345 });

      const db = await createDb();
      const maxId = db.getMaxRowId();

      expect(maxId).toBe(12345);
    });

    it("returns 0 when table is empty", async () => {
      mockGet.mockReturnValue({ maxId: null });

      const db = await createDb();
      const maxId = db.getMaxRowId();

      expect(maxId).toBe(0);
    });
  });
});
