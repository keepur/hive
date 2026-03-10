# Rename crm-search to knowledge-base

## User Story

**As** Jessica (and all agents with search access),
**I want** the semantic search tools to be clearly named `kb_search`, `kb_find_similar`, etc. under a `knowledge-base` MCP server,
**So that** I don't confuse them with the HubSpot CRM direct API tools and waste tokens searching the wrong system.

## Background

The `crm-search` MCP server provides semantic vector search over MongoDB Atlas. The `hubspot-crm` MCP server provides direct read/write to the HubSpot API. Both have "CRM" in the name, causing agents (especially Jessica) to burn tokens trying the wrong tool. Additionally, the search layer will soon include dodi_v2 job/design/production data, making the "CRM" name misleading.

## Acceptance Criteria

1. MCP server renamed from `crm-search` to `knowledge-base`
2. Tool prefix changed from `crm_` to `kb_` (`kb_search`, `kb_find_similar`, `kb_timeline`, `kb_stats`)
3. Tool descriptions updated to reference "CRM, design, and production data" (not just CRM)
4. Server source moved from `src/hubspot/` to `src/search/` (it's not HubSpot-specific)
5. All agent templates updated (servers list + system prompt tool references)
6. Architecture docs updated
7. Clean build, clean deploy, all agents load

## Out of Scope

- MongoDB collection names (`rag_deals`, `rag_contacts`, `rag_activities`) — Atlas-side, separate effort
- The `hubspot-crm` MCP server — correctly named, no change
- Marketing pipeline repo — separate repo, separate effort
- Actually adding dodi_v2 data to the vector DB — future work
