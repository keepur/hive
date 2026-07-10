/**
 * KPR-307: Mongo-backed outage queue — turns fast-failed by KPR-306's
 * provider circuit breaker persist here for automatic replay after recovery.
 * Distinct from the delivery retry queue (src/sweeper/retry-queue.ts), which
 * handles "turn succeeded, channel delivery failed" and is untouched.
 */
import type { Collection, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { WorkItem } from "../types/work-item.js";

const log = createLogger("outage-queue");

export interface OutageQueueConfig {
  /** false = interception fully off; fast-fails fall back to today's raw error path. */
  enabled: boolean;
  /** Replay poller tick interval (own timer — NOT a sweeper step; must track the breaker's ≤60s probe cadence). */
  replayIntervalMs: number;
  /** Items older than this at replay time are marked expired, not run (§5-2c). */
  maxAgeHours: number;
  /** Global pending-depth cap; at cap new turns are NOT queued and get the overflow notice (§5-2f). */
  maxDepth: number;
  /** Real (non-fast-fail) replay attempts before terminal `failed` (§5-2g). */
  maxReplayAttempts: number;
}

/** ⚠ spec §10 delegated defaults, chosen for the 30-minute-outage profile. */
export const DEFAULT_OUTAGE_QUEUE_CONFIG: OutageQueueConfig = {
  enabled: true,
  replayIntervalMs: 15_000,
  maxAgeHours: 4,
  maxDepth: 500,
  maxReplayAttempts: 3,
};
