# KPR-356 — Hygiene: close PR #194 as superseded (no code)

**Child 11 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md).
**Shape:** no code. Pure hygiene — record the supersession of PR [keepur/hive#194](https://github.com/keepur/hive/pull/194) and the out-of-scope ruling on an OpenAI sidecar provider, so the epic's ledger has no dangling "what happened to the sidecar branch?" thread.
**Depends on:** none. Sequences anywhere; no file collisions with any sibling (the only repo diff this child produces is this spec + its plan under `docs/epics/kpr-345/`).
**Verified baseline (2026-07-22):** #194 (`feat(llm): multi-provider sidecar layer + secret hardening`, head `codex/multi-provider-sidecar-llm`) is **already CLOSED** — closedAt 2026-07-20T07:09:13Z, not merged — **and already carries a closing comment** recording the supersession (KPR-314 salvage → KPR-309/PR #318 refinement, OpenAI sidecar out of scope). The mechanical work is done; this spec documents the rationale as durable epic canon and defines the verify-only delivery.
**Decision-register canon honored:** "OpenAI *sidecar* provider (non-agentic one-shot calls) is explicitly out of this epic's scope" — this child records that ruling, it does not reopen it. The epic's two-lane model (Lane A: Claude passthrough via `ClaudeAgentAdapter`; Lane B: provider adapters) is the superset that absorbs #194's intent for agentic provider routing.

## TL;DR

PR #194 (April-2026 multi-provider sidecar layer) is superseded: main's `src/llm/` — salvaged from that branch under KPR-314 and refined/merged under KPR-309 (PR #318) — is a superset of everything it shipped except the OpenAI/OpenAI-compatible sidecar providers, which are ruled out of this epic's scope by canon. The PR is already closed (2026-07-20, unmerged) with a supersession comment posted, so delivery here is verify-only: confirm closed-not-merged + supersession note present, land this spec/plan under `docs/epics/kpr-345/`, and change zero code.

## Key Points

- **The decision:** #194 closes as **superseded, not rejected** — its provider-seam design won; it landed via a better path (KPR-314 salvage → KPR-309 refinement) rather than via the original branch.
- **What absorbed it:** main's `src/llm/` (`types.ts`, `registry.ts`, `provider-utils.ts`, `catalog.ts`, `errors.ts`, `providers/`) now covers #194's registry + anthropic/gemini providers and adds what the branch lacked — cost tracking, `jsonSchema` structured outputs, no-key precheck, and the fixes accumulated since April. For agentic provider routing, the epic's Lane A/B adapter model (KPR-347–349, 353) supersedes #194's "Phase 2" ambition entirely.
- **The one unported piece is out of scope by canon:** OpenAI/OpenAI-compatible *sidecar* providers (non-agentic one-shot calls — model routing, classification, memory lifecycle, vision). Explicitly out of this epic's scope; can be filed separately if wanted. This is consistent with the fleet's subscription-first posture (vendor `OPENAI_API_KEY` optional/deferred/non-gating).
- **Mechanical closure already happened:** closed 2026-07-20T07:09:13Z, unmerged, with a "Closing as superseded" comment already on the PR referencing KPR-314/KPR-309/PR #318 and the out-of-scope ruling. Posting the §Deliverable comment is therefore a **verify-only no-op** unless the existing comment is found missing or materially deficient.
- **No code changes** — no diff outside `docs/epics/kpr-345/` (this spec + plan). No branch deletion mandate: cleanup of `codex/multi-provider-sidecar-llm` is left to routine janitor tooling (reconcile-tickets), not this child.
- **Why record it at all:** #194 was the epic's ancestral artifact — the last open thread from the pre-KPR-209 "sidecar Phase 1 / AgentRuntime Phase 2" framing (KPR-68, canceled). Closing the loop in the epic's own docs prevents a future drafter from rediscovering the branch and re-litigating the sidecar.
- ⚠ Delegated assumption: the existing closing comment **suffices** — an explicit (re)post is not required when an equivalent comment is already present (§Open assumptions A1).

## Problem / context

#194 (April 2026) was Phase 1 of the pre-epic multi-provider strategy: route hive's **non-runtime** LLM calls (model routing, meeting classification, memory lifecycle, image description) through a provider-agnostic registry with Anthropic/OpenAI/Gemini/OpenAI-compatible adapters, plus DOD-212 secret hardening. It was converted to draft in April to wait for its Phase 2 (KPR-68, AgentRuntime abstraction) because Phase 1 alone didn't address the vendor-lock-in concern it was motivated by.

That framing is dead. KPR-209 superseded KPR-68 with the orchestration-layer realignment, and this epic (KPR-345) delivers the real answer to the vendor-lock-in concern: the two-lane runtime where Lane B provider adapters execute **agentic** turns with real tools (KPR-347/348/349/353 merged in this baseline). Meanwhile the salvageable core of #194 — the provider seam for sidecar calls — was extracted from the branch under KPR-314 and refined/merged under KPR-309 (PR #318). Main's `src/llm/` is now a strict superset of #194's landed value: same registry shape, anthropic + gemini providers, plus cost tracking, structured outputs, the no-key precheck, and post-April fixes the stale branch never received.

What remains unabsorbed is exactly the piece canon rules out: OpenAI/OpenAI-compatible sidecar providers. The fleet runs subscription auth with no vendor `OPENAI_API_KEY` (optional/deferred/non-gating by directive), so an OpenAI sidecar has no live consumer today. Keeping #194 open to preserve that fragment would hold a 3-month-stale branch hostage to a hypothetical — file a fresh ticket against current `src/llm/` if the need materializes.

## Deliverable

### (a) Closing comment on PR #194 — canonical text

The following is the canonical supersession record. **Verified: an equivalent comment already exists on the PR** (posted at closure, 2026-07-20). If verification during delivery finds it present — expected — this deliverable is a no-op. Only if it were missing or materially deficient (no KPR-314/KPR-309 reference, or no out-of-scope ruling) would the text below be posted:

> Closing as superseded (KPR-356, epic KPR-345). Main's `src/llm/` provider seam was salvaged from this branch under KPR-314 and refined/merged via KPR-309 (PR #318) — it now covers everything here (registry, anthropic + gemini providers, cost tracking, jsonSchema structured outputs, no-key precheck) with fixes this branch lacked. The one unported piece — OpenAI/OpenAI-compatible sidecar providers (non-agentic one-shot calls) — is explicitly out of scope for epic KPR-345 per its decision register; file separately against current `src/llm/` if wanted. Agentic provider routing (this PR's "Phase 2" ambition) is delivered by the epic's Lane B adapters instead (KPR-347–349, KPR-353).

