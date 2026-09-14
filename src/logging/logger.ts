import type { Writable } from "node:stream";

export type Level = "debug" | "info" | "warn" | "error";
export type LogWriteResult = "acknowledged" | "filtered" | "failed" | "overflow";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function emit(level: Level, component: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...data,
  };

  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

export function createTrackedLogSink(out: Writable) {
  const pending = new Set<(result: LogWriteResult) => void>();
  let sinkErrors = 0;

  const onError = () => {
    sinkErrors += 1;
    for (const settle of [...pending]) settle("failed");
  };
  out.on("error", onError);

  return {
    write(line: string, callback: (result: LogWriteResult) => void): void {
      const notify = (result: LogWriteResult) => {
        try {
          callback(result);
        } catch {}
      };
      if (pending.size >= 256) {
        notify("overflow");
        return;
      }
      if (out.destroyed || out.errored || !out.writable) {
        notify("failed");
        return;
      }

      let settled = false;
      const settle = (result: LogWriteResult) => {
        if (settled) return;
        settled = true;
        pending.delete(settle);
        notify(result);
      };
      pending.add(settle);
      try {
        out.write(line, (error?: Error | null) => settle(error ? "failed" : "acknowledged"));
      } catch {
        settle("failed");
      }
    },
    snapshot: () => ({ pending: pending.size, sinkErrors }),
    dispose(): void {
      for (const settle of [...pending]) settle("failed");
      out.off("error", onError);
    },
  };
}

const trackedSinks = new WeakMap<Writable, ReturnType<typeof createTrackedLogSink>>();

function trackedSink(out: Writable) {
  let sink = trackedSinks.get(out);
  if (!sink) {
    sink = createTrackedLogSink(out);
    trackedSinks.set(out, sink);
  }
  return sink;
}

function emitTracked(
  level: Level,
  component: string,
  msg: string,
  data: Record<string, unknown> | undefined,
  callback: (result: LogWriteResult) => void,
): void {
  const notify = (result: LogWriteResult) => {
    try {
      callback(result);
    } catch {}
  };
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
    notify("filtered");
    return;
  }
  try {
    const entry = { ts: new Date().toISOString(), level, component, msg, ...data };
    const out = level === "error" ? process.stderr : process.stdout;
    trackedSink(out).write(JSON.stringify(entry) + "\n", notify);
  } catch {
    notify("failed");
  }
}

export function createLogger(component: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", component, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", component, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", component, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", component, msg, data),
    writeTracked: (
      level: Level,
      msg: string,
      data: Record<string, unknown> | undefined,
      callback: (result: LogWriteResult) => void,
    ) => emitTracked(level, component, msg, data, callback),
    trackedSinkSnapshot: () => ({
      sinkErrors: trackedSink(process.stdout).snapshot().sinkErrors + trackedSink(process.stderr).snapshot().sinkErrors,
    }),
  };
}
