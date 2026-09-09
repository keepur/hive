# KPR-463 — Packaged engine and voice-worker lifecycle implementation plan

> **For agentic workers:** After this revision passes the child plan-review gate, resume through the dodi-dev implementation/delivery lane using the serial schedule below. The user explicitly authorized dodi-dev to replace the unavailable `/spec-and-implement` entrypoint (authorization record `ac95b136`); that workflow substitution is resolved. It does not establish deployment prerequisites or authorize live calls.

**Status:** DRAFT_READY pilot-evidence/S7 completion revision for review. S0–S6 and the coherent S7 prefix are preserved on the implementation child as recorded below; this revision does not assert readiness, deployment, or call completion.

**Goal:** Ship, install, operate, and recover the enabled LiveKit worker and engine as one instance-owned npm release, then record the required dodi migration evidence.

**Architecture:** Extend the existing `.hive.next/.hive/.hive.prev/.hive.broken` lifecycle with a bundled TypeScript single-instance transaction helper. A supervisor-owned accepted-job ledger and reversible local admission barrier establish quiescence before launchd shutdown. Package identity, locked production dependencies, process ownership, registration-aware SDK health, and a no-turn authenticated bridge probe determine activation and recovery success.

**Tech Stack:** TypeScript/ESM, Node `>=22.19.0`, npm publishable shrinkwrap, esbuild, Vitest, macOS launchd, Mongo telemetry, LiveKit Agents `1.6.4`, RTC Node `0.13.33`; operational native proof on macOS ARM64/Node 24.

**Authority:** Approved [spec](./kpr-463-spec.md) at `2063bacd5bf41b8e035909d1d3d07790fe4bbb43`. Gate 1 and routine spec/plan delegation are recorded on KPR-462. No `Decision Register — Canon` section was present in the supplied epic. No sibling convention is invented. No scope demotion is requested by this draft; a failed feasibility proof that requires changing the approved contract returns to the spec lane.

## Reading order and chunk boundaries

All four files are one dependent implementation plan, split for review; they are not independently releasable subsystems. Each remains below 1,000 lines.

1. This file: full Testing Contract, file map, dependency order, SDK proof, artifact/native install implementation.
2. [Worker runtime and evidence](./kpr-463-plan-runtime.md): admission ledger/IPC, entry completion, identity, shared configuration and probes.
3. [Lifecycle and delivery](./kpr-463-plan-lifecycle.md): service generation, reversible quiescence, transaction/recovery, CLI adoption, verification and operational acceptance.
4. [Registered pilot evidence and S7 completion](./kpr-463-plan-pilot.md): strict registry/check schemas, current inventory/hold proof and explicit legacy deferral, pilot reconstruction, concrete interrupted recovery, locked beta compatibility and stable bootstrap. Its suffixed substeps complete the existing Task/Step IDs.

The code blocks prescribe complete core functions/types and exact replacement blocks. Named existing helpers retain behavior outside the listed edits. Adapter operation tables specify exact inputs, outputs, ordering, and failure behavior; they are implementation contracts, not permission to substitute mocked production behavior.

## Testing Contract

### Required Test Groups

- Unit: **required**.
  - Scope: release/lock validation and development-lock ownership across build/install/repack; configuration/port derivation and basename-based alternate dotenv selection; XML generation; accepted ledger and barrier transitions; job completion wrapper; heartbeat field ownership; boot/health classification; transaction state machine; CLI argument routing.
  - Reason: false idle or false success can interrupt a live call or leave an unrecoverable mixed release.
  - Minimum assertions: all T3–T8 branches below, especially no ledger deletion on `accept()` resolution, no signal before quiescence, exact release/PID/boot matching, and nonzero deployment result after successful recovery.
- Integration: **required**.
  - Scope: actual pinned SDK JobRequest and job-child loader, filesystem IPC, isolated retained bundle-smoke subprocesses, candidate package installation, local HTTP auth boundary, fake launchctl/process ownership boundary, migration bootstrap and rollback profiles.
  - Reason: mocks alone cannot prove SDK callback timing, native asset resolution, bundle relocation, self-replacement, or instance isolation.
  - Harness: **setup-required**, building on Vitest, `src/voice-worker/*.test.ts`, `src/channels/voice/voice-adapter.integration.test.ts`, and `service/deploy.test.sh`.
  - Minimum assertions: real SDK acceptance behavior and forked initialization; real packed `.tgz` production installation; native RTC and Silero/ONNX loading; engine and worker path/config equivalence; complete failure injection matrix; no vendor/model/launchd calls from automated tests.
- E2E: **required, no-call deployment E2E**.
  - Scope: disposable filesystem/process lifecycle E2E, then actual dodi install/restart/pilot rollback/reapply/final read-back under spec §7.
  - Reason: only actual service/process/config evidence establishes migration acceptance.
  - Harness: **setup-required** for the disposable process harness; **execution-dependent** for the inventoried dodi recovery route and verified legacy dispatch hold.
  - Minimum assertions: T9 and full packaged profile after final reactivation; pilot recovery passes its separate profile; no Keepur restart/repoint, no operator-data drift; final current release identity recorded for KPR-466.

### Critical Flows

- Fresh install/resume receives the same package, shrinkwrap, complete production dependencies, and service entries as update.
- Admission closes while engine/worker/call remain live; racing accepted work settles or the 30-second budget defers with admission verifiably reopened.
- Quiescent worker exits with every child before engine stop and artifact rotation.
- Fetch/stage failure preserves the live pair; post-stop failure restores and checks the exact prior pair while returning failure.
- First adoption uses candidate tooling while installed updater remains old, exercises pilot recovery, and ends on the candidate.
- Voice-disabled use needs no voice secrets/network and cleans stale worker registration without disturbing another instance.

### Regression Surface

- Existing engine CLI/foreground startup, startup marker ordering, update pin selection and developer deploy mode.
- Vapi authentication, bridge abort behavior, agent/session loading, call shutdown order, vendor choices, warm-path/tool-ack flags, voice metrics and per-agent voice routing.
- Existing npm pack exclusions, ABI declaration closure, Qdrant stub, bundle string/size guards and Node 22 support.
- Shared instance config/dotenv/Honeypot precedence; operator skills, plugins, data identity, update-preflight plugin relocation and notifications.

### Commands

Run this full-contract block only after S9 integration below, from the implementing worktree, with disposable test fixtures created by the harness. Earlier slices use their own bounded commands. Do not use operator instance config or Keychain to make tests pass. Build before any SDK-child test or artifact command so neither can consume stale or absent compiled entries.

```bash
npm ci
npm run bundle
npx vitest run src/paths.test.ts src/voice-worker/admission.test.ts src/voice-worker/job-lifecycle.test.ts src/deployment/release.test.ts src/deployment/ports.test.ts src/deployment/health.test.ts src/deployment/transaction.test.ts
npx vitest run src/voice-worker/sdk-lifecycle.integration.test.ts src/voice-worker/maintenance-ipc.integration.test.ts src/deployment/lifecycle.integration.test.ts src/deployment/adoption.integration.test.ts src/channels/voice/voice-adapter.integration.test.ts
node --test scripts/generate-shrinkwrap.test.mjs scripts/check-bundle-runtime.test.mjs
npm run check:artifact
bash service/deploy.test.sh
bash service/install.test.sh
npm run check
npm run check:bundle
```

