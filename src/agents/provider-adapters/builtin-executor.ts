/**
 * KPR-348 (spec §D5): builtin executor — Task 2 authors the six tools.
 * This chunk-1 stub pins the construction/lifecycle contract the bridge
 * compiles against; execute() is unreachable until Task 2 flips the
 * inventory (claude-builtin entries are still {kind:"unavailable"}).
 */
import type { HiveToolSchemaEntry } from "./tool-transport.js";

export const EXECUTOR_BACKED_BUILTIN_NAMES: ReadonlySet<string> = new Set([]); // Task 2: the six names
export const BUILTIN_TOOL_DEFINITIONS: HiveToolSchemaEntry[] = []; // Task 2 authors

export class BuiltinExecutor {
  constructor(private readonly opts: { cwd: string; signal: AbortSignal }) {}
  async execute(name: string, _input: unknown): Promise<string> {
    return `Tool execution failed (${name}): builtin executor not yet implemented`;
  }
  killAll(): void {}
}
