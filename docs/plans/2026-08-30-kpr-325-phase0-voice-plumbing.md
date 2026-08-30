# KPR-325 Phase 0 — Voice Plumbing Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Make the already-working LiveKit outbound-call tool documented and correctly classified, and give agents a per-agent Cartesia voice, so a real dry-run call (Mokie calling May) can be wired up post-deploy without any further code changes.

**Architecture:** Two independent, additive changes. (1) `voice-livekit` gets a `SERVER_CATALOG` entry (prompt visibility) and a `SERVER_CREDENTIAL_CHECKS` entry (accurate configured/unconfigured classification) — no change to the already-correct spawn wiring in `agent-runner.ts`. (2) A new `agentVoices: Record<string, string>` config map flows `hive.yaml` → `config.ts` → `WorkerConfig` → `buildTts()`, mirroring the existing `inboundAgents` map end to end, so the Cartesia TTS client receives a specific voice id per calling agent when one is configured, falling back to today's behavior otherwise.

**Tech Stack:** TypeScript, Vitest, `@livekit/agents-plugin-cartesia`.

**Spec:** [docs/epics/kpr-320/kpr-325-spec.md](../epics/kpr-320/kpr-325-spec.md)

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `resolveVoiceLivekitConfig` (config.ts), `loadWorkerConfig`/`WorkerConfig` shape (worker-config.ts), `buildTts` (session.ts), `SERVER_CATALOG`/`SERVER_CREDENTIAL_CHECKS` entries + `buildInstanceCapabilities` classification (server-catalog.ts / instance-capabilities.ts)
  - Reason: every touched function is pure/mockable config-and-construction logic with existing unit coverage patterns in the same files; this is exactly the kind of change unit tests are for
  - Minimum assertions: see Task 1 Step 4 and Task 2 Steps 8–9 below — non-goal is any assertion beyond what's listed there (YAGNI)

- Integration: `not-required`
  - Scope: n/a
  - Reason: no new integration surface is introduced — no new MCP server, no new network call shape. The one place these changes reach a live system (`runCallSession` actually placing a call with a real `WorkerConfig`) is exactly the kind of flow this epic's own Decision Register (KPR-320 D3) already treats as "designed-but-not-run," requiring a recorded per-run operator go, not CI coverage. `voice_call`'s dispatch mechanics are unchanged by this ticket.
  - Harness: not-applicable
  - Minimum assertions: n/a

- E2E: `not-required`
  - Scope: n/a
  - Reason: a live PSTN call cannot run in CI. Verification is May's own ear on a real call, post-deploy, per the spec's Handoff section — the same posture KPR-322/323/324 used for live-call verification.
  - Harness: not-applicable
  - Minimum assertions: n/a

### Critical Flows

- `hive.yaml` `voice.livekit.agentVoices.<agentId>` → `VoiceLivekitConfig.agentVoices` → `WorkerConfig.agentVoices` → `buildTts()`'s Cartesia `voice` option, for an agent that has an entry.
- Same flow with no entry for an agent (or a non-Cartesia cell) → behavior byte-identical to pre-change (no `voice` key passed to Cartesia; ElevenLabs branch untouched).
- `voice-livekit` catalog + credential-check classification: fully configured (`enabled` + full API pair) → `configured`; missing/partial → `unconfigured`.

### Regression Surface

- `inboundAgents` parsing and behavior (config.ts, worker-config.ts, session.ts) — must remain byte-identical; `agentVoices` is added alongside it, not by modifying its code path.
- Every other `SERVER_CATALOG` / `SERVER_CREDENTIAL_CHECKS` entry and its classification — unaffected by adding one new key.
- The `voice` (Vapi) server's catalog entry, credential check (none today), and config — untouched.
- `buildTts`'s ElevenLabs branch — untouched, no `voice` option added there in this ticket.

### Commands