- Unit/integration expected: Vitest exit 0, no skipped contract cases.
- Artifact expected: exit 0 and `ARTIFACT_RUNTIME_OK`, `SDK_IMPORT_OK`, `ARTIFACT_INSTALL_OK` records from the installed candidate; exit 0 without these records fails the harness.
- Shell expected: exit 0 and each fixture assertion passes; launchctl is a test shim.
- Broader regression expected: typecheck, ESLint, Prettier, complete Vitest suite, existing bundle guards, plus the newly required artifact check all exit 0.
- Operational E2E commands are in Task 12 of the lifecycle chunk; do not run them during maturation.

### Harness Requirements

- Tests own all temporary roots, HOME/config/env files, fake Mongo/Keychain adapters, registry artifact fixtures, clocks and process/launchctl shims. For subprocess config tests on macOS, prepend a fixture `security` executable that exits 44 (Keychain item absent) and records invocation; scratch HOME alone does not isolate the login Keychain. Restore environment after every test; reject any fixture path equal to an actual instance root.
- SDK proof and packed smoke use real `@livekit/agents@1.6.4`. Test-only imports of the installed SDK child helper may resolve its package path; they do not modify the SDK or become production runtime adapters.
- Native acceptance uses a real `npm pack`, extracted outside any repository under a parent with no `node_modules`; `NODE_PATH`, `NODE_OPTIONS`, SDK credentials and operator HOME are absent. Install scripts run normally. Registry access during installation is allowed; runtime checks create no vendor connections.
- Record `process.version`, `npm --version`, OS and architecture. The macOS ARM64/Node 24 native check is required. Retain Node 22 validation separately; no OS-support claims from an untested runner.
- Packed tests use a scratch HOME and explicit `HIVE_HOME`/`HIVE_CONFIG`; native diagnostics must not import config at module initialization.
- The SDK child test owns every process it forks, waits for exit and cleans its temporary root. No SIP participants, agent dispatches, real rooms, model turns or external notifications.
- Migration requires inventoried current launchd service definitions, executable/dependency hashes, pilot listener, retained candidate tooling, validated recovery files, and a separately verifiable hold over all legacy dispatch sources and outstanding assignment work. Missing any of these is a concrete operational blocker.

### Non-Required Rationale

No required test group is waived. Live-call conversation/audio E2E is outside KPR-463 and belongs to KPR-466 after May's call authorization. Dodi migration is a required later execution step; a pending operational step cannot be marked passed by a fixture.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test exposes an implementation issue, fix the implementation, not the assertion.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Do not invoke SDK drain, SIGTERM, bootout, `kickstart -k`, or port-owner killing as an abortable idle check.
- Do not issue completion/readiness labels from this document. Apply the child review and dependency gates through the dispatcher.

### T1–T9 executable ownership

| Spec ID | Primary files/tests | Required cases |
| --- | --- | --- |
| T1 | `scripts/check-bundle-pack.mjs`, `scripts/generate-shrinkwrap.test.mjs`, `scripts/check-artifact-install.mjs` | actual tarball, worker/helpers/manifest/shrinkwrap/MCP present; no src/dist/secrets/node_modules; build → lock change → install → rebuild/repack follows package-lock; no development-root shrinkwrap after success/failure; unchanged size/string guards |
| T2 | `src/voice-worker/runtime-diagnostic.ts`, `scripts/check-artifact-install.mjs` | fresh locked production install, RTC/ONNX/Silero load, SDK child imports packaged default agent |
| T3 | `src/voice-worker/main.test.ts`, `src/deployment/services.test.ts`, artifact harness | relocate root; spaces, `&`, symlink home; actual direct/import distinction; missing entrypoint fails before writes |
| T4 | `src/paths.test.ts`, `worker-config.test.ts`, bridge integration tests, `health.test.ts`, `scripts/check-bundle-runtime.test.mjs` | shared selectors and dotenv/Keychain precedence, including absolute/relative alternate selectors; retained smoke isolates HOME/config/env and Keychain; no secret output; correct/missing/wrong token results; zero model spawns |
| T5 | `src/deployment/lifecycle.integration.test.ts` | both service labels, order/idempotency, disabled transition, target-only ownership, port/collision validation |
| T6 | `transaction.test.ts`, `adoption.integration.test.ts`, shell tests | every failure stage; old updater is never invoked; exact checked recovery; incompatible prior release rejected; separate legacy profile |
| T7 | admission/IPC/SDK tests, transaction and health tests | call race >30s, unresolved assignment, after-close rejection, missing/wrong-boot/release acknowledgements, dead owner/marker, KeepAlive, stale health/logs, wrong owner |
| T8 | `src/deployment/lifecycle.integration.test.ts` | sentinel hashes/permissions, second-instance process state, `.hive-state` survival, retry after recovered failure |
| T9 | `docs/epics/kpr-462/kpr-463-deployment-evidence.md` | actual dodi migration/restart/rollback/reapply/current identity, read-only setup validation and Keepur/state comparisons |

## File structure and dependency order

| File(s) | Responsibility |
| --- | --- |
| `src/deployment/release.ts` + `.test.ts` | versioned manifest, artifact validation, runtime identity/containment |
| `scripts/generate-shrinkwrap.mjs` + `.test.mjs`, `build/bundle.ts`, `package.json`, `package-lock.json`, `.gitignore` | pinned production packaging, scratch-only generated shrinkwrap, development-lock regression and release manifest |
| `src/voice-worker/runtime-diagnostic.ts`, `scripts/check-artifact-install.mjs` | offline native and packaged SDK-import acceptance |
| `src/voice-worker/admission.ts` + `.test.ts` | synchronous admission/accepted ledger state machine |
| `src/voice-worker/maintenance-ipc.ts` + `.integration.test.ts` | bundle-safe shared mailbox protocol/client and supervisor transport; boot/operation ownership |
| `src/voice-worker/job-lifecycle.ts` + `.test.ts` | entry and post-cleanup completion envelope |
| `src/voice-worker/sdk-lifecycle.integration.test.ts`, `src/voice-worker/fixtures/sdk-agent.ts` | real pinned SDK acceptance and child lifecycle proof, no calls |
| `src/voice-worker/main.ts`, `worker-config.ts`, `telemetry.ts` and existing tests | wire gate, lazy job imports, port and immutable supervisor identity |
| `src/deployment/ports.ts`, `src/config.ts` and tests | worker health port validation alongside resolved engine ports |
| `src/paths.ts`, `src/paths.test.ts` | shared resolveDotenvPath basename correction and alternate-config dotenv regression (Task 7) |
| `src/logging/logger.ts` (reuse; no source edit) | existing dependency-free `createLogger` for helper/shared-module diagnostics |
| `src/deployment/runtime-probe.ts`, `health.ts` and tests | config/auth/registration/dependency evidence, separate acceptance profiles |
| `src/deployment/services.ts` + tests | service descriptions, XML and launchd/process ownership adapters |
| `src/deployment/operation.ts`, `transaction.ts`, `artifact.ts` + tests | lock/marker/frozen helper, paired transaction, extraction/install/rotation |
| `src/deployment/main.ts` | standalone bundled deploy helper, package-root-independent after freeze |
| `src/deployment/pilot-records.ts`, `pilot.ts`, `reconcile.ts`, `bootstrap.ts`, `plugin-compat.ts` + tests | registered pilot evidence/current readback, profile reconstruction, concrete stale reconciliation, stable bootstrap and locked beta compatibility; detailed interfaces in chunk 4 |
| `src/cli/daemon.ts`, `update.ts`, `rollback.ts`, `single-instance-env.ts`, `src/cli.ts` + tests | existing CLI routes into same transaction, artifact/dry-run/adoption selection |
| `src/setup/populate-engine.ts` + tests | share validated package entries and complete locked install/resume |
| `src/cli/doctor.ts`, `doctor-checks.ts` + tests | installed versus observed identity and accurate worker-health display |
| `service/deploy.sh`, `deploy-check.sh`, `install.sh`, `setup/generate-plist.ts`, shell tests | packaged single-instance delegation and developer-mode isolation |
| `scripts/check-bundle-pack.mjs`, `scripts/check-bundle-runtime.mjs` + `.test.mjs`, `.github/workflows/ci.yml`, `publish.yml` | required artifact guard, retained-smoke isolation and runtime matrix |
| `CLAUDE.md`, `AGENTS.md`, `docs/epics/kpr-462/kpr-463-operations.md` | supported paths, native prerequisites, adoption/recovery/runbook |
| `docs/epics/kpr-462/kpr-463-deployment-evidence.md` | sanitized actual delivery evidence; create only during delivery |

