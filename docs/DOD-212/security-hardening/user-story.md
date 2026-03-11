# DOD-212: Security Hardening Round 1

## User Story

**As** the Hive platform operator,
**I want** critical security vulnerabilities identified in the external review to be remediated,
**So that** agent sessions cannot be exploited via prompt injection to execute arbitrary commands, access secrets, or manipulate downstream systems.

## Acceptance Criteria

### Critical: Command Injection (MCP Servers)
- [ ] All `execSync(cmdString)` calls in google, keychain, and drive MCP servers replaced with `execFileSync(binary, argsArray)`
- [ ] Inputs containing `$(...)`, backticks, or `;` are treated as literal strings
- [ ] All existing tool functionality (Gmail, Calendar, Keychain, Drive) works correctly with array-based args

### Critical: Permission Bypass (Agent Sessions)
- [ ] Runtime spike confirms whether MCP tools work under default SDK permission mode
- [ ] If yes: `bypassPermissions` and `allowDangerouslySkipPermissions` removed, `disallowedTools` added
- [ ] If no: `disallowedTools` shipped as partial mitigation, follow-up issue opened in Linear

### High: Background Task RCE
- [ ] All background task API endpoints require `Authorization: Bearer <token>` (POST and GET)
- [ ] Unauthenticated requests return 401
- [ ] `shell: true` removed from `spawn()` — tool schema accepts structured `{ command, args }`
- [ ] Agents can still execute background tasks with structured arguments (spaces, paths work correctly)

### High: Unsigned Recall Webhooks
- [ ] `RECALL_WEBHOOK_SECRET` required — fail closed if missing when Recall is enabled
- [ ] Webhook route includes secret path token; wrong path returns 404
- [ ] Missing secret config returns 403, logs startup error
- [ ] `recall_join_meeting` skips realtime endpoints if secret not configured

### Medium: Sensitive Data in Logs
- [ ] Pairing codes removed from device-registry logs
- [ ] Prompt previews removed from agent-runner logs
- [ ] Tool input previews removed from agent-runner logs
- [ ] Message text/attachment content removed from slack-gateway debug logs

### Low: SMS Initial Poll
- [ ] First poll happens immediately on adapter start (not after 30s delay)

## Out of Scope

- LaunchDaemon migration (separate `_hive` service user) — future DOD-212 scope
- Filesystem access scoping — future DOD-212 scope
- Header-based HMAC webhook verification — follow-up to round 1
- Comprehensive log redaction framework — round 1 covers cited findings only
