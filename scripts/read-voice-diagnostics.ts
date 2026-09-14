#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  assertBoundedInput,
  MAX_VOICE_DIAGNOSTIC_BYTES,
  parseVoiceDiagnosticJsonl,
  reduceVoiceDiagnostics,
  VoiceDiagnosticInputError,
} from "../src/voice/voice-diagnostic-reader.js";

async function readBoundedStream(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    assertBoundedInput(bytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new VoiceDiagnosticInputError(`input is not a file: ${path}`);
    assertBoundedInput(info.size);
    return await readBoundedStream(handle.createReadStream({ autoClose: false }));
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        input: { type: "string" },
        "call-id": { type: "string" },
      },
    });
    if (!values.input || !values["call-id"]) {
      throw new VoiceDiagnosticInputError("usage: read-voice-diagnostics --input <path|-> --call-id <id>");
    }
    const input = values.input === "-" ? await readBoundedStream(process.stdin) : await readBoundedFile(values.input);
    const parsed = parseVoiceDiagnosticJsonl(input, values["call-id"]);
    const report = reduceVoiceDiagnostics(parsed, values["call-id"]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.complete ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`read-voice-diagnostics: ${message}\n`);
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

export { MAX_VOICE_DIAGNOSTIC_BYTES };
