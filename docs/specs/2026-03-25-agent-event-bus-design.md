# Agent Event Bus — Design Spec

**Date**: 2026-03-25
**Status**: Draft
**Scope**: Pub/sub event system for cross-agent coordination

## Problem

Agents can only communicate by posting Slack messages routed through the dispatcher. This is noisy (visible to humans), slow (full dispatch pipeline), and tightly coupled (sender must know the recipient). There's no way for an agent to say "something happened" and have interested agents react without the sender knowing who cares.

Examples:
- Milo sees a deal won → Jessica needs to start customer handoff, Sige needs to prep for incoming job
- Jessica resolves a case → Milo should deprioritize the associated deal
- Sige marks a job complete → Jessica should notify the customer
- River finds a hot lead on Reddit → Milo should add it to his outreach queue

Today each of these requires the sender to know exactly who to tell, via Slack, in public channels.

## Design

### Core Concepts

**Event**: A typed, structured message emitted by an agent when something noteworthy happens. Has a `type`, a `payload`, and a `source` (who emitted it).

**Subscription**: An agent declares which event types it cares about in its `agent.yaml`. When a matching event is emitted, the agent receives it as a WorkItem.

**Event Bus**: MongoDB-backed. Agents emit events via an MCP tool. The scheduler polls for undelivered events and dispatches them to subscribers.

### Event Types — Domain-Scoped

Events use a `domain:action` naming convention. Subscribers subscribe to **domains**, not individual actions. This means new actions within an existing domain are automatically delivered to all domain subscribers — zero config changes needed.

**Domains** (the stable contract):

| Domain | What it covers | Primary publishers | Subscribers |
|--------|---------------|-------------------|-------------|
| `deals` | Sales pipeline state changes | Milo, Jessica | Jessica, Sige |
| `cases` | Customer issue lifecycle | Jessica, Sige | Milo |
| `jobs` | Production/manufacturing status | Sige | Jessica |
| `leads` | New prospect discovery | River, Milo | Milo |
| `system` | Infrastructure/operational events | Any agent | Mokie |

**Starting actions per domain**:

| Event | Payload |
|-------|---------|
| `deals:won` | `{ dealId, dealName, customerName, amount? }` |
| `deals:lost` | `{ dealId, dealName, customerName, reason? }` |
| `deals:stage_changed` | `{ dealId, dealName, fromStage, toStage }` |
| `cases:opened` | `{ caseId, customerName, summary }` |
| `cases:resolved` | `{ caseId, customerName, resolution }` |
| `cases:escalated` | `{ caseId, customerName, summary, escalatedTo }` |
| `jobs:complete` | `{ jobId, customerName }` |
| `jobs:schedule_changed` | `{ jobId, customerName, milestone, oldDate?, newDate }` |
| `jobs:blocked` | `{ jobId, customerName, reason }` |
| `leads:found` | `{ source, name, context, url? }` |
| `leads:qualified` | `{ name, context, score? }` |
| `system:task_blocked` | `{ taskId, description, blockedBy }` |
| `system:custom` | `{ message }` |

**Key principle**: adding new actions (e.g., `deals:reopened`, `jobs:delayed`) requires only adding the Zod schema in code. No subscriber config changes — anyone subscribed to `deals` or `jobs` automatically receives the new action.

New **domains** require subscriber config changes (adding the domain to `subscribe` arrays). This is intentional — domains are structural decisions about what an agent cares about.

### MCP Tool: `emit_event`

Registered in a new `event-bus-mcp-server.ts`. Available to any agent with `event-bus` in their servers list (registered unconditionally in agent-runner, filtered by the `servers` allowlist like all other MCP servers).

**Parameters**:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Event type in `domain:action` format (e.g., `deals:won`, `cases:resolved`) |
| `payload` | object | Yes | Typed payload matching the event's Zod schema |

**Behavior**:
- Validates `domain:action` format — must have exactly one colon
- Validates event type exists in `EVENT_SCHEMAS`
- Validates payload against the Zod schema for that event type
- Extracts domain from type (e.g., `deals` from `deals:won`)
- Looks up subscribers from `EVENT_SUBSCRIBERS` env var by domain (excludes self)
- Writes event to `agent_events` MongoDB collection with per-subscriber delivery records
- Returns confirmation with event ID and subscriber count

**Response format**:
```
Event emitted: deals:won [evt_67abc...] → 2 subscribers (customer-success, production-support)
```

If no subscribers exist for the domain:
```
Event emitted: deals:won [evt_67abc...] → 0 subscribers (no agents subscribe to "deals" events)
```

### Subscriptions in agent.yaml