- Unit: `npm run test -- src/config.test.ts src/voice-worker/session.test.ts src/voice-worker/telemetry.test.ts src/tools/server-catalog.test.ts src/tools/instance-capabilities.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression: `npm run check`

### Harness Requirements

- None beyond the existing Vitest setup. All new tests are pure-function/mocked-module tests — no database, no network, no external service.

### Non-Required Rationale

- Integration: see reason above — this epic's own convention (KPR-320 D3) treats live-call verification as an operator-gated empirical run, not a CI integration test, and this ticket adds no new integration surface beyond that already-established path.
- E2E: a live outbound PSTN call cannot execute in CI; verification is inherently a human, post-deploy check (spec §"Handoff" step 5).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## Task 1: `voice-livekit` server catalog entry + credential check

**Files:**
- Modify: `src/tools/server-catalog.ts:78-81` (insert new entry immediately after the existing `voice:` entry)
- Modify: `src/tools/instance-capabilities.ts:44-57` (insert new credential check into `SERVER_CREDENTIAL_CHECKS`)
- Modify: `src/tools/instance-capabilities.test.ts` (extend the invariant test's hardcoded list + add a new classification test)

- [ ] **Step 1:** Add the catalog entry.

In `src/tools/server-catalog.ts`, immediately after the existing `voice: { ... }` entry (currently lines 78-81), insert:

```typescript
  "voice-livekit": {
    description: "Make outbound phone calls via the LiveKit voice pipeline",
    usage: "Calling someone by phone when a live voice conversation is what's needed",
    notFor: "Vapi-based calling — use voice instead; that server key is separate and unrelated",
  },
```

- [ ] **Step 2:** Add the credential check.

In `src/tools/instance-capabilities.ts`, inside the `SERVER_CREDENTIAL_CHECKS` object (currently lines 44-57), add a new entry — condition mirrors `agent-runner.ts:662-666`'s actual spawn gate, but with `config.voice?.` optional-chained (like every other entry in this map, e.g. `config.google?.`, `config.resend?.`) rather than `config.voice.` unguarded — the shared test mock in `instance-capabilities.test.ts` has no `voice` key at all, and every entry here must tolerate that:

```typescript
  "voice-livekit": () =>
    !!(config.voice?.livekit?.enabled && config.voice?.livekitApiKey && config.voice?.livekitApiSecret && config.voice?.livekit?.url),
```

- [ ] **Step 3:** Extend the invariant test's hardcoded server list.

In `src/tools/instance-capabilities.test.ts`, in the `SERVER_CREDENTIAL_CHECKS invariant` describe block, add `"voice-livekit"` to the `credentialCheckServers` array:

```typescript
    const credentialCheckServers = [
      "google",
      "resend",
      "brave-search",
      "linear",
      "clickup",
      "github-issues",
      "quo",
      "recall",
      "code-task",
      "code-search",
      "browser",
      "tasks",
      "voice-livekit",
    ];
```

- [ ] **Step 4:** Add a dedicated classification test.

This test needs its own module-scoped config mock (the file's top-level `vi.mock("../config.js", ...)` is shared by every other test in the file and doesn't include a `voice` key at all). Add a new `describe` block at the **end** of `src/tools/instance-capabilities.test.ts` (placement matters: it must run after every other describe in the file, since `vi.resetModules()` would otherwise invalidate the module those earlier tests already imported), using `vi.doMock()` + a dynamic import so it doesn't disturb the shared top-level mock used by every other test.

First, extend the file's top-of-file vitest import (currently `import { describe, it, expect, vi, beforeEach } from "vitest";`) to include `afterEach`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
```

Then add the new block. `vi.resetModules()` must run in `beforeEach`, **before** the `doMock`+`import` in each test — not in `afterEach` — otherwise the dynamic `import("./instance-capabilities.js")` returns the module instance already cached (and bound to the old config) from the static import at the top of this file:

