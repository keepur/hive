# Two-Turn Dispatch — Implementation Specs

## Files to Create

### `src/agents/triage.ts` (NEW)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { ChannelKind } from "../types/work-item.js";
import { config } from "../config.js";

export interface TriageResult {
  response: string;
  action: "done" | "continue";
  costUsd: number;
  durationMs: number;
}
```

**Function**: `triage(text, agentConfig, context)` → `Promise<TriageResult>`

**System prompt construction**:
- Triage preamble (classification instructions)
- Agent's `soul` (personality)
- Thread context note (if applicable)

**SDK query options**:
- `model`: `agentConfig.triageModel ?? config.triage.model`
- `tools: []` — disables ALL built-in tools
- `maxTurns: 1`
- `persistSession: false`
- `thinking: { type: "disabled" }`
- `maxBudgetUsd: 0.01`
- No `mcpServers`

**JSON parse chain**:
1. Try `JSON.parse(resultText)`
2. Try strip markdown fences, then parse
3. Fallback: `{ response: resultText || "On it...", action: "continue" }`

**Timeout**: 10s via `setTimeout` + `query.close()` (same pattern as AgentRunner)

**Error handling**: catch all, log warning, return default `continue` result

## Files to Modify

### `src/config.ts`

Add after `background` block:

```typescript
triage: {
  model: optional("TRIAGE_MODEL", "claude-haiku-4-5-20251001"),
  timeoutMs: parseInt(optional("TRIAGE_TIMEOUT_MS", "10000"), 10),
  enabled: optional("TRIAGE_ENABLED", "true") === "true",
},
```

### `src/types/agent-config.ts`

Add to `AgentConfig` interface:

```typescript
triageModel?: string;  // Override triage model. Default: config.triage.model
```

### `src/agents/agent-registry.ts`

In `loadAgent()`, parse `triageModel` from YAML:

```typescript
triageModel: (raw.triageModel as string) || undefined,
```

### `src/channels/dispatcher.ts`

Import triage:
```typescript
import { triage } from "../agents/triage.js";
```

In `dispatch()`, after agent resolution (line ~96), before full agent send:

```typescript
const isInteractive = item.source.kind === "slack" || item.source.kind === "sms";

if (isInteractive && config.triage.enabled && agentConfig) {
  await adapter?.onProcessingStart?.(item);
  try {
    const triageResult = await triage(item.text, agentConfig, {
      isThread: !!item.threadId,
    });

    if (triageResult.action === "done") {
      // Triage handled it completely
      const workResult = { text: triageResult.response, agentId, workItem: item,
        costUsd: triageResult.costUsd, durationMs: triageResult.durationMs };
      if (adapter) await adapter.deliver(workResult);
      // audit log...
      await adapter?.onProcessingEnd?.(item);
      return;
    }

    // action === "continue" — post ack, then proceed to full agent
    const ackResult = { text: triageResult.response, agentId, workItem: item,
      costUsd: triageResult.costUsd, durationMs: triageResult.durationMs };
    if (adapter) await adapter.deliver(ackResult);
    await adapter?.onProcessingEnd?.(item);
  } catch (err) {
    log.warn("Triage failed, falling through", { error: String(err) });
    await adapter?.onProcessingEnd?.(item);
  }
}

// Full agent processing (existing code, with onProcessingStart for non-interactive)
```

## Data Models

### TriageResult
```typescript
{
  response: string;     // Human-facing text (either final answer or ack)
  action: "done" | "continue";  // Whether full agent is needed
  costUsd: number;      // Haiku cost (~$0.001)
  durationMs: number;   // Triage latency (~1s)
}
```

### Triage System Prompt JSON Contract
```json
{
  "response": "string — the message to post",
  "action": "done | continue"
}
```

## Testing

1. **Unit**: triage() with mock query — verify JSON parse, fallback, timeout
2. **Integration**: Send "good morning" via Slack → verify single Haiku response
3. **Integration**: Send "check the CI" → verify ack + full response (two messages)
4. **Integration**: Trigger scheduled job → verify triage bypassed
5. **Kill switch**: Set TRIAGE_ENABLED=false → verify single-turn behavior
6. **Thread**: Reply in existing thread → verify "continue" default
