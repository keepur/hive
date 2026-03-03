# Implementation Roadmap: Product Cleanup

## Design Summary

Hive has a solid template engine and setup wizard. The main gaps are:
1. Agent names hardcoded in templates (not parameterized)
2. `soul.md` and `agent.yaml` not rendered as templates (bug — they contain `{{variables}}` but lack `.tpl` extension)
3. Constitution is a static file with business-specific content
4. Setup wizard doesn't ask for agent names or make all agents optional

## Implementation Phases

### Phase 1: Foundation (must complete first)
- Extract template renderer to shared module (`setup/template-renderer.ts`)
- Enhance regex to support hyphens in template keys
- Add conditional team blocks (`{{#team.agent-id}}...{{/team.agent-id}}`)

### Phase 2: Template Cleanup (parallelizable after Phase 1)
- **Stream A**: Rename and edit soul.md → soul.md.tpl (6 files)
- **Stream B**: Rename and edit agent.yaml → agent.yaml.tpl (6 files)
- **Stream C**: Edit system-prompt.md.tpl files (6 files)
- **Stream D**: Create constitution template

### Phase 3: Integration (depends on Phase 1 + 2)
- Update `generate-agents.ts` to use shared renderer with per-agent context
- Update setup wizard (agent naming, all-optional, constitution generation)
- Add `agents:` section to existing `hive.yaml`
- Source code comment/default cleanup

## Dependencies
- Phase 2 streams A-D are independent of each other
- Phase 2 all depend on Phase 1 (template renderer must exist)
- Phase 3 depends on Phase 1 and Phase 2 (templates must be cleaned before generator can use them)

## Risks
- Template rendering errors in 18 files — mitigated by verification step (`npm run setup:agents`)
- Breaking existing Dodi installation — mitigated by adding `agents:` section to hive.yaml and backward-compatible fallbacks in template engine
