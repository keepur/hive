# Linear → GitHub Issues Migration

**Date**: 2026-03-14
**Status**: Draft
**Scope**: Replace Linear with GitHub Issues for all project management in Hive

## Context

We use Linear for issue tracking but have very little in it — no process, no sprints, no projects. The team is myself, one dev, QA, and agents (including a PM agent). Moving to GitHub Issues eliminates a tool, reduces context-switching, and simplifies agent tooling (`gh` CLI vs Linear API).

## Goals

1. Build a GitHub Issues MCP server for agents
2. Update agent templates to use GitHub Issues instead of Linear
3. Set up basic labels on the `hive` repo
4. Migrate existing Linear issues to GitHub Issues
5. Verify everything works end-to-end
6. Remove Linear MCP server, client, and all references

## Non-Goals

- Process design (sprints, milestones, project boards, automation)
- Issue templates
- Workflow beyond basic label taxonomy

---

## 1. GitHub Issues MCP Server

**File**: `src/github/github-issues-mcp-server.ts`

New MCP server, same stdio pattern as existing servers. Wraps `gh` CLI via `execFileSync`.

**Env vars**:
- `GITHUB_REPO` — `owner/repo` (required, e.g. `dodihome/hive`)
- `GH_TOKEN` — GitHub token (optional if `gh` is already authed, but explicit is safer for agent subprocesses)

### Tools

| Tool | Description | `gh` command |
|------|-------------|--------------|
| `github_list_issues` | List issues with filters (state, labels, assignee, limit) | `gh issue list` |
| `github_get_issue` | Get full issue details by number | `gh issue view` |
| `github_create_issue` | Create issue (title, body, labels, assignee) | `gh issue create` |
| `github_update_issue` | Update issue fields (title, body, labels, state, assignee) | `gh issue edit` |
| `github_add_comment` | Add comment to issue | `gh issue comment` |
| `github_search_issues` | Search issues (full text + qualifier filters) | `gh search issues` |
| `github_list_labels` | List available labels | `gh label list` |
| `github_close_issue` | Close an issue with optional comment | `gh issue close` |
| `github_list_collaborators` | List repo collaborators (for assignee resolution) | `gh api repos/{owner}/{repo}/collaborators` |

**Design decisions**:
- Use `execFileSync` (not shell — per DOD-212 security policy)
- JSON output from `gh` (`--json` flag) parsed server-side
- No client library needed — `gh` CLI handles auth, pagination, rate limiting
- Server name: `"github-issues"`
- `github_search_issues` uses `gh issue list --search` (not `gh search issues`) — the REST Issues API is real-time and strictly repo-scoped, vs the global search index which can lag
- `linear_list_states` has no direct equivalent — GitHub Issues uses labels instead of workflow states. `github_list_labels` covers this use case.
- `GITHUB_REPO` is required — server exits on startup if missing (same pattern as Linear server with `LINEAR_API_KEY`)

### Tool Details

**`github_list_issues`**
- Params: `state` (open/closed/all, default: open), `labels` (comma-separated), `assignee`, `limit` (default: 25)
- Returns: number, title, state, labels, assignee, URL

**`github_get_issue`**
- Params: `number` (required)
- Returns: full issue body, comments count, labels, assignee, state, URL

**`github_create_issue`**
- Params: `title` (required), `body`, `labels` (array), `assignee`
- Returns: issue number + URL

**`github_update_issue`**
- Params: `number` (required), `title`, `body`, `addLabels`, `removeLabels`, `assignee`, `state` (open/closed)
- Returns: confirmation

**`github_add_comment`**
- Params: `number` (required), `body` (required)
- Returns: confirmation

**`github_search_issues`**
- Params: `query` (required), `limit` (default: 10)
- Uses `gh search issues` with `--repo` scoping
- Returns: number, title, state, labels

**`github_list_labels`**
- No params
- Returns: name, description, color

**`github_close_issue`**
- Params: `number` (required), `comment` (optional)
- Returns: confirmation

**`github_list_collaborators`**
- Params: `limit` (default: 30)
- Returns: login, name, role
- Use case: agents resolve a person's name to a GitHub login before assigning issues

---

## 2. Agent Template Updates

### 2.1 Jasper (vp-engineering)

**`agent.yaml.tpl`**: Replace `linear` → `github-issues` in servers list

**`system-prompt.md.tpl`**:
- "Track work in Linear" → "Track work in GitHub Issues"
- "update Linear issue status" → "update GitHub Issue status"
- "close the Linear issue until CI is green" → "close the GitHub Issue until CI is green"
- "Linear issue is updated" → "GitHub Issue is updated"
- "Linear MCP — manage issues" → "GitHub Issues MCP — manage issues and track work (`github_list_issues`, `github_get_issue`, `github_create_issue`, `github_update_issue`, `github_close_issue`, `github_search_issues`)"

### 2.2 Colt (devops)

**`agent.yaml.tpl`**: Replace `linear` → `github-issues` in servers list

**`system-prompt.md.tpl`**:
- "what's in progress in Linear" → "what's in progress in GitHub Issues"
- "Linear Status" section → "GitHub Issues Status"
- "Use Linear MCP to query recent issues, check sprint progress" → "Use GitHub Issues MCP to query recent issues and their status"
- "Linear MCP — read engineering status (do NOT create or modify issues)" → "GitHub Issues MCP — read engineering status (do NOT create or modify issues). Tools: `github_list_issues`, `github_get_issue`, `github_search_issues`, `github_list_labels`"
- "Create or update Linear issues (read-only access)" → "Create or update GitHub Issues (read-only access)"

