# KPR-321 — W5.1: Telephony foundation — dedicated Twilio line + CNAM

**Epic:** KPR-320 (W5: Voice v2 — outbound vendor pilot). **Blocks:** KPR-325 (call personas + vendor pilot — places real calls from this line). **Feeds:** KPR-322 (LiveKit Agents worker — consumes the line via SIP trunking; handoff artifacts defined in §8).

**Decision Register note:** epic KPR-320 has no `## Decision Register — Canon` section yet (this is the first lane of a fresh epic). The one binding ruling is recorded inline below as D1; when the epic register is created, D1 should be its first entry. Not a blocker.

**Ticket shape:** ops runbook, not code design. Zero hive engine changes. The only "code-adjacent" output is documented names for future config/secret keys (§9) and SIP handoff artifacts (§8) that KPR-322 will wire.

> **D1 (ruled 2026-07-13, May, "Start now — split roles"):** May personally sets up the Twilio account + payment method (the human-only part). The KPR-321 ops lane then drives CNAM registration, number purchase, and configuration to done, **checking in with May at each spend or business-identity step**. The track runs in parallel with spec maturity — it is NOT gated behind the rest of the wave (W5 code delivery is frozen; this ops track is the sanctioned exception, because of external registration lead time).

## TL;DR

Stand up a dedicated "DodiHome purchasing/ops line" on a new Twilio account: Trust Hub Business Profile → voice-capable local number → SHAKEN/STIR (A-attestation) → CNAM registration ("DodiHome" on carrier displays) → vendor announcement, with an Elastic SIP trunk pre-created as the KPR-322 handoff. The critical path is external vetting + CNAM propagation — **realistically 2–3 weeks** end-to-end, with a **stacked worst case of ~4+ weeks** (48h profile vetting + ~5 business days CNAM approval + 15 business days propagation) — which is why this runs now, decoupled from the frozen W5 code wave. Twilio Verified Caller ID presenting the existing Quo number is documented as the fallback if pickup rates disappoint — with the caveat (new finding) that it caps at SHAKEN/STIR **B** attestation, so it trades number familiarity for weaker call-trust signaling.

## Key Points

