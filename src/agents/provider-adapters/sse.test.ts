import { describe, expect, it } from "vitest";
import { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";

describe("splitSseEvents", () => {
  it("splits on LF blank-line boundaries", () => {
    const { events, remainder } = splitSseEvents("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(events).toEqual(["event: a\ndata: 1", "event: b\ndata: 2"]);
    expect(remainder).toBe("");
  });

  it("splits on CRLF blank-line boundaries", () => {
    const { events, remainder } = splitSseEvents("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n");
    expect(events).toEqual(["event: a\r\ndata: 1", "event: b\r\ndata: 2"]);
    expect(remainder).toBe("");
  });

  it("returns a trailing partial block as remainder", () => {
    const { events, remainder } = splitSseEvents("event: a\ndata: 1\n\nevent: b\ndata: par");
    expect(events).toEqual(["event: a\ndata: 1"]);
    expect(remainder).toBe("event: b\ndata: par");
  });

  it("returns no events for an empty buffer", () => {
    expect(splitSseEvents("")).toEqual({ events: [], remainder: "" });
  });
});

describe("parseSseEvent", () => {
  it("parses an event name plus a single data line", () => {
    expect(parseSseEvent("event: response.output_text.delta\ndata: {\"a\":1}")).toEqual({
      event: "response.output_text.delta",
      data: '{"a":1}',
    });
  });

  it("joins multiple data lines with a newline", () => {
    expect(parseSseEvent("event: x\ndata: one\ndata: two")).toEqual({
      event: "x",
      data: "one\ntwo",
    });
  });

  it("trims the event name and leading data whitespace", () => {
    expect(parseSseEvent("event:  spaced  \ndata: x")?.event).toBe("spaced");
    expect(parseSseEvent("data: x")).toEqual(parseSseEvent("data:x"));
  });

  it("skips comment lines", () => {
    expect(parseSseEvent(": keep-alive\nevent: x\n: another\ndata: y")).toEqual({
      event: "x",
      data: "y",
    });
  });

  it("returns null for a pure-comment block", () => {
    expect(parseSseEvent(": keep-alive")).toBeNull();
  });

  it("returns null for a block with an event but no data lines", () => {
    expect(parseSseEvent("event: x")).toBeNull();
  });
});

describe("isSseDone", () => {
  it("is true for the [DONE] sentinel", () => {
    expect(isSseDone({ data: "[DONE]" })).toBe(true);
  });

  it("is false for other payloads", () => {
    expect(isSseDone({ data: '{"type":"response.completed"}' })).toBe(false);
    expect(isSseDone({ event: "done", data: "" })).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isSseDone({ data: "[done]" })).toBe(false);
  });
});
