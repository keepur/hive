# Fresh-install publish smoke test

Manually executed before pushing a `v*` tag that triggers the npm publish workflow. Confirms the published artifact + bootstrap script + onboarding flow actually work end-to-end on a machine with no prior hive state.

**MUST run before any minor or major version tag push** (`v0.1.0`, `v0.2.0`, `v1.0.0`, ...). Patch releases (`v0.1.1`) MAY skip if the change is mechanically obvious and `npm run check` covers it — note the skip rationale in the PR.

## Setup

1. Create a fresh Mac user account (or use a sandbox account with no `~/services/hive/`, no Homebrew, no Node).
2. Have ready: an Anthropic API key, a dev Slack workspace with admin rights for app creation.

## Procedure

For a release candidate (before tag-push), the package under test must already be `npm publish`-able from your dev machine. Two options:

- **Option A (preferred): publish a pre-release tag first.** Bump version to e.g. `0.1.0-rc.1`, push the tag, let CI publish, then run the smoke against `npm i -g @keepur/hive@0.1.0-rc.1`. After smoke passes, bump to `0.1.0` and push the real tag.
- **Option B: install from a local pack.** On the dev box: `npm pack`. Copy the resulting `.tgz` to the fresh user account. Install with `npm i -g ./keepur-hive-0.1.0.tgz`. The bootstrap script does NOT exercise this path — for option B, run install steps manually.

| Step | Action | Expected |
|------|--------|----------|
| 1 | On fresh user account, run: `curl -fsSL https://raw.githubusercontent.com/keepur/hive-docs/main/install/bootstrap.sh \| bash` (only valid for option A — for option B, install manually then run `hive init`) | Homebrew installs (prompts for Xcode CLI), Node 22 installs, `@keepur/hive` installs, `hive init` launches |
| 2 | Complete `hive init` interactively: enter Anthropic key, follow Slack manifest URL, paste tokens, accept defaults for instance config | Wizard exits clean, LaunchAgent loaded |
| 3 | In the configured Slack workspace, send a DM to the Chief of Staff agent | CoS responds within ~10 seconds |
| 4 | Run: `hive plugin add @keepur/hive-plugin-google` | Installs, validates, prints `✓ Restarting hive... done` (or `Start hive to activate the plugin.` if service isn't running) |
| 5 | Run: `hive doctor` | All required checks green |

## Sign-off

Record below before tagging the release.

| Version | Operator | Date | Notes |
|---------|----------|------|-------|
| (e.g. v0.1.0) | (name) | (YYYY-MM-DD) | (e.g. "all steps green; took 18 min") |
