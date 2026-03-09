# Implementation Roadmap

## Design Summary

Extend the existing MongoDB override pattern (model_overrides) to cover all operational agent config fields. New `agent_config_overrides` collection stores per-agent, per-field overrides that merge on top of YAML template defaults during registry load.

### Key Decisions

- **Separate collection** (`agent_config_overrides`) rather than extending `model_overrides` — cleaner separation, zero regression risk
- **Per-field granularity** — only overridden fields are stored, not whole configs
- **Array merge semantics** — `add`/`remove` ops (template changes flow through) or `replace` (full takeover)
- **Hot-reload via SIGUSR1** — same as model overrides, no new mechanism needed

## Implementation Phases

### Phase 1: Types + Registry (no user-facing change)
- Add `ConfigOverride` and `ArrayOverride` types
- Add `loadConfigOverrides()` and `applyConfigOverrides()` to AgentRegistry
- Store template defaults for comparison
- All existing behavior unchanged — overrides collection is empty

### Phase 2: Admin Tools
- Add `config_list`, `config_get`, `config_set`, `config_reset` tools to admin MCP server
- Add `config_add`/`config_remove` convenience tools for array fields

### Phase 3: Mokie System Prompt Update
- Document new tools in Mokie's system prompt template
- Update guidance: use admin tools for operational config, not file edits

## Dependencies

- MongoDB (already in use)
- Admin MCP server (already exists)
- SIGUSR1 hot-reload (already wired)

## Risks

- **Array replace vs template drift**: If Mokie uses `replace` on channels, new template channels won't appear. Mitigated by recommending `add`/`remove` and showing template vs effective in `config_get`.
- **isDefault conflict**: Two agents with isDefault=true. Mitigated by warning in `config_set`.
