# KPR-348 Task 0 — Spike Evidence (T0a)

**Worktree:** `hive-lane-kpr-348` @ branch `kpr-348`, HEAD `71c77e5` · Node v24.16.0 · macOS.
**Installed SDK:** `@openai/agents` **0.11.4** (re-exports `@openai/agents-core` **0.11.4**); `@modelcontextprotocol/sdk` **1.29.0**.
**Scripts:** throwaway drivers run from the session scratchpad (symlinked `node_modules` → worktree, `{"type":"module"}` package.json so top-level `await` runs under tsx ESM). Reproduced verbatim below; not committed. Secret *values* are never logged — only presence + result *shape*; the keychain/Slack payloads returned real business data and are elided here.

**Blocking-leg verdict: S1 GREEN, S2 GREEN.** No STOP condition. S3 GREEN. S4 schema-acceptance GREEN; S4 live-turn half DEFERRED to T0b (non-blocking, see §S4). S5 = hand-rolled (default) confirmed.

---

## Step 0.1 — Install + build

`npm ci` was already done at branch point; `npm run build` (`tsc`) exits 0. Both stdio server entry points present:

```
dist/keychain/keychain-mcp-server.js      (6376 bytes)
dist/background/background-task-mcp-server.js (6021 bytes)
```

**Credential presence** (values not read into logs): `SLACK_MCP_TOKEN` PRESENT (Honeypot `hive/dodi/SLACK_MCP_TOKEN`); `~/.codex/auth.json` PRESENT; `OPENAI_API_KEY` NOT set.

---

## Step 0.2 — S1: `MCPServerStdio` fidelity vs real hive stdio servers — **GREEN**

**Import path that works:** `import { MCPServerStdio, MCPServerStreamableHttp, MCPServerSSE } from "@openai/agents"`. `@openai/agents/dist/index.d.ts` does `export * from '@openai/agents-core'`; agents-core `index.d.ts:17` explicitly re-exports `MCPServerStdio`, `MCPServerStreamableHttp`, `MCPServerSSE`, `getAllMcpTools`, `mcpToFunctionTool`. **No explicit `@openai/agents-core` dep needed** — Task 1.1 imports from `@openai/agents` (Task 0.7 "S1 import path" = green/default row).

Script (`spike-s1.ts`):

```ts
import { MCPServerStdio } from "@openai/agents";
const WT = "/Users/mokie/github/hive-lane-kpr-348";
async function connectServer(name, command, args, env) {
  const server = new MCPServerStdio({
    name, command, args, env, cwd: WT,
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 30, // option exists; unit confirmed SECONDS (S3)
  });
  await server.connect();
  return server;
}
const t0 = Date.now();
const keychain   = await connectServer("keychain",   "node", [`${WT}/dist/keychain/keychain-mcp-server.js`], { KEYCHAIN_SERVICE: "hive/dodi" });
const background = await connectServer("background", "node", [`${WT}/dist/background/background-task-mcp-server.js`], {
  BG_TASK_API: "http://127.0.0.1:9999", BG_AUTH_TOKEN: "spike", BG_AGENT_ID: "spike",
  BG_ADAPTER_ID: "", BG_CHANNEL_ID: "", BG_CHANNEL_KIND: "internal", BG_CHANNEL_LABEL: "",
  BG_THREAD_ID: "", BG_SLACK_TS: "", BG_SLACK_THREAD_TS: "",
});
const keychain2  = await connectServer("keychain2",  "node", [`${WT}/dist/keychain/keychain-mcp-server.js`], { KEYCHAIN_SERVICE: "hive/dodi" });
console.log("3-server concurrent connect ms:", Date.now() - t0);
for (const s of [keychain, background, keychain2]) {
  const tools = await s.listTools();
  console.log(s.name, "tools:", tools.map(t => t.name));
  console.log(s.name, "first schema:", JSON.stringify(tools[0]?.inputSchema));
}
const kcTools = await keychain.listTools();
const listTool = kcTools.find(t => /list/.test(t.name)) ?? kcTools[0];
const result = await keychain.callTool(listTool.name, {});
console.log("callTool result shape:", JSON.stringify(result).slice(0, 500));
await Promise.all([keychain.close(), background.close(), keychain2.close()]);
```

Observed output (secret inventory elided):

