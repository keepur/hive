# KPR-390 Implementation Plan — Meeting worker pool (Part A): fetch-workers, claim ledger, boss re-entry

**Goal:** a conference boss agent can dispatch a data-acquisition task to a cheap detached claude-lane worker with one tool call; "I got this" is atomic per meeting via a Mongo claim ledger; worker completion re-triggers the boss in the meeting thread through the existing callback-shaped re-entry; orphaned claims recover via TTL/watchdog/restart-sweep with honest notices.

**Tech stack:** TypeScript (strict, no `any` without justification), Node 22, Claude Agent SDK in-process MCP (`createSdkMcpServer`), MongoDB (native driver `^7.5.0` — v7 `findOneAndUpdate` returns doc-or-null, which the null-gating below relies on; do not "fix" the label back to v6), vitest (tests beside source).

**Spec:** `docs/epics/kpr-386/kpr-390-spec.md` (spec-ready, review clean r2 — binding contract). Epic branch `KPR-386` @ `9771b04` (KPR-387/388/389 merged).

**Canon note:** C1–C20 bind. Part A touches **neither `buildConferenceContext` (C13) nor `src/channels/dispatcher.ts` at all**; C18 observability = the claim ledger + existing KPR-389 turn fields, no new telemetry kinds; C19/E2 = worker lifecycle owned by the pool service, never the dispatching turn's abort chain, `delegateServers: []` structural.

**⚠ Scope: PART A ONLY.** Part B (scribe — `meeting_summaries`, cadence seam, C13 anchor edit, scribe pins) is **KPR-409's** design, carried in the spec document deliberately. Nothing in this plan implements, stores, configures, or tests anything scribe-shaped. See "Out-of-scope guard rails" at the end.

---

## Testing Contract

### Test groups

