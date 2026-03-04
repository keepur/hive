# HubSpot Data Jailbreak — User Story

## User Story

**As a** business owner with 5 years of customer data locked in HubSpot,
**I want to** extract all my CRM data (contacts, companies, deals, tasks, activities) into my own infrastructure,
**So that** I can own my data fully, make it searchable via AI agents, and eventually replace HubSpot with my own tools.

## Acceptance Criteria

### Data Extraction
- [ ] All HubSpot contacts are extracted and mapped to dodi_v2 `Persons` collection
- [ ] All HubSpot companies are extracted and mapped to dodi_v2 `Orgs`/`Bizz` collection
- [ ] All HubSpot deals are extracted and mapped to dodi_v2 `Deals` collection
- [ ] All HubSpot tasks are extracted and mapped to dodi_v2 `Tasks` collection
- [ ] All HubSpot activities (notes, emails, calls, meetings) are stored as raw dumps in `hubspot_activities_raw`
- [ ] Contact↔Company associations are resolved to Person→Org links
- [ ] Deal associations are resolved to `contactId`/`orgId` links to migrated records
- [ ] HubSpot ID → dodi ID mapping is maintained for referential integrity

### Vector Embeddings (Atlas)
- [ ] All extracted records are embedded using Voyage AI and stored in Atlas
- [ ] Atlas vector search indexes are created on all RAG collections
- [ ] Semantic search returns relevant results for natural language queries

### CRM Search MCP Server
- [ ] `crm_search` tool performs semantic search across all record types
- [ ] `crm_find_similar` finds records by vector similarity
- [ ] `crm_timeline` returns chronological activity history for a person/org
- [ ] `crm_stats` returns pipeline and record count statistics
- [ ] MCP server is registered in agent-runner and available to agents via `crm-search` server key

### SDR Agent
- [ ] SDR agent template created with system prompt, soul, and config
- [ ] Agent has access to `crm-search`, `contacts`, `resend`, `brave-search`, `slack`, `google`, `memory`, `tasks`
- [ ] Scheduled tasks configured for morning pipeline review, afternoon follow-ups, weekly summary

### Sync Operations
- [ ] `npm run sync:hubspot -- --full` performs complete extraction
- [ ] `npm run sync:hubspot -- --incremental` syncs only records changed since last run
- [ ] `npm run sync:hubspot -- --dry-run` previews counts without writing

## Out of Scope

- HubSpot write-back / bidirectional sync (we're leaving, not integrating)
- Real-time webhooks from HubSpot
- Formal dodi schema for activities/notes (raw dump for now)
- Deal pipeline FSM state mapping (depends on existing `fsm_definitions` — manual mapping step)
- ClickUp integration (separate effort)
