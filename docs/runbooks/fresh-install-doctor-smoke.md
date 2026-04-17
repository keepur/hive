# Fresh-install `hive doctor` smoke test

Manually executed before merging #157. Confirms each required check in
`hive doctor` produces the expected failure and remedy on a clean box.

## Setup

1. Create a fresh Mac user account (or a sandbox account with empty HOME).
2. Clone hive at `~/github/hive`.
3. **Do not** install prereqs, create `.env`, or start services.
4. `npm install && npm run build`.

## Procedure

Run each step, confirm the listed output appears, then fix before moving on.

| Step | State | Expected failing checks (with `--verbose`) |
|------|-------|-------------------------------------------|
| 1 | Nothing installed | Node ≥22 (if system Node is old), Homebrew, MongoDB, Ollama, Ollama models, Qdrant, Xcode CLI tools |
| 2 | brew + services installed, no `.env` | `hive.yaml loads` ✗, all `env: *` lines ✗ |
| 3 | `.env` populated with required keys, no Mongo yet | `MongoDB reachable` ✗ with its remedy |
| 4 | Mongo running, empty DB | `At least one agent exists` ✗, `default agent exists` ✗ |
| 5 | `npm run setup:seeds` run | Agents group green; `LaunchAgent com.hive.agent running` ✗ |
| 6 | `hive start --daemon` | `LaunchAgent` green; `Slack auth.test` ✗ if SLACK_BOT_TOKEN invalid |
| 7 | Valid Slack token | All green |

For each ✗ row, verify the `--verbose` remedy text matches the remedy
registered in `src/cli/doctor.ts`.

## Sign-off

Record the operator name + date at the bottom of the PR description before merging.
