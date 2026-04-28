# Per-Agent Private Skills — Design (KPR-75)

**Status:** Implemented 2026-04-28
**Builds on:** `2026-03-14-agent-skills-access-design.md`, `2026-04-15-skills-customer-space-design.md`

## Problem

Skills load from three sources today (customer, seeds, plugins) and are scoped to agents via `agents:` frontmatter. To make a Luna-only skill, an operator authors `<instance>/skills/luna-blog-flow/...` with `agents: [luna]` in frontmatter. Two issues:

1. **Filesystem disagrees with intent.** The skill lives in shared customer-space; only the frontmatter says "Luna-only." Discoverability is wrong.
2. **Operator-authored, not agent-authored.** Agents can't self-author skills at runtime in their own home.

## Solution

A 4th skill source: `<hiveHome>/agents/<id>/skills/`. Skills there are agent-private, agent-authored, agent-scoped implicitly by path. Frontmatter `agents:` is forbidden (hard error) — path is the source of truth.

## Sync semantics

- **Per-agent collisions are not collisions.** Luna and Sam each having `publish-blog-post` is fine — they're scoped per-agent in the index.
- **Customer-space still wins** for the agents it scopes to. Operator authority preserved via explicit eviction of the agent-private entry.
- **No commit, no push, no sync.** Agent-private skills are local-filesystem-only and ephemeral by design. If an agent's skill becomes valuable enough to share, the operator promotes it through the appropriate channel.

## Pass ordering (load-bearing invariant)

Seeds → plugins → agent-private → customer. Reordering breaks the customer-shadow-evicts-agent-private logic in `scanWorkflowsFrom`. This invariant is documented in the loader header comment.

## Collision keying

- Customer / seeds / plugins use the global key: `workflow`
- Agent-private uses per-agent: `<agentId>::<workflow>`
- Customer-shadow eviction: when customer scans (no implicit scope), after the per-skill agent set is known, evict any per-agent-keyed entries for those agents.

## What this is NOT

- Not a sharing flow. No agent → other-agent or agent → operator-repo path. Out of scope per ticket.
- Not auto-tracked. No `commitToState` for agent-private skill writes — keeps the workflow ceremony-free and avoids any auto-push concern (per `feedback_deploy_skill_autocommit.md`).
- Not a config-edit channel. Constitution 1.16 forbids agents from editing their own prompts/soul/config; skills are workflow recipes only.
- Not a paid-tier backup substrate (yet). KPR-117 captures the future paid backup-as-a-service line item; this PR ships only the local substrate.

## File map

- `src/paths.ts` — `agentSkillsDir(agentId, home?)` helper
- `src/agents/skill-loader.ts` — 4th source scan, `implicitAgentScope` parameter, per-agent collision scoping, customer-shadow eviction
- `src/agents/agent-manager.ts` — pass `this.registry.listIds()` into `loadSkillIndex` on boot + reload
- `src/index.ts` — file watcher extended to `agentsDir()` (filtered to SKILL.md, with null-filename fallback)
- `setup/templates/constitution-bootstrap.md.tpl` — §1.25 affordance copy

## Freemium alignment

- **Free tier:** agents author and use their own skills, fully local, fully transparent. Operator can `tar -czf` the `agents/` directory anytime to back it up themselves.
- **Paid tier (future, KPR-117):** Keepur runs a continuous backup service for agent-authored content (private skills, memory, soul evolutions) with restore-on-demand. Customer cancels → keeps last backup. Value flows from the ongoing service, not from access control.
