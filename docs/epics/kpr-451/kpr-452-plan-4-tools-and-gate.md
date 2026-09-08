# KPR-452 plan — chunk 4: admin tools, documentation, submission gate

Read with [the main plan](kpr-452-plan.md). Tasks 7–8.

## Task 7: The two admin MCP tools

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` — imports (`:10-35`), new tools before the closing `];` of `buildAdminTools` (`:1446`)
- Modify: `src/admin/admin-mcp-server.test.ts`

- [ ] **Step 1:** Add the import beside the other `../` imports in `src/admin/admin-mcp-server.ts`:

```typescript
// KPR-452 (D5): the audit-routing control reaches this server through a
// module-global accessor, NOT through a Dispatcher import — that is what
// keeps the two out of an import cycle.
import { getAuditRoutingControl } from "../audit/audit-routing.js";
```

- [ ] **Step 2:** Insert both tools immediately after the `memory_lifecycle_run_consolidation` tool, before the closing `];` of `buildAdminTools` (`:1446` — note `:1443` is the `}` closing that tool's own `catch`, not the array terminator; the prose anchor is authoritative if the line has moved). `agentId` is already destructured from `deps` at the top of that function and is the `updatedBy` value D5 specifies (`AdminToolDeps.agentId`).

Neither tool calls `control.ready()` directly, and that is correct rather than an oversight: readiness is enforced *inside* the control — `describe()` and `set()` each check `dispatcher.auditRoutingReady()` first and return the boot-window `NOT_READY` message — so a tool-level pre-check would only duplicate it and could disagree with it under a race. `ready()` therefore stays on the `AuditRoutingControl` interface unused by its only consumer; keep the comment below so a later reader does not conclude the boot-window check was forgotten and "fix" it by adding a second gate.

```typescript
    tool(
      "audit_channel_get",
      "Report where this hive's audit mirror posts. The audit mirror copies every non-Slack-sourced agent turn — agent-to-agent team DMs, event-bus deliveries, voice, SMS and iOS turns — into ONE configured Slack channel. Shows the effective channel name, whether it comes from a runtime override or hive.yaml, whether it currently resolves to a Slack channel id, who last changed it, and an advisory if the channel is some agent's own homeBase. Call this before audit_channel_set.",
      {},
      async () => {
        const control = getAuditRoutingControl();
        if (!control) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "audit_channel_get: audit routing is not reachable from this process. These tools require the in-process admin server.",
              },
            ],
          };
        }
        // No `control.ready()` call here BY DESIGN — describe()/set() each
        // check readiness internally and return the boot-window NOT_READY
        // message themselves. A second gate here would duplicate that check
        // and could disagree with it. `ready()` is deliberately unused.
        try {
          return { content: [{ type: "text", text: await control.describe() }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `audit_channel_get error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "audit_channel_set",
      "Point this hive's audit mirror at a Slack channel. Pass the channel NAME (not its id), with or without a leading '#'. The name is validated against Slack before anything is saved — an unresolvable name is REJECTED and nothing is persisted. On success it applies to the NEXT AUDIT POST: no restart and no SIGUSR1. Pass an empty string to clear the runtime override and revert to the hive.yaml `slack.auditChannel` value; if that is also unset, the audit mirror is then OFF. The bot must be a member of the channel to post there — invite it first.",
      {
        channel_name: z
          .string()
          .describe(
            "Slack channel NAME, e.g. 'ops-audit' or '#ops-audit'. Pass an empty string to clear the override and revert to hive.yaml.",
          ),
      },
      async ({ channel_name }) => {
        const control = getAuditRoutingControl();
        if (!control) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "audit_channel_set: audit routing is not reachable from this process. These tools require the in-process admin server.",
              },
            ],
          };
        }
        try {
          const stripped = channel_name.trim().replace(/^#/, "");
          if (stripped === "") {
            const cleared = await control.set("", agentId);
            return cleared.ok
              ? { content: [{ type: "text", text: cleared.message }] }
              : { isError: true, content: [{ type: "text", text: cleared.message }] };
          }
          // Reject a raw Slack id BEFORE lowercasing — the id form is
          // uppercase, so the check has to run on the pre-normalized value.
          if (/^[CGD][A-Z0-9]{7,}$/.test(stripped)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `audit_channel_set: '${stripped}' looks like a raw Slack channel id. Pass the channel NAME instead (e.g. 'ops-audit'). Nothing was saved.`,
                },
              ],
            };
          }
          const normalized = stripped.toLowerCase();
          if (!/^[a-z0-9_.-]{1,80}$/.test(normalized)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `audit_channel_set: '${stripped}' is not a valid Slack channel name (lowercase letters, digits, '-', '_' and '.' only, 1-80 characters). Nothing was saved.`,
                },
              ],
            };
          }
          const res = await control.set(normalized, agentId);
          return res.ok
            ? { content: [{ type: "text", text: res.message }] }
            : { isError: true, content: [{ type: "text", text: res.message }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `audit_channel_set error: ${String(err)}` }] };
        }
      },
    ),
```

**Lane B note — deliberately no code.** `buildToolTransportInventory` (`agent-runner.ts:1337-1368`) is server-level and `admin` already has a stdio placeholder in the filtered map, so two new tools on an existing server require no KPR-390 inventory compensation and no new `suppressAutoInjectedServers` gate. Do not add one.

**Access control — deliberately no code.** These tools are reachable only by agents that already carry `admin` in `coreServers`. No new permission surface and no autonomy flag ships (spec D5).

- [ ] **Step 3:** Append this describe block to `src/admin/admin-mcp-server.test.ts`, moving the `import` line up beside the file's other imports.

```typescript
import { setAuditRoutingControl, type AuditRoutingControl } from "../audit/audit-routing.js";

// ---------------------------------------------------------------------------
// KPR-452: audit_channel_get / audit_channel_set. The TOOL layer owns
// normalization and the syntax rejection ladder; resolution, persistence and
// application belong to the control (covered in src/audit/audit-routing.test.ts).
// ---------------------------------------------------------------------------

describe("admin-mcp-server — audit channel tools (KPR-452)", () => {
  let control: { ready: any; describe: any; set: any };

  beforeEach(() => {
    control = {
      ready: vi.fn(() => true),
      describe: vi.fn(async () => "Audit channel: #ops-audit\nSource: runtime override"),
      set: vi.fn(async (name: string) => ({ ok: true, message: `set to ${name || "(cleared)"}` })),
    };
    setAuditRoutingControl(control as unknown as AuditRoutingControl);
  });

  afterEach(() => setAuditRoutingControl(undefined));

  it("audit_channel_get returns the control's description", async () => {
    const res = await getHandler(makeTools(), "audit_channel_get")({});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("#ops-audit");
    expect(control.describe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a bare name", "ops-audit", "ops-audit"],
    ["a leading hash", "#Ops-Audit", "ops-audit"],
    ["surrounding whitespace", "  #ops-audit  ", "ops-audit"],
  ])("audit_channel_set normalizes %s", async (_label, input, expected) => {
    const res = await getHandler(makeTools({ agentId: "chief-of-staff" }), "audit_channel_set")({
      channel_name: input,
    });
    expect(res.isError).toBeFalsy();
    expect(control.set).toHaveBeenCalledWith(expected, "chief-of-staff");
  });

  it("AC9: rejects a raw Slack channel id without touching the control", async () => {
    const res = await getHandler(makeTools(), "audit_channel_set")({ channel_name: "C09ABCDEFG" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("raw Slack channel id");
    expect(res.content[0].text).toContain("Nothing was saved");
    expect(control.set).not.toHaveBeenCalled();
  });

  it.each(["ops audit", "Ops/Audit!", "a".repeat(81)])(
    "AC9: rejects the invalid name %s without touching the control",
    async (name) => {
      const res = await getHandler(makeTools(), "audit_channel_set")({ channel_name: name });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not a valid Slack channel name");
      expect(control.set).not.toHaveBeenCalled();
    },
  );

  it("AC9: an empty string clears the override through the control", async () => {
    const res = await getHandler(makeTools(), "audit_channel_set")({ channel_name: "   " });
    expect(res.isError).toBeFalsy();
    expect(control.set).toHaveBeenCalledWith("", "admin");
  });

  it("surfaces a control rejection as a tool error", async () => {
    control.set = vi.fn(async () => ({ ok: false, message: "#ghost did not resolve" }));
    const res = await getHandler(makeTools(), "audit_channel_set")({ channel_name: "ghost" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("did not resolve");
  });

  // Spec D5: during the boot window the tools must "say so and ask for a
  // retry" — never a spurious not-found. The CONTRACT lives in the control
  // (src/audit/audit-routing.test.ts pins it there); this row pins the
  // SURFACE the agent actually sees, i.e. that the tool layer neither
  // swallows the message nor reports success. Nothing here reads
  // `control.ready()` — see the interface note in Step 2.
  it("D5: reports the boot-window not-ready state at the tool surface", async () => {
    const NOT_READY = "Audit routing is not ready yet — the engine is still starting. Retry in a moment.";
    control.ready = vi.fn(() => false);
    control.describe = vi.fn(async () => NOT_READY);
    control.set = vi.fn(async () => ({ ok: false, message: NOT_READY }));

    const got = await getHandler(makeTools(), "audit_channel_get")({});
    expect(got.content[0].text).toContain("not ready yet");

    const setRes = await getHandler(makeTools(), "audit_channel_set")({ channel_name: "ops-audit" });
    expect(setRes.isError).toBe(true);
    expect(setRes.content[0].text).toContain("not ready yet");
    expect(setRes.content[0].text).toContain("Retry in a moment");
  });

  it("reports honestly when no control is installed (the stdio-fallback limit)", async () => {
    setAuditRoutingControl(undefined);
    const tools = makeTools();
    for (const name of ["audit_channel_get", "audit_channel_set"]) {
      const res = await getHandler(tools, name)({ channel_name: "ops-audit" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not reachable from this process");
    }
  });

  it("a throwing control becomes a tool error, never an unhandled rejection", async () => {
    control.describe = vi.fn(async () => {
      throw new Error("mongo down");
    });
    const res = await getHandler(makeTools(), "audit_channel_get")({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("audit_channel_get error");
  });
});
```

- [ ] **Step 4:** Verify. This is the main plan's **Unit** command in full — both files, not `admin-mcp-server.test.ts` alone. The two tests share the `setAuditRoutingControl` module global, and running them in one invocation is what proves the `afterEach(() => setAuditRoutingControl(undefined))` cleanup in each file actually holds across the pair (Harness Requirements, last bullet).

```bash
cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts && \
  npm run typecheck && \
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/audit/audit-routing.test.ts src/admin/admin-mcp-server.test.ts
```

Expected: `tsc` exits 0; both files green — the whole admin suite including the pre-existing envelope and model-catalog blocks, plus the Chunk 1 leaf tests re-running clean.

- [ ] **Step 5:** Commit.

```bash
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "feat: add audit_channel_get and audit_channel_set admin tools"
```

---

## Task 8: Documentation, AC11 inspection, and the submission gate

**Files:**
- Modify: `CLAUDE.md:300` (engine-written MongoDB collections list) and the `admin-mcp-server.ts` bullet in the MCP-server list.

- [ ] **Step 1:** In `CLAUDE.md`'s engine-written collections list (line 300), insert this entry immediately after `` `instance_identity` (identity sentinel, KPR-294), ``:

```
`instance_settings` (KPR-452 audit-mirror routing override — exactly one document, `_id: "audit_routing"` `{channelName, updatedAt, updatedBy}`; written only by the admin `audit_channel_set` tool, read once at boot; no TTL, no index beyond `_id`),
```

- [ ] **Step 2:** In the MCP-server list, extend the admin bullet:

```
- `admin-mcp-server.ts` — agent CRUD + version history, agent model catalog (KPR-381), audit-mirror channel routing (KPR-452 — `audit_channel_get`/`audit_channel_set`) [in-process]
```

- [ ] **Step 3:** AC11 — verify by inspection.

```bash
cd /Users/mokie/github/hive-kpr-452-mature && \
  echo "fallbackAuditId=$(grep -c 'fallbackAuditId' src/index.ts) retentionReportChannelId=$(grep -c 'retentionReportChannelId' src/index.ts)" && \
  grep -n "retentionReportChannelId\|fallbackAuditId" src/index.ts
```

Expected, machine-checkable rather than eyeballed: `fallbackAuditId=0 retentionReportChannelId=5`. (`grep -c` counts matching **lines**, and all five sites are on distinct lines.) The five are the declaration (~`:183`), the assignment in the audit try block (~`:660`), the boot-log `retentionReportResolved: Boolean(retentionReportChannelId)` field, and the two `RetentionSweeper.report` reads (~`:925`, `:927`) — the `grep -n` output confirms they are those five and not five of something else. If the variable is gone, AC11 fails and the change must be corrected — not the criterion.

Then confirm by inspection that `RetentionSweeper.report` still reads a value derived from `config.slack.auditChannel` and **not** from `dispatcher.getAuditChannelName()` / `peekAuditChannelId()`. The divergence is deliberate (spec D4): a runtime `audit_channel_set` moves the audit mirror and does not move the retention report.

- [ ] **Step 4:** AC13 — confirm by inspection that `postAuditLog`'s `try` opens as its first statement and its `catch` is the method's last, so name resolution, the lazy `conversations.list` and `auditAdapter.deliver` are all inside it:

```bash
cd /Users/mokie/github/hive-kpr-452-mature && sed -n '/private async postAuditLog/,/^  }$/p' src/channels/dispatcher.ts
```

- [ ] **Step 5:** Full diff inspection against the recorded `implementation-base`:

```bash
cd /Users/mokie/github/hive-kpr-452-mature && git diff --check <implementation-base> && git diff --stat <implementation-base> && \
  echo "auditAdapter.kind=$(grep -c 'auditAdapter.kind' src/channels/dispatcher.ts)" && \
  grep -n "auditAdapter.kind" src/channels/dispatcher.ts
```

Expected: only the ten files in the main plan's File map. Confirm no change landed in `src/scheduler/`, `src/workers/`, `src/outage/`, `src/retention/`, `src/config.ts`, `src/channels/slack-adapter.ts`, or `src/agents/`; no new config key; no `activity_log` or event-schema change. The count line must read exactly `auditAdapter.kind=1`, and the `grep -n` line must fall inside `postAuditLog` — a second hit means a `source.kind` predicate was re-added at a call site (spec D1).

- [ ] **Step 6:** Submission gate.

```bash
cd /Users/mokie/github/hive-kpr-452-mature && node -v && \
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: `node -v` prints `v24.*`; typecheck, lint, format check and the full Vitest suite each exit 0. Record the exact exit status and the actual test totals in the child delivery handoff — do not invent expected counts.

- [ ] **Step 7:** Commit.

```bash
git add CLAUDE.md
git commit -m "docs: record the instance_settings collection and audit channel tools"
```