### Serial execution schedule and resume checkpoint

Task/Step numbers below remain stable audit IDs, **not numeric execution order**. Execute S0–S12 serially. A split step is complete only after all of its assigned slices pass; record slice completion separately. This schedule changes implementation/check ordering only: every behavior and T1–T9 gate remains required. One owner edits shared `main.ts`, `telemetry.ts`, `config.ts`, `build/bundle.ts`, `package.json` and lockfile; integrate serially with KPR-464/KPR-465.

**Preserved child:** `codex/kpr-463-packaged-voice` at `bc0d47aaa5ae9c39366e185715cbde407837ce2f` in `/Users/mokie/github/hive-kpr463-deliver` preserves S0–S6 and the coherent S7 prefix. Task 1 remains in ancestor `438115f2788e19c01dc8d7e08a43be17ef3a30bb` with its recorded build/20-test proof. The current checkpoint includes operation/artifact/transaction/lifecycle/CLI routing and 65 injected S7 tests; recorded checks passed build, typecheck, lint, shell routing, affected runtime tests and the 197-file/4,155-test full suite using inert process-local Slack test values. This is reused execution evidence from `.dodi/kpr463-s7.txt`, not a rerun during plan drafting. Pilot flags currently fail closed pending this revision; concrete stale reconciliation, locked beta compatibility and final bootstrap are still incomplete. After review and epic-plan publication, merge these revised documents into that child and resume **remaining S7**, preserving all earlier commits. Do not replay S0–S6 or copy product code into the epic planning branch.

| Slice | Requires | Original work to execute in this slice | Verification/checkpoint using available artifacts |
| --- | --- | --- | --- |
| S0 | existing child | Reuse Task 1 Steps 1–5, Task 4 Step 1 ledger and Task 5 Step 1 wrapper. Integrate reviewed plan documents into that child. | Confirm preserved commit ancestry and six-file inventory; reuse recorded build/20-test proof. No Task 1 replay for a docs-only merge. |
| S1 | S0 | Task 2 Step 4 release decoder/identity helpers and only its decoder fixture tests from Step 5. | `npm run typecheck`; `npx vitest run src/deployment/release.test.ts`. Strict decoder fixtures are unit inputs, never a claimed built release. |
| S2 | S1 | Task 6 Step 1 ports/config/worker-config producer and its port/loader unit cases from Step 6. | `npm run typecheck`; `npx vitest run src/deployment/ports.test.ts src/voice-worker/worker-config.test.ts`. |
| S3 | S2 | Task 7 Steps 1–2 shared service environment, serializer, process/launchd adapters and basename resolver; their foundation unit cases from Step 5. Keep daemon routing for S7. | `npm run typecheck`; `npx vitest run src/paths.test.ts src/deployment/services.test.ts`. Test-owned definitions/files and injected ServiceIO exercise these boundaries without a built release. |
| S4 | S3 | Task 4 Steps 2–3 transport plus Step 4 diagnostic data; Step 5 ledger/IPC tests. Reuse Step 1. Consumer display wiring from Step 4 is completed in S6/S7; Step 5 lifecycle/marker assertions finish in S9. | Task 4 Step 5 command plus `npm run typecheck`. Process census uses the available S3 adapter; real worker wiring waits for S5. |
| S5 | S4 | Task 5 Steps 2–6 supervisor/job wiring, heartbeat and engine identity; reuse Step 1. | Task 5 Step 6 commands, including a fresh `npm run build` before SDK-child tests. S1 identity, S2 healthPort and S4 mailbox now exist. |
| S6 | S5 | Task 6 Steps 2–5 probe/health/doctor source and Step 6 local unit/integration cases; Task 3 Step 2 offline diagnostic source. Complete Task 4 Step 4 probe/doctor display. | `npm run build`; Task 6 Step 6 command. Build checks both diagnostic sources; actual packaged/native success waits for S8. Transaction closed-gate propagation waits for S9. |
| S7 | S6 | **Partially complete at `bc0d47a`; finish all remainder.** Preserve Task 8 Steps 1–5 source, Task 7 Steps 3–4 routing and Task 9 Steps 1–4 prefix. Complete chunk 4's Task 8 Step 1a concrete stale reconciliation (including frozen-child ownership), Step 5a pilot capture/reconstruction/migration/recovery/reapply adapters, Task 9 Step 1b locked beta-plugin preflight and Steps 4a–4d strict registry/current hold/inventory/release/final bootstrap handlers. Extend Task 8 Step 6/6a and Task 7/9 CLI/shell unit assertions; complete Task 4 Step 4 lifecycle/CLI display. A file/boolean never bypasses hold; the real uninstrumented pilot may remain operationally pending. | Run chunk 4 Task 8 Step 6a.1 build/new evidence/reconcile/bootstrap/compatibility/transaction/CLI unit commands and both shell tests. All remaining source handlers must be concrete before S7 completion. Frozen-helper/actual-packaged lifecycle and adoption cases remain S9. |
| S8 | S7 | Complete Task 2 Steps 1–3 and remaining Step 5 packaging/generator/guards, then Task 3 Steps 1, 3–4 installer and artifact/retained-smoke harnesses. All entrypoint sources/imports already exist before bundler registration. | Run the complete Task 2 Step 5 and Task 3 Step 4 blocks after implementing both sets of changes. Require real bundle/pack/native/SDK-import markers before this combined artifact checkpoint. |
| S9 | S8 | Complete Task 4 Step 5 lifecycle/marker assertions, Task 7 Step 5 packaged selector/loader fixture, Task 8 Step 6 lifecycle/failure/preservation integration, Task 6 Step 6 transaction closed-gate propagation, and Task 9 Steps 5/5a bootstrap/adoption integration, including actual stale-helper recovery, capable historical-layout success and uninstrumented legacy deferral without fabricated hold. | Run full Task 7 Step 5 and Task 9 Step 5 commands against the S8 artifact. Any product/lock/build change first requires rebuild and affected artifact revalidation. No fixture substitutes for the actual helper or packed entrypoints at these boundaries. |
| S10 | S9 | Task 10 Steps 1–5 operation/recovery documentation, using observed T2 prerequisites. | Review commands against implemented CLI/helper; `git diff --check`. T9 evidence remains pending. |
| S11 | S10 | Task 11 Steps 1–4 CI/release wiring, full contract, fresh review and final clean candidate. | All Task 11 gates, including Node22 and macOS ARM64/Node24, plus exact clean archive identity. |
| S12 | S11 | Task 12 Steps 1–7 actual inventoried operational acceptance once its real prerequisites are established, using chunk 4 registration/check procedures. The described pilot has no established external hold/assignment authority; retain migration-pending unless actual inventory supplies a reviewed verifiable route. | Actual T9 records; no fixture/merge substitutes for migration, and no live call is introduced. Inventory/bootstrap or negative deferral alone cannot pass T9. |

