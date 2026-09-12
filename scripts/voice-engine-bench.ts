#!/usr/bin/env node
/**
 * KPR-465 §4.2 Tier E: loopback engine bench. Operator-run on the instance
 * host, from the instance directory (HIVE_HOME) so config.ts resolves the
 * bridge token the way the worker does (env → Honeypot). The token is never
 * logged. Posts the fixed §6.1 script at the real adapter; writes a
 * content-free JSONL result file. Engine stages come from the engine's own
 * voice_diagnostic rows for the call ids this script prints.
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { realpathSync, appendFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

import {
  BENCH_SCRIPT,
  BENCH_SCRIPT_VERSION,
  SseChunkParser,
  assertTurn,
  benchResultRow,
  buildBridgeRequest,
  type BenchTurn,
} from "../src/voice/voice-bench-script.js";

export type Drill = "double-request" | "concurrent-3" | "kill-a" | "kill-b" | "kill-c";
export const DRILLS: readonly Drill[] = ["double-request", "concurrent-3", "kill-a", "kill-b", "kill-c"];
export const BARGE_IN_AFTER_FIRST_TEXT_MS = 300;
export const BARGE_IN_DURING_TOOL_WAIT_MS = 1_500;

export interface BenchOptions {
  baseUrl: string; // http://127.0.0.1:<port>
  token: string; // never logged
  agentId: string;
  arm: string;
  goal: string;
  context: string;
  workerBootId: string;
  out: (row: Record<string, unknown>) => void;
  /** Kill drills: invoked at the drilled phase; the CLI wires an operator prompt, tests inject a spy. */
  kill?: (phase: "before-first-byte" | "after-first-byte", turn: BenchTurn) => Promise<void>;
  drill?: Drill;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface TurnOutcome {
  status: number | null;
  firstTextMs: number | null;
  totalMs: number;
  text: string; // in-memory only
  finish: "stop" | "error" | "closed" | "none";
}

/**
 * Posts one turn and streams its SSE answer.
 *
 * Drill hooks (`onSent`, `onFirstText`) are awaited, not fired and forgotten: every
 * response step (each chunk's events and `end`) runs on one promise chain, so while a
 * hook is pending no later SSE event is processed, the turn does not settle, and the
 * caller cannot post the next turn. The response stream is also paused for the hook's
 * duration. What this cannot do is hold the engine: the server keeps running the turn
 * (and may finish it) while the operator is at the prompt — whether a kill lands inside
 * the engine turn is wall-clock on the live instance, not something the client controls.
 * A transport failure (`req`/`res` error) still settles the turn immediately; a hook
 * that rejects rejects the turn.
 */
export function postTurn(
  opts: BenchOptions,
  body: Record<string, unknown>,
  hooks: {
    onSent?: () => Promise<void>;
    onFirstText?: () => Promise<void>;
    closeAfterMs?: number;
    closeAfterFirstTextMs?: number;
  },
): Promise<TurnOutcome> {
  const url = new URL("/v1/chat/completions", opts.baseUrl);
  const payload = JSON.stringify(body);
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let status: number | null = null;
    let firstTextMs: number | null = null;
    let text = "";
    let finish: TurnOutcome["finish"] = "none";
    let settled = false;
    const parser = new SseChunkParser();
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ status, firstTextMs, totalMs: performance.now() - startedAt, text, finish });
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    let chain: Promise<void> = Promise.resolve();
    const step = (fn: () => void | Promise<void>) => {
      chain = chain.then(fn).catch(fail);
    };
    let response: IncomingMessage | undefined;
    let holding = false;
    const hold = async (hook: () => Promise<void>) => {
      holding = true;
      response?.pause();
      try {
        await hook();
      } finally {
        holding = false;
        response?.resume();
      }
    };
    const handleChunk = async (chunk: string) => {
      for (const ev of parser.push(chunk)) {
        if (ev.type === "text") {
          if (firstTextMs === null) {
            firstTextMs = performance.now() - startedAt;
            if (hooks.onFirstText) await hold(hooks.onFirstText);
            if (hooks.closeAfterFirstTextMs !== undefined) {
              setTimeout(() => {
                // Same guard as closeAfterMs. A response that ended before the barge-in point already resolved
                // with its honest "stop"; don't lean on Node treating a destroy() of a released keep-alive
                // request (whose socket may now carry the next turn) as a no-op.
                if (settled) return;
                finish = "closed";
                req.destroy();
                done();
              }, hooks.closeAfterFirstTextMs).unref?.();
            }
          }
          text += ev.text;
        } else if (ev.type === "done") {
          finish = ev.finishReason === "error" ? "error" : "stop";
        }
      }
    };
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.token}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        response = res;
        // An `onSent` hook still pending when the response arrives keeps it paused; its `finally` resumes it.
        // Pausing before the `data` listener is attached keeps the listener from switching the stream to flowing.
        if (holding) res.pause();
        status = res.statusCode ?? null;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => step(() => handleChunk(chunk)));
        // Chained: `end` can be emitted while the stream is paused, so it must wait behind any pending hook too.
        res.on("end", () => step(done));
        res.on("error", done);
      },
    );
    req.on("error", () => {
      if (finish === "none") finish = "closed";
      done();
    });
    const onSent = hooks.onSent;
    if (onSent) {
      let sent!: () => void;
      const flushed = new Promise<void>((r) => (sent = r));
      // First link of the chain: every response step waits for the body to flush and then for the hook.
      step(() => flushed.then(() => hold(onSent)));
      req.end(payload, () => sent());
    } else {
      req.end(payload);
    }
    if (hooks.closeAfterMs !== undefined) {
      setTimeout(() => {
        if (settled) return;
        finish = "closed";
        req.destroy();
        done();
      }, hooks.closeAfterMs).unref?.();
    }
  });
}

