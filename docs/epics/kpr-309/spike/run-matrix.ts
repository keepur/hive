/**
 * KPR-310 spike — chain runner for the model-switching matrix.
 * Spec: docs/epics/kpr-309/kpr-310-spec.md. Throwaway harness (D1) - no imports from src/**.
 *
 * Usage (from worktree root, after npm install):
 *   npx tsx docs/epics/kpr-309/spike/run-matrix.ts [--plan] [--cell M2 [--run <id>]] [--seed 310] [--with-m9] [--summarize [--run <id>]]
 */
import { mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  query,
  createSdkMcpServer,
  tool,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { FIXED_SYSTEM_PROMPT } from "./prefix.ts";
import {
  buildCells,
  noncesFor,
  DEFAULT_SEED,
  MODELS,
  SECRET_WORD,
  TOOL_NAME,
  MCP_SERVER_NAME,
  MCP_TOOL_FULL_NAME,
  type CellSpec,
  type TurnSpec,
} from "./cells.ts";
import { viewResult, type TurnRecord } from "./grade.ts";
import { buildSummary, latestCompleteRunId, REQUIRED_CELLS } from "./summarize.ts";

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SPIKE_DIR, "evidence");
const SUMMARY_PATH = join(EVIDENCE_DIR, "summary.json");
/** Isolated session cwd: SDK session files land under a dedicated ~/.claude/projects/ slot (spec). */
const SCRATCH_CWD = join(tmpdir(), "kpr-310-spike-sessions");
const TURN_TIMEOUT_MS = 120_000; // spec-pinned per-turn wall-clock bound
const CACHE_WINDOW_MS = 240_000; // T3 must start within this of T1's end (5m TTL minus margin)
const MAX_TURNS = 6; // spec-pinned

function sdkVersion(): string {
  // Spike dir is docs/epics/kpr-309/spike -> repo root is 4 levels up.
  const p = join(SPIKE_DIR, "..", "..", "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  const pkg = JSON.parse(readFileSync(p, "utf8")) as { version: string };
  return pkg.version;
}

const spikeServer = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "1.0.0",
  tools: [
    tool(TOOL_NAME, "Returns the secret word for the KPR-310 spike.", {}, async () => ({
      content: [{ type: "text", text: SECRET_WORD }],
    })),
  ],
});

interface CliArgs {
  plan: boolean;
  cell: string | null;
  seed: number;
  withM9: boolean;
  summarize: boolean;
  run: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { plan: false, cell: null, seed: DEFAULT_SEED, withM9: false, summarize: false, run: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") args.plan = true;
    else if (a === "--with-m9") args.withM9 = true;
    else if (a === "--summarize") args.summarize = true;
    else if (a === "--cell") args.cell = argv[++i] ?? null;
    else if (a === "--run") args.run = argv[++i] ?? null;
    else if (a === "--seed") args.seed = Number(argv[++i] ?? String(DEFAULT_SEED));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(args.seed)) throw new Error("--seed must be an integer");
  return args;
}

function buildOptions(turn: TurnSpec, resumeId: string | null, controller: AbortController): Options {
  const options: Options = {
    model: turn.model,
    systemPrompt: FIXED_SYSTEM_PROMPT,
    maxTurns: MAX_TURNS,
    cwd: SCRATCH_CWD,
    settingSources: [],
    // Mirror hive's isolation posture (KPR-201): sandbox MCP discovery only; auth and
    // session storage stay on the default ~/.claude/. Never set CLAUDE_CONFIG_DIR.
    extraArgs: { "strict-mcp-config": null },
    abortController: controller,
    env: {
      ...process.env,
      CLAUDECODE: undefined, // avoid nested-session guard when run from inside a Claude Code session
      CLAUDE_AGENT_SDK_CLIENT_APP: "kpr-310-spike/0.0.1",
    },
  };
  if (resumeId !== null) options.resume = resumeId;
  if (turn.fork === true) options.forkSession = true;
  if (turn.withTool === true) {
    options.mcpServers = { [MCP_SERVER_NAME]: spikeServer };
    options.allowedTools = [MCP_TOOL_FULL_NAME];
  }
  if (turn.adaptiveThinking === true) options.thinking = { type: "adaptive" };
  return options;
}

