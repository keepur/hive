# Keepur Instance Tuning — Analysis (verbatim)

**Date:** 2026-04-25
**Instance:** keepur (`hive_keepur` MongoDB, `~/services/hive/keepur`)
**Agents at time of analysis:** Hermi (chief-of-staff, Opus), Samantha (Sonnet), Alexandria (Sonnet), Luna (Sonnet)
**Trigger:** May asked to (1) trim constitution + business-context for tokens while keeping the spirit, (2) tighten per-agent system prompts, (3) audit tools per agent.

This document is saved verbatim from the live audit so we can revisit it later. Edits to live config are NOT yet applied.

---

Got the full picture. Keepur is 4 agents (Hermi/Sam/Alex/Luna), with constitution + business context loaded into every agent prompt on every turn — so trims here compound. Here's the audit, no edits applied yet — confirm where you want to go first.

---

## 1. Constitution — 188 lines, ~2.5K tokens

**Spirit to keep:** authority flows from May, risk-level ladder, no self-modification, escalate-don't-loop, agentic mindset, tool discipline.

**Redundancy / cuttable:**

| Section | Issue | Suggested action |
|---|---|---|
| 1.7–1.10 (Data/Fin/Sec) | Restates the Risk Levels table | Drop 1.7–1.8; let the table carry it |
| 1.11–1.14 (Resources) | 1.12 ≈ 2.7's "Max 3 retries" | Move 1.12 into 2.7, drop 1.11/1.13/1.14 (covered by Guiding Principles) |
| 1.21–1.23 (Conflict) | Three lines saying the same thing | Collapse into one line |
| 2.1 Team Structure | Repeats hive.yaml + business-context | Drop |
| 2.4 Systems Access | Repeats business-context "Tools & Systems" | Drop |
| 2.5 Communication Rules | Repeats business-context "Communication Preferences" | Drop |
| 2.6 Autonomy & Approvals | 80% restates Risk Levels table | Keep only the "internal-vs-external" framing as 2 bullets |
| 2.8 Working Together | Three soft bullets | Collapse to one line in 2.2 |

**Also missing:** the template has a "Message Delivery" section (`templates/constitution-bootstrap.md.tpl:90`) explaining "don't reply via slack MCP, just return text" — **not in the rendered keepur constitution**. That's a real footgun worth backfilling.

Target: ~90 lines, same spirit.

---

## 2. Business Context — 57 lines, already lean

Mostly good. Two trims:
- "Tools & Systems" duplicates constitution 2.4 — pick one home (recommend: business-context, since constitution should be conduct, not inventory).
- "Communication Preferences" duplicates constitution 2.5 — same.

Target: ~45 lines.

---

## 3. Agent System Prompts — DRY violation

Sam/Alex/Luna prompts each repeat the same boilerplate ("be proactive", "use semantic search", "back with data", "work closely with May") — that all belongs in constitution 2.2, once. Hermi's prompt is the opposite problem: too generic ("be direct, concise, and actionable") with no real role definition.

**Proposed per-agent prompt template (5 lines max):**
```
You are <Name>, <Title> at Keepur. Reports to <X>. Collaborates with <Y, Z>.
You own: <2-4 concrete deliverables>.
Your domain ends where <other agent>'s begins: <boundary>.
Tools you should reach for first: <2-3 named tools/MCPs>.
<One role-specific guardrail or quality bar, if any>.
```

Soul stays — that's voice, not instruction.

**Per agent — what to actually change:**

| Agent | Current issue | Fix |
|---|---|---|
| Hermi | Generic, no Keepur context, no scope boundary vs Alex/Sam | Define as platform/admin, agent-team coordinator, *not* a doer of product/marketing work |
| Samantha | Repeats "be agentic" 3x | Lean to: GTM strategy, positioning, launch. Boundary: Luna owns the writing |
| Alexandria | Says "lives in GitHub and Linear" but has neither tool (see §4) | Either give her the tools or rewrite the prompt |
| Luna | "Content across all channels" but no publishing tools | Same problem — claim vs capability mismatch |

---

## 4. Tools — current state vs role claims

| Tool | Hermi | Samantha | Alexandria | Luna |
|---|:---:|:---:|:---:|:---:|
| memory | core | core | core | core |
| structured-memory | core | core | core | core |
| keychain | core | core | core | core |
| event-bus | core | core | core | core |
| contacts | core | core | core | core |
| admin | core | — | — | — |
| linear | — | core | — | — |
| **github** | — | — | **missing** | — |
| **code-task** | — | — | **missing** | — |
| **google-workspace / google** | — | **missing** | — | **missing** |
| **resend** (outbound email) | — | gated | — | gated |
| **slack** (outbound only) | — | — | — | — |
| delegateServers | none | none | none | none |

**Gap analysis:**
- **Alex** is "Head of Product *and engineering*" with `archetype: software-engineer` and `workshop: ~/github` — but has no `github`, no `code-task`, no `linear`. She literally cannot ship code. Either trim her role or add `linear`, `github` (if it exists for keepur), `code-task` to coreServers.
- **Luna** owns docs/blog/website — needs `google-workspace` (Drive/Docs) at minimum.
- **Sam** does GTM but has no read access to Gmail/Calendar (May's actual customer signals).
- **No agent has `slack`** — fine for *replying* (delivery pipeline does it) but blocks cross-channel posting per the constitution's Message Delivery rules.
- **`delegateServers` is empty across the board** — meaning agents can't delegate even to each other via subagents. May be intentional for a 4-person team.

---

## Proposed pattern → skill: `tune-instance`

If we run this exercise across instances, the repeatable shape is:

1. **Snapshot** — pull constitution, business-context, all agent defs (`db.agent_definitions`) + their declared tools.
2. **Constitution audit** — flag duplication with business-context, drift from template, sections that restate the risk table.
3. **DRY pass on prompts** — anything repeated across 2+ agents → constitution; per-agent prompt = identity + scope + boundary + first-reach tools.
4. **Capability/claim audit** — for each agent, diff "what the prompt says they do" vs "what their tools allow." Flag mismatches both ways (claim without tool, tool without claim).
5. **Tools matrix** — render the table above; surface gaps.
6. **Diff + apply** — write updated constitution/business-context to memory, agent updates via `db.agent_definitions.updateOne` with `updatedBy` traceable, SIGUSR1 reload.

That's the skill. It's roughly: *audit → propose → confirm → apply*, with the matrix + DRY checks being the load-bearing analytical steps.

---

**Where do you want to start?** I'd suggest the tools/capability audit first (§4) — fixing Alex's missing github/code-task is the only finding here that's a *functional* break, not just verbosity. Constitution + prompt trims are pure token savings and can ride on the same SIGUSR1 reload.

---

## Meta-finding (added when filing this)

This audit also exposes a gap upstream of tuning: the **initial setup experience** and **CoS's onboarding skill** don't produce instances that pass this audit on day one. Specifically:

- The constitution template ships with redundancy and a "Message Delivery" section that wasn't in the rendered keepur copy (template drift after bootstrap).
- CoS-authored Section 2 duplicates business-context wholesale rather than referencing it.
- New agents created post-bootstrap (Sam/Alex/Luna here) get prompts from CoS that boilerplate "be agentic" instead of pulling that from the constitution.
- No tool/role consistency check at agent creation — Alex was created as Head of Product+Eng without `github`/`code-task`/`linear`.

Filed as a Linear ticket alongside this analysis. The tuning skill (`tune-instance`) is the *remedial* tool; the setup/onboarding fix is the *preventive* one. Both are needed.
