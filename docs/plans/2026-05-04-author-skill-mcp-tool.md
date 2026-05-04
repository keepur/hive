# author_skill MCP Tool Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Wire a single, always-on MCP tool (`author_skill`) that lets every agent write a `SKILL.md` to its own per-agent skills dir, with code-side slug validation that prevents path traversal.

**Architecture:** New stdio MCP server (`src/skill-author/skill-author-mcp-server.ts`) that owns one tool — `author_skill({ skillName, content })` — validates `skillName` against `/^[a-z0-9][a-z0-9-]*$/` before any path construction, then writes to `<HIVE_HOME>/agents/<AGENT_ID>/skills/<slug>/skills/<slug>/SKILL.md` (KPR-75 nested layout — see Decisions below) via `path.join`. The server is registered in `buildAllServerConfigs` and force-added to every agent's allowlist in `filterCoreServers` (alongside `schedule`/`team`/`team-roster`/`slack`), so it bypasses per-agent `coreServers` declarations. Hot reload of newly-authored skills is already handled by the KPR-75 `agentsDir` watch on the epic branch.

**Tech Stack:** TypeScript strict, `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), `zod` (input schema), `node:fs` (`mkdirSync`, `writeFileSync`), `node:path` (`join`, `resolve`), Vitest for unit tests.

## Loader contract (verified)

> _Populated by Task 1. The contract here informs the doubled-slug nested write path adopted in the Decisions section below: future maintainers reading "why is the slug repeated?" should land on this paragraph first._

## Decisions

- **Base branch: `KPR-74-day1-oob` (Option 2 from spec).** KPR-75's per-agent skills work — `implicitAgentScope`, `agentSkillsDir`, the 4-source pass-ordering invariant in `skill-loader.ts`, the `agentsDir` watch in `index.ts` — lives on this branch only and has not yet merged to `main`. KPR-104 depends on it. The implementation PR targets `KPR-74-day1-oob`, not `main`.
- **MCP server type: stdio subprocess** (not in-process / `createSdkMcpServer`). Rationale: the tool needs the calling agent's id at write time, and the codebase's per-agent-scoped pattern (memory, structured-memory, schedule, admin, keychain) is "stdio + `env: { AGENT_ID: this.agentConfig.id, ... }`" — exactly what AC #9 calls for. The team-roster in-process precedent works because that data has no per-agent slice; for `author_skill` a single shared in-process instance would have to thread `agentId` through every call as an arg, which is messier and inconsistent with the rest of the engine. Stdio matches the AC literally and reuses the existing `mcpPath` / bundle-map plumbing.
- **Always-on injection mechanism: extend `filterCoreServers` to add `"skill-author"` to `coreSet` unconditionally** (same pattern used for `schedule`, `team`, `team-roster`, `slack`). No new "always-on MCP class" abstraction — that would be over-engineering for one more entry; a follow-up can lift the pattern if it grows. The tool is unconditionally available to every agent regardless of `coreServers`/`delegateServers`.
- **Write path: `<HIVE_HOME>/agents/<AGENT_ID>/skills/<slug>/skills/<slug>/SKILL.md`** (slug appears twice). The KPR-75 spec's prose "writes to `agents/<id>/skills/<slug>/SKILL.md`" is shorthand; the loader (`scanWorkflowsFrom` in `src/agents/skill-loader.ts`, verified on `KPR-74-day1-oob`) requires the layout `<root>/<workflow>/skills/<X>/SKILL.md` for every source, including agent-private. The KPR-75 test fixture `writeAgentSkill(...)` confirms: `join(hiveHome, "agents", agentId, "skills", workflow, "skills", skill)`. To satisfy AC #5 (next session spawn picks up the skill via the existing `agentsDir` watch + `loadSkillIndex`), `author_skill` must produce the nested form. We collapse `<workflow>` and `<skill>` to the same slug — one `author_skill` call = one user-facing skill named `<slug>`. No `agents:` frontmatter (path is the source of truth; KPR-75 throws if frontmatter `agents:` is set under agent-private). This decision means the AC #2 spec phrasing is technically incomplete; we follow the loader's actual contract and note the deviation in Spec Ambiguities.

## Testing Contract

### Required Test Groups

- **Unit: required.**
  - **Scope/Reason:** Slug regex enforcement (path-traversal prevention is the load-bearing security claim, AC #6) + path construction + AGENT_ID env handling. Must run with no MongoDB, no SDK, no spawn — pure file-system + zod input parsing.
  - **Min assertions:**
    - Valid slugs (`my-skill`, `a`, `a1`, `a-b-c-1`, `0abc`) accepted, file written at the KPR-75 nested layout `<HIVE_HOME>/agents/<AGENT_ID>/skills/<slug>/skills/<slug>/SKILL.md` (slug doubled — see Decisions), content byte-for-byte equal to input.
    - Invalid slugs rejected with `isError: true` and **no fs write**: `../../../etc/x`, `/etc/passwd`, `foo/bar`, `foo\\bar`, `-leading-hyphen`, `Mixed-Case`, `space slug`, empty string `""`, `with.dot`, a real null-byte vector (`"x\u0000y"`), `..`, `.`, `under_score`, `trailing-`. (At least 13 explicit cases; the null-byte vector uses the actual `\u0000` codepoint per AC #6.)
    - Concurrent writes to the same slug (race two `author_skill` calls with different content): final file contents must equal one of the two inputs (last-writer-wins is OK), file must not be empty/truncated/partially written, frontmatter remains parseable.
    - Missing `AGENT_ID` env: returns `isError: true` with a clear message, writes nothing — assert `existsSync(join(home, "agents"))` is `false`. (AC #8.)
    - Missing `HIVE_HOME` env: returns `isError: true`, writes nothing — invoke with `hiveHome: undefined` so there is no path to write to and no fallback occurs. (Defensive; engine sets it but server must not silently fall back to a wrong path.)
    - Tool description string contains the literal tokens `name:`, `description:`, `## Instructions`, and the regex `/^[a-z0-9][a-z0-9-]*$/` — verifies AC #4 (format reference embedded in description). Note: the description correctly tells agents *not* to include `agents:` in agent-private frontmatter, so the literal `agents:` token appears only inside a "do NOT include" note; we assert on tokens the agent must produce, not on the negative example.
  - **Harness:** Vitest, `mkdtempSync` for temp HIVE_HOME, no network. Pattern: import the server's exported tool handler directly (export it from the server module) and invoke it with controlled env.
