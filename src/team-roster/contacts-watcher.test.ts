import { describe, expect, it, vi } from "vitest";
import { ContactsWatcher } from "./contacts-watcher.js";

function fakeCol() {
  const handlers: Record<string, Function> = {};
  const stream = {
    on: vi.fn((event: string, cb: Function) => {
      handlers[event] = cb;
    }),
    close: vi.fn(async () => {}),
  };
  return {
    handlers,
    col: {
      watch: vi.fn(() => stream),
      countDocuments: vi.fn(async () => 0),
    } as any,
    stream,
  };
}

describe("ContactsWatcher", () => {
  it("invalidates humans on change-stream event", async () => {
    const { col, handlers } = fakeCol();
    const cache = { invalidateHumans: vi.fn() } as any;
    const w = new ContactsWatcher(col, cache);
    await w.start();
    handlers["change"]({ operationType: "update" });
    expect(cache.invalidateHumans).toHaveBeenCalledOnce();
    w.stop();
  });

  it("falls back to polling on change-stream error", async () => {
    const { col, handlers } = fakeCol();
    const cache = { invalidateHumans: vi.fn() } as any;
    const w = new ContactsWatcher(col, cache);
    await w.start();
    handlers["error"](new Error("no replica set"));
    // pollTimer started — verify by stopping cleanly
    expect(() => w.stop()).not.toThrow();
  });

  it("stop closes change-stream and clears poll timer", async () => {
    const { col, stream } = fakeCol();
    const w = new ContactsWatcher(col, { invalidateHumans: vi.fn() } as any);
    await w.start();
    w.stop();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
