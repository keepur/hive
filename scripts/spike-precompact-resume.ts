/**
 * KPR-211 — PreCompact-under-resume verification spike
 *
 * Question: when query() launches with options.resume=sessionId against an
 * already-large server-side conversation, does the SDK fire the PreCompact
 * hook (auto-compaction triggered by total history) or only on per-query()-
 * lifetime growth?
 *
 * (a) PreCompact fires on resumed sessions when total history crosses
 *     threshold → existing PreCompact hook works as-is in Phase A.
 * (b) PreCompact only fires on per-query() growth → Phase A must add hive-
 *     side detection + explicit /compact or summarization-at-resume.
 *
 * Auth: subscription / OAuth (CLI subprocess path) — same path KPR-207 voice
 * uses in production. No ANTHROPIC_API_KEY needed.
 *
 * Run: `tsx scripts/spike-precompact-resume.ts <run-id>`
 *   where <run-id> is one of: small | medium | large | very-large | stress-resume
 *
 * Output: writes a row to scripts/spike-precompact-resume.results.jsonl
 * (append-only) with the observation. Run all five for the full matrix;
 * stress-resume is the load-bearing scenario.
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

type Trigger = "manual" | "auto";

interface Observation {
  runId: string;
  timestamp: string;
  authMode: "oauth-subscription";
  model: string;
  phase1: PhaseResult;
  phase2: PhaseResult;
  conclusion: "fired-on-resume" | "did-not-fire-on-resume" | "fired-only-phase1" | "fired-neither";
  notes: string[];
}

interface PhaseResult {
  sessionId: string | null;
  bulkBytes: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  numTurns: number;
  preCompactFired: boolean;
  preCompactTrigger: Trigger | null;
  compactBoundarySeen: boolean;
  compactBoundaryTrigger: Trigger | null;
  errors: string[];
}

const RESULTS_PATH = resolvePath(process.cwd(), "scripts/spike-precompact-resume.results.jsonl");

interface RunPlan {
  id: string;
  // Approximate target tokens for the bulk content seeded in phase 1.
  // Large numbers approach Sonnet's 200k context window; the SDK should
  // auto-compact before hitting it. very-large probes the threshold.
  phase1TargetTokens: number;
  // Phase 2 just needs to provoke a turn; small is fine.
  phase2TargetTokens: number;
}

const RUNS: Record<string, RunPlan> = {
  small: { id: "small", phase1TargetTokens: 2_500, phase2TargetTokens: 500 },
  medium: { id: "medium", phase1TargetTokens: 25_000, phase2TargetTokens: 500 },
  large: { id: "large", phase1TargetTokens: 125_000, phase2TargetTokens: 500 },
  "very-large": { id: "very-large", phase1TargetTokens: 175_000, phase2TargetTokens: 500 },
  // Critical scenario: phase 1 ends BELOW compaction threshold (uncompacted),
  // phase 2 resumes and adds enough to push cumulative context PAST threshold.
  // If PreCompact fires here, the SDK considers cumulative resumed history when
  // deciding to compact. If it doesn't, hive must add detection at resume time.
  "stress-resume": { id: "stress-resume", phase1TargetTokens: 130_000, phase2TargetTokens: 50_000 },
};

const MODEL = "claude-sonnet-4-6"; // hive's default routine model

function generateBulk(targetTokens: number): string {
  // ~4 chars/token is a conservative rule of thumb for English prose.
  // We use unique-ish content to discourage prompt-cache cleverness from
  // making this look smaller than it is to compaction logic.
  const targetChars = targetTokens * 4;
  const lines: string[] = [];
  let n = 0;
  while (lines.join("\n").length < targetChars) {
    n++;
    lines.push(
      `KPR-211 spike line ${n}: this is unique-ish padding text designed to grow the conversation history toward a token target so we can probe whether the SDK auto-compaction fires under query() resume mode against a large server-side conversation. The number is ${n}, the run is ${process.argv[2] ?? "unknown"}, and the timestamp is ${Date.now()}.`,
    );
  }
  return lines.join("\n");
}

function emptyPhase(): PhaseResult {
  return {
    sessionId: null,
    bulkBytes: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    numTurns: 0,
    preCompactFired: false,
    preCompactTrigger: null,
    compactBoundarySeen: false,
    compactBoundaryTrigger: null,
    errors: [],
  };
}

async function runPhase1(plan: RunPlan): Promise<PhaseResult> {
  const phase: PhaseResult = emptyPhase();
  const bulk = generateBulk(plan.phase1TargetTokens);
  phase.bulkBytes = Buffer.byteLength(bulk, "utf-8");

  console.log(`\n=== Phase 1 (${plan.id}): seeding ~${plan.phase1TargetTokens} tokens of history ===`);

  try {
    const q = query({
      prompt: `Acknowledge briefly. Then I'll send a large block of context for you to read but not summarize.\n\nHere is the block:\n\n${bulk}\n\nReply with one short sentence: "Read it."`,
      options: {
        model: MODEL,
        maxTurns: 2,
        permissionMode: "bypassPermissions",
        hooks: {
          PreCompact: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === "PreCompact") {
                    phase.preCompactFired = true;
                    phase.preCompactTrigger = input.trigger;
                    console.log(`    [hook] PreCompact fired in phase 1 (trigger=${input.trigger})`);
                  }
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    for await (const msg of q) {
      handleMessage(msg, phase);
    }
  } catch (err) {
    phase.errors.push(String(err));
    console.error(`    [phase 1 error] ${String(err)}`);
  }

  console.log(
    `    phase1: bytes=${phase.bulkBytes}, in=${phase.inputTokens}, out=${phase.outputTokens}, cacheRead=${phase.cacheReadInputTokens}, cacheWrite=${phase.cacheCreationInputTokens}, sessionId=${phase.sessionId ?? "n/a"}, preCompact=${phase.preCompactFired ? phase.preCompactTrigger : "no"}`,
  );

  return phase;
}

async function runPhase2(plan: RunPlan, sessionId: string): Promise<PhaseResult> {
  const phase: PhaseResult = emptyPhase();
  const bulk = generateBulk(plan.phase2TargetTokens);
  phase.bulkBytes = Buffer.byteLength(bulk, "utf-8");

  console.log(`\n=== Phase 2 (${plan.id}): resuming session ${sessionId} ===`);

  try {
    const q = query({
      prompt: `Brief follow-up question after the long context above: did you read it? One short sentence.\n\n${bulk}`,
      options: {
        model: MODEL,
        maxTurns: 2,
        permissionMode: "bypassPermissions",
        resume: sessionId,
        hooks: {
          PreCompact: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === "PreCompact") {
                    phase.preCompactFired = true;
                    phase.preCompactTrigger = input.trigger;
                    console.log(
                      `    [hook] PreCompact fired in phase 2 (trigger=${input.trigger}) <-- LOAD-BEARING OBSERVATION`,
                    );
                  }
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    for await (const msg of q) {
      handleMessage(msg, phase);
    }
  } catch (err) {
    phase.errors.push(String(err));
    console.error(`    [phase 2 error] ${String(err)}`);
  }

  console.log(
    `    phase2: bytes=${phase.bulkBytes}, in=${phase.inputTokens}, out=${phase.outputTokens}, cacheRead=${phase.cacheReadInputTokens}, cacheWrite=${phase.cacheCreationInputTokens}, preCompact=${phase.preCompactFired ? phase.preCompactTrigger : "no"}, compactBoundary=${phase.compactBoundarySeen ? phase.compactBoundaryTrigger : "no"}`,
  );

  return phase;
}

function handleMessage(msg: SDKMessage, phase: PhaseResult): void {
  switch (msg.type) {
    case "system": {
      if ("subtype" in msg && msg.subtype === "init") {
        const initMsg = msg as unknown as { session_id?: string; model?: string };
        if (initMsg.session_id) {
          phase.sessionId = initMsg.session_id;
        }
      }
      if ("subtype" in msg && msg.subtype === "compact_boundary") {
        const cb = msg as unknown as {
          compact_metadata?: { trigger?: Trigger };
        };
        phase.compactBoundarySeen = true;
        phase.compactBoundaryTrigger = cb.compact_metadata?.trigger ?? null;
        console.log(`    [stream] compact_boundary observed (trigger=${cb.compact_metadata?.trigger ?? "unknown"})`);
      }
      break;
    }
    case "result": {
      const r = msg as unknown as {
        num_turns?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      if (r.num_turns) phase.numTurns = r.num_turns;
      if (r.usage) {
        phase.inputTokens += r.usage.input_tokens ?? 0;
        phase.outputTokens += r.usage.output_tokens ?? 0;
        phase.cacheCreationInputTokens += r.usage.cache_creation_input_tokens ?? 0;
        phase.cacheReadInputTokens += r.usage.cache_read_input_tokens ?? 0;
      }
      break;
    }
    default:
      // Other message types not relevant to compaction probe
      break;
  }
}

function classifyOutcome(phase1: PhaseResult, phase2: PhaseResult): Observation["conclusion"] {
  const fired1 = phase1.preCompactFired || phase1.compactBoundarySeen;
  const fired2Auto =
    (phase2.preCompactFired && phase2.preCompactTrigger === "auto") ||
    (phase2.compactBoundarySeen && phase2.compactBoundaryTrigger === "auto");
  const fired2Any = phase2.preCompactFired || phase2.compactBoundarySeen;

  if (fired2Auto) return "fired-on-resume";
  if (fired1 && !fired2Any) return "fired-only-phase1";
  if (!fired1 && !fired2Any) return "fired-neither";
  return "did-not-fire-on-resume";
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId || !RUNS[runId]) {
    console.error(`usage: tsx scripts/spike-precompact-resume.ts <${Object.keys(RUNS).join("|")}>`);
    process.exit(1);
  }
  const plan = RUNS[runId]!;

  const phase1 = await runPhase1(plan);
  if (!phase1.sessionId) {
    console.error("Phase 1 produced no session_id; aborting phase 2.");
    return;
  }

  const phase2 = await runPhase2(plan, phase1.sessionId);
  const conclusion = classifyOutcome(phase1, phase2);

  const obs: Observation = {
    runId: plan.id,
    timestamp: new Date().toISOString(),
    authMode: "oauth-subscription",
    model: MODEL,
    phase1,
    phase2,
    conclusion,
    notes: [],
  };

  if (conclusion === "fired-on-resume") {
    obs.notes.push(
      "Case (a): SDK auto-compaction fires on resumed sessions. Existing PreCompact hook works as-is post-Phase-A.",
    );
  } else if (conclusion === "did-not-fire-on-resume" || conclusion === "fired-only-phase1") {
    obs.notes.push(
      "Case (b): SDK auto-compaction did NOT fire on resumed session despite large server-side history. Phase A must add hive-side detection + explicit /compact or summarization-at-resume.",
    );
  } else {
    obs.notes.push(
      "Inconclusive: history may not have crossed compaction threshold. Try a larger run or repeat for non-determinism.",
    );
  }

  await appendFile(RESULTS_PATH, JSON.stringify(obs) + "\n", "utf-8");

  console.log(`\n=== Observation (${plan.id}): ${conclusion} ===`);
  console.log(obs.notes.join("\n"));
  console.log(`Appended to ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("spike failed:", err);
  process.exit(1);
});
