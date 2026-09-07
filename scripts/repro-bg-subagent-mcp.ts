/**
 * KPR-438 — background-subagent vs in-process MCP probe
 *
 * SDK 0.3.26x (Claude Code 2.1.26x) runs the `Agent` tool's subagents in the
 * BACKGROUND by default and completes them with a `task_notification` that
 * wakes the session. On the dodi fleet, in-process SDK MCP tool calls made
 * after such a notification began failing with "The tool call was interrupted
 * before a result was received". The engine now pins
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the spawn env
 * (`src/agents/agent-runner.ts`) to force subagents inline.
 *
 * This script exists so a future SDK bump can be re-tested. It has two modes,
 * and you need BOTH — read the honesty note below before trusting either.
 *
 *   npx tsx scripts/repro-bg-subagent-mcp.ts --audit [--since=YYYY-MM-DD]
 *       Scan the local Claude CLI transcripts written by a running hive and
 *       report the in-process-MCP interruption rate BEFORE vs AFTER a
 *       task notification, plus a per-day timeline. THIS is the measurement
 *       that actually detects the regression. `--since` scopes it to a
 *       window — use it to gate on days AFTER an SDK bump was deployed,
 *       since the default whole-history scan still carries the 2026-09-03..06
 *       incident and will always report REGRESSION PRESENT.
 *
 *   npx tsx scripts/repro-bg-subagent-mcp.ts [--disable-bg]
 *       Live probe: one query() with an in-process MCP server and one Agent
 *       call. Reports whether the SDK still backgrounds subagents and whether
 *       post-notification pings survive in this harness.
 *
 * ⚠ HONESTY NOTE — the live probe does NOT reproduce the production failure.
 * On SDK 0.3.258 and 0.3.261 (the deployed version) it reports PASS on the
 * unpinned path, across three variants: instant subagent, a genuinely
 * backgrounded 12s subagent with overlapping slow MCP calls, and a
 * dispatch-then-resume pair matching hive's one-query()-per-turn shape. The
 * production trigger is something this minimal harness does not recreate.
 * So: a PASS from the live probe is NECESSARY BUT NOT SUFFICIENT to drop the
 * pin. The removal gate is the audit mode, run against a real hive that has
 * been deployed WITHOUT the pin for at least a day of normal delegating
 * traffic. Drop the pin only when the after-notification interruption rate
 * stays at the pre-regression baseline (~0.06%, i.e. effectively zero).
 *
 * The production signal this was diagnosed from (dodi, SDK 0.3.261):
 *   before any notification : 17502 ok /  10 interrupted (0.06%)
 *   after  a  notification  :   447 ok / 151 interrupted (25%)
 *   every interrupted tool was an in-process SDK MCP server; stdio servers
 *   and builtins never failed. Zero interruptions before the 2026-09-02
 *   deploy; zero again on 2026-09-07 once the operator set the env var.
 *
 * Auth: subscription / OAuth (CLI subprocess path). No ANTHROPIC_API_KEY.
 * Not shipped — `scripts/` is outside package.json `files`.
 */

