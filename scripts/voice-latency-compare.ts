#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertBoundedInput, VoiceDiagnosticInputError } from "../src/voice/voice-diagnostic-reader.js";
import {
  compareVoiceLatency,
  parseEngineLog,
  DEFAULT_RESAMPLES,
  DEFAULT_SEED,
  type BenchResultRow,
  type ComparePair,
} from "../src/voice/voice-latency-compare.js";

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new VoiceDiagnosticInputError(`input is not a file: ${path}`);
    assertBoundedInput(info.size);
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function splitPair(raw: string, flag: string): [string, string] {
  const i = raw.indexOf("=");
  if (i <= 0 || i === raw.length - 1) throw new VoiceDiagnosticInputError(`${flag} expects <a>=<b>, got "${raw}"`);
  return [raw.slice(0, i), raw.slice(i + 1)];
}

function parseBenchResults(text: string): BenchResultRow[] {
  const rows: BenchResultRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v.callId !== "string" || typeof v.turnId !== "string" || typeof v.arm !== "string") {
      throw new VoiceDiagnosticInputError("bench result row missing callId/turnId/arm");
    }
    rows.push({
      callId: v.callId,
      arm: v.arm,
      turnIndex: Number(v.turnIndex),
      turnId: v.turnId,
      expectsTool: v.expectsTool === true,
      keywordPass: typeof v.keywordPass === "boolean" ? v.keywordPass : null,
      clientFirstTextMs: typeof v.clientFirstTextMs === "number" ? v.clientFirstTextMs : null,
      textLength: typeof v.textLength === "number" ? v.textLength : 0,
      status: typeof v.status === "number" ? v.status : null,
    });
  }
  return rows;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        input: { type: "string", multiple: true },
        call: { type: "string", multiple: true },
        pair: { type: "string", multiple: true },
        "engine-log": { type: "string" },
        "bench-results": { type: "string" },
        seed: { type: "string" },
        resamples: { type: "string" },
      },
    });
    if (!values.input?.length || !values.call?.length) {
      throw new VoiceDiagnosticInputError(
        "usage: voice-latency-compare --input <jsonl> [--input ...] --call <callId>=<armLabel> [--call ...] [--pair <treatment>=<base>] [--engine-log <jsonl>] [--bench-results <jsonl>] [--seed n] [--resamples n]",
      );
    }
    const texts = await Promise.all(values.input.map(readBoundedFile));
    const jsonl = texts.join("\n");
    assertBoundedInput(Buffer.byteLength(jsonl));
    const calls = values.call.map((raw) => {
      const [callId, arm] = splitPair(raw, "--call");
      return { callId, arm, jsonl };
    });
    const pairs: ComparePair[] = (values.pair ?? []).map((raw) => {
      const [treatment, base] = splitPair(raw, "--pair");
      return { treatment, base };
    });
    const callIds = new Set(calls.map((c) => c.callId));
    const engineLog = values["engine-log"]
      ? parseEngineLog(await readBoundedFile(values["engine-log"]), callIds).rows
      : undefined;
    const benchResults = values["bench-results"]
      ? parseBenchResults(await readBoundedFile(values["bench-results"]))
      : undefined;
    const seed = values.seed === undefined ? DEFAULT_SEED : Number.parseInt(values.seed, 10);
    const resamples = values.resamples === undefined ? DEFAULT_RESAMPLES : Number.parseInt(values.resamples, 10);
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(resamples) || resamples < 1) {
      throw new VoiceDiagnosticInputError("--seed and --resamples must be integers (resamples ≥ 1)");
    }
    const report = compareVoiceLatency({ calls, pairs, engineLog, benchResults, seed, resamples });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`voice-latency-compare: ${message}\n`);
    return 2;
  }
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