```typescript
describe("voice-livekit credential check", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../config.js");
  });

  it("classifies configured when livekit is fully enabled", async () => {
    vi.doMock("../config.js", () => ({
      config: {
        instance: { id: "test-instance" },
        voice: {
          livekit: { enabled: true, url: "wss://p.livekit.cloud" },
          livekitApiKey: "lk_key",
          livekitApiSecret: "lk_secret",
        },
      },
    }));
    const { buildInstanceCapabilities } = await import("./instance-capabilities.js");
    const result = buildInstanceCapabilities();
    expect(result.servers.configured).toContain("voice-livekit");
  });

  it("classifies unconfigured when the API pair is missing", async () => {
    vi.doMock("../config.js", () => ({
      config: {
        instance: { id: "test-instance" },
        voice: {
          livekit: { enabled: true, url: "wss://p.livekit.cloud" },
          livekitApiKey: "",
          livekitApiSecret: "",
        },
      },
    }));
    const { buildInstanceCapabilities } = await import("./instance-capabilities.js");
    const result = buildInstanceCapabilities();
    expect(result.servers.unconfigured).toContain("voice-livekit");
  });

  it("classifies unconfigured when livekit is disabled", async () => {
    vi.doMock("../config.js", () => ({
      config: {
        instance: { id: "test-instance" },
        voice: {
          livekit: { enabled: false, url: "" },
          livekitApiKey: "",
          livekitApiSecret: "",
        },
      },
    }));
    const { buildInstanceCapabilities } = await import("./instance-capabilities.js");
    const result = buildInstanceCapabilities();
    expect(result.servers.unconfigured).toContain("voice-livekit");
  });
});
```

Note: `vi.mock("../keychain/from-keychain.js", ...)` stays hoisted at module scope (already covers every test in the file, including this new block) — only `../config.js` needs the per-test override since it's the only mock these three cases vary. Every other entry in `SERVER_CREDENTIAL_CHECKS` uses optional chaining (confirmed against the file), so none of them throw under this block's minimal mocked config.

- [ ] **Step 5:** Verify.

Run:
```bash
npx vitest run src/tools/server-catalog.test.ts src/tools/instance-capabilities.test.ts
```
Expected: all tests pass, including the three new `voice-livekit credential check` cases and the extended invariant test.

Run:
```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6:** Commit.

```bash
git add src/tools/server-catalog.ts src/tools/instance-capabilities.ts src/tools/instance-capabilities.test.ts
git commit -m "KPR-325: register voice-livekit in server catalog + credential check"
```

---

## Task 2: Per-agent Cartesia voice id

**Files:**
- Modify: `src/config.ts:216-246` (`VoiceLivekitConfig` interface + `resolveVoiceLivekitConfig`)
- Modify: `src/voice-worker/worker-config.ts:12-56` (`WorkerConfig` interface + `loadWorkerConfig`)
- Modify: `src/voice-worker/session.ts:66-70,160` (`buildTts` + its call site)
- Modify: `src/config.test.ts:324-354` (`resolveVoiceLivekitConfig` test suite)
- Modify: `src/voice-worker/session.test.ts` (new `buildTts` test suite; also has two pre-existing `satisfies WorkerConfig` fixtures that need updating — see Step 5)
- Modify: `src/voice-worker/telemetry.test.ts:39-54` (one pre-existing `satisfies WorkerConfig` fixture — see Step 5)

- [ ] **Step 1:** Add `agentVoices` to `VoiceLivekitConfig`.

In `src/config.ts`, in the `VoiceLivekitConfig` interface (currently lines 216-227), add:

```typescript
export interface VoiceLivekitConfig {
  enabled: boolean;
  /** wss://<project>.livekit.cloud — non-secret. */
  url: string;
  /** SIPOutboundTrunk id from SIP-1 (ST_...). */
  sipTrunkId: string;
  /** E.164 → hive agent id map for inbound dispatch (S5). */
  inboundAgents: Record<string, string>;
  /** Cartesia voice id per hive agent id (Phase-0 scope, Cartesia only — KPR-325). */
  agentVoices: Record<string, string>;
  /** A/B cell defaults (S7); per-dispatch metadata overrides. */
  defaultStt: string;
  defaultTts: string;
}
```

- [ ] **Step 2:** Parse `agentVoices` in `resolveVoiceLivekitConfig`.

In `src/config.ts`, in `resolveVoiceLivekitConfig` (currently lines 229-246), add parsing that mirrors `inboundAgents` exactly (same trim-values-only, drop-non-string, drop-whitespace-only behavior — keys are used as-is, not trimmed):

```typescript
export function resolveVoiceLivekitConfig(raw: unknown): VoiceLivekitConfig {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const inboundAgents: Record<string, string> = {};
  if (src.inboundAgents && typeof src.inboundAgents === "object" && !Array.isArray(src.inboundAgents)) {
    for (const [num, agent] of Object.entries(src.inboundAgents as Record<string, unknown>)) {
      if (typeof agent === "string" && agent.trim()) inboundAgents[num] = agent.trim();
    }
  }
  const agentVoices: Record<string, string> = {};
  if (src.agentVoices && typeof src.agentVoices === "object" && !Array.isArray(src.agentVoices)) {
    for (const [agentId, voiceId] of Object.entries(src.agentVoices as Record<string, unknown>)) {
      if (typeof voiceId === "string" && voiceId.trim()) agentVoices[agentId] = voiceId.trim();
    }
  }
  return {
    enabled: src.enabled === true,
    url: str(src.url, ""),
    sipTrunkId: str(src.sipTrunkId, ""),
    inboundAgents,
    agentVoices,
    defaultStt: str(src.defaultStt, "deepgram/flux-general-en"),
    defaultTts: str(src.defaultTts, "cartesia/sonic-3"),
  };
}
```

- [ ] **Step 3:** Add `agentVoices` to `WorkerConfig`.

In `src/voice-worker/worker-config.ts`, in the `WorkerConfig` interface (currently lines 12-27), add the field next to `inboundAgents`:

```typescript
export interface WorkerConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sipTrunkId: string;
  inboundAgents: Record<string, string>;
  agentVoices: Record<string, string>;
  defaultStt: string;
  defaultTts: string;
  deepgramApiKey: string;
  cartesiaApiKey: string;
  elevenlabsApiKey: string;
  bridgeToken: string;
  bridgeUrl: string; // http://127.0.0.1:<voice.port>/v1/chat/completions
  mongoUri: string;
  mongoDbName: string;
}
```

- [ ] **Step 4:** Thread it through in `loadWorkerConfig`.

In `src/voice-worker/worker-config.ts`, in `loadWorkerConfig` (currently lines 38-72), add the mapping next to `inboundAgents`:

```typescript
  const wc: WorkerConfig = {
    livekitUrl: lk.url,
    livekitApiKey: config.voice.livekitApiKey,
    livekitApiSecret: config.voice.livekitApiSecret,
    sipTrunkId: lk.sipTrunkId,
    inboundAgents: lk.inboundAgents,
    agentVoices: lk.agentVoices,
    defaultStt: lk.defaultStt,
    defaultTts: lk.defaultTts,
    deepgramApiKey: resolveSecretEnv("DEEPGRAM_API_KEY"),
    cartesiaApiKey: resolveSecretEnv("CARTESIA_API_KEY"),
    elevenlabsApiKey: resolveSecretEnv("ELEVENLABS_API_KEY"),
    bridgeToken: config.voice.bridgeToken,
    bridgeUrl: `http://127.0.0.1:${config.voice.port}/v1/chat/completions`,
    mongoUri: config.mongo.uri,
    mongoDbName: config.mongo.dbName,
  };
