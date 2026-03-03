# User Story: Make Hive Generic / Product-Ready

## Story

**As a** new Hive user setting up on their own Mac Mini,
**I want to** clone the repo, run setup, and have a fully personalized agent team,
**So that** I get my own named agents, my own constitution, and no references to someone else's business.

## Acceptance Criteria

- [ ] `npm run setup` asks for agent names (Chief of Staff always included, all others optional)
- [ ] Generated agent files use the configured names — soul, system prompt, agent.yaml all reflect the user's chosen names
- [ ] Cross-agent references use the correct names (e.g., "delegate to [EA name]")
- [ ] If an agent isn't selected, references to it are omitted from other agents' prompts
- [ ] Constitution is generated during setup with the user's business name, owner name, and agent names
- [ ] No "Dodi", "DodiHome", "May", "Mokie", "Jasper", "Rae", "River", "Chloe", or "Colt" hardcoded in templates
- [ ] No `~/dev/dodi_v2` paths in templates
- [ ] Gender-neutral pronouns (they/them) throughout
- [ ] Existing Dodi installation continues working after code changes (backward compatible)
- [ ] `npm run build` compiles clean

## Out of Scope

- Multi-tenant / SaaS hosting
- Agent self-upgrade capabilities
- New agent types
- Renaming `src/dodi/` internal code (optional integration, no user impact)
- Multi-bot Slack generalization (works as-is via config)