### 2.3 Chloe (product-manager)

**`agent.yaml.tpl`**: Replace `linear` → `github-issues` in servers list

**`system-prompt.md.tpl`** — this is the heaviest rewrite:
- "File Linear issues" → "File GitHub Issues"
- "Linear issue format" section → "GitHub Issue Format"
- "Filing issues to Linear" → "Filing issues to GitHub"
- "Linear Configuration" section → "GitHub Issues Configuration" — remove team discovery (no teams in GH Issues, just labels), keep "search before creating" guidance
- "linear_list_teams" setup flow → remove entirely (not needed)
- "linear_search" → `github_search_issues`
- Tool list: replace Linear MCP tools with GitHub Issues MCP tools
- "Linear usage" guardrails → "GitHub Issues usage": "You file issues to the `hive` repo. Use `team:engineering` label for dev work. Always search before creating to avoid duplicates."
- "Is there something related already in the Linear backlog?" → "Is there something related already in GitHub Issues?"

### 2.4 Production Support

**`agent.yaml.tpl`**: Replace `linear` → `github-issues` in servers list (or remove if this agent doesn't need issue access)

### 2.5 Marketing Manager

**`agent.yaml.tpl`**: Replace `linear` → `github-issues` in servers list

**`system-prompt.md.tpl`**:
- Replace Linear MCP tool list with GitHub Issues MCP tools
- Remove team discovery flow
- "Linear usage" → "GitHub Issues usage": "You own marketing issues (label: `team:marketing`). Do NOT create or modify issues with `team:engineering` label."

### 2.6 Guardrail-Only Updates

These templates mention Linear in "you do NOT have access to" sections:

- **executive-assistant**: "Linear" → "GitHub Issues" in guardrails. Update delegation path.
- **customer-success**: "Linear" → "GitHub Issues" in guardrails.
- **product-specialist**: "Linear" → "GitHub Issues" in guardrails.
- **chief-of-staff**: Update team description for product-manager from "Linear issues, specs" → "GitHub Issues, specs". Update any Linear references in guardrails.

### 2.7 Constitution

**`setup/templates/constitution.md.tpl`** line 34:
- "verified internal channels (Slack, Linear)" → "verified internal channels (Slack, GitHub)"

---

## 3. Agent Runner Wiring

**`src/agents/agent-runner.ts`**:
- Add `github-issues` server config block, guarded like other optional services:
  ```
  if (config.github.repo) {
    servers["github-issues"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/github/github-issues-mcp-server.js")],
      env: {
        GITHUB_REPO: config.github.repo,
        GH_TOKEN: config.github.token,
        PATH: process.env.PATH ?? "",
      },
    }
  }
  ```

**`src/config.ts`**:
- Add `github.repo` (required) and `github.token` (optional) config fields (from env `GITHUB_REPO`, `GH_TOKEN`)

---

## 4. Label Setup

Create these labels on `hive` repo:

| Label | Description | Color |
|-------|-------------|-------|
| `team:engineering` | Engineering work | blue |
| `team:marketing` | Marketing work | purple |
| `type:bug` | Bug report | red |
| `type:feature` | New feature | green |
| `type:task` | General task | grey |
| `priority:high` | High priority | orange |
| `priority:low` | Low priority | yellow |

Script: `setup/create-github-labels.sh` using `gh label create`.

---

## 5. Migration

1. Export all open Linear issues (there are very few)
2. Create corresponding GitHub Issues with labels
3. Add a comment on each Linear issue linking to the new GH issue
4. Verify agents can list, create, update, search, close issues via the new MCP server
5. Close Linear issues with a note "Migrated to GitHub Issues #N"
6. Clean up agent memory — instruct affected agents (Jasper, Chloe, marketing manager) to clear or update any stored Linear issue identifiers (e.g. `HIVE-42`) that would be dead references

---

## 6. Cleanup (after verification)

1. Delete `src/linear/linear-mcp-server.ts`
2. Delete `src/linear/linear-client.ts`
3. Remove `linear` server block from `src/agents/agent-runner.ts`
4. Remove `linear` config from `src/config.ts`
5. Remove `LINEAR_API_KEY` / `LINEAR_TEAM_ID` from `.env`
6. Remove `@linear/sdk` from `package.json`
7. Remove `linear` import and dead `LinearClient` instantiation block from `src/index.ts`
8. Update `src/agents/agent-runner.test.ts` — remove `linear` from mock config, add `github` fields
9. Update `src/tasks/task-mcp-server.ts` — change `issueId` description from "Link to a Linear issue" to "Link to a GitHub issue"
10. Update `src/channels/slack-adapter.ts` — fix "Show me all open tasks from Linear" sample text
11. Update `CLAUDE.md` — remove Linear MCP server from the MCP servers list, add GitHub Issues MCP server
12. Update `docs/architecture.md` if it references Linear
13. Update `README.md` if it references Linear
14. Delete or archive `docs/main/linear-integration/` (original Linear integration spec)

---

## Implementation Order

1. GitHub Issues MCP server (`src/github/github-issues-mcp-server.ts`)
2. Config + agent-runner wiring
3. Label setup script + run it
4. Agent template updates (all agents)
5. `npm run setup:agents` to regenerate
6. Build + test locally
7. Migrate Linear issues
8. Deploy, verify agents work end-to-end
9. Remove Linear code + dependencies
10. Final build + deploy
