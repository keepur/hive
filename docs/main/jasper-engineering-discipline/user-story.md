# User Story: Engineering Workflow Discipline for Jasper

## Story

**As** the CEO,
**I want** Jasper to follow a consistent workflow when handling Linear issues — picking them up, tracking progress, and closing them out completely,
**So that** I don't have to manually clean up half-finished tickets and submit branches myself.

## Acceptance Criteria

- [ ] When Jasper picks up a Linear issue, he moves it to In Progress, assigns himself, and comments his approach
- [ ] When delegating to subagents, Jasper tracks the delegation in Linear and verifies output before closing
- [ ] Jasper does not call an issue "done" until: code is committed, build passes, branch is submitted, and Linear is updated
- [ ] When working on multi-issue epics, Jasper closes each child issue individually — even if implementation was consolidated
- [ ] Blocked issues are moved to Blocked with a comment explaining why (not silently abandoned)

## Out of Scope

- Automated enforcement (Layer 2/3 — work ledger and monitoring come later)
- Changes to other agents' workflows
- Linear state machine configuration