```

(No change to the required-field validation loop below it — `agentVoices` is optional, same as `inboundAgents`.)

- [ ] **Step 5:** Update pre-existing `WorkerConfig` fixtures.

Making `agentVoices` a required field on `WorkerConfig` (Step 3) breaks three existing test fixtures typed `satisfies WorkerConfig` that don't yet have it — `npm run typecheck` will fail at Step 10 otherwise. Add `agentVoices: {},` immediately after `inboundAgents: {},` in each of these three spots:

`src/voice-worker/session.test.ts:112`:
```typescript
    inboundAgents: {},
    agentVoices: {},
```

`src/voice-worker/session.test.ts:140`:
```typescript
    inboundAgents: {},
    agentVoices: {},
```

`src/voice-worker/telemetry.test.ts:44`:
```typescript
  inboundAgents: {},
  agentVoices: {},
```

- [ ] **Step 6:** Thread the agent id into `buildTts`.

In `src/voice-worker/session.ts`, replace the current `buildTts` (lines 66-70):

```typescript
export function buildTts(cell: VendorCell, wc: WorkerConfig) {
  return cell.tts === "cartesia/sonic-3"
    ? new cartesia.TTS({ model: "sonic-3", apiKey: wc.cartesiaApiKey })
    : new elevenlabs.TTS({ model: "eleven_flash_v2_5", apiKey: wc.elevenlabsApiKey });
}
```

with:

```typescript
export function buildTts(cell: VendorCell, wc: WorkerConfig, agentId: string) {
  const voiceId = wc.agentVoices[agentId];
  return cell.tts === "cartesia/sonic-3"
    ? new cartesia.TTS({
        model: "sonic-3",
        apiKey: wc.cartesiaApiKey,
        ...(typeof voiceId === "string" && voiceId ? { voice: voiceId } : {}),
      })
    : new elevenlabs.TTS({ model: "eleven_flash_v2_5", apiKey: wc.elevenlabsApiKey });
}
```

(Guard is mandatory, not optional — `agentVoices` is a plain `{}` literal (Step 2), so an unguarded indexed lookup with `agentId = "constructor"` would return `Object.prototype.constructor`, a truthy `Function` that a bare truthiness check would spread into the TTS options. `caught-by: plan-review/1/fable`.)

- [ ] **Step 7:** Update the call site.

In `src/voice-worker/session.ts:160`, change:

```typescript
    tts: buildTts(cell, wc),
