# Implementation Specs

## File 1: `src/types/agent-config.ts`

Add two new exported interfaces after the existing `AgentConfig` interface:

```typescript
export interface ArrayOverride {
  replace?: string[];
  add?: string[];
  remove?: string[];
}

export interface ConfigOverride {
  agentId: string;
  channels?: ArrayOverride;
  passiveChannels?: ArrayOverride;
  keywords?: ArrayOverride;
  servers?: ArrayOverride;
  isDefault?: boolean;
  budgetUsd?: number;
  maxTurns?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  updatedAt: Date;
  updatedBy: string;
}
```

## File 2: `src/agents/agent-registry.ts`

### New instance fields

```typescript
private configOverrides = new Map<string, ConfigOverride>();
private configOverridesCollection?: Collection<ConfigOverride>;
private templateConfigs = new Map<string, AgentConfig>(); // pre-override snapshots
```

### In `connectDb()`

After model overrides setup, add:
```typescript
this.configOverridesCollection = this.db.collection<ConfigOverride>("agent_config_overrides");
await this.configOverridesCollection.createIndex({ agentId: 1 }, { unique: true });
await this.loadConfigOverrides();
```

### New method: `loadConfigOverrides()`

Same pattern as `loadModelOverrides()` — fetch all docs, populate the map, log active overrides.

### In `load()`

Call `this.loadConfigOverrides()` alongside the existing `this.loadModelOverrides()`.

### In `loadAgent()`

After building the config object (line ~116), before returning:
1. Save a copy to `this.templateConfigs`
2. Call `this.applyConfigOverrides(config)` and return the result

### New method: `applyConfigOverrides(config: AgentConfig): AgentConfig`

```
For each array field (channels, passiveChannels, keywords, servers):
  - If override has `replace`: use replace value
  - Else: start with template array, add items from `add`, filter out items from `remove`

For each scalar field (isDefault, budgetUsd, maxTurns, maxConcurrent, timeoutMs):
  - If override has value (not undefined): use override value
```

### New public method: `getTemplate(id: string): AgentConfig | undefined`

Returns the pre-override config from `templateConfigs` map. Used by admin tools for comparison display.

## File 3: `src/admin/admin-mcp-server.ts`

Add a new collection handle at the top:
```typescript
const configOverrides = db.collection("agent_config_overrides");
```

### Tool: `config_list`
- No inputs
- Fetches all docs from `agent_config_overrides`
- Displays agent ID + which fields are overridden + updatedAt/updatedBy

### Tool: `config_get`
- Input: `agent_id: string`
- Fetches the override doc (if any) for this agent
- Shows each overridden field with its current value
- For array overrides, shows the mode (replace/add/remove) and values

### Tool: `config_set`
- Input: `agent_id: string`, `field: string`, `value: any`
- `field` must be one of the overridable fields
- For scalar fields: value is the scalar value
- For array fields: value is `{ replace?: string[], add?: string[], remove?: string[] }`
- Upserts into MongoDB using `$set` on the specific field path
- Sends SIGUSR1 for hot-reload

### Tool: `config_reset`
- Input: `agent_id: string`, `field?: string`
- If field provided: `$unset` that field from the override doc
- If no field: `deleteOne` the entire override doc
- Sends SIGUSR1

### Tool: `config_add`
- Input: `agent_id: string`, `field: string` (must be array field), `values: string[]`
- Reads existing override doc, merges `values` into the `add` array (or creates it)
- Also removes items from `remove` array if they were previously removed
- Upserts, sends SIGUSR1

### Tool: `config_remove`
- Input: `agent_id: string`, `field: string` (must be array field), `values: string[]`
- Reads existing override doc, merges `values` into the `remove` array (or creates it)
- Also removes items from `add` array if they were previously added
- Upserts, sends SIGUSR1

## File 4: `agents-templates/chief-of-staff/system-prompt.md.tpl`

Update the Admin Tools section to document new config tools:

```markdown
## Admin Tools

You have access to the **Admin MCP** for managing agents at runtime:

**Model management:**
- **`model_list`** — see current model overrides
- **`model_set`** — change which AI model an agent runs on
- **`model_reset`** — revert an agent to its default model

**Config management (channels, keywords, budgets, etc.):**
- **`config_list`** — see all active config overrides
- **`config_get`** — show effective config for an agent (template defaults + overrides)
- **`config_set`** — set a config field override (scalar or array replace)
- **`config_reset`** — revert config field(s) to template defaults
- **`config_add`** — add values to an array field (channels, passiveChannels, keywords, servers)
- **`config_remove`** — remove values from an array field

For config changes (channels, keywords, budgets), use these admin tools — they persist in the database
and survive deploys. Do NOT edit YAML files for operational changes.
```

Also update the file system restrictions section to clarify:
- Mokie should use admin tools for operational config changes (not file edits)
- File edits are still appropriate for soul/system-prompt content changes

## Testing Plan

1. Build succeeds with no type errors
2. Hive starts cleanly with empty `agent_config_overrides` collection (no behavior change)
3. `config_add` a channel to an agent → verify via `config_get` and `config_list`
4. Send SIGUSR1 → verify the agent's routing picks up the new channel
5. `config_remove` a channel → verify it's gone after reload
6. `config_reset` → verify revert to template defaults
7. Deploy (full `deploy.sh`) → verify overrides survive
8. Set a scalar override (budgetUsd) → verify via `config_get`
