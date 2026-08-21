# KPR-371 — Live validation record

Run 2026-08-20 against a live SuperGrok subscription on the maintainer's machine, from the built `kpr-371` tree (`grok` CLI 1.0.4, `~/.grok/auth.json` @ 0600). Token secrets are recorded as SHA-256 prefixes only.

**Split.** The matrix divides into a credential layer (runnable from the built tree, no instance deploy) and an agent layer (needs the code on a running hive instance with an agent pinned to `grok/`). Per operator ruling, the credential layer was validated pre-merge and the agent layer is deferred to post-merge rollout.

## Credential layer — PASSED

### V1 — the operator's `grok` CLI is unaffected (R5 acceptance criterion)

`grok models` before hive touched anything: logged in, `grok-4.6` (default) + `grok-4.5`.
`grok models` after hive performed a real refresh and rewrote the file: **identical output, exit 0.** No re-login prompt.

This is the ruling that made write-back mandatory rather than optional, and it holds end to end.

### V2 — hot path costs one file read and zero network

`resolveOAuthFileToken` against a token with ~6h remaining, instrumented with a counting `fetch`:

| Assertion | Result |
|---|---|
| network calls | **0** |
| returned token == on-disk `key` | ✅ |
| `expires_at` untouched | ✅ |
| `refresh_token` untouched | ✅ |

Re-run after V3 against the token hive itself wrote: same result, 0 network calls.

### V3 — refresh, rotation, and atomic write-back

Forced by widening the refresh threshold to 24h against a valid 6h token — the real production code path, a real grant, a real write-back, with no file hand-editing.

| Assertion | Before | After | Result |
|---|---|---|---|
| network calls | — | 2 | ✅ 1 discovery + 1 grant (discovery cached) |
| entry key | `https://auth.x.ai::b1a0…828` | same | ✅ unchanged |
| top-level entries | 1 | 1 | ✅ |
| access token (sha12) | `595e9267b1d0` | `46777e134aff` | ✅ new |
| refresh token (sha12) | `cfb64f9cbf21` | `755ff3b193aa` | ✅ **rotated and persisted** |
| `expires_at` | `2026-08-21T00:19:38Z` | `2026-08-21T00:21:44Z` | ✅ advanced (`expires_in` 21600 = 6h, confirming §3.4) |
| file mode | 0600 | 0600 | ✅ preserved |
| unknown fields | 13 | 13 | ✅ all preserved verbatim |
| total fields | 16 | 16 | ✅ |
| returned token == on-disk `key` | — | — | ✅ |
| refreshed token → `api.x.ai` | — | — | ✅ 200 |

The rotation is the hazard the whole design exists for: the vendor **did** rotate, hive **did** persist it, and the CLI **did** survive.

### Live endpoint probe — §3.2/§3.3 re-confirmed at implementation time

`POST https://api.x.ai/v1/messages` with the resolved token as `Authorization: Bearer` (the Lane A env pin's exact carrier shape):

- status **200**
- `model: grok-4.6`, `stop_reason: end_turn`
- content blocks: `thinking, text` — extended thinking works on the compat path
- usage: `input_tokens: 215`, `cache_read_input_tokens: 128` — **prompt caching is active**

### V7 — cost attribution (the spec's flagged unknown)

Unresolved by design; it changes no code. Subscription-token traffic on `api.x.ai` succeeded on an account with no API credits purchased, which implies the subscription pool rather than an API-credit balance — but xAI documents neither, so this stays an inference. Recorded in `docs/providers.md` under **Revisit triggers**: if a credit balance ever starts moving, row 15's Grok cell is revisited as new work.

## Agent layer — DEFERRED to post-merge rollout

Operator ruling: validate on `hive update` at keepur/dodi, as every prior provider child was. Row 17 of the parity matrix is scoped accordingly and must be updated when these land.

- **V4** — full runtime parity on an agent pinned to `grok/grok-4.6`: MCP tool call, skill load, memory recall, delegate subagent.
- **V5** — `grok/grok-4.6:xhigh` logs the Lane A clamp warning once and the turn still runs. (Covered by unit + integration tests; wanted live.)
- **V6** — three faults open the **grok** breaker with claude closed, visible in `hive doctor`. (Covered by integration tests; wanted live.)

## Test-suite evidence

- Full gate green: `npm run check` → **2671 passed, 3 skipped** (147 files).
- Negative-verified per house rule:
  - reverting the rotation write-back fails the persistence test (`expected 'old-refresh-token' to be 'rotated-refresh-token'`);
  - removing the single-flight guard fails the concurrency test (`expected 5 to be 1`) — five grants, i.e. exactly the credential-corruption scenario;
  - reverting the `isLaneAProvider` body **typechecks clean** (confirming it is the silent-failure surface the spec flagged) and is caught only by tests — the handoff-variant assertion and both `:effort` assertions fail.
- Confirmed the spec's compile-force claim: reverting the `createProviderAdapter` adapter gate fails typecheck with `Type '"grok"' is not assignable to type 'LaneBProviderId'`.