- **D1 split is the spine of the runbook, refined by dispatcher reconciliation:** Track A = May-only — account creation, payment, **entering and submitting** business-identity fields into Twilio's forms at G1 and G3 (agent guardrails prohibit agents from entering EIN/legal identifiers into forms, regardless of ruling text), and creating the Twilio API key pair + SIP credential-list password so no secret value ever enters an agent session. Track B **prepares** everything preparable — field checklists, number shortlist, trunk shell — and hands off to May at the gate for entry-and-submit. Four May check-in gates: G1 identity submission, G2 number purchase/spend, G3 CNAM display-name submission, G4 vendor announcement.
- **Finding — prerequisite chain is longer than the ticket implies.** Since Twilio's June 1, 2026 voice-regulation tightening, Trust Hub Business Profile + SHAKEN/STIR onboarding are effectively mandatory for outbound US calling (unregistered traffic risks blocking/spam labels). CNAM is the *last* link of a chain (profile → number → SHAKEN/STIR → CNAM), not a standalone registration. Reinforces START EARLY.
- **Lead times (Twilio docs, checked 2026-07-13):** Business Profile vetting ~24–48h; SHAKEN/STIR trust product up to 72h; CNAM approval + carrier propagation 48–72h officially, **7–15 business days for full carrier coverage** in practice. Number purchase itself is instant. **Realistic end-to-end estimate: 2–3 weeks; stacked worst case: ~4+ weeks** — don't anchor KPR-325 scheduling to the optimistic number.
- **Finding — fallback is weaker than assumed:** Verified Caller ID on the Quo number yields at most **B attestation** (Twilio can't attest ownership of a non-Twilio number), is voice-only (no Twilio inbound, no SMS), and its CNAM is whatever OpenPhone's carrier registered — outside our control. Documented (§7), not built; trigger = KPR-325 pilot pickup rates disappoint.
- **Gate-decline + teardown (new §12):** a "no" at any gate triggers one re-proposal with alternatives (different name/number/cost option); a second "no" parks the ticket operator-held, state recorded. Mid-chain abandonment has a teardown checklist (release number, delete trunk/credentials, scrub Honeypot keys, vendor retraction only if abandonment happens after the announcement already went out).
- **CNAM failure paths (§5.2, §6.1):** display-name rejection → prepared variants → one retry → G3 re-consult with May if that fails too; propagation stuck past the 15-business-day outer window → Twilio support ticket + weekly re-verify + a May gate decision (announce anyway, accepting number-only recognition, vs. hold the announcement).
- **In scope:** Twilio account bring-up, Trust Hub profile, number purchase, SHAKEN/STIR + CNAM registration, interim inbound handling (callback forwarding), vendor announcement, SIP trunk shell + credential for KPR-322, secrets placement, verification checklist, gate-decline/teardown handling.
- **Out of scope (non-goals):** porting the main Quo number (explicitly customer-phase), LiveKit worker design (KPR-322), call personas / pilot rubric / pickup-rate thresholds (KPR-325), any hive engine code changes, A2P 10DLC / SMS campaign registration (line is voice-first; no Twilio SMS in W5).
- ⚠ **Business-identity fields (legal name, EIN, address, authorized rep) are runtime inputs collected from May at execution** — placeholders throughout; not spec blockers, not to be guessed.
- ⚠ Delegated assumptions (details in §11): CNAM display name proposal "DodiHome"; area code = match existing Quo line; interim inbound = forward to Quo ops line; announcement sent by Nora + Sige from their own identities after CNAM verifies.
- **Risk:** CNAM display on *wireless* carriers is inconsistent (carrier apps/branded-calling ecosystems have partially displaced CNAM dips). Vendors answering on business landlines/VoIP are the favorable case; the pilot (KPR-325) measures reality. Voice Integrity is the documented escalation lever if the new number gets spam-labeled — not purchased up front (YAGNI).

## 1. Problem / Context

DodiHome (custom cabinetry) wants agents (Nora — purchasing/ops; Sige — production support, bilingual Mandarin/English) placing outbound vendor calls. Today all telephony runs on Quo/OpenPhone (`src/channels/sms-adapter.ts`, `src/quo-mcp-server.ts`); voice experiments ran through Vapi (`hive.yaml` `voice:` block, `src/config.ts:408-417`). W5 pivots outbound voice to a LiveKit Agents worker over SIP (KPR-322), which needs a real PSTN line with a trustworthy identity: a dedicated Twilio number, A-attestation SHAKEN/STIR signing, and "DodiHome" as registered CNAM so vendors answer. There is **no Twilio account yet**. Every step past account creation has external vetting/propagation lead time, so this ticket runs now, ahead of the frozen code wave.

## 2. Goals (done criteria)

1. Twilio account exists, upgraded (payment on file), owned by May. (Track A)
2. Trust Hub Business Profile is **Twilio-Approved** (EIN-backed). (gate G1)
3. Voice-capable US local number purchased per §5 criteria. (gate G2)
4. SHAKEN/STIR trust product approved; number assigned; test call signs **attestation A**.
5. CNAM trust product approved with display name per G3; CNAM lookup + live test calls show "DodiHome" (§6).
6. Interim inbound handling live: callbacks to the new number reach a human-reachable destination (§5.3), no dead air.
7. Vendors announced (§6.2) by the agents from their own identities, after G4 approval.
8. Elastic SIP trunk shell + credential list created; handoff artifacts for KPR-322 recorded (§8).
9. Secrets seeded in Honeypot; config key names documented (§9). No secret ever enters cloud-model-facing context.
10. Verified-Caller-ID fallback documented with trigger + mechanics (§7) — documented only, nothing built.

## 3. Non-Goals

- **No porting of the main Quo number** — explicitly a customer-phase decision (ticket text).
- **No LiveKit worker design** — KPR-322. This spec only defines what 322 consumes (§8).
- **No call personas, pilot rubric, or pickup-rate thresholds** — KPR-325.
- **No hive engine code changes** — no new `src/config.ts` keys wired, no channel adapter, no MCP server. Names in §9 are reservations for KPR-322, not implementation.
- **No A2P 10DLC / SMS registration** — the line is voice-first; SMS stays on Quo.
- **No Voice Integrity / branded-calling purchase** — documented as escalation levers only.

## 4. Prerequisite chain & lead times (2026 reality, sources checked 2026-07-13)

```
Account create + upgrade ──► Business Profile (EIN) ──► buy number ──► SHAKEN/STIR product ──► CNAM product ──► propagation ──► verify ──► announce
        same day                  ~24–48h vetting          instant          ≤72h vetting          approval, then 48–72h…7–15 business days
```

| Step | Lead time | Notes |
|---|---|---|
| Account create + upgrade | same day | Trial accounts can only call verified numbers; payment method (Track A) lifts trial limits. |
| Trust Hub Business Profile | ~24h (docs), up to 48h | Requires EIN or DUNS, legal name/address, authorized representative. |
| Number purchase (US local) | instant | No regulatory bundle for US local numbers. ~$1.15/mo class of spend ⚠ verify current price in console. |
| SHAKEN/STIR trust product | up to 72h vetting | Number must be assigned to profile + product to sign **A**. |
| CNAM trust product | approval not precisely documented (budget ~2–5 business days) + **48–72h propagation** officially; full carrier coverage anecdotally **7–15 business days** | Free per Twilio. US numbers only; toll-free excluded (we use local — fine). |
| Verified Caller ID (fallback only) | minutes | Validation call or SMS to the Quo number. |

**Critical path to "CNAM shows DodiHome":** account → profile → CNAM approval → propagation ≈ **2–3 weeks realistic**; **~4+ weeks stacked worst case** (48h profile vetting + ~5 business days CNAM approval + 15 business days propagation). Everything else (trunk shell, interim inbound, fallback doc) hangs off the chain without extending it.

**Flag vs. ticket assumptions:** the ticket framed CNAM as the long-pole registration. Post-June-2026, Trust Hub + SHAKEN/STIR are mandatory predecessors, and full CNAM propagation can exceed Twilio's official 48–72h figure. Net: same conclusion (START EARLY), longer chain than written.

## 5. Runbook

Placeholders in `{braces}` are **runtime inputs collected from May at execution** — ⚠ never guessed, never committed to the repo.

### Reconciliation: prepare vs. enter-and-submit (dispatcher ruling)

D1 says the ops lane "drives CNAM registration, number purchase, and configuration to done," checking in with May at each identity/spend step. Taken literally, that would have an agent typing the EIN and legal name into Twilio's Business Profile form (B1) and the CNAM display name into the CNAM form (B5) — which agent guardrails prohibit regardless of ruling text (no agent enters government/business identifiers into external forms). **Reconciliation: Track B prepares, Track A enters and submits, at the gate May is already stopping at.** B1/B5 assemble every preparable field and the submission checklist; A4/A5 are May typing the prepared values into Twilio's console and clicking submit. This adds no new gates — G1 and G3 already required May's presence.

### Track A — May (human-only)

| # | Step | Output |
|---|---|---|
| A1 | Create Twilio account with a DodiHome-controlled email; enable 2FA | Account SID |
| A2 | Upgrade account: add payment method | Trial limits lifted |
| A3 | Provide business-identity fields to the ops lane for G1 prep: `{LEGAL_ENTITY_NAME}`, `{EIN}`, `{BUSINESS_ADDRESS}`, `{AUTHORIZED_REP_NAME/EMAIL/TITLE}` (rep should be May) | G1 prep inputs |
| A4 | **At G1:** enter the Business Profile fields B1 prepared into Trust Hub's form; submit | Business Profile submitted |
| A5 | **At G3:** enter the CNAM display name B5 prepared (incl. fallback variants if a prior attempt was rejected, §5.2) into the CNAM trust product form; submit | CNAM submitted |
| A6 | Create the Twilio **API key pair** and the **SIP trunk credential-list** (username + password) in console | Secrets exist |
| A7 | Seed A6's secrets + Account SID into Honeypot herself (`hive credentials add` / `honeypot set`) — values never pass through an agent session (§9) | Secrets live |

A1, A2, A4, A5, and A6 require May directly — either actions agents are prohibited from performing (account creation, payment, entering government/business identifiers into forms) or credential creation that must never pass through an agent session. Track B does all the preparation (checklists, shortlists, trunk-shell config) so May's at-gate time is entry-and-click, not drafting.

### Track B — ops lane (agent-driven, with May check-in gates)

Gates: **G1** = business-identity submission (prepared by B1, entered by A4), **G2** = spend, **G3** = business-identity display name (prepared by B5, entered by A5), **G4** = external comms. At each gate the lane presents exactly what will be submitted/spent and waits for May's go. Gate-decline handling: §12.

| # | Step | Gate | Depends on |
|---|---|---|---|
| B1 | Prepare the Trust Hub **Business Profile** submission from A3 inputs — assemble the field set + document checklist; present at G1 for May to enter (A4) | **G1** (present) | A1–A3 |
| B2 | Search voice-capable local numbers per §5.1 criteria; shortlist 2–3; present with monthly + per-minute cost | **G2** | A2 |
| B3 | Purchase chosen number | (covered by G2) | B2 |
| B4 | Create **SHAKEN/STIR trust product**; assign Business Profile + number; submit for vetting | — (no new identity/spend) | B1 approved, B3 |
| B5 | Prepare the **CNAM trust product** submission — display name `{CNAM_DISPLAY_NAME}` (proposed: `DodiHome` — 8 chars, letters only, well under the 15-char limit; industry displays often uppercase to `DODIHOME`) plus fallback variants (§5.2); present at G3 for May to enter (A5) | **G3** (present) | B1 approved, B3 |
| B6 | Interim inbound handling (§5.3): point the number's voice config at a TwiML forward to `{INBOUND_FORWARD_TARGET}` | — | B3 |
| B7 | Create **Elastic SIP trunk** shell: trunk + termination URI `dodihome-ops.pstn.twilio.com` (or similar unique domain); attach the credential list A6 created **by SID reference only** — the agent never generates or sees the username/password | — | A6 |
| B8 | Verify SHAKEN/STIR: place test call, confirm attestation **A** (§6.1) | — | B4 approved |
| B9 | Verify CNAM: lookup + live test-call matrix (§6.1); on failure see §6.1 CNAM failure paths | — | B5 approved (submitted via A5) + propagation |
| B10 | Vendor announcement (§6.2): draft per-agent messages, review with May/ops, send from Nora + Sige's own identities | **G4** | B9 |
| B11 | Record handoff artifacts for KPR-322 (§8) + close out verification checklist (§10) | — | B7–B10 |

Steps B4/B5 parallelize after B1 (approved) + B3; B6 is off-critical-path and can run any time after B3; B7 needs A6 done first — the credential list must exist before the trunk shell can reference it.

### 5.1 Number selection criteria (B2)

- **Voice-capable US local number** (not toll-free — toll-free is excluded from CNAM and reads as telemarketing to vendors).
- **Area code:** ⚠ delegated default — match the existing Quo ops line's area code / DodiHome's business locale (`{AREA_CODE}`, confirmed with May at G2). Vendors are regional; a local, familiar area code is the pickup-rate play.
- SMS capability is nice-to-have (future optionality), not required.
- Post-purchase sanity: place 2–3 test calls to team phones; if the number arrives pre-tainted with spam labels (recycled-number risk), release and re-pick within Twilio's release window rather than remediating.
- **Spam-taint replacement purchase:** if release-and-re-pick is needed, the replacement is covered by the **original G2 approval only if** it comes from B2's already-approved shortlist and stays within the approved budget; anything outside that shortlist/budget needs a fresh G2. ⚠ Confirm Twilio's actual number-release window during execution — not verified in this research pass.

### 5.2 CNAM display name (B5 prepares / A5 submits, G3)

Rules: max 15 chars, must start with a letter, letters/numbers/periods/commas/spaces only, no generic city/state values. Proposal `DodiHome` complies. ⚠ Final string is May's call at G3 (it's the public business identity on every vendor's phone).

**If Twilio rejects the display name:** B5 prepares 1–2 fallback variants up front (e.g. `Dodi Home`, `DodiHome Ops` — both compliant with the rules above) so a rejection doesn't stall the chain waiting on a fresh prep cycle. A5 submits **one retry** with a variant. If that also fails, stop — don't loop autonomously — and re-consult May at G3 before any further attempts.

### 5.3 Interim inbound handling (B6)

Vendors **will** call the announced number back. Until KPR-322 attaches LiveKit via SIP origination, the number stays on Programmable Voice with a minimal TwiML `<Dial>` forward to `{INBOUND_FORWARD_TARGET}` — ⚠ delegated default: the existing Quo ops line (keeps callbacks inside today's working channel; zero new infrastructure). Voicemail-only is the fallback if forwarding misbehaves. This is console/TwiML-bin config, not engine code.

## 6. Verification & announcement

### 6.1 How we know it worked

- **Attestation A:** after B4 approval, place a test call and confirm A-level signing — check the call's SHAKEN/STIR disposition in Twilio call logs/insights, and/or observe "Caller Verified" on a supporting handset. If it signs B, the number↔profile↔product assignment is wrong — fix before CNAM verification effort.
- **CNAM:** two layers, because carriers dip different databases:
  1. **Lookup:** query caller-name (CNAM) for the new number via a lookup service (Twilio Lookup caller_name or equivalent third-party dip) — confirms the authoritative-database write.
  2. **Live matrix:** test calls to a small carrier matrix — at least one landline/VoIP (the vendor-realistic case, where classic CNAM dips still rule) and majors (AT&T/Verizon/T-Mobile mobiles, acknowledging wireless display is app-mediated and inconsistent). Record per-carrier results; the acceptance bar is the landline/VoIP class showing `DodiHome`, not 100% of wireless.
- **Do not announce (B10) before CNAM verifies** — the announcement's value is "save this number, it's us," and it lands best when the name already displays. If KPR-325 timing pressure demands, announcement may be pulled earlier with May's explicit okay at G4 (the message itself carries the number, so CNAM is reinforcing, not load-bearing).

**CNAM failure paths:**
- **Display-name rejection:** see §5.2 — fallback variants prepared in B5, one retry via A5, then stop and re-consult May at G3 if the retry also fails.
- **Propagation stuck:** if the landline/VoIP acceptance bar above still fails past the 15-business-day outer window from §4, open a Twilio support ticket, re-verify weekly (lookup + spot test calls), and present May a gate decision: **announce anyway** — accepting number-only recognition for now, since B10's message already carries the number, so this is a degraded-but-usable state, not a failure — **vs. hold the announcement** until CNAM resolves. Treat this as an ad hoc G3-adjacent check-in, not a formal fifth gate.

### 6.2 Vendor announcement (B10, G4)

- **Who sends:** Nora (purchasing/ops vendors) and Sige (production-support vendors, Mandarin where appropriate) — outbound vendor comms come **from the agents' own identities** per operator policy (no ghost-writing as May, no shared "DodiHome robot" voice).
- **Approval:** drafts reviewed at G4 (May/ops check-in) before anything is sent — this is external business comms announcing a new company contact channel.
- **Content (drafted at execution, not here):** new number, what it's for (purchasing/ops calls), existing Quo line unchanged for SMS, who they'll be talking to.
- **Channel:** whatever each vendor relationship already uses (email from the agent's address, or SMS from the Quo line). Choosing per-vendor channel is the agents' judgment within G4-approved drafts.

## 7. Fallback — Verified Caller ID presenting the Quo number (documented, NOT built)

**Trigger:** KPR-325 pilot pickup rates disappoint on the new number (threshold and measurement belong to KPR-325's rubric — not defined here). Decision to flip is a May/ops check-in.

**Mechanics:** verify the Quo number as a Twilio Verified Caller ID (console or API; Twilio delivers a validation code via call or SMS to the Quo number — note the SMS path is convenient because the code lands in the existing Quo integration). Once verified, outbound Twilio/LiveKit calls set `From` to the Quo number (E.164).

**Known trade-offs (2026 docs — this is the material caveat vs. the ticket's framing):**
- **Attestation caps at B.** Twilio cannot attest ownership of a non-Twilio number, so calls presenting the Quo number sign B — weaker trust signal, no "Caller Verified" badge, somewhat higher spam-label risk. The fallback trades *number familiarity* for *attestation strength*; the pilot data decides which wins.
- **Voice-only:** no inbound to Twilio on that number (callbacks ring Quo as they do today — actually convenient), no SMS display use.
- **CNAM not ours to set via Twilio:** display name for the Quo number is whatever OpenPhone's underlying carrier registered. If it's wrong/missing, remediation goes through OpenPhone support, not Twilio.

**Escalation ladder if *both* identities underperform:** Voice Integrity (spam-label remediation across analytics providers) on the Twilio number, then branded-calling products. Priced/decided only if triggered — YAGNI now.

## 8. Handoff artifacts for KPR-322 (LiveKit Agents worker)

KPR-321 delivers the trunk *shell*; KPR-322 does all LiveKit-side wiring. Recorded artifacts (values in Honeypot/ops notes, never in repo):

| Artifact | Produced by | Consumed by KPR-322 as |
|---|---|---|
| Twilio Account SID | A1 | API auth (with key pair below) |
| Twilio **API key pair** (SID + secret) | A6 | API auth alongside Account SID |
| Phone number (E.164) | B3 | Outbound `From` / LiveKit trunk number |
| Elastic SIP trunk SID + **termination URI** (`<domain>.pstn.twilio.com`) | B7 | LiveKit **outbound** trunk destination |
| Credential-list **username + password** | Created by May (A6); trunk attaches it by SID reference only (B7) — the agent never sees the values | LiveKit outbound trunk auth |
| Inbound path note | B6 | KPR-322 replaces the TwiML forward: assigns the number to the trunk and adds an **origination URI** pointing at the LiveKit SIP endpoint (`sip:<livekit>.sip.livekit.cloud;transport=tcp`), which cannot exist until 322 stands the endpoint up |

Explicitly deferred to 322: origination URI creation, number→trunk assignment (mutually exclusive with the interim TwiML routing), TLS/SRTP secure-trunking options, and any LiveKit config.

## 9. Secrets & config placement (names only — no engine wiring in this ticket)

Per the security posture: credentials live in macOS Keychain via Honeypot (`hive/<instanceId>/<KEY>`, instance = dodi), resolved as `secret-env` at MCP/worker spawn. **Never** in cloud-model-facing context, never in `.env` committed anywhere, never pasted into an agent session — the values are **created by May in Twilio's console (Track A6)** and **seeded into Honeypot by May (Track A7)**, in that order. Track B (B7) only ever references the credential list by SID when wiring the trunk shell — it never generates or sees the username/password.

| Key (Honeypot, `hive/dodi/<KEY>`) | What |
|---|---|
| `TWILIO_ACCOUNT_SID` | Account SID (low-sensitivity, kept with its siblings) — created A1, seeded A7 |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | Standard API key pair — preferred over the master auth token (scoped, revocable) — created A6, seeded A7 |
| `TWILIO_SIP_TRUNK_USERNAME` / `TWILIO_SIP_TRUNK_PASSWORD` | Credential list for the trunk — created A6, seeded A7; Track B (B7) attaches it to the trunk by SID only; consumed by LiveKit outbound trunk in KPR-322 |

Non-secret config (future `hive.yaml`, **reserved names for KPR-322 to wire** — nothing added to `src/config.ts` now): `telephony.twilio.number`, `telephony.twilio.trunkDomain`. Naming follows the existing `voice:`/`quo:` block style; final shape is 322's design surface.

## 10. Verification checklist (close-out)

- [ ] Account upgraded (not trial); 2FA on; May is owner
- [ ] Business Profile status = Twilio-Approved
- [ ] Number purchased; voice-capable; criteria §5.1 met; not spam-tainted (test calls)
- [ ] SHAKEN/STIR product approved; test call signs attestation A
- [ ] CNAM product approved; lookup returns `{CNAM_DISPLAY_NAME}`; live test matrix recorded (landline/VoIP class shows the name)
- [ ] Inbound test: calling the number from an outside phone reaches `{INBOUND_FORWARD_TARGET}`
- [ ] Trunk shell + credential list exist; §8 artifact table filled in ops notes
- [ ] Honeypot keys seeded (`hive credentials list` shows all §9 keys set)
- [ ] Vendor announcements sent (Nora + Sige, own identities, G4-approved)
- [ ] Fallback doc (§7) acknowledged by May (so the pilot team knows the lever exists)

## 11. Risks & delegated assumptions

- **Wireless CNAM inconsistency** — CNAM reliably serves landline/VoIP dips; wireless display is increasingly mediated by carrier apps/branded-calling. Mitigation: acceptance bar targets the vendor-realistic landline/VoIP class; pilot measures the rest; Voice Integrity is the documented escalation.
- **Vetting rejection/delay** — EIN/legal-name mismatch is the common Business Profile rejection cause. Mitigation: G1 review against May-provided fields before submission; lead-time budget already assumes retry headroom.
- **Recycled-number spam taint** — mitigation in §5.1 (test then release/re-pick; replacement purchase re-uses G2 only within the approved shortlist/budget, otherwise a fresh G2).
- **CNAM display-name rejection or propagation stall** — mitigated by prepared name variants (§5.2) and the propagation failure path (§6.1: Twilio support ticket, weekly re-verify, May gate decision on announcing anyway vs. holding).
- ⚠ Delegated: CNAM display name `DodiHome` (May confirms at G3).
- ⚠ Delegated: area code matches existing Quo line (May confirms at G2).
- ⚠ Delegated: interim inbound forwards to the Quo ops line (voicemail as fallback).
- ⚠ Delegated: announcement waits for CNAM verification unless May pulls it earlier at G4.
- ⚠ Delegated: costs are order-of-magnitude from public pricing (number ~$1.15/mo, US voice ~$0.014/min, CNAM free) — exact figures presented live at G2 from the console.
- **Source note:** lead times/processes verified against Twilio docs + support material as of 2026-07-13; the June-2026 regulation summary leans partly on secondary reporting. Anything console-shaped gets re-confirmed live during execution — the runbook's gates make that natural.

## 12. Teardown & gate-decline

**Gate-decline semantics (any gate, G1–G4):** a "no" is not a dead end. The ops lane re-proposes **once**, with alternatives reflecting the reason for the decline — a different CNAM display-name variant, a different number/area code, a lower-cost option. A **second** "no" on the same decision parks the ticket **operator-held** — record the parked state (which gate, what was declined, what alternatives were offered) in ops notes, and stop. Resuming is May's call, not an autonomous retry loop.

**Teardown checklist (mid-chain abandonment, any point after A1):**

- [ ] Release the purchased number, if any — or, if May chooses to keep it dormant deliberately, note the ~$1.15/mo carrying cost and that keeping it is her call
- [ ] Delete the Elastic SIP trunk + credential list (if B7 ran)
- [ ] Remove the Honeypot keys seeded in A7 (`hive credentials remove <KEY>` for each §9 key)
- [ ] Downgrade or leave the Twilio account dormant — May's call at the point of abandonment, not automatic
- [ ] **Only if abandonment happens after B10** (announcement already sent): send a vendor retraction/correction note, under the same identity-and-approval rules as the original announcement (§6.2 — Nora/Sige's own identity, G4-equivalent review before sending)

Teardown is symmetric with the build: whatever Track B built, Track B tears down; whatever only May can touch (account status, dormant/cancel, Honeypot removal per the secrets posture) is hers. Nothing here is automatic — each teardown step is triggered by an explicit park/abandon decision, not inferred from silence.
