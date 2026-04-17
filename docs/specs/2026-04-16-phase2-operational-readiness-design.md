---
issue: hive#157
status: draft
date: 2026-04-16
---

# Phase 2 — Operational Readiness

Populate default registries with real installable content, and complete `hive doctor` as the troubleshooting safety net. Bundled into a single PR to keep momentum; both tracks are independently shippable but related in "day-one install works" terms.

## Context

- Phase 1 (#156, PR #159) shipped plugin architecture, `keepur/hive-skills` registry with 4 skills, dual-path plugin resolution, the `plugin.yaml` env-declaration schema (`env`, `env-map`, `agent-env`), and the `hive plugin add` CLI (`src/cli/plugin.ts`) with post-install validation, rollback, and LaunchAgent restart.
- Long-term credential home is Honeypot (#139, 3+ months out). Until then plugin MCP servers read credentials from `process.env` via the existing passthrough — this is explicitly blessed by #139's scope section. No new credential mechanism is needed for this ticket.
- Existing `src/cli/doctor.ts` has prereq checks only (Node ≥22, brew, Mongo via brew-services, Ollama + models, Qdrant, gh, gog, xcode).

## Scope

### Track 8 — Default plugin registry content

1. Create `keepur/hive-plugins` GitHub repo. Structure parallels `keepur/hive-skills` from #159.
2. Seed with three real plugins, each extracted from in-tree code:
   - **`@keepur/hive-plugin-google`** — wraps `google-mcp-server.ts`. Declares `env: [GOG_ACCOUNT, GOG_CLIENT]`. Requires external `gog` CLI, resolved via shell `$PATH` (already checked globally by doctor — no `GOG_PATH` env needed).
   - **`@keepur/hive-plugin-linear`** — wraps `linear-mcp-server.ts`. Declares `env: [LINEAR_API_KEY]`.
   - **`@keepur/hive-plugin-github`** — wraps `github-issues-mcp-server.ts`. Declares `env: [GH_TOKEN]`.

   Linear and GitHub ship as separate plugins (not a compound `project-management` plugin) because their credentials are independent — some installs have one, not the other. Keeps env presence/absence unambiguous.
3. Each plugin repo gets a minimal README with env-var setup instructions.

**Registry curation note (DOD-212):** `keepur/hive-plugins` is a write-gated repo — only dodi-hq maintainers push. Third-party plugins use their own registries or raw-URL dev-mode install, never land in the default registry. This posture is inherited from `keepur/hive-skills` and should be stated in the repo README.

### Track 11 — `hive doctor` completion

Extend existing `src/cli/doctor.ts` with three new check groups. Preserve existing prereq block and its output style.

**Check interface extension:**

```ts
interface Check {
  name: string;
  group: "prereq" | "config" | "agents" | "services";
  required: boolean;
  test: () => boolean | Promise<boolean>;
  remedy?: string; // shown when check fails and --verbose is set
}
```

Output groups under section headers; non-zero exit if any required check fails (existing behavior).

**Config group:**
- `hive.yaml` exists, parses, loads via `src/config.ts`'s existing loader (schema validation already handled there)
- `.env` has all keys marked `required()` in `src/config.ts`. **Derive the list programmatically from `config.ts` — do not hardcode.** This avoids the reviewer-flagged mismatch where `ANTHROPIC_API_KEY`, `MONGODB_URI`, and `BG_TASK_AUTH_TOKEN` are optional-with-fallback and would false-positive as missing.

**Agents group:**
- MongoDB connection succeeds (authoritative check — supersedes prereq-group's `brew services list` check for mongo, which only reports brew state, not actual reachability). Keep brew check in the prereq group as informational, but treat the live-connection check in the agents group as the gate.
- At least one agent exists in `agent_definitions`
- Default agent exists — use `config.defaultAgent` (loaded from `hive.yaml` / `DEFAULT_AGENT` env), not hardcoded `chief-of-staff`

**Services group:**
- LaunchAgent `com.hive.agent` loaded and running — invoke `launchctl print gui/<uid>/com.hive.agent` for structured output (`state = running` and `pid = N`), not `launchctl list` column parsing. **Implementation note:** resolve `<uid>` via `process.getuid()` in TypeScript and pass the fully-formed domain string as an argv element to `execFileSync("launchctl", ["print", `gui/${uid}/com.hive.agent`])` — no shell `$(id -u)` expansion, per CLAUDE.md security rule.
- Process alive — verify the parsed PID via `kill -0`
- Slack Web API `auth.test` passes (validates `SLACK_BOT_TOKEN` — Slack is infrastructure, not agent state)

**Known limitation — document in doctor output header:** the LaunchAgent points at `~/services/hive` (deploy clone), not the dev clone. Running `hive doctor` from `~/github/hive` reports on the deployed service. This is intentional but surprising; doctor should print the resolved service path so users aren't confused.

**Flags:**
- `--verbose` — show `remedy` hints on failed checks
- Existing non-zero-exit-on-required-failure behavior preserved

## Test strategy

`doctor.ts` is all side effects (launchctl, brew, mongo, HTTP, Slack). Approach:
- Extract each check's `test` function so it can be unit-tested with mocked subprocess/HTTP responses
- Cover each failure mode per check: config-load success and failure, each required env var missing individually, Mongo reachable vs not, default-agent-exists vs not, `launchctl print` states (running / not running / not loaded), Slack `auth.test` success vs auth failure
- Do **not** attempt live-integration coverage (no real Slack/Mongo in CI) — rely on mocks
- **Fresh-box runbook:** on a newly-provisioned Mac user (or sandbox account with empty `.env`, no Mongo, no agents), run `hive doctor` and confirm every required check fails with the expected remedy hint. Document this runbook in `docs/runbooks/fresh-install-doctor-smoke.md` — executed manually before merge.
- Smoke-test manually on dev instance and deploy instance before merging

## Out of scope

- Auto-remediation (`hive doctor --fix`) — defer
- Non-Mac platform support
- Plugin-level prereq declarations (e.g., "google plugin needs `gog`") — global doctor check is good enough for now; per-plugin prereq schema is a future `plugin.yaml` extension
- `hive plugin add` UX for prompting/setting env vars — polish, not blocker (user edits `.env` today)
- Seeding additional skills beyond the 4 already in `keepur/hive-skills` — defer unless a gap surfaces during manual smoke

## Done when

- `keepur/hive-plugins` exists with three installable plugins (google, linear, github); `hive plugin add @keepur/hive-plugin-google` on a fresh instance works end-to-end
- `hive doctor` on a healthy box prints all green; fresh-box runbook (see test strategy) confirms each required-check failure path produces the expected output and remedy
- Unit tests cover each new check's failure modes with mocked side effects
- `npm run check` passes
- Manual smoke on dev + deploy instances

## Open questions flagged during spec review (resolved)

- **Plugin credential plumbing pre-honeypot?** Resolved — `plugin.yaml` `env:` declarations + existing agent-runner passthrough handle this. Honeypot replaces the mechanism later without changing the plugin contract.
- **Bundling risk?** Accepted — Track 8 is repackaging, not new architecture, given #159's plumbing is already in place.
- **`GOG_PATH` in env declaration?** Dropped — `gog` resolves via shell `$PATH` like any other binary; no need to plumb a path env var.
- **Compound `project-management` plugin?** Rejected — split into `hive-plugin-linear` and `hive-plugin-github` to avoid ambiguous partial-config states.
- **Slack check placement?** Moved to Services group — Slack is infrastructure, not agent state.
- **`launchctl list` parse contract?** Replaced with `launchctl print gui/$(uid)/com.hive.agent` for structured state/pid output.
- **Fresh-box DoD testability?** Addressed via dedicated fresh-install runbook executed pre-merge.