Agents subscribe to **domains**, not individual actions. An agent subscribed to `deals` receives all `deals:*` events.

```yaml
# Jessica — customer success
subscribe:
  - deals      # deal won/lost/stage changes → customer handoff, context updates
  - jobs       # job complete/schedule changes → notify customer

# Sige — production support
subscribe:
  - deals      # deal won → incoming job awareness
  - cases      # case opened/resolved → production-side awareness

# Milo — SDR
subscribe:
  - cases      # case resolved → deprioritize associated deal
  - leads      # lead found → add to outreach queue

# Mokie — chief of staff
subscribe:
  - system     # task blocked, custom alerts
```

Fine-grained subscription (e.g., `deals:won` only) is supported for future use. Matching logic uses **exact equality** at two levels:
- Domain subscription: `deals` → matches all events where `eventDomain(type) === "deals"` (i.e., all `deals:*` events)
- Action subscription: `deals:won` → matches only events where `type === "deals:won"`

This is not prefix matching — it's discrete string comparison. `deal` would not match `deals:won`. The default and recommended pattern is domain-level subscription.

Loaded by `AgentRegistry` alongside existing config fields. Added to `AgentConfig` type as `subscribe?: string[]`. Must be added to `loadAgent()` in agent-registry.ts: `subscribe: (raw.subscribe as string[]) || []`.

Also add `"subscribe"` to the `arrayFields` list in `applyConfigOverrides` so subscriptions can be dynamically overridden via `agent_config_overrides` MongoDB collection (consistent with channels, servers, keywords, etc.).

### Subscriber Resolution

At emit time, the MCP server needs to know who subscribes to each domain.

The agent-runner builds an `EVENT_SUBSCRIBERS` JSON env var from the registry at session creation time and passes it to the event-bus MCP server. Format is **domain → agent list**:

```json
{"deals":["customer-success","production-support"],"cases":["sdr"],"jobs":["customer-success"],"leads":["sdr"],"system":["chief-of-staff"]}
```

The MCP server extracts the domain from the event type (everything before the colon) and looks up subscribers from this map. Self-exclusion is applied at this step.

