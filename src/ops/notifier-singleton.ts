/**
 * KPR-468 D10: the module-global singleton, on KPR-454's
 * publisher-singleton.ts precedent (itself the provider-registry.ts pattern).
 *
 * UNSET ⇒ every intake call returns { state: "unavailable" }, which keeps the
 * pre-wiring boot window and every bare test construction correct BY
 * CONSTRUCTION rather than by a caller remembering to check.
 */
import type { OpsIntakeResult, OpsAcknowledgement } from "./notification-types.js";
import type { OpsNotifier } from "./notifier.js";

let current: OpsNotifier | undefined;

export function setOpsNotifier(notifier: OpsNotifier): void {
  current = notifier;
}

export function opsNotifier(): OpsNotifier | undefined {
  return current;
}

export function __resetOpsNotifierForTests(): void {
  current = undefined;
}

/**
 * The whole of the seam KPR-455's inbound edge calls. A free function rather
 * than an exported instance so an unset singleton is a correct answer instead
 * of a crash — and so that child needs no knowledge of this module's lifecycle.
 */
export function acceptOpsAcknowledgement(input: OpsAcknowledgement): Promise<OpsIntakeResult> {
  return current ? current.accept(input) : Promise.resolve({ state: "unavailable" });
}