/** Serializable subset of the options for the evidence line (spec: "full options object (minus env)"). */
function loggableOptions(turn: TurnSpec, resumeId: string | null): Record<string, unknown> {
  return {
    model: turn.model,
    systemPromptChars: FIXED_SYSTEM_PROMPT.length,
    maxTurns: MAX_TURNS,
    cwd: SCRATCH_CWD,
    settingSources: [],
    extraArgs: { "strict-mcp-config": null },
    ...(resumeId !== null ? { resume: resumeId } : {}),
    ...(turn.fork === true ? { forkSession: true } : {}),
    ...(turn.withTool === true ? { mcpServers: [MCP_SERVER_NAME], allowedTools: [MCP_TOOL_FULL_NAME] } : {}),
    ...(turn.adaptiveThinking === true ? { thinking: { type: "adaptive" } } : {}),
  };
}

interface TurnOutcome {
  record: TurnRecord;
  returnedSessionId: string | null;
  failed: boolean; // triggers cell retry unless faultExpected
}

async function runTurn(
  cell: CellSpec,
  turn: TurnSpec,
  resumeId: string | null,
  runId: string,
  seed: number,
  attempt: number,
  cacheWindowOk: boolean | null,
): Promise<TurnOutcome> {
  const nonces = noncesFor(cell.id, seed);
  const prompt = turn.prompt(nonces);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TURN_TIMEOUT_MS);

  const messageTypes: string[] = [];
  const assistantTexts: string[] = [];
  let initSessionId: string | null = null;
  let apiKeySource: string | null = null;
  let resultMessage: unknown = null;
  let responseText = "";
  let toolCalled = false;
  let thrown: TurnRecord["thrown"] = null;
  const started = Date.now();

  try {
    const q = query({ prompt, options: buildOptions(turn, resumeId, controller) });
    for await (const msg of q) {
      const subtype = "subtype" in msg && typeof (msg as { subtype?: unknown }).subtype === "string"
        ? `:${(msg as { subtype: string }).subtype}`
        : "";
      messageTypes.push(`${msg.type}${subtype}`);
      if (msg.type === "system" && msg.subtype === "init") {
        initSessionId = msg.session_id;
        apiKeySource = String(msg.apiKeySource);
      } else if (msg.type === "assistant") {
        // Structural access into the Beta API message content (SDK types the payload loosely).
        const content = (msg as unknown as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string") assistantTexts.push(block.text);
            if (block.type === "tool_use" && block.name === MCP_TOOL_FULL_NAME) toolCalled = true;
          }
        }
      } else if (msg.type === "result") {
        resultMessage = msg;
        if (msg.subtype === "success") responseText = msg.result;
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    thrown = { name: e.name, message: e.message, stack: e.stack };
  } finally {
    clearTimeout(timer);
  }
  if (responseText === "") responseText = assistantTexts.join("\n");

  const nonceChecks: TurnRecord["nonceChecks"] = [
    ...turn.expect.map((key) => ({ key, value: nonces[key], relation: "expect" as const, found: responseText.includes(nonces[key]) })),
    ...(turn.forbid ?? []).map((key) => ({ key, value: nonces[key], relation: "forbid" as const, found: responseText.includes(nonces[key]) })),
    ...(turn.observe ?? []).map((key) => ({ key, value: nonces[key], relation: "observe" as const, found: responseText.includes(nonces[key]) })),
  ];

  const record: TurnRecord = {
    runId, seed, ts: new Date().toISOString(), cell: cell.id, attempt,
    turnLabel: turn.label, requestedModel: turn.model, resumeOf: turn.resumeOf,
    resumedSessionId: resumeId, fork: turn.fork === true,
    options: loggableOptions(turn, resumeId),
    messageTypes, apiKeySource, initSessionId, resultMessage, responseText,
    toolCalled, thrown, timedOut, wallMs: Date.now() - started, cacheWindowOk, nonceChecks,
  };

  const rv = viewResult(resultMessage);
  const turnErrored = thrown !== null || timedOut || rv === null || rv.subtype !== "success" || rv.isError;
  // Retry-once on ANY failure (spec): a continuity break on an otherwise-successful turn
  // counts as a failure too - expect-misses trigger the retry (forbid/observe are
  // evidence-not-failure and never do).
  const expectMiss = nonceChecks.some((c) => c.relation === "expect" && !c.found);
  const toolMissing = turn.requireToolCall === true && !toolCalled;
  const windowBlown = turn.switchBack === true && cacheWindowOk === false;
  const failed =
    ((turnErrored || expectMiss) && turn.faultExpected !== true) || toolMissing || windowBlown;
  return { record, returnedSessionId: initSessionId, failed };
}