- **Integration: required.**
  - **Scope/Reason:** Verifies end-to-end (a) the server is in `buildAllServerConfigs`, (b) `filterCoreServers` retains it for an agent whose `coreServers` does NOT mention it, (c) the env passed to the spawned server contains `AGENT_ID` (AC #9) and `HIVE_HOME`, (d) loading a freshly-authored skill via `loadSkillIndex(..., agentIds=[id])` picks it up (AC #5).
  - **Min assertions:**
    - Building configs for an agent with `coreServers: []` produces a result containing `"skill-author"` after `filterCoreServers` runs.
    - The server config object has `env.AGENT_ID === agentConfig.id` and `env.HIVE_HOME === hiveHome`.
    - After invoking the server's handler to write a skill into `<tmpHome>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md` (KPR-75 nested layout), calling `loadSkillIndex(<tmpHome>/skills, [], [], [id], <tmpHome>)` returns an index where `getSkillsForAgent(idx, id)` includes a plugin config whose `path` equals `<tmpHome>/agents/<id>/skills/<slug>` (the workflow dir is the outer slug).
  - **Harness:** Vitest with a `tmpdir()` HIVE_HOME, no Mongo, no SDK spawn — wire the server's exported handler in-process; do not actually fork a subprocess.
- **E2E: not-required.**
  - **Rationale:** No new channel, no new external integration. The end-to-end "agent calls tool, file lands, next session sees it" path is fully exercised by the integration test against the real `skill-loader.ts`. Covering it again with a real Claude session would burn API credit for no incremental signal.

### Critical Flows

- Agent invokes `author_skill({ skillName, content })` → slug regex check → `path.join(hiveHome, "agents", agentId, "skills", slug, "skills", slug, "SKILL.md")` (KPR-75 nested layout) → `mkdirSync(..., { recursive: true })` → `writeFileSync(path, content, "utf-8")` → return success text containing the absolute path written.
- Adversarial slug → `isError: true` returned, zero filesystem mutations, error string names the offending input and the regex constraint.
- Hot reload: file appears under `<HIVE_HOME>/agents/<id>/skills/`, the existing KPR-75 `watch(agentsRoot, { recursive: true }, ...)` debounce in `src/index.ts` fires, `loadSkillIndex` runs, next session-spawn `getSkillsForAgent(id)` returns it.

### Regression Surface

- `filterCoreServers` — new unconditional `coreSet.add("skill-author")` must not break any existing agent's allowlist (existing tests should pass unchanged; if any existing test asserts "agent X has exactly these N servers", count expectations must be bumped by 1 — search and update).
- `buildAllServerConfigs` shape — adds one new key. Snapshot/Object.keys tests, if any, need updating.
- Bundle: `build/bundle.ts` `entryPoints` map gets a new entry; `MCP_BUNDLE_MAP` in `agent-runner.ts` gets a parallel entry. `npm run check:bundle` (which runs `check-bundle-pack.mjs` etc.) must pass.

### Commands

```bash
# Unit + integration
npx vitest run src/skill-author/skill-author-mcp-server.test.ts
npx vitest run src/agents/agent-runner.skill-author.test.ts

# Whole suite
npm run typecheck
npm run lint
npm run format
npm run test
npm run check                # all of the above
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check  # if env stub trips

# Bundle gate
npm run check:bundle
```

### Harness Requirements

- Node 22+, Vitest, `@modelcontextprotocol/sdk`, `zod` — all already in deps.
- No MongoDB, no Slack, no Anthropic API needed for this ticket's tests.

### Non-Required Rationale

- E2E skipped: integration test against the real `skill-loader.ts` covers the load-bearing claim ("next session picks it up"). A real Claude SDK round-trip would not surface any failure mode the unit + integration tests miss.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

### Task 1: Verify loader layout contract

**Files:**
- Read-only: `src/agents/skill-loader.ts` (on `KPR-74-day1-oob`).
- Modify: `docs/plans/2026-05-04-author-skill-mcp-tool.md` (this file — populate the "Loader contract (verified)" section near the top).

This task is read-only on the engine code and produces a documented finding. It runs ahead of the worktree setup so the contract is pinned in writing before any code is written. Future maintainers reading "why does `author_skill` write to `<root>/<slug>/skills/<slug>/SKILL.md` instead of the AC #2 shorthand?" should land here first.

- [ ] **Step 1:** Read `src/agents/skill-loader.ts` on the `KPR-74-day1-oob` branch tip — specifically the `scanWorkflowsFrom` function and the per-agent pass that calls it. Confirm three claims:

  1. The outer loop in `scanWorkflowsFrom` iterates over entries of `rootDir`, treating each subdirectory as a workflow dir.
  2. For each workflow, it looks for an inner `skills/` directory and only descends into `<workflowPath>/skills/<skillDir>/SKILL.md`. The branch `if (!existsSync(skillsSubdir)) continue` silently skips workflow dirs without an inner `skills/` — i.e. a flat layout `<root>/<slug>/SKILL.md` (no inner `skills/`) is **not** loaded.
  3. The per-agent pass invokes `scanWorkflowsFrom(agentSkillsDir(agentId), ..., implicitAgentScope: agentId)` — confirming agent-private uses the same nested-workflow contract as customer/plugin/baseline sources, with the agent id stamped on every loaded skill.

  Use the engine's branch checkout (or `git show origin/KPR-74-day1-oob:src/agents/skill-loader.ts`) to read the file directly — do not rely on `main`'s copy, which predates KPR-75.

- [ ] **Step 2:** Populate the "Loader contract (verified)" section near the top of this plan with a paragraph like:

  > Verified against `src/agents/skill-loader.ts` on `KPR-74-day1-oob`: `scanWorkflowsFrom` iterates `rootDir` for workflow dirs, then descends only into `<workflow>/skills/<skill>/SKILL.md`. A flat layout `<root>/<slug>/SKILL.md` (no inner `skills/`) is silently skipped via the `if (!existsSync(skillsSubdir)) continue` branch. The per-agent pass calls `scanWorkflowsFrom(agentSkillsDir(agentId), ..., implicitAgentScope: agentId)`, so agent-private skills follow the same nested-workflow contract as the other three sources. Conclusion: `author_skill` must write to `<HIVE_HOME>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md` (workflow dir and skill dir share the slug). The doubled slug is not a quirk; it is the loader's literal contract for every skill source.

  Replace the placeholder block under that heading with the verified paragraph (keep the heading; drop the `_Populated by Task 1..._` placeholder).

- [ ] **Step 3:** Spot-test the layout assumption end-to-end. Inside the worktree (or a scratch checkout of `KPR-74-day1-oob` if the worktree is not yet created — Task 2 below sets up the worktree, so this step may be deferred to immediately after Task 2 Step 2 if needed):

  1. Pick a temporary `<hiveHome>` (e.g. `mkdtempSync` directory or a scratch dir under `/tmp`).
  2. Write a SKILL.md at `<hiveHome>/agents/test-agent/skills/test-skill/skills/test-skill/SKILL.md` with minimal valid frontmatter:

     ```
     ---
     name: test-skill
     description: layout verification for KPR-104
     ---
     body
     ```

  3. Drive the existing skill-loader (via the test harness in `src/agents/skill-loader.test.ts` patterns, or a one-shot Vitest run that calls `loadSkillIndex(<hiveHome>/skills, [], [], ["test-agent"], <hiveHome>)` and `getSkillsForAgent(idx, "test-agent")`) and confirm the skill is picked up.
  4. Also confirm the **negative**: a flat `<hiveHome>/agents/test-agent/skills/test-skill/SKILL.md` (no inner `skills/test-skill/` dir) is NOT loaded — the loader's `existsSync(skillsSubdir)` guard skips it.
  5. Remove the test skill (`rmSync(<hiveHome>, { recursive: true, force: true })` or delete just the temp dir).

  Record the result inline in the "Loader contract (verified)" paragraph (e.g. append "Spot-checked end-to-end: nested layout loads, flat layout does not.").

- [ ] **Step 4:** Commit.

  ```bash
  git add docs/plans/2026-05-04-author-skill-mcp-tool.md
  git commit -m "$(cat <<'EOF'
  docs(KPR-104): verified loader layout contract for per-agent skills

  Confirmed scanWorkflowsFrom requires <workflow>/skills/<skill>/SKILL.md
  layout. Documented in implementation plan; informs author_skill write path.
  EOF
  )"
  ```

  Note: this commit may land on the worktree branch created in Task 2, or directly on a scratch branch if you do Task 1 before Task 2. Either is fine — the documentation change is isolated and non-conflicting.

---

### Task 2: Worktree setup off `KPR-74-day1-oob`

**Files:** none — git plumbing only.

- [ ] **Step 1:** From `/Users/mokie/github/hive`, fetch and check the epic exists:

  ```bash
  cd /Users/mokie/github/hive
  git fetch origin KPR-74-day1-oob
  git rev-parse origin/KPR-74-day1-oob
  ```

- [ ] **Step 2:** Create a worktree + child branch off the epic:

  ```bash
  git worktree add -b KPR-104-author-skill-mcp-tool ../hive-KPR-104 origin/KPR-74-day1-oob
  cd ../hive-KPR-104
  git status
  git log --oneline -1   # confirm tip is the KPR-74-day1-oob HEAD, not main
  npm install
  ```

- [ ] **Step 3:** Sanity-check baseline:

  ```bash
  npm run typecheck
  npm run test -- --run --reporter=dot
  ```

  All work in subsequent tasks happens inside `../hive-KPR-104`. PR target at submit time: `KPR-74-day1-oob`.

- [ ] **Step 4:** No commit — this task is pure setup.

---

### Task 3: Implement the `skill-author` stdio MCP server

**Files:**
- Create: `src/skill-author/skill-author-mcp-server.ts`
- Create: `src/skill-author/skill-author-mcp-server.test.ts`
- Modify: none (wiring lands in Task 4).

- [ ] **Step 1:** Create the server. Drop in this complete file:

  ```ts
  // src/skill-author/skill-author-mcp-server.ts
  #!/usr/bin/env node

  /**
   * Skill-Author MCP Server (KPR-104).
   *
   * Exposes a single tool — `author_skill` — that writes a SKILL.md to the
   * calling agent's per-agent skills directory:
   *
   *   <HIVE_HOME>/agents/<AGENT_ID>/skills/<slug>/skills/<slug>/SKILL.md
   *
   * The doubled <slug> is intentional: KPR-75's loader (scanWorkflowsFrom in
   * src/agents/skill-loader.ts) treats every skill source as
   * <root>/<workflow>/skills/<X>/SKILL.md, and agent-private is no exception.
   * One author_skill call = one user-facing skill, so we name the workflow
   * and the skill identically.
   *
   * Per-agent skills directory is the 4th skill source introduced by KPR-75
   * (`src/agents/skill-loader.ts`, `src/paths.ts:agentSkillsDir`). The
   * `agentsDir` watcher in `src/index.ts` picks up new SKILL.md files on the
   * next session spawn — no extra hot-reload wiring needed here.
   *
   * Always-on: this server is added to every agent's allowlist in
   * `agent-runner.ts:filterCoreServers` regardless of declared coreServers.
   * No permission flag; no opt-in/opt-out. See KPR-104 spec.
   *
   * Slug validation is code-correctness, not gating: the regex
   * `/^[a-z0-9][a-z0-9-]*$/` rejects every path-traversal vector
   * (../, /, \, .., ., null bytes, dots, slashes) by construction, so
   * `path.join` only ever sees a validated leaf segment.
   *
   * Env vars (set by agent-runner.ts):
   *   AGENT_ID  — the calling agent's id
   *   HIVE_HOME — instance home (resolved by src/paths.ts)
   */

  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { z } from "zod";
  import { mkdirSync, writeFileSync } from "node:fs";
  import { join, resolve } from "node:path";

  /** Slug regex — lowercase alphanumeric + hyphens, no leading hyphen, non-empty. */
  export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

  /**
   * Tool description. Embedded SKILL.md format reference (AC #4) — agents read
   * tool descriptions natively (KPR-87 toolkit visibility).
   */
  export const AUTHOR_SKILL_DESCRIPTION = [
    "Author a private skill that becomes part of your toolkit on the next session.",
    "",
    "Writes a SKILL.md under your per-agent skills tree at",
    "<HIVE_HOME>/agents/<your-agent-id>/skills/<skillName>/skills/<skillName>/SKILL.md.",
    "(The nested layout is the engine's loader contract; you don't have to think",
    "about it — you pick the skillName and your skill is named that.)",
    "",
    "skillName must match /^[a-z0-9][a-z0-9-]*$/ — lowercase alphanumeric plus",
    "hyphens, must start with a letter or digit. (This is a code constraint, not",
    "a permission gate: it keeps the path safe to construct.)",
    "",
    "content is the full SKILL.md body — frontmatter + markdown. Pass it as-is;",
    "the loader handles malformed frontmatter on next session spawn.",
    "",
    "SKILL.md format:",
    "",
    "    ---",
    "    name: my-skill",
    "    description: One-line summary the model uses to decide when to invoke.",
    "    ---",
    "",
    "    ## When to use",
    "",
    "    Bullet the trigger conditions.",
    "",
    "    ## Instructions",
    "",
    "    Step-by-step. Reference any helper scripts or templates you also dropped",
    "    into this skill's directory.",
    "",
    "Notes:",
    "  - Do NOT include `agents:` in frontmatter. The path is the source of truth",
    "    for agent-private skills; declaring `agents:` is rejected by the loader.",
    "  - Last-writer-wins on identical skillName.",
    "  - The skill loads on the next session spawn (the engine watches your",
    "    agents/ tree).",
  ].join("\n");

  /**
   * Pure handler — exported for unit tests. Returns the SDK content+isError
   * shape. No process.env reads; caller injects agentId and hiveHome.
   */
  export function authorSkill(
    args: { skillName: string; content: string },
    deps: { agentId: string | undefined; hiveHome: string | undefined },
  ): { content: { type: "text"; text: string }[]; isError?: true } {
    if (!deps.agentId || deps.agentId.trim() === "") {
      return {
        content: [{ type: "text", text: "AGENT_ID env not set — refusing to write (would land in the wrong agent's skills/)." }],
        isError: true,
      };
    }
    if (!deps.hiveHome || deps.hiveHome.trim() === "") {
      return {
        content: [{ type: "text", text: "HIVE_HOME env not set — refusing to write." }],
        isError: true,
      };
    }
    if (!SLUG_RE.test(args.skillName)) {
      return {
        content: [
          {
            type: "text",
            text:
              `skillName=${JSON.stringify(args.skillName)} does not match /^[a-z0-9][a-z0-9-]*$/. ` +
              "Use lowercase alphanumeric plus hyphens, no leading hyphen, no slashes, no dots.",
          },
        ],
        isError: true,
      };
    }

    // Slug is regex-validated — every path component is a known-safe leaf.
    // Layout: <home>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md per
    // KPR-75 loader contract. Workflow dir and skill dir share the slug.
    const skillDir = join(
      resolve(deps.hiveHome),
      "agents",
      deps.agentId,
      "skills",
      args.skillName,
      "skills",
      args.skillName,
    );
    const skillMd = join(skillDir, "SKILL.md");

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillMd, args.content, { encoding: "utf-8" });
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to write ${skillMd}: ${String(err)}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Wrote ${skillMd}. The skill becomes available on your next session spawn ` +
            "(the engine's agents/ watcher refreshes the skill index automatically).",
        },
      ],
    };
  }

  // --- Server entry ---

  const server = new McpServer({
    name: "hive-skill-author",
    version: "0.1.0",
  });

  server.registerTool(
    "author_skill",
    {
      title: "Author a private skill",
      description: AUTHOR_SKILL_DESCRIPTION,
      inputSchema: {
        skillName: z
          .string()
          .describe("Slug for the skill directory. Must match /^[a-z0-9][a-z0-9-]*$/."),
        content: z
          .string()
          .describe("Full SKILL.md content — frontmatter (name + description) plus markdown body."),
      },
    },
    async ({ skillName, content }) => {
      return authorSkill(
        { skillName, content },
        { agentId: process.env.AGENT_ID, hiveHome: process.env.HIVE_HOME },
      );
    },
  );

  // Only connect transport when invoked as a process — the test imports the
  // module to call `authorSkill` directly without spawning stdio.
  if (process.env.NODE_ENV !== "test" && !process.env.HIVE_SKILL_AUTHOR_NO_TRANSPORT) {
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("skill-author MCP server failed to start:", err);
      process.exit(1);
    });
  }
  ```

- [ ] **Step 2:** Create the unit test:

  ```ts
  // src/skill-author/skill-author-mcp-server.test.ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { authorSkill, AUTHOR_SKILL_DESCRIPTION, SLUG_RE } from "./skill-author-mcp-server.js";

  describe("author_skill: slug regex", () => {
    const accept = ["my-skill", "a", "a1", "a-b-c-1", "0abc", "skill-author"];
    const reject = [
      "../../../etc/x",
      "/etc/passwd",
      "foo/bar",
      "foo\\bar",
      "-leading-hyphen",
      "Mixed-Case",
      "space slug",
      "",
      "with.dot",
      "x\u0000y", // real null byte (AC #6)
      "..",
      ".",
      "under_score",
      "trailing-",
    ];

    for (const s of accept) {
      it(`accepts ${JSON.stringify(s)}`, () => {
        expect(SLUG_RE.test(s)).toBe(true);
      });
    }
    for (const s of reject) {
      it(`rejects ${JSON.stringify(s)}`, () => {
        expect(SLUG_RE.test(s)).toBe(false);
      });
    }
  });

  describe("authorSkill handler", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "hive-skill-author-"));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it("writes SKILL.md at the per-agent nested path on a valid slug", () => {
      const r = authorSkill(
        { skillName: "my-skill", content: "---\nname: my-skill\ndescription: t\n---\nbody\n" },
        { agentId: "river", hiveHome: home },
      );
      expect(r.isError).toBeUndefined();
      // KPR-75 nested layout: <home>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md
      const path = join(home, "agents", "river", "skills", "my-skill", "skills", "my-skill", "SKILL.md");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("---\nname: my-skill\ndescription: t\n---\nbody\n");
    });

    it("returns isError and writes nothing on missing AGENT_ID", () => {
      const r = authorSkill(
        { skillName: "ok", content: "x" },
        { agentId: undefined, hiveHome: home },
      );
      expect(r.isError).toBe(true);
      expect(existsSync(join(home, "agents"))).toBe(false);
    });

    it("returns isError and writes nothing on missing HIVE_HOME", () => {
      const r = authorSkill(
        { skillName: "ok", content: "x" },
        { agentId: "river", hiveHome: undefined },
      );
      expect(r.isError).toBe(true);
    });

    it.each([
      "../../../etc/passwd",
      "/etc/passwd",
      "foo/bar",
      "foo\\bar",
      "-leading",
      "Mixed",
      "space slug",
      "",
      "with.dot",
      "x\u0000y", // real null byte (AC #6)
      "..",
      ".",
      "under_score",
    ])("rejects adversarial slug %j with isError and no fs writes", (bad) => {
      const r = authorSkill(
        { skillName: bad, content: "x" },
        { agentId: "river", hiveHome: home },
      );
      expect(r.isError).toBe(true);
      // Ensure no agent directory was created at all
      const agentsDir = join(home, "agents");
      if (existsSync(agentsDir)) {
        // If it exists (it shouldn't), the slug dir certainly must not.
        const entries = readdirSync(agentsDir);
        expect(entries).not.toContain("..");
      }
    });

    it("concurrent writes to the same slug end with a valid file (last-writer-wins)", async () => {
      const a = authorSkill(
        { skillName: "race", content: "A".repeat(2048) + "\n" },
        { agentId: "river", hiveHome: home },
      );
      const b = authorSkill(
        { skillName: "race", content: "B".repeat(2048) + "\n" },
        { agentId: "river", hiveHome: home },
      );
      // Both calls return synchronously. Sequence them via Promise.all to mirror
      // the spec's "concurrent same-slug" requirement — the underlying
      // writeFileSync is atomic on POSIX for a single open/write/close, so the
      // file ends with one of the two contents in full.
      await Promise.all([a, b]);
      const path = join(home, "agents", "river", "skills", "race", "skills", "race", "SKILL.md");
      expect(existsSync(path)).toBe(true);
      const got = readFileSync(path, "utf-8");
      expect(got === "A".repeat(2048) + "\n" || got === "B".repeat(2048) + "\n").toBe(true);
    });

    it("description embeds the SKILL.md format reference (AC #4)", () => {
      expect(AUTHOR_SKILL_DESCRIPTION).toContain("name:");
      expect(AUTHOR_SKILL_DESCRIPTION).toContain("description:");
      expect(AUTHOR_SKILL_DESCRIPTION).toContain("## Instructions");
      expect(AUTHOR_SKILL_DESCRIPTION).toContain("/^[a-z0-9][a-z0-9-]*$/");
    });
  });
  ```

- [ ] **Step 3:** Verify locally:

  ```bash
  npx vitest run src/skill-author/skill-author-mcp-server.test.ts
  npm run typecheck
  ```

- [ ] **Step 4:** Commit.

  ```bash
  git add src/skill-author/skill-author-mcp-server.ts src/skill-author/skill-author-mcp-server.test.ts
  git commit -m "KPR-104: skill-author MCP server with slug-validated author_skill tool"
  ```

---

### Task 4: Wire `skill-author` into `agent-runner.ts` (always-on)

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Create: `src/agents/agent-runner.skill-author.test.ts`

- [ ] **Step 1:** Add the bundle entry in `MCP_BUNDLE_MAP` in `src/agents/agent-runner.ts` (the `const MCP_BUNDLE_MAP: Record<string, string>` block). Insert one new line, e.g. after the `slack` entry:

  ```ts
  "skill-author/skill-author-mcp-server.js": "skill-author.min.js",
  ```

- [ ] **Step 2:** Register the server in `buildAllServerConfigs(context?)` in the same file. Add this block immediately after the `servers["schedule"] = { ... };` block (so the unconditional always-on servers are clustered together):

  ```ts
  // Skill-author MCP — always-on (KPR-104). Lets every agent author a private
  // SKILL.md under <HIVE_HOME>/agents/<id>/skills/<slug>/. Slug regex is
  // enforced inside the server so we never path.join unvalidated input.
  servers["skill-author"] = {
    type: "stdio",
    command: "node",
    args: [mcpPath("skill-author/skill-author-mcp-server.js")],
    env: {
      AGENT_ID: this.agentConfig.id,
      HIVE_HOME: hiveHome,
    },
  };
  ```

  Note: `hiveHome` is already imported from `../paths.js` at the top of the file (used elsewhere in agent-runner). If the build complains about an unused import, double-check the existing import — it's there in the epic-branch source.

- [ ] **Step 3:** Add `"skill-author"` to the always-on set inside `filterCoreServers`. Find the cluster:

  ```ts
  // schedule is an implicit core server — available to all agents unconditionally
  coreSet.add("schedule");
  // team is an implicit core server — available to all agents unconditionally
  coreSet.add("team");
  // team-roster is an implicit core server — every agent gets the team API
  coreSet.add("team-roster");
  ```

  And add directly below:

  ```ts
  // skill-author is an implicit core server — every agent can author its own
  // skills unconditionally (KPR-104). No permission flag; empowerment posture.
  coreSet.add("skill-author");
  ```

- [ ] **Step 4:** Create the integration test `src/agents/agent-runner.skill-author.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { loadSkillIndex, getSkillsForAgent } from "./skill-loader.js";
  import { authorSkill } from "../skill-author/skill-author-mcp-server.js";

  /**
   * KPR-104 integration: a skill written via the author_skill handler is
   * picked up by skill-loader.loadSkillIndex on the next call (mirrors what
   * happens on next session spawn in production).
   */
  describe("author_skill → skill-loader integration", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "hive-author-skill-int-"));
      // Customer skills dir is allowed to be missing — loader handles that —
      // but create it so detectModifiedSkills has a stable parent.
      mkdirSync(join(home, "skills"), { recursive: true });
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it("authored skill loads under the calling agent's id on next loadSkillIndex", () => {
      const id = "river";
      const skillName = "drip-campaign";
      const content = [
        "---",
        `name: ${skillName}`,
        "description: write a 5-step drip",
        "---",
        "",
        "## Instructions",
        "Write the drip.",
        "",
      ].join("\n");

      const r = authorSkill(
        { skillName, content },
        { agentId: id, hiveHome: home },
      );
      expect(r.isError).toBeUndefined();

      // Confirm the nested KPR-75 layout was written: <home>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md
      const written = join(home, "agents", id, "skills", skillName, "skills", skillName, "SKILL.md");
      expect(existsSync(written)).toBe(true);

      // Now have the loader pick it up exactly the way the engine will on next session spawn.
      const idx = loadSkillIndex(
        join(home, "skills"),
        [],
        [],
        [id],
        home,
      );
      const forAgent = getSkillsForAgent(idx, id);
      // The plugin path is the workflow dir (the outer <slug>), per scanWorkflowsFrom.
      const expectedWorkflowPath = join(home, "agents", id, "skills", skillName);
      expect(forAgent.some((p) => p.path === expectedWorkflowPath)).toBe(true);
    });
  });
  ```

- [ ] **Step 5:** A `filterCoreServers` smoke test that does not require a real `AgentManager`. Append to the same test file:

  ```ts
  describe("filterCoreServers always-on injection", () => {
    it("retains skill-author for an agent whose coreServers does not list it", async () => {
      // Import via dynamic require so we don't pull in the full agent-runner
      // module init at file load. We exercise just the static behavior of
      // filterCoreServers by constructing a minimal AgentRunner-shaped instance.
      const { AgentRunner } = await import("./agent-runner.js");

      // Build a minimal-but-valid AgentConfig. Field set must match what
      // filterCoreServers reads: coreServers (string[]), autonomy.{externalComms,
      // codeTask, codeAccess}.
      const agentConfig: any = {
        id: "river",
        coreServers: [], // empty allowlist — only implicit servers should survive
        delegateServers: [],
        autonomy: { externalComms: false, codeTask: false, codeAccess: false },
      };
      const runner = Object.create(AgentRunner.prototype);
      runner.agentConfig = agentConfig;

      const servers = {
        "skill-author": { type: "stdio" } as any,
        "schedule": { type: "stdio" } as any,
        "team": { type: "stdio" } as any,
        "team-roster": { type: "sdk" } as any,
        "memory": { type: "stdio" } as any, // not in coreServers, not implicit → should drop
      };
      const filtered = (runner as any).filterCoreServers(servers);
      expect(filtered["skill-author"]).toBeDefined();
      expect(filtered["memory"]).toBeUndefined();
    });
  });
  ```

  > **Plan note:** if `filterCoreServers` is not visible without going through a real constructor, fall back to a runtime check: spin a real `AgentRunner` with stub deps, call `(runner as any).filterCoreServers(servers)`, and assert the same. Either path is acceptable so long as the assertion is real.

- [ ] **Step 6:** Verify:

  ```bash
  npx vitest run src/agents/agent-runner.skill-author.test.ts
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 7:** Commit.

  ```bash
  git add src/agents/agent-runner.ts src/agents/agent-runner.skill-author.test.ts
  git commit -m "KPR-104: register skill-author MCP, force-include via filterCoreServers"
  ```

