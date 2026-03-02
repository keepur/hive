# Implementation Roadmap: Agent Concurrency

## Design Summary

The bottleneck is `AgentManager.processQueue()` which uses a per-agent lock — only one message per agent at a time, regardless of thread. Additionally, `AgentRunner` is a singleton per agent with a shared `activeQuery` slot, preventing concurrent SDK calls.

**Fix**: Change lock granularity from per-agent to per-thread. Create runners per-call instead of per-agent. Add response timeout as safety net.

## Implementation Phases

### Phase 1: Config + Types (no behavioral change)
- Add `maxConcurrent?: number` and `timeoutMs?: number` to `AgentConfig`
- Add `activeThreadCount: number` to `AgentState`
- Parse new fields in `AgentRegistry.loadAgent()`

### Phase 2: Core Concurrency (parallel with Phase 3)
- Rewrite `AgentManager` to use per-thread queues and runner-per-call
- Add concurrency limit enforcement
- Add deferred thread retry mechanism
- Update `stopAgent()` and `stopAll()` for multi-runner abort
- Update health reporter to show active thread count

### Phase 3: Timeout Safety Net (parallel with Phase 2)
- Wrap `AgentRunner.send()` `for await` loop in a setTimeout
- Auto-abort on timeout, return error result

## Dependencies
- Phase 2 and 3 depend on Phase 1 (new config fields), but all can be implemented in parallel if agents are given the interface definitions

## Risk Considerations
- Each concurrent thread spawns its own MCP server subprocesses (capped by maxConcurrent)
- No session store race conditions — different threads write to different keys
