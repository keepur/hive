# Periodic Sweeper — Implementation Roadmap

## Design Summary

The sweeper is a periodic maintenance module (like the existing Scheduler) that runs on a `setInterval` timer. It calls `sweep()` on each participating component, processes a retry queue for failed deliveries, and reports aggregate results to both hive.log and dodi_v2.

**Key technical decisions:**
- Parallel timestamp maps (`lastSeen`) alongside existing maps — avoids refactoring value types
- Sequential sweep execution — all operations are fast (<100ms total), no need for Promise.all
- In-memory retry queue — acceptable for single-instance, lost on restart
- dodi_v2 reporting via existing TaskClient — one long-running `[Sweeper]` task with comment per cycle

## Implementation Phases

### Phase 1: Foundation (no deps on existing code)
- Create `src/sweeper/retry-queue.ts` — standalone retry queue with exponential backoff
- Create `src/sweeper/sweeper.ts` — orchestrator class
- Add config block to `src/config.ts`

### Phase 2: Component sweep() methods
- Add `sweep()` to dispatcher, task-ledger, slack-adapter (timestamp pattern — parallel lastSeen maps)
- Add async `sweep()` to background-task-manager (disk cleanup)
- Add `sweep()` to meeting-monitor (requires `endedAt` field addition)
- Add `sweep()` to slack-gateway (simple cache clear)
- Add `sweep()` to agent-manager (zombie + stuck queue detection)

### Phase 3: Integration
- Add retry queue to dispatcher (wrap 5 deliver call sites)
- Wire sweeper into index.ts (instantiate, start, shutdown)
- Add dodi_v2 reporting to sweeper

## Dependencies

- `src/tasks/task-client.ts` — already exists, used for dodi_v2 reporting
- All target components must exist before sweeper can reference them
- Config must be added before sweeper instantiation

## Risk Considerations

- **Sweep during active processing**: sweep() only touches stale entries (TTL-based), so active threads are safe
- **Disk I/O in bgTaskManager.sweep()**: async, non-blocking, but could be slow with many files
- **Retry queue memory**: unbounded in theory, but entries expire after 3 attempts — max ~100 entries
- **Gateway cache clear**: causes burst of Slack API calls after sweep, but bounded by org size