For S1–S9, checkpoint only the slice's implemented files after its listed checks and worker self-review, then commit through the implementation lane. Full lane review remains the Task 11 pre-PR gate; this schedule adds no separate review gate per slice. Source-only checkpoints do not pass artifact gates or make a release deployable. Add deferred integration cases when their owning slice is reached, rather than committing skipped cases or running a nonexistent future test path. Existing dependency-injected unit fixtures may model a boundary; never generate placeholder production entrypoints, omit a required bundler entry, or relax `readRelease`/pack/native assertions to obtain a pass. The first full bundle/native checkpoint is S8; all commands that consume it are explicitly scheduled at S8 or later. The final Testing Contract is unchanged in scope.

The source import order is release → ports/config → service environment/process adapters → mailbox → worker/engine wiring → health/probes/diagnostic → transaction/helper → CLI/service wrappers. This keeps `services.ts` independent of transaction/CLI/config imports and `health.ts` independent of transaction imports, as required by the existing frozen-helper boundary. The shared `requestMaintenance` remains in Task 4/S4's `maintenance-ipc.ts`, reusing S0's import-free admission module; existing `paths.ts` and `logging/logger.ts` are the other allowed shared helper dependencies. Task 7/S3 owns the path-selector changes, and Task 8/S7 consumes the same client through injected S3 process checks. No file, test or slice is split or moved: S4 owns client/protocol tests, S8 owns the complete helper graph/builtin-external build check, and S9 owns actual frozen-helper lifecycle/adoption execution. The `pkg/deploy.min.js` runtime path is validated by source code written in S7, but the real frozen executable is produced in S8 and exercised in S9. Task 2 cannot bundle `dist/voice-worker/runtime-diagnostic.js`, `dist/deployment/runtime-probe.js` or `dist/deployment/main.js` until those producers and their imports compile. `npm run bundle` performs that build; missing sources remain hard failures.

## Task 1: Prove pinned SDK admission and accepted-job completion before broad implementation

**Files:**
- Create: `src/voice-worker/admission.ts`, `job-lifecycle.ts`, their tests, `sdk-lifecycle.integration.test.ts`, `fixtures/sdk-agent.ts` (code contracts in runtime chunk).
- Read only: installed `@livekit/agents` package, especially `dist/job.js`, `dist/worker.js`, `dist/ipc/job_proc_lazy_main.js` and `dist/ipc/job_proc_executor.js`.

- [x] **Step 1:** Install the reviewed repository dependencies in the implementation worktree; record the SDK and host versions. Completed in the preserved S0 child checkpoint. Commands below retain the proof procedure for audit; they are not a request to redo Task 1 during resume.

```bash
npm ci
node -e 'console.log(process.version, process.platform, process.arch); console.log(require("@livekit/agents/package.json").version)'
npm --version
```

Expected: dependency install exits 0 and SDK version is exactly `1.6.4`; if package exports block `package.json`, resolve the package root using the diagnostic's path walker rather than changing versions.

- [x] **Step 2:** Implement the admission and cleanup envelope from Tasks 4–5 as small dependency-injected modules. Test the real exported SDK `JobRequest`, not an invented promise contract:

```typescript
it("accept resolution leaves an accepted-but-unassigned job unresolved", async () => {
  const gate = new AdmissionLedger({ pid: 100, bootId: "boot-a" }, () => {});
  let assignmentResolved = false;
  let finishAssignment!: () => void;
  const assignment = new Promise<void>((resolve) => { finishAssignment = resolve; });
  const req = new JobRequest(
    { id: "job-a" } as JobRequest["job"],
    async () => { throw new Error("unexpected rejection"); },
    async () => { await assignment; assignmentResolved = true; },
  );
  await gate.request(req);
  expect(assignmentResolved).toBe(false);
  expect(gate.snapshot().unresolved).toHaveLength(1);
  gate.close("op-a");
  expect(gate.canStop("op-a", 0, 0)).toBe(false);
  finishAssignment();
  await assignment;
  expect(gate.canStop("op-a", 0, 0)).toBe(false);
});
```

Imports are `it/expect` from Vitest, `JobRequest` from `@livekit/agents`, and `AdmissionLedger` from the new local module. The explicit no-op persistence callback is only for this in-memory proof fixture; production callers must supply Task 4's required durable snapshot callback. No SDK private field is accessed or patched.

- [x] **Step 3:** Fork the actual installed SDK `dist/ipc/job_proc_lazy_main.js` with the compiled Hive test agent as argv[2]. Drive its existing IPC messages: send `initializeRequest` with `{ loggerOptions: { level: "error", pretty: false } }`; require `initializeResponse`; send `startJobRequest` with a dummy `RunningJobInfo`; require Hive entry acknowledgement; send `shutdownRequest`; require Hive completion acknowledgement, SDK `done`, and process exit. The fixture uses `withJobLifecycle` and `ctx.shutdown`, never `ctx.connect` or `runCallSession`.

Test `RunningJobInfo` contains `job: { id: "job-a", room: { name: "fixture" }, metadata: "{}" }`, `acceptArguments: { identity: "agent-job-a", name: "", metadata: "" }`, `url: "ws://127.0.0.1:1"`, `token: "fixture-token"`, `workerId: "fixture-worker"`; fill SDK-required protobuf defaults using the installed protocol's `Job`/`Room` constructors. Resolve `@livekit/protocol` through the Agents package's own resolver in this test, avoiding a new production direct dependency. Test process IPC is fixture-controlled; no LiveKit server is required.

The fixture's shutdown callback awaits a parent-controlled cleanup release, then signals `cleanup-finished`; the ledger must remain unresolved until that release. Repeat with thrown work before session setup, process exit before Hive entry, and suppressed completion write. The latter two must leave diagnostic unresolved entries even when the SDK process has exited. Test-only subprocess budgets are 15 seconds and must clean up only their own child PIDs on failure.

- [x] **Step 4:** Add the fake-clock race proof: a request enters before barrier close, stays live beyond 30 seconds, and produces zero SDK-active count during the assignment gap. Assert zero drain/close/signal/bootout/swap calls, same service PIDs and call still alive, and verified `open` acknowledgement from the same boot after abort. After closure, another JobRequest is rejected. A stale or missing release acknowledgement yields `maintenance-unresolved`, never a restored-availability claim. The shutdown fake must model SDK 1.6.4 accurately: drain marks irreversible draining state, and the CLI calls close even if drain times out. Assert this entire path remains untouched during every abortable maintenance failure.

