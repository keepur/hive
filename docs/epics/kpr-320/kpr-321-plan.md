# KPR-321 — Implementation Plan: Telephony foundation — dedicated Twilio line + CNAM

**Ticket:** KPR-321 (W5.1), child of epic KPR-320 (W5 Voice v2). **Blocks:** KPR-325. **Feeds:** KPR-322.
**Spec:** [`kpr-321-spec.md`](./kpr-321-spec.md) (signed off through 3 Frontier review rounds). Section references (§n) below are spec sections; step IDs (A1–A7, B1–B11, G1–G4) are the spec's.
**Plan type:** ops runbook — zero hive engine changes. The executor is a future ops-lane session, not a coding session.
**API claims verified against twilio.com docs on 2026-07-13.** Anything marked ⚠ verify-at-execution could not be pinned from docs and must be re-confirmed live before relying on it.
**Status:** DRAFT — dispatcher runs the plan-review loop; not self-approved.

---

## 0. How to run this plan

### 0.1 Executor & tracks

- **Track A steps (A1–A7)** are May-only. The plan packages each as a **step card**: what May does, in what surface, with every preparable value pre-filled by the lane. The lane presents the card and waits; it never performs the card's actions.
- **Track B steps (B1–B11)** are lane-driven via the Twilio REST API using the §9 auth mechanism (§0.2 below). **No Track B API step can run before A6+A7 are complete** (keys seeded) — this is B2's precondition and cascades to everything after it.
- **Gates G1–G4**: the lane presents the exact check-in block given in the task, then stops until May answers. A "no" follows Appendix B (one re-proposal, then park operator-held). Gate approvals are per-decision — never generalized.
- **Wall-clock waits** (vetting, propagation) are park points: record state in ops notes, set a re-check (see the task's poll cadence), resume when the poll flips.
- Tick each `- [ ]` as executed. Ops notes live with the lane (Linear KPR-321 comments + agent memory at execution time — non-secret identifiers only; secret values exist solely in Honeypot).

### 0.2 API auth invocation shape (§9 mechanism — mandatory for every Track B command)

Every API command below is **one self-contained Bash invocation**. Secrets resolve from Keychain inside the invocation and flow shell → process env → TLS. Rules:

- Never `echo`/`printf` a resolved secret; never run with `set -x`/`-v`; never pass a secret on a separate visible line.
- Output goes through the `jq` filter shown with each command — filters select expected fields only. (No Twilio API below ever returns a secret: credential-list resources return usernames/SIDs, never passwords.)
- Standard prelude, copied verbatim as the first lines of every command block:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
```

(Variables live only for that single invocation; agent Bash calls don't persist environment. `TW_ACCT`/`TW_KEY` are low-sensitivity SIDs; `TW_SEC` is the secret and appears only in the `-u` argument.)

- All calls authenticate as `-u "$TW_KEY:$TW_SEC"` (API key auth — works for api.twilio.com, trusthub, trunking, lookups, insights, pricing subdomains).

### 0.3 Standard failure interpretations (apply to every API command)

| Symptom | Meaning | Action |
|---|---|---|
| HTTP 401, body `code: 20003` | Auth failed — key not seeded, mistyped service name, or key revoked | Re-check A7 seeding (`hive credentials list`), re-run auth smoke test (Task 6) |
| HTTP 404 on a resource URL | Wrong SID or wrong subdomain | Re-read the SID from the producing step's ops note |
| HTTP 400 with Twilio `code` + `message` | Validation failure — body says exactly what | Interpret per the step's specific table; don't retry blind |
| HTTP 429 | Rate limited | Back off ≥30s; these are single-shot ops calls, so this signals something looping — stop and inspect |
| Empty `security find-generic-password` output / "could not be found" | Honeypot key missing | A7 incomplete — present the A7 card again |

### 0.4 Placeholders (⚠ runtime inputs — never guessed, never committed)

| Placeholder | Source | First needed |
|---|---|---|
| `{LEGAL_ENTITY_NAME}`, `{EIN}`, `{BUSINESS_ADDRESS}`, `{AUTHORIZED_REP_NAME/EMAIL/TITLE}` | A3 (May) — the rep **email** is retained contact info per the Task 3 carve-out; the rest are G1-prep-scoped identity fields | B1 (email again at T14) |
| `{AREA_CODE}` | Delegated default: Quo ops line's area code; May confirms at G2 | B2 |
| `{CNAM_DISPLAY_NAME}` | Proposed `DodiHome`; May's call at G3 | B5 |
| `{INBOUND_FORWARD_TARGET}` | Delegated default: existing Quo ops line (E.164) | A6 card / B6 |
| `{NEW_NUMBER}` / `{NEW_NUMBER_PN_SID}` | B3 output | B4 onward |
| `{BP_SID}` | Business Profile SID (BU…), created A4, read via API Task 9 | B4, B5 |
| `{TEAM_PHONE_*}` | Task 0 (observer numbers collected with availability + consent: one landline/VoIP + AT&T/Verizon/T-Mobile mobiles) | Task 13, B8, B9 |

### 0.5 Fixed constants (doc-verified 2026-07-13)

| Constant | Value |
|---|---|
| SHAKEN/STIR trust product PolicySid | `RN7a97559effdf62d00f4298208492a5ea` (static, same for all accounts) |
| CNAM trust product PolicySid | `RNf3db3cd1fe25fcfd3c3ded065c8fea53` (used read-only here — to find/poll the CNAM product May creates at A5) |
| CNAM display-name rules | ≤15 chars, starts with a letter, letters/numbers/periods/commas/spaces only, no generic city/state values |
| Trunk DomainName rule | letters/digits/hyphens, must end `pstn.twilio.com` |
| Honeypot key names (§9) | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_SIP_TRUNK_USERNAME`, `TWILIO_SIP_TRUNK_PASSWORD` — all under `hive/dodi/` |
| Reserved config names (KPR-322 wires; **nothing added to `src/config.ts` now**) | `telephony.twilio.number`, `telephony.twilio.trunkDomain` |

---

## 1. Execution order (critical path, tracks interleaved per §4)

```
T1(A1)──T2(A2)──┬── T3(A3)──T5(B1 prep)──T6[G1]+A4──T7(wait: vetting ~24–48h)──┐
                │                                                              ├─ T10(B2)──T11[G2]──T12(B3)──T13(taint test)──┬─ T14(B4 SHAKEN/STIR, wait ≤72h)──T19(B8: attestation A)
                └── T4(A6)──T5b(A7)──T8(auth smoke)───────────────────────────┘                                              ├─ T15(B5 prep)──T16[G3]+A5──T17(wait: CNAM approval)──T20(B9: CNAM verify, wait 48–72h…15bd)
                                                                                                                             ├─ T18(B6 interim inbound)          │
                                                                                T9(B7 trunk shell — anytime after A6) ───────┘                                   │
                                                                                                             T21(B10 announce)[G4] ◄────────────────────────────┘
                                                                                                             T22(B11 close-out)
```

| Task | Spec step | Gate | Blocks on | Wall clock |
|---|---|---|---|---|
| T0 | preflight | — | — | — |
| T1 | A1 | — | — | May's time |
| T2 | A2 | — | A1 | May's time |
| T3 | A3 | — | A1 | May's time |
| T4 | A6 | — | A2 | May's time |
| T5 | B1 | — | A3 | — |
| T5b | A7 | — | A6 | May's time |
| T6 | G1 + A4 | **G1** | B1 | May's time |
| T7 | vetting poll | — | A4 | ~24–48h |
| T8 | auth smoke | — | A7 | — |
| T9 | B7 | — | A6 + A7 | — |
| T10 | B2 | — | A2 + A7 | — |
| T11 | G2 | **G2** | B2 | May's time |
| T12 | B3 | (G2) | G2 yes | instant |
| T13 | §5.1 taint test | — | B3 | minutes |
| T14 | B4 | — | T7 approved + T13 | ≤72h vetting |
| T15 | B5 | — | T7 approved + T13 | — |
| T16 | G3 + A5 | **G3** | B5 | May's time |
| T17 | CNAM approval poll | — | A5 | ~2–5 business days (budget) |
| T18 | B6 | — | B3 (+ A6 card's TwiML bin) | — |
| T19 | B8 | — | T14 approved | ≥10 min post-call |
| T20 | B9 | — | T17 approved | 48–72h → up to 15 business days |
| T21 | B10 | **G4** | B9 (or May's early pull) | May's time |
| T22 | B11 | — | B7–B10 | — |

Parallelism: T4/T5b/T8 run during T7's vetting wait. T14, T15/T16, T18, T9 all parallelize once T7+T13 are done. T9 can run even earlier (only needs A6+A7). Nothing after T12 extends the critical path except CNAM itself (T17+T20).

---

## 2. Tasks

### Task 0 — Preflight (lane)

- [ ] Read the spec end-to-end (`docs/epics/kpr-320/kpr-321-spec.md`); confirm no engine code will be touched at any step (§3 non-goals).
- [ ] Confirm no Twilio keys already exist: run `hive credentials list` (dodi instance) — expect none of the five §9 keys set. If any are set, stop and ask May whether a previous attempt exists (possible partial state; see Appendix A inventory commands).
- [ ] Open the ops-notes surface for this run (KPR-321 Linear comment thread at execution + agent memory). Create the empty §8 artifact table and the §10 close-out checklist copies there.
- [ ] Confirm with May a rough availability window for the Track A cards (A1–A3 together take ~20–30 min; A4 ~10–15 min; A5/A6/A7 ~15 min) so gates don't stall on scheduling.
- [ ] Collect `{TEAM_PHONE_*}` observer numbers for the test-call work — at least one **landline or VoIP** line plus AT&T / Verizon / T-Mobile mobiles (May/Mike/Corey/team handsets) — and confirm each owner's availability + consent to receive short test calls. Consumed at Task 13, B8 (T19), and B9 (T20).

### Task 1 — Card A1: Create the Twilio account (May)

Present this card to May verbatim (values pre-filled where possible):

> **Card A1 — Create Twilio account (~10 min)**
> 1. Go to `https://www.twilio.com/try-twilio` and sign up with a DodiHome-controlled email (your call which; it becomes the account owner login).
> 2. Verify email + phone as prompted.
> 3. In Console: profile menu → **User settings** → enable **two-factor authentication**.
> 4. From the Console home ("Account Info" panel), copy the **Account SID** (starts `AC…`) — you'll seed it into Honeypot at card A7; park it somewhere private until then (password manager note is fine). Do **not** paste it into this chat — it stays out of agent sessions with its siblings.
> ⚠ Console layout drifts; the panel names above are as-documented 2026-07-13.

- [ ] Present card A1; wait for May's "done".
- [ ] Record in ops notes: account created (date, owner email's mailbox — not the address itself if May prefers), 2FA on = May attests. **Not API-verifiable by the lane** (no keys exist yet); verified indirectly at Task 8.

### Task 2 — Card A2: Upgrade the account / payment (May)

> **Card A2 — Upgrade account (~5 min)**
> 1. Console → **Billing** → **Upgrade** (or "Add payment method").
> 2. Add the business card; complete the upgrade so the account leaves trial mode (trial can only call verified numbers — useless for this line).
> 3. Optional: set a billing alert (e.g. $20/mo) — this line's steady spend is ~$1.15/mo + pennies of test calls, so any alert firing means something's wrong.

- [ ] Present card A2; wait for "done".
- [ ] Record: upgraded = May attests now; **API-verified later** at Task 8 (`type: "Full"`).

### Task 3 — A3: Collect business-identity fields (May → lane, for B1 prep)

- [ ] Ask May for the G1 prep inputs, as a fill-in list: `{LEGAL_ENTITY_NAME}` (exactly as on IRS/EIN records), `{EIN}`, `{BUSINESS_ADDRESS}` (registered business address), `{AUTHORIZED_REP_NAME/EMAIL/TITLE}` (rep should be May per spec).
- [ ] **Handling rule (identity fields):** `{LEGAL_ENTITY_NAME}`, `{EIN}`, `{BUSINESS_ADDRESS}`, and the rep's **name/title** are collected for checklist assembly only (B1). The lane never enters them into any external form or API call (that's A4 — per the spec §5 reconciliation, agents don't enter government/business identifiers into external systems), never commits them to the repo, never puts them in Linear. Hold them in the session/private ops note for the duration of G1 prep only.
- [ ] **Carve-out (retained contact info):** `{AUTHORIZED_REP_EMAIL}` is designated **retained non-identity contact info** — it is a status-notification address, not a government/business identifier, so it sits outside the never-enter guardrail the spec's reconciliation protects. The lane keeps it for the life of the ticket and is permitted to send it as the `Email` param in T14's `POST /v1/TrustProducts`. It still never goes into the repo.
- [ ] Confirm with May which area code the Quo ops line uses → provisional `{AREA_CODE}` (final confirmation happens at G2).
- [ ] Confirm `{INBOUND_FORWARD_TARGET}` default = Quo ops line E.164 (delegated default per §11; May can override here or at the A6 card).

### Task 4 — Card A6: Create API key pair + SIP credential list (+ TwiML bin) (May)

Runs any time after A2 — do it in the same May session as A2 if she has 5 more minutes. Bundles the B6 TwiML bin (60 seconds, saves a later console trip).

> **Card A6 — Secrets creation in Twilio Console (~10 min). Nothing you create here gets pasted to me — values go straight to Honeypot at card A7.**
>
> **1. API key pair** (for the ops lane + later the LiveKit worker):
> - Console → **Account** → **API keys & tokens** → **Create API key**. ⚠ nav drifts; it lives under account-level settings.
> - Type: **Standard**. Friendly name: `hive-dodi-ops (KPR-321)`.
> - Copy the **SID** (`SK…`) and the **Secret** — the secret is shown once. Park both privately until card A7.
>
> **2. SIP credential list** (for the KPR-322 trunk):
> - Console → **Elastic SIP Trunking** → **Manage** → **Credential lists** → create. ⚠ nav drifts (also reachable via Voice → Manage → Credential lists).
> - Friendly name: `dodihome-ops-trunk-creds`.
> - Add one credential: username `dodihome-ops` (or your pick — letters/digits, no secrets in the name), password = generate a strong one (≥16 chars; Twilio requires mixed case + digit). Park username + password privately until card A7.
>
> **3. TwiML bin for interim inbound forwarding** (prep for step B6 — no number needed yet):
> - Console → **Explore products** → **TwiML Bins** → **Create new TwiML Bin**. ⚠ nav drifts. (TwiML Bins have **no public API** — that's why this is on your card and not mine.)
> - Friendly name: `dodihome-ops-interim-forward`.
> - Content (exactly, with the real forward number in E.164):
>   ```xml
>   <?xml version="1.0" encoding="UTF-8"?>
>   <Response><Dial>{INBOUND_FORWARD_TARGET}</Dial></Response>
>   ```
> - Save, then copy the bin's **URL** (`https://handler.twilio.com/twiml/EH…`) and give **that URL** (it's not a secret) back to me for step B6.

- [ ] Present card A6; wait for "done" + the TwiML bin URL.
- [ ] Record in ops notes: API key friendly name, credential-list friendly name, TwiML bin URL. (SIDs get read via API later; secrets never.)

### Task 5 — B1: Prepare the Business Profile submission (lane)

- [ ] Assemble the G1 submission checklist from A3 inputs. Field set for a Trust Hub **Primary Business Profile** (⚠ the live console form is authoritative — finalize this checklist against the actual form fields during G1; the set below is the doc-expected shape as of 2026-07-13):
  - Legal business name: `{LEGAL_ENTITY_NAME}` — must match IRS records exactly (mismatch is the #1 rejection cause, §11)
  - Business identity: Direct customer (DodiHome is calling for itself)
  - Business type: (LLC / corporation / etc. — as registered)
  - Business registration ID: EIN `{EIN}`, country US
  - Business address: `{BUSINESS_ADDRESS}`
  - Industry: (closest match — e.g., construction / home furnishings retail)
  - Website: dodihome.com
  - Regions of operations: USA
  - Authorized representative #1: `{AUTHORIZED_REP_NAME/EMAIL/TITLE}` (May), rep phone
- [ ] Cross-check `{LEGAL_ENTITY_NAME}` + `{EIN}` formatting with May once more (typo check, not a new gate — it's part of G1 prep quality per §11 mitigation).
- [ ] Note on the checklist: **no supporting documents are usually required for EIN-backed US profiles, but if the form requests any, that's May's to attach at A4.**

### Task 6 — Gate G1 + Card A4: Business Profile submission (May)

- [ ] Present the G1 check-in block:

> **G1 — Business-identity submission (Trust Hub Business Profile)**
> **What happens if you approve:** you (not I) enter the fields below into Twilio's Trust Hub form and submit them for vetting (~24–48h). This registers DodiHome's legal identity with Twilio — prerequisite for everything else (number trust, CNAM).
> **Fields prepared (B1):** [render the full Task 5 checklist with actual values]
> **What I'm asking:** confirm the fields are correct and that you're go to submit.
> **If no:** tell me what's off — I re-prepare once with corrections/alternatives; a second no parks the ticket (spec §12, Appendix B here).

- [ ] On "go", present card A4:

> **Card A4 — Enter + submit the Business Profile (~10–15 min)**
> 1. Console → **Trust Hub** → **Customer Profiles** (⚠ sometimes surfaced as "Overview → Create Primary Business Profile"; nav drifts).
> 2. Create a **Primary Business Profile**; enter exactly the fields from the checklist above.
> 3. Submit for review. Status will show `pending-review` / `in-review`.
> 4. Tell me "submitted" — I'll poll status via API from here.

- [ ] Record: G1 approved (date/words used), A4 submitted (date).

### Task 7 — Poll Business Profile vetting (lane; wall-clock ~24–48h)

- [ ] Poll once A7 is seeded (Task 5b) — until then May can relay the console status if asked. Command:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://trusthub.twilio.com/v1/CustomerProfiles" \
  | jq '.results[] | {sid, friendly_name, status, valid_until}'
```

- Expected while vetting: one result, `sid` starting `BU`, `status: "pending-review"` or `"in-review"`.
- Expected done: `status: "twilio-approved"`. Record `{BP_SID}` in ops notes (it's also a §8-adjacent identifier KPR-322 may want).
- Failure: `status: "twilio-rejected"` → fetch the same object's failure details (`jq '.results[]'` unfiltered — rejection reason rides on the resource/email notification), map the reason to the field checklist, and re-enter G1 with the correction (counts as the one re-proposal; a second rejection of the same shape → re-consult May per Appendix B).
- [ ] Poll cadence: once ~24h after submission, then every 12h. Past 72h with no movement → have May check the status-notification email; past 5 business days → Twilio support ticket (May's account, so May files it from console with lane-drafted text).

### Task 5b — Card A7: Seed Honeypot (May)

Immediately after A6 (same sitting ideally). Also covers the Account SID from A1.

> **Card A7 — Seed secrets into Honeypot (~5 min, on the dodi box)**
> For each of the five keys, run the command and paste the value **at the tool's own prompt** (never as a command argument, never into this chat):
> ```
> hive credentials add TWILIO_ACCOUNT_SID
> hive credentials add TWILIO_API_KEY_SID
> hive credentials add TWILIO_API_KEY_SECRET
> hive credentials add TWILIO_SIP_TRUNK_USERNAME
> hive credentials add TWILIO_SIP_TRUNK_PASSWORD
> ```
> ⚠ If `hive credentials add` rejects a key (curated-registry miss for TWILIO_*), fall back to Honeypot directly for that key: `honeypot set hive/dodi/<KEY>` (⚠ verify exact `honeypot set` syntax on the box — `honeypot doctor` shows usage).
> Then confirm: `hive credentials list` should show all five as set (names only, no values).

- [ ] Present card A7; wait for "done".
- [ ] Lane verifies presence (not values): run `hive credentials list` — expect all five §9 keys marked set. (If the curated registry doesn't track TWILIO_* keys, verify via the Task 8 smoke test instead — a successful authenticated call proves all three API-auth keys resolve.)

### Task 8 — Auth smoke test (lane; first Track B API call)

- [ ] Run the account fetch — this simultaneously validates the whole §9 mechanism, A7 seeding, and the A2 upgrade:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT.json" \
  | jq '{friendly_name, status, type}'
```

- Expected: `status: "active"`, `type: "Full"`. (jq deliberately omits `sid` — the Account SID stays out of agent-session transcripts, consistent with card A1.)
- `type: "Trial"` → A2 incomplete; re-present card A2.
- 401/20003 → A7 mis-seeded (wrong value or key name); re-present card A7 for the failing key.
- [ ] Run the deliberate-failure drill (validates §0.3 interpretation; zero risk):

```bash
curl -sS -u "SKdeadbeefdeadbeefdeadbeefdeadbeef:bogus" \
  "https://api.twilio.com/2010-04-01/Accounts.json" | jq '{status, code, message}'
```

- Expected: `status: 401, code: 20003` — confirms the failure table's auth row reads as documented.
- [ ] Tick §10 item "Account upgraded (not trial); 2FA on; May is owner" — `type: Full` from API + May's A1/A2 attestations.

### Task 9 — B7: Elastic SIP trunk shell (lane; any time after A6+A7)

- [ ] Create the trunk:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://trunking.twilio.com/v1/Trunks" \
  --data-urlencode "FriendlyName=DodiHome ops trunk (KPR-321/KPR-322)" \
  --data-urlencode "DomainName=dodihome-ops.pstn.twilio.com" \
  | jq '{sid, friendly_name, domain_name, auth_type, secure}'
```

- Expected: `sid` starting `TK`, `domain_name: "dodihome-ops.pstn.twilio.com"`.
- Failure: 400 saying the domain is invalid/taken → domain must be globally unique, letters/digits/hyphens, ending `pstn.twilio.com`; retry once with `dodihome-ops1.pstn.twilio.com` and record which stuck.
- [ ] Find the credential-list SID May created at A6 (returns SIDs/usernames only — never passwords):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/SIP/CredentialLists.json" \
  | jq '.credential_lists[] | {sid, friendly_name}'
```

- Expected: one entry, `sid` starting `CL`, `friendly_name: "dodihome-ops-trunk-creds"`. Record `{CL_SID}`.
- Empty list → A6 step 2 wasn't completed; re-present that part of card A6.
- [ ] Attach the credential list to the trunk **by SID reference only** (the lane never sees the username/password):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://trunking.twilio.com/v1/Trunks/{TK_SID}/CredentialLists" \
  --data-urlencode "CredentialListSid={CL_SID}" \
  | jq '{sid, trunk_sid}'
```

- Expected: association echoes the CL sid + `trunk_sid`.
- [ ] Per-step verify (V1) — trunk + attachment in one invocation:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://trunking.twilio.com/v1/Trunks/{TK_SID}" \
  | jq '{sid, domain_name}'
curl -sS -u "$TW_KEY:$TW_SEC" "https://trunking.twilio.com/v1/Trunks/{TK_SID}/CredentialLists" \
  | jq '.credential_lists[] | {sid, friendly_name}'
```

  - Expected: trunk `domain_name` as created; `{CL_SID}` present in the credential-lists output. (This block is also the T22/V3 re-read for the trunk artifacts.)
- [ ] **DO-NOT list (KPR-322's surface — creating any of these here is scope breach):** do **not** create an origination URI; do **not** assign the phone number to the trunk (mutually exclusive with the B6 TwiML routing); do **not** enable secure trunking / TLS options.
- [ ] Record in §8 artifact table: trunk SID, termination (domain) URI, `{CL_SID}`.

### Task 10 — B2: Number search + shortlist (lane)

- [ ] Search voice-capable local numbers in `{AREA_CODE}` (§5.1 criteria: local not toll-free; SMS nice-to-have):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/AvailablePhoneNumbers/US/Local.json?AreaCode={AREA_CODE}&VoiceEnabled=true&PageSize=20" \
  | jq '.available_phone_numbers[] | {phone_number, friendly_name, locality, region, capabilities}'
```

- Expected: up to 20 candidates with `capabilities.voice: true`. Empty list → area code exhausted; widen with `InRegion={STATE}` instead of `AreaCode`, note the deviation for G2.
- [ ] Shortlist 2–3: prefer `capabilities.SMS: true` (nice-to-have), prefer locality matching DodiHome's locale, avoid vanity-looking repeats (no functional weight — just pickup-rate cosmetics).
- [ ] Pull current pricing for the G2 presentation (agent-accessible equivalent of "console figures"; sanity-check against console at G2 if May's already logged in):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://pricing.twilio.com/v1/PhoneNumbers/Countries/US" \
  | jq '.phone_number_prices[] | select(.number_type=="local")'
curl -sS -u "$TW_KEY:$TW_SEC" "https://pricing.twilio.com/v2/Voice/Countries/US" \
  | jq '{outbound_sample: .outbound_prefix_prices[0]}'
```

- Expected: local number `current_price` ≈ $1.15/mo class; outbound US voice ≈ $0.014/min class. (⚠ minor — Pricing API response field names re-confirmed by simply reading this call's real output; if the jq filter misses, print `keys` and adjust.)

### Task 11 — Gate G2: Number purchase (spend)

- [ ] Present the G2 check-in block:

> **G2 — Number purchase (first real spend)**
> **Shortlist** (voice-capable US local, area code `{AREA_CODE}` — your delegated default; confirm or redirect):
> 1. `+1 XXX XXX XXXX` — {locality}, {region} — voice ✓ / SMS {✓|✗}
> 2. `+1 XXX XXX XXXX` — …
> 3. `+1 XXX XXX XXXX` — …
> **Cost:** ${X.XX}/mo per number + ~${0.0XX}/min US outbound (Pricing API, {date}); plus incidental test-call + CNAM-lookup usage over this ticket's life — order of ~$1 total.
> **Also covered by this approval (§5.1):** if the number arrives spam-tainted on test calls, I release it and purchase a replacement **from this same shortlist within this same budget** without re-asking. Anything outside the shortlist/budget comes back as a fresh G2.
> **What I'm asking:** pick one (or rank them), and confirm the spend.
> **If no:** I re-propose once (different area code / different candidates / cost option); a second no parks the ticket (§12 / Appendix B).

- [ ] Record: G2 decision — chosen number, approved budget, spam-taint-replacement pre-authorization, date/words.

### Task 12 — B3: Purchase the number (lane)

- [ ] Purchase:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/IncomingPhoneNumbers.json" \
  --data-urlencode "PhoneNumber={NEW_NUMBER}" \
  --data-urlencode "FriendlyName=DodiHome purchasing-ops line (KPR-321)" \
  | jq '{sid, phone_number, friendly_name, status, capabilities}'
```

- Expected: `sid` starting `PN` (record as `{NEW_NUMBER_PN_SID}`), `phone_number` = chosen E.164, `capabilities.voice: true`.
- Failure: 400 `code 21422` (or "not available") → the number was taken between search and purchase; buy the next shortlist entry (covered by G2); if the whole shortlist is gone, re-run Task 10 and return to G2.
- [ ] Per-step verify (V1):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/IncomingPhoneNumbers/{NEW_NUMBER_PN_SID}.json" \
  | jq '{sid, phone_number, status, voice_url, voice_method}'
```

  - Expected: the number owned, `voice_url` empty for now (T18 sets it; this same block re-checks it there and at T22/V3).
- [ ] Record `{NEW_NUMBER}` + `{NEW_NUMBER_PN_SID}` in §8 artifact table.

### Task 13 — §5.1 post-purchase spam-taint check (lane + human observers)

- [ ] Place 2–3 test calls from the new number to team phones on different carriers (`{TEAM_PHONE_*}` — coordinate observers first so they're looking at the screen):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/Calls.json" \
  --data-urlencode "To={TEAM_PHONE_1}" \
  --data-urlencode "From={NEW_NUMBER}" \
  --data-urlencode "Twiml=<Response><Pause length='1'/><Say>DodiHome line test call. No action needed.</Say><Pause length='3'/></Response>" \
  | jq '{sid, status, from, to}'
```

- Expected: `sid` starting `CA`, `status: "queued"`; phone rings within seconds. Record each `CA` sid.
- [ ] Ask each observer: what did the incoming-call screen show? **Pass:** number displays with no "Spam Likely" / "Scam Likely" / "Telemarketer" label. (Pre-SHAKEN/STIR it may show as plain unverified number — that's expected and fine at this stage.)
- [ ] **If spam-labeled on any handset (recycled-number taint):** release and re-pick per §5.1 — do not remediate.
  - Release:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -o /dev/null -w '%{http_code}\n' -u "$TW_KEY:$TW_SEC" -X DELETE \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/IncomingPhoneNumbers/{NEW_NUMBER_PN_SID}.json"
```

  - Expected: `204` (no body).
  - ⚠ verify-at-execution: Twilio's number-release/refund window (spec §5.1 flags this as unverified) — check the console billing line or support docs at the moment of release; the monthly fee may not be refundable, which is a ≤$1.15 write-off, note it.
  - Replacement from the approved shortlist/budget → re-run Task 12/13 (no new gate). Outside shortlist/budget → fresh G2.
- [ ] Tick §10 item "Number purchased; voice-capable; criteria §5.1 met; not spam-tainted (test calls)".

### Task 14 — B4: SHAKEN/STIR trust product (lane; needs T7 approved + T13 passed — don't register trust products against a number the taint test may still release)

Doc-verified sequence (2026-07-13). Trust Hub URLs don't embed the Account SID, so these blocks resolve only the key pair — each block below is one self-contained invocation, paste-as-shown.

- [ ] 1. Assign the number to the Business Profile:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST \
  "https://trusthub.twilio.com/v1/CustomerProfiles/{BP_SID}/ChannelEndpointAssignments" \
  --data-urlencode "ChannelEndpointType=phone-number" \
  --data-urlencode "ChannelEndpointSid={NEW_NUMBER_PN_SID}" \
  | jq '{sid, channel_endpoint_sid}'
```

  - Expected: assignment `sid` starting `RA`, `channel_endpoint_sid` = the PN sid.
- [ ] 2. Create the SHAKEN/STIR trust product:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://trusthub.twilio.com/v1/TrustProducts" \
  --data-urlencode "FriendlyName=DodiHome SHAKEN-STIR (KPR-321)" \
  --data-urlencode "Email={AUTHORIZED_REP_EMAIL}" \
  --data-urlencode "PolicySid=RN7a97559effdf62d00f4298208492a5ea" \
  | jq '{sid, status, policy_sid}'
```

  - Expected: `sid` starting `BU` (record `{SS_TP_SID}`), `status: "draft"`.
  - `Email` = `{AUTHORIZED_REP_EMAIL}` — permitted for the lane to send: it is retained non-identity contact info under the Task 3 carve-out (a status-notification address, not a business identifier).
- [ ] 3. Connect it to the Business Profile:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST \
  "https://trusthub.twilio.com/v1/TrustProducts/{SS_TP_SID}/EntityAssignments" \
  --data-urlencode "ObjectSid={BP_SID}" \
  | jq '{sid, object_sid}'
```

  - Expected: assignment `sid` starting `BV`.
- [ ] 4. Assign the number to the trust product:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST \
  "https://trusthub.twilio.com/v1/TrustProducts/{SS_TP_SID}/ChannelEndpointAssignments" \
  --data-urlencode "ChannelEndpointType=phone-number" \
  --data-urlencode "ChannelEndpointSid={NEW_NUMBER_PN_SID}" \
  | jq '{sid, channel_endpoint_sid}'
```

- [ ] 5. Pre-submission evaluation (catches assembly errors before the 72h clock starts):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST \
  "https://trusthub.twilio.com/v1/TrustProducts/{SS_TP_SID}/Evaluations" \
  --data-urlencode "PolicySid=RN7a97559effdf62d00f4298208492a5ea" \
  | jq '{sid, status}'
```

  - Expected: `status: "compliant"`. `"noncompliant"` → inspect `.results` (drop the jq filter) — usually a missing assignment from steps 1/3/4; fix and re-evaluate. No identity data is involved, so this loop stays lane-side.
- [ ] 6. Submit for vetting:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST "https://trusthub.twilio.com/v1/TrustProducts/{SS_TP_SID}" \
  --data-urlencode "Status=pending-review" \
  | jq '{sid, status}'
```

  - Expected: `status: "pending-review"`. (No new gate — no identity entry, no spend; per spec B4 row.)
- [ ] 7. Poll (cadence: 12h, budget ≤72h):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://trusthub.twilio.com/v1/TrustProducts/{SS_TP_SID}" \
  | jq '{sid, status}'
```

  - Expected done: `status: "twilio-approved"`. `twilio-rejected` → read failure details + notification email (May's mailbox), fix assignment/profile mismatch, resubmit once; a second rejection → Twilio support ticket via May.

### Task 15 — B5: Prepare the CNAM submission (lane; needs T7 approved + T13 passed)

- [ ] Assemble the G3 pack:
  - Primary display name: `DodiHome` (8 chars, starts with letter, letters only — compliant with §0.5 rules; carriers often render uppercase `DODIHOME`).
  - Fallback variants (pre-checked against the same rules): `Dodi Home` (9 incl. space), `DodiHome Ops` (12).
  - Retry policy to restate at G3: one retry with a variant on rejection, then stop and re-consult (spec §5.2).
- [ ] Prepare the A5 field checklist: which Business Profile to select (the Task 7 approved one), which number to attach (`{NEW_NUMBER}`), display name string.
- [ ] Note for the card: CNAM registration is **free** (Twilio); approval budget ~2–5 business days (⚠ not precisely documented — spec §4), then 48–72h official propagation, 7–15 business days full-coverage in practice.

### Task 16 — Gate G3 + Card A5: CNAM display-name submission (May)

- [ ] Present the G3 check-in block:

> **G3 — CNAM display name (public business identity on every vendor's phone)**
> **Proposed:** `DodiHome` — what vendors' phones will display when this line calls.
> **Prepared fallbacks** (only used if Twilio rejects the primary; one retry, then I stop and come back): `Dodi Home`, `DodiHome Ops`.
> **Rules it must meet:** ≤15 chars, starts with a letter, letters/numbers/periods/commas/spaces, not a generic city/state.
> **Cost:** free. **Timeline after you submit:** ~2–5 business days approval, then 48h–15 business days to actually show on phones.
> **What I'm asking:** confirm the display name (or give me the one you want), and you'll enter it at the card that follows.
> **If no:** I re-propose once with different name options; a second no parks the ticket (§12 / Appendix B).

- [ ] On "go", present card A5:

> **Card A5 — Enter + submit the CNAM registration (~5–10 min)**
> 1. Console → **Trust Hub** → **Registrations** → **CNAM** tab → **Create registration**. ⚠ nav drifts (docs 2026-07-13; older consoles surface it under Trust Hub → Trust Products → CNAM).
> 2. Registration name: `dodihome-cnam (KPR-321)`. Compliance/Business Profile: select the approved DodiHome profile.
> 3. Display name: exactly `{CNAM_DISPLAY_NAME as approved at G3}`.
> 4. Attach phone number `{NEW_NUMBER}`.
> 5. Submit. Tell me "submitted" — I poll from here.
> **If Twilio rejects the name later:** I'll prompt you for exactly one resubmission with the pre-approved fallback variant; if that fails too, we regroup (no autonomous retries).

- [ ] Record: G3 approval (final string, date/words), A5 submitted (date).

### Task 17 — Poll CNAM approval (lane; wall-clock ~2–5 business days)

- [ ] Find and poll the CNAM trust product May created via console (identified by policy SID, read-only):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://trusthub.twilio.com/v1/TrustProducts" \
  | jq '.results[] | select(.policy_sid=="RNf3db3cd1fe25fcfd3c3ded065c8fea53") | {sid, friendly_name, status}'
```

- Expected while pending: `status: "pending-review"` / `"in-review"`. Record `{CNAM_TP_SID}`.
- Expected done: `status: "twilio-approved"` → propagation clock starts (Task 20).
- **Display-name rejection** (`twilio-rejected`): per §5.2 — present May the single-retry card (A5 with fallback variant #1). If the retry is also rejected: **stop**, re-consult at a G3 re-open with whatever Twilio's rejection reason says. Record both rejection reasons verbatim in ops notes.
- [ ] Poll cadence: daily. Past 5 business days → Twilio support ticket (May files from console, lane drafts the text: CNAM trust product SID, submission date, no status movement).

### Task 18 — B6: Interim inbound forwarding (lane; needs B3 + the A6-card TwiML bin)

- [ ] Point the number's voice config at the TwiML bin from card A6:

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -u "$TW_KEY:$TW_SEC" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/IncomingPhoneNumbers/{NEW_NUMBER_PN_SID}.json" \
  --data-urlencode "VoiceUrl={TWIML_BIN_URL}" \
  --data-urlencode "VoiceMethod=POST" \
  | jq '{sid, phone_number, voice_url, voice_method}'
```

- Expected: `voice_url` = the `https://handler.twilio.com/twiml/EH…` URL.
- **Alternative (only if the TwiML bin wasn't created at A6 and May isn't reachable):** re-run the block above with the two params swapped to `--data-urlencode "VoiceUrl=https://twimlets.com/forward?PhoneNumber=%2B1XXXXXXXXXX"` and `--data-urlencode "VoiceMethod=GET"`. ⚠ verify-at-execution: Twimlets is Twilio Labs (unsupported; no deprecation notice found as of 2026-07-13) — pre-check with an unauthenticated `curl -sS "https://twimlets.com/forward?PhoneNumber=%2B15555550100"` and confirm it returns `<Response><Dial>…` XML before pointing the live number at it. Prefer the bin; swap to it at the next May console session.
- [ ] **Live inbound verify (V2/§10):** call `{NEW_NUMBER}` from an outside phone → it must ring through to `{INBOUND_FORWARD_TARGET}` (Quo ops line), no dead air. Record who tested + result.
- Failure: dead air / error tone → re-run the Task 12 per-step verify block and check `voice_url`/`voice_method` against the bin URL; test the bin URL directly with `curl -sS -X POST {TWIML_BIN_URL}` (unauthenticated) — expect the `<Response><Dial>` XML back. Voicemail-only is the documented fallback if forwarding misbehaves persistently (§5.3) — that requires a May console edit of the bin content (new card, 2 min).
- [ ] Record the interim routing in ops notes (feeds the §8 "inbound path note" artifact and §3 interim-state map below).

### Task 19 — B8: Milestone — SHAKEN/STIR attestation A (lane + observer; needs T14 approved)

- [ ] Place a test call (same command as Task 13) from `{NEW_NUMBER}` to a team mobile on a major carrier (T-Mobile or AT&T display verification badges most consistently). Record the `CA` sid.
- [ ] Observer check: incoming-call screen shows a verified indicator ("Caller Verified" / check-mark, carrier-dependent). Wireless display is app-mediated — absence of a badge on one handset is not failure by itself; combine with the API check.
- [ ] API check (≥10 min after the call completes; summary `processing_state` may be `partial` up to ~30 min):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://insights.twilio.com/v1/Voice/{CA_SID}/Summary" \
  | jq '{processing_state, trust}'
```

- Expected: `trust.verified_caller.verified: true`.
- ⚠ verify-at-execution: the Insights `trust` object exposes a **boolean** verified flag (doc-verified); the **letter grade** (A vs B) is displayed in Console → Monitor → Calls → {call} → Insights, and in StatusCallback events (`StirStatus`, e.g. `TN-Validation-Passed-A`) which we have no webhook receiver for. If the boolean + handset badge disagree or May wants the letter confirmed explicitly: May opens that call's Insights page and reads the attestation line (30-second card), or run the zero-infra check below.
- **Optional zero-infra letter-grade check** (⚠ verify-at-execution — relies on TwiML-bin template interpolation and self-calls being permitted): temporarily point a **second** TwiML bin at the number containing `<Response><Say>Verstat {{StirVerstat}}</Say></Response>`, call the number **from itself** (`To={NEW_NUMBER}`, `From={NEW_NUMBER}`), and listen: `TN-Validation-Passed-A` spoken back = attestation A on the inbound leg of our own outbound call. Restore the forward bin immediately after.
- **If it signs B instead of A:** the number↔profile↔product assignment is wrong (spec §6.1) — re-run Task 14 steps 1/3/4 verification GETs (`GET https://trusthub.twilio.com/v1/TrustProducts/{SS_TP_SID}/ChannelEndpointAssignments` and `…/EntityAssignments`), fix the missing link, allow up to a day, retest. Do not proceed to CNAM verification effort until A confirms.
- [ ] Tick §10 item "SHAKEN/STIR product approved; test call signs attestation A".

### Task 20 — B9: Milestone — CNAM verification (lane + observers; needs T17 approved + propagation)

**Wall-clock honesty:** nothing here can be forced. Official propagation 48–72h post-approval; full carrier coverage up to 15 business days. Schedule: first check at +72h, then every 2–3 days.

- [ ] **Layer 1 — authoritative-database lookup** (~$0.01/lookup, covered by G2 incidental budget):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -u "$TW_KEY:$TW_SEC" "https://lookups.twilio.com/v2/PhoneNumbers/{NEW_NUMBER}?Fields=caller_name" \
  | jq '{phone_number, caller_name}'
```

- Expected once propagated: `caller_name.caller_name: "DODIHOME"` (case may be normalized upward), `caller_type: "BUSINESS"`, `error_code: null`.
- `caller_name: null` at +72h → normal lag, keep polling. Still null past ~7 business days → keep polling but pre-draft the support-ticket text.
- (Command-shape drill: this exact call was validated against the Quo line in V4-D3 — see §4.)
- [ ] **Layer 2 — live test-call matrix** (only after Layer 1 returns the name). Place calls (Task 13 command) to each row; observers report the displayed name:

| # | Destination class | Line | Displayed name | Pass? |
|---|---|---|---|---|
| 1 | **Landline or VoIP (vendor-realistic — the acceptance bar)** | {TEAM_PHONE_LANDLINE_OR_VOIP} | | required: `DodiHome`/`DODIHOME` |
| 2 | AT&T mobile | {TEAM_PHONE_ATT} | | informational |
| 3 | Verizon mobile | {TEAM_PHONE_VZW} | | informational |
| 4 | T-Mobile mobile | {TEAM_PHONE_TMO} | | informational |

- **Acceptance bar (spec §6.1):** the landline/VoIP class shows the name. Wireless rows are recorded but do **not** block — carrier apps mediate wireless display; KPR-325's pilot measures reality.
- [ ] Record the completed matrix in ops notes (it's a §10 close-out item).
- [ ] **Propagation-stuck path (§6.1):** if the landline/VoIP row still fails past 15 business days from CNAM approval: (1) Twilio support ticket (May files, lane drafts: CNAM TP SID, approval date, lookup output, matrix results); (2) weekly re-verify (Layer 1 + spot calls); (3) present May the ad-hoc check-in (G3-adjacent, not a fifth gate): **announce anyway** (number-only recognition — degraded-but-usable; the B10 message carries the number) **vs. hold** until CNAM resolves. Record her ruling; it directly gates Task 21 timing.
- [ ] Tick §10 item "CNAM product approved; lookup returns `{CNAM_DISPLAY_NAME}`; live test matrix recorded".

### Task 21 — B10 + Gate G4: Vendor announcement (lane drafts at execution; Nora + Sige send)

**Precondition:** B9 verified — or May's explicit early-pull/announce-anyway ruling (Task 20 stuck-path or §6.1 timing-pressure clause).

- [ ] Draft per-agent announcements **at execution** (content is deliberately not written in this plan — spec §6.2). Skeleton each draft must fill (the spec-defined content elements, nothing more):

> **[Draft skeleton — per agent, per language where applicable]**
> - New number: `{NEW_NUMBER}` and what it's for (purchasing/ops calls from DodiHome)
> - Existing Quo line unchanged for SMS
> - Who they'll be talking to (Nora — purchasing/ops; Sige — production support, Mandarin where appropriate)
> - Sent from the agent's **own identity** (Nora's address / Sige's address or Quo SMS) — no ghost-writing as May, no shared robot voice

- [ ] Assemble the recipient split: Nora → purchasing/ops vendors; Sige → production-support vendors (Mandarin versions where appropriate). Per-vendor channel (email vs. Quo SMS) is the agents' judgment within approved drafts.
- [ ] Present the G4 check-in block:

> **G4 — Vendor announcement (external comms)**
> **CNAM state:** [verified per matrix / May's early-pull ruling from {date}]
> **Drafts:** [full text of each draft, per agent, per language]
> **Recipients:** [vendor list per agent] **Channels:** [email from agent's own address / SMS via Quo]
> **What I'm asking:** approve the drafts + recipient split for sending by Nora and Sige from their own identities.
> **If no:** I revise once per your notes; a second no on the same decision parks the ticket (§12 / Appendix B).

- [ ] On approval: hand the approved drafts to Nora and Sige (team MCP direct message at execution), each sends from her own identity. Lane confirms sends happened (agents report back; spot-check one sent email/SMS).
- [ ] Record: G4 approval, send date(s), per-agent recipient counts (no vendor PII into the repo).
- [ ] Tick §10 item "Vendor announcements sent (Nora + Sige, own identities, G4-approved)".

### Task 22 — B11: Close-out — handoff artifacts + verification checklist (lane)

- [ ] Fill the §8 artifact table in ops notes (values; secrets referenced by Honeypot key name only):

| Artifact | Value/location | Re-read check (V3) |
|---|---|---|
| Twilio Account SID | Honeypot `hive/dodi/TWILIO_ACCOUNT_SID` | Task 8 GET succeeds |
| API key pair | Honeypot `…API_KEY_SID` / `…API_KEY_SECRET` | any authenticated call succeeds |
| Phone number (E.164) + PN SID | ops notes | `GET …/IncomingPhoneNumbers/{PN}.json` |
| Trunk SID + termination URI | ops notes (`TK…`, `….pstn.twilio.com`) | `GET https://trunking.twilio.com/v1/Trunks/{TK_SID}` → `jq '{sid, domain_name}'` |
| Credential-list username + password | Honeypot `…SIP_TRUNK_USERNAME`/`…SIP_TRUNK_PASSWORD`; attached to trunk by `{CL_SID}` | `GET …/Trunks/{TK_SID}/CredentialLists` lists `{CL_SID}` |
| Inbound path note | number → TwiML bin forward → `{INBOUND_FORWARD_TARGET}`; **KPR-322 replaces this** (number→trunk + origination URI `sip:<livekit>.sip.livekit.cloud;transport=tcp` — cannot exist until 322 stands the endpoint up) | `GET …/IncomingPhoneNumbers/{PN}.json` → `voice_url` = bin URL |

- [ ] Run every V3 re-read command above in one pass; paste the (non-secret) outputs into ops notes as evidence.
- [ ] Walk the §10 close-out checklist; every box must have evidence attached (task references above):
  - [ ] Account upgraded (not trial); 2FA on; May is owner (T8 + May attestation)
  - [ ] Business Profile status = Twilio-Approved (T7)
  - [ ] Number purchased; voice-capable; §5.1 criteria met; not spam-tainted (T12/T13)
  - [ ] SHAKEN/STIR approved; test call signs attestation A (T14/T19)
  - [ ] CNAM approved; lookup returns the display name; live matrix recorded (T17/T20)
  - [ ] Inbound test: outside call reaches `{INBOUND_FORWARD_TARGET}` (T18)
  - [ ] Trunk shell + credential list exist; §8 table filled (T9/this task)
  - [ ] Honeypot keys seeded — `hive credentials list` shows all §9 keys (T5b)
  - [ ] Vendor announcements sent (T21)
  - [ ] Fallback doc (§7) acknowledged by May — present her the one-paragraph summary: *Verified Caller ID can present the Quo number if KPR-325 pickup rates disappoint; caps at B attestation, voice-only, CNAM not ours to set via Twilio; flip decision is a May/ops check-in.* Record her ack.
- [ ] Record the interim-state map (§3 below) status as the final state handed to KPR-322; note explicitly in the KPR-322-facing artifact note that **the TwiML forward stays live** — B11 does not remove it.
- [ ] Purge any A3 **identity** values still sitting in lane-side notes — legal name, EIN, address, rep name/title (they were G1-prep-scoped; Twilio is now the system of record). **Exemption:** `{AUTHORIZED_REP_EMAIL}` is retained ops contact info under the Task 3 carve-out (it is live on the T14 trust product as the notification address), not an identity value — keep it with the ops notes.

---

## 3. Interim-state map (§5.3)

State of the world **between B6 going live and KPR-322 shipping** — expected to persist for weeks; it is a designed state, not drift:

| Surface | Interim state (while CNAM propagates / until 322) | Flipped by |
|---|---|---|
| Inbound calls to `{NEW_NUMBER}` | Programmable Voice → TwiML bin `<Dial>` forward → `{INBOUND_FORWARD_TARGET}` (Quo ops line). Voicemail-only bin is the degraded fallback. | **KPR-322** (assigns number to trunk + origination URI; mutually exclusive with TwiML routing) |
| Outbound calls from `{NEW_NUMBER}` | None in steady state (test calls only). Personas/pilot calls are KPR-325, after 322. | KPR-322/KPR-325 |
| CNAM display | Approved → propagating; lookup may show the name before handsets do; wireless may lag landline/VoIP indefinitely | Carrier propagation (wall clock); verified at B9 |
| SIP trunk | Shell only: termination URI + credential list attached; **no origination URI, no number attached, no TLS/SRTP config** | KPR-322 |
| Vendor awareness | Unannounced until B9 verifies (or May's explicit early pull at G4) | B10 |
| **What B11 close-out flips** | Ticket → done: §10 checklist evidenced, §8 artifacts recorded + re-read, May's §7 fallback ack captured. **B11 does *not* flip the TwiML forward** — that stays live as the recorded inbound path until KPR-322 replaces it. | — |

---

## 4. Verification contract (Testing Contract, ops-adapted)

### Group V1 — per-step API verification (every Twilio resource confirmed by follow-up GET)

Each mutating step's task embeds its GET; consolidated:

| Resource | GET | Expected |
|---|---|---|
| Account | `…/2010-04-01/Accounts/$TW_ACCT.json` | `status: active`, `type: Full` (T8) |
| Business Profile | `https://trusthub.twilio.com/v1/CustomerProfiles` | `status: twilio-approved` (T7) |
| Number | `…/IncomingPhoneNumbers/{PN}.json` | owned; `capabilities.voice: true`; after T18 `voice_url` = bin URL |
| SHAKEN/STIR TP + assignments | `…/v1/TrustProducts/{SS_TP_SID}` (+ `/EntityAssignments`, `/ChannelEndpointAssignments`) | `status: twilio-approved`; both assignments present (T14) |
| CNAM TP | `…/v1/TrustProducts` filtered on `policy_sid RNf3db…` | `status: twilio-approved` (T17) |
| Trunk + credential attach | `https://trunking.twilio.com/v1/Trunks/{TK_SID}` + `/CredentialLists` | domain correct; `{CL_SID}` attached (T9) |
| Honeypot keys | `hive credentials list` | all five §9 keys set, values never displayed (T5b) |

### Group V2 — milestone verification

1. **Attestation A** (T19): API-placed test call → observer badge + Insights `trust.verified_caller.verified: true`; letter-grade arbiter = console Call Insights (May) or the ⚠-flagged StirVerstat self-call drill. B-not-A → assignment-repair loop in T19.
2. **CNAM** (T20): Lookup v2 `caller_name` = display name, then the live matrix with the **landline/VoIP acceptance bar** (wireless informational). Both recorded in ops notes.
3. **Inbound forwarding** (T18): real outside call reaches the Quo ops line — no dead air.

### Group V3 — handoff verification (T22)

§8 artifact table filled **and** every artifact re-read from the live API in one evidence pass (commands in T22's table). A KPR-322 session starting cold must be able to reconstruct: auth (Honeypot), number, trunk SID + termination URI, credential-list SID (+ its Honeypot-held values), and the inbound-path note including what it must replace.

### Group V4 — failure-path drills (pre-verifiable subset)

- [ ] **D1 — auth-failure shape** (T8): bogus-key call → `401 / code 20003`. Validates the §0.3 table. Zero risk.
- [ ] **D2 — gate templates render**: fill each G1–G4 block with dummy values, self-review that every "What I'm asking / If no" line survives templating. Zero risk, no send.
- [ ] **D3 — lookup command shape** (after G2, pennies of spend): run the T20 Layer-1 lookup against the **existing Quo line** — validates endpoint/params/jq long before B9 relies on them; also incidentally documents the Quo line's current CNAM (useful for §7 fallback context).
- [ ] **D4 — twimlet pre-check** (only if the T18 alternative is ever used): unauthenticated curl returns `<Response><Dial>` XML.

**Cannot be pre-verified (honestly):**

| Path | Why not |
|---|---|
| Teardown (Appendix A) | Destructive — releasing the number/deleting the trunk is the real thing; drill = read-only inventory commands only |
| CNAM display-name rejection retry (§5.2) | Requires an actual Twilio rejection; can't be induced safely |
| Propagation-stuck path (§6.1) | Wall-clock-gated by definition (15 business days) |
| Spam-taint release/re-pick (§5.1) | Requires purchasing a tainted number; the release command itself is exercised only if triggered |
| Gate-decline → park (Appendix B) | Requires a real May "no"; template is drilled (D2), the parking isn't |
| A-attestation before approval | Vetting-gated; nothing to test until `twilio-approved` |

**May-gated or wall-clock-gated checks (not lane-executable on demand):** all Track A card completions; T7/T14/T17 vetting waits; T20 propagation; badge/display observations (human observers); console Call Insights letter-grade read; §7 fallback acknowledgment.

---

## 5. Scope guards

- **No LiveKit wiring** — origination URI, number→trunk assignment, TLS/SRTP, worker config are KPR-322 (T9's DO-NOT list).
- **No engine/config code changes** — `telephony.twilio.number` / `telephony.twilio.trunkDomain` are name reservations only (§9); nothing lands in `src/config.ts`, no channel adapter, no MCP server.
- **No announcement copy in this plan** — B10 drafts happen at execution under G4 (skeleton in T21 lists only the spec-defined content elements).
- **No porting the Quo number, no A2P/SMS registration, no Voice Integrity purchase** (§3) — Voice Integrity is a documented escalation lever only.
- **No secret ever enters an agent session** — creation (A6) and seeding (A7) are May's; Track B touches secrets only as Keychain lookups inside single invocations (§0.2) and credential-list **SID** references (T9).

---

## Appendix A — Teardown (§12; OFF the happy path — runs only on an explicit park/abandon decision, never inferred)

Symmetry rule: Track B tears down what Track B built (API); May tears down what only she can touch (account status, Honeypot, dormancy). Nothing is automatic.

- [ ] **Inventory first** (read-only, safe any time): run the V1 GET set (§4) to establish what actually exists before deleting anything; record it.
- [ ] **Release the number** (lane, if B3 ran) — unless May chooses to keep it dormant deliberately (~$1.15/mo carrying cost; her call — ask before releasing):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -o /dev/null -w '%{http_code}\n' -u "$TW_KEY:$TW_SEC" -X DELETE \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/IncomingPhoneNumbers/{NEW_NUMBER_PN_SID}.json"
```

  Expected: `204`. Verify: the V1 number GET now returns 404.
- [ ] **Delete the trunk** (lane, if B7 ran):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
curl -sS -o /dev/null -w '%{http_code}\n' -u "$TW_KEY:$TW_SEC" -X DELETE \
  "https://trunking.twilio.com/v1/Trunks/{TK_SID}"
```

  Expected: `204`.
- [ ] **Delete the credential list** (lane, if A6 ran — it exists from A6 whether or not B7 attached it; delete the trunk first so no association remains):

```bash
TW_KEY="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SID -w)"
TW_SEC="$(security find-generic-password -s hive/dodi/TWILIO_API_KEY_SECRET -w)"
TW_ACCT="$(security find-generic-password -s hive/dodi/TWILIO_ACCOUNT_SID -w)"
curl -sS -o /dev/null -w '%{http_code}\n' -u "$TW_KEY:$TW_SEC" -X DELETE \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_ACCT/SIP/CredentialLists/{CL_SID}.json"
```

  Expected: `204`.
- [ ] **Remove Honeypot keys** (May, if A7 ran): `hive credentials remove <KEY>` for each of the five §9 keys; confirm with `hive credentials list`. (Do this **after** the lane's API deletions above — the lane needs auth to tear down.)
- [ ] **Account disposition** (May): downgrade / leave dormant / close — explicitly her call at the point of abandonment, not automatic. Card offered, not pushed.
- [ ] **Vendor retraction — ONLY if abandonment happens after B10** (announcement already sent): Nora + Sige send a correction note from their own identities, with a G4-equivalent May/ops review of the draft before sending (§6.2 rules apply unchanged).
- [ ] Record in ops notes: what was torn down, what was deliberately kept, date, and the triggering decision (who/when).

## Appendix B — Gate-decline procedure (§12; applies to G1–G4 and the G3-adjacent propagation check-in)

1. May says "no" at a gate → **one** re-proposal, shaped by her stated reason: different CNAM variant (G3), different number/area code or cost option (G2), corrected field set (G1), revised drafts/recipients/timing (G4). Present the re-proposal through the same gate template.
2. Second "no" on the **same decision** → **park operator-held**. No autonomous retries, no creative third options.
3. Parked-state record (write to ops notes + Linear at execution):

> **PARKED (operator-held)** — KPR-321
> Gate: {G1|G2|G3|G4} · Date: {date}
> Declined: {exactly what was proposed}
> Reason given: {May's words}
> Re-proposal offered: {what alternative} → also declined
> State at park: {which A/B steps complete; live resources per V1 inventory; any wall-clocks running}
> Teardown: {not triggered | triggered → Appendix A record}
> Resume: May's call only.

4. Parking does **not** itself trigger teardown — Appendix A runs only if May additionally decides to abandon.

---

## ⚠ verify-at-execution registry (consolidated)

| # | Claim to re-verify live | Where used |
|---|---|---|
| 1 | Console navigation paths (Trust Hub profile/CNAM registration, API keys, credential lists, TwiML bins) — drift-prone | Cards A1/A4/A5/A6 |
| 2 | Business Profile console form's exact field list (checklist finalized against the live form) | T5/T6 |
| 3 | `hive credentials add` accepts TWILIO_* keys (else `honeypot set` fallback + its exact syntax) | T5b |
| 4 | Number release/refund window (spec-flagged unverified) | T13, Appendix A |
| 5 | Pricing API response field names (read real output; adjust jq) | T10 |
| 6 | CNAM approval SLA (~2–5 business days is a budget, not a doc-backed figure) | T17 |
| 7 | Insights `trust` object as outbound letter-grade source (boolean doc-verified; A/B letter arbiter = console Insights or StirVerstat drill) | T19 |
| 8 | StirVerstat TwiML-template self-call drill (optional path only) | T19 |
| 9 | Twimlets availability (only if the T18 alternative is used) | T18 |

Everything else API-shaped in this plan (endpoints, methods, param names, policy SIDs, response fields cited) was verified against twilio.com documentation on 2026-07-13.