function appendEvidence(record: TurnRecord): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(join(EVIDENCE_DIR, `${record.cell}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

async function runCellAttempt(cell: CellSpec, runId: string, seed: number, attempt: number): Promise<{ records: TurnRecord[]; failed: boolean }> {
  const returnedIds = new Map<string, string>();
  const records: TurnRecord[] = [];
  let failed = false;
  let t1EndedAt: number | null = null;
  for (const turn of cell.turns) {
    let resumeId: string | null = null;
    if (turn.resumeOf !== null) {
      resumeId = returnedIds.get(turn.resumeOf) ?? null;
      if (resumeId === null) {
        // Only turns whose resume target never returned an id are skipped; independent
        // branches (M7a T3b, M8 T3/P1/P2) still run after an earlier turn failed.
        console.error(`  ${cell.id}/${turn.label}: no returned id for ${turn.resumeOf} - skipping turn`);
        failed = true;
        continue;
      }
    }
    const cacheWindowOk = turn.switchBack === true && t1EndedAt !== null
      ? Date.now() - t1EndedAt <= CACHE_WINDOW_MS
      : turn.switchBack === true
        ? false
        : null;
    console.log(`  ${cell.id}/${turn.label} attempt ${attempt}: model=${turn.model}${resumeId ? ` resume=${resumeId.slice(0, 8)}...` : " (new session)"}${turn.fork ? " fork" : ""}`);
    const outcome = await runTurn(cell, turn, resumeId, runId, seed, attempt, cacheWindowOk);
    appendEvidence(outcome.record);
    records.push(outcome.record);
    if (outcome.returnedSessionId !== null) returnedIds.set(turn.label, outcome.returnedSessionId);
    if (turn.label === "T1") t1EndedAt = Date.now();
    const rv = viewResult(outcome.record.resultMessage);
    console.log(
      `    -> ${outcome.record.timedOut ? "TIMEOUT" : outcome.record.thrown ? `THROWN ${outcome.record.thrown.name}` : `subtype=${rv?.subtype}`} id=${outcome.record.initSessionId?.slice(0, 8) ?? "none"} wall=${outcome.record.wallMs}ms cacheRead=${rv?.modelUsage[turn.model]?.cacheReadInputTokens ?? "n/a"}`,
    );
    if (outcome.failed) failed = true;
  }
  return { records, failed };
}

/** Retry policy (spec-pinned): retry a failed cell ONCE on ANY failure; both attempts recorded. */
async function runCell(cell: CellSpec, runId: string, seed: number): Promise<TurnRecord[]> {
  console.log(`\n== ${cell.id} - ${cell.title}`);
  const a1 = await runCellAttempt(cell, runId, seed, 1);
  if (!a1.failed) return a1.records;
  console.log(`  ${cell.id}: attempt 1 failed - retrying once (spec retry policy)`);
  const a2 = await runCellAttempt(cell, runId, seed, 2);
  return [...a1.records, ...a2.records]; // grader/summary use the final attempt
}

/** Spec-pinned cache-validity gate: M1's T2 must show nonzero per-model cacheReadInputTokens. */
function checkM1Gate(m1Records: TurnRecord[]): boolean {
  const finalAttempt = Math.max(...m1Records.map((r) => r.attempt));
  const t2 = m1Records.find((r) => r.attempt === finalAttempt && r.turnLabel === "T2");
  const mu = t2 ? viewResult(t2.resultMessage)?.modelUsage[MODELS.sonnet] : undefined;
  const read = mu?.cacheReadInputTokens ?? 0;
  if (read > 0) {
    console.log(`\nM1 cache-validity gate PASS: T2 cacheReadInputTokens=${read}`);
    return true;
  }
  console.error(
    `\nM1 cache-validity gate FAILED: T2 cacheReadInputTokens=${read}.\n` +
      `The fixed prefix is below the minimum cacheable size for this model - every cache\n` +
      `column would read zero vacuously. Enlarge SECTIONS in prefix.ts, then RESTART THE\n` +
      `FULL MATRIX (spec: gate is automated, not a judgment call).`,
  );
  return false;
}

function readAllRecords(): TurnRecord[] {
  if (!existsSync(EVIDENCE_DIR)) return [];
  const records: TurnRecord[] = [];
  for (const f of readdirSync(EVIDENCE_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(EVIDENCE_DIR, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      records.push(JSON.parse(line) as TurnRecord);
    }
  }
  return records;
}

function writeSummary(records: TurnRecord[], runId: string, seed: number): void {
  const summary = buildSummary(records, runId, sdkVersion(), seed);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nsummary.json written: ruling=${summary.ruling} cost=$${summary.totalCostUsd} turnAttempts=${summary.totalTurnAttempts}`);
  for (const c of summary.cells) console.log(`  ${c.id}: ${c.grade}${c.caveats.length ? ` (${c.caveats.length} caveat${c.caveats.length > 1 ? "s" : ""})` : ""}`);
  if (summary.constraints.length > 0) {
    console.log("constraints:");
    for (const k of summary.constraints) console.log(`  - ${k}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cells = buildCells(args.withM9 || args.cell === "M9");

  if (args.plan) {
    console.log(`KPR-310 matrix plan (seed=${args.seed}, sdk=${sdkVersion()}) - NO API calls`);
    for (const cell of cells) {
      const n = noncesFor(cell.id, args.seed);
      console.log(`\n${cell.id} - ${cell.title}${cell.optional ? " [OPTIONAL]" : ""}`);
      for (const t of cell.turns) {
        console.log(`  ${t.label}: model=${t.model} resumeOf=${t.resumeOf ?? "(new)"}${t.fork ? " fork" : ""}${t.withTool ? " +tool" : ""}`);
        console.log(`      prompt: ${t.prompt(n)}`);
      }
    }
    return;
  }

  if (args.summarize) {
    const records = readAllRecords();
    if (records.length === 0) {
      console.error("no evidence found - run the matrix first");
      process.exitCode = 1;
      return;
    }
    const runId = args.run ?? latestCompleteRunId(records);
    if (runId === null) {
      console.error(`no COMPLETE run found (required cells: ${REQUIRED_CELLS.join(", ")}); pass --run <id> to force`);
      process.exitCode = 1;
      return;
    }
    const seed = records.find((r) => r.runId === runId)?.seed ?? args.seed;
    try {
      writeSummary(records, runId, seed);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
    }
    return;
  }

  mkdirSync(SCRATCH_CWD, { recursive: true });

  if (args.cell !== null) {
    // Partial run: writes .jsonl evidence, NEVER touches summary.json (spec-pinned).
    // --run <id> appends to an EXISTING run id (post-abort recovery: rerun the failed
    // cells under the aborted run's id, then --summarize --run <id> completes it).
    const cell = cells.find((c) => c.id === args.cell);
    if (!cell) {
      console.error(`unknown cell ${args.cell} - known: ${cells.map((c) => c.id).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    let runId: string;
    let seed = args.seed;
    if (args.run !== null) {
      runId = args.run;
      const prior = readAllRecords().filter((r) => r.runId === runId);
      if (prior.length > 0 && prior[0].seed !== seed) {
        seed = prior[0].seed;
        console.log(`adopting seed=${seed} from existing run ${runId} (nonce comparability)`);
      }
    } else {
      runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    }
    console.log(`KPR-310 --cell ${cell.id} run ${runId} seed=${seed} sdk=${sdkVersion()} cwd=${SCRATCH_CWD}`);
    const records = await runCell(cell, runId, seed);
    if (cell.id === "M1" && !checkM1Gate(records)) process.exitCode = 1;
    console.log(`\n--cell run complete (${records.length} turn attempts). summary.json NOT written (partial-run discipline).`);
    return;
  }

  // Full matrix: serial, M1 first (gate), M8 last (post-fault probe is final API activity).
  if (args.run !== null) {
    console.error("--run is only valid with --cell or --summarize; full-matrix runs always mint a fresh run id");
    process.exitCode = 1;
    return;
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`KPR-310 matrix run ${runId} seed=${args.seed} sdk=${sdkVersion()} cwd=${SCRATCH_CWD}`);
  console.log(`prefix: ${FIXED_SYSTEM_PROMPT.length} chars (~${Math.ceil(FIXED_SYSTEM_PROMPT.length / 4)} tokens)`);
  const allRecords: TurnRecord[] = [];
  for (const cell of cells) {
    const records = await runCell(cell, runId, args.seed);
    allRecords.push(...records);
    if (cell.id === "M1" && !checkM1Gate(records)) {
      process.exitCode = 1;
      return; // abort BEFORE M2+ burns turns; summary.json untouched (spec throw-safety)
    }
  }
  writeSummary(allRecords, runId, args.seed);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