import { query, tool, createSdkMcpServer, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ARGS = process.argv.slice(2);
const AUDIT = ARGS.includes("--audit");
const DISABLE_BG = ARGS.includes("--disable-bg");
const SINCE = (ARGS.find((a) => a.startsWith("--since=")) ?? "").slice("--since=".length);
const INTERRUPTED = "interrupted before a result was received";

// ── audit mode ───────────────────────────────────────────────────
// Reads the Claude CLI's own transcripts. A hive agent's spawns land in
// ~/.claude/projects/<slugified agent scratch cwd>/*.jsonl.

const PROJECTS_DIR = process.env.REPRO_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
// Deployed instances write to ~/.claude/projects/-Users-<u>-services-hive-<instance>-agents-<agent>-scratch.
// Deliberately NOT just "hive": that also matches every dev checkout and
// worktree under ~/github/hive, whose own Claude Code sessions use background
// subagents freely and would swamp the measurement with unrelated traffic.
// Override for a non-default hive home.
const PROJECT_MATCH = process.env.REPRO_PROJECT_MATCH ?? "services-hive";

interface AuditTotals {
  ok: number;
  interrupted: number;
}

async function audit() {
  let dirs: string[];
  try {
    dirs = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.includes(PROJECT_MATCH))
      .map((e) => join(PROJECTS_DIR, e.name));
  } catch (err) {
    console.error(`cannot read ${PROJECTS_DIR}: ${String(err)}`);
    process.exit(1);
  }
  if (dirs.length === 0) {
    console.error(`no transcript directories under ${PROJECTS_DIR} matching "${PROJECT_MATCH}".`);
    console.error(`Set REPRO_PROJECT_MATCH to a substring of the agent scratch paths.`);
    process.exit(1);
  }

  const toolName = new Map<string, string>();
  const perSession = new Map<string, { ts: string; kind: "ok" | "int" | "notif"; id?: string }[]>();
  const byDay = new Map<string, AuditTotals>();
  let files = 0;

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of entries) {
      files += 1;
      let text: string;
      try {
        text = await readFile(join(dir, name), "utf-8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const cheap =
          line.includes("tool_result") ||
          line.includes("task-notification") ||
          line.includes("task_notification") ||
          line.includes("tool_use");
        if (!cheap) continue;
        let d: any;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const sid: string = d.sessionId ?? "?";
        const ts: string = d.timestamp ?? "";
        const day = ts.slice(0, 10);
        // A --since window drops older lines entirely, including the tool_use
        // name map — an interrupted result whose call predates the window then
        // reports <unknown>, which is fine: the rate is what gates.
        if (SINCE && day && day < SINCE) continue;
        const content = d.message?.content;
        const push = (kind: "ok" | "int" | "notif", id?: string) => {
          const arr = perSession.get(sid) ?? [];
          arr.push({ ts, kind, id });
          perSession.set(sid, arr);
        };

        if (d.type === "assistant" && Array.isArray(content))
          for (const b of content) if (b?.type === "tool_use") toolName.set(b.id, b.name);

        if (d.type === "system" && d.subtype === "task_notification") push("notif");
        else if (line.includes("task-notification")) push("notif");

        if (d.type === "user" && Array.isArray(content))
          for (const b of content) {
            if (b?.type !== "tool_result") continue;
            const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            const kind = body.includes(INTERRUPTED) ? "int" : "ok";
            push(kind, b.tool_use_id);
            if (day) {
              const t = byDay.get(day) ?? { ok: 0, interrupted: 0 };
              if (kind === "int") t.interrupted += 1;
              else t.ok += 1;
              byDay.set(day, t);
            }
          }
      }
    }
  }

  const before: AuditTotals = { ok: 0, interrupted: 0 };
  const after: AuditTotals = { ok: 0, interrupted: 0 };
  const failingTools = new Map<string, number>();
  let notifSessions = 0;

  for (const events of perSession.values()) {
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    let seen = false;
    if (events.some((e) => e.kind === "notif")) notifSessions += 1;
    for (const e of events) {
      if (e.kind === "notif") {
        seen = true;
        continue;
      }
      const bucket = seen ? after : before;
      if (e.kind === "int") {
        bucket.interrupted += 1;
        if (seen) {
          const n = toolName.get(e.id ?? "") ?? "<unknown>";
          failingTools.set(n, (failingTools.get(n) ?? 0) + 1);
        }
      } else bucket.ok += 1;
    }
  }

  const rate = (t: AuditTotals) => (t.ok + t.interrupted === 0 ? 0 : (100 * t.interrupted) / (t.ok + t.interrupted));

  console.log(`── KPR-438 transcript audit ──`);
  console.log(
    `transcript dirs: ${dirs.length}   files: ${files}   sessions: ${perSession.size} (${notifSessions} saw a task notification)`,
  );
  if (SINCE) console.log(`window: ${SINCE} onward`);
  console.log("");
  console.log(
    `before any notification:  ok=${before.ok}  interrupted=${before.interrupted}  (${rate(before).toFixed(2)}%)`,
  );
  console.log(
    `after  a  notification:   ok=${after.ok}  interrupted=${after.interrupted}  (${rate(after).toFixed(2)}%)`,
  );

  if (failingTools.size > 0) {
    console.log("\ninterrupted tools after a notification:");
    for (const [n, c] of [...failingTools.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(c).padStart(4)}  ${n}`);
  }

  const days = [...byDay.keys()].sort().slice(-14);
  if (days.length > 0) {
    console.log("\nper-day tool results (last 14 days with data):");
    for (const day of days) {
      const t = byDay.get(day)!;
      console.log(`  ${day}  interrupted=${String(t.interrupted).padStart(4)}  ok=${String(t.ok).padStart(6)}`);
    }
  }

  // Regression threshold: production ran at 0.06% before the bump and 25%
  // after. 1% is comfortably clear of both.
  const regressed = after.interrupted > 0 && rate(after) > 1;
  console.log("");
  if (after.ok + after.interrupted === 0) {
    console.log("INCONCLUSIVE — no tool results after a notification in these transcripts.");
    console.log("Run against a hive that has been delegating (Agent/Task calls) recently.");
    process.exit(1);
  }
  if (regressed) {
    console.log(`REGRESSION PRESENT — ${rate(after).toFixed(1)}% of post-notification tool calls were interrupted.`);
    console.log("Keep CLAUDE_CODE_DISABLE_BACKGROUND_TASKS pinned in the spawn env.");
    process.exit(1);
  }
  console.log(`CLEAN — post-notification interruption rate ${rate(after).toFixed(2)}% is at baseline.`);
  console.log("If this hive was running WITHOUT the pin, the SDK regression is fixed and the pin may be dropped.");
  process.exit(0);
}

// ── live probe ───────────────────────────────────────────────────

let handlerInvocations = 0;

const probeServer = createSdkMcpServer({
  name: "probe",
  version: "1.0.0",
  tools: [
    tool("ping", "Health probe. Returns a token echoing the call label.", { label: z.string() }, async (args) => {
      handlerInvocations += 1;
      return { content: [{ type: "text" as const, text: `pong:${args.label}:${handlerInvocations}` }] };
    }),
  ],
});

const PROMPT = [
  "Do these three steps in order. Do not skip any. Do not summarize instead of acting.",
  "",
  '1. Call the mcp__probe__ping tool with label "before".',
  '2. Use the Agent tool with subagent_type "sleeper" to run a slow job. Do not wait for it.',
  '3. Then call mcp__probe__ping five more times, with labels "after1" through "after5",',
  "   one at a time, continuing even if some calls fail.",
  "",
  "Then reply with just the word DONE.",
].join("\n");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (b && typeof b === "object" && "text" in b ? String(b.text ?? "") : "")).join(" ");
}

async function probe() {
  if (DISABLE_BG) process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  else delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

  const model = process.env.REPRO_MODEL ?? "claude-sonnet-5";
  const sleepSeconds = Number(process.env.REPRO_SLEEP_S ?? 12);

  console.log("── KPR-438 live probe ──");
  console.log(
    `mode:  ${DISABLE_BG ? "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (pinned)" : "background tasks ENABLED (SDK default)"}`,
  );
  console.log(`model: ${model}`);
  console.log("note:  a PASS here is necessary but NOT sufficient — see the header. Use --audit for the real gate.");

  const pings = new Map<
    string,
    { label: string; afterAgent: boolean; afterNotification: boolean; ok?: boolean; detail?: string }
  >();
  let notificationSeen = false;
  let agentCalls = 0;

  const q = query({
    prompt: PROMPT,
    options: {
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 25,
      settingSources: [],
      mcpServers: { probe: probeServer },
      agents: {
        sleeper: {
          description: "Slow job used to force a genuinely backgrounded Agent call.",
          prompt: `Run exactly one Bash command: sleep ${sleepSeconds}. Then reply with the single word SLEPT.`,
          tools: ["Bash"],
        },
      },
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        ...(DISABLE_BG ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : {}),
      } as Record<string, string | undefined>,
      extraArgs: { "strict-mcp-config": null },
    },
  });

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    const m = msg as any;

    if (m.type === "system" && m.subtype === "task_notification") {
      notificationSeen = true;
      console.log(`  → task_notification (status=${m.status})`);
      continue;
    }

    if (m.type === "assistant" && Array.isArray(m.message?.content))
      for (const b of m.message.content) {
        if (b?.type !== "tool_use") continue;
        if (b.name === "Agent" || b.name === "Task") {
          agentCalls += 1;
          console.log(`  → ${b.name} dispatched`);
        }
        if (String(b.name).includes("probe__ping"))
          pings.set(b.id, {
            label: String(b.input?.label ?? "?"),
            afterAgent: agentCalls > 0,
            afterNotification: notificationSeen,
          });
      }

    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content) {
        if (b?.type !== "tool_result") continue;
        const rec = pings.get(b.tool_use_id);
        if (!rec) continue;
        const body = textOf(b.content).trim();
        rec.ok = !b.is_error && !body.includes(INTERRUPTED) && /^pong:/m.test(body);
        rec.detail = body.slice(0, 100);
        const phase = rec.afterNotification ? "post-notification" : rec.afterAgent ? "post-dispatch" : "pre-dispatch";
        console.log(`  → ping "${rec.label}" [${phase}]: ${rec.ok ? "OK" : "FAIL"} — ${rec.detail}`);
      }
  }

  const all = [...pings.values()];
  // The subject is every in-process MCP call made once the Agent tool has been
  // dispatched — whether or not the completion notification had landed yet.
  // Keying only on the notification made the run INCONCLUSIVE whenever the
  // model finished its pings before the subagent completed.
  const afterAgent = all.filter((p) => p.afterAgent);
  const afterAgentOk = afterAgent.filter((p) => p.ok).length;
  const postNotif = all.filter((p) => p.afterNotification);
  const postNotifOk = postNotif.filter((p) => p.ok).length;

  console.log("\n── result ──");
  console.log(`Agent tool calls:            ${agentCalls}`);
  // A task_notification is emitted either way; what distinguishes background
  // from inline is whether the PARENT kept working before it arrived.
  const ranInBackground = afterAgent.some((p) => !p.afterNotification);
  console.log(`task_notification seen:      ${notificationSeen ? "yes" : "no"}`);
  console.log(
    `subagent execution:          ${ranInBackground ? "BACKGROUND — parent continued before completion" : "inline — parent waited for completion"}`,
  );
  console.log(`handler invocations:         ${handlerInvocations}`);
  console.log(`MCP calls after dispatch:    ${afterAgentOk} / ${afterAgent.length} OK`);
  console.log(`MCP calls post-notification: ${postNotifOk} / ${postNotif.length} OK`);

  if (agentCalls === 0 || afterAgent.length === 0) {
    console.log("\nINCONCLUSIVE — the model did not produce the required call sequence; re-run.");
    process.exit(1);
  }

  if (afterAgentOk === afterAgent.length) {
    console.log(
      `\nPASS (in this harness) — all ${afterAgent.length} in-process MCP calls after the Agent call succeeded.`,
    );
    console.log("This does NOT clear the pin on its own. Run --audit against a real hive.");
    process.exit(0);
  }

  console.log(
    `\nFAIL — ${afterAgent.length - afterAgentOk} of ${afterAgent.length} in-process MCP calls after the Agent call were interrupted.`,
  );
  console.log(
    DISABLE_BG
      ? "The pin did NOT fix it — the failure mode has changed; investigate."
      : "This is the KPR-438 regression. Keep the pin.",
  );
  process.exit(1);
}

const main = AUDIT ? audit : probe;
main().catch((err) => {
  console.error("repro failed to run:", err);
  process.exit(1);
});