```
3-server concurrent connect ms: 393
keychain   tools: [ 'secret_get', 'secret_list' ]
keychain   first schema: {"type":"object","properties":{"account":{"type":"string",...},"service":{...}},"required":["account"],"$schema":"http://json-schema.org/draft-07/schema#"}
background tools: [ 'bg_execute', 'bg_status', 'bg_list' ]
background first schema: {"type":"object","properties":{"command":{"type":"string",...},"args":{"type":"array","items":{"type":"string"},...},"cwd":{...}},"required":["command"],"$schema":"http://json-schema.org/draft-07/schema#"}
keychain2  tools: [ 'secret_get', 'secret_list' ]
keychain calling tool: secret_list
callTool result shape: [{"type":"text","text":"<TSV list of hive/dodi/<KEY>\\t<label> rows — ELIDED>"}]
closed all 3 servers
```
Orphan check after close: `pgrep -f mcp-server` → empty (no orphan mcp-server processes).

**Evidence checklist:**
- [x] Import path: `@openai/agents` (core re-export; no extra dep).
- [x] connect + `listTools` + `callTool` round-trip transcript for both real servers (keychain `secret_list` returned live Honeypot key-name TSV — elided; background listed 3 tools).
- [x] Schema sample from each server's `tools/list` captured (used for S4 tally).
- [x] Concurrency: 3 servers connected in parallel in **393 ms**, no interference, independent tool lists.
- [x] Env: explicit vars won (KEYCHAIN_SERVICE/BG_* honored); inherited HOME/PATH present — keychain's `security` invocation **succeeded** (needs PATH), which is the env-inheritance evidence.
- [x] `close()` leaves no orphan (`pgrep -f mcp-server` empty).
- [x] Constructor option interface (pasted from `node_modules/@openai/agents-core/dist/mcp.d.ts:299-320`):

```ts
export interface BaseMCPServerStdioOptions {
  env?: Record<string, string>;
  cwd?: string;
  cacheToolsList?: boolean;
  clientSessionTimeoutSeconds?: number;
  name?: string;
  encoding?: string;
  encodingErrorHandler?: 'strict' | 'ignore' | 'replace';
  logger?: Logger;
  toolFilter?: MCPToolFilterCallable | MCPToolFilterStatic;
  toolMetaResolver?: MCPToolMetaResolver;
  errorFunction?: MCPToolErrorFunction | null;
  timeout?: number;
}
// + DefaultMCPServerStdioOptions extends it with { command: string; args?: string[] }
```

---

## Step 0.3 — S2: hosted Slack MCP via `MCPServerStreamableHttp` + `requestInit` auth — **GREEN** (blocking assumption b)

Script (`spike-s2.ts` / follow-up `spike-s2b.ts`):

```ts
import { MCPServerStreamableHttp } from "@openai/agents";
const token = process.env.SLACK_MCP_TOKEN; // security find-generic-password -s "hive/dodi/SLACK_MCP_TOKEN" -w
const server = new MCPServerStreamableHttp({
  name: "slack",
  url: "https://mcp.slack.com/mcp",
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
  cacheToolsList: true,
  clientSessionTimeoutSeconds: 30,
});
await server.connect();
const tools = await server.listTools();
// s2b: real read-only call
const res = await server.callTool("slack_search_public", { query: "hive", limit: 2 });
await server.close();
```

Observed output (search results elided):

```
token present: true
connect: OK (no auth error thrown)          <-- 200-class handshake via requestInit Authorization header, NOT 401
slack tool count: 15
slack tools: [ slack_send_message, slack_schedule_message, slack_create_canvas, slack_update_canvas,
  slack_search_public, slack_search_public_and_private, slack_search_channels, slack_search_users,
  slack_read_channel, slack_read_thread, slack_read_canvas, slack_read_user_profile,
  slack_list_channel_members, slack_read_file, slack_send_message_draft ]
# arg-less call → server-side validation error (proves authenticated round-trip reached tool-arg layer):
slack_search_public {} -> [{"type":"text","text":"initialization_failed: Missing value for parameter `query`"}]
# s2b with real arg → SUCCESS:
slack_search_public {query:"hive",limit:2} -> [{"type":"text","text":"{\"results\":\"# Search Results for: hive ... <2 real messages — ELIDED>\"}"}]
closed slack server
```

**Verdict:** connect succeeded with a 200-class handshake (not 401), 15 tools listed, one read-only `callTool` returned real authenticated search results. Header pass-through via `requestInit.headers.Authorization` works end-to-end. **Blocking assumption (b) PASSES.** No fallback needed (raw `StreamableHTTPClientTransport` remains the documented fallback in the 0.7 table but is unused).

