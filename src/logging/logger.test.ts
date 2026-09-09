import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger, createTrackedLogSink, setLogLevel } from "./logger.js";

afterEach(() => setLogLevel("info"));

describe("tracked log sink", () => {
  it("acknowledges from the Writable callback and treats write(false) as backpressure", async () => {
    let release: ((error?: Error | null) => void) | undefined;
    const out = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const sink = createTrackedLogSink(out);
    const result = new Promise<string>((resolve) => sink.write("long line", resolve));

    expect(out.writableNeedDrain).toBe(true);
    expect(sink.snapshot().pending).toBe(1);
    release?.();
    await expect(result).resolves.toBe("acknowledged");
    expect(sink.snapshot().pending).toBe(0);
    sink.dispose();
    out.destroy();
  });

  it("contains synchronous throws, async callback errors, stream errors, and observers", async () => {
    const sync = new Writable({
      write: () => {
        throw new Error("sync");
      },
    });
    const syncSink = createTrackedLogSink(sync);
    expect(() =>
      syncSink.write("x", () => {
        throw new Error("observer");
      }),
    ).not.toThrow();
    expect(syncSink.snapshot().pending).toBe(0);
    syncSink.dispose();

    let finish: ((error?: Error | null) => void) | undefined;
    const asyncOut = new Writable({
      write(_c, _e, callback) {
        finish = callback;
      },
    });
    const asyncSink = createTrackedLogSink(asyncOut);
    const callbackFailure = new Promise<string>((resolve) => asyncSink.write("x", resolve));
    finish?.(new Error("async"));
    await expect(callbackFailure).resolves.toBe("failed");
    await new Promise((resolve) => setImmediate(resolve));
    expect(asyncSink.snapshot()).toEqual({ pending: 0, sinkErrors: 1 });
    asyncSink.dispose();
    asyncOut.destroy();

    const eventOut = new Writable({ write() {} });
    const eventSink = createTrackedLogSink(eventOut);
    const streamFailure = new Promise<string>((resolve) => eventSink.write("y", resolve));
    eventOut.emit("error", new Error("stream"));
    await expect(streamFailure).resolves.toBe("failed");
    expect(eventSink.snapshot()).toEqual({ pending: 0, sinkErrors: 1 });
    eventSink.dispose();
    eventOut.destroy();
  });

  it("bounds pending writes and fails all unresolved callbacks on disposal", async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const out = new Writable({
      write(_chunk, _encoding, callback) {
        callbacks.push(callback);
      },
    });
    const sink = createTrackedLogSink(out);
    const results: string[] = [];
    for (let index = 0; index < 257; index += 1) sink.write(String(index), (result) => results.push(result));

    expect(sink.snapshot().pending).toBe(256);
    expect(results).toEqual(["overflow"]);
    sink.dispose();
    expect(results.filter((result) => result === "failed")).toHaveLength(256);
    callbacks.forEach((callback) => callback());
    expect(results).toHaveLength(257);
    out.destroy();
  });
});

describe("tracked logger", () => {
  it("reports filtered writes without touching a process stream", async () => {
    setLogLevel("error");
    const logger = createLogger("filter-test");
    const result = await new Promise<string>((resolve) => logger.writeTracked("info", "hidden", undefined, resolve));
    expect(result).toBe("filtered");
  });

  it("reports serialization failure and contains a throwing result observer", () => {
    const logger = createLogger("serialization-test");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      logger.writeTracked("info", "circular", circular, () => {
        throw new Error("observer");
      }),
    ).not.toThrow();
  });
});