```

to:

```typescript
    tts: buildTts(cell, wc, hiveAgentId),
```

(`hiveAgentId` is already resolved above this line for both the outbound and inbound branches — see `session.ts:134,145` — no other change needed at the call site.)

- [ ] **Step 8:** Extend `config.test.ts` coverage.

In `src/config.test.ts`, replace the whole `resolveVoiceLivekitConfig (KPR-322 E3)` describe block (currently lines 324-354, three tests) with the version below — it carries every existing assertion forward unchanged and adds `agentVoices` coverage additively:

```typescript
describe("resolveVoiceLivekitConfig (KPR-322 E3)", () => {
  it("defaults on absent/garbage input", () => {
    for (const input of [undefined, null, 42, "x", []]) {
      const c = resolveVoiceLivekitConfig(input);
      expect(c.enabled).toBe(false);
      expect(c.url).toBe("");
      expect(c.sipTrunkId).toBe("");
      expect(c.inboundAgents).toEqual({});
      expect(c.agentVoices).toEqual({});
      expect(c.defaultStt).toBe("deepgram/flux-general-en");
      expect(c.defaultTts).toBe("cartesia/sonic-3");
    }
  });
  it("parses a full section and filters junk inboundAgents and agentVoices entries", () => {
    const c = resolveVoiceLivekitConfig({
      enabled: true,
      url: " wss://p.livekit.cloud ",
      sipTrunkId: "ST_1",
      inboundAgents: { "+15551230000": "nora", "+15551231111": 7, "+15551232222": " " },
      agentVoices: { mokie: " 47c38ca4-5f35-497b-b1a3-415245fb35e1 ", nora: 7, sige: " " },
      defaultStt: "deepgram/nova-3",
      defaultTts: "elevenlabs/eleven_flash_v2_5",
      unknownKey: "ignored",
    });
    expect(c.enabled).toBe(true);
    expect(c.url).toBe("wss://p.livekit.cloud");
    expect(c.inboundAgents).toEqual({ "+15551230000": "nora" });
    expect(c.agentVoices).toEqual({ mokie: "47c38ca4-5f35-497b-b1a3-415245fb35e1" });
    expect(c.defaultStt).toBe("deepgram/nova-3");
  });
  it("enabled must be literal true", () => {
    expect(resolveVoiceLivekitConfig({ enabled: "true" }).enabled).toBe(false);
  });
});
```

- [ ] **Step 9:** Add `buildTts` coverage to `session.test.ts`.

`src/voice-worker/session.test.ts` has no existing `buildTts` coverage. Add `vi.mock`s for both the Cartesia and ElevenLabs plugins near the top of the file (alongside the existing `vi.mock("mongodb", ...)` block) to capture constructor options, then import `buildTts` and add a new describe block covering both branches (the Cartesia branch with a voice id, without one, and the ElevenLabs branch, which this ticket deliberately leaves untouched).

`vi.mock` factories are hoisted above all imports, so the capture arrays must be declared via `vi.hoisted()` — same pattern the file already uses for `mongoMocks` (lines 6-15) — otherwise the factory runs before a plain `const` would be initialized.

At the top of `src/voice-worker/session.test.ts`, add (near the existing `vi.hoisted`/`vi.mock("mongodb", ...)` block):

```typescript
const { cartesiaCtorCalls, elevenlabsCtorCalls } = vi.hoisted(() => ({
  cartesiaCtorCalls: [] as Array<Record<string, unknown>>,
  elevenlabsCtorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@livekit/agents-plugin-cartesia", () => ({
  TTS: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    cartesiaCtorCalls.push(opts);
    return { label: "cartesia-tts-mock" };
  }),
}));

