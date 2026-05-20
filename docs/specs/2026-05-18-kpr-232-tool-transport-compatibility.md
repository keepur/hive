# KPR-232 Tool Transport Compatibility Design

## Summary

KPR-232 is Phase B1 of the KPR-230 provider adapter epic. KPR-231 introduced the one-turn provider adapter boundary while leaving all Claude Agent SDK runtime wiring inside `AgentRunner`. B1 decides and prototypes how Hive's tool catalog should cross that boundary before OpenAI or Gemini runtime adapters are attempted.

The outcome should be a provider-neutral inventory of Hive tool transports plus an explicit compatibility strategy:

- Claude continues to receive the current Claude Agent SDK `mcpServers`, in-process SDK MCP servers, SDK built-ins, hooks, and delegated sub-agent tools with no behavior change.
- OpenAI and Gemini pilots do not receive the current Claude-shaped `mcpServers` object directly.
- OpenAI and Gemini start from an inventory that says which Hive tools can be bridged through MCP transport, which require Hive turn context, which are Claude-only for now, and which need a future provider-native implementation.

This is a compatibility/prototype phase, not the OpenAI or Gemini adapter implementation.

## Context

`AgentRunner` currently owns both prompt assembly and Claude SDK tool wiring:

- `buildAllServerConfigs(context)` builds a Claude SDK-style server map for stdio and HTTP MCP servers.
- `filterCoreServers(...)` applies the agent's `coreServers`, auto-injected servers, and autonomy gates.
- KPR-122 ported several servers to in-process SDK MCP servers when a shared Mongo `Db` is available.
- `buildServerSubAgents(...)` maps `delegateServers` into Claude SDK `agents`, which is a Claude-native sub-agent surface rather than a general provider abstraction.
- `toolkit-section.ts` describes tools in the prompt, including Claude SDK built-ins and Hive MCP servers.

This shape is correct for Claude, but B2/B3 need a smaller, provider-neutral description of the available Hive tools. The current map uses Claude SDK types and includes in-process server objects that other provider SDKs cannot consume directly.

## Goals

- Add a provider-neutral tool transport inventory model that can describe the tools available for one Hive turn.
- Preserve the existing Claude execution path and all current MCP/server behavior.
- Classify current Hive tool surfaces by provider compatibility:
  - Claude direct support.
  - MCP bridge candidate.
  - Requires Hive turn context.
  - Claude-only/deferred.
  - Unsupported/misconfigured.
- Expose enough inventory from `AgentRunner` for future adapters to plan tool wiring without importing Claude SDK server config details.
- Document the B1 decision: non-Claude adapters should consume Hive's inventory and a small bridge layer, not the Claude `mcpServers` object.
- Add tests that lock the classification and prove the inventory matches the current Claude tool allowlist.

## Non-Goals

- No OpenAI Agents SDK adapter.
- No Gemini ADK adapter.
- No provider selection in agent definitions.
- No production MCP bridge server or HTTP proxy yet.
- No conversion of MCP tool schemas into OpenAI/Gemini native function tools yet.
- No replacement of Claude SDK built-in tools.
- No redesign of `delegateServers`; Claude delegated sub-agents remain Claude-only for now.
- No memory boundary implementation. Phase D remains deferred.
- No behavior change for Slack, SMS, WebSocket, voice, scheduler, callback, event bus, team messaging, code-task, or plugins.

## Design

### Tool Inventory Types

Create `src/agents/provider-adapters/tool-transport.ts` with provider-neutral descriptors:

```typescript
export type HiveToolTransportKind = "stdio" | "http" | "sse" | "sdk-in-process" | "claude-builtin" | "claude-subagent";
export type ProviderToolCompatibility =
  | "direct"
  | "mcp-bridge-candidate"
  | "requires-hive-bridge"
  | "claude-only"
  | "unsupported";

export interface HiveToolTransportDescriptor {
  name: string;
  transport: HiveToolTransportKind;
  source: "engine" | "core" | "plugin" | "delegate" | "sdk-builtin";
  requiresTurnContext: boolean;
  requiresHiveRuntime: boolean;
  inProcess: boolean;
  compatibility: {
    claude: ProviderToolCompatibility;
    openai: ProviderToolCompatibility;
    gemini: ProviderToolCompatibility;
  };
}
```

