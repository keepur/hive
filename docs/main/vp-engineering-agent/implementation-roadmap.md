# VP Engineering Agent (Jasper) — Implementation Roadmap

## Design Summary

No code changes required. Jasper follows the established agent pattern — three template files that the existing infrastructure auto-discovers. Same pattern as River (marketing-manager).

## Implementation

### Single Phase: Create Agent Templates

**Goal:** Create `agents-templates/vp-engineering/` with three files, generate active agent, verify hot-reload.

**Work:**
- Create `agent.yaml` — config with channels, keywords, model
- Create `soul.md` — Jasper's personality
- Create `system-prompt.md.tpl` — role, domain, tools, guidelines
- Run `npx tsx setup/generate-agents.ts` to render templates
- Hive hot-reloads automatically

**Verification:** Hive logs show Jasper loaded. Messages in `#dev` route to Jasper.

**Estimated effort:** Small. Three new files, no code changes.

## Dependencies

| Dependency | Status |
|-----------|--------|
| Agent template pattern | Established (3 existing agents) |
| Slack channels (#dev, #product, #bugs) | Manual creation needed |
| Hive infrastructure (registry, dispatcher, runner) | Already supports dynamic agents |

## Risks

None significant. This is a pure content addition — no code changes, no new dependencies.
