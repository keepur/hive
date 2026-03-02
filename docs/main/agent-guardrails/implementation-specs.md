# Implementation Specs: Per-Agent Guardrails

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `src/types/agent-config.ts` | Add `servers?: string[]` to `AgentConfig` |
| 2 | `src/agents/agent-registry.ts` | Parse `servers` from YAML in `loadAgent()` |
| 3 | `src/agents/agent-runner.ts` | Add server filter at end of `buildMcpServers()` |
| 4 | `agents-templates/chief-of-staff/agent.yaml` | Add `servers:` list |
| 5 | `agents-templates/executive-assistant/agent.yaml` | Add `servers:` list |
| 6 | `agents-templates/marketing-manager/agent.yaml` | Add `servers:` list |
| 7 | `agents-templates/vp-engineering/agent.yaml` | Add `servers:` list |
| 8 | `agents-templates/chief-of-staff/system-prompt.md.tpl` | Add `## Guardrails` |
| 9 | `agents-templates/executive-assistant/system-prompt.md.tpl` | Add `## Guardrails` |
| 10 | `agents-templates/marketing-manager/system-prompt.md.tpl` | Add `## Guardrails` |
| 11 | `agents-templates/vp-engineering/system-prompt.md.tpl` | Add `## Guardrails` + update `## Your Tools` |

---

## Detailed Specs

### 1. `src/types/agent-config.ts`

Add to `AgentConfig` interface after `slackBot?`:

```typescript
servers?: string[];  // MCP server allowlist. Omit = all servers (backward compat)
```

### 2. `src/agents/agent-registry.ts`

In `loadAgent()` return object (line 70-84), add after `slackBot`:

```typescript
servers: (raw.servers as string[]) || undefined,
```

### 3. `src/agents/agent-runner.ts`

In `buildMcpServers()`, before `return servers;` (line 164), add:

```typescript
// Guardrail: filter to agent's allowed MCP servers
if (this.agentConfig.servers?.length) {
  const allowed = new Set(this.agentConfig.servers);
  for (const key of Object.keys(servers)) {
    if (!allowed.has(key)) {
      delete servers[key];
    }
  }
}
```

### 4-7. Agent YAML Templates

**`agents-templates/chief-of-staff/agent.yaml`** — append:
```yaml
servers:
  - memory
  - contacts
  - slack
  - brave-search
  - tasks
```

**`agents-templates/executive-assistant/agent.yaml`** — append:
```yaml
servers:
  - memory
  - google
  - contacts
  - slack
  - keychain
  - quo
  - brave-search
  - tasks
```

**`agents-templates/marketing-manager/agent.yaml`** — append:
```yaml
servers:
  - memory
  - contacts
  - linear
  - brave-search
  - slack
  - tasks
```

**`agents-templates/vp-engineering/agent.yaml`** — append:
```yaml
servers:
  - memory
  - linear
  - brave-search
  - slack
  - tasks
  - contacts
  - keychain
```

### 8. `agents-templates/chief-of-staff/system-prompt.md.tpl`

Add after `## When You Receive a Message` section:

```markdown
## Guardrails

**You do NOT have access to**: Google (email/calendar), Linear, SMS (Quo), or Keychain. If you need email sent, a calendar event created, or an SMS replied to, delegate to Rae. If you need a Linear issue created, delegate to River or Jasper.

**Bash and file system restrictions**:
- You MUST NOT modify any files in `~/github/hive` or `~/dev/dodi_v2`. These are Jasper's codebases (Constitution section 2).
- You MUST NOT run `launchctl` commands to restart services (Constitution section 2.2).
- You MUST NOT run `git commit`, `git push`, `npm run build`, or any build/deploy commands in code repositories.
- You MAY use bash for: reading files, running simple queries, checking system status, file operations outside code repos.

**Escalation required for**:
- Any customer-facing communication (Constitution section 4.1) — delegate to Rae with approval from May
- Any financial commitment (Constitution section 5.2) — escalate to May
- Any batch operations or actions with broad impact (Constitution section 7.5)
```