---

## Step 0.4 — S3: timeout UNITS — **GREEN**

**Source half** (`node_modules/@openai/agents-core/dist/shims/mcp-server/node.js`):

```js
function buildRequestOptions(clientSessionTimeoutSeconds, overrides) {
  const baseOptions = clientSessionTimeoutSeconds === undefined
    ? undefined
    : { timeout: clientSessionTimeoutSeconds * 1000 };      // <-- SECONDS → ms (×1000)
  const mergedOptions = { ...(baseOptions ?? {}), ...(overrides ?? {}) };
  return Object.keys(mergedOptions).length === 0 ? undefined : mergedOptions;
}
// constructor: this.clientSessionTimeoutSeconds = params.clientSessionTimeoutSeconds ?? 5;
//              this.timeout = params.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;   // <-- ms, MCP-SDK default
// callTool:    buildRequestOptions(this.clientSessionTimeoutSeconds, { timeout: this.timeout });
//              -> override { timeout: this.timeout } (ms) WINS over the session base for the per-call RPC
//              -> passed straight to @modelcontextprotocol/sdk session.callTool(params, undefined, requestOptions)
//                 i.e. RequestOptions.timeout (MILLISECONDS).
```

**Live half** — fixture stdio server (`spike-s3-server.ts`, MCP SDK `McpServer` + `StdioServerTransport`, one `sleep3` tool sleeping 3000 ms) called via `MCPServerStdio({ timeout: 1500 })`:

```
connected, calling sleep3 with timeout:1500 ...
callTool FAILED after 1503ms (expected ~1500 if ms): MCP error -32001: Request timed out
```

Failed at **1503 ms** with MCP `-32001 Request timed out` → the per-call knob is **milliseconds**. If it were seconds the 3 s call would have succeeded; it did not.

**Canon for Task 1.1 constants:**
- `clientSessionTimeoutSeconds`: **SECONDS** (session RPCs — connect/listTools; internally ×1000). SDK default 5.
- `timeout` (constructor option): **MILLISECONDS** (per-tool-call `RequestOptions.timeout`; overrides the session base for `callTool`). SDK default = MCP `DEFAULT_REQUEST_TIMEOUT_MSEC`.
- Task 1 passes the session budget as `clientSessionTimeoutSeconds` (seconds) and the per-call budget as `timeout` (ms) — no unit conversion at the call site; the shim converts the session value.

---

## Step 0.5 — S4: schema-normalization sampling + `tool()` acceptance — schema-half **GREEN**, live-turn half **DEFERRED to T0b**

**Fleet schema tally** (stdio keychain + http Slack, 17 tools; `spike-s4-tally.ts`):

```
keychain/secret_get:  required=true  additionalProperties=absent  $schema=draft-07
keychain/secret_list: required=absent additionalProperties=absent  $schema=draft-07
slack/* (all 15):     required=true  additionalProperties=absent  $schema=absent
```

Findings: **`additionalProperties` is absent on every sampled tool** (both transports); `required` is occasionally absent (`keychain_secret_list`); `$schema` (draft-07) present on hive-authored stdio servers, absent on hosted Slack. Normalization adds `required: []` + `additionalProperties: false` where missing and drops `$schema`.

**`tool()` acceptance** (`spike-s4.ts`, `strict: false`): both a **raw** fleet schema (no `additionalProperties`) and a **normalized** schema were accepted at construction with no throw:

```
tool() accepted raw schema (no throw at construction): true
tool() accepted normalized schema (no throw at construction): true
```

**Live-turn half — DEFERRED to T0b.** The live `openai/…` turn (Agents SDK `Runner` + `new OpenAI({ apiKey: codexTokenProvider })`, model `gpt-5.4-mini`) failed:

```
LIVE turn error: 401 You have insufficient permissions for this operation.
  Missing scopes: api.responses.write.
```

Root cause (not a stale token — the codex access token is valid ~6.5 days, `aud: ["https://api.openai.com/v1"]`): the **codex ChatGPT-subscription** token cannot call the **Responses API on `api.openai.com`**. The working codex path (`codex-subscription-adapter.ts:7,74`) posts raw HTTP to `https://chatgpt.com/backend-api/codex/responses`, **not** the default OpenAI base URL the Agents SDK `Runner` uses. No `OPENAI_API_KEY` is set to substitute.

