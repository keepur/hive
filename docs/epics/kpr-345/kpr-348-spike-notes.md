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
