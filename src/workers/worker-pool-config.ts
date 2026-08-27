/**
 * KPR-390: `meetingWorkers` hive.yaml section — types + defaults.
 * Dependency-free leaf: imported by config.ts (resolver) and by the pool
 * service, so it must not import either (avoids a module cycle
 * config → pool → worker-claim-dedup → config).
 */
export interface MeetingWorkersConfig {
  /** Claude-lane pin for fetch workers (bare id or CLI alias — goes to SDK Options.model, not the sidecar catalog). */
  workerModel: string;
  /** Engine-wide live workers. */
  maxConcurrent: number;
  /** Running claims per meeting thread. */
  perMeetingMax: number;
  /** Watchdog deadline (claim TTL). Must stay > workerTimeoutMs — resolver clamps. */
  claimTtlMinutes: number;
  workerMaxTurns: number;
  /** 10m — KPR-354 nested-backstop precedent. */
  workerTimeoutMs: number;
  /** false ⇒ tools refuse with an honest notice; nothing else changes. */
  enabled: boolean;
}

export const DEFAULT_MEETING_WORKERS_CONFIG: MeetingWorkersConfig = {
  workerModel: "sonnet",
  maxConcurrent: 4,
  perMeetingMax: 3,
  claimTtlMinutes: 30,
  workerMaxTurns: 25,
  workerTimeoutMs: 600_000,
  enabled: true,
};
