# Google MCP Server Consolidation — Design Spec

**Date**: 2026-03-26
**Status**: Draft
**Scope**: Merge Drive tools into the `google` MCP server, retire `google-workspace` server

## Problem

Two separate MCP servers handle Google services:
- `google` (google-mcp-server.ts) — Gmail + Calendar via `gog` CLI
- `google-workspace` (drive/drive-mcp-server.ts) — Google Drive via `gws` CLI

This is unnecessary because `gog` already supports Drive (`gog drive ls`, `gog drive upload`, `gog drive download`). Having two servers means:
- Two CLIs to install and auth (`gog` + `gws`)
- Two OAuth clients and token stores to manage
- Two entries in agent `servers` lists
- Two sets of env vars to configure
- Confusion about which server does what

## Design

### Add Drive tools to `google` MCP server

Add three tools to `src/google/google-mcp-server.ts`, replacing the functionality in `src/drive/drive-mcp-server.ts`:

**`drive_upload`** — Upload a local file to Google Drive
- Uses `gog drive upload <localPath> --parent <folderId> --name <name> --json`
- Parameters: `file_path` (required), `name` (optional — override filename)
- `DRIVE_SHARED_FOLDER` env var for default upload folder (optional — if unset, uploads to Drive root)
- Returns file name, web link, file ID
- Validates file exists before upload (`existsSync` check)

**`drive_download`** — Download a file from Google Drive
- Uses `gog drive download <fileId> --out <localPath> --format <format>`
- Parameters: `file_id` (optional), `url` (optional — extracts file ID from Drive URL)
- Google-native docs: `gog drive download` auto-detects and exports. The `--format` flag controls export format (default: inferred — Docs→txt, Sheets→csv, Slides→pdf). To force a specific format: `--format txt`, `--format csv`, etc.
- Downloads to `/tmp/{instanceId}-drive-downloads/`
- For text-based exports (txt, csv), read the file and return content inline so the agent can process it without a second tool call

**`drive_list`** — List files in a Drive folder
- Uses `gog drive ls --parent <folderId> --query <filter> --json`
- Parameters: `query` (optional — Drive query filter), `limit` (optional, default 20)
- Default folder from `DRIVE_SHARED_FOLDER` env var. If query is provided, uses `gog drive ls --parent <folderId> --query "name contains '<query>'"` for folder-scoped search
- Returns file names, sizes, dates, links

### Verified `gog` CLI flags

Confirmed via `gog drive <cmd> --help`:

| Command | Key flags |
|---------|-----------|
| `upload` | `--parent <folderId>`, `--name <name>`, `--json` |
| `download` | `--out <path>`, `--format pdf\|csv\|xlsx\|txt\|png\|docx` (default: inferred) |
| `ls` | `--parent <folderId>`, `--query <filter>`, `--json`, `--all-drives` |
| `get` | `<fileId>`, `--json` (returns metadata) |
| `search` | `<query>`, `--json` (global search, not folder-scoped) |

### Env var changes

The `google` MCP server gains one new env var:

| Env Var | Source | Description |
|---------|--------|-------------|
| `DRIVE_SHARED_FOLDER` | `config.google.sharedFolder` | Default Drive folder ID for uploads/listings (optional) |

Existing env vars unchanged: `GOG_ACCOUNT`, `GOG_CLIENT`, `GOG_PATH`.

### Config changes

Move `sharedFolder` from `googleWorkspace` to `google` with backward-compat fallback:

```yaml
# Before
googleWorkspace:
  account: bot@dodihome.com
  sharedFolder: 149-loWJnUWfJP6rEAsuFoYsI2pS1JjRM

# After
google:
  account: bot@dodihome.com
  client: ""
  sharedFolder: 149-loWJnUWfJP6rEAsuFoYsI2pS1JjRM
  accounts:
    marketing-manager: river@dodihome.com
    customer-success: jessica@dodihome.com
```

`config.ts` changes:
```typescript
sharedFolder: optional("DRIVE_SHARED_FOLDER",
  hive.google?.sharedFolder ?? hive.googleWorkspace?.sharedFolder ?? ""),
```

The `googleWorkspace.sharedFolder` fallback ensures existing `hive.yaml` files that haven't been migrated still work. Without this, uploads silently go to Drive root.

### Agent runner changes

In `agent-runner.ts`:
- Add `DRIVE_SHARED_FOLDER: config.google.sharedFolder` to the `google` server env vars
- Remove the `google-workspace` server registration block entirely

### Agent config changes — IMPORTANT

Every agent template that has `google-workspace` in its `servers` list must be updated. Two changes per template:

1. **Remove** `google-workspace` from servers
2. **Add** `google` to servers **if not already present**

Many templates have `google-workspace` but NOT `google` (they had Drive but not Gmail/Calendar). After migration, these agents need `google` in their servers list or they lose Drive access entirely.

**Action**: `grep -r "google-workspace" agents-templates/ plugins/dodi/agents-templates/` to find all affected templates. For each:
- If it has both `google` and `google-workspace`: remove `google-workspace`
- If it has only `google-workspace`: replace with `google`

### Files to retire

| File | Action |
|------|--------|
| `src/drive/drive-mcp-server.ts` | Delete |
| `src/drive/` directory | Delete (if empty after removal) |

### Backward compatibility

- **Config**: `config.ts` falls back to `googleWorkspace.sharedFolder` if `google.sharedFolder` is not set (explicit fallback chain shown above)
- **Agents**: Templates are updated in this PR. Any manually configured agents with `google-workspace` in their servers will silently lose Drive access until their config is updated — this is acceptable since all templates are updated and MongoDB config overrides can be fixed per-agent.

## Files to Change

| File | Change |
|------|--------|
| `src/google/google-mcp-server.ts` | Add `drive_upload`, `drive_download`, `drive_list` tools; read `DRIVE_SHARED_FOLDER` env var |
| `src/agents/agent-runner.ts` | Add `DRIVE_SHARED_FOLDER` env var to google server; remove `google-workspace` server block |
| `src/config.ts` | Add `sharedFolder` to `google` config with `googleWorkspace` fallback |
| `src/drive/drive-mcp-server.ts` | Delete |
| Agent templates (`agents-templates/*/agent.yaml.tpl`) | Replace `google-workspace` with `google` in servers lists (add `google` if not present) |
| Plugin templates (`plugins/dodi/agents-templates/*/agent.yaml.tpl`) | Same |
| `CLAUDE.md` | Update MCP server list: remove `drive/drive-mcp-server.ts`, note Drive tools are now in `google-mcp-server.ts` |

## Not In Scope

- Adding new Drive features beyond upload/download/list (search, mkdir, share, etc. are available in `gog` but not needed for V1)
- Uninstalling the `gws` binary
- Changing the `gog` CLI itself