Per the plan's round-1 amendment, S4 is **non-blocking** and its live-turn half is evidence-deferred to Task 4 **T0b (Step 4.1)**. S1/S2 both passed, so this is **not** a STOP. The schema-acceptance signal that Task 1.1's normalization posture depends on is green independently.

> **Concern flagged for T0b:** `OpenAIAgentsAdapter`'s OAuth attempt (`new OpenAI({ apiKey: tokenProvider })`, default `api.openai.com` base) 401s for a codex subscription token against the Responses API. T0b must exercise the live openai turn with a Responses-capable credential — either an `OPENAI_API_KEY` with `api.responses.write`, or a base-URL/backend path compatible with the codex token. This may surface an adapter-auth gap the OpenAI-lane live turn depends on.

---

## Step 0.6 — S5: `getAllMcpTools` vs hand-rolled — **hand-rolled (default) confirmed**

Flip to `getAllMcpTools` + `FunctionTool.invoke` decoration was gated on S4 showing the non-strict `tool()` path **rejecting** fleet schemas. S4 showed the opposite — `tool({ strict: false })` **accepted** both raw (missing `additionalProperties`) and normalized fleet schemas at construction, with no wholesale rejection. **Decision: hand-rolled** — the bridge calls `listTools`/`callTool` itself and builds `tool()` per discovered (normalized) schema. `BridgedTool` hides the choice (spec §D2). Final runtime-conversion confirmation rides along with T0b's live turn; nothing observed contradicts hand-rolled.

---

## Step 0.7 — Spike-outcome dependency table (contract for Tasks 1–4)

| Spike leg | Outcome consumed by | Verdict | Path taken |
|---|---|---|---|
| S1 stdio fidelity | Task 1.1 transport layer | **GREEN** | `MCPServerStdio` from `@openai/agents` (default). Raw MCP `Client` fallback unused. |
| S1 import path | Task 1.1 imports | **GREEN** | import from `@openai/agents` (default). No explicit `@openai/agents-core` dep. |
| S2 hosted auth | Task 1.1 http transport | **GREEN** | `MCPServerStreamableHttp` + `requestInit` (default). Raw `StreamableHTTPClientTransport` fallback unused. |
| S3 units | Task 1.1 constants | **GREEN** | `clientSessionTimeoutSeconds` = SECONDS (session); `timeout` = MILLISECONDS (per-call). Pass as recorded units at those knobs. |
| S4 schema acceptance | Task 1.1 normalization + Task 3.2 binding | **GREEN (schema)** / **DEFERRED (live)** | normalize-and-pass with `strict: false` (default). `additionalProperties` universally absent → filled. Live conversion confirmation deferred to T0b. |
| S5 conversion | Task 1.1 / 3.2 | **GREEN** | hand-rolled `tool()` (default). No `getAllMcpTools` flip. |
| Per-turn spawn cost | matrix note only | note | 3 concurrent stdio servers connected in **393 ms** — no KPR-122-class churn signal; pooling remains a follow-up only if live turns show worse. |

**STOP condition:** not triggered — S1 and S2 both GREEN.

---

# KPR-348 Task 4 — Live e2e evidence (T0b) + final verification

**Worktree:** `hive-lane-kpr-348` @ branch `kpr-348`, HEAD `e7ec72c` (Chunks 1-3 committed) · Node v24.16.0 · macOS.
**Scripts:** throwaway drivers in the session scratchpad (symlinked `node_modules` → worktree, `{"type":"module"}` package.json, run under tsx ESM). Reproduced verbatim below; not committed. Secret *values* never logged — presence + result *shape* only; the keychain payload (Honeypot key names) is elided.

**T0b verdict:** live model-turn leg **BLOCKED** (no Responses-capable OpenAI credential exists anywhere — concrete external blocker, not a code defect; the post-implementation adapter reaches the provider and 401s exactly at the credential boundary). Every leg that can run WITHOUT the model was driven green via the mandatory scratch-driver path: bridged-MCP (stdio) **GREEN**, builtin **GREEN**, abort/containment **GREEN**, connect cost noted. **Final verification (Step 4.2) fully GREEN.**

## §T0b.0 — Credential probe (presence/absence only — no values read)

Repeating the S4 concern's remediation checklist against every location:

