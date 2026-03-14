# Implementation Specs: Jasper Engineering Discipline

## Files to Modify

| File | Change |
|------|--------|
| `agents-templates/vp-engineering/system-prompt.md.tpl` | Add "Engineering Workflow" section after "Guidelines" (line 74) |

## Detailed Changes

### `agents-templates/vp-engineering/system-prompt.md.tpl`

Insert new section between `## Guidelines` (ends line 74) and `## Your Tools` (line 76).

The section contains three subsections:

1. **Picking Up Work** — 3-step process for starting a Linear issue (move to In Progress, assign self, comment approach)
2. **Delegating to Subagents** — rules establishing Jasper still owns the issue after delegation, must verify and close
3. **Definition of Done** — 5-item checklist that must ALL be true before an issue is considered complete
4. **Epic Discipline** — rules for multi-issue epics (update each issue individually, verify all children before closing epic)

Uses template variables: `{{team.devops}}` for the devops agent reference.

## Post-Change Steps

1. `npm run setup:agents` — regenerate `agents/vp-engineering/system-prompt.md`
2. `npm run build` — recompile
3. `launchctl kickstart -k gui/$(id -u)/com.hive.agent` — restart Hive
4. Commit template file and push

## Testing

- Verify `agents/vp-engineering/system-prompt.md` contains the new section with resolved template variables
- Behavioral: next time Jasper picks up a Linear issue, observe whether he follows the workflow
