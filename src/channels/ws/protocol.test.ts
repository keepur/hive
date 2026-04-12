import { describe, it, expect } from "vitest";
import { parseClientMessage, isTeamMessage } from "./protocol.js";

describe("parseClientMessage — Team extensions", () => {
  it("parses Team message (message with channelId)", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "message",
        channelId: "dm:a:b",
        text: "hello",
        id: "m1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("message");
    expect(isTeamMessage(msg!)).toBe(true);
    expect((msg as any).channelId).toBe("dm:a:b");
  });

  it("parses legacy message (no channelId)", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "message",
        text: "hello",
        id: "m1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(isTeamMessage(msg!)).toBe(false);
  });

  it("parses Team message with threadId", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "message",
        channelId: "general",
        text: "hello",
        threadId: "t1",
        id: "m1",
      }),
    );
    expect(msg).toBeTruthy();
    expect((msg as any).threadId).toBe("t1");
  });

  it("parses Team image", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "image",
        channelId: "dm:a:b",
        data: "base64data",
        filename: "photo.png",
        id: "i1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("image");
    expect(isTeamMessage(msg!)).toBe(true);
  });

  it("parses legacy image (no channelId)", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "image",
        data: "base64data",
        filename: "photo.png",
        id: "i1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(isTeamMessage(msg!)).toBe(false);
  });

  it("parses file message", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "file",
        channelId: "general",
        data: "base64data",
        filename: "doc.pdf",
        mimetype: "application/pdf",
        id: "f1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("file");
    expect(isTeamMessage(msg!)).toBe(true);
  });

  it("rejects file message with missing fields", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "file",
          channelId: "general",
          // missing data, filename, mimetype
          id: "f1",
        }),
      ),
    ).toBeNull();
  });

  it("parses command", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "command",
        channelId: "general",
        name: "help",
        args: [],
        id: "c1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("command");
  });

  it("parses command_list", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "command_list",
        id: "cl1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("command_list");
  });

  it("parses channel_list", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "channel_list",
        id: "ch1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("channel_list");
  });

  it("parses history request", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "history",
        channelId: "general",
        before: "abc123",
        limit: 25,
        id: "h1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("history");
    expect((msg as any).before).toBe("abc123");
    expect((msg as any).limit).toBe(25);
  });

  it("parses history without optional fields", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "history",
        channelId: "general",
        id: "h2",
      }),
    );
    expect(msg).toBeTruthy();
    expect((msg as any).before).toBeUndefined();
    expect((msg as any).limit).toBeUndefined();
  });

  it("parses join", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "join",
        channelId: "general",
        id: "j1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("join");
  });

  it("parses leave", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "leave",
        channelId: "general",
        id: "l1",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("leave");
  });

  it("parses ping (unchanged)", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "ping" }));
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("ping");
  });

  it("returns null for invalid JSON", () => {
    expect(parseClientMessage("not json")).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("returns null for null/non-object", () => {
    expect(parseClientMessage("null")).toBeNull();
    expect(parseClientMessage('"string"')).toBeNull();
  });

  it("coerces command args to strings", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "command",
        channelId: "ch",
        name: "test",
        args: [123, true],
        id: "c2",
      }),
    );
    expect(msg).toBeTruthy();
    expect((msg as any).args).toEqual(["123", "true"]);
  });
});

describe("parseClientMessage — agent_list", () => {
  it("parses valid agent_list request", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: "agent_list",
        id: "abc",
      }),
    );
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("agent_list");
    expect((msg as any).id).toBe("abc");
  });

  it("rejects agent_list with missing id field", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "agent_list",
        }),
      ),
    ).toBeNull();
  });

  it("rejects agent_list with non-string id", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "agent_list",
          id: 123,
        }),
      ),
    ).toBeNull();
  });
});
