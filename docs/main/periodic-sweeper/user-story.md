# Periodic Sweeper — User Story

## User Story

**As a** Hive operator,
**I want** a periodic maintenance process that automatically cleans stale state, retries failed deliveries, and reports health metrics,
**So that** the system runs reliably without manual intervention, messages aren't silently lost, and I have visibility into system health via logs and the dodi_v2 dashboard.

## Acceptance Criteria

1. A sweeper runs every 5 minutes (configurable via `SWEEPER_INTERVAL_MS`)
2. Unbounded in-memory maps are pruned based on TTL:
   - `dispatcher.threadAgentMap` — 24h TTL
   - `slackAdapter.threadContextMap` — 24h TTL
   - `taskLedger.threadTaskMap` — 24h TTL
   - `slackGateway` name caches — cleared every ~1h
3. Completed background tasks and their `/tmp` files are cleaned after 7 days
4. Ended meeting sessions are removed from memory after 1 hour
5. Zombie agent states (for deleted agents) are cleaned up
6. Stuck processing queues are detected and unstuck
7. Failed message deliveries are retried with exponential backoff (30s base, 3 max attempts)
8. Each sweep cycle logs results: items pruned, retries attempted, bytes freed, errors
9. Sweep results are reported to dodi_v2 as comments on a persistent `[Sweeper]` task
10. Quiet sweeps (nothing to do) log at `debug` level, not `info`
11. Sweeper stops cleanly on SIGTERM/SIGINT shutdown

## Out of Scope

- Distributed retry (this is single-instance on a Mac Mini)
- Persistent message store / dead letter queue in MongoDB
- Circuit breaker for failing adapters
- Automatic agent query retry (too expensive, risk of duplicate responses)
