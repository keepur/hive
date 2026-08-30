# KPR-325 — W5.5: Call personas + vendor pilot

**Epic:** KPR-320 (W5: Voice v2 — outbound vendor pilot). **Consumes:** the shipped KPR-322 LiveKit worker/bridge + `voice_call` (E4) tool, KPR-323 warm lease, KPR-324 tool-ack masking. **Depends on:** KPR-321 (Twilio line + CNAM) for the real vendor-facing phase — **not** for Phase 0 (§4). **Blocks:** nothing downstream in this epic; this is the last child.

**Anchor:** epic branch `kpr-320` @ `1412e8a` (KPR-324 merge, PR #438). Design against the shipped 322/323/324 code, not against unmerged wishes.

**Ticket shape:** this ticket is being delivered in two phases, decided live with May (2026-08-30) rather than up front:

- **Phase 0 (this spec designs in full):** an internal dry run — May, in Slack, tells Mokie to call her cell; she judges naturalness, latency, and "smart-soundingness" herself. Purpose: prove the end-to-end plumbing works and establish what an agent's voice actually sounds like, before spending any effort on a formal vendor-facing rubric.
- **Phase 1 (deliberately NOT designed here):** the originally-scoped Nora/Sige vendor pilot with a reception rubric and pickup-rate go/no-go thresholds. Every sibling spec (321–324) already reserves this scope for 325 (kpr-321-spec.md:24, kpr-322-spec.md:326,331, kpr-323-spec.md:221, kpr-324-spec.md:406) — this document does not resolve it. Phase 1 gets designed after Phase 0's findings (and after KPR-321's CNAM propagates) tell us what's actually worth measuring.

## TL;DR

Before running a single real vendor call, May wants to hear Mokie place a real outbound call to her own cell phone — initiated by asking Mokie in Slack — and judge the voice herself. Two small, self-contained code changes make that possible: (1) register the already-working `voice-livekit` MCP server in the server catalog so it's documented and correctly classified rather than invisible, and (2) thread a per-agent Cartesia voice ID through the TTS layer, which today hardcodes one stock voice for every call regardless of who's speaking. Nothing in this phase touches Nora, Sige, CNAM, or a rubric. Nothing here gets tested live until this PR clears Gate 2, merges, and `hive update` deploys it — actually wiring Mokie's live agent definition (coreServers + her voice ID) is a post-deploy admin action, not part of this PR.

## Key Points