### (b) No code changes

Confirmed: nothing in `src/` moves. Main's `src/llm/` already is the superseding artifact; #194's branch is not merged, rebased, or partially cherry-picked further. The only repo diff from this child is this spec and its plan under `docs/epics/kpr-345/`.

### (c) Out-of-scope ruling (recorded)

An OpenAI *sidecar* provider — non-agentic one-shot calls through `src/llm/` — is **out of this epic's scope** (decision-register canon). Nothing in this epic's remaining children (346/350/351/352/354/355) should grow sidecar-provider work. If a concrete consumer appears, it gets its own ticket, specced against current `src/llm/` (registry + provider adapter shape), not against #194's stale branch.

## Non-goals / out of scope

- Implementing an OpenAI or OpenAI-compatible sidecar provider (the ruling above — not deferred, *excluded* from this epic).
- Reopening, rebasing, or partially merging #194; cherry-picking any remaining fragment of the branch.
- Deleting the `codex/multi-provider-sidecar-llm` branch (routine janitor territory; not gated on this child).
- Any change to `src/llm/`, Lane B adapters, or any other code.
- Relocating or rewriting #194's original spec/plan docs (they live in `keepur/hive-docs/internal/`; historical record, left as-is).

## Testing contract

**This is a no-code ticket: there are no unit, integration, or e2e code test groups — N/A by construction.** There is no diff for tests to cover (the entire repo change is two markdown files under `docs/epics/kpr-345/`), so the "define test groups" gate is satisfied by this explicit N/A plus the concrete verification checklist below, which is the whole of delivery:

1. **PR state:** `gh pr view 194 --repo keepur/hive --json state,mergedAt,closedAt` → `state: CLOSED`, `mergedAt: null` (closed, **not** merged). Baseline-verified 2026-07-22.
2. **Supersession note present:** the PR's comment thread contains a closing comment equivalent to §Deliverable(a) — references KPR-314 and/or KPR-309/PR #318 as the absorbing work AND records the OpenAI-sidecar out-of-scope ruling. Baseline-verified present; if absent/deficient, post the canonical text and re-verify.
3. **No code diff:** `git diff <epic-base>...HEAD --stat` on this child's branch shows changes only under `docs/epics/kpr-345/` (this spec + the plan).
4. **Docs land:** `docs/epics/kpr-345/kpr-356-spec.md` and `kpr-356-plan.md` exist on the child branch and merge to the epic branch through the normal child-PR flow.

`npm run check` still runs on the child PR per repo policy (CI is unconditional); it exercises the unchanged codebase and is expected green with zero relation to this child's content.

## Open assumptions

- **A1 (⚠ delegated):** the closing comment already on #194 (posted 2026-07-20 at closure) **suffices** as the supersession record — it names the salvage path (KPR-314 → KPR-309/PR #318), enumerates the superset coverage, and states the out-of-scope ruling. Assumption: no re-post is required for the KPR-356 ticket-id back-reference alone; the canonical text in §Deliverable(a) exists as the fallback if review rules the existing comment deficient. Non-blocking either way — worst case is posting one comment.
- **A2:** leaving the unmerged branch `codex/multi-provider-sidecar-llm` in place (undeleted) is acceptable hygiene; branch GC belongs to reconcile-tickets, not this child. Non-blocking.
- **A3:** #194's original design docs under `keepur/hive-docs/internal/` need no supersession stamp — the PR comment + this spec are the discoverable record. Non-blocking.
