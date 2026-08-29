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
  /** false ⇒ tools refuse with an honest notice, AND (KPR-409) the scribe and
   *  the summary anchor are off — gate 1 of both `noteActivity` and
   *  `getSummary` checks this flag, so it kills the whole subsystem, not just
   *  fetch-worker dispatch. `scribeEnabled` is the scribe-only lever. */
  enabled: boolean;

  // --- KPR-417 delay-then-ack (Child B1) ---
  /** false ⇒ a slow round-0 conference turn posts no acknowledgment. The
   *  rollback lever for KPR-417 — it changes VISIBLE meeting output (up to N
   *  messages per human trigger), so an operator must be able to silence it
   *  without a deploy (spec §10).
   *
   *  ⚠ DELIBERATELY INDEPENDENT OF `enabled`, unlike `scribeEnabled`. The
   *  scribe genuinely consumes pool machinery (runRoleTurn / hasCapacity), so
   *  the worker master switch must kill it. The ack consumes NO pool machinery
   *  at all — it lives in this section for config locality only. Gating it
   *  under `enabled` would mean an operator disabling fetch-workers silently
   *  loses an unrelated UX feature. Spec §5.6; pinned by config.test.ts.
   *
   *  Note the RECOGNITION FILTER is not gated on this flag at all (see
   *  Dispatcher.fetchMeetingHistory): flipping the lever off must not un-hide
   *  acks that are already sitting in a live thread. */
  ackEnabled: boolean;

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
  ackEnabled: true,
  scribeEnabled: true,
  scribeModel: "haiku",
  scribeDebounceMs: 90_000,
  scribeMinNewMessages: 6,
  scribeMaxConcurrent: 2,
  scribeMaxTurns: 4,
  scribeTimeoutMs: 120_000,
};