---

### Task 5: Wire `skill-author` into the bundle

**Files:**
- Modify: `build/bundle.ts`

- [ ] **Step 1:** Add an entry to the MCP `entryPoints` map. Open `build/bundle.ts`, find the `entryPoints: { ... }` block under the comment `// MCP servers — each is a separate entry point (spawned as subprocess)`, and add:

  ```ts
  "mcp/skill-author": "dist/skill-author/skill-author-mcp-server.js",
  ```

  (Add it next to the other simple entries — alphabetical or grouped near keychain/admin.)

- [ ] **Step 2:** Verify both tsc and bundle:

  ```bash
  npm run build
  ls dist/skill-author/skill-author-mcp-server.js   # confirm tsc emitted
  npm run bundle
  ls pkg/mcp/skill-author.min.js                    # confirm bundle emitted
  npm run check:bundle
  ```

  If `check-bundle-pack.mjs` or `check-bundle-runtime.mjs` rejects the new file, fix the cause (most likely a missing string match in the bundle-strings allowlist, or a runtime smoke-spawn that needs `HIVE_SKILL_AUTHOR_NO_TRANSPORT=1` in env to avoid hanging on stdio).

- [ ] **Step 3:** Commit.

  ```bash
  git add build/bundle.ts
  git commit -m "KPR-104: bundle skill-author MCP into pkg/mcp/skill-author.min.js"
  ```

