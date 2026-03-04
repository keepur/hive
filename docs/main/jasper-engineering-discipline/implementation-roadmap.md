# Implementation Roadmap: Jasper Engineering Discipline

## Design Summary

Add an "Engineering Workflow" section to Jasper's system prompt template covering three areas: issue lifecycle, subagent accountability, and definition of done. This is a prompt-only change — no code modifications.

Modeled after patterns already working in other agents:
- Rae (EA) has explicit task tracking format with proactive follow-up triggers
- Colt (DevOps) has structured reporting format and decision trees

## Implementation Phases

### Phase 1 (this change)
- System prompt update with workflow section
- Regenerate agents, rebuild, restart

### Phase 2 (future — Layer 2)
- Shared work ledger agents write to when picking up / completing issues
- Visibility into what's in flight across the team

### Phase 3 (future — Layer 3)
- Monitoring agent that sweeps stale work
- Escalation path for abandoned issues

## Dependencies
- None for Phase 1

## Risks
- Jasper may still not follow the checklist consistently (LLM compliance is probabilistic)
- Mitigation: observe behavior over next few sessions, tighten wording if needed
