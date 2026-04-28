# Operator Skills Repo — Design (KPR-82)

**Status:** Implemented 2026-04-28
**Builds on:** `2026-04-15-skills-customer-space-design.md`

## Problem

Customer-space skills are gitignored and instance-local. When an operator runs hives on multiple machines (one for dev, one for production, one for migration), skills authored on machine A do not propagate to machines B and C. The 2026-04-25 morning-briefing incident — properly designed skills stranded on the wrong machine for 7+ days — is the canonical example.

## Solution

A single git repo, declared in `hive.yaml` as `operatorSkillsRepo`, is the canonical source of one operator's customer-space skills. All of that operator's instances pull from it.

The operator repo has the same shape as a skill registry (flat `skills/<skill-name>/`). What's new is **declarative sync**: every skill in the operator repo *should* be installed in every instance, and every instance reports orphans when the operator removes a skill.

## Sync semantics

- **Install missing** — skill in repo, not in customer space → `installSkill()`
- **Upgrade stale** — skill in both, base-version differs → `upgradeSkill()`
- **Skip up-to-date** — skill in both, base-version matches HEAD → no-op
- **Skip customer-modified** — `origin.modified === true` → never overwrite
- **Report orphans** — skill in customer space (sourced from this repo) but no longer in repo
- **Prune (opt-in)** — `--prune` removes orphans

## Lifecycle

- `hive skill sync` — manual, on-demand. Supports `--dry-run` and `--prune`.
- `hive update` — automatic post-upgrade hook. Non-fatal on sync error (engine upgrade already succeeded).

## What this is NOT

- **Not a registry replacement.** Existing `skillRegistries[]` config still works for one-off `hive skill add @registry/name` installs. The operator repo is for "everything in this repo, kept in sync."
- **Not a marketplace.** No customer-to-customer skill sharing. (See `project_skills_distribution_strategy.md`.)
- **Not push-back.** Authoring on instance A → operator repo is manual today. Future ticket: `hive skill publish` or auto-commit.
- **Not the paid-tier delivery channel.** That's Registry (A), a separate ticket. The operator repo is the substrate; both free DIY and paid bundle delivery (later) write into the same place.

## Freemium alignment

Free customers maintain the operator repo themselves. Paid customers will eventually receive curated bundles into the same `<hiveHome>/skills/` location via Registry (A). One mechanism, two audiences. (See `project_freemium_model.md`.)

## File map

- `src/config.ts` — `operatorSkillsRepo` field (opt-in, null when not configured)
- `src/skills/customer-space-scan.ts` — walk customer space, return installed skills with origin metadata
- `src/skills/sync.ts` — `syncOperatorSkills()` orchestrator
- `src/cli/skill.ts` — `hive skill sync` subcommand
- `src/cli/update.ts` — post-upgrade hook
