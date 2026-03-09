# Runtime Agent Config Overrides

## User Story

**As** Mokie (chief-of-staff agent),
**I want** to change agent operational config (channels, passive channels, keywords, budgets, etc.) at runtime via admin tools,
**So that** my changes survive deploys without requiring template edits, rebuilds, or redeployments.

## Background

Currently, agent config lives in YAML templates (`agents-templates/`). When Mokie edits runtime config (e.g., removing River from #marketing), the next deploy regenerates agents from templates and overwrites his changes. The model_overrides pattern already solves this for model assignments — this extends it to all operational config fields.

## Acceptance Criteria

1. Mokie can add/remove channels and passive channels for any agent via admin tools
2. Mokie can modify keywords, budgets, maxTurns, maxConcurrent, timeoutMs, servers, and isDefault
3. Array fields (channels, passiveChannels, keywords, servers) support add/remove operations, not just full replacement
4. Overrides persist in MongoDB and survive deploys
5. Changes take effect via SIGUSR1 hot-reload (no restart needed)
6. Mokie can see what's overridden vs template defaults
7. Mokie can reset any override to revert to template defaults
8. Templates remain the defaults — overrides layer on top

## Out of Scope

- Soul and system prompt overrides (content, not config)
- UI for managing overrides
- Migrating existing model_overrides into the new system (they stay separate)
