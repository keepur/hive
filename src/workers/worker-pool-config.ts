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

  // --- KPR-409 scribe (Part B) ---
  /** The rollback lever for the prompt-shape change. false ⇒ no scribe runs
   *  AND no anchor branch (getSummary short-circuits) ⇒ byte-identical to
   *  pre-KPR-409. Deliberately separate from `enabled` so an operator can keep
   *  fetch-workers while reverting the injection change. */
  scribeEnabled: boolean;
  /** Claude-lane pin for the scribe — same posture as workerModel. */
  scribeModel: string;
  /** Minimum wall clock between two scribe runs on one thread. */
  scribeDebounceMs: number;
  /** Novelty floor: fewer new messages than this ⇒ abandon silently. */
  scribeMinNewMessages: number;
  /** Engine-wide live scribes. SEPARATE from maxConcurrent — scribes never
   *  consume a fetch-worker slot (spec §D3 capacity disposition). */
  scribeMaxConcurrent: number;
  /** Runaway bound, not a working budget — coreServers: [] means no MCP loop. */
  scribeMaxTurns: number;
  /** Scribe wall clock. No claimTtlMinutes interaction — the scribe creates no claim. */
  scribeTimeoutMs: number;
}

export const DEFAULT_MEETING_WORKERS_CONFIG: MeetingWorkersConfig = {
  workerModel: "sonnet",
  maxConcurrent: 4,
  perMeetingMax: 3,
  claimTtlMinutes: 30,
  workerMaxTurns: 25,
  workerTimeoutMs: 600_000,
  enabled: true,
  scribeEnabled: true,
  scribeModel: "haiku",
  scribeDebounceMs: 90_000,
  scribeMinNewMessages: 6,
  scribeMaxConcurrent: 2,
  scribeMaxTurns: 4,
  scribeTimeoutMs: 120_000,
};
