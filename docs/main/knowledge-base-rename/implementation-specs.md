# Implementation Specs

## Stream 1: Server file — move + rename internals

### Create `src/search/knowledge-base-mcp-server.ts`
Copy from `src/hubspot/crm-search-mcp-server.ts` with these changes:
- Server name: `"crm-search"` → `"knowledge-base"`
- Tool `"crm_search"` → `"kb_search"`, description: "Semantic search across all CRM, design, and production data..."
- Tool `"crm_find_similar"` → `"kb_find_similar"`, description updated similarly
- Tool `"crm_timeline"` → `"kb_timeline"`, description updated similarly
- Tool `"crm_stats"` → `"kb_stats"`, description updated similarly
- All internal logic, collections, vector search unchanged

### Delete `src/hubspot/crm-search-mcp-server.ts`

## Stream 2: Agent runner registration

### File: `src/agents/agent-runner.ts` (~line 283-296)
- Comment: "CRM Search" → "Knowledge Base — semantic search"
- Server key: `"crm-search"` → `"knowledge-base"`
- Path: `dist/hubspot/crm-search-mcp-server.js` → `dist/search/knowledge-base-mcp-server.js`

## Stream 3: Agent templates — servers lists

Replace `crm-search` with `knowledge-base` in servers arrays:
- `agents-templates/chief-of-staff/agent.yaml.tpl`
- `agents-templates/marketing-manager/agent.yaml.tpl`
- `agents-templates/devops/agent.yaml.tpl`
- `agents-templates/customer-success/agent.yaml`
- `agents-templates/executive-assistant/agent.yaml.tpl`
- `agents-templates/sdr/agent.yaml.tpl`
- `agents-templates/product-manager/agent.yaml.tpl`
- `agents-templates/production-support/agent.yaml` (check if it has crm-search)

## Stream 3b: Agent templates — system prompts

Update tool references in system prompts:

### `agents-templates/chief-of-staff/system-prompt.md.tpl`
- `crm_search` → `kb_search`
- `crm_find_similar` → `kb_find_similar`
- `crm_timeline` → `kb_timeline`
- `crm_stats` → `kb_stats`
- Update description text from "CRM data" to "knowledge base (CRM, design, and production data)"

### `agents-templates/customer-success/system-prompt.md`
- Same tool renames
- Update "CRM Search MCP" → "Knowledge Base MCP" in tool section
- Update description: "semantic search across all CRM, design, and production data"
- Keep all usage instructions (search first, cross-reference, etc.)

### `agents-templates/sdr/system-prompt.md.tpl`
- Same tool renames
- Update section header and description

### Other templates
- Check all other system prompt templates for any `crm_search` references

## Stream 4: Documentation

### `docs/architecture.md`
- `crm-search` → `knowledge-base` in all references
- Update descriptions to reflect broader scope

## Testing

1. `npm run build` — clean compile (no type errors)
2. `deploy.sh` — full deploy, all 10 agents load
3. Verify agents see `kb_*` tools (check logs or ask an agent to list tools)
