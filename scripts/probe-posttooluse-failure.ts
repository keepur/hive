/**
 * KPR-454 chunk 4, Task 5, Step 6 — the `PostToolUseFailure` failure-class probe.
 *
 * Probes WHICH Claude-lane failure classes fire PostToolUseFailure.
 * MUST run through the SDK's BUNDLED binary — `query()` from inside this repo
 * resolves @anthropic-ai/claude-agent-sdk-darwin-arm64. NEVER `claude -p`,
 * which tests the wrong binary (CLAUDE.md, "Agent CLI = the SDK's bundled
 * native binary"). The fleet floats ^0.3.258, so deployed instances resolve
 * HIGHER than this lockfile — record the resolved version with the result.
 *
 * Class 6 (a Claude-lane PreToolUse DENY) is the class AC12 turns on: if
 * PostToolUseFailure fires for a denied call, every archetype denial mints a
 * false `tool-failed` row. For that class the probe records THREE facts:
 * (i) does PostToolUseFailure fire, (ii) does PermissionDenied fire, and
 * (iii) in what order.
 *
 * ── RESULT, 2026-09-11, @anthropic-ai/claude-agent-sdk@0.3.258, claude-haiku-4-5
 *
 * Two columns: PTUF = PostToolUseFailure, PTU = PostToolUse. The PTU column is
 * the RECOVERY half's load-bearing assumption (see the standing re-check below);
 * the run below observed it — the per-class dump at the foot of this file prints
 * every fired event in sequence, PostToolUse included — but the run's summary
 * line tallied only PTUF, so the PTU answers were not PRESERVED and are recorded
 * as `unrecorded` rather than reconstructed. The summary line now tallies both,
 * so the next run records them without a re-run being needed for that alone.
 *
 *   1 throwing in-process MCP tool ............ PTUF FIRED (is_interrupt=false)
 *                                              PTU  unrecorded
 *   2 MCP isError result ...................... PTUF FIRED (is_interrupt=false)
 *                                              PTU  unrecorded
 *   3 stdio server whose command exits ........ PTUF did NOT fire — the server
 *     never connects (CONNECTION_CLOSED), its tools never enter the inventory, so
 *     no tool call is ever made. A connect-time fault, not an unobserved call.
 *                                              PTU  n/a (no call was made)
 *   4 builtin throw (Read ENOENT, Bash rc=7) .. PTUF FIRED x2
 *                                              PTU  unrecorded
 *   5 KPR-438-style interrupt ................. PTUF INCONCLUSIVE — not
 *     reproduced (the same caveat repro-bg-subagent-mcp.ts carries). NOT "does
 *     not fire".                               PTU  unrecorded
 *   6 PreToolUse DENY ......................... PTUF did NOT fire.
 *     PermissionDenied did not fire either; the denial reason reached the model
 *     verbatim and the turn continued. ⇒ AC12 holds as written: an archetype
 *     denial mints no `tool-failed` row, and NO id-keyed suppression is needed.
 *                                              PTU  did NOT fire (the `order:`
 *     field this class already prints enumerates every seq >= 0 event, and it
 *     was empty — so this one PTU answer IS recorded, by that field).
 *
 * ── THE STANDING RE-CHECK LIST. Each item is CLI-version-dependent, cannot be
 *    unit-tested, and the fleet floats ^0.3.258 and resolves HIGHER than this
 *    lockfile — so re-run this probe on an SDK bump rather than assuming.
 *
 * ⚠ Class 6's "did not fire". AC12's Claude-lane clause rests on it.
 *
 * ⚠ The PTU column, on classes 1/2/4 — the RECOVERY half's single most
 *   load-bearing SDK assumption, and until now documented without being
 *   recorded. The recovery half rests on PostToolUse firing per SUCCESSFUL call
 *   and NEVER after a failed one. If it also fired after PostToolUseFailure,
 *   every failure would be followed by a closure, so the NEXT failure of that
 *   tool would advance `generation` — a fresh epoch per failure (the C18 flood),
 *   plus a fresh ledger row and a first delivery once KPR-468 exists. A
 *   `PostToolUse` line for the same `tool_use_id` as a `PostToolUseFailure` line
 *   is the signature to look for.
 *
 * ⚠ Class 7 (NOT PROBED, added from review — do not read the absence as a
 *   negative): a MODEL-INVENTED tool name. Class 6 establishes that a DENIED
 *   call does not fire the hook; nothing here covers a name the model made up
 *   that resolves to no tool at all. If that fires PostToolUseFailure, the
 *   Claude lane's family key space becomes model-influenced rather than bounded
 *   by the installed inventory — which is what `OPEN_CONDITION_MAP_CAP`'s
 *   rationale rests on (publisher.ts) — and an invented name over 200 characters
 *   increments `rejected`, D9's mis-integrated-PRODUCER signal, from model
 *   output. Bounded either way (eviction costs one delayed boundary; a rejection
 *   stores nothing), which is why it is recorded rather than defended against.
 *
 * Usage: npx tsx scripts/probe-posttooluse-failure.ts [class-number ...]
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";

const SDK_VERSION = JSON.parse(readFileSync("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8"))
  .version as string;

interface Fired {
  seq: number;
  event: string;
  tool: string;
  toolUseId: string;
  extra?: string;
}

const MODEL = "claude-haiku-4-5";

function observers(fired: Fired[]): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  let seq = 0;
  const push = (input: HookInput, extra?: string) => {
    const i = input as unknown as { hook_event_name: string; tool_name?: string; tool_use_id?: string };
    fired.push({
      seq: seq++,
      event: i.hook_event_name,
      tool: i.tool_name ?? "?",
      toolUseId: i.tool_use_id ?? "?",
      ...(extra !== undefined ? { extra } : {}),
    });
  };
  return {
    PostToolUseFailure: [
      {
        hooks: [
          async (input: HookInput) => {
            const f = input as unknown as { error?: string; is_interrupt?: boolean; duration_ms?: number };
            push(
              input,
              `is_interrupt=${String(f.is_interrupt)} duration_ms=${String(f.duration_ms)} error=${JSON.stringify(
                (f.error ?? "").slice(0, 160),
              )}`,
            );
            return {};
          },
        ],
      },
    ],
    PostToolUse: [{ hooks: [async (input: HookInput) => (push(input), {})] }],
    PermissionDenied: [
      {
        hooks: [
          async (input: HookInput) => {
            push(
              input,
              `reason=${JSON.stringify(String((input as unknown as { reason?: string }).reason ?? "").slice(0, 120))}`,
            );
            return {};
          },
        ],
      },
    ],
  };
}

// ── the six classes ────────────────────────────────────────────────────────

const throwingServer = createSdkMcpServer({
  name: "probe_throw",
  version: "1.0.0",
  tools: [
    tool("probe_boom", "Always throws. Call it exactly once.", {}, async () => {
      throw new Error("probe: deliberate handler throw");
    }),
  ],
});

const isErrorServer = createSdkMcpServer({
  name: "probe_iserror",
  version: "1.0.0",
  tools: [
    tool("probe_iserror_tool", "Always returns an error result. Call it exactly once.", {}, async () => ({
      isError: true,
      content: [{ type: "text" as const, text: "probe: deliberate isError result" }],
    })),
  ],
});

const delegateServer = createSdkMcpServer({
  name: "probe_slow",
  version: "1.0.0",
  tools: [
    tool("probe_slow_tool", "Sleeps briefly then returns ok.", { ms: z.number().optional() }, async (args) => {
      await new Promise((r) => setTimeout(r, Math.min(Number(args.ms ?? 1500), 12000)));
      return { content: [{ type: "text" as const, text: "ok" }] };
    }),
  ],
});

interface ProbeClass {
  n: number;
  label: string;
  prompt: string;
  extraOptions?: Record<string, unknown>;
  denyAll?: boolean;
}

const CLASSES: ProbeClass[] = [
  {
    n: 1,
    label: "Throwing in-process MCP tool",
    prompt:
      "Call the tool mcp__probe_throw__probe_boom exactly once with no arguments, then reply DONE. Do not retry it.",
    extraOptions: { mcpServers: { probe_throw: throwingServer }, allowedTools: ["mcp__probe_throw__probe_boom"] },
  },
  {
    n: 2,
    label: "MCP isError result",
    prompt:
      "Call the tool mcp__probe_iserror__probe_iserror_tool exactly once with no arguments, then reply DONE. Do not retry it.",
    extraOptions: {
      mcpServers: { probe_iserror: isErrorServer },
      allowedTools: ["mcp__probe_iserror__probe_iserror_tool"],
    },
  },
  {
    n: 3,
    label: "Stdio-server fault (command exits immediately)",
    prompt: "Call the tool mcp__probe_dead__anything exactly once, then reply DONE. Do not retry it.",
    extraOptions: {
      mcpServers: {
        probe_dead: { type: "stdio" as const, command: "/usr/bin/false", args: [] as string[], env: {} },
      },
    },
  },
  {
    n: 4,
    label: "Builtin throw (Read on a nonexistent path, Bash exiting nonzero)",
    prompt:
      "Do exactly two things then reply DONE. (1) Use the Read tool on the absolute path /tmp/kpr454-probe-does-not-exist-9f3a.txt. (2) Use the Bash tool to run: exit 7. Do not retry either one, and do not check whether the file exists first.",
    extraOptions: { allowedTools: ["Read", "Bash"] },
  },
  {
    n: 5,
    label: "KPR-438-style interrupt (delegating subagent)",
    prompt:
      "Use the Task tool to dispatch one general-purpose subagent whose entire job is to reply with the single word PONG. While it runs, call mcp__probe_slow__probe_slow_tool with ms=4000. Then reply DONE.",
    extraOptions: {
      mcpServers: { probe_slow: delegateServer },
      allowedTools: ["Task", "mcp__probe_slow__probe_slow_tool"],
    },
  },
  {
    n: 6,
    label: "Claude-lane PreToolUse DENY",
    prompt: "Use the Bash tool to run: echo hello. Then reply DONE. Do not retry if it is denied.",
    extraOptions: { allowedTools: ["Bash"] },
    denyAll: true,
  },
];

async function runClass(c: ProbeClass): Promise<Fired[]> {
  const fired: Fired[] = [];
  const hooks = observers(fired);
  if (c.denyAll) {
    // Exactly the shape agent-runner.ts's fail-closed archetype arm installs.
    hooks.PreToolUse = [
      {
        hooks: [
          async () => ({
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason:
                "Archetype hook initialization failed (probe). All tool calls blocked until the archetype is fixed.",
            },
          }),
        ],
      },
    ];
  }
  const q = query({
    prompt: c.prompt,
    options: {
      model: MODEL,
      maxTurns: 8,
      permissionMode: "bypassPermissions",
      settingSources: [],
      hooks,
      ...(c.extraOptions ?? {}),
    } as never,
  });
  const timer = setTimeout(() => void q.interrupt?.().catch(() => {}), 120_000);
  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of (msg as { message: { content: Array<Record<string, unknown>> } }).message.content) {
          if (block.type === "tool_use") {
            fired.push({ seq: -1, event: "[model requested]", tool: String(block.name), toolUseId: String(block.id) });
          }
        }
      }
      if (msg.type === "result") {
        fired.push({
          seq: -1,
          event: `[result:${(msg as { subtype?: string }).subtype ?? "?"}]`,
          tool: "",
          toolUseId: "",
          extra: JSON.stringify(String((msg as { result?: string }).result ?? "").slice(0, 300)),
        });
      }
    }
  } catch (err) {
    fired.push({ seq: -1, event: `[threw: ${String(err).slice(0, 200)}]`, tool: "", toolUseId: "" });
  } finally {
    clearTimeout(timer);
  }
  return fired;
}

async function main(): Promise<void> {
  const wanted = process.argv
    .slice(2)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const classes = wanted.length > 0 ? CLASSES.filter((c) => wanted.includes(c.n)) : CLASSES;
  console.log(`SDK @anthropic-ai/claude-agent-sdk@${SDK_VERSION}, model ${MODEL}\n`);
  for (const c of classes) {
    console.log(`\n═══ class ${c.n}: ${c.label} ═══`);
    const fired = await runClass(c);
    for (const f of fired) {
      console.log(`  [${f.seq}] ${f.event} tool=${f.tool} id=${f.toolUseId}${f.extra ? ` ${f.extra}` : ""}`);
    }
    const ptuf = fired.filter((f) => f.event === "PostToolUseFailure");
    const ptu = fired.filter((f) => f.event === "PostToolUse");
    const pd = fired.filter((f) => f.event === "PermissionDenied");
    const tally = (label: string, rows: Fired[]) =>
      `${label}: ${rows.length > 0 ? `FIRED x${rows.length}` : "did not fire"}`;
    // PostToolUse is tallied HERE, not only dumped above: the per-class dump
    // prints it, but the dump is transcript and the summary is what gets pasted
    // into this file's RESULT block — which is how the 2026-09-11 run observed
    // the PTU answers and preserved none of them. It is also the recovery half's
    // load-bearing assumption, so `tool_use_id` overlap with a
    // PostToolUseFailure on the same class is the thing to read (see the
    // standing re-check list at the head of this file).
    const overlap = ptu.filter((s) => ptuf.some((f) => f.toolUseId === s.toolUseId)).map((s) => s.toolUseId);
    console.log(
      `  => ${tally("PostToolUseFailure", ptuf)} | ${tally("PostToolUse", ptu)}` +
        (overlap.length > 0 ? ` | ⚠ SAME tool_use_id on BOTH: ${overlap.join(",")}` : "") +
        (c.denyAll
          ? ` | ${tally("PermissionDenied", pd)}` +
            ` | order: ${fired
              .filter((f) => f.seq >= 0)
              .map((f) => f.event)
              .join(" -> ")}`
          : ""),
    );
  }
}

void main();
