type Level = "debug" | "info" | "warn" | "error";

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

export function createLogger(component: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", component, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", component, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", component, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", component, msg, data),
  };
}
