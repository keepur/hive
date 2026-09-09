# KPR-464 offline capability evidence

This records capability observations and their limits. It is not implementation verification, caller acceptance, or approval to deploy/place calls. The [plan's Task 0](./kpr-464-plan.md#task-0-finish-exact-artifact-offline-capability-proof-before-readiness) retains the remaining readiness checks.

## Exact artifact and runtime

- Repository HEAD for this documentation/probe run: `8d0dcfeef8756305df0aefc25d8f019f2fa51587`.
- Repository `package-lock.json` SHA-256: `197bbe521ff1ff5000d8ad0586dc0765e013d770e6588b909e4e7c3e9b3f1089`.
- `@livekit/agents`: `1.6.4`; npm tarball SHA-512 verified against that lock: `sha512-Q+qlXmR8wLB4aMm2K5bt1ijItuMcoyfHvAHp047ORf2+yhIwR6csKfo95ErPbszWzgnLf7nIGSvJjvNVSh9okA==`.
- `@livekit/rtc-node`: `0.13.33`.
- Re-executed documentation probe: Node `v24.16.0`, macOS `darwin`, `arm64`; exit 0.
- Artifact source: [pinned npm tarball](https://registry.npmjs.org/@livekit/agents/-/agents-1.6.4.tgz). The same-version GitHub tag is not used as artifact identity proof.

Durable source: [SDK probe](./probes/kpr-464-sdk-probe.mjs). Actual stdout: [SDK results](./probes/kpr-464-sdk-results.json). The source contains assertions on the observations listed below; a mismatch exits nonzero. It uses no instance config/secrets, real room, SIP call, remote provider or Mongo. Fake STT/LLM/TTS use the installed SDK provider/session classes.

Reproduction after `npm ci` with the repository lock and Node 24:

```bash
node docs/epics/kpr-462/probes/kpr-464-sdk-probe.mjs
```

An optional first argument selects an isolated npm runtime directory containing `node_modules`. The recorded authoring run used the verified scratch runtime:

```bash
/opt/homebrew/opt/node@24/bin/node docs/epics/kpr-462/probes/kpr-464-sdk-probe.mjs /Users/mokie/github/hive-epic-kpr-462/.dodi/sdk464-probe/runtime
```

That scratch path is not required to reproduce the checked-in source; use the normal worktree `npm ci` installation. Do not create runtime/deployment dependency links to the scratch directory.

## Executed observations

| Probe | Observation | Limit |
| --- | --- | --- |
| Direct LLM close before run, before modeled headers, after modeled headers/no text, during text | Six stream monitors retain their distinct app ALS turn IDs; first three canceled metrics have empty provider request ID and TTFT `-1`. | The phase barriers are fake-provider gates, not real HTTP; only the first three genuinely have no content. |
| Two direct streams overlap/reverse settlement | Each metric retains its own turn ID even though provider request ID is the same. | This is no proof that arbitrary SDK metrics carry app context outside this seam. |
| Full AgentSession no-content generation | Session metric's speech ID equals the actual SpeechHandle ID and coexists with app ALS turn ID. | The probe does not execute all direct cancellation phases inside a full audio session. |
| Handle-specific interrupt and replacement | First handle interrupted, replacement completes, both real session metrics retain correct distinct speech/turn IDs. | No real Hive HTTP adapter, synthesized audio or handset receipt in this case. |
| Fake STT accepted caller turn | Public `Agent.onUserTurnCompleted` observes nonempty input before `SpeechCreated`. | Does not yet prove every speaking/listening/false-interruption or SIP-answer ordering. |
| TTS stream wrapper | First frame object identity and copied timed metadata remain intact; normal metric retains synthesis ALS ID. | The probe reconstructs the default-node body; it does not call actual `Agent.default.ttsNode` inside a real session. |
| TTS cancellation before first frame | No TTS metric is emitted. | There is no speech association supplied by such a metric. Explicit finalizer/unbound evidence is necessary; never synthesize metrics or infer a speech ID. |

The application must use the public accepted-turn hook, not a nonexistent accepted-turn session event or `ConversationItemAdded`, which happens after scheduling. It should use public `addDoneCallback`/`chatItems` for completion/item evidence. The probe's SDK handle interruption result supports canceling the known stale opening's own handle, rather than interrupting the session's current replacement.

## HTTP ownership reproduction

Durable source: [HTTP reproduction](./probes/kpr-464-http-reproduction.test.ts), [isolated Vitest config](./probes/vitest.config.ts). The independent HTTP probe's reported command exited 0, 1 file/1 test passed in 130 ms, against the same baseline adapter source. Its original command used the development Vitest executable and isolated scratch configuration; this writer copied the source with only repository-relative import adjustment and did not claim a second HTTP test execution.

After worktree `npm ci`, reproduce with:

```bash
npx vitest run --config docs/epics/kpr-462/probes/vitest.config.ts --reporter=verbose
```

The test starts the real VoiceAdapter with a stub coordinator on an authenticated loopback HTTP connection. It holds the predecessor's registered `ServerResponse.close` callback, destroys that client socket, admits a same-call replacement, then releases the held callback. The adapter calls `abortThread(agentId, threadId)` with no request identity; the stub coordinator necessarily selects the replacement as current work and cancels it.

This proves the unsafe adapter API/order. It does **not** prove the exact cold/warm manager implementations' scheduling. The required implementation regression composes the real adapter with real AgentManager/WarmVoiceSession and fake providers, asserting predecessor cancellation cannot cancel queued/active replacement work and the replacement progresses to normal text/frame completion. The selected plan correction is a request-owned AbortSignal carried through TurnContext; it expresses the same required ownership without adding a global ID lookup/cancel map. Existing abortThread semantics remain available to other callers.

## Remaining gate evidence

Before readiness, complete the planned public SDK seam proof: actual default TTS node with original timed-frame metadata, frame/cancel/backpressure behavior and generated-frame association; full-session bridge no-content/cancellation/overlap matrix; actual startup-state/accepted-hook/false-interruption order and handle/error/metrics finalization order. Do not turn the direct-provider tests into broad capability claims.

A pre-frame TTS cancellation may honestly end as an unbound synthesis attempt because the SDK emits no metric. This observation alone must not be renamed a proved speech binding. If the approved complete-correlation contract requires more than the public surfaces can provide, return to specification review with the failed case; do not hide the gap in the plan or permit readiness by weakening a required regression.

No SIP, live call, handset confirmation, deployment or historical root cause was established by these probes.
