import type { OpsPublisher } from "./publisher.js";

/**
 * D10: a module-global singleton, the provider-registry.ts precedent — the
 * consumer (the capture points) is module-scope, so the publisher must be
 * too. UNSET ⇒ every observe call is a no-op, which is what keeps the
 * pre-wiring boot window and every bare test construction correct BY
 * CONSTRUCTION rather than by ordering luck.
 */
let current: OpsPublisher | undefined;

export function setOpsPublisher(publisher: OpsPublisher | undefined): void {
  current = publisher;
}

export function opsPublisher(): OpsPublisher | undefined {
  return current;
}

export function __resetOpsPublisherForTests(): void {
  current = undefined;
}