- [x] **Step 5:** Verify the proof and inspect it before permitting the remaining serial implementation slices.

```bash
npm run build
npx vitest run src/voice-worker/admission.test.ts src/voice-worker/job-lifecycle.test.ts src/voice-worker/sdk-lifecycle.integration.test.ts
```

Expected: all cases pass with the installed SDK. If completion cannot be proved with Hive-owned callbacks and the supported request hook, stop the implementation lane and return the exact mismatch to spec; do not patch SDK internals, replace the SDK, clear timed-out ledger entries, or silently reduce acceptance to `/worker.active_jobs === 0`.

**Source findings used:** [JobRequest 1.6.4](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/job.ts) does not await its internal acceptance callback. [Worker 1.6.4](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/worker.ts) records pending assignment separately from active processes; assignment timeout does not settle the pending promise; drain sets persistent state. [SDK child](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/ipc/job_proc_lazy_main.ts) awaits entry and later runs registered shutdown callbacks concurrently before exit. These findings dictate the proof rather than certify it.

**Completed checkpoint:** `438115f2788e19c01dc8d7e08a43be17ef3a30bb`. Original commit commands are retained for audit only; resume preserves this commit instead of repeating them:

```bash
git add src/voice-worker/admission.ts src/voice-worker/admission.test.ts src/voice-worker/job-lifecycle.ts src/voice-worker/job-lifecycle.test.ts src/voice-worker/sdk-lifecycle.integration.test.ts src/voice-worker/fixtures/sdk-agent.ts
git commit -m "feat: track voice admission and job completion for maintenance"
```

## Task 2: Package a reproducible worker release

**Files:** `package.json`, `package-lock.json`, `.gitignore`, `scripts/generate-shrinkwrap.mjs`, `scripts/generate-shrinkwrap.test.mjs`, `build/bundle.ts`, `src/deployment/release.ts`, `src/deployment/release.test.ts`, `scripts/check-bundle-pack.mjs`, `.github/workflows/publish.yml`.

**Schedule:** S1 implements Step 4 plus its decoder unit cases from Step 5. Steps 1–3 and the remaining Step 5 run in S8 together with Task 3's installation/harness completion. Do not register new bundle entries or require a full pack during S1. The decoder remains strict throughout.

- [ ] **Step 1:** Assert this worktree has no repository-root `npm-shrinkwrap.json` before any npm dependency command; remove only a known generated leftover from an earlier packaging attempt. Move these exact six entries from devDependencies to dependencies, preserve all other selected versions, then regenerate the repository lock with the same npm version used for release validation:

```json
{
  "@livekit/agents": "1.6.4",
  "@livekit/agents-plugin-cartesia": "1.6.4",
  "@livekit/agents-plugin-deepgram": "1.6.4",
  "@livekit/agents-plugin-elevenlabs": "1.6.4",
  "@livekit/agents-plugin-silero": "1.6.4",
  "@livekit/rtc-node": "0.13.33"
}
```

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: root dependency classification and affected lock `dev` flags change; unrelated version upgrades require investigation, not acceptance by default. Keep the Node engine string `>=22.19.0` and all native install-script requirements. Do not remove ElevenLabs or change configured vendor selection.

- [ ] **Step 2:** Keep the development root free of `npm-shrinkwrap.json`: generate that filename only inside a disposable packaging directory. Add `/npm-shrinkwrap.json` to `.gitignore` as a guard against accidental tooling output, not permission to retain it. Bundling only validates `package-lock.json` and hashes those bytes; it never writes a root shrinkwrap. npm prefers root shrinkwrap over package-lock, so post-install hooks are too late to preserve lock selection.

Add `pack:release: node scripts/generate-shrinkwrap.mjs --pack` and `prepack: node scripts/generate-shrinkwrap.mjs --reject-root-pack`. All source-package pack callers use `pack:release`; its implementation invokes real `npm pack` against a scratch copy of the built package. The prepack guard makes an accidental direct source `npm pack`/`npm publish` fail with the supported command. Do not add install/prepare hooks: installed production packages must need no source scripts. Complete generator/packer core:

```javascript
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const cwd = process.cwd();
const [mode, ...args] = process.argv.slice(2);
if (mode === "--reject-root-pack") throw new Error("Use npm run pack:release; publish its validated .tgz");
if (!["--check-source", "--check", "--pack"].includes(mode)) throw new Error("unknown shrinkwrap mode");
if (existsSync(resolve(cwd, "npm-shrinkwrap.json"))) throw new Error("development root must not contain npm-shrinkwrap.json");
const source = readFileSync(resolve(cwd, "package-lock.json"));
const lock = JSON.parse(source.toString("utf8"));
const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
const root = lock.packages?.[""];
if (lock.lockfileVersion !== 3 || !root || root.name !== pkg.name || root.version !== pkg.version) {
  throw new Error("package-lock root identity mismatch");
}
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (!isDeepStrictEqual(root[field] ?? {}, pkg[field] ?? {})) throw new Error(`package-lock ${field} mismatch`);
}
if (mode !== "--check-source") {
  const manifest = JSON.parse(readFileSync(resolve(cwd, "pkg/release.json"), "utf8"));
  const digest = createHash("sha256").update(source).digest("hex");
  if (manifest.packageVersion !== pkg.version || manifest.dependencyLockSha256 !== digest) {
    throw new Error("bundle lock is stale; rebuild before packing");
  }
}
if (mode === "--pack") {
  let destination = cwd;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i] === "--dry-run") { dryRun = true; continue; }
    if (args[i] === "--pack-destination" && args[i + 1]) { destination = resolve(cwd, args[++i]); continue; }
    throw new Error("unsupported pack argument");
  }
  const scratch = mkdtempSync(resolve(tmpdir(), "hive-release-pack-"));
  const stage = resolve(scratch, "package");
  try {
    mkdirSync(stage);
    const entries = new Set([...pkg.files, "package.json", "README.md", "LICENSE", "LICENSE-APACHE-2.0.txt", "NOTICE"]);
    for (const entry of entries) {
      const rel = relative(cwd, resolve(cwd, entry));
      if (!rel || isAbsolute(entry) || rel === ".." || rel.startsWith(`..${sep}`) || /[*?[\]{}!]/.test(entry)) {
        throw new Error("pack files must be explicit contained paths");
      }
      const from = resolve(cwd, entry);
      if (!existsSync(from)) continue;
      const to = resolve(stage, entry);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true, dereference: false });
    }
    writeFileSync(resolve(stage, "npm-shrinkwrap.json"), source, { flag: "wx" });
    if (!source.equals(readFileSync(resolve(stage, "npm-shrinkwrap.json")))) throw new Error("shrinkwrap copy mismatch");
    const npmArgs = ["pack", "--ignore-scripts", "--json", "--pack-destination", destination];
    if (dryRun) npmArgs.push("--dry-run");
    process.stdout.write(execFileSync("npm", npmArgs, {
      cwd: stage, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
```

