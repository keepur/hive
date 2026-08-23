# KPR-382 — Gemini Key Fallback Chain in agent_model_catalog_list Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** `agent_model_catalog_list`'s Gemini leg resolves its API key through the same fallback chain the Gemini provider adapter actually uses (`config.gemini.apiKey` → `GOOGLE_GENAI_API_KEY` → `GEMINI_API_KEY` → `GOOGLE_API_KEY` from `process.env`), so the tool's availability judgment matches real turn behavior, and the missing-key remediation message only fires — and is accurate — when no key in the whole chain is present.

**Architecture:** A single-site change inside the existing `agent_model_catalog_list` handler in `src/admin/admin-mcp-server.ts` (KPR-381, already merged on the epic branch). The key read at the Gemini leg becomes a byte-for-byte mirror of the adapter's chain in `src/agents/provider-adapters/gemini-interactions-adapter.ts:194-198`, reusing the adapter lane's exported `envValue()` helper (trims, empty-string-falsy) rather than reimplementing trimming. The `GEMINI_KEY_MISSING_MSG` constant is reworded to name the full checked chain. Per the ticket's out-of-scope rulings: the adapter itself is untouched, and `config.ts`'s `gemini.apiKey` resolution stays `GEMINI_API_KEY`-only — the fallbacks are read directly from `process.env` at handler-call time, exactly as the adapter reads them.

**Tech Stack:** TypeScript (strict), Node 22+, `@anthropic-ai/claude-agent-sdk` `tool()` handlers, Vitest (`vi.stubEnv` / `vi.stubGlobal` on the existing fake-Db harness).

**Spec:** The KPR-382 Linear ticket description is normative (small corrective child of epic KPR-380; no separate design doc). Filed from the integrated-head epic-PR review (`caught-by: epic-integration/1/opus`), classified judgment. Sibling context: `docs/epics/kpr-380/kpr-381-spec.md` / `kpr-381-plan.md`.

**Baseline:** worktree `/Users/mokie/github/lane-kpr-382-mature`, branch `lane/kpr-382-mature-20260823` @ `7b44dde` (epic branch `kpr-380`, KPR-381 merged). All line references verified against this baseline. Baseline test run: `src/admin/admin-mcp-server.test.ts` → 80 passed.

**Chain-order note (read before implementing):** the ticket's Scope prose says "`GEMINI_API_KEY` → `GOOGLE_GENAI_API_KEY` → `GOOGLE_API_KEY`". The adapter's literal code order is `this.options.apiKey || envValue("GOOGLE_GENAI_API_KEY") || envValue("GEMINI_API_KEY") || envValue("GOOGLE_API_KEY")` — and in production `options.apiKey` **is** `appConfig.gemini.apiKey || undefined` (`src/agents/agent-manager.ts:666,772`), which config.ts resolves from `GEMINI_API_KEY` env-first-then-Keychain at boot. So the adapter's *effective* precedence is exactly the ticket's prose chain, with `GOOGLE_GENAI_API_KEY` ahead of `GOOGLE_API_KEY` among the env-only fallbacks. This plan mirrors the adapter's literal chain (config key first, then the three `envValue` legs in adapter order) — the redundant raw `GEMINI_API_KEY` env leg is kept deliberately so the tool's chain is textually identical to the adapter's and can never diverge in a corner the config singleton doesn't cover. "Mirror the adapter" is the invariant; the prose chain is its observable consequence.