/** One scripted call. Returns the call id. Barge-ins are always on (script turns 5 and 7). */
export async function runBenchCall(
  opts: BenchOptions,
  callId = `bench-${opts.arm}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const runTurn = async (turn: BenchTurn, extra: { drill?: string } = {}) => {
    const turnId = randomUUID();
    messages.push({ role: "user", content: turn.text });
    const body = buildBridgeRequest({
      callId,
      agentId: opts.agentId,
      goal: opts.goal,
      context: opts.context,
      messages: [...messages],
      workerBootId: opts.workerBootId,
      turnId,
    });
    const isKill =
      opts.drill?.startsWith("kill-") &&
      ((opts.drill === "kill-c" && turn.index === 1) || (opts.drill !== "kill-c" && turn.index === 3));
    const outcome = await postTurn(opts, body, {
      closeAfterFirstTextMs: turn.bargeIn === "mid-sentence" ? BARGE_IN_AFTER_FIRST_TEXT_MS : undefined,
      closeAfterMs: turn.bargeIn === "during-tool-wait" ? BARGE_IN_DURING_TOOL_WAIT_MS : undefined,
      onSent:
        isKill && (opts.drill === "kill-a" || opts.drill === "kill-c")
          ? () => opts.kill!("before-first-byte", turn)
          : undefined,
      onFirstText: isKill && opts.drill === "kill-b" ? () => opts.kill!("after-first-byte", turn) : undefined,
    });
    if (outcome.text.length > 0) messages.push({ role: "assistant", content: outcome.text });
    // Spread: BenchResultRow is an interface (no implicit index signature), so the row must be re-shaped
    // into an object-literal type to satisfy `out`'s Record<string, unknown> parameter.
    opts.out({
      ...benchResultRow({
        callId,
        arm: opts.arm,
        turn,
        turnId,
        assertion: assertTurn(turn, outcome.text),
        clientFirstTextMs: outcome.firstTextMs,
        clientTotalMs: outcome.totalMs,
        textLength: outcome.text.length,
        status: outcome.status,
        finish: outcome.finish,
        ...(isKill ? { drill: opts.drill } : extra),
      }),
    });
    await sleep(250); // caller think-time; keeps turns strictly sequential like a real call
  };
  if (opts.drill === "double-request") {
    // V9: turn 1 and turn 2 posted without awaiting — the second must wait on the pending opening.
    await Promise.all([
      runTurn(BENCH_SCRIPT[0]!, { drill: "double-request" }),
      runTurn(BENCH_SCRIPT[1]!, { drill: "double-request" }),
    ]);
    for (const turn of BENCH_SCRIPT.slice(2)) await runTurn(turn);
    return callId;
  }
  for (const turn of BENCH_SCRIPT) await runTurn(turn);
  return callId;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * The bench is loopback-only and every request carries the bridge bearer, so a base URL
 * that is not plain `http:` to 127.0.0.1/localhost is refused. Returns an error message
 * (never echoing the raw URL), or null when the URL is acceptable.
 */
export function loopbackBaseUrlError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "--base-url is not a valid URL";
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    return `--base-url must be http://127.0.0.1:<port> or http://localhost:<port> (loopback only; the bridge bearer is sent on every request), got ${url.protocol}//${url.hostname}`;
  }
  return null;
}

