export class VoiceRequestCancelledError extends Error {
  constructor() {
    super("Voice request cancelled");
    this.name = "VoiceRequestCancelledError";
  }
}

export function checkVoiceRequest(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VoiceRequestCancelledError();
}

export function bindVoiceRequest(signal: AbortSignal | undefined, cancel: () => void): () => void {
  if (!signal) return () => {};
  let fired = false;
  const onAbort = () => {
    if (fired) return;
    fired = true;
    try {
      cancel();
    } catch {
      // AbortSignal listeners must never throw.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}

export async function waitForVoiceOpening(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  checkVoiceRequest(signal);
  let detach = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    detach = bindVoiceRequest(signal, () => reject(new VoiceRequestCancelledError()));
  });
  try {
    await Promise.race([pending, cancelled]);
    checkVoiceRequest(signal);
  } finally {
    detach();
  }
}
