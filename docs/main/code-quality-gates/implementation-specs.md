# Code Quality Gates — Implementation Specs

## Files to Create

### `eslint.config.js`

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "agents/", "logs/", "**/*.js"],
  }
);
```

### `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "tabWidth": 2,
  "printWidth": 120
}
```

### `.prettierignore`

```
dist/
node_modules/
agents/
logs/
```

### `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
```

### `.husky/pre-commit`

```sh
npx lint-staged
```

### `.git-blame-ignore-revs`

```
# Initial Prettier + ESLint formatting pass
<SHA will be filled after the formatting commit>
```

## Files to Modify

### `package.json`

**Add devDependencies:**

```json
"devDependencies": {
  "eslint": "^9",
  "@eslint/js": "^9",
  "typescript-eslint": "^8",
  "eslint-config-prettier": "^10",
  "prettier": "^3",
  "husky": "^9",
  "lint-staged": "^15",
  "vitest": "^3"
}
```

**Add scripts:**

```json
"scripts": {
  "lint": "eslint src/ plugins/ setup/",
  "lint:fix": "eslint --fix src/ plugins/ setup/",
  "format": "prettier --write '**/*.ts'",
  "format:check": "prettier --check '**/*.ts'",
  "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.plugins.json",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "check": "npm run typecheck && npm run lint && npm run format:check && npm run test"
}
```

**Add lint-staged config:**

```json
"lint-staged": {
  "*.ts": ["eslint --fix", "prettier --write"]
}
```

### `tsconfig.json`

Add to `exclude` array:

```json
"exclude": ["src/**/*.test.ts"]
```

This prevents test files from being compiled into `dist/`.

### `.gitignore`

Add:

```
coverage/
```

### `src/plugins/plugin-loader.ts`

Export `normalizeManifest()` so it can be tested directly:

```ts
// Before: function normalizeManifest(raw: any): PluginManifest { ... }
// After:  export function normalizeManifest(raw: any): PluginManifest { ... }
```

### `src/agents/agent-registry.ts`

Extract `applyConfigOverrides()` as an exported standalone function. It's a pure transform (takes agent config + overrides, returns modified config) — no reason to be a private method.

```ts
// Extract from wherever it lives in the class/module:
export function applyConfigOverrides(config: AgentConfig, overrides: ConfigOverride[]): AgentConfig {
  // existing logic moved here
}
```

## Test Specs

### `src/plugins/plugin-loader.test.ts`

**`normalizeManifest()` tests:**

| Scenario | Input | Expected |
|----------|-------|----------|
| Kebab-to-camel conversion | `{ "agent-env": {...} }` | `{ agentEnv: {...} }` |
| Missing optional fields default | `{ name: "x", entry: "y" }` | Defaults for `env`, `envMap`, `agentEnv`, `mcpServers` |
| Full manifest passthrough | Complete YAML-parsed object | All fields present and correctly typed |
| env/envMap/agentEnv merging | Overlapping keys | Later values override earlier |

**`loadPlugins()` tests (mock filesystem):**

| Scenario | Setup | Expected |
|----------|-------|----------|
| Valid plugin loads | Mock dir with `manifest.yaml` + entry file | Plugin returned in array |
| Missing manifest | Mock dir, no `manifest.yaml` | Warn logged, plugin skipped |
| Missing entry file | Manifest points to nonexistent file | Warn logged, plugin skipped |

### `src/agents/agent-registry.test.ts`

**Name addressing tests:**

| Input | Expected match |
|-------|---------------|
| `"hey River can you..."` | River |
| `"@Jasper please check"` | Jasper |
| `"Jasper: do this"` | Jasper |
| `"Jasper and River"` | [Jasper, River] (multi-match fan-out) |
| `"nobody mentioned"` | No match |

**Keyword matching tests:**

| Input | Expected |
|-------|----------|
| Keyword in message | Matching agent |
| Special regex chars in keyword | No crash, correct match |
| No keyword match | No match |

**Channel lookup tests:**

| Input | Expected |
|-------|----------|
| Channel with mapped agent | Correct agent |
| Unmapped channel | No match |

**`applyConfigOverrides()` tests:**

| Scenario | Expected |
|----------|----------|
| Scalar override (model) | Value replaced |
| Array add (mcpServers) | Item appended |
| Array remove (mcpServers) | Item removed |
| No matching overrides | Config unchanged |

### `src/channels/dispatcher.test.ts`

Uses mock registry and agent-manager to test `resolveAgents()` through all 6 tiers.

**Resolution tier tests (in priority order):**

| Tier | Scenario | Expected |
|------|----------|----------|
| 1 | Explicit `targetAgentId` set | That agent, skip all other tiers |
| 2 | Reply in existing thread | Thread's agent (continuity) |
| 3 | Message in mapped channel | Channel's agent |
| 4 | Name mentioned in text | Named agent(s), including multi-agent fan-out |
| 5 | Keyword match | Keyword-matched agent |
| 6 | No match at all | Default agent fallback |

**Dedup tests:**

| Scenario | Expected |
|----------|----------|
| Same message ID within TTL | Second call skipped |
| Same message ID after TTL | Processed again |
| Different message IDs | Both processed |

**Other dispatcher tests:**

| Scenario | Expected |
|----------|----------|
| Status query (`"agent status"`) | Intercepted, returns status response |
| Non-response suppression pattern | Message suppressed, not dispatched |

## Execution Notes

- Run phases 1-2 as a single session (config + format commit)
- Phase 3 (husky) should be a separate commit — touching `package.json` again
- Phase 4 (vitest) separate commit — new config file + tsconfig change
- Phase 5 (tests) can be one commit or split per test file if the refactors are significant
- After all phases: run `npm run check` to validate, then `npm run build` to confirm dist is clean