vi.mock("@livekit/agents-plugin-elevenlabs", () => ({
  TTS: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    elevenlabsCtorCalls.push(opts);
    return { label: "elevenlabs-tts-mock" };
  }),
}));
```

Change the import line:

```typescript
import { buildTts, recordSetupFailure, resolveInboundAgent, runJobShutdown } from "./session.js";
```

Add a new describe block (a fresh `WorkerConfig` fixture is fine — only the fields `buildTts` reads matter):

```typescript
describe("buildTts (KPR-325 per-agent voice)", () => {
  const baseWc = {
    cartesiaApiKey: "ck_test",
    elevenlabsApiKey: "el_test",
    agentVoices: {},
  } as WorkerConfig;
  const cartesiaCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" } as VendorCell;
  const elevenlabsCell = { stt: "deepgram/flux-general-en", tts: "elevenlabs/eleven_flash_v2_5" } as VendorCell;

  beforeEach(() => {
    cartesiaCtorCalls.length = 0;
    elevenlabsCtorCalls.length = 0;
  });

  it("passes the agent's configured voice id to Cartesia", () => {
    const wc = { ...baseWc, agentVoices: { mokie: "47c38ca4-5f35-497b-b1a3-415245fb35e1" } };
    buildTts(cartesiaCell, wc, "mokie");
    expect(cartesiaCtorCalls[0]).toMatchObject({
      model: "sonic-3",
      apiKey: "ck_test",
      voice: "47c38ca4-5f35-497b-b1a3-415245fb35e1",
    });
  });

  it("omits the voice option when the agent has no configured voice", () => {
    buildTts(cartesiaCell, baseWc, "sige");
    expect(cartesiaCtorCalls[0]).toEqual({ model: "sonic-3", apiKey: "ck_test" });
    expect(cartesiaCtorCalls[0]).not.toHaveProperty("voice");
  });

  it("omits the voice option when agentId is unset entirely", () => {
    buildTts(cartesiaCell, baseWc, "");
    expect(cartesiaCtorCalls[0]).not.toHaveProperty("voice");
  });

  it("omits the voice option for a prototype-chain agentId (no accidental Function value)", () => {
    buildTts(cartesiaCell, baseWc, "constructor");
    expect(cartesiaCtorCalls[0]).toEqual({ model: "sonic-3", apiKey: "ck_test" });
    expect(cartesiaCtorCalls[0]).not.toHaveProperty("voice");
  });

  it("ElevenLabs branch is unaffected by agentVoices — no voice option threaded", () => {
    const wc = { ...baseWc, agentVoices: { mokie: "47c38ca4-5f35-497b-b1a3-415245fb35e1" } };
    buildTts(elevenlabsCell, wc, "mokie");
    expect(elevenlabsCtorCalls[0]).toEqual({ model: "eleven_flash_v2_5", apiKey: "el_test" });
    expect(cartesiaCtorCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 10:** Verify.

Run:
```bash
npx vitest run src/config.test.ts src/voice-worker/session.test.ts src/voice-worker/telemetry.test.ts
```
Expected: all tests pass, including the new `resolveVoiceLivekitConfig` assertions and the five new `buildTts` cases (Cartesia-with-voice, Cartesia-without-voice, Cartesia-empty-agentId, Cartesia-prototype-chain-agentId, ElevenLabs-unaffected), and the three pre-existing fixture-based tests still pass with `agentVoices: {}` added.

Run:
```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 11:** Commit.

```bash
git add src/config.ts src/voice-worker/worker-config.ts src/voice-worker/session.ts src/config.test.ts src/voice-worker/session.test.ts src/voice-worker/telemetry.test.ts
git commit -m "KPR-325: thread per-agent Cartesia voice id through the TTS layer"
```

---

## Final check

- [ ] Run the full suite once both tasks are committed:

```bash
npm run check
```

Expected: typecheck, lint, format, and test all pass — no regressions outside the files touched above.
