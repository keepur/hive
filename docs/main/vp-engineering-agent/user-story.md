# VP Engineering Agent (Jasper) — User Story

## User Story

**As** Mokie (CEO and sole operator),
**I want** a dedicated VP of Engineering agent (Jasper) who owns dev and product for Hive and DodiHome,
**So that** engineering and product work has its own lead with dedicated channels, separate from operational triage handled by Chief of Staff.

## Acceptance Criteria

### AC-1: Jasper Is a Registered Agent
- Jasper loads on Hive startup alongside existing agents (Mokie, Rae, River)
- Has its own identity, personality, and system prompt

### AC-2: Channel Routing
- Messages in `#dev`, `#product`, `#bugs` route to Jasper
- "hey Jasper" or "@Jasper" in any channel routes to Jasper (name matching)
- Engineering keywords (deploy, build, bug, feature, etc.) route to Jasper

### AC-3: Full Tool Access
- Jasper has access to all MCP tools: Memory, Linear, Brave Search, Slack, Contacts, Bash, File system, Keychain, Google
- On first Linear use, Jasper discovers teams and asks which to use, stores in memory

### AC-4: Codebase Awareness
- System prompt directs Jasper to Hive (`~/github/hive`) and DodiHome (`~/github/dodi_v2`)
- Jasper can read, modify, build, and test code in both repos

## Out of Scope
- Separate Slack bot app (Jasper runs under the existing Hive bot)
- GitHub MCP integration (uses `gh` CLI via Bash)
- Automated CI/CD triggers