---

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: the `agent_model_catalog_list` handler's Gemini key-resolution branch + the updated `GEMINI_KEY_MISSING_MSG` text, in `src/admin/admin-mcp-server.ts`. Tests live in the existing `describe("admin-mcp-server — agent_model_catalog_list (KPR-381)")` block of `src/admin/admin-mcp-server.test.ts` (they reuse its `beforeEach` reset, `geminiOkResponse` fixture, `seedGrok()` helper, and fetch stubbing).
  - Reason: The ticket's entire deliverable is fallback-chain order + message accuracy — both pure handler logic, fully drivable through the established fake-Db `buildAdminTools` harness with `vi.stubEnv` for the env legs. The observable proof of "which key won" is the `x-goog-api-key` header on the stubbed `fetch`, which the KPR-381 tests already inspect.
  - Minimum assertions:
    - **Fallback works:** config key empty + `GOOGLE_GENAI_API_KEY` set → gemini-only call succeeds (`isError` absent) and `fetch` is called with that key in the `x-goog-api-key` header.
    - **Last-resort fallback works:** config key empty + only `GOOGLE_API_KEY` set → succeeds with that key in the header.
    - **Precedence, config first:** config key set + both env fallbacks set → header carries the config key.
    - **Precedence among env fallbacks:** config key empty + both `GOOGLE_GENAI_API_KEY` and `GOOGLE_API_KEY` set → header carries `GOOGLE_GENAI_API_KEY`'s value (adapter order).
    - **Trim semantics:** config key empty + `GOOGLE_API_KEY` whitespace-only → treated as missing → `isError` (mirrors `envValue`'s trim).
    - **Updated message:** all keys absent → `isError: true`; message names `GOOGLE_GENAI_API_KEY` and `GOOGLE_API_KEY` and still carries the `hive credentials add GEMINI_API_KEY` remediation.
    - **All-4 degradation fixed:** all-4 call (no `provider` arg) with only a fallback key present → gemini entries included, **no** `gemini:` prose note.
    - **Env-leak guard held:** the existing KPR-381 assertions that the key never appears in the URL or error text stay green with fallback-sourced keys (covered by the header/URL assertions in the fallback tests above).

- Integration: `not-required`
  - Scope: n/a
  - Reason: No new module boundary — the change is a 10-line resolution expression plus one imported pure helper (`envValue`, node-builtin-only module, no config import) inside a handler the fake-Db harness already exercises end to end. Same rationale as the KPR-381 contract for this exact file.
  - Harness: `not-applicable`
  - Minimum assertions: n/a

- E2E: `not-required`
  - Scope: n/a
  - Reason: No automated E2E harness exists in this repo; the operator's fleet uses `GEMINI_API_KEY` (Honeypot-curated), so the fallback path has no live production configuration to validate against — the unit-level header assertions are the strongest available evidence that the right key reaches the vendor call.
  - Harness: `not-applicable`
  - Minimum assertions: n/a

### Critical Flows

- Instance configured with `GOOGLE_API_KEY` only (no `GEMINI_API_KEY`): Gemini agent turns already work via the adapter; after this fix, `agent_model_catalog_list({provider:"gemini"})` returns live models instead of hard-erroring with wrong remediation, and the all-4 call includes the gemini leg instead of a misleading prose note.
- Instance with no Gemini key at all: gemini-only call still hard-errors honestly; the message now states the full checked chain and remains actionable (`hive credentials add GEMINI_API_KEY` is still the paved-path remediation).

### Regression Surface

- The 8 existing KPR-381 `agent_model_catalog_list` tests + 6 `agent_model_catalog_refresh` tests, and all other admin-tool tests in `src/admin/admin-mcp-server.test.ts` (80 total at baseline) must stay green. Two are behavior-adjacent: "missing gemini key + provider=gemini → isError with credentials-add remediation" and "all-4 listing with a missing gemini key → partial results + prose note" — both must now run with the env fallbacks deterministically cleared (Step 3's `vi.stubEnv` in `beforeEach`), otherwise an ambient `GOOGLE_API_KEY` on a dev machine would flip them from missing-key to live-lookup and fail them (or worse, hit the real network — the fetch stub is absent in the missing-key tests).
- The adapter (`gemini-interactions-adapter.ts`) and `config.ts` are untouched — verify the diff contains no hunks in either file.
- `docs/providers.md` needs **no** change: footnote 16 already documents the env-only fallbacks as supported adapter behavior; this ticket aligns the tool *to* the documented reality.
- Bundle: `admin-mcp-server.ts` gains an import of `oauth-credentials.ts`, which is already in the `pkg/server.min.js` graph via the adapters — no new externals.

### Commands

- Fast loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/admin/admin-mcp-server.test.ts`
- Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle sanity (pre-PR, optional): `npm run bundle`

### Harness Requirements

- Existing fake-Db harness in `src/admin/admin-mcp-server.test.ts` — no structural changes; the new tests slot into the KPR-381 `agent_model_catalog_list` describe block.
- `vi.stubEnv(...)` for the three env keys, stubbed to `""` in the block's `beforeEach` (deterministic isolation from ambient dev-machine keys) and to real values per test; `vi.unstubAllEnvs()` added to the block's `afterEach`.
- `vi.stubGlobal("fetch", ...)` (existing pattern) for header inspection; `invalidateGeminiModelCache()` already runs in `beforeEach`.
- No live network in any test.

### Non-Required Rationale

- Integration: the fake-Db handler tests are the boundary tests for this file per repo convention (KPR-122 port note at the top of the test file); this change adds no cross-module flow beyond one pure-function import.
- E2E: no harness exists, and no fleet instance is configured with the fallback keys to validate against; the header assertion on the stubbed fetch is the equivalent evidence.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
---

### Task 1: Mirror the adapter's key chain into the Gemini leg + update the message + tests

**Files**
- `/Users/mokie/github/lane-kpr-382-mature/src/admin/admin-mcp-server.ts` (edit — import, message constant, key resolution)
- `/Users/mokie/github/lane-kpr-382-mature/src/admin/admin-mcp-server.test.ts` (edit — env hygiene in the existing describe block, 7 new tests)

- [ ] **Step 1: Add the `envValue` import to `admin-mcp-server.ts`.** In the import block at the top (after the `in-process-servers.js` import, line ~20), add:

  ```ts
  import { envValue } from "../agents/provider-adapters/oauth-credentials.js";
  ```

  (`oauth-credentials.ts` imports node builtins only — no `config.js` — so this is safe in both the runtime graph and the test file's mocked module graph.)

- [ ] **Step 2: Replace the `GEMINI_KEY_MISSING_MSG` constant (line ~199).** Old:

  ```ts
  const GEMINI_KEY_MISSING_MSG =
    "Gemini API key not configured on this instance (GEMINI_API_KEY) — run `hive credentials add GEMINI_API_KEY`, " +
    "then restart the hive service (gemini key resolution happens once at boot; see docs/providers.md).";
  ```

  New:

  ```ts
  const GEMINI_KEY_MISSING_MSG =
    "Gemini API key not configured on this instance — checked GEMINI_API_KEY (env→Keychain) and the adapter's " +
    "env-only fallbacks GOOGLE_GENAI_API_KEY / GOOGLE_API_KEY (KPR-382). Run `hive credentials add GEMINI_API_KEY`, " +
    "then restart the hive service (GEMINI_API_KEY keychain resolution happens once at boot; see docs/providers.md).";
  ```

  (Existing tests match on `/hive credentials add GEMINI_API_KEY/` and `/gemini: Gemini API key not configured/` — both survive this rewording.)

- [ ] **Step 3: Replace the key read in the `agent_model_catalog_list` handler (line ~956).** Old:

  ```ts
            if (wantGemini) {
              const key = appConfig.gemini.apiKey;
  ```

  New:

  ```ts
            if (wantGemini) {
              // KPR-382: byte-for-byte mirror of the adapter's key chain
              // (gemini-interactions-adapter.ts:194-198, where options.apiKey
              // is config.gemini.apiKey per agent-manager.ts) so this tool's
              // availability judgment matches actual turn behavior. The env
              // fallbacks are adapter-local by ruling — read from process.env
              // here, deliberately NOT pushed into config.ts (docs/providers.md
              // fn 16: env-only, never Keychain-resolved). The raw
              // GEMINI_API_KEY leg is redundant behind the config read but
              // kept so the chain is textually identical to the adapter's.
              const key =
                appConfig.gemini.apiKey ||
                envValue("GOOGLE_GENAI_API_KEY") ||
                envValue("GEMINI_API_KEY") ||
                envValue("GOOGLE_API_KEY");
  ```

  Everything downstream (`if (!key) { ... }` hard-error/note split, `fetchGeminiModels(key)`) is unchanged.

- [ ] **Step 4: Make the existing test block env-deterministic.** In `src/admin/admin-mcp-server.test.ts`, inside `describe("admin-mcp-server — agent_model_catalog_list (KPR-381)")`, extend the `beforeEach` (line ~1076) and `afterEach` (line ~1085):

  ```ts
    beforeEach(() => {
      agentDocsStore = new Map();
      agentVersionsStore = [];
      catalogDocsStore = new Map();
      catalogVersionsStore = [];
      invalidateGeminiModelCache();
      mockConfig.gemini.apiKey = "test-gemini-key";
      // KPR-382: the gemini leg now reads the adapter's env fallbacks — clear
      // any ambient dev-machine keys so missing-key tests stay deterministic.
      vi.stubEnv("GOOGLE_GENAI_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      vi.stubEnv("GOOGLE_API_KEY", "");
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
  ```

- [ ] **Step 5: Add the 7 KPR-382 tests** at the end of the same describe block (after the last existing `it`, before the closing `});` of the describe, line ~1290):

  ```ts
    // ------------------------------------------------------------------
    // KPR-382: gemini key fallback chain — mirror of the adapter's
    // resolution (gemini-interactions-adapter.ts:194-198).
    // ------------------------------------------------------------------

    function headerKeyOf(fetchMock: ReturnType<typeof vi.fn>): string {
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
      return init.headers["x-goog-api-key"];
    }

    it("falls back to GOOGLE_GENAI_API_KEY when the config key is empty (KPR-382)", async () => {
      mockConfig.gemini.apiKey = "";
      vi.stubEnv("GOOGLE_GENAI_API_KEY", "genai-fallback-key");
      const fetchMock = vi.fn(async () => geminiOkResponse);
      vi.stubGlobal("fetch", fetchMock);
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      const result = await handler({ provider: "gemini" });
      expect(result.isError).toBeUndefined();
      expect(headerKeyOf(fetchMock)).toBe("genai-fallback-key");
      expect(JSON.parse(result.content[0].text)).toHaveLength(1);
    });

    it("falls back to GOOGLE_API_KEY as the last resort (KPR-382)", async () => {
      mockConfig.gemini.apiKey = "";
      vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
      const fetchMock = vi.fn(async () => geminiOkResponse);
      vi.stubGlobal("fetch", fetchMock);
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      const result = await handler({ provider: "gemini" });
      expect(result.isError).toBeUndefined();
      expect(headerKeyOf(fetchMock)).toBe("google-fallback-key");
    });

    it("config.gemini.apiKey wins over env fallbacks (KPR-382)", async () => {
      vi.stubEnv("GOOGLE_GENAI_API_KEY", "genai-fallback-key");
      vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
      const fetchMock = vi.fn(async () => geminiOkResponse);
      vi.stubGlobal("fetch", fetchMock);
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      await handler({ provider: "gemini" });
      expect(headerKeyOf(fetchMock)).toBe("test-gemini-key");
    });

    it("GOOGLE_GENAI_API_KEY beats GOOGLE_API_KEY — adapter order (KPR-382)", async () => {
      mockConfig.gemini.apiKey = "";
      vi.stubEnv("GOOGLE_GENAI_API_KEY", "genai-fallback-key");
      vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
      const fetchMock = vi.fn(async () => geminiOkResponse);
      vi.stubGlobal("fetch", fetchMock);
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      await handler({ provider: "gemini" });
      expect(headerKeyOf(fetchMock)).toBe("genai-fallback-key");
    });

    it("whitespace-only fallback values are treated as missing (KPR-382)", async () => {
      mockConfig.gemini.apiKey = "";
      vi.stubEnv("GOOGLE_API_KEY", "   ");
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      const result = await handler({ provider: "gemini" });
      expect(result.isError).toBe(true);
    });

    it("missing-key message names the full chain and keeps the credentials-add remediation (KPR-382)", async () => {
      mockConfig.gemini.apiKey = "";
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      const result = await handler({ provider: "gemini" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/GOOGLE_GENAI_API_KEY/);
      expect(result.content[0].text).toMatch(/GOOGLE_API_KEY/);
      expect(result.content[0].text).toMatch(/hive credentials add GEMINI_API_KEY/);
    });

    it("all-4 call with only a fallback key → gemini leg succeeds, no gemini note (KPR-382)", async () => {
      seedGrok();
      mockConfig.gemini.apiKey = "";
      vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => geminiOkResponse),
      );
      const handler = getHandler(makeTools(), "agent_model_catalog_list");
      const result = await handler({});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.some((e: any) => e.provider === "gemini")).toBe(true);
      const noteTexts = result.content.slice(1).map((c: any) => c.text);
      expect(noteTexts.some((n: string) => n.startsWith("gemini:"))).toBe(false);
    });
  ```

- [ ] **Step 6: Verify — targeted tests.** Run:

  ```bash
  cd /Users/mokie/github/lane-kpr-382-mature && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/admin/admin-mcp-server.test.ts
  ```

  Expected output: `Test Files  1 passed (1)` and `Tests  87 passed (87)` (80 baseline + 7 new), zero failures.

- [ ] **Step 7: Negative-verify the regression tests** (repo convention — confirm the new tests fail on pre-fix code). Temporarily revert only the production hunk:

  ```bash
  cd /Users/mokie/github/lane-kpr-382-mature && git stash push -- src/admin/admin-mcp-server.ts && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/admin/admin-mcp-server.test.ts 2>&1 | tail -5; git stash pop
  ```

  Expected: the run under the stash **fails** (the 4 fallback/precedence tests and the two message/all-4 tests error — at minimum `falls back to GOOGLE_GENAI_API_KEY…` and `missing-key message names the full chain…` fail), then `git stash pop` restores the fix. Re-run Step 6's command after the pop and confirm 87 passed again.

- [ ] **Step 8: Verify — full gate.** Run:

  ```bash
  cd /Users/mokie/github/lane-kpr-382-mature && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
  ```

  Expected: typecheck, lint, format, and the full Vitest suite all pass (exit 0). Also confirm scope discipline: `git diff --name-only` lists **only** `src/admin/admin-mcp-server.ts` and `src/admin/admin-mcp-server.test.ts` (plus this plan doc if not yet committed) — no hunks in `gemini-interactions-adapter.ts` or `config.ts`.

- [ ] **Step 9: Commit.**

  ```bash
  cd /Users/mokie/github/lane-kpr-382-mature && git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts && git commit -m "fix(kpr-382): mirror adapter's Gemini key fallback chain in agent_model_catalog_list

  agent_model_catalog_list's gemini leg read only config.gemini.apiKey while
  the adapter also accepts GOOGLE_GENAI_API_KEY/GOOGLE_API_KEY env fallbacks
  (docs/providers.md fn 16). Mirror the adapter's chain via envValue() and
  reword GEMINI_KEY_MISSING_MSG to name the full checked chain.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```