`npm pack --ignore-scripts` is restricted to this already-built scratch tree, where source-only build hooks are unavailable; dependency installation still runs its required native scripts. Preserve all files allowed by the existing package manifest and npm's automatic README/license inclusion; fixture tests compare the staging packlist against that published surface. Keep the real archive's required/excluded-file guards. The scratch directory is removed after successful/dry-run/failed packing; even abrupt process death leaves any shrinkwrap outside the development repository. No second hand-maintained dependency tree is introduced.

Change `scripts/check-bundle-pack.mjs` to invoke this script with `--pack --dry-run --json`, and Task 3's artifact harness to invoke it with `--pack --json --pack-destination <scratch>`. Keep their existing npm array/object JSON parsing. In `.github/workflows/publish.yml`, build/validate first, pack once through this command, parse and retain its exact archive filename/digest, and publish that validated archive with `npm publish <absolute-tgz> --access public`; preserve publication authorization and token handling. Task 11 and the operations runbook must use this same source packaging entrypoint. Registry downloads such as `npm pack @keepur/hive@<version>` are unaffected. npm automatically includes the staged root shrinkwrap; add it to `PACKAGE_ENTRIES` and required pack assertions. These choices follow [npm shrinkwrap precedence](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/) and [npm packaging lifecycle](https://docs.npmjs.com/cli/v11/using-npm/scripts/).

- [ ] **Step 3:** In S8, after S5–S7 have supplied every entrypoint and import, update `build/bundle.ts`: add the six package names to `external` and these named entries to the existing shared build: `voice-worker: dist/voice-worker/main.js`, `voice-worker-diagnostic: dist/voice-worker/runtime-diagnostic.js`, `runtime-probe: dist/deployment/runtime-probe.js`. Keep existing server/CLI/MCP bundles and externalizations.

Build the orchestration helper separately with `entryPoints: { deploy: "dist/deployment/main.js" }`, existing Node/ESM/minification settings, `external: []`, `metafile: true`, no code splitting, and **no third-party externals**. Its complete runtime import closure has this explicit allowlist, expressed as source paths (the build checks their compiled `dist/` equivalents):

| Allowed source/package | Boundary and producer |
| --- | --- |
| `src/deployment/{main,operation,transaction,artifact,services,health,release,ports}.ts` | existing orchestration modules: release S1, ports S2, services S3, health S6, remaining helper source S7; `services` cannot import transaction/CLI/config, and `health` cannot import transaction/config/probe entries |
| `src/voice-worker/maintenance-ipc.ts`, `src/voice-worker/admission.ts` | one shared `requestMaintenance`/wire protocol/atomic mailbox implementation from Task 4/S4 and its S0 pure ledger dependency; mailbox imports only builtins, admission and the logger, with process checks supplied as callbacks |
| `src/paths.ts` | existing builtin-only selector helpers, corrected in Task 7/S3; reuse `resolveHiveHome`, `resolveConfigFile` and `resolveDotenvPath` as needed, passing the selected home explicitly; never use its module-level derived package/data paths to locate the frozen helper's target |
| `src/logging/logger.ts` | existing import-free `createLogger`; only sanitized classifications/allowed evidence are logged |
| `yaml` | bundle the resolved package's own transitive parser files; no second third-party package is allowed by this exception |
| `node:*` | Node builtins only; no runtime dependency-tree lookup |

Keep shared mailbox module initialization inert: importing it cannot start polling, create state, inspect services, or read config/secrets; those operations begin only in explicit client/supervisor functions. Do not duplicate its protocol or client in `deployment/`. Runtime/config/vendor/native probes remain explicit child diagnostics chosen by release path; the helper must never import `config.ts`, worker config/session/telemetry/main, runtime-probe/runtime-diagnostic entries, MongoDB, SDKs or any CLI module, including through a transitive edge. Services and helper identity planning reuse the shared selectors and bundled non-secret YAML parsing without importing `src/cli/single-instance-env.ts` or its callers.

In this helper build only, canonicalize builtin specifiers using `isBuiltin` from `node:module` in an esbuild `onResolve` hook: if builtin, return `{ path: specifier.startsWith("node:") ? specifier : "node:" + specifier, external: true }`; otherwise let normal resolution proceed. The installed YAML parser uses bare `process`/`buffer`, so normalize them without changing that dependency or loosening the external rule. Use `node:module` in the helper's `createRequire` banner too. Check every helper metafile input against the canonical compiled-file allowlist or the resolved YAML package root, and check external imports in both input and output records; reject anything outside the allowlist or any external not starting `node:`. Unresolved/computed runtime module loading is forbidden in the helper; it cannot evade this check through `createRequire` or a dynamic import. Run this guard as part of S8's `npm run bundle`, retaining the existing S9 frozen-helper tests. This produces one frozen JS file that survives `.hive` replacement without copying or borrowing a dependency tree.

At the start of bundling, execute `node scripts/generate-shrinkwrap.mjs --check-source`; at the end emit `pkg/release.json` from the reviewed development lock, without writing a repository-root shrinkwrap:

```typescript
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
  encoding: "utf8",
}).trim().length > 0;
if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("full source revision required");
const release = {
  schemaVersion: 1,
  packageVersion: pkg.version,
  sourceRevision,
  sourceDirty,
  dependencyLockSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};
writeFileSync(resolve(PKG_DIR, "release.json"), JSON.stringify(release, null, 2) + "\n");
```

Use the actual repository root as build cwd. Unknown revision is a build failure; dirty builds may be used in disposable tests but are rejected for migration. Clean release validation must run after the final implementation commit. Do not set dirty=false through a release environment override.

- [ ] **Step 4:** Add the complete shared manifest decoder below to `src/deployment/release.ts`, together with exported SHA/containment helpers. Runtime readers receive an explicit package root; they never use operator cwd to infer the running revision.

```typescript
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
export interface Release {
  schemaVersion: 1;
  packageVersion: string;
  sourceRevision: string;
  sourceDirty: boolean;
  dependencyLockSha256: string;
  voiceWorker: { path: "pkg/voice-worker.min.js"; admissionProtocol: 1 };
}
export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function contained(root: string, path: string): string {
  const base = realpathSync(root);
  const actual = realpathSync(path);
  const rel = relative(base, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("runtime path escapes release");
  return actual;
}
export function readRelease(root: string, requireClean = false): Release {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (pkg.name !== "@keepur/hive" || typeof pkg.version !== "string") throw new Error("unexpected package identity");
  const raw: unknown = JSON.parse(readFileSync(resolve(root, "pkg/release.json"), "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("release manifest missing");
  const r = raw as Partial<Release>;
  if (r.schemaVersion !== 1 || r.packageVersion !== pkg.version || typeof r.sourceDirty !== "boolean" ||
      !/^[a-f0-9]{40}$/.test(r.sourceRevision ?? "") ||
      !/^[a-f0-9]{64}$/.test(r.dependencyLockSha256 ?? "") ||
      r.voiceWorker?.path !== "pkg/voice-worker.min.js" || r.voiceWorker.admissionProtocol !== 1) {
    throw new Error("unsupported or inconsistent release manifest");
  }
  if (requireClean && r.sourceDirty) throw new Error("dirty candidate is ineligible for migration");
  const lock = readFileSync(resolve(root, "npm-shrinkwrap.json"));
  if (sha256(lock) !== r.dependencyLockSha256) throw new Error("dependency lock digest mismatch");
  const locked = JSON.parse(lock.toString("utf8"));
  if (locked.packages?.[""]?.version !== pkg.version) throw new Error("shrinkwrap version mismatch");
  for (const file of ["pkg/server.min.js", "pkg/cli.min.js", r.voiceWorker.path,
    "pkg/voice-worker-diagnostic.min.js", "pkg/runtime-probe.min.js", "pkg/deploy.min.js", "pkg/mcp/voice-livekit.min.js"]) {
    if (!statSync(contained(root, resolve(root, file))).isFile()) throw new Error(`missing artifact: ${file}`);
  }
  return r as Release;
}
export function bootIdentity(release: Release, component: "engine" | "voice-worker") {
  return { release, component, pid: process.pid, bootId: randomUUID(), startedAt: new Date().toISOString() };
}
export type BootIdentity = ReturnType<typeof bootIdentity>;
```