| Group | Verdict | Scope / Reason | Harness | Minimum assertions |
|---|---|---|---|---|
| **Unit** | **required** | All new modules and every touched engine seam: pool service (claims, gates, caps, dedup wiring, spawn shape, completion, re-entry, watchdog, restart sweep, cancel, abort), dedup sidecar, MCP tool handlers, config resolver, `policyFor` row, `workerClaimDedup` registry binding, runner in-process block, manager handshake + `stopAgent` hook | vitest beside source (`src/workers/*.test.ts` + additions to existing suites); fake `Db`/collection objects (callback-mcp-server.test.ts precedent), `vi.hoisted` mocks for config/LLM registry (meeting-classifier.test.ts precedent), injected fake manager hooks, `vi.useFakeTimers` for the watchdog | Spec T1–T10 (T1 incl. the cap-overshoot row; T5 both halves — boss-gone **and** no-conference-fan-out assertion) **plus**: atomic-claim duplicate-key race (concurrent identical dispatches ⇒ exactly one doc), dedup fail-open (throw / no-key / non-open-id ⇒ insert proceeds), denylist filtering is structural (captured worker `AgentConfig`, not prose), boss-gone guard (no `onDispatch` call at all), watchdog + restart sweep (atomic flip, exactly one re-entry, live-worker abort — watchdog covered via the **interval path on an empty-start ledger**, never masked by the restart sweep), re-entry WorkItem byte pin (id `worker:<claimId>`, `meta.targetAgentId`, source seven from the claim snapshot), worker containment (aborted worker ⇒ no status transition by the worker path; `abortForBoss` scoping; `stop()` aborts all + clears timer + fires no further sweeps), **worker-mode auto-injection suppression is structural on BOTH surfaces** (a worker-flagged runner's **built server set** omits `team`/`schedule`/`team-roster`, AND its **tool-transport inventory** — the filterCoreServers surface — carries no `team`/`schedule`/`team-roster`/`skill-author` entry; the config-array filter alone is insufficient because all three sync sites — `effectiveCoreServerSet`, `filterCoreServers`, `autoInjectedServerNames` — re-add them unconditionally, and `skill-author` is a live spawnable stdio server injected only via `filterCoreServers`), **Lane B inventory carries `worker-pool`** (KPR-327 memory-pattern compensation in `buildToolTransportInventory` — without it Lane B bosses never see the tools), index-spec pin (`partialFilterExpression: { status: "running" }` on the unique key; TTL on `updatedAt`), config-resolver liberal-loader rows (defaults, garbage input, wallclock<TTL clamp) |
| **Integration** | **not-required** (as a separate harness) | The repo has no live-Mongo/integration tier — every engine suite runs on fake `Db` objects (callback, outage-queue, dispatcher precedents). The cross-module seams are each pinned at their boundary by unit suites: the re-entry WorkItem is byte-pinned against the exact shape the *already-shipped* callback path consumes (scheduler.ts:288–305 verified identical), the runner block is pinned via public `buildInProcessServers`, the manager handshake via `setWorkerPool` assertions. | n/a | n/a |
| **E2E** | **not-required** | Requires live Slack + a real `conf-*` meeting + real Claude spawns. Covered by operator rollout validation on a fleet instance post-deploy (see Rollout note), the same posture KPR-387/388/389 shipped under (unit + pins + live validation). | n/a | n/a |

### Spec T1–T10 → plan mapping

| Spec test | Where |
|---|---|
| T1 atomic claim (+ distinct tasks, perMeetingMax refusal, cap-overshoot tolerated) | Task D — `meeting-worker-pool.test.ts` |
| T2 dedup (duplicate ⇒ no insert; null ⇒ insert; throw/no-key ⇒ insert; metadata stamped) | Task C (sidecar) + Task D (pool wiring) |
| T3 worker spawn shape (clone pin; negative-verify leak) | Task E (config-array half) + Task G5 (**authoritative built-server-set half** — auto-injection suppression) |
| T4 completion → re-entry (done/failed byte pin; drop after expiry) | Task E |
| T5 guards (boss deleted ⇒ no dispatch AND no unpinned item; breaker open; non-meeting; disabled) | Task D (gates) + Task E (boss-gone) |
| T6 watchdog + restart sweep | Task E |
| T7 `policyFor` `worker:` ⇒ silent | Task H |
| T8 stopAgent/shutdown abort scoping | Task E (pool half) + Task G (manager hook) |
| T9 conference stack untouched (zero-edit suite green) | Task K review gate |
| T10 registry task binding | Task B |

### Critical flows

1. **Happy path:** boss in `conf-*` thread → `worker_dispatch` → gates pass → dedup unique → atomic insert → detached spawn (cloned config, denylist-stripped, sessionless, charter override) → worker completes → atomic `running→done` → boss-gone guard passes → `worker:<claimId>` WorkItem via `onDispatch` → dispatcher step-0 pin → boss posts finding.
2. **Duplicate race:** two bosses, identical normalized text, concurrent → exactly one claim; loser gets claimant name. Near-equivalent text → dedup sidecar verdict; sidecar failure → fail-open to a second worker (accepted waste).
3. **Expiry paths:** worker wall-clock timeout (10m) → `failed` + honest report; hung completion → watchdog (claim TTL) → `expired` + honest report + live abort; engine restart → boot sweep flips all `running` → `expired` + notices. Exactly one re-entry per claim (atomic transition gates all paths).
4. **Abort paths:** `worker_cancel` (flip-then-abort; completion drops), `stopAgent(boss)` → `abortForBoss` (that boss only), `pool.stop()` (all + timer).

### Regression surface (must stay green, unmodified)

| Suite | Baseline (measured @ 9771b04) | Allowed edits |
|---|---|---|
| `src/channels/dispatcher-conference.test.ts` | **34 passed** | **ZERO** (T9 review gate — C6/C10/C3 pins byte-green) |
| `src/channels/dispatcher.test.ts` | **96 passed** | **ZERO** (`dispatcher.ts` untouched in Part A) |
| `src/agents/agent-manager.test.ts` | **245 passed** | additions only; **whole-file runs only, never `-t`** |
| `src/outage/outage-notices.test.ts` | **12 passed** | +1 table row |
| `src/agents/agent-runner.test.ts`, `src/agents/agent-registry.test.ts`, `src/config.test.ts`, `src/llm/registry.test.ts` | current counts | additions only |
| Full sweep `npm run check` + `npm run check:bundle` (4 guards) | green | — |

### Commands (env stubs required on every test/check run)

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
npx vitest run src/workers/                               # new suites
npx vitest run src/channels/dispatcher-conference.test.ts # expect: 34 passed, file untouched
npx vitest run src/channels/dispatcher.test.ts            # expect: 96 passed, file untouched
npx vitest run src/agents/agent-manager.test.ts           # WHOLE FILE ONLY — never -t
npx vitest run src/outage/outage-notices.test.ts          # expect: 13 passed (12 + 1)
npm run check                                             # typecheck + lint + format + test
npm run check:bundle                                      # bundle + 4 guards
```

Husky note: `.husky/pre-commit` runs `npx lint-staged` — expect staged files to be rewritten (prettier/eslint --fix) at commit time; if a commit's diff shifts, that is lint-staged, not a lost edit.

### Harness requirements

- **In-process MCP server testing (repo precedent = `src/callback/callback-mcp-server.test.ts`):** `vi.mock("@anthropic-ai/claude-agent-sdk")` replacing `createSdkMcpServer`/`tool` with capture shims; export a `buildWorkerPoolTools(deps)` function (parallel to `buildCallbackTools`) and invoke handlers directly with a mutable `{ current }` context ref; assert the ref is read per-call, not captured.
- **Mongo-backed ledger testing (repo precedent = fake-Db objects, e.g. callback + outage suites):** a `makeFakeClaims()` in-memory collection implementing exactly the operators the pool uses (`createIndex` recorder, `insertOne` with partial-unique-on-running simulation throwing `code: 11000`, `findOne`, `find().sort().limit().toArray()`, `findOneAndUpdate` with query-filter match returning doc-or-null, `updateOne`, `countDocuments`). The **real** atomicity lives in the Mongo index — pinned by asserting the `createIndex` call spec (`{ threadId: 1, taskKey: 1 }, { unique: true, partialFilterExpression: { status: "running" } }`); the fake reproduces its semantics so the handler's duplicate-key branch is exercised.
- **Sidecar-classifier testing (repo precedent = `src/agents/meeting-classifier.test.ts`):** `vi.hoisted` mocks + `vi.mock("../config.js")` + `vi.mock("../llm/registry.js")`.
- **Watchdog:** `vi.useFakeTimers()` + injected `now` seam (constructor dep) — never real sleeps.
- **Manager/runner additions:** follow the construction fixtures already in `agent-manager.test.ts` / `agent-runner.test.ts`; `buildInProcessServers` is public — call it directly.

### Non-required rationale

Recorded in the table above (Integration: no live-Mongo tier exists in this repo and every seam is boundary-pinned; E2E: live-fleet validation is the operative check, per KPR-387–389 precedent).

### Verification rules

- Evidence before claims (dodi-dev:verify): every "passes" statement in commits/PR text must be backed by a command actually run in the session with its output.
- `agent-manager.test.ts` runs **whole-file only** (repo rule — never `-t`).
- Negative-verify (Task J) runs before the final completion claim; working tree confirmed clean (`git status`) after each revert probe.
- T9 gate: `git diff --stat main...HEAD -- src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts` must show **no Part-A commits touching either file** (KPR-387–389 epic-branch history touches them; the KPR-390 commit range must not).

---

## Tasks

Baseline check before starting:

```bash
cd /Users/mokie/github/hive-KPR-386 && git status --short   # expect: clean
git log --oneline -1   # expect: 82bccbe (plan draft) or a later docs-only commit
# (the K1 T9 gate still ranges from 9771b04 — the last pre-KPR-390 code commit)
```

---

### Task A — Pool foundation: config leaf, resolver, claim types, denylist

- [ ] **A1.** Create `src/workers/worker-pool-config.ts` — a dependency-free leaf (config.ts imports it; keeping it import-free avoids a `config → pool → dedup → config` module cycle; the outage precedent co-locates type+default with the feature module, this splits them one file over for cycle safety — mechanical sharpening, noted):

```ts
/**
 * KPR-390: `meetingWorkers` hive.yaml section — types + defaults.
 * Dependency-free leaf: imported by config.ts (resolver) and by the pool
 * service, so it must not import either (avoids a module cycle
 * config → pool → worker-claim-dedup → config).
 */
export interface MeetingWorkersConfig {
  /** Claude-lane pin for fetch workers (bare id or CLI alias — goes to SDK Options.model, not the sidecar catalog). */
  workerModel: string;
  /** Engine-wide live workers. */
  maxConcurrent: number;
  /** Running claims per meeting thread. */
  perMeetingMax: number;
  /** Watchdog deadline (claim TTL). Must stay > workerTimeoutMs — resolver clamps. */
  claimTtlMinutes: number;
  workerMaxTurns: number;
  /** 10m — KPR-354 nested-backstop precedent. */
  workerTimeoutMs: number;
  /** false ⇒ tools refuse with an honest notice; nothing else changes. */
  enabled: boolean;
}

export const DEFAULT_MEETING_WORKERS_CONFIG: MeetingWorkersConfig = {
  workerModel: "sonnet",
  maxConcurrent: 4,
  perMeetingMax: 3,
  claimTtlMinutes: 30,
  workerMaxTurns: 25,
  workerTimeoutMs: 600_000,
  enabled: true,
};
```

- [ ] **A2.** In `src/config.ts`, add the liberal-loader resolver (place beside `resolveOutageQueueConfig`, ~line 75ff; KPR-225 F3 precedent — all keys optional, unknown keys ignored, garbage ⇒ defaults):

```ts
import { DEFAULT_MEETING_WORKERS_CONFIG, type MeetingWorkersConfig } from "./workers/worker-pool-config.js";

/**
 * KPR-390: liberal-loader resolver for the `meetingWorkers` hive.yaml section
 * (KPR-225 F3 — all keys optional, unknown keys ignored, absent section =
 * all defaults). Exported pure for unit tests. Invariant (spec §A5): the
 * worker wall clock must stay < the claim TTL — a violating TTL is clamped
 * up with a warning so the watchdog can never expire a still-sanctioned
 * worker.
 */
export function resolveMeetingWorkersConfig(raw: unknown): MeetingWorkersConfig {
  const d = DEFAULT_MEETING_WORKERS_CONFIG;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  const posNum = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  const workerTimeoutMs = posNum(r.workerTimeoutMs, d.workerTimeoutMs);
  let claimTtlMinutes = posNum(r.claimTtlMinutes, d.claimTtlMinutes);
  const minTtl = Math.ceil(workerTimeoutMs / 60_000) + 1;
  if (claimTtlMinutes < minTtl) {
    console.warn(
      `[config] meetingWorkers.claimTtlMinutes (${claimTtlMinutes}m) must exceed workerTimeoutMs (${workerTimeoutMs}ms) — clamping to ${minTtl}m.`,
    );
    claimTtlMinutes = minTtl;
  }
  return {
    workerModel:
      typeof r.workerModel === "string" && r.workerModel.trim() ? r.workerModel.trim() : d.workerModel,
    maxConcurrent: posNum(r.maxConcurrent, d.maxConcurrent),
    perMeetingMax: posNum(r.perMeetingMax, d.perMeetingMax),
    claimTtlMinutes,
    workerMaxTurns: posNum(r.workerMaxTurns, d.workerMaxTurns),
    workerTimeoutMs,
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
  };
}
```

- [ ] **A3.** In the exported `config` object (beside the `outageQueue:` entry, ~line 453):

```ts
  // KPR-390: meeting worker pool (hive.yaml `meetingWorkers`, all keys
  // optional; enabled:false = worker_dispatch refuses honestly, nothing else changes).
  meetingWorkers: resolveMeetingWorkersConfig(hive.meetingWorkers),
```

(`hive.meetingWorkers` follows the same untyped-yaml access pattern as `hive.outageQueue` — cast if the `hive` type requires it, mirroring the neighboring lines.)

- [ ] **A4.** Add resolver tests to `src/config.test.ts` (follow the `resolveOutageQueueConfig` test block conventions): absent/garbage/array input ⇒ deep-equals defaults; each key individually overridable; non-finite/negative numbers fall back; `enabled: false` honored; **TTL clamp row** — `{ workerTimeoutMs: 600000, claimTtlMinutes: 5 }` ⇒ `claimTtlMinutes: 11`; unknown keys ignored.
- [ ] **A5.** Verify:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts
# expect: all passed (existing count + ~6 new)
npm run typecheck   # expect: clean
```

- [ ] **A6.** Commit: `feat(workers): meetingWorkers config section — liberal-loader resolver + defaults (KPR-390)`

---

### Task B — `workerClaimDedup` LLM task binding

- [ ] **B1.** `src/llm/types.ts` line 78 — widen the union:

```ts
export type LLMTask = "routerClassifier" | "meetingClassifier" | "memory" | "vision" | "workerClaimDedup";
```

- [ ] **B2.** `src/llm/registry.ts` — add to `TASKS` (same classifier-grade binding the meeting classifier borrows; task bindings are code constants):

```ts
  // KPR-390: meeting worker-pool semantic claim dedup — classifier-grade,
  // borrows the router's model like meetingClassifier (spec §A2).
  workerClaimDedup: { provider: "anthropic", modelId: () => config.modelRouter.model },
```

- [ ] **B3.** `src/llm/registry.test.ts` — add (following the file's existing task-binding test conventions): `workerClaimDedup` resolves to the anthropic provider with `config.modelRouter.model`; with no anthropic key constructed, `generateForTask("workerClaimDedup", …)` rejects with `LLMProviderUnavailableError` (this is the error the sidecar's fail-open path swallows — T10).
- [ ] **B4.** Verify: `npx vitest run src/llm/registry.test.ts` (with env stubs) — existing count + 2. `npm run typecheck` clean.
- [ ] **B5.** Commit: `feat(llm): workerClaimDedup sidecar task binding (KPR-390)`

---

### Task C — Dedup sidecar `src/workers/worker-claim-dedup.ts`

- [ ] **C1.** Create `src/workers/worker-claim-dedup.ts` (meeting-classifier template — imports config + registry; the pool injects this function, so pool unit tests never touch it):

```ts
/**
 * KPR-390 §A2: best-effort semantic dedup for meeting worker claims.
 * One classifier-grade sidecar call before insert; EVERY failure path
 * (no key, transport error, parse failure, non-open id) degrades to
 * "unique" — fail-open to duplicate work, never to a blocked dispatch
 * (ticket-explicit). The exact-key partial-unique index backstops
 * identical text regardless.
 */
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { getLLMRegistry } from "../llm/registry.js";

const log = createLogger("worker-claim-dedup");

const DEDUP_SYSTEM_PROMPT =
  "You deduplicate research tasks dispatched during a meeting. Decide whether the NEW task would substantially duplicate any OPEN task's work — near-equivalent data fetches count as duplicates; different targets or clearly different deliverables do not. Reply with JSON only: {\"duplicateOf\": \"<open task id>\"} if a duplicate, {\"duplicateOf\": null} otherwise.";

const DEDUP_SCHEMA = {
  type: "object",
  properties: { duplicateOf: { type: ["string", "null"] } },
  required: ["duplicateOf"],
  additionalProperties: false,
};

/** Open claims are capped at 10 by the caller; enforced here too (belt-and-braces). */
const MAX_COMPARED = 10;

export interface OpenClaimSummary {
  claimId: string;
  taskText: string;
}

export interface ClaimDedupVerdict {
  /** null = unique (including every fail-open path). */
  duplicateOfClaimId: string | null;
  costUsd: number;
}

export async function classifyClaimDedup(
  newTask: string,
  openClaims: OpenClaimSummary[],
): Promise<ClaimDedupVerdict> {
  if (openClaims.length === 0) return { duplicateOfClaimId: null, costUsd: 0 };
  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) return { duplicateOfClaimId: null, costUsd: 0 };
  const open = openClaims.slice(0, MAX_COMPARED);
  try {
    const prompt = `OPEN tasks:\n${open.map((c) => `- [${c.claimId}] ${c.taskText}`).join("\n")}\n\nNEW task:\n${newTask}`;
    const result = await registry.generateForTask("workerClaimDedup", {
      prompt,
      systemPrompt: DEDUP_SYSTEM_PROMPT,
      jsonSchema: DEDUP_SCHEMA,
      maxOutputTokens: 128,
      temperature: 0,
      timeoutMs: config.modelRouter.timeoutMs,
    });
    let parsed: unknown = result.parsed;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = undefined;
      }
    }
    const dup =
      parsed && typeof parsed === "object" && typeof (parsed as { duplicateOf?: unknown }).duplicateOf === "string"
        ? ((parsed as { duplicateOf: string }).duplicateOf)
        : null;
    // Non-open id returned ⇒ fail-open to unique (spec §A2).
    const valid = dup && open.some((c) => c.claimId === dup) ? dup : null;
    return { duplicateOfClaimId: valid, costUsd: result.costUsd ?? 0 };
  } catch (err) {
    log.warn("workerClaimDedup call failed — treating task as unique (fail-open)", { error: String(err) });
    return { duplicateOfClaimId: null, costUsd: 0 };
  }
}
```

- [ ] **C2.** Create `src/workers/worker-claim-dedup.test.ts` — clone the `meeting-classifier.test.ts` mocking scaffold (`vi.hoisted` for `mockGenerateForTask`/`mockHasProvider`; `vi.mock` for `../logging/logger.js`, `../config.js` with `{ config: { modelRouter: { model: "claude-haiku-4-5-20251001", timeoutMs: 4000 } } }`, `../llm/registry.js`). Assertions (≥8):
  1. empty `openClaims` ⇒ `{ null, 0 }` and `generateForTask` **never called**;
  2. no anthropic provider ⇒ `{ null, 0 }`, never called (fail-open pre-check);
  3. request shape pin: task `"workerClaimDedup"`, `jsonSchema` present, `maxOutputTokens: 128`, `temperature: 0`, `timeoutMs: 4000`;
  4. `parsed: { duplicateOf: "<open id>" }` ⇒ that id + costUsd passthrough;
  5. `duplicateOf: null` ⇒ null;
  6. non-open id ⇒ null (fail-open pin);
  7. `generateForTask` rejects ⇒ null, warn logged;
  8. `parsed` undefined + unparsable `text` ⇒ null;
  9. > 10 open claims ⇒ prompt contains only 10.
- [ ] **C3.** Verify: `npx vitest run src/workers/worker-claim-dedup.test.ts` — 9 passed. `npm run typecheck` clean.
- [ ] **C4.** Commit: `feat(workers): workerClaimDedup sidecar classifier — fail-open by construction (KPR-390)`

---

### Task D — Pool service part 1: claim ledger, gates, atomic dispatch, status, cancel

- [ ] **D1.** Create `src/workers/meeting-worker-pool.ts`. Full module (part 1 — the spawn/completion/watchdog internals arrive in Task E; write the file with Task E's method stubs throwing `new Error("not yet implemented (Task E)")` ONLY if you commit D separately, otherwise land D+E in one commit — **preferred: implement D and E fully, commit once after E**; the split below is for review readability):

```ts
/**
 * KPR-390 (Part A): Meeting worker pool — async fetch-workers with a Mongo
 * claim ledger (`meeting_worker_claims`).
 *
 * A conference boss claims a task atomically (exact-key partial-unique index
 * + best-effort semantic dedup), a detached claude-lane worker runs it
 * (cloned boss config minus WORKER_SERVER_DENYLIST, sessionless,
 * breaker-invisible, NOT spawnBudget-accounted — bounds are the pool caps),
 * and completion re-enters the boss through the callback-shaped WorkItem via
 * the onDispatch seam (dispatcher step-0 pin).
 *
 * The scribe role (Part B) is KPR-409 — it will reuse runWorkerTurn with its
 * own WorkerRoleParams and zero changes to this file's spawn path.
 */
import { createHash } from "node:crypto";
import { ObjectId, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { AgentProviderAdapter } from "../agents/provider-adapters/types.js";
import type { CircuitBreakerSnapshot } from "../agents/provider-circuit-breaker.js";
import type { MeetingWorkersConfig } from "./worker-pool-config.js";
import { classifyClaimDedup } from "./worker-claim-dedup.js";

const log = createLogger("meeting-worker-pool");

/** Redaction rule (spec §A6): taskText previews hard-capped at 80 chars on
 *  EVERY log site; resultText is NEVER logged at any length (ledger-only). */
const TASK_PREVIEW_CHARS = 80;
const RESULT_TEXT_CAP = 8000;
const WATCHDOG_INTERVAL_MS = 60_000;
/** Housekeeping TTL — terminal docs age out; live expiry is the watchdog's
 *  status flip on `expiresAt`, so a TTL-deleted doc is always already terminal. */
const CLAIMS_TTL_SECONDS = 7 * 86_400;

/**
 * Through-the-boss + containment enforcement — STRUCTURAL, not prose
 * (code-enforce-don't-prose-enforce). Stripped from the worker's cloned
 * coreServers — AND paired with the runner's suppressAutoInjectedServers
 * worker-mode flag (set by the manager's buildWorkerAdapter): team/schedule/
 * team-roster are auto-injected for every normal agent regardless of
 * coreServers, so the strip alone would be a no-op without the flag.
 * Rationale per entry (spec §A3): outbound message surfaces
 * (slack/quo/resend/team/event-bus/recall/voice); self-scheduling &
 * re-entry minting (callback/schedule); recursion (worker-pool); agent-def
 * editing (admin); detached-process escape hatch that would outlive every
 * kill path (background — E5 load-bearing); credential-read leak
 * amplification (keychain); long-lived CLI session spawning (code-task).
 * Memory servers deliberately STAY (same trust domain, reviewer-confirmed r1).
 */
export const WORKER_SERVER_DENYLIST = new Set<string>([
  "slack",
  "quo",
  "resend",
  "team",
  "event-bus",
  "callback",
  "schedule",
  "recall",
  "voice",
  "admin",
  "worker-pool",
  "background",
  "keychain",
  "code-task",
]);

/** The WorkItemContext seven — per-turn metadata from the boss's dispatching turn. */
export interface WorkerPoolTurnContext {
  adapterId?: string;
  channelId?: string;
  channelKind?: string;
  channelLabel?: string;
  threadId?: string;
  slackTs?: string;
  slackThreadTs?: string;
}

export type WorkerClaimStatus = "running" | "done" | "failed" | "expired" | "cancelled";

export interface WorkerClaimSource {
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  slackTs: string;
  slackThreadTs: string;
}

export interface WorkerClaimDoc {
  _id: ObjectId;
  /** Meeting thread key — the boss turn's WorkItemContext.threadId (already the `threadId ?? id` formula). */
  threadId: string;
  /** Re-entry source snapshot (callback-doc template). */
  source: WorkerClaimSource;
  taskText: string;
  /** sha256 of lowercase/whitespace-collapsed taskText — exact-match atomicity key. */
  taskKey: string;
  status: WorkerClaimStatus;
  bossAgentId: string;
  workerModel: string;
  createdAt: Date;
  updatedAt: Date;
  /** createdAt + claimTtlMinutes — watchdog deadline, NOT a Mongo TTL delete. */
  expiresAt: Date;
  resultText?: string;
  error?: string;
  /** C18: the worker measurement surface. */
  durationMs?: number;
  costUsd?: number;
  toolCalls?: number;
  dedup?: { compared: number; verdict: "unique" | "duplicate"; costUsd: number };
}

/**
 * Per-role spawn parameters (spec §A3 plan directive): the fetch-worker role
 * is Part A's only instantiation; KPR-409's scribe supplies its own object
 * (haiku pin, coreServers: [], scribe caps/charter) with zero changes here.
 */
export interface WorkerRoleParams {
  model: string;
  /** POST-filter allowlist — the role owns the filtering (fetch role: boss minus denylist). */
  coreServers: string[];
  maxTurns: number;
  timeoutMs: number;
  /** Total systemPromptOverride replacement (voice precedent). */
  charter: string;
}

/** Manager handshake (spec §A3 "factory callback" choice): runner-construction
 *  inputs stay inside AgentManager; the pool holds only capabilities. */
export interface WorkerPoolManagerHooks {
  /** Builds AgentRunner + ClaudeAgentAdapter from the cloned worker config —
   *  prefixCache deliberately omitted, workerPool deliberately not passed. */
  buildWorkerAdapter(workerConfig: AgentConfig): AgentProviderAdapter;
  breakerStateFor(provider: "claude"): CircuitBreakerSnapshot | null;
}

export interface WorkerPoolRegistry {
  get(id: string): AgentConfig | undefined;
}

export interface MeetingWorkerPoolDeps {
  db: Db;
  registry: WorkerPoolRegistry;
  config: MeetingWorkersConfig;
  /** Scheduler-seam precedent — index.ts wires `(item) => dispatcher.dispatch(item).catch(…)`. */
  onDispatch: (item: WorkItem) => void;
  /** Test seams. */
  dedup?: typeof classifyClaimDedup;
  now?: () => Date;
}

export function normalizedTaskKey(taskText: string): string {
  return createHash("sha256")
    .update(taskText.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
}

function taskPreview(taskText: string): string {
  return taskText.slice(0, TASK_PREVIEW_CHARS);
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

interface LiveWorker {
  abort: () => void;
  bossAgentId: string;
}

export class MeetingWorkerPool {
  private readonly claims: Collection<WorkerClaimDoc>;
  private readonly liveWorkers = new Map<string, LiveWorker>();
  private manager?: WorkerPoolManagerHooks;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private readonly now: () => Date;
  private readonly dedup: typeof classifyClaimDedup;

  constructor(private readonly deps: MeetingWorkerPoolDeps) {
    this.claims = deps.db.collection<WorkerClaimDoc>("meeting_worker_claims");
    this.now = deps.now ?? (() => new Date());
    this.dedup = deps.dedup ?? classifyClaimDedup;
  }

  /** Called by AgentManager.setWorkerPool (index.ts wiring). */
  bindManager(hooks: WorkerPoolManagerHooks): void {
    this.manager = hooks;
  }

  async ensureIndexes(): Promise<void> {
    // The atomic "I got this" — two bosses inserting the identical normalized
    // task race on this index; the loser's duplicate-key error is the
    // claim-denied signal (spec §A2).
    await this.claims.createIndex(
      { threadId: 1, taskKey: 1 },
      { unique: true, partialFilterExpression: { status: "running" } },
    );
    await this.claims.createIndex({ threadId: 1, status: 1 });
    // Housekeeping only — live expiry is the watchdog's job via expiresAt.
    await this.claims.createIndex({ updatedAt: 1 }, { expireAfterSeconds: CLAIMS_TTL_SECONDS });
  }

  async start(): Promise<void> {
    await this.ensureIndexes();
    await this.sweepOnRestart();
    this.watchdogTimer = setInterval(() => {
      this.sweepExpired().catch((err) => log.error("Worker watchdog sweep failed", { error: String(err) }));
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    for (const [claimId, worker] of this.liveWorkers) {
      try {
        worker.abort();
      } catch (err) {
        log.warn("Worker abort threw during pool stop — contained", { claimId, error: String(err) });
      }
    }
  }

  /** stopAgent hook — aborts THIS boss's live workers only. Claims stay
   *  `running` and are owned by the cancel/watchdog/restart-sweep paths. */
  abortForBoss(agentId: string): void {
    for (const [claimId, worker] of this.liveWorkers) {
      if (worker.bossAgentId !== agentId) continue;
      try {
        worker.abort();
      } catch (err) {
        log.warn("Worker abort threw in abortForBoss — contained", { claimId, error: String(err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tool surface (called by worker-pool-mcp-server handlers)
  // -------------------------------------------------------------------------

  /** worker_dispatch — handler sequence per spec §A1 (steps 1–6; only step 5 is atomic). */
  async dispatch(req: { bossAgentId: string; task: string; context: WorkerPoolTurnContext }): Promise<string> {
    const cfg = this.deps.config;
    if (!cfg.enabled) {
      return "The meeting worker pool is disabled on this instance (meetingWorkers.enabled: false). Do the work in your own turn, via bg_execute, or an in-turn Task subagent.";
    }
    const ctx = req.context;
    // 1. Meeting gate — mirrors dispatcher step 0.7's discriminator (both halves).
    if (ctx.channelKind !== "slack" || !ctx.channelLabel?.startsWith("conf-") || !ctx.threadId) {
      return "worker_dispatch is meeting-only (Slack conf-* channels). Use bg_execute for shell work or an in-turn Task subagent instead.";
    }
    if (!this.manager) {
      return "The worker pool is not fully wired yet — try again shortly.";
    }
    // 2. Breaker pre-check (read-only — no permit, nothing recorded; KPR-354 posture).
    const breaker = this.manager.breakerStateFor("claude");
    if (breaker && breaker.enabled && breaker.state === "open") {
      return "Provider outage (claude circuit open) — I can't dispatch a worker right now. Tell the room and retry once service recovers.";
    }
    // 3. Caps — check-then-act, bounded overshoot EXPLICITLY accepted (spec §A1
    //    step 3): caps are load valves, not correctness invariants. Do NOT add
    //    locking or post-insert re-count machinery here.
    if (this.liveWorkers.size >= cfg.maxConcurrent) {
      return `Worker pool saturated (${this.liveWorkers.size}/${cfg.maxConcurrent} engine-wide) — retry shortly or do the work in your own turn.`;
    }
    const runningHere = await this.claims.countDocuments({ threadId: ctx.threadId, status: "running" });
    if (runningHere >= cfg.perMeetingMax) {
      return `This meeting already has ${runningHere}/${cfg.perMeetingMax} workers running — wait for one to report back.`;
    }
    // 4. Semantic dedup (best-effort, fail-open — spec §A2).
    const open = await this.claims
      .find({ threadId: ctx.threadId, status: "running" })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    let dedupStamp: WorkerClaimDoc["dedup"];
    if (open.length > 0) {
      const verdict = await this.dedup(
        req.task,
        open.map((c) => ({ claimId: c._id.toString(), taskText: c.taskText })),
      );
      dedupStamp = {
        compared: open.length,
        verdict: verdict.duplicateOfClaimId ? "duplicate" : "unique",
        costUsd: verdict.costUsd,
      };
      if (verdict.duplicateOfClaimId) {
        const dup = open.find((c) => c._id.toString() === verdict.duplicateOfClaimId);
        if (dup) {
          log.info("Worker claim denied (duplicate)", {
            claimId: dup._id.toString(),
            bossAgentId: req.bossAgentId,
            threadId: ctx.threadId,
            taskPreview: taskPreview(req.task),
          });
          return this.alreadyClaimedText(dup);
        }
      }
    }
    // 5. Atomic claim — the insert is the only atomic step.
    const nowDate = this.now();
    const doc: WorkerClaimDoc = {
      _id: new ObjectId(),
      threadId: ctx.threadId,
      source: {
        adapterId: ctx.adapterId ?? "",
        channelId: ctx.channelId ?? "",
        channelKind: ctx.channelKind ?? "slack",
        channelLabel: ctx.channelLabel ?? "",
        slackTs: ctx.slackTs ?? "",
        slackThreadTs: ctx.slackThreadTs ?? "",
      },
      taskText: req.task,
      taskKey: normalizedTaskKey(req.task),
      status: "running",
      bossAgentId: req.bossAgentId,
      workerModel: cfg.workerModel,
      createdAt: nowDate,
      updatedAt: nowDate,
      expiresAt: new Date(nowDate.getTime() + cfg.claimTtlMinutes * 60_000),
      ...(dedupStamp ? { dedup: dedupStamp } : {}),
    };
    try {
      await this.claims.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const winner = await this.claims.findOne({ threadId: ctx.threadId, taskKey: doc.taskKey, status: "running" });
        if (winner) return this.alreadyClaimedText(winner);
        // Winner already finished between throw and read — extremely narrow;
        // honest retry text rather than a second insert attempt.
        return "That task was just claimed and completed — check worker_status before re-dispatching.";
      }
      throw err; // MCP handler try/catch shapes this into a structured error
    }
    // 6. Detached spawn — containment lives inside runWorkerTurn (never throws).
    void this.spawnFetchWorker(doc);
    log.info("Worker dispatched", {
      claimId: doc._id.toString(),
      bossAgentId: req.bossAgentId,
      threadId: ctx.threadId,
      taskPreview: taskPreview(req.task),
    });
    return `Worker dispatched (claim ${doc._id.toString()}). You'll be re-triggered here with the report — tell the room you've sent someone and end your turn.`;
  }

  /** worker_status — one line per claim, task preview capped at 80 chars. */
  async status(threadId: string): Promise<string> {
    const docs = await this.claims.find({ threadId }).sort({ createdAt: -1 }).limit(20).toArray();
    if (docs.length === 0) return "No worker claims for this meeting yet.";
    const nowMs = this.now().getTime();
    return docs
      .map((c) => {
        const ageMin = Math.max(0, Math.round((nowMs - c.createdAt.getTime()) / 60_000));
        const name = this.deps.registry.get(c.bossAgentId)?.name ?? c.bossAgentId;
        return `${c._id.toString()} — ${c.status} — ${name} — ${ageMin}m — ${taskPreview(c.taskText)}`;
      })
      .join("\n");
  }

  /** worker_cancel — flip-then-abort; completion after cancel drops on the atomic gate (E13). */
  async cancel(claimId: string, bossAgentId: string): Promise<string> {
    if (!ObjectId.isValid(claimId)) return `Claim not found: ${claimId}`;
    const _id = new ObjectId(claimId);
    const doc = await this.claims.findOne({ _id });
    if (!doc) return `Claim not found: ${claimId}`;
    if (doc.bossAgentId !== bossAgentId) {
      const name = this.deps.registry.get(doc.bossAgentId)?.name ?? doc.bossAgentId;
      return `Not yours — that claim was dispatched by ${name}.`;
    }
    const updated = await this.claims.findOneAndUpdate(
      { _id, status: "running" },
      { $set: { status: "cancelled" as const, error: "cancelled by dispatching boss", updatedAt: this.now() } },
    );
    if (!updated) return `Already finished (status: ${doc.status}).`;
    const live = this.liveWorkers.get(claimId);
    if (live) {
      try {
        live.abort();
      } catch (err) {
        log.warn("Worker abort threw in cancel — contained", { claimId, error: String(err) });
      }
    }
    log.info("Worker claim cancelled", { claimId, bossAgentId });
    return `Cancelled claim ${claimId}.`;
  }

  private alreadyClaimedText(claim: WorkerClaimDoc): string {
    const name = this.deps.registry.get(claim.bossAgentId)?.name ?? claim.bossAgentId;
    const ageMin = Math.max(0, Math.round((this.now().getTime() - claim.createdAt.getTime()) / 60_000));
    return `Already claimed by ${name} (claim ${claim._id.toString()}, started ${ageMin}m ago), in progress — say so in the thread.`;
  }

  // …Task E adds: spawnFetchWorker, runWorkerTurn, finishClaim,
  // dispatchReentry, sweepExpired, sweepOnRestart, and the prompt builders…
}
```

- [ ] **D2.** Begin `src/workers/meeting-worker-pool.test.ts` with the shared harness + Task-D assertions. Harness (complete — Task E extends the same file):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// The pool takes `dedup` as an injected dep — the real module (which imports
// config) must never load in this suite.
vi.mock("./worker-claim-dedup.js", () => ({
  classifyClaimDedup: vi.fn(async () => ({ duplicateOfClaimId: null, costUsd: 0 })),
}));

import {
  MeetingWorkerPool,
  WORKER_SERVER_DENYLIST,
  normalizedTaskKey,
  type WorkerClaimDoc,
  type WorkerPoolTurnContext,
} from "./meeting-worker-pool.js";
import { DEFAULT_MEETING_WORKERS_CONFIG } from "./worker-pool-config.js";

type AnyDoc = Record<string, any>;

/** Minimal query matcher for exactly the operators the pool uses. */
function matches(doc: AnyDoc, q: AnyDoc): boolean {
  for (const [k, v] of Object.entries(q)) {
    if (k === "_id") {
      if (String(doc._id) !== String(v)) return false;
    } else if (v && typeof v === "object" && "$lt" in v) {
      if (!(doc[k] < (v as { $lt: any }).$lt)) return false;
    } else if (doc[k] !== v) return false;
  }
  return true;
}

function makeFakeClaims() {
  const docs: AnyDoc[] = [];
  const createIndexCalls: Array<[AnyDoc, AnyDoc | undefined]> = [];
  const col = {
    docs,
    createIndexCalls,
    async createIndex(spec: AnyDoc, opts?: AnyDoc) {
      createIndexCalls.push([spec, opts]);
      return "";
    },
    async insertOne(doc: AnyDoc) {
      // Simulates the partial-unique index { threadId, taskKey } WHERE status:"running".
      if (
        doc.status === "running" &&
        docs.some((d) => d.status === "running" && d.threadId === doc.threadId && d.taskKey === doc.taskKey)
      ) {
        const err: any = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
      }
      docs.push(doc);
      return { insertedId: doc._id };
    },
    async countDocuments(q: AnyDoc) {
      return docs.filter((d) => matches(d, q)).length;
    },
    find(q: AnyDoc) {
      const arr = docs.filter((d) => matches(d, q));
      return {
        sort() { return this; },
        limit() { return this; },
        async toArray() { return arr; },
      };
    },
    async findOne(q: AnyDoc) {
      return docs.find((d) => matches(d, q)) ?? null;
    },
    async findOneAndUpdate(q: AnyDoc, u: AnyDoc) {
      const d = docs.find((x) => matches(x, q));
      if (!d) return null;
      Object.assign(d, u.$set);
      return d;
    },
    async updateOne(q: AnyDoc, u: AnyDoc) {
      const d = docs.find((x) => matches(x, q));
      if (d) Object.assign(d, u.$set);
      return { modifiedCount: d ? 1 : 0 };
    },
  };
  return col;
}

function makeFixture(overrides?: {
  config?: Partial<typeof DEFAULT_MEETING_WORKERS_CONFIG>;
  registryAgents?: Record<string, AnyDoc>;
  dedup?: (...args: any[]) => any;
  runTurnImpl?: (req: any) => Promise<AnyDoc>;
}) {
  const claims = makeFakeClaims();
  const db = { collection: () => claims } as any;
  const agents: Record<string, AnyDoc> = overrides?.registryAgents ?? {
    boss: {
      id: "boss", name: "Jasper", model: "opus",
      coreServers: ["memory", "slack", "callback", "worker-pool", "code-search", "background", "keychain"],
      delegateServers: ["crm-search"], schedule: [{ cron: "0 9 * * *" }], budgetUsd: 2.5,
    },
  };
  const registry = { get: (id: string) => agents[id] as any };
  const onDispatch = vi.fn();
  const builtConfigs: AnyDoc[] = [];
  const abortSpy = vi.fn();
  const runTurn = vi.fn(
    overrides?.runTurnImpl ??
      (async () => ({ text: "report body", costUsd: 0.01, durationMs: 1200, toolCalls: 3 })),
  );
  const hooks = {
    buildWorkerAdapter: vi.fn((cfg: AnyDoc) => {
      builtConfigs.push(cfg);
      return { provider: "claude", runTurn, abort: abortSpy, wasAborted: false } as any;
    }),
    breakerStateFor: vi.fn(() => null),
  };
  const dedup = vi.fn(overrides?.dedup ?? (async () => ({ duplicateOfClaimId: null, costUsd: 0 })));
  const pool = new MeetingWorkerPool({
    db, registry, onDispatch,
    config: { ...DEFAULT_MEETING_WORKERS_CONFIG, ...overrides?.config },
    dedup: dedup as any,
  });
  pool.bindManager(hooks as any);
  return { pool, claims, onDispatch, hooks, dedup, builtConfigs, abortSpy, runTurn, agents };
}

const meetingCtx: WorkerPoolTurnContext = {
  adapterId: "slack-main", channelId: "C123", channelKind: "slack",
  channelLabel: "conf-tahoe", threadId: "1724680000.100", slackTs: "1724680001.200",
  slackThreadTs: "1724680000.100",
};
```

  Task-D assertions (each an `it(...)`):
  1. **(T1 core)** concurrent identical dispatches: `Promise.all` of two `pool.dispatch` with the same task ⇒ exactly one doc in `claims.docs`; one response starts `"Worker dispatched (claim "`, the other starts `"Already claimed by Jasper"` (claimant **name** resolved via registry).
  2. **(T1)** distinct tasks ⇒ two claims, two workers.
  3. **(T1)** `perMeetingMax` pre-seeded running claims ⇒ refusal with counts, no insert.
  4. **(T1 cap-overshoot pin)** concurrent **distinct** dispatches straddling `perMeetingMax` (seed `perMeetingMax - 1` running docs, fire 2 concurrently with a dedup stub that awaits a deferred promise so both pass the count check before either inserts) ⇒ **both may succeed; the test asserts the overshoot is tolerated** (`docs running count <= perMeetingMax + 1` and no rejection was thrown) — pinning the check-then-act acceptance. The "no lock/re-count machinery added" half is a plan/review gate (a unit test cannot assert code absence).
  5. **(T2 wiring)** dedup returns `duplicateOfClaimId` of an open claim ⇒ no insert, claimed-by text; returns null ⇒ insert with `dedup: { compared: 1, verdict: "unique", costUsd }` stamped; dedup not called at all when no open claims (and no `dedup` field on the doc).
  6. **(T2 fail-open at pool level)** injected dedup throws ⇒ dispatch still inserts (the injected seam mirrors the sidecar's own fail-open; wrap: if the pool does not catch dedup throws itself, the sidecar contract guarantees no-throw — assert via a dedup stub that returns the fail-open verdict; add one row asserting a **throwing** stub propagates as the MCP-shaped error only if the pool deliberately doesn't catch — decision: the pool does NOT add its own try/catch around `this.dedup` (the sidecar is no-throw by contract); the test row uses the no-throw stub).
  7. **(T5 gates)** non-`conf-` label ⇒ refused with `bg_execute` pointer, no state touched; non-slack `channelKind` ⇒ refused; missing `threadId` ⇒ refused; `enabled: false` ⇒ refused; breaker `{ state: "open", enabled: true }` ⇒ refused, **no claim created**; breaker `{ state: "open", enabled: false }` (shadow mode) ⇒ dispatch proceeds; breaker `null` ⇒ proceeds.
  8. **worker_status:** empty ⇒ "No worker claims…"; seeded docs ⇒ one line each with id/status/claimant-name/age/80-char preview (seed a >80-char task; assert the line contains exactly the 80-char slice).
  9. **worker_cancel:** running own claim ⇒ flipped to `cancelled` + live abort called (after Task E wires liveWorkers — mark this sub-assertion to be finished in Task E) ; other boss's claim ⇒ "Not yours — … Jasper"; terminal claim ⇒ "Already finished (status: done)."; invalid id ⇒ "Claim not found".
  10. **Index pin:** `await pool.ensureIndexes()` ⇒ `createIndexCalls` contains `[{ threadId: 1, taskKey: 1 }, { unique: true, partialFilterExpression: { status: "running" } }]`, `[{ threadId: 1, status: 1 }, undefined]`, and `[{ updatedAt: 1 }, { expireAfterSeconds: 604800 }]`.
  11. **`normalizedTaskKey`:** case/whitespace-insensitive (`"Fetch Q2  numbers"` === `"fetch q2 numbers"`), distinct texts differ.

- [ ] **D3.** Do **not** commit yet — proceed to Task E (same files).

---

### Task E — Pool service part 2: spawn path, completion → re-entry, watchdog, restart sweep

- [ ] **E1.** Complete `src/workers/meeting-worker-pool.ts` with the remaining members (inside the class, plus module-level prompt builders):

```ts
  // -------------------------------------------------------------------------
  // Worker spawn path (spec §A3)
  // -------------------------------------------------------------------------

  /** Fetch-worker role — Part A's only WorkerRoleParams instantiation. */
  private async spawnFetchWorker(claim: WorkerClaimDoc): Promise<void> {
    const boss = this.deps.registry.get(claim.bossAgentId); // re-checked live
    if (!boss) {
      // Boss vanished between dispatch and spawn — terminal-fail the claim;
      // dispatchReentry's own guard will skip the notice (E6).
      await this.finishClaim(claim, { status: "failed", error: "boss config missing at spawn", durationMs: 0 });
      return;
    }
    const role: WorkerRoleParams = {
      model: this.deps.config.workerModel,
      coreServers: boss.coreServers.filter((s) => !WORKER_SERVER_DENYLIST.has(s)),
      maxTurns: this.deps.config.workerMaxTurns,
      timeoutMs: this.deps.config.workerTimeoutMs,
      charter: fetchWorkerCharter(boss, claim),
    };
    await this.runWorkerTurn(claim, boss, role);
  }

  /**
   * Role-parameterized worker turn (spec §A3 plan directive — KPR-409's
   * scribe reuses this with its own role object). Never throws; completion
   * (both outcomes) transitions the claim atomically and the finally always
   * clears the live-worker handle.
   *
   * NOT budget-accounted, lock-exempt, breaker-invisible, sessionless —
   * all by construction (see spec §A3 rationale).
   */
  private async runWorkerTurn(claim: WorkerClaimDoc, boss: AgentConfig, role: WorkerRoleParams): Promise<void> {
    const claimId = claim._id.toString();
    const startedAt = Date.now();
    try {
      // Server containment is TWO-part: this config clone strips the
      // explicitly-listed denylist servers, and the runner-side
      // suppressAutoInjectedServers flag (set inside buildWorkerAdapter,
      // Task G3) blocks the runner's unconditional auto-injection of
      // team/schedule/team-roster/skill-author/workflow — without the flag,
      // stripping them from coreServers would be a no-op
      // (effectiveCoreServerSet/filterCoreServers re-add them).
      const workerConfig: AgentConfig = {
        ...boss,
        model: role.model,
        coreServers: role.coreServers,
        delegateServers: [], // C19: workers never nest delegates
        schedule: [],        // paranoia — nothing reads it on this path, keep it inert
      };
      if (!this.manager) throw new Error("worker pool manager hooks not bound");
      const adapter = this.manager.buildWorkerAdapter(workerConfig);
      this.liveWorkers.set(claimId, { abort: () => adapter.abort(), bossAgentId: claim.bossAgentId });
      const result = await adapter.runTurn({
        prompt: workerTaskPrompt(claim),
        sessionId: undefined, // sessionless — fresh every time, `sessions` untouched
        workItemContext: workItemContextFromClaim(claim),
        resourceLimits: {
          maxTurns: role.maxTurns,
          timeoutMs: role.timeoutMs,
          budgetUsd: boss.budgetUsd, // operator's per-turn cost cap still binds
        },
        systemPromptOverride: role.charter, // total replacement — voice precedent
      });
      const durationMs = Date.now() - startedAt;
      if (result.aborted) {
        // Abort is always initiator-owned (worker_cancel flipped the status
        // first; stopAgent/shutdown leave the claim to the watchdog/restart
        // sweep, which own the honest notice). No transition, no re-entry.
        log.info("Worker aborted — claim left to its owning path", { claimId, durationMs });
        return;
      }
      if (result.timedOut) {
        await this.finishClaim(claim, {
          status: "failed",
          error: `worker timed out after ${role.timeoutMs}ms`,
          durationMs, costUsd: result.costUsd, toolCalls: result.toolCalls,
        });
        return;
      }
      if (result.error) {
        await this.finishClaim(claim, {
          status: "failed",
          error: result.error.slice(0, 2000),
          durationMs, costUsd: result.costUsd, toolCalls: result.toolCalls,
        });
        return;
      }
      await this.finishClaim(claim, {
        status: "done",
        resultText: truncateResult(result.text),
        durationMs, costUsd: result.costUsd, toolCalls: result.toolCalls,
      });
    } catch (err) {
      // finally-disciplined wrapper that never throws (spec §A3 completion).
      await this.finishClaim(claim, {
        status: "failed",
        error: String(err).slice(0, 2000),
        durationMs: Date.now() - startedAt,
      }).catch((e) => log.error("Worker completion write failed", { claimId, error: String(e) }));
    } finally {
      this.liveWorkers.delete(claimId);
    }
  }

  /** Atomic completion transition; drops the result if the claim already
   *  left `running` (expired/cancelled/restart-swept — E13). */
  private async finishClaim(
    claim: WorkerClaimDoc,
    outcome: {
      status: "done" | "failed";
      resultText?: string;
      error?: string;
      durationMs: number;
      costUsd?: number;
      toolCalls?: number;
    },
  ): Promise<void> {
    const claimId = claim._id.toString();
    const updated = await this.claims.findOneAndUpdate(
      { _id: claim._id, status: "running" },
      {
        $set: {
          status: outcome.status,
          ...(outcome.resultText !== undefined ? { resultText: outcome.resultText } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          durationMs: outcome.durationMs,
          ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
          ...(outcome.toolCalls !== undefined ? { toolCalls: outcome.toolCalls } : {}),
          updatedAt: this.now(),
        },
      },
    );
    if (!updated) {
      log.info("Worker result dropped (claim no longer running)", { claimId });
      return;
    }
    log.info(outcome.status === "done" ? "Worker completed" : "Worker failed", {
      claimId,
      durationMs: outcome.durationMs,
      costUsd: outcome.costUsd,
      toolCalls: outcome.toolCalls,
    });
    this.dispatchReentry(
      { ...claim, resultText: outcome.resultText, error: outcome.error },
      outcome.status,
    );
  }

  // -------------------------------------------------------------------------
  // Completion → boss re-entry (spec §A4)
  // -------------------------------------------------------------------------

  private dispatchReentry(
    claim: Pick<WorkerClaimDoc, "_id" | "threadId" | "source" | "taskText" | "bossAgentId" | "resultText" | "error">,
    status: "done" | "failed" | "expired",
  ): void {
    const claimId = claim._id.toString();
    // Boss-gone guard — LOAD-BEARING (E6): without it, a step-0 miss on a
    // conf-*-labeled item would fall through to resolveConferenceAgents and
    // fire a full classifier fan-out off a system item.
    const boss = this.deps.registry.get(claim.bossAgentId);
    if (!boss || boss.disabled) {
      log.warn("Worker re-entry skipped — boss agent gone or disabled", { claimId, bossAgentId: claim.bossAgentId });
      void this.claims
        .updateOne({ _id: claim._id }, { $set: { error: "re-entry skipped: boss agent gone or disabled", updatedAt: this.now() } })
        .catch((err) => log.error("Claim annotate failed", { claimId, error: String(err) }));
      return;
    }
    const item: WorkItem = {
      id: `worker:${claimId}`, // unique per claim — dispatcher dedup-safe; fires at most once (atomic transition gates)
      text: workerReportPrompt(claim, status),
      source: {
        kind: (claim.source.channelKind || "slack") as ChannelKind,
        id: claim.source.channelId,
        label: claim.source.channelLabel,
        adapterId: claim.source.adapterId,
      },
      sender: "system",
      threadId: claim.threadId,
      timestamp: this.now(),
      meta: {
        slackTs: claim.source.slackTs,
        slackThreadTs: claim.source.slackThreadTs,
        targetAgentId: claim.bossAgentId,
      },
    };
    try {
      this.deps.onDispatch(item);
    } catch (err) {
      log.error("Worker re-entry dispatch threw", { claimId, error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Watchdog + restart sweep (spec §A2)
  // -------------------------------------------------------------------------

  /** 60s interval: flip past-deadline running claims to expired (atomic),
   *  abort any live handle, honest re-entry notice. */
  private async sweepExpired(): Promise<void> {
    const nowDate = this.now();
    const stale = await this.claims.find({ status: "running", expiresAt: { $lt: nowDate } }).toArray();
    for (const claim of stale) {
      await this.expireClaim(claim, "claim TTL expired");
    }
  }

  /** Boot sweep: a fresh process can never have live workers, so every
   *  running claim is an orphan — flip unconditionally with notice (E5). */
  private async sweepOnRestart(): Promise<void> {
    const orphans = await this.claims.find({ status: "running" }).toArray();
    for (const claim of orphans) {
      await this.expireClaim(claim, "engine restarted mid-worker");
    }
  }

  private async expireClaim(claim: WorkerClaimDoc, reason: string): Promise<void> {
    const claimId = claim._id.toString();
    const updated = await this.claims.findOneAndUpdate(
      { _id: claim._id, status: "running" },
      { $set: { status: "expired" as const, error: reason, updatedAt: this.now() } },
    );
    if (!updated) return; // completion or cancel won the race — theirs now
    const live = this.liveWorkers.get(claimId);
    if (live) {
      try {
        live.abort();
      } catch (err) {
        log.warn("Worker abort threw in expiry — contained", { claimId, error: String(err) });
      }
      this.liveWorkers.delete(claimId);
    }
    log.info("Worker claim expired", { claimId, reason, bossAgentId: claim.bossAgentId });
    this.dispatchReentry({ ...claim, error: reason }, "expired");
  }
```

  And the module-level helpers (bottom of the file, exported for test pinning):

```ts
// ---------------------------------------------------------------------------
// Prompt builders (exported for byte pins in tests)
// ---------------------------------------------------------------------------

/** Charter — lean, TOTAL systemPromptOverride replacement: no soul, no
 *  constitution (cheap + focused). The no-posting rule is information here;
 *  the ENFORCEMENT is the denylist (code-enforce-don't-prose-enforce). */
export function fetchWorkerCharter(boss: AgentConfig, claim: WorkerClaimDoc): string {
  return [
    `You are a background research worker acting for ${boss.name} during a meeting in #${claim.source.channelLabel}.`,
    ``,
    `Task:`,
    claim.taskText,
    ``,
    `Return contract: reply with a concise, factual, self-contained report — it will be relayed to the meeting by ${boss.name}. Include concrete numbers, quotes, and file paths where relevant. Say clearly if you could not complete the task.`,
    ``,
    `You have no messaging tools; your final message IS the deliverable.`,
  ].join("\n");
}

export function workerTaskPrompt(claim: WorkerClaimDoc): string {
  return `${claim.taskText}\n\nReply with your report now — concise, factual, self-contained.`;
}

/** Re-entry report prompt. Escape phrase matches NON_RESPONSE_PATTERNS[0]
 *  exactly (C4-coherent — a stale finding suppresses on the existing
 *  single-dispatch isNonResponse branch). */
export function workerReportPrompt(
  claim: Pick<WorkerClaimDoc, "taskText" | "resultText" | "error">,
  status: "done" | "failed" | "expired",
): string {
  const body =
    status === "done"
      ? claim.resultText ?? "(empty report)"
      : status === "failed"
        ? `The worker failed: ${claim.error ?? "unknown error"}`
        : "The worker did not finish in time — re-dispatch if the room still needs it.";
  return `[Worker report — ${status}] Task: ${claim.taskText}\n\n${body}\n\nYou dispatched this worker during the meeting in this thread. Interpret the finding and post what the room needs, as yourself — do not paste the raw report verbatim if a summary serves better. If the meeting has moved on and this is no longer useful, reply "No response needed."`;
}

export function workItemContextFromClaim(claim: WorkerClaimDoc): {
  adapterId: string; channelId: string; channelKind: string; channelLabel: string;
  threadId: string; slackTs: string; slackThreadTs: string;
} {
  return {
    adapterId: claim.source.adapterId,
    channelId: claim.source.channelId,
    channelKind: claim.source.channelKind,
    channelLabel: claim.source.channelLabel,
    threadId: claim.threadId,
    slackTs: claim.source.slackTs,
    slackThreadTs: claim.source.slackThreadTs,
  };
}

function truncateResult(text: string): string {
  return text.length <= RESULT_TEXT_CAP ? text : `${text.slice(0, RESULT_TEXT_CAP)}\n…[truncated at ${RESULT_TEXT_CAP} chars]`;
}
```

  Type notes: `ChannelKind` must be exported from `src/types/work-item.ts` (it is — the scheduler imports it). All agent-runner-adjacent imports are `import type` (cycle-safe erasure). `RunResult` reaches the pool only through `AgentProviderAdapter.runTurn`'s return type — no direct agent-runner import needed.

- [ ] **E2.** Extend `src/workers/meeting-worker-pool.test.ts` with Task-E assertions. To reach the spawn synchronously in tests, add a tiny helper: after `await pool.dispatch(...)`, `await vi.waitFor(() => expect(fixture.runTurn).toHaveBeenCalled())` (the spawn is `void`-detached), or export nothing extra — the fake adapter's `runTurn` resolving lets `await new Promise(setImmediate)` flush the chain. Assertions:
  1. **(T3 spawn shape — config-array half; necessary but NOT sufficient)** after a successful dispatch: `hooks.buildWorkerAdapter` called once with a config where `model === "sonnet"` (from config, boss is `"opus"`), `coreServers` deep-equals `["memory", "code-search"]` (denylist stripped `slack/callback/worker-pool/background/keychain`; memory + code-search survive), `delegateServers` deep-equals `[]`, `schedule` deep-equals `[]`, and `id === "boss"` (identity clone). `runTurn` received `sessionId: undefined`, `resourceLimits: { maxTurns: 25, timeoutMs: 600000, budgetUsd: 2.5 }`, a `systemPromptOverride` containing the boss name, channel label, and the task text, and a `workItemContext` matching the claim's source seven. **The authoritative structural pin — that the worker runner's BUILT server set omits the auto-injected `team`/`schedule`/`team-roster` — cannot live here (the pool suite sees only a fake adapter); it lives in Task G5's runner/manager tests against `buildInProcessServers`.**
  2. **(T4 done)** default `runTurn` result ⇒ claim doc `status: "done"`, `resultText: "report body"`, `durationMs`/`costUsd`/`toolCalls` stamped; `onDispatch` called exactly once with the **byte-pinned** WorkItem: `id === \`worker:${claimId}\``, `sender: "system"`, `threadId`, `source: { kind: "slack", id: "C123", label: "conf-tahoe", adapterId: "slack-main" }`, `meta: { slackTs, slackThreadTs, targetAgentId: "boss" }`, `text` starting `"[Worker report — done] Task: "` and containing the report body and the `"No response needed."` escape sentence.
  3. **(T4 failed)** `runTurnImpl` resolving `{ text: "", error: "boom", … }` ⇒ `status: "failed"`, report text contains `"The worker failed: boom"`.
  4. **(T4 timeout)** `timedOut: true` ⇒ `failed` with `"timed out after 600000ms"` in the claim error.
  5. **(T4 drop pin)** flip the claim to `expired` (simulate watchdog) **before** the fake `runTurn` resolves (use a deferred promise) ⇒ after resolution, claim stays `expired`, resultText **absent**, `onDispatch` NOT called by the completion path.
  6. **(T4 truncation, E12)** `runTurn` text of 9000 chars ⇒ `resultText.length` ≈ 8000 + marker, marker present.
  7. **(T5 boss-gone)** delete the boss from the fixture registry between dispatch and completion ⇒ `onDispatch` **never called at all** (not merely "not called with an unpinned item" — the guard returns before item construction), claim error annotated `"re-entry skipped: boss agent gone or disabled"`; same for `disabled: true`.
  8. **(T6 watchdog — interval path, NOT the restart sweep)** ordering matters: `pool.start()` runs `sweepOnRestart()` (which flips EVERY running claim unconditionally) **before** installing the interval, so a pre-seeded claim would be expired by the restart sweep and the 60s interval + `expiresAt` predicate would stay uncovered. Boundary arithmetic also matters: the sweep predicate is strict (`expiresAt < now`, and the fake matcher mirrors it), so a TTL that lands `expiresAt` exactly on an interval tick never fires on that tick. Correct recipe: `vi.useFakeTimers()`; build the fixture with a **directly-constructed test config** `{ claimTtlMinutes: 1.5 }` ⇒ `expiresAt = dispatch + 90_000` (the resolver's TTL≥wallclock clamp does not apply to injected configs) and a never-resolving `runTurnImpl`; `await pool.start()` on the **empty** ledger (assert `onDispatch` not called — restart sweep no-ops); `await pool.dispatch(...)` (claim created, worker live; fake timers mock `Date`, so the pool's default `now` seam advances with them); `await vi.advanceTimersByTimeAsync(60_000)` ⇒ the interval **has genuinely fired once** and the predicate was false (`90_000 < 60_000`) — claim still `running`, no `onDispatch` (a real predicate-false pin, not "no tick yet"); `await vi.advanceTimersByTimeAsync(60_000)` again (tick at T=120s, `90_000 < 120_000` true) ⇒ claim `status: "expired"`, `abortSpy` called, exactly **one** `onDispatch` with `text` starting `"[Worker report — expired]"` and containing the re-dispatch sentence.
  9. **(T6 restart sweep)** construct a fresh pool over a claims fake pre-seeded with 2 `running` + 1 `done` docs; `await pool.start()` ⇒ both running docs `expired` with notices (2 `onDispatch` calls), `done` doc untouched.
  10. **(T8 pool half)** two live workers for different bosses ⇒ `abortForBoss("boss")` aborts only boss's (`abortSpy` call count scoped). Separately, with the item-8 recipe (empty start, fake timers, short TTL, live never-resolving worker): `pool.stop()` aborts all, then `await vi.advanceTimersByTimeAsync(120_000)` ⇒ the past-deadline claim is **still `running`** and `onDispatch` was never called — proving the interval is actually cleared (with the old pre-seed recipe this assertion was blind: the restart sweep would already have expired the claim).
  11. **(worker aborted)** `runTurn` resolves `{ aborted: true, … }` ⇒ **no** status transition (claim still `running`), no `onDispatch` — the claim is owned by the cancel/watchdog path (spec E5/E13 coherence).
  12. **(cancel + abort, completing D's deferred sub-assertion)** dispatch with deferred `runTurn`; `pool.cancel(claimId, "boss")` ⇒ status `cancelled`, `abortSpy` called; then resolve the deferred with a success result ⇒ claim stays `cancelled` (completion dropped).

- [ ] **E3.** Verify:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/workers/
# expect: 2 files (dedup + pool), ~32 passed, 0 failed
npm run typecheck && npm run lint
```

- [ ] **E4.** Commit (Tasks D+E together): `feat(workers): meeting worker pool — claim ledger, atomic dispatch, detached spawn, re-entry, watchdog (KPR-390)`

---

### Task F — In-process MCP server `src/workers/worker-pool-mcp-server.ts`

- [ ] **F1.** Create the server (callback-server template — thin handlers, every one try/caught returning structured errors; all business logic lives in the pool):

```ts
/**
 * KPR-390: worker-pool MCP server — in-process via createSdkMcpServer
 * (callback-server template). 3 tools; per-turn channel/thread metadata
 * flows through a mutable context ref the runner refreshes each turn.
 * All handlers try/caught returning structured errors (in-process
 * convention — a handler exception must never crash the hive).
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MeetingWorkerPool, WorkerPoolTurnContext } from "./meeting-worker-pool.js";

export interface WorkerPoolToolDeps {
  pool: MeetingWorkerPool;
  agentId: string;
  context: { current: WorkerPoolTurnContext };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

export function buildWorkerPoolTools(deps: WorkerPoolToolDeps) {
  const { pool, agentId, context } = deps;
  return [
    tool(
      "worker_dispatch",
      "Dispatch a background worker to fetch data or do legwork for this meeting. Returns immediately — end your turn after telling the room you've sent someone; you will be re-triggered in this thread with the worker's report. Meeting-only. Checks the claim ledger first: if an equivalent task is already in progress you get the claimant's name instead of a new worker.",
      {
        task: z
          .string()
          .min(10)
          .describe(
            "What to fetch/do AND what to return; self-contained (the worker has your tools but not this conversation).",
          ),
      },
      async ({ task }) => {
        try {
          return ok(await pool.dispatch({ bossAgentId: agentId, task, context: context.current }));
        } catch (err) {
          return fail(`worker_dispatch error: ${String(err)}`);
        }
      },
    ),
    tool(
      "worker_status",
      "List this meeting's worker claims (running and recently finished).",
      {},
      async () => {
        try {
          const threadId = context.current.threadId;
          if (!threadId) return fail("worker_status: no thread context on this turn.");
          return ok(await pool.status(threadId));
        } catch (err) {
          return fail(`worker_status error: ${String(err)}`);
        }
      },
    ),
    tool(
      "worker_cancel",
      "Cancel a running worker claim you dispatched.",
      { claimId: z.string().describe("The claim id from worker_dispatch or worker_status.") },
      async ({ claimId }) => {
        try {
          return ok(await pool.cancel(claimId, agentId));
        } catch (err) {
          return fail(`worker_cancel error: ${String(err)}`);
        }
      },
    ),
  ];
}

export function createWorkerPoolMcpServer(deps: WorkerPoolToolDeps) {
  return createSdkMcpServer({
    name: "worker-pool",
    version: "1.0.0",
    tools: buildWorkerPoolTools(deps),
  });
}
```

- [ ] **F2.** Create `src/workers/worker-pool-mcp-server.test.ts` (clone the callback test's SDK mock + `getHandler` helper; fake pool = `{ dispatch: vi.fn(), status: vi.fn(), cancel: vi.fn() }`). Assertions (~8):
  1. three tools registered with the exact names;
  2. `worker_dispatch` passes `{ bossAgentId: <deps.agentId>, task, context: <ref.current> }` and returns the pool's text;
  3. mutable-ref pin: mutate `ctx.current` between calls ⇒ second dispatch sees the new context (callback-precedent test shape);
  4. pool.dispatch rejects ⇒ `isError: true` with `worker_dispatch error:` prefix (structured-error convention — never throws);
  5. `worker_status` uses `context.current.threadId`; missing threadId ⇒ `isError` without calling the pool;
  6. `worker_status` pool text passthrough;
  7. `worker_cancel` passes `(claimId, agentId)`;
  8. `worker_cancel` rejection ⇒ structured error.
- [ ] **F3.** Verify: `npx vitest run src/workers/` (env stubs) — all passed. `npm run typecheck && npm run lint`.
- [ ] **F4.** Commit: `feat(workers): worker-pool in-process MCP server — 3 tools, context-ref template (KPR-390)`

---

### Task G — Engine wiring: in-process registry constant, AgentRunner, AgentManager, index.ts

- [ ] **G1.** `src/agents/in-process-servers.ts` — add `"worker-pool"` to `IN_PROCESS_PORTED_SERVERS` and update the doc comment's first line from "the 10 KPR-122-ported in-process MCP servers" to "the KPR-122-ported in-process MCP servers, plus later in-process servers (KPR-390: worker-pool)". KPR-184 enforcement (admin-tool rejection + registry sanitization of `delegateServers`) then covers worker-pool for free — **and so does the plugin name-conflict guard** (agent-runner.ts:866 checks `IN_PROCESS_PORTED_SERVERS.has(name)` directly, the KPR-327 memory compensation's first dependent); of KPR-327's two compensation sites only `buildToolTransportInventory` needs an explicit block (G2).
- [ ] **G1b.** `src/agents/server-traits.ts` — add `"worker-pool"` to `TURN_CONTEXT_DEPENDENT_SERVERS` (it is context-ref driven, exactly like `callback`). Consequences are all correct: inventory descriptors carry `requiresTurnContext: true` (compatibility stays `requires-hive-bridge`, same bucket as any in-process server), and `DELEGATE_UNSAFE_SERVERS` picks it up (redundant with KPR-184, harmless).
- [ ] **G2.** `src/agents/agent-runner.ts`:
  - Add imports (type-only where possible):

    ```ts
    import { createWorkerPoolMcpServer } from "../workers/worker-pool-mcp-server.js";
    import type { MeetingWorkerPool, WorkerPoolTurnContext } from "../workers/meeting-worker-pool.js";
    ```
  - `AgentRunnerOptions` (~line 311) gains **two** members:

    ```ts
      /** KPR-390: meeting worker pool — set by AgentManager.createProviderAdapter
       *  once index.ts has wired the pool. Absent ⇒ the worker-pool in-process
       *  server is never built (tools invisible even if listed in coreServers). */
      workerPool?: MeetingWorkerPool;
      /** KPR-390: worker-mode runner (set ONLY by the pool's buildWorkerAdapter
       *  factory). Suppresses the unconditional auto-injection of implicit core
       *  servers (schedule, team, team-roster, skill-author, workflow) at all
       *  three sync sites — effectiveCoreServerSet, filterCoreServers,
       *  autoInjectedServerNames — AND the teamRoster wiring. Without this,
       *  stripping those names from a worker's cloned coreServers is a no-op
       *  and through-the-boss enforcement is fiction: `team` alone lets a
       *  worker message an agent that posts to Slack, and `skill-author` is a
       *  live stdio subprocess. */
      suppressAutoInjectedServers?: boolean;
    ```
    (Spec §A1 names the positional teamRoster/memoryLifecycle precedent; routing through the existing `runnerOptions` object is the same constructor-dep contract with zero churn on the many existing positional call sites — mechanical sharpening, flagged in the plan digest.)
  - Fields (beside `callbackContextRef`, ~line 343):

    ```ts
    private workerPoolMcpServer?: ReturnType<typeof createWorkerPoolMcpServer>;
    private workerPoolContextRef: { current: WorkerPoolTurnContext } = { current: {} };
    private workerPool?: MeetingWorkerPool;
    private readonly suppressAutoInjectedServers: boolean;
    ```
    Constructor body: `this.workerPool = runnerOptions?.workerPool;` and `this.suppressAutoInjectedServers = runnerOptions?.suppressAutoInjectedServers ?? false;`
  - **`effectiveCoreServerSet()` (~line 410–432) — gate the implicit adds** (memory→structured-memory pairing and the autonomy gates stay unconditional):

    ```ts
    const coreSet = new Set(this.agentConfig.coreServers);
    if (coreSet.has("memory")) {
      coreSet.add("structured-memory");
    }
    // KPR-390: worker-mode runners get NO implicit core servers — the
    // auto-injected surfaces (team = outbound agent-to-agent messaging,
    // schedule = self-scheduling) are exactly what WORKER_SERVER_DENYLIST
    // exists to remove, and they are re-added here for every normal agent.
    if (!this.suppressAutoInjectedServers) {
      coreSet.add("schedule");
      coreSet.add("team");
      coreSet.add("team-roster");
      if (config.workflow.enabled) {
        coreSet.add("workflow");
      }
    }
    ```
    (Keep the existing autonomy-gate `delete` lines below unchanged.)
  - **`filterCoreServers()` (~line 1073–1094) — mirror the same gate** (the file's own comment mandates the sync): wrap the `coreSet.add("schedule") / add("team") / add("team-roster") / add("skill-author")` lines and the `workflow` conditional in the identical `if (!this.suppressAutoInjectedServers) { … }` block, preserving each existing comment line inside it. **This is the only gate guarding a LIVE surface:** `skill-author` is a real, bundled, spawnable stdio server (config ~line 1039, in `MCP_BUNDLE_MAP`) injected ONLY here — never via `effectiveCoreServerSet` — so without this gate a worker gets a live skill-author subprocess (authoring skills as the boss, persisting past the worker's death) plus vestigial team/schedule stdio slots. Its test pin is the inventory assertion in G5.c (buildToolTransportInventory iterates this method's output).
  - **`autoInjectedServerNames()` (~line 1176) — the spec's THIRD sync site, gated via instance conversion.** It is currently `private static` and cannot read the flag; both call sites (:388 in `buildSystemPrompt`'s buildContext, :1256 in `buildToolTransportInventory`) are instance contexts, so convert it to a `private` instance method and gate it:

    ```ts
    private autoInjectedServerNames(): ReadonlySet<string> {
      // (existing doc comment retained)
      // KPR-390: worker-mode runners auto-inject nothing — mirror of the
      // effectiveCoreServerSet/filterCoreServers gates (three-site sync).
      if (this.suppressAutoInjectedServers) return new Set<string>();
      const set = new Set<string>(["schedule", "team", "team-roster", "skill-author"]);
      if (config.workflow.enabled) set.add("workflow");
      return set;
    }
    ```
    Update both call sites from `AgentRunner.autoInjectedServerNames()` to `this.autoInjectedServerNames()`. No behavior change for normal runners (flag false ⇒ identical set); for worker runners the :1256 inventory source-classification stays coherent with the gated filterCoreServers output, and the :388 toolkit classification is bypassed anyway (charter `systemPromptOverride`).
  - **`buildInProcessServers` team-roster block (~line 1376)** — gate: `if (this.teamRoster && !this.suppressAutoInjectedServers) { … }` (a worker runner receives `this.teamRoster` from the manager's construction inputs; without the gate it would be wired unconditionally).
  - **`buildToolTransportInventory` (~line 1290) — Lane B visibility compensation (KPR-327 memory pattern).** `worker-pool` has no vestigial stdio entry in `buildAllServerConfigs` (and must not get one — nothing to spawn), so without compensation it is absent from `filterCoreServers`' output and therefore from the Lane B partition: a Lane B conference boss would never see `worker_dispatch`. Add directly after the existing `memory` compensation block, gated exactly like the runtime block in `buildInProcessServers`:

    ```ts
    // KPR-390: worker-pool is in-process-only with no stdio placeholder
    // (KPR-327 memory pattern) — surface its descriptor explicitly so the
    // Lane B partition (assembleProviderTurn → partitionInventoryForProvider)
    // bridges the tools. Gate mirrors the runtime wiring in send().
    if (this.workerPool && this.shouldEnableInProcessServer("worker-pool") && !mcpServers["worker-pool"]) {
      inventory.push({
        ...classifyToolTransport({
          name: "worker-pool",
          transport: "sdk-in-process",
          source: "core",
          requiresTurnContext: TURN_CONTEXT_DEPENDENT_SERVERS.has("worker-pool"),
          requiresHiveRuntime: true,
          inProcess: true,
        }),
        schemas: { kind: "connect-time" },
      });
    }
    ```
    Also update the team-roster inventory push just below it to carry the same worker-mode gate (`if (this.teamRoster && !this.suppressAutoInjectedServers)`) for coherence with the runtime wiring.
  - `buildInProcessServers` (place the block directly after the callback block, ~line 1512):

    ```ts
    // KPR-390: worker-pool MCP — in-process. Meeting bosses dispatch detached
    // fetch-workers; per-turn source metadata flows through
    // workerPoolContextRef (callback template). Gated on the pool being wired
    // (index.ts) AND coreServers membership — Day-1-OOB layer 2: shipping the
    // engine changes nothing until the operator adds "worker-pool" to a
    // boss's coreServers. Lane B reaches these tools through the KPR-348
    // bridge like every other in-process server — no adapter changes.
    if (this.workerPool && this.shouldEnableInProcessServer("worker-pool")) {
      this.workerPoolContextRef.current = {
        adapterId: context?.adapterId,
        channelId: context?.channelId,
        channelKind: context?.channelKind,
        channelLabel: context?.channelLabel,
        threadId: context?.threadId,
        slackTs: context?.slackTs,
        slackThreadTs: context?.slackThreadTs,
      };
      if (!this.workerPoolMcpServer) {
        this.workerPoolMcpServer = createWorkerPoolMcpServer({
          pool: this.workerPool,
          agentId: this.agentConfig.id,
          context: this.workerPoolContextRef,
        });
      }
      servers["worker-pool"] = this.workerPoolMcpServer;
    }
    ```
- [ ] **G3.** `src/agents/agent-manager.ts`:
  - Imports: `import type { MeetingWorkerPool } from "../workers/meeting-worker-pool.js";` and add `type AgentRunnerOptions` to the existing agent-runner import.
  - Field: `private workerPool?: MeetingWorkerPool;`
  - New method (near `setRetryQueue`-style setters / after the constructor):

    ```ts
    /**
     * KPR-390: wire the meeting worker pool (index.ts, post-dispatcher).
     * The handshake keeps runner-construction inputs inside the manager —
     * the pool holds only capabilities (spec §A3 "factory callback" choice).
     * The factory deliberately passes NO prefixCache (worker turns provably
     * can't touch the boss's cached prefix), NO workerPool (a worker can
     * never see worker-pool tools even if a config clone slipped the
     * denylist — belt-and-braces recursion guard), and sets
     * suppressAutoInjectedServers — WITHOUT which the runner re-adds
     * team/schedule/team-roster unconditionally and the denylist strip in
     * runWorkerTurn is a no-op (through-the-boss would be fiction).
     */
    setWorkerPool(pool: MeetingWorkerPool): void {
      this.workerPool = pool;
      pool.bindManager({
        buildWorkerAdapter: (workerConfig) => {
          const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
          const runner = new AgentRunner(
            workerConfig,
            this.memoryManager,
            this.plugins,
            this.skillIndex,
            eventSubscribersJson,
            this.prefetcher,
            this.teamRoster,
            this.db,
            undefined, // prefixCache — deliberately absent
            this.memoryLifecycle,
            { suppressAutoInjectedServers: true }, // worker mode — no workerPool
          );
          return new ClaudeAgentAdapter(runner);
        },
        breakerStateFor: (provider) => this.circuitBreakers.stateFor(provider),
      });
    }
    ```
  - `createProviderAdapter` (~line 632): replace the runner construction's final argument:

    ```ts
    const runnerOptions: AgentRunnerOptions | undefined =
      laneAPassthrough || this.workerPool
        ? { laneAPassthrough, workerPool: this.workerPool }
        : undefined;
    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle, runnerOptions);
    ```
  - `stopAgent` (~line 2137): after `this.stoppedAgents.add(agentId);` add:

    ```ts
    // KPR-390: abort this boss's live meeting workers (claims stay `running`;
    // the watchdog/restart sweep own the honest expiry notice).
    this.workerPool?.abortForBoss(agentId);
    ```
- [ ] **G4.** `src/index.ts`:
  - Import: `import { MeetingWorkerPool } from "./workers/meeting-worker-pool.js";`
  - After the scheduler start block (~line 733; dispatcher + agentManager both live), add:

    ```ts
    // KPR-390: meeting worker pool — constructed after the dispatcher
    // (scheduler-seam precedent, breaks the manager↔dispatcher cycle).
    const workerPool = new MeetingWorkerPool({
      db,
      registry,
      config: config.meetingWorkers,
      onDispatch: (item) => {
        dispatcher.dispatch(item).catch((err) => {
          log.error("Worker re-entry dispatch failed", { error: String(err) });
        });
      },
    });
    agentManager.setWorkerPool(workerPool);
    await workerPool.start(); // indexes + restart sweep + watchdog
    log.info("Meeting worker pool started", {
      enabled: config.meetingWorkers.enabled,
      maxConcurrent: config.meetingWorkers.maxConcurrent,
      perMeetingMax: config.meetingWorkers.perMeetingMax,
    });
    ```
  - Shutdown handler (~line 856, beside `scheduler.stop()`): add `workerPool.stop();`
- [ ] **G5.** Tests:
  - `src/agents/agent-runner.test.ts` (+4, following the file's runner-construction fixtures):
    - (a) a runner with `coreServers: ["worker-pool"]` and `runnerOptions.workerPool` = a fake pool object ⇒ `buildInProcessServers(ctx)` returns a map containing `"worker-pool"`, and the context ref (reach it via the captured `createSdkMcpServer` deps if the suite mocks the SDK, or assert presence + call again with a different ctx and assert refresh through the tools' deps object) reflects the seven;
    - (b) same coreServers but **no** `workerPool` option ⇒ key absent (and: workerPool set but `coreServers: []` ⇒ absent — membership gate);
    - (c) **(BLOCKING-1 pin — worker-mode suppression is structural, BOTH surfaces)** a runner with `suppressAutoInjectedServers: true`, `coreServers: ["memory", "contacts"]`, a fake `db`, and a `teamRoster` passed ⇒ `buildInProcessServers()` map **omits `"team"`, `"schedule"`, `"team-roster"`, and `"workflow"`** while containing `"memory"`/`"structured-memory"`/`"contacts"`; **AND** the same runner's `buildToolTransportInventory()` — which iterates `filterCoreServers`' output and is the ONLY test surface that can see the `filterCoreServers` mirror gate — contains **no entry named `team`, `schedule`, `team-roster`, or `skill-author`** (the spec-T3 union pin: filterCoreServers output ∪ buildInProcessServers keys). An otherwise-identical control runner without the flag **contains** `"team"`/`"schedule"`/`"team-roster"` in the map and `skill-author` (live stdio) + the vestigial `team`/`schedule` entries in the inventory. Without the inventory half, reverting the `filterCoreServers` gate alone ships a live skill-author subprocess into every worker with all suites green — the exact vacuous-green failure this pin closes;
    - (d) **(BLOCKING-2 pin — Lane B inventory)** a runner with `runnerOptions.workerPool` + `coreServers: ["worker-pool"]` ⇒ `buildToolTransportInventory()` contains an entry `name === "worker-pool"` with `inProcess: true`, `requiresTurnContext: true`, and `compatibility.openai === compatibility.gemini === compatibility.codex === "requires-hive-bridge"`; without the `workerPool` option (or without coreServers membership) ⇒ absent. Fails without the G2 compensation block (worker-pool has no stdio placeholder, so the base loop never emits it).
  - `src/agents/agent-manager.test.ts` (+3, **whole-file runs only**): (a) `setWorkerPool` calls `bindManager` with hooks whose `breakerStateFor("claude")` proxies `circuitBreakers.stateFor`; (b) **(end-to-end worker-mode pin)** `hooks.buildWorkerAdapter(config with coreServers: ["memory"])` returns an adapter with `provider === "claude"` whose runner (reach it via `(adapter as unknown as { runner: AgentRunner }).runner`) has `buildInProcessServers()` **omitting `team`/`schedule`/`team-roster` AND `worker-pool`** (the factory sets the suppression flag and withholds the pool — recursion guard) — fails if the factory drops `{ suppressAutoInjectedServers: true }`. **Fixture requirement: the manager under test must be constructed with a fake `db`** — every in-process block in `buildInProcessServers` gates on `this.db`, so a db-less fixture makes this pin vacuously green (and NV6's first probe would confusingly fail-to-fail at revert time); (c) `stopAgent("a")` invokes `workerPool.abortForBoss("a")` (fake pool with spies).
- [ ] **G6.** Verify:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts src/agents/agent-registry.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
# expect: agent-manager 248 passed (245 + 3); runner/registry all green (registry's
# KPR-184 sanitizer tests must pass unmodified — worker-pool joins the strip set)
npm run typecheck && npm run lint
```

- [ ] **G7.** Commit: `feat(agents): wire worker-pool — in-process registry, runner block, manager handshake, index lifecycle (KPR-390)`

---

### Task H — Outage policy: `worker:` ⇒ silent

- [ ] **H1.** `src/outage/outage-notices.ts` `policyFor` (~line 23) — add after the `team-` line:

```ts
  if (id.startsWith("worker:")) return "silent"; // KPR-390: one-shot boss re-entry, claim already terminal — queue preserves it
```

- [ ] **H2.** `src/outage/outage-notices.test.ts` — add a table row beside the existing prefixes: `expect(policyFor(item({ id: "worker:65a1b2c3d4" }))).toBe("silent");`
- [ ] **H3.** Verify: `npx vitest run src/outage/outage-notices.test.ts` (env stubs) — **13 passed**.
- [ ] **H4.** Commit: `feat(outage): worker re-entry items queue silently during provider outages (KPR-390)`

---

### Task I — Documentation

- [ ] **I1.** `docs/providers.md` — spec calls for one additive row/note. **Conclusion: providers.md MUST be updated** (this change adds tools visible on every tool-executing lane and pins worker execution to the Claude lane — provider-behavior surface). The note's "all tool-executing lanes" claim is made true by Task G2's Lane B inventory compensation — do not land this doc commit before commit 6. Add a short note section after the parity matrix (before Footnotes):

```markdown
### Meeting worker pool (KPR-390)

The `worker-pool` in-process MCP tools (`worker_dispatch` / `worker_status` / `worker_cancel`) are available on **all tool-executing lanes** — Claude and Lane A directly, Lane B through the tool bridge like every other in-process server. **Dispatched workers themselves always run on the Claude lane** (sonnet-pinned by default via `meetingWorkers.workerModel`), regardless of the dispatching boss's lane. Worker spawns are sessionless, breaker-invisible, and not `spawnBudget`-accounted; their measurement surface is the `meeting_worker_claims` collection.
```

- [ ] **I2.** `CLAUDE.md`:
  - MongoDB collections list: add `meeting_worker_claims` (`… meeting worker-pool claim ledger KPR-390 — per-meeting atomic task claims incl. worker cost/duration; partial-unique (threadId, taskKey) on running; 7d TTL housekeeping`) to the engine-written list.
  - MCP servers list: add `workers/worker-pool-mcp-server.ts — meeting worker pool: dispatch detached fetch-workers with claim ledger (KPR-390) [in-process]`.
  - KPR-184 constraint paragraph: the ported-server list gains `worker-pool` (update the "the 10 KPR-122-ported MCPs" phrasing to include it, mirroring the constant's comment).
- [ ] **I3.** Verify: `npm run format` (docs prettier), `git diff --stat` shows only docs files.
- [ ] **I4.** Commit: `docs: worker-pool provider note, meeting_worker_claims collection, KPR-184 list (KPR-390)`

---

### Task J — Negative-verify pass (no commit)

For each expected-FAIL probe: make the temporary edit, run the named suite, **confirm the named test fails**, then `git checkout -- <file>` and re-run to green. Confirm `git status` clean after the pass.

**Expected-FAIL probes (revert-the-fix ⇒ new test must fail):**

- [ ] **NV1 (T7):** remove the `worker:` line from `policyFor` → `npx vitest run src/outage/outage-notices.test.ts` — the new row fails (`"notify"` ≠ `"silent"`). Restore.
- [ ] **NV2 (T1):** in `dispatch`, replace the duplicate-key catch branch with a bare `throw err` (no winner read) → pool suite: the concurrent-identical-dispatch test fails (rejection instead of claimed-by text). Restore.
- [ ] **NV3 (T3 config-array half):** in `spawnFetchWorker`, build the role with `coreServers: boss.coreServers` (drop the filter) and `model: boss.model` → pool suite: the spawn-shape test fails (boss model/servers leak through — the spec's named leak). Restore. (This probe alone is NOT sufficient for through-the-boss — NV6 covers the auto-injection half.)
- [ ] **NV4 (T5):** in `dispatchReentry`, delete the boss-gone guard block → pool suite: the boss-gone test fails (`onDispatch` called). Restore.
- [ ] **NV5 (T4 atomicity):** in `finishClaim`, change the filter to `{ _id: claim._id }` (drop `status: "running"`) → pool suite: the completion-after-expiry drop test fails (claim overwritten to `done`, re-entry fired). Restore.
- [ ] **NV6 (BLOCKING-1 flag, three stages):** (i) remove `{ suppressAutoInjectedServers: true }` from `setWorkerPool`'s `buildWorkerAdapter` factory → `npx vitest run src/agents/agent-manager.test.ts` (whole file): the end-to-end worker-mode pin (G5.b) fails (`team`/`schedule`/`team-roster` present in the worker runner's built server set). Restore. (ii) delete the `if (!this.suppressAutoInjectedServers)` gate in `effectiveCoreServerSet` (revert to unconditional adds) → `npx vitest run src/agents/agent-runner.test.ts`: the suppression pair's `buildInProcessServers` half (G5.c) fails. Restore. (iii) **delete the `filterCoreServers` mirror gate only** (revert its adds to unconditional, leaving the other two sites gated) → `npx vitest run src/agents/agent-runner.test.ts`: the **inventory containment half** of G5.c fails (`skill-author` + vestigial `team`/`schedule` entries appear in the worker-flagged runner's `buildToolTransportInventory()`). This is the probe that proves the live-surface gate is independently pinned — before this round, reverting exactly this gate left every suite green. Restore.
- [ ] **NV7 (BLOCKING-2 compensation):** delete the `worker-pool` compensation block in `buildToolTransportInventory` → `npx vitest run src/agents/agent-runner.test.ts`: the inventory pin (G5.d) fails (entry absent ⇒ Lane B partition would omit the tools). Restore.

**Expected-PASS control (behavior-preserving edit ⇒ suites stay green, demonstrating the pins target behavior, not incidentals):**

- [ ] **NV8:** rename the private method `sweepExpired` → `sweepExpiredClaims` (declaration + both internal call sites) → `npx vitest run src/workers/` stays green. Restore.

- [ ] **NV9:** `git status --short` → clean; `npx vitest run src/workers/ src/outage/outage-notices.test.ts src/agents/agent-runner.test.ts` and `npx vitest run src/agents/agent-manager.test.ts` → all green.

---

### Task K — Full sweep, bundle guards, T9 gate, rollout note

- [ ] **K1. T9 review gate (conference stack untouched):**

```bash
git log --oneline 9771b04..HEAD --name-only | grep -E "dispatcher\.(ts|test)|dispatcher-conference" || echo "CLEAN"
# expect: CLEAN — no KPR-390 commit touches src/channels/dispatcher.ts,
# dispatcher.test.ts, or dispatcher-conference.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts
# expect: 34 + 96 passed, zero edits (C6/C10/C3 pins byte-green)
```

- [ ] **K2. Full sweep:**

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
# expect: typecheck clean, lint clean, format clean, ALL test files passed
```

- [ ] **K3. Bundle + guards** (new `src/workers/*` modules are reachable from index.ts/agent-runner — they must bundle; no standalone shims, no `import.meta.url` guards, no new externals):

```bash
npm run check:bundle
# expect: esbuild bundle OK + check-bundle-strings, check-bundle-pack,
# check-bundle-runtime, check-bundle-qdrant-stub all pass
```

- [ ] **K4.** If K2/K3 surfaced mechanical fixes (format, lint), commit them: `chore: quality-gate fixes (KPR-390)`.

**Rollout note (goes in the PR body and the ticket):**

> Shipping this engine change alters nothing by itself (Day-1-OOB layer 2). Operator steps to activate, per instance:
> 1. Add `"worker-pool"` to each conference **boss** agent's `coreServers` (`admin_agent_update` or beekeeper CLI) — never `delegateServers` (KPR-184 rejects it).
> 2. `SIGUSR1` (takes effect next spawn). No restart needed for the agent-def change; the engine upgrade itself needs the usual `launchctl kickstart`.
> 3. Optional `hive.yaml` `meetingWorkers:` section (all keys optional; defaults: sonnet workers, 4 engine-wide / 3 per meeting, 30m claim TTL, 10m worker wall clock, enabled).
> 4. Validate on a live `conf-*` meeting: boss dispatches, room sees "sent someone", boss posts the finding on re-entry; check `db.meeting_worker_claims` for the C18 measurement fields.
> Rollback: remove `worker-pool` from `coreServers` + SIGUSR1 (tools vanish), or `meetingWorkers.enabled: false` + restart (tools refuse honestly).
>
> Behavior note (deliberate, not a hang): after `stopAgent(boss)`, that boss's live workers are aborted but their claims stay `running` — the honest expiry notice arrives from the watchdog up to `claimTtlMinutes` (default 30m) later, or immediately from the restart sweep on the next engine boot. The abort path deliberately performs no status transition (E5/E13 coherence — the cancel/watchdog/sweep paths own the notice).

---

## Out-of-scope guard rails (do NOT touch)

- **Part B / KPR-409 (scribe):** no `meeting_summaries` collection, no scribe config keys (`scribeModel`, `scribeDebounceMs`, `scribeMinNewMessages`, scribe caps), no `noteMeetingActivity` seam, no `buildConferenceContext` edit, no summary byte pins. `runWorkerTurn`'s role-object shape is the full extent of scribe-readiness.
- **`src/channels/dispatcher.ts`:** zero edits of any kind (C13 + T9). The re-entry path consumes existing dispatcher behavior only.
- **Staleness culling, C5 disposition:** owned by KPR-389's measure-first trigger — untouched.
- **Tool-inventory restriction beyond the denylist:** no per-tool filtering inside surviving servers, no prompt-side tool prose (no-per-tool-prompt-awareness feedback).
- **Lane B effort / adapter changes:** none — worker-pool tools reach Lane B through the existing bridge; workers are claude-lane only.
- **No spawnBudget accounting, no per-thread lock, no breaker permits for workers** — deliberate spec divergences from KPR-354; do not "fix" them in review.
- **No new telemetry kinds, no `hive doctor` section, no `agent_turn_telemetry` rows for worker turns** (C18).
- **Caps stay check-then-act** — no locking or post-insert re-count machinery (spec §A1 step 3, explicit).

## Commit sequence summary

| # | Commit | Files |
|---|---|---|
| 1 | `feat(workers): meetingWorkers config section — liberal-loader resolver + defaults (KPR-390)` | worker-pool-config.ts, config.ts, config.test.ts |
| 2 | `feat(llm): workerClaimDedup sidecar task binding (KPR-390)` | llm/types.ts, llm/registry.ts, llm/registry.test.ts |
| 3 | `feat(workers): workerClaimDedup sidecar classifier — fail-open by construction (KPR-390)` | worker-claim-dedup.ts + test |
| 4 | `feat(workers): meeting worker pool — claim ledger, atomic dispatch, detached spawn, re-entry, watchdog (KPR-390)` | meeting-worker-pool.ts + test |
| 5 | `feat(workers): worker-pool in-process MCP server — 3 tools, context-ref template (KPR-390)` | worker-pool-mcp-server.ts + test |
| 6 | `feat(agents): wire worker-pool — in-process registry, worker-mode suppression, Lane B inventory, manager handshake, index lifecycle (KPR-390)` | in-process-servers.ts, server-traits.ts, agent-runner.ts (+test), agent-manager.ts (+test), index.ts |
| 7 | `feat(outage): worker re-entry items queue silently during provider outages (KPR-390)` | outage-notices.ts + test |
| 8 | `docs: worker-pool provider note, meeting_worker_claims collection, KPR-184 list (KPR-390)` | docs/providers.md, CLAUDE.md |
| 9 | (conditional) `chore: quality-gate fixes (KPR-390)` | — |