This is the same value for all agents (it's a global subscriber map, not per-agent). Agent-runner computes it once via a `registry.getSubscriberMap()` helper and passes it identically to all sessions.

**Staleness note**: `EVENT_SUBSCRIBERS` is frozen at session creation time. If subscriptions change via hot-reload during a long-running session, the MCP server in that session still has the old map. New sessions pick up the updated map. This is acceptable for V1 — subscription changes are infrequent and sessions are short-lived.

### Event Delivery

The scheduler polls `agent_events` on the same 30-second cycle as callbacks.

**Flow**:
1. Agent calls `emit_event({ type: "deals:won", payload: { dealId: "D-123", ... } })`
2. MCP server extracts domain `deals`, looks up subscribers, writes to `agent_events`:
   ```
   {
     _id: ObjectId,
     type: "deals:won",
     domain: "deals",
     payload: { dealId: "D-123", dealName: "Jones Kitchen", customerName: "Jones" },
     sourceAgentId: "sdr",
     createdAt: Date,
     deliveries: [
       { agentId: "customer-success", status: "pending" },
       { agentId: "production-support", status: "pending" }
     ]
   }
   ```
3. Scheduler finds events with any `deliveries.status === "pending"`
4. For each pending delivery, atomically marks it as fired:
   ```javascript
   updateOne(
     { _id: eventId, "deliveries": { $elemMatch: { agentId, status: "pending" } } },
     { $set: { "deliveries.$.status": "fired", "deliveries.$.firedAt": now } }
   )
   ```
   If `modifiedCount === 0`, another scheduler instance already picked it up — skip.
   After firing the last pending delivery for an event, also set `hasPending: false` on the parent document.
5. Creates a WorkItem and dispatches via `onDispatch`:
   ```
   {
     id: "event:{eventId}:{agentId}",
     text: "[Event: deals:won from Milo]\n\n{\"dealId\":\"D-123\",\"dealName\":\"Jones Kitchen\",\"customerName\":\"Jones\"}",
     source: { kind: "internal", id: "agent-jessica", label: "agent-jessica" },
     sender: "system",
     threadId: "event:{eventId}:{agentId}:{timestamp}",
     timestamp: now,
     meta: { targetAgentId: "customer-success", eventType: "deals:won", eventDomain: "deals", eventId: "{eventId}" }
   }
   ```
6. Dispatched via `onDispatch` — goes through full dispatcher pipeline

**Event delivery is fire-and-forget**: the subscribing agent processes the event and may take action using its own tools (send Slack messages, update memory, create tasks, emit further events, etc.), but the event delivery itself has no response channel. The `source.kind: "internal"` means no adapter is registered under that kind — `dispatcher.ts:153` resolves to `undefined`, so the agent's text response is silently discarded. This is intentional — events trigger agent behavior, they don't create conversations. Agents that need to take visible action (post to Slack, send email, update CRM) must use their own MCP tools within the session.

### Self-Delivery Prevention

An agent does not receive its own events. The MCP server excludes the `sourceAgentId` from the subscriber list when creating delivery records.

### Disabled Agent Handling

Same pattern as callbacks (scheduler.ts:262-269): the scheduler marks the delivery as `"fired"` atomically, then checks if the agent is disabled. If disabled, the scheduler logs a skip and does not dispatch. The delivery stays marked `"fired"` — there is no `"skipped"` status. This keeps the data model simple and avoids a second MongoDB update.

### MongoDB Schema

**Collection**: `agent_events`

```typescript
interface AgentEvent {
  _id?: ObjectId;
  type: string;              // "domain:action" format (e.g., "deals:won")
  domain: string;            // extracted domain (e.g., "deals") — denormalized for indexing
  payload: Record<string, unknown>;
  sourceAgentId: string;
  createdAt: Date;
  hasPending: boolean;       // denormalized flag — true while any delivery is "pending"
  deliveries: EventDelivery[];
}

interface EventDelivery {
  agentId: string;
  status: "pending" | "fired";
  firedAt?: Date;
}
```

**Indexes**:
- `{ hasPending: 1, createdAt: 1 }` — for scheduler polling (avoids multikey array scan)
- `{ sourceAgentId: 1, createdAt: -1 }` — for event history queries
- `{ domain: 1, createdAt: -1 }` — for domain-based queries
- TTL index on `createdAt` — auto-delete events after 30 days

The `hasPending` flag is set to `true` on insert. When the scheduler fires the last pending delivery for an event, it sets `hasPending: false`. This gives the scheduler a clean, non-multikey index to poll on: `find({ hasPending: true })`.

### Event Types Definition

New file: `src/events/event-types.ts`

Uses Zod for payload validation, consistent with all other MCP servers in the codebase. Organized by domain — each domain groups its actions.

```typescript
import { z } from "zod";

interface EventSchema {
  description: string;
  payload: z.ZodObject<z.ZodRawShape>;
}

// ── Domains ─────────────────────────────────────────────────────────────

export const EVENT_DOMAINS = ["deals", "cases", "jobs", "leads", "system"] as const;
export type EventDomain = (typeof EVENT_DOMAINS)[number];

// ── Schemas (domain:action → schema) ────────────────────────────────────

export const EVENT_SCHEMAS: Record<string, EventSchema> = {
  // ── deals ──
  "deals:won": {
    description: "A deal was marked as won",
    payload: z.object({
      dealId: z.string(),
      dealName: z.string(),
      customerName: z.string(),
      amount: z.number().optional(),
    }),
  },
  "deals:lost": {
    description: "A deal was marked as lost",
    payload: z.object({
      dealId: z.string(),
      dealName: z.string(),
      customerName: z.string(),
      reason: z.string().optional(),
    }),
  },
  "deals:stage_changed": {
    description: "A deal moved to a new pipeline stage",
    payload: z.object({
      dealId: z.string(),
      dealName: z.string(),
      fromStage: z.string(),
      toStage: z.string(),
    }),
  },

  // ── cases ──
  "cases:opened": {
    description: "A customer case was opened",
    payload: z.object({
      caseId: z.string(),
      customerName: z.string(),
      summary: z.string(),
    }),
  },
  "cases:resolved": {
    description: "A customer case was resolved",
    payload: z.object({
      caseId: z.string(),
      customerName: z.string(),
      resolution: z.string(),
    }),
  },
  "cases:escalated": {
    description: "A customer case was escalated",
    payload: z.object({
      caseId: z.string(),
      customerName: z.string(),
      summary: z.string(),
      escalatedTo: z.string(),
    }),
  },

  // ── jobs ──
  "jobs:complete": {
    description: "A production job was completed",
    payload: z.object({
      jobId: z.string(),
      customerName: z.string(),
    }),
  },
  "jobs:schedule_changed": {
    description: "A job milestone date changed",
    payload: z.object({
      jobId: z.string(),
      customerName: z.string(),
      milestone: z.string(),
      oldDate: z.string().optional(),
      newDate: z.string(),
    }),
  },
  "jobs:blocked": {
    description: "A production job is blocked",
    payload: z.object({
      jobId: z.string(),
      customerName: z.string(),
      reason: z.string(),
    }),
  },

  // ── leads ──
  "leads:found": {
    description: "A new lead was identified",
    payload: z.object({
      source: z.string(),
      name: z.string(),
      context: z.string(),
      url: z.string().optional(),
    }),
  },
  "leads:qualified": {
    description: "A lead was qualified for outreach",
    payload: z.object({
      name: z.string(),
      context: z.string(),
      score: z.number().optional(),
    }),
  },

  // ── system ──
  "system:task_blocked": {
    description: "A task is blocked and needs attention",
    payload: z.object({
      taskId: z.string(),
      description: z.string(),
      blockedBy: z.string(),
    }),
  },
  "system:custom": {
    description: "Freeform notification — use when no specific event type fits",
    payload: z.object({
      message: z.string(),
    }),
  },
};

export type EventType = keyof typeof EVENT_SCHEMAS;

/** Extract domain from "domain:action" event type */
export function eventDomain(type: string): string {
  return type.split(":")[0];
}
```

Adding a new action to an existing domain (e.g., `deals:reopened`) requires only adding its schema entry here. No subscriber config changes needed.

### Constitution Addition

Add to Section 10 (Common Tools):

> **10.X. Event Bus** (`event-bus` server) — emit and receive structured events for cross-agent coordination. Use `emit_event` when something noteworthy happens that other agents may need to act on (deal won, case resolved, job complete, lead found). Events you subscribe to will arrive as messages — act on them as you would any other message. Do not use events for casual communication — use Slack for that. Events are for structured state changes that trigger workflows.

### Agent Prompt Guidance

Each subscribing agent's system prompt should include guidance on how to handle the event domains they subscribe to. Example for Jessica:

> **Event handling**: You subscribe to `deals` and `jobs` events. When you receive these:
> - `deals:won`: Start customer handoff process — create onboarding case, send welcome email
> - `deals:stage_changed`: Update your context on the customer's sales status
> - `deals:lost`: Close any open pre-sale work for the customer
> - `jobs:complete`: Notify the customer their order is ready
> - `jobs:schedule_changed`: If delivery date moved, proactively update the customer
> - `jobs:blocked`: Flag for customer communication if it impacts their timeline
>
> You may receive new event actions within these domains over time. Use your judgment — the domain tells you what area it's about, the action tells you what happened, the payload has the details.

This is prompt text, not code — agents interpret events using their judgment, guided by their role definition. The "use your judgment" guidance means agents can handle new actions they've never seen before, as long as they understand the domain.

## Files to Create

| File | Purpose |
|------|---------|
| `src/events/event-types.ts` | Event type definitions + Zod payload schemas |
| `src/events/event-bus-mcp-server.ts` | MCP server with `emit_event` tool |

## Files to Modify

| File | Change |
|------|--------|
| `src/types/agent-config.ts` | Add `subscribe?: string[]` to `AgentConfig` |
| `src/agents/agent-registry.ts` | Load `subscribe` from agent.yaml in `loadAgent()`; add `"subscribe"` to `arrayFields` in `applyConfigOverrides`; add `getSubscriberMap(): Record<string, string[]>` method (builds domain→agentIds map from all agents' subscribe arrays — used by agent-runner to build the env var) |
| `src/agents/agent-runner.ts` | Register `event-bus` MCP server (unconditional, filtered by allowlist); call `registry.getSubscriberMap()` and pass as `EVENT_SUBSCRIBERS` JSON env var |
| `src/scheduler/scheduler.ts` | Add `checkEvents()` method to poll `agent_events` for pending deliveries; add `agent_events` collection reference in `connectDb`; add to 30-second timer alongside `checkCallbacks` |
| `src/config.ts` | Add `events` config subsection: `events.retentionDays` (TTL, default 30). Pattern: `hive.events?.retentionDays` with env var fallback `EVENT_RETENTION_DAYS` |
| `setup/templates/constitution.md.tpl` | Add Section 10.X for event bus tool |
| Agent template `agent.yaml` files | Add `subscribe` arrays + `event-bus` to `servers` for relevant agents |
| Agent template `system-prompt.md.tpl` files | Add event handling guidance for subscribers |

## Not In Scope

- **Slack echo on emit** — agents can use their own `slack` MCP server to post to their channel if they want visibility. Avoids wiring a Slack adapter into the scheduler.
- Event replay / redelivery (if delivery fails, log and move on — can be added later)
- Payload-level filtering (e.g., "only deals:won where amount > 50k") — subscribe to the domain, filter in agent logic
- Agent-defined event types at runtime (types are code-defined contracts; domains are structural)
- Event acknowledgment from subscribers (fire-and-forget delivery)
- Event chaining / workflows (agent A's event triggers agent B, whose response triggers agent C — possible but emergent, not orchestrated)
