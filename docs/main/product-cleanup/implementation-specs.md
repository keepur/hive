# Implementation Specs: Product Cleanup

## 1. Template Renderer Module

### New file: `setup/template-renderer.ts`

Extract from `setup/generate-agents.ts` and enhance:

```typescript
// Exported functions:
export function render(template: string, ctx: Record<string, any>): string
export function fileHash(content: string): string
```

**render() enhancements:**
- Regex change: `\w+(?:\.\w+)*` → `[\w-]+(?:\.[\w-]+)*` to support hyphenated keys like `team.chief-of-staff`
- New: generic conditional blocks `{{#path.to.key}}...{{/path.to.key}}` — renders block only if value is truthy
- Keep existing: `{{#sms_section}}`, `{{sms_channels}}`, `{{sms_lines_description}}` special handlers
- Keep existing: `{{key.subkey}}` dotted path resolution

### Modified: `setup/generate-agents.ts`

**Template context per agent:**
```typescript
const agentCtx = {
  business: config.business ?? {},
  sms: config.sms ?? { lines: [] },
  quo: config.quo ?? {},
  agent: {
    name: agentConfigs[agentId]?.name ?? agentId,
    id: agentId,
  },
  team,  // Record<string, string> mapping agent IDs to names
};
```

The `team` map is built from `config.agents`:
```typescript
const agentConfigs = config.agents ?? {};
const team: Record<string, string> = {};
for (const [id, def] of Object.entries(agentConfigs)) {
  team[id] = (def as any).name ?? id;
}
```

## 2. File Renames (12 files)

```
agents-templates/chief-of-staff/soul.md       → soul.md.tpl
agents-templates/chief-of-staff/agent.yaml     → agent.yaml.tpl
agents-templates/vp-engineering/soul.md        → soul.md.tpl
agents-templates/vp-engineering/agent.yaml     → agent.yaml.tpl
agents-templates/executive-assistant/soul.md   → soul.md.tpl
agents-templates/executive-assistant/agent.yaml → agent.yaml.tpl
agents-templates/marketing-manager/soul.md     → soul.md.tpl
agents-templates/marketing-manager/agent.yaml  → agent.yaml.tpl
agents-templates/product-manager/soul.md       → soul.md.tpl
agents-templates/product-manager/agent.yaml    → agent.yaml.tpl
agents-templates/devops/soul.md                → soul.md.tpl
agents-templates/devops/agent.yaml             → agent.yaml.tpl
```

## 3. Template Variable Reference

| Variable | Resolves to | Example |
|----------|-------------|---------|
| `{{agent.name}}` | This agent's configured name | "Mokie" |
| `{{agent.id}}` | This agent's ID | "chief-of-staff" |
| `{{team.chief-of-staff}}` | Chief of Staff's name | "Mokie" |
| `{{team.vp-engineering}}` | VP Engineering's name | "Jasper" |
| `{{team.executive-assistant}}` | EA's name | "Rae" |
| `{{team.marketing-manager}}` | Marketing's name | "River" |
| `{{team.product-manager}}` | PM's name | "Chloe" |
| `{{team.devops}}` | DevOps' name | "Colt" |
| `{{#team.agent-id}}...{{/team.agent-id}}` | Conditional: only if agent exists | |
| `{{business.name}}` | Business name | "Dodi" |
| `{{business.owner.name}}` | Owner's name | "May" |
| `{{business.owner.role}}` | Owner's role | "CEO" |

## 4. Agent Template Changes

### agent.yaml.tpl (all 6 — same pattern)
```yaml
# Before:
name: Mokie
# After:
name: "{{agent.name}}"
```

### soul.md.tpl (all 6 — pattern)
```markdown
# Before:
# Soul: Mokie
You are Mokie, Chief of Staff at {{business.name}}.
# After:
# Soul: {{agent.name}}
You are {{agent.name}}, Chief of Staff at {{business.name}}.
```
Plus: `she/her` → `they/them/their` throughout.

### system-prompt.md.tpl — cross-agent reference pattern
```markdown
# Before:
delegate to Rae
# After:
{{#team.executive-assistant}}delegate to {{team.executive-assistant}}{{/team.executive-assistant}}
```

### system-prompt.md.tpl — business-specific removal
- Remove all `~/dev/dodi_v2` and `DodiHome` references
- `com.dodi.hive` → `com.hive.orchestrator`
- Hardcoded Linear team ID → "discover via `linear_list_teams`"

## 5. Constitution Template

### New file: `setup/templates/constitution.md.tpl`

Full templated version of the current constitution. Key replacements:
- Agent names → `{{team.*}}`
- Business owner → `{{business.owner.name}}` / `{{business.owner.role}}`
- Company name → `{{business.name}}`
- Conditional appendix entries per agent

## 6. Setup Wizard Changes

### Agent selection (all optional except CoS)
```
Chief of Staff — always included
VP of Engineering — optional (default: yes)
Executive Assistant — optional (default: yes)
Product Manager — optional (default: no)
Marketing Manager — optional (default: no)
DevOps Engineer — optional (default: no)
```

### Agent naming (new section)
Ask name for each selected agent. Defaults: Mokie, Jasper, Rae, River, Chloe, Colt.

### hive.yaml output (new agents section)
```yaml
agents:
  chief-of-staff:
    name: "<user input>"
  # ... only selected agents
```

### Constitution generation
Render `setup/templates/constitution.md.tpl` → `{memoryPath}/shared/constitution.md` during memory init.

## 7. Source Code Changes

| File | Change |
|------|--------|
| `src/config.ts:101` | `"Dodi <bot@dodihome.com>"` → `""` |
| `src/config.ts:102` | `"sales@dodihome.com"` → `""` |
| `src/index.ts` | Update comments removing agent names |
| `src/resend/resend-mcp-server.ts` | Update comments removing dodihome.com |
| `hive.yaml` | Add `agents:` section with current Dodi names |