- **The call-placing mechanism already works and is already assignable — it's just undocumented and unclassified.** `voice-livekit` (`src/voice/livekit-voice-mcp-server.ts`) is already spawned correctly by `AgentRunner` whenever `config.voice.livekit.enabled` + the LiveKit API pair are set (`src/agents/agent-runner.ts:662-680`), and `coreServers` itself is an unvalidated string array — an operator could already list `"voice-livekit"` there today and it would spawn. The real gap is that `SERVER_CATALOG` (`src/tools/server-catalog.ts`) has no `voice-livekit` entry: an assigned-but-uncataloged server doesn't disappear from the "Your toolkit" prompt section (KPR-87) — it falls back to a degenerate `serverName`-as-description line (`resolveCatalogEntry`, `src/agents/toolkit-section.ts:81-93`) instead of the real description — and `buildInstanceCapabilities` has no credential check for it (§4.1), so instance-capabilities tooling can't correctly classify whether it's actually usable on a given instance.
- **Voice today is global, not per-agent.** `buildTts(cell, wc)` (`src/voice-worker/session.ts:66-69`) always constructs Cartesia/ElevenLabs with just `model` + `apiKey` — no `voice` id. The Cartesia plugin's `TTSOptions` already has a `voice: string | number[]` field (`node_modules/@livekit/agents-plugin-cartesia/dist/tts.d.ts`); it's simply never populated. At the one call site (`session.ts:160`), the resolved `hiveAgentId` (`session.ts:134,145`) is already in scope — this is a small threading change, not new architecture.
- **Voice ID picked: Daniel, Cartesia's own catalog voice `47c38ca4-5f35-497b-b1a3-415245fb35e1`** (verified against Cartesia's docs, cross-checked by May against the actual voice-library entry she previewed — "Daniel, Modern Assistant"). This is Mokie's Phase-0 voice. It is **not** committed anywhere in this repo — it's dodi-instance config (§4.2), same as every other business-specific value.
- **CNAM/Twilio account status does not gate Phase 0.** CNAM only affects the caller-ID name a *receiving* carrier displays — it has no bearing on whether a call can be placed at all. Phase 0 only needs a working number + SIP trunk (KPR-321's Track A A6/A7 — the API key pair and SIP credential list, which are independent of Trust Hub business-profile vetting) plus KPR-322's trunk wiring. May seeing "unknown number" on her own phone during a dry run with herself is a non-issue.
- **Nothing here is live until it ships the normal way.** This spec's two changes land in this PR → epic PR → Gate 2 human review → merge → `hive update` on the dodi instance. Flipping Mokie's live `coreServers` to include `voice-livekit`, and setting her `agentVoices` entry to Daniel's id, happens *after* deploy, via admin MCP / beekeeper — not as part of this code change, and not simulable from this dev worktree (confirmed: no local `~/services/hive/*` deploy dir on this machine, no reachable dodi `agent_definitions` from this repo's local Mongo).
- **In scope (Phase 0):** `voice-livekit` catalog + credential-check entries; `agentVoices` config threading (hive.yaml → `config.ts` → `WorkerConfig` → `buildTts`); unit test coverage for both. **Out of scope:** anything Nora/Sige-specific, the reception rubric, pickup-rate thresholds, AMD policy, CNAM/Twilio ops (KPR-321's job), ElevenLabs voice-id threading (only Cartesia is in play for Phase 0 — §4.1 notes the extension point but does not build it), and any change to the `voice` (Vapi) server or its config.
- ⚠ **The actual `agentVoices.mokie` value and Mokie's `coreServers` addition are runtime/admin inputs, not code** — placeholders only; not committed to this repo.

## 1. Problem / Context

KPR-320 pivots Nora and Sige to real outbound vendor calls. Before pointing that capability at a vendor, at a customer, or even at a formal rubric, May wants to personally hear it: ask Mokie in Slack to call her cell, pick up, and judge for herself whether it sounds natural, responds quickly, and sounds "smart" — the same bar any human would apply before trusting an assistant to represent them on the phone. That's a reasonable gate, and it's cheap to clear: KPR-322/323/324 already built the mechanism (LiveKit worker, warm execution path, tool-ack latency masking); what's missing is (a) making the call-placing tool visible and correctly classified — it's already assignable today, just undocumented and unclassified (§4.1) — and (b) giving that agent a voice that isn't the stock default every other call would also use.

The original KPR-325 scope (Nora/Sige, real vendors, reception rubric, pickup-rate go/no-go) is unchanged as the eventual destination — it's just no longer the first thing built. Phase 0 is a prerequisite dry run, decided live with May on 2026-08-30, not a replacement.

## 2. Goals — Phase 0 done criteria

1. `voice-livekit` has a `SERVER_CATALOG` entry (§4.1) so it's visible, documented, and correctly classified — same as every other MCP server in the catalog. (It is already assignable today via `coreServers`; this goal is about visibility and classification, not assignability.)
2. `SERVER_CREDENTIAL_CHECKS` gets a matching `voice-livekit` entry that mirrors `agent-runner.ts`'s actual gate condition, so `buildInstanceCapabilities` doesn't report it "configured" on an instance where it can't actually spawn (per the standing warning at `server-catalog.ts:21-28`).
3. An agent can be given a specific Cartesia voice via config (`voice.livekit.agentVoices` in hive.yaml), threaded through to the call session, with a clean fallback to Cartesia's own default when unset.
4. Unit tests cover both changes. No live call is placed as part of this ticket's delivery — that happens post-deploy, operationally.

## 3. Non-Goals

- No change to Nora's or Sige's agent definitions, or to any live instance's `coreServers` / `hive.yaml` — those are post-deploy admin actions (§"Handoff", below).
- No reception rubric, pickup-rate metric, or go/no-go threshold — Phase 1, undesigned here.
- No AMD (answering-machine detection) policy — still an open item from KPR-322 (kpr-322-spec.md:331), irrelevant to a call May personally answers.
- No ElevenLabs per-agent voice support — Cartesia only, per May's pick. The extension point is noted (§4.1) but not built; adding it later is a one-line mirror of the Cartesia branch if/when needed.
- No Twilio/CNAM work — that's KPR-321, already in flight independently (business profile submission in progress as of 2026-08-30).
- No changes to the `voice` (Vapi) server, its catalog entry, or its config — untouched.

## 4. Design

### 4.1 `voice-livekit` server catalog entry

Add to `SERVER_CATALOG` (`src/tools/server-catalog.ts`), alongside the existing `voice` (Vapi) entry:

```ts
"voice-livekit": {
  description: "Make outbound phone calls via the LiveKit voice pipeline",
  usage: "Calling someone by phone when a live voice conversation is what's needed",
  notFor: "Vapi-based calling — use voice instead; that server key is separate and unrelated",
},
```

Add to `SERVER_CREDENTIAL_CHECKS` (`src/tools/instance-capabilities.ts`), mirroring the exact gate `agent-runner.ts:662-666` uses to decide whether it actually spawns the server:

```ts
"voice-livekit": () =>
  !!(config.voice.livekit?.enabled && config.voice.livekitApiKey && config.voice.livekitApiSecret && config.voice.livekit?.url),
```

No change to `agent-runner.ts` itself — the candidate server config it builds (`agent-runner.ts:659-680`) is already correct and gated only on `hive.yaml`, unconditional on `coreServers` membership; actual inclusion for a given agent is decided downstream by `filterCoreServers` against that agent's `coreServers` list, same as every other server. The catalog entry only affects the toolkit-prompt description and the instance-capabilities "configured" classification, not spawnability. `voice-livekit` is a stdio server (the MCP server itself uses `StdioServerTransport`, not an in-process SDK server), so none of the KPR-184 `delegateServers` in-process constraints apply to it.

### 4.2 Per-agent Cartesia voice ID

New optional field on the existing liberal-loader config (`src/config.ts:216-246`, `VoiceLivekitConfig`):

```ts
export interface VoiceLivekitConfig {
  // ...existing fields...
  /** Cartesia voice id per hive agent id (S7-adjacent; Cartesia only, Phase-0 scope). */
  agentVoices: Record<string, string>;
}
```

Parsed in `resolveVoiceLivekitConfig` exactly like the existing `inboundAgents` map (`config.ts:232-237`) — non-object input → `{}`, non-string values dropped, **values trimmed, keys used as-is** (matching `inboundAgents`'s actual behavior precisely: only `agent.trim()` is called, never the key). hive.yaml shape:

```yaml
voice:
  livekit:
    agentVoices:
      mokie: "47c38ca4-5f35-497b-b1a3-415245fb35e1"
```

Threaded into `WorkerConfig` (`src/voice-worker/worker-config.ts:12-27,41-56`) as `agentVoices: lk.agentVoices`, same pattern as `inboundAgents`.

`buildTts` (`src/voice-worker/session.ts:66-69`) gains an explicit `agentId` parameter:

```ts
export function buildTts(cell: VendorCell, wc: WorkerConfig, agentId: string) {
  const voiceId = wc.agentVoices[agentId];
  return cell.tts === "cartesia/sonic-3"
    ? new cartesia.TTS({ model: "sonic-3", apiKey: wc.cartesiaApiKey, ...(voiceId ? { voice: voiceId } : {}) })
    : new elevenlabs.TTS({ model: "eleven_flash_v2_5", apiKey: wc.elevenlabsApiKey });
}
```

Call site (`session.ts:160`) becomes `tts: buildTts(cell, wc, hiveAgentId)` — `hiveAgentId` is already resolved above it (`session.ts:134,145`) for both the outbound and inbound branches, so no new plumbing is needed to get the agent id to this point. The ElevenLabs branch is deliberately left untouched (no `voice` option threaded) — out of scope per §3; a future ticket mirrors this same shape for it if/when an agent's Phase-0 pick is ElevenLabs instead of Cartesia.

⚠ `wc.agentVoices[agentId]` is a plain-object indexed lookup on an externally-influenced key (`meta.hive_agent_id`) — same unguarded shape as the existing `inboundAgents` lookup it mirrors, so this matches precedent rather than introducing a new pattern. A `typeof voiceId === "string"` check costs nothing if the plan wants to close it anyway; not required to match `inboundAgents`'s existing behavior.

### 4.3 What does NOT change

- `agent-runner.ts`'s server-spawn block (§4.1) — already correct.
- Any actual `hive.yaml` on any instance, any agent's `coreServers`, any agent's `agentVoices` entry — all instance/operator config, set post-deploy (§"Handoff").
- `voice_call`'s tool schema, `livekit-dispatch.ts`, or anything else in the already-shipped KPR-322 call-placing path.

## 5. Testing

- `src/config.test.ts` — extend `resolveVoiceLivekitConfig` coverage: `agentVoices` defaults to `{}`; non-object input ignored; non-string values dropped; valid entries pass through with values trimmed and keys unchanged (mirror the existing `inboundAgents` test cases exactly, including the no-key-trimming behavior).
- `src/voice-worker/session.test.ts` — **add** `buildTts` coverage (no existing tests cover this function today — the file currently covers `resolveInboundAgent`, failure actions, stats, and shutdown only). `vi.mock` the `@livekit/agents-plugin-cartesia` module to capture constructor options: with a matching `agentVoices` entry, assert the captured options include `voice: <id>`; with no entry (or an ElevenLabs cell), assert behavior is byte-identical to today (no `voice` key passed / ElevenLabs branch unchanged).
- `src/tools/instance-capabilities.test.ts` — the existing `SERVER_CREDENTIAL_CHECKS invariant` test (`instance-capabilities.test.ts:107-133`) only checks a hardcoded list of server names against `SERVER_CATALOG` keys; it does not introspect `SERVER_CREDENTIAL_CHECKS` itself (unexported) and will pass regardless of whether the new credential check is added correctly, added wrong, or omitted. Two additions needed: (a) add `"voice-livekit"` to that test's hardcoded `credentialCheckServers` list, so a future catalog-key rename/removal still catches drift; (b) add a dedicated `buildInstanceCapabilities` test case — under a mocked `config.voice.livekit` (enabled + full API pair vs. missing/partial) — asserting `voice-livekit` lands in `configured` vs. `unconfigured` correctly. This is the actual coverage for done-criterion §2.2; (a) alone does not exercise it.
- `src/tools/server-catalog.test.ts`'s generic "every entry has a non-empty description" test covers the new `voice-livekit` entry automatically — no test change needed there.
- No live-call T-gate in this ticket. The actual "does it sound right" verification is May's own ear, post-deploy, out of band from CI.

## 6. Handoff — what happens after this merges and deploys (not part of this PR)

1. `hive update` on the dodi instance picks up the code change.
2. Operator (May, via beekeeper/admin MCP) adds `voice-livekit` to Mokie's live `coreServers`.
3. Operator sets `voice.livekit.agentVoices.mokie: "47c38ca4-5f35-497b-b1a3-415245fb35e1"` in dodi's `hive.yaml` (gitignored, instance-local). This is voice-worker config, not an agent definition — SIGUSR1 only reloads agent definitions from MongoDB and does **not** pick this up; the voice-worker process itself needs a restart to reread `hive.yaml`.
4. Operator confirms KPR-321's Track A A6/A7 (Twilio API key pair + SIP credential list) exist and are seeded in dodi's Honeypot, and that KPR-322's trunk wiring is actually deployed and pointed at a real number — none of this is Phase-0 code, all of it is prerequisite infrastructure this ticket assumes is separately in place before the dry run is attempted.
5. May, in Slack: "Mokie, call me at my cell." Mokie already has May's number in memory/contacts — no number needs to be supplied. She judges naturalness, latency, and how "smart" it sounds.
6. Findings from step 5 (and CNAM's eventual propagation on KPR-321) shape Phase 1's actual design — not written here.