```
OPENAI_API_KEY env:            NOT SET
Honeypot hive/dodi/OPENAI_API_KEY:    ABSENT
Honeypot hive/keepur/OPENAI_API_KEY:  ABSENT
Honeypot hive/dodi/OPENAI_KEY:        ABSENT
Honeypot hive/keepur/OPENAI_KEY:      ABSENT
~/.codex/auth.json:            PRESENT (codex ChatGPT-subscription OAuth — the S4 token; cannot call api.responses.write)
dodi/keepur hive.yaml openai:  (no openai section)
keychain generic-passwords matching openai/responses/gpt: none (only "Codex Safe Storage" — the codex CLI's own store)
```

**Conclusion:** no `api.responses.write`-capable credential is reachable. The only OpenAI-adjacent credential is the codex subscription token the spike (§S4) already proved 401s against the Responses API. The live model turn cannot be exercised. Per the plan's verification rules this is a **concrete blocker to report** — recorded here; every non-model leg was still run. Follow-up: T0b's live model turn (and the model-driven halves of legs 1-2 + live connect-cost) remain outstanding until a Responses-capable `OPENAI_API_KEY` (or a codex-token-compatible base URL/backend path) is available; whoever obtains it re-runs `t0b-liveturn.ts` + a tool-forcing turn.

## §T0b.1 — Live-turn attempt against the POST-implementation adapter (credential boundary)

Constructs the real `OpenAIAgentsAdapter` (agent-manager.ts:521-527 shape) with a minimal hand-built assembly (empty inventory — the model authenticates before any tool dispatch, so tools are irrelevant to the credential boundary this leg probes) and runs a turn. `runTurn` never throws on provider errors (openai-agents-adapter.ts:126-134) — the 401 returns as `result.error`.

Script (`t0b-liveturn.ts`):

```ts
import { OpenAIAgentsAdapter } from ".../src/agents/provider-adapters/openai-agents-adapter.js";
const assembly: any = {
  instructions: "You are a terse test agent. Reply with a single word.",
  toolInventory: [], omittedTools: [], guardrailGate: async () => ({ behavior: "allow" }),
  memory: {}, skillIndex: [], inProcessServers: {}, sessionCwd: WT,
};
const adapter = new OpenAIAgentsAdapter({ name: "t0b-openai", model: "gpt-5.4-mini", assembly });
const result = await adapter.runTurn({ prompt: "Say hello in one word." });
console.log(`aborted=${result.aborted} textChars=${result.text.length} error=${result.error ?? "(none)"}`);
```

Observed:

```
OPENAI_API_KEY env present: false
runTurn returned in 765ms
  aborted=false textChars=0
  error=401 You have insufficient permissions for this operation. Missing scopes: api.responses.write. Check that you have the correct role in your organization (Reader, Writer, Owner) and project (Member, Owner), and if you're using a restricted API key, that it has the necessary scopes.
```

**Verdict:** the post-implementation adapter's `runWithAuthFallback` builds the codex-oauth attempt, reaches `api.openai.com` Responses, and fails **only** at the credential scope — byte-for-byte the S4 finding, now reproduced against the delivered code. Wiring is correct up to the credential boundary; the blocker is purely credential. Model-driven legs cannot proceed.

## §T0b.2 — Bridge-direct legs (mandatory scratch-driver path; model-independent)

Constructs `ToolBridge` **exactly as `OpenAIAgentsAdapter.runTurn()` does** (openai-agents-adapter.ts:54-63) — same options, same `AbortController` whose `.abort()` is precisely what `adapter.abort()` invokes (openai-agents-adapter.ts:145) — and drives `bridge.connect()` + `BridgedTool.execute()` directly. This exercises the real §D3 dispatch (gate→execute→contain→meter), §D5 builtin executor, and abort/containment code; only the model's *decision* to call a tool is absent (credential-blocked above). Hand-built inventory = keychain stdio (real `dist/keychain/keychain-mcp-server.js`) + `BUILTIN_TOOL_DEFINITIONS` (Read, Bash); allow-all gate (call-counted).

Script (`t0b-bridge.ts`, abridged to the load-bearing shape):

