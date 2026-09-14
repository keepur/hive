import { describe, expect, it, vi } from "vitest";
import {
  bindVoiceRequest,
  checkVoiceRequest,
  VoiceRequestCancelledError,
  waitForVoiceOpening,
} from "./voice-request-cancellation.js";

describe("voice request cancellation", () => {
  it("throws the typed cancellation only for an aborted signal", () => {
    const controller = new AbortController();
    expect(() => checkVoiceRequest(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => checkVoiceRequest(controller.signal)).toThrow(VoiceRequestCancelledError);
  });

  it("fires once, contains callback failures, and supports disposal", () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => {
      throw new Error("foreign abort failure");
    });
    const detach = bindVoiceRequest(controller.signal, cancel);

    expect(() => controller.abort()).not.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(() => detach()).not.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);

    const detachedController = new AbortController();
    const detached = vi.fn();
    bindVoiceRequest(detachedController.signal, detached)();
    detachedController.abort();
    expect(detached).not.toHaveBeenCalled();
  });

  it("fires synchronously for a signal already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const cancel = vi.fn();
    bindVoiceRequest(controller.signal, cancel);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("waits for opening completion and cancels only its own waiter", async () => {
    let publish!: () => void;
    const pending = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = waitForVoiceOpening(pending, first.signal);
    const surviving = waitForVoiceOpening(pending, second.signal);

    first.abort();
    await expect(cancelled).rejects.toBeInstanceOf(VoiceRequestCancelledError);
    publish();
    await expect(surviving).resolves.toBeUndefined();
  });
});