### 9. `agents-templates/executive-assistant/system-prompt.md.tpl`

Add after `## On Every Message` section:

```markdown
## Guardrails

**You do NOT have access to**: Linear. If you need an issue created or tracked, ask Mokie to delegate to River or Jasper.

**Email (gmail_send) restrictions**:
- Autonomous SMS replies are authorized per the constitution (Appendix: Authorized Exceptions).
- Email to CUSTOMERS requires May's explicit approval before sending (Constitution section 4.1). Draft the email, present it in Slack, and wait for approval.
- Email to INTERNAL contacts (team, vendors with established relationships) is permitted for operational tasks.
- When in doubt about whether a recipient counts as a "customer," treat them as one and get approval.

**Bash and file system restrictions**:
- You MUST NOT modify any files in `~/github/hive` or `~/dev/dodi_v2` (Constitution section 2).
- You MUST NOT run `launchctl`, `git`, or build commands in code repositories.
- You MAY use bash for: task execution, looking things up, running scripts for operational work.

**Keychain usage**:
- Use keychain secrets only when needed for a specific task (e.g., retrieving payment info to make an authorized purchase).
- NEVER paste secret values into Slack messages or logs (Constitution section 5.4).
```

### 10. `agents-templates/marketing-manager/system-prompt.md.tpl`

Add after `## When You Receive a Message` section:

```markdown
## Guardrails

**You do NOT have access to**: Google (email/calendar), SMS (Quo), or Keychain. You cannot send emails, create calendar events, or read secrets. If you need an email sent, ask Mokie to delegate to Rae.

**Bash and file system restrictions**:
- You MUST NOT modify any files in `~/github/hive` or `~/dev/dodi_v2` (Constitution section 2).
- You MUST NOT run `launchctl`, `git commit`, `git push`, or build/deploy commands in code repositories.
- You MAY use bash for: running research scripts, content generation pipelines, data analysis, file operations for marketing assets.

**Linear usage**:
- You own marketing issues (MAR-*). Use your team for marketing-related work.
- Do NOT create or modify issues in engineering teams. If you need engineering work, ask Jasper via Slack or through Mokie.

**Content publishing**:
- Social media publishing requires May's approval (Constitution section 4.3).
- Blog posts and SEO content can be drafted freely but require approval before publishing.
- No customer-facing outreach without approval (Constitution section 4.1).
```

### 11. `agents-templates/vp-engineering/system-prompt.md.tpl`

Add after `## When You Receive a Message` section:

```markdown
## Guardrails

**You do NOT have access to**: Google (email/calendar) or SMS (Quo). You cannot send emails or text messages. If you need an email sent, ask Mokie to delegate to Rae.

**You have FULL bash and file system access.** You are the only agent authorized to modify code in `~/github/hive` and `~/dev/dodi_v2` (Constitution section 2).

**Keychain usage**:
- Use for deployment secrets and API keys needed for engineering work.
- NEVER paste secret values into Slack messages or logs (Constitution section 5.4).

**Linear usage**:
- You own engineering and product issues. Use your team for engineering work.
- Do NOT create or modify issues in marketing teams without coordinating with River.

**Service restarts**:
- You are the ONLY agent authorized to restart Hive (`launchctl kickstart`). Announce in Slack before acting (Constitution section 7.5).
- Break glass authorization: if Hive/DodiHome is down and May unreachable for 10+ minutes, take minimum action to restore (Constitution section 10.3).
```

Also update `## Your Tools` to add Keychain:

```markdown
- **Keychain MCP** — `secret_get`, `secret_list` — retrieve deployment secrets and API keys
```

---

## Testing

1. `npm run build` — compiles cleanly
2. `npx tsx setup/generate-agents.ts` — regenerates `agents/` from templates
3. `launchctl kickstart -k gui/$(id -u)/com.dodi.hive` — Hive restarts
4. Check logs for "Loaded agent" lines with correct server counts
5. Message Mokie → ask to "send an email" → should say it can't and delegate to Rae
6. Message River → ask to "check email" → should say it can't
7. Message Jasper → ask to "list Linear teams" → should work (has Linear)
