import { existsSync, statSync } from "node:fs";
import { normalize, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type TrackerConfig =
  | { type: "linear"; project: string }
  | { type: "github"; repo: string }
  | { type: "clickup"; list: string };

export interface Workspace {
  name: string;
  path: string;
  tracker: TrackerConfig;
  primary?: boolean;
}

export interface SoftwareEngineerConfig {
  workshop: string;
  workspaces: Workspace[];
}

// ── Validation ─────────────────────────────────────────────────────────────

const VALID_TRACKER_TYPES = new Set(["linear", "github", "clickup"]);

export function validateConfig(raw: unknown): SoftwareEngineerConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("software-engineer archetypeConfig must be an object");
  }
  const obj = raw as Record<string, unknown>;

  // workshop — required, absolute, exists, directory
  if (typeof obj.workshop !== "string" || !obj.workshop.startsWith("/")) {
    throw new Error("workshop must be an absolute path");
  }
  const workshop = normalize(obj.workshop);
  assertDirectory(workshop, "workshop");

  // workspaces — optional array, may be empty
  const rawWs = obj.workspaces ?? [];
  if (!Array.isArray(rawWs)) {
    throw new Error("workspaces must be an array");
  }

  const seenNames = new Set<string>();
  const workspaces: Workspace[] = rawWs.map((w, i) => {
    if (!w || typeof w !== "object") {
      throw new Error(`workspaces[${i}]: must be an object`);
    }
    const ws = w as Record<string, unknown>;

    // name — required, unique
    if (typeof ws.name !== "string" || ws.name.length === 0) {
      throw new Error(`workspaces[${i}]: name is required`);
    }
    if (seenNames.has(ws.name)) {
      throw new Error(`workspaces[${i}]: duplicate workspace name "${ws.name}"`);
    }
    seenNames.add(ws.name);

    // path — required, absolute, exists, directory, inside workshop
    if (typeof ws.path !== "string" || !ws.path.startsWith("/")) {
      throw new Error(`workspaces[${i}] (${ws.name}): path must be an absolute path`);
    }
    const wsPath = normalize(ws.path);
    assertDirectory(wsPath, `workspaces[${i}] (${ws.name})`);

    const resolvedWs = resolve(wsPath);
    const resolvedWorkshop = resolve(workshop);
    if (!resolvedWs.startsWith(resolvedWorkshop + "/")) {
      throw new Error(`workspaces[${i}] (${ws.name}): path must be inside workshop (${workshop}), got ${wsPath}`);
    }

    // tracker — required
    if (!ws.tracker || typeof ws.tracker !== "object") {
      throw new Error(`workspaces[${i}] (${ws.name}): tracker is required`);
    }
    const tracker = ws.tracker as Record<string, unknown>;
    if (typeof tracker.type !== "string" || !VALID_TRACKER_TYPES.has(tracker.type)) {
      throw new Error(
        `workspaces[${i}] (${ws.name}): tracker.type must be one of: ${[...VALID_TRACKER_TYPES].join(", ")}`,
      );
    }
    validateTrackerFields(tracker, i, ws.name as string);

    return {
      name: ws.name as string,
      path: wsPath,
      tracker: tracker as unknown as TrackerConfig,
      ...(ws.primary === true ? { primary: true } : {}),
    };
  });

  return { workshop, workspaces };
}

function assertDirectory(absPath: string, label: string): void {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    throw new Error(`${label}: path does not exist: ${absPath}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${label}: path is not a directory: ${absPath}`);
  }
}

function validateTrackerFields(tracker: Record<string, unknown>, i: number, name: string): void {
  switch (tracker.type) {
    case "linear":
      if (typeof tracker.project !== "string" || tracker.project.length === 0) {
        throw new Error(`workspaces[${i}] (${name}): linear tracker requires project`);
      }
      break;
    case "github":
      if (typeof tracker.repo !== "string" || tracker.repo.length === 0) {
        throw new Error(`workspaces[${i}] (${name}): github tracker requires repo`);
      }
      break;
    case "clickup":
      if (typeof tracker.list !== "string" || tracker.list.length === 0) {
        throw new Error(`workspaces[${i}] (${name}): clickup tracker requires list`);
      }
      break;
  }
}
