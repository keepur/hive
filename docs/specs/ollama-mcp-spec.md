# Ollama MCP Server — Tool Surface Spec (v1)

**Owner:** Jim (VP Engineering) · **Status:** Implemented, pending review
**Date:** 2026-09-16 · **Reviewer:** Ralphie (post-implementation, per Tony 2026-09-16)

## Provenance

Ralphie's original 2026-08-06 `ollama_query` spec was never landed in `docs/specs/`. Tony set a
10 AM PT 2026-09-16 deadline for it and authorised me to take my own out if it did not appear:
spec the surface myself and proceed, with Ralphie reviewing after rather than gating before. This
document is that spec. It describes the surface **as built** — if Ralphie's review changes it, the
changes land as a follow-up, not a rewrite.

## Background

Seven agents (Bill, Diana, Lily, Nora, Ross, Stefan, Warren) have had `ollama` in `coreServers`
for weeks with no working server behind it. The implementation was a hand-edited minified bundle
at `.hive/pkg/mcp/ollama.min.js`; it was untracked, a routine `deploy.sh` overwrote `.hive/pkg`,
and the capability vanished **with zero log output** — an unknown *core* server name is dropped
silently (the "Delegate server not found" warning only covers *delegate* servers).

v1 restores the capability in-repo, shipping through the normal engine release path.

## Scope

**In scope:** `ollama_query`, `ollama_list_models`.

**Deferred:** `rag_ingest`, `rag_query`, `rag_list_sources`, `rag_delete_source`. These four come
from the legacy 772-line server and constitute a separate product surface with their own storage
story. Bundling them triples the review surface for no v1 benefit. Approved as deferred by Tony.

## Design constraints

| Constraint | Decision |
|---|---|
| Transport | In-process via `createSdkMcpServer`, registered in `IN_PROCESS_PORTED_SERVERS` |
| Endpoint | `OLLAMA_URL`, default `http://localhost:11434` |
| Credentials | None — local daemon. Classified `INFRASTRUCTURE_SERVERS`, no `SERVER_CREDENTIAL_CHECKS` entry |
| DB dependency | None. Unlike `code-search`, it is **not** gated on `this.db` |
| Privacy | Prompts and responses are **never logged**. Metadata only (model, duration, char count) |
| Timeouts | 120s generate / 10s list — owned here because the SDK has no per-tool timeout |

## `ollama_query`

Run a prompt against a local model. Nothing leaves the machine.

| Param | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string (min 1) | yes | The prompt. |
| `model` | string | no | Default `qwen2.5:14b`. |
| `system_prompt` | string | no | Sets context/role. |
| `image` | string | no | Base64 for vision models (e.g. `llama3.2-vision:11b`). A `data:image/...;base64,` prefix is stripped. Ignored by text-only models. |

**Routing:** `/api/chat` when `system_prompt` or `image` is present (only that endpoint carries
system messages and images); `/api/generate` otherwise, as the cheaper path. Identical contract
to the caller either way. `stream: false` in both cases.

**Returns:** the response text, or `(empty response)`.
**Errors:** `isError: true` with the model, the URL, the underlying message, and a pointer to
`ollama_list_models`. A wedged daemon surfaces as a tool error, never a hung agent turn.

## `ollama_list_models`

No parameters. `GET /api/tags`, shaped into a token-cheap summary: `name`, `size_gb`, `family`,
`parameters`, `quantization`. Returns an explicit "no models pulled" message rather than an empty
array, so the agent gets an actionable string instead of silence.

## Anti-recurrence: core-server drift guard

**This is the part that matters most** and it is a deviation from the approved scope doc, which
called for a check in `scripts/mcp-preflight.mjs`. **That file does not exist** — the scope doc's
premise was wrong. Rather than create a build-time script to satisfy the letter of the plan, the
guard is implemented where the failure actually occurs, at runtime:

`AgentRunner.buildToolTransportInventory()` now diffs configured `coreServers` against what
actually resolved, and logs at **error** level:

> `Core servers configured but not available — agent will silently lack these tools`

with the offending server names. Correctly quiet for in-process servers (no stdio entry by
design) and engine-auto-injected servers. Logs **once per runner**, not per turn, so a hot-reload
loop cannot spam.

This is strictly stronger than a preflight script: it catches drift in the running engine, on any
host, regardless of how the config got there — including a deploy that erases a bundle after the
build passed. That is the exact scenario that produced this incident.

## Test coverage

16 tests in `src/ollama/ollama-mcp-server.test.ts` (routing, data-URL stripping, model
summarisation, timeouts, error shaping, the never-log-content guarantee) and 5 new tests in
`src/agents/agent-runner.test.ts` (build/skip on config, no-db construction, transport inventory,
instance reuse), plus 4 drift-guard tests. 244 tests pass in the two affected files.

## Rollout order

1. Land and deploy the engine change. The seven already-configured agents regain the capability
   on restart with **no config edit**.
2. **Then** run `scripts/migrate-julie-ollama.ts --instance catalyst --apply` to add `ollama` to
   Julie plus her privacy guardrail.

Order is not cosmetic. Applying Julie's config before the engine ships the server would create an
eighth silently-broken agent — the precise failure this work exists to fix.

## Open items

- `may-dodi` has pull-only access on `keepur/hive`; delivery is a fork PR + patch handoff until
  org write access lands. Tony owns that escalation.
- Ralphie's review may adjust the surface. Changes land as a follow-up.
