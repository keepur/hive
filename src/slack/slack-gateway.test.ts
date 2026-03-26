import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackGateway } from "./slack-gateway.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Track all chat.postMessage calls and files.uploadV2 calls
const postMessageMock = vi.fn().mockResolvedValue({ ts: "1234.5678" });
const uploadV2Mock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: postMessageMock },
    files: { uploadV2: uploadV2Mock },
  })),
}));

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    start: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

describe("SlackGateway.postMessage — message length handling", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  it("posts short messages normally (≤3900 chars)", async () => {
    const text = "Hello world";
    await gateway.postMessage("C123", text, "thread-1");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", text, thread_ts: "thread-1" }),
    );
  });

  it("posts messages at exactly 3900 chars as single message", async () => {
    const text = "a".repeat(3900);
    await gateway.postMessage("C123", text);

    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });

  it("splits messages between 3901-8000 chars into multiple messages", async () => {
    // Build a message slightly over 3900 chars with paragraph breaks
    const paragraph = "x".repeat(1900);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    // text is 1900 + 2 + 1900 + 2 + 1900 = 5704 chars

    await gateway.postMessage("C123", text, "thread-1");

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    // First chunk should NOT have continuation marker
    const firstCall = postMessageMock.mock.calls[0][0];
    expect(firstCall.text).not.toContain("_(cont.)_");
    // Second chunk SHOULD have continuation marker
    const secondCall = postMessageMock.mock.calls[1][0];
    expect(secondCall.text).toContain("_(cont.)_");
  });

  it("splits on paragraph boundaries (double newline) first", async () => {
    const part1 = "a".repeat(2000);
    const part2 = "b".repeat(2000);
    const part3 = "c".repeat(500);
    const text = `${part1}\n\n${part2}\n\n${part3}`;
    // 2000 + 2 + 2000 + 2 + 500 = 4504

    await gateway.postMessage("C123", text);

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    // First chunk should end near a paragraph boundary
    const firstChunk = postMessageMock.mock.calls[0][0].text;
    expect(firstChunk.length).toBeLessThanOrEqual(3900);
  });

  it("falls back to single newline split when no paragraph breaks", async () => {
    const line = "x".repeat(100);
    const lines = Array(50).fill(line).join("\n"); // 50 * 100 + 49 = 5049

    await gateway.postMessage("C123", lines);

    expect(postMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of postMessageMock.mock.calls) {
      // Each chunk (before cont. prefix) should be within limits
      expect(call[0].text.length).toBeLessThanOrEqual(3900 + 12); // 12 for "_(cont.)_ " prefix
    }
  });

  it("hard-cuts text with no whitespace", async () => {
    const text = "x".repeat(5000); // no whitespace at all
    await gateway.postMessage("C123", text);

    expect(postMessageMock.mock.calls.length).toBe(2);
    // First chunk should be exactly 3900 chars
    expect(postMessageMock.mock.calls[0][0].text).toBe("x".repeat(3900));
  });

  it("uploads as file for messages >8000 chars", async () => {
    const text = "This is a long response. " + "x".repeat(8100);
    await gateway.postMessage("C123", text, "thread-1", { name: "Remy", icon: ":wrench:" });

    // Should post summary first, then upload file
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const summaryCall = postMessageMock.mock.calls[0][0];
    expect(summaryCall.text).toContain("_(full response attached)_");

    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
    expect(uploadV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123",
        thread_ts: "thread-1",
        content: text,
        title: "Remy response",
      }),
    );
    // Filename should use agent name
    const uploadCall = uploadV2Mock.mock.calls[0][0];
    expect(uploadCall.filename).toMatch(/^remy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
  });

  it("falls back to 'hive' filename when no identity provided", async () => {
    const text = "y".repeat(8100);
    await gateway.postMessage("C123", text);

    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
    const uploadCall = uploadV2Mock.mock.calls[0][0];
    expect(uploadCall.filename).toMatch(/^hive-/);
    expect(uploadCall.title).toBe("hive response");
  });

  it("falls back to split when file upload fails", async () => {
    uploadV2Mock.mockRejectedValueOnce(new Error("upload_failed"));
    const text = "y".repeat(8100);
    await gateway.postMessage("C123", text);

    // 1 summary post + split posts (fallback)
    expect(postMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Upload was attempted
    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
  });

  it("preserves identity across split chunks", async () => {
    const text = "a".repeat(5000);
    const identity = { name: "Remy", icon: ":wrench:" };
    await gateway.postMessage("C123", text, undefined, identity);

    for (const call of postMessageMock.mock.calls) {
      expect(call[0].username).toBe("Remy");
      expect(call[0].icon_emoji).toBe(":wrench:");
    }
  });

  it("preserves thread_ts across all split chunks", async () => {
    const text = "a".repeat(5000);
    await gateway.postMessage("C123", text, "thread-99");

    for (const call of postMessageMock.mock.calls) {
      expect(call[0].thread_ts).toBe("thread-99");
    }
  });

  it("trims summary to sentence boundary for file upload", async () => {
    const text = "First sentence. Second sentence. Third sentence is very long. " + "x".repeat(8000);
    await gateway.postMessage("C123", text);

    const summaryText = postMessageMock.mock.calls[0][0].text as string;
    expect(summaryText).toContain("_(full response attached)_");
    // Should end at a sentence boundary, not mid-word
    const beforeAttached = summaryText.split("\n\n_(full response attached)_")[0];
    expect(beforeAttached).toMatch(/[.!?]$/);
  });
});