The exact naming can evolve during implementation, but the module must not export Claude SDK `McpServerConfig` as the public type. Claude-specific server config inspection can be an implementation detail.

`requiresTurnContext` is intentionally narrow: it means the tool needs per-turn channel/thread/source metadata from `WorkItemContext`. `requiresHiveRuntime` is broader: it means a provider-neutral bridge would need local Hive runtime objects such as Mongo `Db`, registry/team-roster state, prefix cache invalidation, callback/event infrastructure, or other in-process closures. In-process SDK MCP servers often require a Hive bridge even when they do not require `WorkItemContext`.

### Shared MCP Server Traits

Move duplicated server traits into a small shared module so future provider adapters do not scrape private `AgentRunner` constants. These traits must stay separate:

- `IN_PROCESS_PORTED_SERVERS` already exists in `src/agents/in-process-servers.ts`.
- Add or expose a sibling shared set for true turn-context-dependent servers:
  - `callback`
  - `background`
  - `code-task`
  - `recall`
  - `structured-memory`
- Keep `memory` out of the turn-context set. Runtime memory is delegate-unsafe and Hive-runtime-backed, but it does not consume per-turn channel/thread metadata.
- Add a separate delegate-unsafe or Hive-runtime bridge trait if useful:
  - delegate-unsafe should include the existing validation set (`callback`, `background`, `code-task`, `recall`, `structured-memory`, `memory`)
  - Hive-runtime-backed should include in-process servers such as `memory`, `schedule`, `team`, `admin`, `code-search`, `workflow`, and `team-roster` when present

`AgentRunner`, `AgentRegistry`, and `admin-mcp-server` should keep their current behavior while sharing trait sources where practical. If fully deduplicating all callers creates unnecessary churn, B1 may export the new traits for future adapters and leave behavior-only callers unchanged, but tests must cover drift risk. Do not derive `requiresTurnContext` from a delegate validation set that includes `memory`.

### Compatibility Rules

The initial compatibility rules are intentionally conservative:

- Claude:
  - stdio/http/sse MCP configs are `direct`.
  - in-process SDK MCP servers are `direct`.
  - Claude SDK built-ins are `direct`.
  - `delegateServers` represented as Claude SDK `agents` are `direct`.
- OpenAI/Gemini:
  - stdio/http/sse MCP servers are `mcp-bridge-candidate`.
  - context-dependent MCP servers are `requires-hive-bridge` with `requiresTurnContext: true`.
  - in-process SDK MCP servers, including `memory`, are `requires-hive-bridge` with `requiresHiveRuntime: true` unless B1 can represent an equivalent process/HTTP bridge without runtime behavior change.
  - Claude SDK built-ins and Claude delegated sub-agents are `claude-only`.
  - plugin servers with missing/broken entries are excluded from available inventory. They may be surfaced separately by diagnostics, but they must not appear as bridge candidates.

This means B2 can pilot a tool-light OpenAI adapter without guessing. It can either run with no Hive tools or choose an explicit bridge candidate. It must not silently inherit Claude-only built-ins, hooks, or sub-agent semantics.

### Inventory Boundary

The B1 inventory is a provider tool transport inventory, not a complete Claude runtime-behavior manifest.

It must include provider-visible tool transports:

- MCP servers exposed through the parent session.
- In-process SDK MCP servers exposed through the parent session.
- `team-roster`, which is injected in-process when a `TeamRoster` is present.
- Claude delegated sub-agents from `delegateServers`.
- Claude SDK built-in tools listed in Hive's toolkit section, because those are explicitly shown to agents as available tools.

It must explicitly exclude non-transport Claude runtime behavior:

- Claude SDK plugins/native skills configuration.
- hooks such as `PreToolUse` and `PreCompact`.
- prompt assembly, settings sources, and SDK `extraArgs`.

Those excluded surfaces remain Claude-only in B1 and must not be assumed portable by KPR-233/KPR-234. If a later provider needs equivalent behavior, it should get its own spec item instead of overloading the tool transport inventory.

### AgentRunner Inventory Surface

Add a public method on `AgentRunner` that builds a descriptor list for the current agent and optional `WorkItemContext`, without changing `send()` behavior.

The method should reuse the same source data as `send()`:

