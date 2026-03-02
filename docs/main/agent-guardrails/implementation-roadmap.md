# Implementation Roadmap: Per-Agent Guardrails

## Design Summary

Two-layer guardrail system:

1. **Hard guardrails** — `servers` allowlist in agent YAML, filtered in `buildMcpServers()`. Removes MCP servers an agent shouldn't have. Simple, auditable, backward-compatible.

2. **Soft guardrails** — `## Guardrails` section in each agent's system prompt template. Covers bash/filesystem restrictions and escalation rules that can't be enforced at the MCP level.

Bash and filesystem are SDK-native capabilities (not MCP servers) and can't be removed without switching from `permissionMode: "bypassPermissions"` to a custom permission callback. Soft guardrails handle this gap.

## Implementation Phases

### Phase 1: TypeScript Changes (sequential — types first, then consumers)
1. Add `servers?: string[]` to `AgentConfig` interface
2. Parse `servers` from YAML in `AgentRegistry.loadAgent()`
3. Add allowlist filter at end of `AgentRunner.buildMcpServers()`

### Phase 2: Agent YAML Updates (parallel — 4 independent files)
4. Add `servers:` to `chief-of-staff/agent.yaml`
5. Add `servers:` to `executive-assistant/agent.yaml`
6. Add `servers:` to `marketing-manager/agent.yaml`
7. Add `servers:` to `vp-engineering/agent.yaml`

### Phase 3: System Prompt Updates (parallel — 4 independent files)
8. Add `## Guardrails` to `chief-of-staff/system-prompt.md.tpl`
9. Add `## Guardrails` to `executive-assistant/system-prompt.md.tpl`
10. Add `## Guardrails` to `marketing-manager/system-prompt.md.tpl`
11. Add `## Guardrails` + update `## Your Tools` in `vp-engineering/system-prompt.md.tpl`

### Phase 4: Build & Deploy
12. `npm run build` — verify TypeScript compiles
13. Regenerate agents from templates
14. Restart Hive service

## Dependencies

- Phase 1 is sequential: `agent-config.ts` must be done before `agent-registry.ts` and `agent-runner.ts`
- Phases 2 and 3 are independent of each other and can be parallelized
- Phase 4 depends on all prior phases

## Risk Considerations

- **Low risk**: All changes are additive. The `servers` field is optional — agents without it get all servers.
- **Bash/filesystem gap**: Soft guardrails only. Agents could still run `git push` in code repos. Mitigated by constitution + explicit system prompt instructions.
- **Future agents**: Any new agent added without a `servers` field gets full access by default. Must remember to add `servers` when creating new agents.