```ts
const controller = new AbortController();
let gateCalls = 0;
const bridge = new ToolBridge({
  inventory,                       // [keychain stdio (connect-time), builtins (static: Read, Bash)]
  inProcessServers: {},
  gate: async () => { gateCalls++; return { behavior: "allow" }; },
  workItemContext: undefined,
  signal: controller.signal,       // adapter.abort() → controller.abort() (adapter:145)
  agentId: "t0b-spike", sessionCwd: WT, skillIndex: [],
});
const tools = await bridge.connect();                                    // Leg 4: time this
// Leg 1: await tools.find(t=>t.name==="mcp__keychain__secret_list").execute({});
// Leg 2: await tools.find(t=>t.name==="Read").execute({file_path:`${WT}/package.json`, limit:4});
// Leg 3: p = tools.find(t=>t.name==="Bash").execute({command:`sleep 37 && echo ${MARKER}`});
//        sleep 2s → pgrep MARKER (running) → controller.abort() → await p → pgrep MARKER (empty)
```

Note (macOS): the abort command must be **compound** (`sleep 37 && echo MARKER`) — `bash -c "sleep 37 # marker"` exec-replaces bash with `sleep` and strips the comment, so the marker vanishes from all argv and `pgrep -f` can't see it. The compound form keeps bash resident (marker in its argv) with a real `sleep` child in the same process group; the group kill takes both.

Observed:

```
[connect] 101ms; tools=mcp__keychain__secret_get,mcp__keychain__secret_list,Bash,Read
[connect] runtimeOmissions=[]

[LEG1] found bridged tool: mcp__keychain__secret_list
[LEG1] gateCallsSoFar=1 deniedOrFailed=false resultChars=1935 tsvRows=36 (payload ELIDED — Honeypot key names)

[LEG2] found builtin tool: Read
[LEG2] Read(package.json, limit=4) →
     1	{
     2	  "name": "@keepur/hive",
     3	  "version": "0.10.0",
     4	  "hiveApi": "1.0.0",
[106 more lines — use offset/limit to read further]

[LEG3] found builtin tool: Bash
[LEG3] pgrep before start: []
[LEG3] pgrep after ~2s (expect non-empty): ["37122"]
[LEG3] execute resolved 1ms after abort; resultChars=0
[LEG3] pgrep ~1.2s after abort (expect empty): []
[LEG3] engine process healthy: pid=37090 alive, uptime=3.7s

[close] pgrep after bridge.close(): []
[close] orphan keychain-mcp-server pids: []
```

**Per-leg verdicts:**
- **Leg 1 — bridged MCP (keychain stdio) — GREEN.** Gate consulted (`gateCalls=1`, allow), not denied/failed, real tool output round-tripped (1935 chars / 36 TSV rows — payload elided). §D3 dispatch over an external stdio transport confirmed end-to-end.
- **Leg 2 — builtin (Read) — GREEN.** Reply reflects real file content (`package.json` lines 1-4 via the §D5 executor's cat-n render).
- **Leg 3 — abort/containment — GREEN.** Child alive during the turn (`pgrep`→`["37122"]`); `controller.abort()` (≡ `adapter.abort()`) → `execute` resolved in 1ms with empty output, child gone (`pgrep`→`[]`), engine process healthy, no orphan after close. Faithful to the plan's `Bash sleep 30` + `adapter.abort()` clause save for the model's tool-call decision (credential-blocked).
- **Leg 4 — per-turn connect cost — note.** `bridge.connect()` (keychain stdio + builtins) = **101ms**; the live model round-trip to the 401 = 765ms (§T0b.1). Consistent with S1's 393ms/3-server figure — no KPR-122-class churn signal; pooling stays a follow-up only.

## §T0b.3 — Final verification (Step 4.2)

- **`SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.** typecheck (`tsc --noEmit`) clean; eslint `✖ 1244 problems (0 errors, 1244 warnings)` — pre-existing warnings only, non-failing; `prettier --check` clean; vitest **2294 passed | 3 skipped (138 files)**.
- **Behavior-neutrality (merge-base `71c77e5`..HEAD `e7ec72c`):**
  - `gemini-adk-adapter.ts` + `codex-subscription-adapter.ts` + `types.ts` → diff **empty** (0 lines).
  - `agent-manager.ts` → diff **empty** (0 lines).
  - `claude-agent-adapter.ts` → diff **empty** (0 lines).
  - `agent-runner.ts` → modified (233 ins / 201 del: `buildInProcessServers`/`resolveTurnCwd`/`resolveSessionCwd` extractions), but the **`buildHooks` method body is byte-identical** — extracted both revisions' method ranges (MB lines 1461-1500, HEAD lines 1683-1722, 40 lines each) and `diff` reports IDENTICAL. buildHooks only *relocated* (down 222 lines by the extractions above it); zero lines of buildHooks itself touched. Neutrality claim is inspected, not asserted.