- `buildAllServerConfigs(context)`
- `filterCoreServers(...)`
- the `team-roster` in-process server, which is injected in `send()` when a `TeamRoster` is present even though it is not returned by `buildAllServerConfigs(...)`
- effective auto-injected servers
- `delegateServers` after the same filtering rules used by `buildServerSubAgents(...)`
- Claude SDK built-ins from the toolkit section
- plugin metadata where available
- in-process/context-dependent traits

Suggested shape:

```typescript
buildToolTransportInventory(context?: WorkItemContext): HiveToolTransportDescriptor[]
```

The inventory must be deterministic and safe to call from tests. It should not spawn subprocesses, open databases, call provider SDKs, call Keychain beyond the existing config construction behavior, or mutate runtime state beyond any existing lazy path that `buildServerConfig` already uses.

### Bridge Decision

B1 chooses a small future bridge strategy, but does not implement the bridge:

- A future bridge should sit inside Hive, not inside provider-specific adapters.
- It should expose selected Hive MCP servers to provider SDKs through provider-supported MCP or native function-tool surfaces.
- It must keep Honeypot/Keychain resolution local to Hive.
- It must preserve the per-turn `WorkItemContext` for context-dependent servers.
- It must not expose every server to every provider by default; provider pilots should opt into explicitly classified tools.

### Documentation

Update `docs/architecture.md` to show:

`Provider adapter -> tool transport inventory -> provider-specific tool bridge`

The doc should state that B1 is a compatibility layer only. Claude continues direct SDK MCP wiring. Non-Claude adapters must consume the inventory and bridge plan before attaching tools.

## Acceptance Criteria

- A provider-neutral tool transport descriptor module exists and is covered by unit tests.
- `AgentRunner` can expose a deterministic tool transport inventory for an agent turn.
- Current Claude `send()` behavior and `mcpServers`/`agents` option assembly remain unchanged.
- Existing in-process MCP server behavior remains unchanged.
- Existing delegate server validation remains unchanged.
- The inventory marks Claude SDK built-ins and delegate sub-agents as Claude-only for non-Claude providers.
- The inventory includes representative Claude SDK built-ins as `claude-builtin` descriptors, including at least `Bash` and `Task`, so non-Claude provider tickets do not silently assume those tools are portable.
- The inventory marks stdio/http/sse MCP servers as bridge candidates for OpenAI/Gemini.
- The inventory marks context-dependent and in-process MCP servers as requiring a Hive bridge for OpenAI/Gemini.
- `requiresTurnContext` is true only for tools that require per-turn channel/thread metadata; `requiresHiveRuntime` is true for in-process/Hive-state-backed tools.
- Runtime `memory` must have `requiresTurnContext: false` and `requiresHiveRuntime: true`.
- The inventory includes `team-roster` when a `TeamRoster` is present, matching current `send()` behavior.
- Broken plugin MCP servers are excluded from available inventory and are not advertised as bridge candidates.
- SDK plugins/native skills and hooks are documented as out-of-inventory Claude runtime behavior.
- `docs/architecture.md` documents the compatibility decision and bridge direction.
- No operator-facing config or schema changes are introduced.

## Test Requirements

- Unit tests for compatibility classification in the new tool transport module.
- `AgentRunner` tests for the inventory method:
  - stdio server, HTTP Slack MCP, plugin stdio server, in-process server, context-dependent server, auto-injected server, and delegate server cases.
  - `team-roster` when a `TeamRoster` is present.
  - representative Claude SDK built-ins such as `Bash` and `Task`.
  - at least one golden test comparing captured `send()` `mcpServers`/`agents` names with inventory entries for the same runner.
  - `memory` as Hive-runtime-backed but not turn-context-dependent.
  - autonomy gates still affect inventory consistently with current `send()` behavior.
  - broken plugin servers do not appear in available inventory.
- Existing `AgentRunner` tests remain green because Claude option assembly must not change.
- Existing `AgentRegistry` and `admin-mcp-server` tests remain green because delegate validation must not change.
- Broader regression must run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.

## Dependency Notes

- KPR-233 should use the B1 inventory when piloting OpenAI. If it needs tool access, it should start with one explicitly classified bridge candidate.
- KPR-234 should follow the same inventory strategy for Gemini rather than reinterpreting Claude SDK config.
- Phase C provider selection and Phase D memory/provider-session boundaries remain deferred.