---

### Task 6: Full quality gate + update existing fixtures if needed

**Files:** anything `npm run check` complains about (count-of-servers fixtures, snapshot updates).

- [ ] **Step 1:** Run the full gate:

  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
  ```

- [ ] **Step 2:** If any pre-existing test asserts a specific number of MCP servers or a snapshot of `Object.keys(buildAllServerConfigs(...))`, bump expectations by one and add `"skill-author"` to enumerated fixtures. **Do not silence assertions** — confirm each delta is the one new key, not regression.

- [ ] **Step 3:** If anything in the agent-runner system-prompt-rendering tests includes the always-on servers in "Your tools" output, verify whether `skill-author` should appear there or be added to `INFRASTRUCTURE_SERVERS` (the set excluded from the visible toolkit listing). The spec is silent. Default: **leave it visible** — agents must know the tool exists for them to use it (KPR-87 toolkit visibility is the empowerment path), and the description carries the format reference. If a test fails because of an "unexpected tool surfaced", add it to the visible set explicitly.

- [ ] **Step 4:** If updates were needed, commit them in a single follow-up:

  ```bash
  git add -A
  git status
  git commit -m "KPR-104: update fixtures and visible-tools list for skill-author"
  ```

  (Only commit if there are real updates — skip the commit if `npm run check` is green already.)

---

### Task 7: Open the PR against the epic branch

**Files:** none.

- [ ] **Step 1:** Push the branch:

  ```bash
  git push -u origin KPR-104-author-skill-mcp-tool
  ```

- [ ] **Step 2:** Open PR with `--base KPR-74-day1-oob` (NOT `main`):

  ```bash
  gh pr create --base KPR-74-day1-oob --title "KPR-104: author_skill MCP tool (always-on)" --body "$(cat <<'EOF'
  ## Summary

  - New stdio MCP server `skill-author` exposing one tool, `author_skill({ skillName, content })`, that writes a SKILL.md under the calling agent's per-agent skills tree (KPR-75 nested layout: `<HIVE_HOME>/agents/<AGENT_ID>/skills/<slug>/skills/<slug>/SKILL.md`).
  - Slug must match `/^[a-z0-9][a-z0-9-]*$/` — code-correctness, validated before any path construction. Adversarial inputs (`../`, `/`, `\`, `..`, `.`, ` `, dots, slashes, empty, mixed case, underscores) are rejected by construction.
  - Always-on: `filterCoreServers` adds `skill-author` to every agent's allowlist alongside `schedule`/`team`/`team-roster`/`slack`. No permission flag.
  - Tool description embeds the SKILL.md format reference (KPR-87 toolkit visibility carries it to agents natively).
  - `AGENT_ID` + `HIVE_HOME` propagated via spawn env.
  - Hot reload: free — picked up by the existing KPR-75 `agentsDir` watch.

  ## Base branch

  Targets `KPR-74-day1-oob`, not `main`. KPR-75's per-agent skills wiring (the 4th source in `skill-loader.ts`, `agentSkillsDir`, the `agentsDir` watcher) lives only on the epic branch today; KPR-104 depends on it.

  ## Test plan

  - [ ] `npx vitest run src/skill-author/skill-author-mcp-server.test.ts`
  - [ ] `npx vitest run src/agents/agent-runner.skill-author.test.ts`
  - [ ] `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  - [ ] `npm run check:bundle`
  - [ ] Manual smoke on a dev instance: have an agent call `author_skill`, SIGUSR1 to reload, confirm new skill is in toolkit on next session.

  ## Out of scope

  - Constitution Section 2 prose update on live instances (operator-side follow-up via tune-instance).
  - Frame anchor `hive-baseline/constitution/capabilities.md` update (different repo, per KPR-162).
  - Skill versioning, cross-agent sharing UX, permission gating.
  EOF
  )"
  ```

- [ ] **Step 3:** Return PR URL.

---

## Spec Ambiguities

- **AC #2 path is shorthand vs. KPR-75 loader layout.** Spec acceptance criterion #2 says: "Tool writes to `<hiveHome>/agents/<callingAgentId>/skills/<slug>/SKILL.md`". But `skill-loader.ts` on `KPR-74-day1-oob` (`scanWorkflowsFrom`) requires `<root>/<workflow>/skills/<X>/SKILL.md` for every source — agent-private included. The KPR-75 test fixture confirms: `writeAgentSkill(...)` builds `join(hiveHome, "agents", agentId, "skills", workflow, "skills", skill)`. **Resolution adopted in this plan:** write to `<hiveHome>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md` (workflow dir and skill dir share the slug name). This matches AC #5 (next session pickup via the existing `agentsDir` watch + `loadSkillIndex`) literally, and the AC #2 path becomes the user-visible "skill named `<slug>`". Caller should not perceive a difference; the description text is forthright about the nested layout. If a maintainer later prefers a flat-skill mode in the loader, that's a follow-up that simplifies `author_skill`'s write path back to the AC #2 shorthand — but it is not in scope here.