/** `--calls`: a positive decimal integer, strictly (no `"8abc"`, no `"0"`, no `"1e3"`). Null when invalid. */
export function parseCallCount(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Line 1 of the `--out` file. Carries no turn and no `callId`; scripts/voice-latency-compare.ts
 * recognizes exactly this shape (`run: true`, no `callId`) and skips it.
 */
export function benchRunHeader(input: {
  arm: string;
  agent: string;
  workerBootId: string;
  startedAt: string;
  calls: number;
  drill: Drill | null;
  warmup: boolean;
}): Record<string, unknown> {
  return {
    run: true,
    script: BENCH_SCRIPT_VERSION,
    arm: input.arm,
    agent: input.agent,
    workerBootId: input.workerBootId,
    startedAt: input.startedAt,
    calls: input.calls,
    drill: input.drill,
    warmup: input.warmup,
  };
}

async function operatorKillPrompt(phase: string, turn: BenchTurn): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Note: this kill-drill instruction assumes a quiet window (Task E3) — pgrep finding wrong process is a real risk
  // if other agents are live, which is exactly why the quiet window is a precondition, not a suggestion.
  process.stderr.write(
    `\n[kill drill] phase=${phase} turn=${turn.index}. Identify the lease's CLI child NOW, e.g.\n` +
      `  pgrep -P <engine-pid> -nf claude-agent-sdk   # newest matching child of the engine\n` +
      `and kill exactly that pid (kill -9 <pid>). Press Enter when done.\n` +
      `The bench holds this turn until Enter, but the engine does not wait: the kill must land while the turn runs.\n`,
  );
  await new Promise<void>((r) => rl.question("", () => r()));
  rl.close();
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      arm: { type: "string" },
      agent: { type: "string", default: "mokie-bench" },
      calls: { type: "string", default: "8" },
      out: { type: "string" },
      "base-url": { type: "string" },
      drill: { type: "string" },
      warmup: { type: "boolean", default: false },
      goal: { type: "string", default: "KPR-465 engine bench" },
      context: { type: "string", default: "Scripted latency bench. Answer briefly." },
    },
  });
  if (!values.arm || !values.out) {
    process.stderr.write(
      "usage: voice-engine-bench --arm <label> --out <jsonl> [--agent mokie-bench] [--calls 8] [--base-url http://127.0.0.1:<port>] [--drill double-request|concurrent-3|kill-a|kill-b|kill-c] [--warmup]\n",
    );
    return 2;
  }
  if (values.drill && !DRILLS.includes(values.drill as Drill)) {
    process.stderr.write(`unknown drill ${values.drill}\n`);
    return 2;
  }
  const calls = parseCallCount(values.calls!);
  if (calls === null) {
    process.stderr.write(`--calls must be a positive integer, got "${values.calls}"\n`);
    return 2;
  }
  // Late import: config.ts loads hive.yaml/.env/Honeypot from HIVE_HOME; keep the module importable by tests without it.
  const { config } = await import("../src/config.js");
  const token = config.voice.bridgeToken;
  if (!token) {
    process.stderr.write("HIVE_VOICE_BRIDGE_TOKEN is not configured for this instance\n");
    return 2;
  }
  const baseUrl = values["base-url"] ?? `http://127.0.0.1:${config.voice.port}`;
  // Checked before anything is written or sent: the bearer never leaves the host.
  const baseUrlError = loopbackBaseUrlError(baseUrl);
  if (baseUrlError) {
    process.stderr.write(`${baseUrlError}\n`);
    return 2;
  }
  const workerBootId = randomUUID();
  writeFileSync(
    values.out,
    `${JSON.stringify(
      benchRunHeader({
        arm: values.arm,
        agent: values.agent!,
        workerBootId,
        startedAt: new Date().toISOString(),
        calls,
        drill: (values.drill as Drill | undefined) ?? null,
        warmup: values.warmup!,
      }),
    )}\n`,
  );
  const opts: BenchOptions = {
    baseUrl,
    token,
    agentId: values.agent!,
    arm: values.arm,
    goal: values.goal!,
    context: values.context!,
    workerBootId,
    out: (row) => appendFileSync(values.out!, `${JSON.stringify(row)}\n`),
    drill: values.drill as Drill | undefined,
    kill: operatorKillPrompt,
  };
  const callIds: string[] = [];
  if (values.warmup) {
    // §6.2: the first turn after a restart is a discarded warm-up — its own call id, not passed to the reader.
    const warmId = `bench-${values.arm}-warmup-${randomUUID().slice(0, 8)}`;
    await postTurn(
      opts,
      buildBridgeRequest({
        callId: warmId,
        agentId: opts.agentId,
        goal: opts.goal,
        context: opts.context,
        messages: [{ role: "user", content: BENCH_SCRIPT[0]!.text }],
        workerBootId,
        turnId: randomUUID(),
      }),
      {},
    );
    process.stderr.write(`warm-up call ${warmId} discarded\n`);
  }
  if (values.drill === "concurrent-3") {
    const ids = await Promise.all([1, 2, 3].map(() => runBenchCall({ ...opts, drill: undefined })));
    callIds.push(...ids);
  } else {
    for (let i = 0; i < calls; i += 1) callIds.push(await runBenchCall(opts));
  }
  process.stderr.write(
    `bench complete: ${callIds.length} call(s)\n${callIds.map((id) => `  --call ${id}=${values.arm}`).join("\n")}\n`,
  );
  return 0;
}

export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