Also compare all three dependency maps in `readRelease` using `isDeepStrictEqual`, as in the generator, before accepting an artifact; this closes the forged-manifest/lock-root mismatch path before npm runs. `readRelease` is a strict packaged-release decoder. Separate legacy classification returns unavailable fields; it never synthesizes a Release from the installed candidate.

- [ ] **Step 5:** Extend `scripts/check-bundle-pack.mjs` required files with worker, both diagnostic helpers, deploy helper, manifest and shrinkwrap. Preserve all MCP/ABI requirements, exclusions and the 10 MB compressed failure threshold. Add `readRelease`/manifest fixture tests for missing file, external symlink, bad digest, unknown schema, dirty migration, mismatched package/version/dependency maps. Add `scripts/generate-shrinkwrap.test.mjs` with real npm subprocesses against a disposable source-package fixture and two locally packed versions of a tiny dependency. Run the actual generator and packaging command: fixture bundle → assert no root shrinkwrap → update package/lock to the second dependency using `npm install --package-lock-only --ignore-scripts` → `npm install --ignore-scripts` → assert the second version is installed and package-lock remains authoritative → assert packing the stale bundle fails → rebuild its manifest → repack → extract and compare published shrinkwrap bytes/digest with the new package-lock. The fixture's build runs the same `--check-source` and manifest-hash path; separately assert the actual repository `npm run bundle` leaves no root shrinkwrap. Test malformed lock/maps, accidental root shrinkwrap rejection, direct source prepack rejection, packlist preservation, packing failure and dry-run cleanup. Inspect only fixture roots and never publish these packages. Append this Node test to `check:bundle` before the pack guard. Run this full block in S8 after both packaging and Task 3 installer/harness changes are implemented; the combined artifact checkpoint requires this block and Task 3 Step 4 to pass before commit:

```bash
npm run bundle
node scripts/generate-shrinkwrap.mjs --check
node --test scripts/generate-shrinkwrap.test.mjs
node scripts/check-bundle-pack.mjs
npx vitest run src/deployment/release.test.ts
```

Expected: all exit 0, the helper's complete graph matches Step 3's allowlist with only `node:` externals, worker assets appear in real pack listing and no forbidden paths appear. Final Task 11 runs all existing guards and native acceptance.

## Task 3: Fresh production installation and native/SDK artifact acceptance

**Files:** `src/setup/populate-engine.ts`, `src/setup/populate-engine.test.ts`, `src/voice-worker/runtime-diagnostic.ts`, `scripts/check-artifact-install.mjs`, `scripts/check-bundle-runtime.mjs`, `scripts/check-bundle-runtime.test.mjs`, `package.json`.

**Schedule:** Create Step 2's real diagnostic source in S6 and verify compilation with `npm run build`; do not invoke its offline runtime mode before a complete package exists. Steps 1, 3–4 run in S8 together with Task 2's packaging completion, after Task 8/S7 supplies the extraction/transaction implementation and all helper imports. The complete S8 checks below remain mandatory before the artifact checkpoint.

- [ ] **Step 1:** Add `npm-shrinkwrap.json` to `PACKAGE_ENTRIES`. Replace `ensureEngineDeps`'s node_modules-exists shortcut with strict artifact validation followed by complete `npm ci --omit=dev --no-audit --no-fund --no-progress` on every explicit resume/install attempt. Never run this repair against a loaded active release during update; stage in `.hive.next`. A complete install marker can be diagnostic, but is not permission to skip revalidation after an interrupted attempt.

```typescript
export function ensureEngineDeps(engineDir: string): void {
  readRelease(engineDir);
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"], {
    cwd: engineDir,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [resolve(engineDir, "pkg/voice-worker-diagnostic.min.js"), "offline"], {
    cwd: engineDir,
    stdio: "inherit",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}
```

Here `readRelease` is imported from `../deployment/release.js`. `skipInstall` remains an injected unit-test-only option and must not be reachable from shipped CLI flags. Resume without package/lock/helper fails with a named missing artifact; do not silently return. `populateEngine` verifies the source artifact before creating `.hive` and copies only `PACKAGE_ENTRIES`. Add the same post-install diagnostic in staged update and bootstrap tooling installation. Record npm/Node versions in the operation evidence. A lock/native/install mismatch must fail while old services remain up.

- [ ] **Step 2:** Create a secret-free `runtime-diagnostic.ts` entrypoint. It imports only builtins/release decoder at top level. For `offline`, validate the explicit package root derived from this helper's `import.meta.url`, load every external LiveKit package from that root, validate pinned versions by walking from the resolved module to its package.json, construct/dispose a native RTC Room, and call `silero.VAD.load({ forceCPU: true })`. It never imports the shared config, loads dotenv, consults Keychain, connects Mongo/LiveKit, or enters a job.

Required load code within `offline()`:

```typescript
const agents = await import("@livekit/agents");
const rtc = await import("@livekit/rtc-node");
const cartesia = await import("@livekit/agents-plugin-cartesia");
const deepgram = await import("@livekit/agents-plugin-deepgram");
const elevenlabs = await import("@livekit/agents-plugin-elevenlabs");
const silero = await import("@livekit/agents-plugin-silero");
if (typeof agents.defineAgent !== "function" || !cartesia.TTS || !deepgram.STT || !elevenlabs.TTS) {
  throw new Error("worker runtime export missing");
}
const room = new rtc.Room();
await silero.VAD.load({ forceCPU: true });
await room.disconnect();
await rtc.dispose();
```

Resolve and inspect the actual RTC addon, ONNX shared library and installed `silero_vad.onnx`, with realpaths inside the inspected release. Compare `process.report.getReport().sharedObjects` before/after loading to identify the loaded native files, excluding Node/system libraries; require evidence of RTC and ONNX native load, not merely package directories. Walk only the resolved Silero package for its single `silero_vad.onnx` file and require containment/existence. Record paths relative to the release and hashes, package versions, SDK child/inference helper paths, Node/npm/platform/arch and the manifest in `ARTIFACT_RUNTIME_OK` JSON. Missing expected native load/asset is failure even if imports succeeded. Error output contains only named stage/package/path classifications, never arbitrary environment dumps. The process exits 0 only after all checks and cleanup complete; catch sets a nonzero exit and prints `ARTIFACT_RUNTIME_FAILED`.

- [ ] **Step 3:** In `scripts/check-artifact-install.mjs`, implement this exact flow using `execFileSync`/`spawn` argument arrays, a disposable scratch HOME and bounded subprocesses:

1. `node scripts/generate-shrinkwrap.mjs --pack --json --pack-destination <scratch>` against the built repository; this runs real `npm pack` in the Task 2 disposable package stage. Parse npm array/object JSON formats as the existing guard does. Hash the actual archive and require its shrinkwrap bytes to equal the reviewed development lock without creating a repository-root shrinkwrap.
2. List archive entries; require `package/` prefix, reject absolute/traversal members, unexpected links and forbidden content. Extract into `<scratch>/instance & space/.hive` with no links to repository files. The extraction adapter from Task 8 performs the same checks for update.
3. Confirm no ancestor/global `node_modules` and unset `NODE_PATH`/`NODE_OPTIONS`; set scratch `HOME`, plain host `PATH`, no voice/model/Slack/Mongo keys. Run `npm ci --omit=dev --no-audit --no-fund --no-progress` inside the extracted root with install scripts enabled.
4. Run installed `pkg/voice-worker-diagnostic.min.js offline`, require its structured success marker and validate every reported realpath under this release. Check both service entries are real files under this root.
5. Fork the **installed SDK's actual** `dist/ipc/job_proc_lazy_main.js` with **installed** `pkg/voice-worker.min.js`, drive initializeRequest/initializeResponse/shutdownRequest, and require exit 0. This is only an import/prewarm test; never send startJobRequest to the production agent. Assert no supervisor boot/heartbeat/config lookup occurred. Print `SDK_IMPORT_OK` only after IPC and exit success.
6. Direct-start the installed worker with scratch config `voice.livekit.enabled: false`, dummy Slack required keys in its scratch dotenv, and the fixture `security` shim (exit 44) at the front of PATH; require the deliberate named `voice.livekit.enabled is false` nonzero boot failure. This narrow test proves the entrypoint executes; it is separate from native success and does not count as native acceptance.
Also execute the installed server with a separate empty scratch configuration and Keychain shim; require its exact `Missing required env var: SLACK_APP_TOKEN` failure and absence of module-resolution/native-load errors. This proves engine module loading only and is never counted as native or healthy-boot evidence. Neither entrypoint smoke connects Mongo or vendors.
7. Move the complete instance directory to another non-repository parent and repeat steps 4–6. Add an intentional symlink to that instance and invoke through it, plus spaces/ampersands in directory/config selectors. Canonical containment follows the real instance root.
8. Capture a structured `ARTIFACT_INSTALL_OK` record with archive digest, lock digest, release identity, relative path list and runtime versions. Clean only this harness's root/processes.

Use a temporary child Node launcher if necessary to assert no source/dev/global resolution. Never install dev dependencies into the extracted release, symlink node_modules, use tsx for installed commands, replace the SDK loader with `import()` alone, or accept an arbitrary config error as native success.

- [ ] **Step 4:** Add `check:artifact: node scripts/check-artifact-install.mjs`; append `npm run check:artifact` to `check:bundle` after existing bundle guards. `check:artifact` requires an already-built package to avoid recursive pack/bundle hooks. Keep the existing lightweight runtime smoke, but revise **all four subprocess paths** in `scripts/check-bundle-runtime.mjs` (CLI version/help, source-package server, relocated server) to use one explicit isolated launcher. Export its fixture/environment factory for `scripts/check-bundle-runtime.test.mjs`; guard execution so importing the module for tests does not launch checks.

Create one `mkdtempSync` scratch root per run with separate `home`, `instance`, `bin` and `tmp` directories. Create an explicit scratch config containing only `instance.id: bundle-smoke`, and an empty matching dotenv file. Prepend a fixture `security` executable that records its argument array to a scratch-only log and exits 44. It must never delegate to `/usr/bin/security`. Use this complete environment allowlist for every retained-smoke child; do not spread `process.env` or reuse an inherited PATH:

```javascript
const childEnv = {
  HOME: scratchHome,
  HIVE_HOME: scratchInstance,
  HIVE_CONFIG: scratchConfigPath,
  PATH: [scratchBin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  TMPDIR: scratchTmp,
  NODE_ENV: "test",
  HIVE_SMOKE_KEYCHAIN_LOG: scratchKeychainLog,
};
```

Every `execFileSync` uses `process.execPath`, argument arrays, `cwd: scratchInstance`, this `env`, and a 10-second timeout. `NODE_PATH`, `NODE_OPTIONS`, npm environment selectors, inherited `HIVE_*` selectors and all operator credential variables are absent. The source-package server still loads its actual built entrypoint by absolute path, while the relocation check retains its existing copied-bundle/repository-node_modules arrangement solely as a path regression. Copy `pkg/release.json` and the generated lock into a **scratch** relocated package when required for its new startup identity checks; obtain the lock bytes from the same validated package-lock, never write it into the repository. CLI output assertions remain exact; neither CLI command gets operator settings.

Replace both permissive server catches: require a nonzero ordinary exit with the exact `Missing required env var: SLACK_APP_TOKEN` error, no timeout/signal, and no syntax/module/native-load error. Successful exit, Mongo connection errors or arbitrary config errors fail this smoke. The empty scratch config/Keychain shim must stop startup at this named required-key boundary before any vendor/database connection. The launcher closes/reaps only its own children and removes scratch files in `finally`.

In `scripts/check-bundle-runtime.test.mjs`, seed a second **fake operator** fixture with conflicting HOME, HIVE_HOME, absolute HIVE_CONFIG, dotenv credentials, NODE_PATH/NODE_OPTIONS and dummy vendor keys. Inject those values into the parent environment after the test process starts, then assert the factory drops them all, preserves only the explicit allowlist, and restores parent environment after each test. Run every launcher branch with test-owned entrypoint probes that report environment/cwd, attempt a Keychain read and attempt config/dotenv selection; assert scratch selectors/paths in all four branches, the shim's exit 44, and no fake-operator sentinel values or path reads. Separately run the actual retained bundle smoke and assert both server failures are exactly the missing Slack key; on macOS require the shim log's `hive/bundle-smoke/SLACK_APP_TOKEN` lookup. Use test-owned connection spies/denial guards to assert zero Mongo/vendor connection attempts rather than waiting for a connection error. Test timeout, unexpected clean exit and wrong error rejection. Add `node --test scripts/check-bundle-runtime.test.mjs` before the retained runtime smoke in `check:bundle`; these tests are isolation evidence, while T2 still requires the fresh installed artifact.

Test partial node_modules resume, missing/mismatched shrinkwrap, native-install failure, relocation, source package absence and library symlink escape. Run:

```bash
npm run bundle
node --test scripts/check-bundle-runtime.test.mjs
node scripts/check-bundle-runtime.mjs
npm run check:artifact
npx vitest run src/setup/populate-engine.test.ts
```

Expected: real artifact install/load/import markers and all tests pass. A native prerequisite failure names the failed package/runtime stage and blocks T2; it is not skipped. On the implementation host record whether this was Node 24/macOS ARM64 or a supplementary platform.

**Checkpoint:** after both Task 2 Step 5 and Task 3 Step 4 blocks pass, commit the reviewed S8 packaging/install/harness files. Runtime and lifecycle sources were prerequisites, not next tasks. Continue with S9 packaged lifecycle/adoption integration in [Tasks 7–9](./kpr-463-plan-lifecycle.md), then S10–S12. Passing this artifact checkpoint alone does not establish deployment acceptance.
