/** Resolve the per-instance LiveKit worker health listener. */
export function voiceWorkerPort(base: unknown, override: unknown): number {
  const portBase = base === undefined ? 3100 : base;
  if (!Number.isSafeInteger(portBase) || typeof portBase !== "number") {
    throw new Error("invalid instance.portBase");
  }
  const port = override === undefined ? portBase + 7 : override;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid instance.ports.voiceWorker");
  }
  return port;
}

/** Reject a worker listener that overlaps an existing resolved listener. */
export function assertWorkerPortAvailableInConfig(workerPort: number, listeners: Record<string, number>): void {
  for (const [name, port] of Object.entries(listeners)) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid ${name} port`);
    }
    if (port === workerPort) throw new Error(`voiceWorker port collides with ${name}`);
  }
}
