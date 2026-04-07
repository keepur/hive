# Workflow Engine Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Extract shared workflow packages from dodi_v2 and wire a workflow MCP server into Hive so agents and humans can coordinate via plans, tasks, and dependencies.

**Architecture:** Four shared packages extracted from dodi_v2 into a new `dodi-workflow` repo. Hive v1 consumes only `@dodi/workflow-core` (FSM) and `@dodi/task-core` (dependency resolution). A new `workflow-mcp-server.ts` gives agents tools to create plans, manage tasks, and track execution. Events flow through the existing event bus.

**Tech Stack:** TypeScript, MongoDB (native driver in Hive, Meteor adapter in dodi_v2), Zod validation, Vitest

**Spec:** [`docs/specs/2026-04-07-workflow-engine-design.md`](../specs/2026-04-07-workflow-engine-design.md)

**Scope:** Phase 1 (package extraction) + Phase 2 (Hive integration). Phase 3 (dodi_v2 migration) is a separate plan.

---

## File Map

### New repo: `dodi-hq/dodi-workflow`

```
packages/
  workflow-core/
    src/
      simple-fsm.ts          # SimpleFSM ported from dodi_v2, lodash replaced
      fsm.ts                 # Strict FSM ported from dodi_v2
      condition-evaluator.ts # json-rules-engine wrapper (copy, already clean)
      types.ts               # IStateful, IState, IAction, IStateTransition, IFSMState, etc.
      index.ts               # Public exports
    package.json
    tsconfig.json
  fsm-persistence/
    src/
      collection-adapter.ts  # ICollectionAdapter interface + FindOptions + result types
      index.ts
    package.json
    tsconfig.json
  task-core/
    src/
      task-states.ts         # TaskState enum
      task-types.ts          # ITask, IWorkflowPlan, IWorkflowTask interfaces
      dependency-engine.ts   # resolveDependencies + cycle detection
      task-fsm.ts            # Task-specific FSM factory (5 states)
      index.ts
    tests/
      dependency-engine.test.ts
      cycle-detection.test.ts
      task-fsm.test.ts
    package.json
    tsconfig.json
package.json               # Workspace root
tsconfig.base.json
```

### Modified in Hive (`bot-dodi/hive`)

```
src/
  config.ts                           # Add workflow.enabled feature flag
  workflow/
    workflow-mcp-server.ts            # MCP server — tools for plans/tasks
    mongodb-adapter.ts                # ICollectionAdapter for native MongoDB driver
    event-emitter.ts                  # Write workflow events to agent_events
    types.ts                          # Hive-specific types (IWorkflowPlan, IWorkflowTask)
  agents/
    agent-runner.ts                   # Register workflow server, feature flag gating
```

---

## Phase 1: Package Extraction

### Task 1: Set up dodi-workflow repo

**Files:**
- Create: `dodi-workflow/package.json`
- Create: `dodi-workflow/tsconfig.base.json`
- Create: `dodi-workflow/packages/workflow-core/package.json`
- Create: `dodi-workflow/packages/workflow-core/tsconfig.json`
- Create: `dodi-workflow/packages/fsm-persistence/package.json`
- Create: `dodi-workflow/packages/fsm-persistence/tsconfig.json`
- Create: `dodi-workflow/packages/task-core/package.json`
- Create: `dodi-workflow/packages/task-core/tsconfig.json`

- [ ] **Step 1:** Create the repo and workspace root

```bash
cd ~/github
mkdir dodi-workflow && cd dodi-workflow
git init
```

Root `package.json`:
```json
{
  "name": "dodi-workflow",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces"
  }
}
```

Root `tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

- [ ] **Step 2:** Create `packages/workflow-core/package.json`:

```json
{
  "name": "@dodi/workflow-core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "json-rules-engine": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`packages/workflow-core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3:** Create `packages/fsm-persistence/package.json` and `packages/fsm-persistence/tsconfig.json`:

`packages/fsm-persistence/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

`packages/fsm-persistence/package.json`:

```json
{
  "name": "@dodi/fsm-persistence",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 4:** Create `packages/task-core/package.json`:

```json
{
  "name": "@dodi/task-core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dodi/workflow-core": "0.1.0",
    "@dodi/fsm-persistence": "0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 5:** Verify

Run: `cd ~/github/dodi-workflow && npm install`
Expected: Workspace installs with linked local packages, no errors.

- [ ] **Step 6:** Commit

```bash
git add -A
git commit -m "feat: scaffold dodi-workflow monorepo with workspace structure"
```

---

### Task 2: Extract `@dodi/workflow-core` — types and SimpleFSM

**Files:**
- Create: `packages/workflow-core/src/types.ts`
- Create: `packages/workflow-core/src/simple-fsm.ts`
- Create: `packages/workflow-core/src/index.ts`

- [ ] **Step 1:** Create `packages/workflow-core/src/types.ts` — extracted and cleaned interfaces:

```typescript
/**
 * Minimal stateful entity constraint.
 * Replaces dodi_v2's IStatable (which pulls in Identifiable, IRequiresPermission, ITrackable).
 */
export interface IStateful {
  state: string;
}

export interface IAction {
  name: string;
  label?: string;
  system?: boolean;
}

export interface IState {
  name: string;
  order?: number;
  transitions?: IStateTransition[];
}

export interface IStateTransition {
  action: IAction;
  condition?: string | ((entity: IStateful) => boolean);
  to?: IState;
}

/**
 * Permission checker callback — typed against IStateful, not dodi_v2's IStatable.
 */
export type PermissionChecker = (
  userId: string,
  entity: IStateful,
  fromState: string,
  toState: string,
) => boolean;

// --- FSM Definition types (for DB-stored FSM definitions) ---

export interface IFSMState {
  name: string;
  label?: string;
  order?: number;
  isInitial?: boolean;
  isTerminal?: boolean;
  style?: Record<string, string | number>;
}

export interface IFSMTransition {
  fromState: string;
  toState: string;
  action: string;
  condition?: string;
  label?: string;
}

export interface IFSMAction {
  name: string;
  label?: string;
  description?: string;
  isSystem?: boolean;
  icon?: string;
}

export interface IFSMDefinition {
  code: string;
  name: string;
  fsmType: "simple" | "strict";
  states: IFSMState[];
  transitions: IFSMTransition[];
  actions: IFSMAction[];
}
```

- [ ] **Step 2:** Create `packages/workflow-core/src/simple-fsm.ts` — ported from dodi_v2, lodash replaced:

```typescript
import type { IAction, IState, IStateful, PermissionChecker } from "./types.js";

/**
 * SimpleFSM — flexible state machine allowing transitions from any state to any other.
 * Ported from dodi_v2/src/modules/core/lib/states/simple-fsm.ts.
 * Changes: IStatable→IStateful, lodash→native Array methods.
 */
export class SimpleFSM {
  states: IState[];
  permissionChecker?: PermissionChecker;

  constructor(states: IState[], permissionChecker?: PermissionChecker) {
    this.states = states;
    this.permissionChecker = permissionChecker;
  }

  changeState(entity: IStateful, toState: string, userId: string): void {
    const state = this.states.find((s) => s.name === toState);
    if (!state) throw new Error("Invalid State: " + toState);
    if (entity.state === toState) throw new Error("Cannot transition to the same state");
    if (this.permissionChecker && !this.permissionChecker(userId, entity, entity.state, toState)) {
      throw new Error("Permission denied for state transition");
    }
    entity.state = toState;
  }

  transition(entity: IStateful, action: IAction, userId: string): void {
    const from = entity.state;
    const targetState = this.states.find(
      (s) =>
        s.name.toLowerCase() === action.name.toLowerCase() ||
        s.name.toLowerCase().replace(/\s+/g, "_") === action.name.toLowerCase(),
    );
    if (!targetState || targetState.name === from) return;
    if (this.permissionChecker && !this.permissionChecker(userId, entity, from, targetState.name)) {
      throw new Error("Permission denied for state transition");
    }
    entity.state = targetState.name;
  }

  getTransitions(entity: IStateful, userId: string) {
    const from = entity.state;
    return this.states
      .filter((s) => s.name !== from)
      .map((s) => {
        if (this.permissionChecker && !this.permissionChecker(userId, entity, from, s.name)) {
          return null;
        }
        return {
          action: { name: s.name.toLowerCase().replace(/\s+/g, "_"), label: `Move to ${s.name}` },
          to: s,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }

  getTransitionsByState(stateName: string) {
    const state = this.states.find((s) => s.name === stateName);
    if (!state) return [];
    return this.states
      .filter((s) => s.name !== stateName)
      .map((s) => ({
        action: { name: s.name.toLowerCase().replace(/\s+/g, "_"), label: s.name },
        to: s,
      }));
  }
}
```

- [ ] **Step 3:** Create `packages/workflow-core/src/index.ts`:

```typescript
export { SimpleFSM } from "./simple-fsm.js";
export type {
  IStateful,
  IAction,
  IState,
  IStateTransition,
  PermissionChecker,
  IFSMState,
  IFSMTransition,
  IFSMAction,
  IFSMDefinition,
} from "./types.js";
```

- [ ] **Step 4:** Verify

Run: `cd ~/github/dodi-workflow && npm run build --workspace=packages/workflow-core`
Expected: Clean compilation, `dist/` populated with `.js` + `.d.ts` files.

- [ ] **Step 5:** Commit

```bash
git add packages/workflow-core/
git commit -m "feat(workflow-core): extract SimpleFSM and type interfaces from dodi_v2"
```

---

### Task 3: Extract `@dodi/fsm-persistence` — ICollectionAdapter

**Files:**
- Create: `packages/fsm-persistence/src/collection-adapter.ts`
- Create: `packages/fsm-persistence/src/index.ts`

- [ ] **Step 1:** Create `packages/fsm-persistence/src/collection-adapter.ts`:

```typescript
/**
 * Framework-agnostic collection adapter interface.
 * Meteor adapter wraps Mongo.Collection (cursor.fetchAsync() internally).
 * Hive adapter wraps native mongodb driver.
 */

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, 0 | 1>;
}

export interface UpdateResult {
  matchedCount: number;
  modifiedCount: number;
}

export interface DeleteResult {
  deletedCount: number;
}

export interface ICollectionAdapter<T> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>, options?: FindOptions): Promise<T[]>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: "before" | "after" },
  ): Promise<T | null>;
  insertOne(doc: T): Promise<string>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<UpdateResult>;
  deleteOne(filter: Record<string, unknown>): Promise<DeleteResult>;
}
```

- [ ] **Step 2:** Create `packages/fsm-persistence/src/index.ts`:

```typescript
export type {
  ICollectionAdapter,
  FindOptions,
  UpdateResult,
  DeleteResult,
} from "./collection-adapter.js";
```

- [ ] **Step 3:** Verify

Run: `npm run build --workspace=packages/fsm-persistence`
Expected: Clean compilation.

- [ ] **Step 4:** Commit

```bash
git add packages/fsm-persistence/
git commit -m "feat(fsm-persistence): add ICollectionAdapter interface"
```

---

### Task 4: Extract `@dodi/task-core` — states, types, FSM, dependency engine

**Files:**
- Create: `packages/task-core/src/task-states.ts`
- Create: `packages/task-core/src/task-types.ts`
- Create: `packages/task-core/src/task-fsm.ts`
- Create: `packages/task-core/src/dependency-engine.ts`
- Create: `packages/task-core/src/index.ts`

- [ ] **Step 1:** Create `packages/task-core/src/task-states.ts`:

```typescript
export enum TaskState {
  BLOCKED = "blocked",
  TODO = "todo",
  IN_PROGRESS = "in_progress",
  DONE = "done",
  CANCELLED = "cancelled",
}

export const TERMINAL_STATES: ReadonlySet<string> = new Set([TaskState.DONE, TaskState.CANCELLED]);

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}
```

- [ ] **Step 2:** Create `packages/task-core/src/task-types.ts`:

```typescript
import type { IStateful } from "@dodi/workflow-core";

export interface TaskAssignee {
  type: "agent" | "human";
  id: string;
  name: string;
}

export interface IWorkflowTask extends IStateful {
  _id: string;
  planId: string;
  title: string;
  description?: string;
  assignee: TaskAssignee;
  state: string; // TaskState values
  dependencies: string[]; // task IDs (end-to-start)
  order: number;
  completedAt?: Date;
  completedBy?: string;
  cancelledBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWorkflowPlan {
  _id: string;
  name: string;
  goal?: string;
  sourceContext?: {
    channelId?: string;
    threadId?: string;
    summary?: string;
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DependencyResult {
  unblockedTaskIds: string[];
  planCompleted: boolean;
}
```

- [ ] **Step 3:** Create `packages/task-core/src/task-fsm.ts`:

```typescript
import { SimpleFSM } from "@dodi/workflow-core";
import type { IState } from "@dodi/workflow-core";
import { TaskState } from "./task-states.js";

const TASK_STATES: IState[] = [
  { name: TaskState.BLOCKED, order: 0 },
  { name: TaskState.TODO, order: 1 },
  { name: TaskState.IN_PROGRESS, order: 2 },
  { name: TaskState.DONE, order: 3 },
  { name: TaskState.CANCELLED, order: 4 },
];

/**
 * Create a SimpleFSM for workflow tasks.
 * Simple mode: any state can transition to any other (except same-state).
 * Validation of business rules (e.g., can't go from done back to in_progress)
 * is handled at the MCP tool layer, not the FSM.
 */
export function createTaskFSM(): SimpleFSM {
  return new SimpleFSM(TASK_STATES);
}

/**
 * Validate that a state transition is allowed.
 * Returns true if the transition is valid.
 */
export function validateTransition(fromState: string, toState: string): boolean {
  if (fromState === toState) return false;
  const validStates = TASK_STATES.map((s) => s.name);
  return validStates.includes(fromState) && validStates.includes(toState);
}
```

- [ ] **Step 4:** Create `packages/task-core/src/dependency-engine.ts`:

```typescript
import type { ICollectionAdapter } from "@dodi/fsm-persistence";
import type { IWorkflowTask, DependencyResult } from "./task-types.js";
import { TaskState, isTerminal } from "./task-states.js";

/**
 * Detect cycles in a dependency graph using DFS.
 * Takes a map of tempId → dependsOn tempIds.
 * Returns the first cycle found as an array of tempIds, or null if acyclic.
 */
export function detectCycle(
  graph: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (inStack.has(node)) {
      // Found cycle — return the cycle portion of the path
      const cycleStart = path.indexOf(node);
      return path.slice(cycleStart).concat(node);
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph.get(node) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = dfs(node);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Compute initial state for a task based on its dependencies.
 * - No dependencies → todo
 * - All dependencies terminal → todo
 * - Any non-terminal dependency → blocked
 */
export function computeInitialState(
  dependencies: string[],
  allTasks: Pick<IWorkflowTask, "_id" | "state">[],
): TaskState {
  if (dependencies.length === 0) return TaskState.TODO;

  const depStates = dependencies.map((depId) => {
    const task = allTasks.find((t) => t._id === depId);
    return task?.state;
  });

  const allTerminal = depStates.every((s) => s !== undefined && isTerminal(s));
  return allTerminal ? TaskState.TODO : TaskState.BLOCKED;
}

/**
 * Process a task reaching a terminal state (done or cancelled).
 * Finds dependent tasks, atomically unblocks those whose dependencies are all terminal.
 * Returns list of unblocked task IDs and whether the plan is now complete.
 *
 * Critical differences from dodi_v2's TaskController.unblockDependents():
 * - Treats both 'done' and 'cancelled' as terminal (dodi_v2 only checks 'done')
 * - Uses atomic findOneAndUpdate with state:'blocked' filter (dodi_v2 does read-then-write)
 */
export async function resolveDependencies(
  completedTaskId: string,
  planId: string,
  tasks: ICollectionAdapter<IWorkflowTask>,
): Promise<DependencyResult> {
  // Find all tasks in this plan that depend on the completed task
  const dependents = await tasks.find({
    planId,
    dependencies: completedTaskId,
    state: TaskState.BLOCKED,
  });

  const unblockedTaskIds: string[] = [];

  for (const dep of dependents) {
    // Check if ALL of this task's dependencies are now terminal
    const depTasks = await tasks.find({
      _id: { $in: dep.dependencies } as unknown as Record<string, unknown>,
      planId,
    });

    const allTerminal = depTasks.every((t) => isTerminal(t.state));
    if (!allTerminal) continue;

    // Atomic unblock: only succeeds if task is still 'blocked'
    const updated = await tasks.findOneAndUpdate(
      { _id: dep._id, state: TaskState.BLOCKED } as unknown as Record<string, unknown>,
      {
        $set: {
          state: TaskState.TODO,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );

    // Only emit if we actually transitioned (prevents double-fire)
    if (updated && updated.state === TaskState.TODO) {
      unblockedTaskIds.push(dep._id);
    }
  }

  // Check if all plan tasks are now terminal
  const allPlanTasks = await tasks.find({ planId });
  const planCompleted = allPlanTasks.length > 0 && allPlanTasks.every((t) => isTerminal(t.state));

  return { unblockedTaskIds, planCompleted };
}
```

- [ ] **Step 5:** Create `packages/task-core/src/index.ts`:

```typescript
export { TaskState, TERMINAL_STATES, isTerminal } from "./task-states.js";
export { createTaskFSM, validateTransition } from "./task-fsm.js";
export { resolveDependencies, detectCycle, computeInitialState } from "./dependency-engine.js";
export type { IWorkflowTask, IWorkflowPlan, TaskAssignee, DependencyResult } from "./task-types.js";
```

- [ ] **Step 6:** Verify

Run: `cd ~/github/dodi-workflow && npm run build`
Expected: All three packages compile cleanly.

- [ ] **Step 7:** Commit

```bash
git add packages/task-core/
git commit -m "feat(task-core): task states, FSM, dependency engine with cycle detection"
```

---

### Task 5: Tests for extracted packages

**Files:**
- Create: `packages/task-core/tests/dependency-engine.test.ts`
- Create: `packages/task-core/tests/cycle-detection.test.ts`
- Create: `packages/task-core/tests/task-fsm.test.ts`
- Create: `packages/task-core/vitest.config.ts`

- [ ] **Step 1:** Create `packages/task-core/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 2:** Create `packages/task-core/tests/cycle-detection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectCycle } from "../src/dependency-engine.js";

describe("detectCycle", () => {
  it("returns null for acyclic graph", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    expect(detectCycle(graph)).toBeNull();
  });

  it("detects simple two-node cycle", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  it("detects cycle in larger graph", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
  });

  it("returns null for single node with no deps", () => {
    const graph = new Map([["a", []]]);
    expect(detectCycle(graph)).toBeNull();
  });

  it("handles diamond dependency (not a cycle)", () => {
    const graph = new Map([
      ["a", ["b", "c"]],
      ["b", ["d"]],
      ["c", ["d"]],
      ["d", []],
    ]);
    expect(detectCycle(graph)).toBeNull();
  });

  it("detects self-referencing node", () => {
    const graph = new Map([["a", ["a"]]]);
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
  });
});
```

- [ ] **Step 3:** Create `packages/task-core/tests/task-fsm.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createTaskFSM, validateTransition } from "../src/task-fsm.js";
import { TaskState } from "../src/task-states.js";

describe("createTaskFSM", () => {
  it("creates FSM with 5 states", () => {
    const fsm = createTaskFSM();
    expect(fsm.states).toHaveLength(5);
  });

  it("allows valid state transitions", () => {
    const fsm = createTaskFSM();
    const entity = { state: TaskState.TODO };
    fsm.changeState(entity, TaskState.IN_PROGRESS, "agent-1");
    expect(entity.state).toBe(TaskState.IN_PROGRESS);
  });

  it("rejects same-state transition", () => {
    const fsm = createTaskFSM();
    const entity = { state: TaskState.TODO };
    expect(() => fsm.changeState(entity, TaskState.TODO, "agent-1")).toThrow(
      "Cannot transition to the same state",
    );
  });

  it("rejects invalid state name", () => {
    const fsm = createTaskFSM();
    const entity = { state: TaskState.TODO };
    expect(() => fsm.changeState(entity, "INVALID", "agent-1")).toThrow("Invalid State");
  });
});

describe("validateTransition", () => {
  it("returns true for valid transitions", () => {
    expect(validateTransition(TaskState.TODO, TaskState.IN_PROGRESS)).toBe(true);
    expect(validateTransition(TaskState.BLOCKED, TaskState.TODO)).toBe(true);
    expect(validateTransition(TaskState.IN_PROGRESS, TaskState.DONE)).toBe(true);
  });

  it("returns false for same-state", () => {
    expect(validateTransition(TaskState.TODO, TaskState.TODO)).toBe(false);
  });

  it("returns false for invalid state names", () => {
    expect(validateTransition("INVALID", TaskState.TODO)).toBe(false);
  });
});
```

- [ ] **Step 4:** Create `packages/task-core/tests/dependency-engine.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeInitialState, resolveDependencies } from "../src/dependency-engine.js";
import { TaskState } from "../src/task-states.js";
import type { IWorkflowTask } from "../src/task-types.js";
import type { ICollectionAdapter } from "@dodi/fsm-persistence";

// In-memory mock adapter for testing
function mockTaskAdapter(tasks: IWorkflowTask[]): ICollectionAdapter<IWorkflowTask> {
  const store = new Map(tasks.map((t) => [t._id, { ...t }]));

  return {
    async findOne(filter: Record<string, unknown>) {
      for (const t of store.values()) {
        if (matchesFilter(t, filter)) return { ...t };
      }
      return null;
    },
    async find(filter: Record<string, unknown>) {
      return [...store.values()].filter((t) => matchesFilter(t, filter)).map((t) => ({ ...t }));
    },
    async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { returnDocument?: string }) {
      for (const [id, t] of store) {
        if (matchesFilter(t, filter)) {
          const $set = (update as any).$set ?? {};
          Object.assign(t, $set);
          store.set(id, t);
          return { ...t };
        }
      }
      return null;
    },
    async insertOne(doc: IWorkflowTask) {
      store.set(doc._id, { ...doc });
      return doc._id;
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      let matched = 0;
      let modified = 0;
      for (const [id, t] of store) {
        if (matchesFilter(t, filter)) {
          matched++;
          const $set = (update as any).$set ?? {};
          Object.assign(t, $set);
          store.set(id, t);
          modified++;
        }
      }
      return { matchedCount: matched, modifiedCount: modified };
    },
    async deleteOne() {
      return { deletedCount: 0 };
    },
  };
}

function matchesFilter(doc: any, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    if (key === "$in" || key === "$or") continue; // simplified
    if (val && typeof val === "object" && "$in" in (val as any)) {
      if (!(val as any).$in.includes(doc[key])) return false;
    } else if (Array.isArray(doc[key]) && typeof val === "string") {
      // Array field contains value (e.g., dependencies includes taskId)
      if (!doc[key].includes(val)) return false;
    } else if (doc[key] !== val) {
      return false;
    }
  }
  return true;
}

function makeTask(overrides: Partial<IWorkflowTask> & { _id: string; planId: string }): IWorkflowTask {
  return {
    title: "test",
    assignee: { type: "agent", id: "test", name: "Test" },
    state: TaskState.BLOCKED,
    dependencies: [],
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("computeInitialState", () => {
  it("returns todo when no dependencies", () => {
    expect(computeInitialState([], [])).toBe(TaskState.TODO);
  });

  it("returns todo when all deps terminal", () => {
    const tasks = [
      { _id: "a", state: TaskState.DONE },
      { _id: "b", state: TaskState.CANCELLED },
    ];
    expect(computeInitialState(["a", "b"], tasks)).toBe(TaskState.TODO);
  });

  it("returns blocked when any dep is non-terminal", () => {
    const tasks = [
      { _id: "a", state: TaskState.DONE },
      { _id: "b", state: TaskState.IN_PROGRESS },
    ];
    expect(computeInitialState(["a", "b"], tasks)).toBe(TaskState.BLOCKED);
  });
});

describe("resolveDependencies", () => {
  it("unblocks task when sole predecessor completes", async () => {
    const taskA = makeTask({ _id: "a", planId: "p1", state: TaskState.DONE, dependencies: [] });
    const taskB = makeTask({ _id: "b", planId: "p1", state: TaskState.BLOCKED, dependencies: ["a"] });
    const adapter = mockTaskAdapter([taskA, taskB]);

    const result = await resolveDependencies("a", "p1", adapter);
    expect(result.unblockedTaskIds).toEqual(["b"]);
  });

  it("does NOT unblock when one predecessor is still active", async () => {
    const taskA = makeTask({ _id: "a", planId: "p1", state: TaskState.DONE, dependencies: [] });
    const taskB = makeTask({ _id: "b", planId: "p1", state: TaskState.IN_PROGRESS, dependencies: [] });
    const taskC = makeTask({ _id: "c", planId: "p1", state: TaskState.BLOCKED, dependencies: ["a", "b"] });
    const adapter = mockTaskAdapter([taskA, taskB, taskC]);

    const result = await resolveDependencies("a", "p1", adapter);
    expect(result.unblockedTaskIds).toEqual([]);
  });

  it("treats cancelled as terminal — unblocks dependents", async () => {
    const taskA = makeTask({ _id: "a", planId: "p1", state: TaskState.CANCELLED, dependencies: [] });
    const taskB = makeTask({ _id: "b", planId: "p1", state: TaskState.BLOCKED, dependencies: ["a"] });
    const adapter = mockTaskAdapter([taskA, taskB]);

    const result = await resolveDependencies("a", "p1", adapter);
    expect(result.unblockedTaskIds).toEqual(["b"]);
  });

  it("detects plan completion when all tasks terminal", async () => {
    const taskA = makeTask({ _id: "a", planId: "p1", state: TaskState.DONE, dependencies: [] });
    const taskB = makeTask({ _id: "b", planId: "p1", state: TaskState.BLOCKED, dependencies: ["a"] });
    const adapter = mockTaskAdapter([taskA, taskB]);

    const result = await resolveDependencies("a", "p1", adapter);
    // taskB just moved to TODO, not terminal yet
    expect(result.planCompleted).toBe(false);
  });

  it("reports plan completed when last task finishes", async () => {
    const taskA = makeTask({ _id: "a", planId: "p1", state: TaskState.DONE, dependencies: [] });
    const taskB = makeTask({ _id: "b", planId: "p1", state: TaskState.DONE, dependencies: ["a"] });
    const adapter = mockTaskAdapter([taskA, taskB]);

    const result = await resolveDependencies("b", "p1", adapter);
    expect(result.planCompleted).toBe(true);
  });
});
```

- [ ] **Step 5:** Verify

Run: `cd ~/github/dodi-workflow && npm test --workspace=packages/task-core`
Expected: All tests pass.

- [ ] **Step 6:** Commit

```bash
git add packages/task-core/tests/ packages/task-core/vitest.config.ts
git commit -m "test(task-core): dependency engine, cycle detection, and task FSM tests"
```

---

### Task 6: Push dodi-workflow repo

- [ ] **Step 1:** Create the GitHub repo and push

```bash
cd ~/github/dodi-workflow
gh repo create dodi-hq/dodi-workflow --private --source=. --push
```

---

## Phase 2: Hive Integration

### Task 7: Add workflow feature flag to Hive config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1:** Add `workflow` section to config, following the `team` pattern:

In `src/config.ts`, add after the `team` config block (around line 183):

```typescript
workflow: {
  enabled: optional("WORKFLOW_ENABLED", "false") === "true",
},
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3:** Commit

```bash
git add src/config.ts
git commit -m "feat: add workflow.enabled feature flag to config"
```

---

### Task 8: Create Hive workflow types and MongoDB adapter

**Files:**
- Create: `src/workflow/types.ts`
- Create: `src/workflow/mongodb-adapter.ts`

- [ ] **Step 1:** Create `src/workflow/types.ts` — Hive-specific types that extend the shared package types:

```typescript
import type { IWorkflowTask, IWorkflowPlan, TaskAssignee } from "@dodi/task-core";

// Re-export shared types
export type { IWorkflowTask, IWorkflowPlan, TaskAssignee };

export interface WorkflowTaskComment {
  _id: string;
  taskId: string;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: Date;
}

export type PlanStatus = "active" | "completed" | "cancelled";

export function computePlanStatus(tasks: Pick<IWorkflowTask, "state">[]): PlanStatus {
  if (tasks.length === 0) return "active";

  const terminal = new Set(["done", "cancelled"]);
  const allTerminal = tasks.every((t) => terminal.has(t.state));

  if (!allTerminal) return "active";
  if (tasks.every((t) => t.state === "cancelled")) return "cancelled";
  return "completed";
}
```

- [ ] **Step 2:** Create `src/workflow/mongodb-adapter.ts` — ICollectionAdapter wrapping native MongoDB driver:

```typescript
import type { Collection, Document, Filter, UpdateFilter, FindOptions as MongoFindOptions } from "mongodb";
import type { ICollectionAdapter, FindOptions, UpdateResult, DeleteResult } from "@dodi/fsm-persistence";

/**
 * MongoDB native driver adapter implementing ICollectionAdapter.
 * Bridges @dodi/fsm-persistence's generic interface to mongodb's Collection.
 */
export class MongoDBAdapter<T extends Document> implements ICollectionAdapter<T> {
  constructor(private collection: Collection<T>) {}

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.collection.findOne(filter as Filter<T>) as Promise<T | null>;
  }

  async find(filter: Record<string, unknown>, options?: FindOptions): Promise<T[]> {
    let cursor = this.collection.find(filter as Filter<T>);
    if (options?.sort) cursor = cursor.sort(options.sort as any);
    if (options?.skip) cursor = cursor.skip(options.skip);
    if (options?.limit) cursor = cursor.limit(options.limit);
    if (options?.projection) cursor = cursor.project(options.projection);
    return cursor.toArray() as Promise<T[]>;
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: "before" | "after" },
  ): Promise<T | null> {
    const result = await this.collection.findOneAndUpdate(
      filter as Filter<T>,
      update as UpdateFilter<T>,
      { returnDocument: options?.returnDocument ?? "after" },
    );
    return result as T | null;
  }

  async insertOne(doc: T): Promise<string> {
    const result = await this.collection.insertOne(doc as any);
    return result.insertedId.toString();
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<UpdateResult> {
    const result = await this.collection.updateOne(filter as Filter<T>, update as UpdateFilter<T>);
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<DeleteResult> {
    const result = await this.collection.deleteOne(filter as Filter<T>);
    return { deletedCount: result.deletedCount };
  }
}
```

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4:** Commit

```bash
git add src/workflow/
git commit -m "feat(workflow): add types and MongoDB collection adapter"
```

---

### Task 9: Create workflow event emitter

**Files:**
- Create: `src/workflow/event-emitter.ts`

- [ ] **Step 1:** Create `src/workflow/event-emitter.ts` — writes workflow events directly to `agent_events`:

```typescript
import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("workflow-events");

interface EventDelivery {
  agentId: string;
  status: "pending";
}

interface AgentEvent {
  type: string;
  domain: string;
  payload: Record<string, unknown>;
  sourceAgentId: string;
  createdAt: Date;
  hasPending: boolean;
  deliveries: EventDelivery[];
}

/**
 * Emits workflow events by writing directly to agent_events collection.
 * Mirrors the pattern in event-bus-mcp-server.ts.
 */
export class WorkflowEventEmitter {
  private events: Collection<AgentEvent>;
  private sourceAgentId: string;
  private subscriberMap: Record<string, string[]>;

  constructor(db: Db, sourceAgentId: string, subscriberMapJson: string) {
    this.events = db.collection<AgentEvent>("agent_events");
    this.sourceAgentId = sourceAgentId;

    try {
      this.subscriberMap = JSON.parse(subscriberMapJson || "{}");
    } catch {
      this.subscriberMap = {};
    }
  }

  async emit(type: string, payload: Record<string, unknown>): Promise<string | null> {
    const domain = type.split(":")[0];
    const subscribers = (this.subscriberMap[domain] ?? []).filter((id) => id !== this.sourceAgentId);

    if (subscribers.length === 0) {
      log.debug("No subscribers for workflow event", { type, domain });
      return null;
    }

    const deliveries: EventDelivery[] = subscribers.map((agentId) => ({
      agentId,
      status: "pending" as const,
    }));

    const doc: AgentEvent = {
      type,
      domain,
      payload,
      sourceAgentId: this.sourceAgentId,
      createdAt: new Date(),
      hasPending: true,
      deliveries,
    };

    const result = await this.events.insertOne(doc as any);
    const eventId = result.insertedId.toHexString();
    log.info("Workflow event emitted", { type, eventId: `evt_${eventId.slice(-8)}`, subscribers: subscribers.length });
    return eventId;
  }
}
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3:** Commit

```bash
git add src/workflow/event-emitter.ts
git commit -m "feat(workflow): add event emitter for workflow domain events"
```

---

### Task 10: Build workflow MCP server

**Files:**
- Create: `src/workflow/workflow-mcp-server.ts`

- [ ] **Step 1:** Create the MCP server. This is the largest file — implements all workflow tools.

Create `src/workflow/workflow-mcp-server.ts`:

```typescript
#!/usr/bin/env node

/**
 * Workflow MCP Server — runs as a stdio subprocess inside each agent session.
 * Gives agents tools to create plans, manage tasks, and track execution.
 *
 * Env vars:
 *   AGENT_ID — calling agent's ID
 *   MONGODB_URI — MongoDB connection string
 *   MONGODB_DB — database name
 *   EVENT_SUBSCRIBERS — JSON map of domain → agentId[]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TaskState,
  isTerminal,
  validateTransition,
  resolveDependencies,
  detectCycle,
  computeInitialState,
} from "@dodi/task-core";
import type { IWorkflowTask, IWorkflowPlan } from "@dodi/task-core";
import { MongoDBAdapter } from "./mongodb-adapter.js";
import { WorkflowEventEmitter } from "./event-emitter.js";
import { computePlanStatus } from "./types.js";
import type { WorkflowTaskComment } from "./types.js";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "";
const EVENT_SUBSCRIBERS = process.env.EVENT_SUBSCRIBERS ?? "{}";

if (!AGENT_ID || !MONGODB_URI || !MONGODB_DB) {
  process.stderr.write("workflow-mcp-server: AGENT_ID, MONGODB_URI, MONGODB_DB required\n");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);

const plans = new MongoDBAdapter<IWorkflowPlan & { _id: string }>(db.collection("workflow_plans"));
const tasks = new MongoDBAdapter<IWorkflowTask & { _id: string }>(db.collection("workflow_tasks"));
const comments = db.collection<WorkflowTaskComment>("workflow_task_comments");
const emitter = new WorkflowEventEmitter(db, AGENT_ID, EVENT_SUBSCRIBERS);

// Ensure indexes
const tasksCol = db.collection("workflow_tasks");
await Promise.all([
  tasksCol.createIndex({ planId: 1 }),
  tasksCol.createIndex({ "assignee.id": 1 }),
  tasksCol.createIndex({ state: 1 }),
  tasksCol.createIndex({ planId: 1, state: 1 }),
  db.collection("workflow_plans").createIndex({ createdBy: 1 }),
  db.collection("workflow_plans").createIndex({ createdAt: -1 }),
  comments.createIndex({ taskId: 1 }),
]);

const server = new McpServer({ name: "workflow", version: "0.1.0" });

// --- Tool: create_plan ---
server.registerTool(
  "create_plan",
  {
    title: "Create Plan",
    description:
      "Create a plan with tasks and dependencies. Tasks reference each other by tempId. Returns the plan with real task IDs.",
    inputSchema: {
      name: z.string().describe("Plan name"),
      goal: z.string().optional().describe("What success looks like"),
      sourceContext: z
        .object({
          channelId: z.string().optional(),
          threadId: z.string().optional(),
          summary: z.string().optional(),
        })
        .optional()
        .describe("Where this plan came from"),
      tasks: z
        .array(
          z.object({
            tempId: z.string().describe("Temporary ID for dependency references"),
            title: z.string().describe("Task title"),
            description: z.string().optional().describe("Task details"),
            assignee: z.object({
              type: z.enum(["agent", "human"]).describe("Assignee type"),
              id: z.string().describe("Agent ID or contact ID"),
              name: z.string().describe("Display name"),
            }),
            dependsOn: z.array(z.string()).optional().describe("tempIds of predecessor tasks"),
          }),
        )
        .min(1)
        .describe("Tasks to create"),
    },
  },
  async (input) => {
    try {
      // Build dependency graph for cycle detection
      const graph = new Map<string, string[]>();
      for (const t of input.tasks) {
        graph.set(t.tempId, t.dependsOn ?? []);
      }
      const cycle = detectCycle(graph);
      if (cycle) {
        return {
          content: [{ type: "text" as const, text: `Dependency cycle detected: ${cycle.join(" → ")}` }],
          isError: true,
        };
      }

      // Create plan
      const now = new Date();
      const planId = randomUUID();
      const plan: IWorkflowPlan & { _id: string } = {
        _id: planId,
        name: input.name,
        goal: input.goal,
        sourceContext: input.sourceContext,
        createdBy: AGENT_ID,
        createdAt: now,
        updatedAt: now,
      };
      await plans.insertOne(plan);

      // Resolve tempIds → real IDs
      const idMap = new Map<string, string>();
      for (const t of input.tasks) {
        idMap.set(t.tempId, randomUUID());
      }

      // Create task docs
      const taskDocs: (IWorkflowTask & { _id: string })[] = [];
      for (let i = 0; i < input.tasks.length; i++) {
        const t = input.tasks[i];
        const realId = idMap.get(t.tempId)!;
        const deps = (t.dependsOn ?? []).map((d) => idMap.get(d)!);

        // At plan creation, no tasks are terminal yet, so:
        // - tasks with no deps start as TODO
        // - tasks with any deps start as BLOCKED
        const initialState = deps.length === 0 ? TaskState.TODO : TaskState.BLOCKED;

        taskDocs.push({
          _id: realId,
          planId,
          title: t.title,
          description: t.description,
          assignee: t.assignee,
          state: initialState,
          dependencies: deps,
          order: i,
          createdAt: now,
          updatedAt: now,
        });
      }

      // Insert all tasks
      for (const doc of taskDocs) {
        await tasks.insertOne(doc);
      }

      // Emit plan_created event
      await emitter.emit("workflow:plan_created", {
        planId,
        name: input.name,
        taskCount: taskDocs.length,
        createdBy: AGENT_ID,
      });

      const result = {
        plan: { _id: planId, name: input.name, goal: input.goal },
        tasks: taskDocs.map((t) => ({
          _id: t._id,
          title: t.title,
          state: t.state,
          assignee: t.assignee,
          dependencies: t.dependencies,
        })),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to create plan: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: get_plan ---
server.registerTool(
  "get_plan",
  {
    title: "Get Plan",
    description: "Get a plan with all its tasks and computed status.",
    inputSchema: {
      planId: z.string().describe("Plan ID"),
    },
  },
  async ({ planId }) => {
    try {
      const plan = await plans.findOne({ _id: planId });
      if (!plan) return { content: [{ type: "text" as const, text: "Plan not found" }], isError: true };

      const planTasks = await tasks.find({ planId }, { sort: { order: 1 } });
      const status = computePlanStatus(planTasks);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...plan, status, tasks: planTasks }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: list_plans ---
server.registerTool(
  "list_plans",
  {
    title: "List Plans",
    description: "List plans with optional filters.",
    inputSchema: {
      status: z.enum(["active", "completed", "cancelled"]).optional().describe("Filter by computed status"),
      createdBy: z.string().optional().describe("Filter by creator agent ID"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results"),
    },
  },
  async (input) => {
    try {
      const filter: Record<string, unknown> = {};
      if (input.createdBy) filter.createdBy = input.createdBy;

      const allPlans = await plans.find(filter, { sort: { createdAt: -1 }, limit: input.limit });

      // Compute status for each plan
      const results = [];
      for (const plan of allPlans) {
        const planTasks = await tasks.find({ planId: plan._id });
        const status = computePlanStatus(planTasks);
        if (input.status && status !== input.status) continue;
        results.push({ ...plan, status, taskCount: planTasks.length });
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: get_my_tasks ---
server.registerTool(
  "get_my_tasks",
  {
    title: "Get My Tasks",
    description: "Get tasks assigned to you, optionally filtered by state.",
    inputSchema: {
      state: z
        .enum(["blocked", "todo", "in_progress", "done", "cancelled"])
        .optional()
        .describe("Filter by state"),
    },
  },
  async (input) => {
    try {
      const filter: Record<string, unknown> = { "assignee.id": AGENT_ID };
      if (input.state) filter.state = input.state;

      const myTasks = await tasks.find(filter, { sort: { updatedAt: -1 } });
      return { content: [{ type: "text" as const, text: JSON.stringify(myTasks, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: update_task_state ---
server.registerTool(
  "update_task_state",
  {
    title: "Update Task State",
    description:
      "Advance a task's state. Triggers dependency resolution on terminal states (done/cancelled). Returns updated task and any newly unblocked tasks.",
    inputSchema: {
      taskId: z.string().describe("Task ID"),
      state: z.enum(["todo", "in_progress", "done", "cancelled"]).describe("New state"),
    },
  },
  async ({ taskId, state: newState }) => {
    try {
      const task = await tasks.findOne({ _id: taskId });
      if (!task) return { content: [{ type: "text" as const, text: "Task not found" }], isError: true };

      // Authorization: must be assignee, or any agent can update human-assigned tasks
      if (task.assignee.type === "agent" && task.assignee.id !== AGENT_ID) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: task is assigned to another agent" }],
          isError: true,
        };
      }

      if (!validateTransition(task.state, newState)) {
        return {
          content: [{ type: "text" as const, text: `Invalid transition: ${task.state} → ${newState}` }],
          isError: true,
        };
      }

      const updateFields: Record<string, unknown> = {
        state: newState,
        updatedAt: new Date(),
      };
      if (newState === TaskState.DONE) {
        updateFields.completedAt = new Date();
        updateFields.completedBy = AGENT_ID;
      }
      if (newState === TaskState.CANCELLED) {
        updateFields.cancelledBy = AGENT_ID;
      }

      await tasks.updateOne({ _id: taskId }, { $set: updateFields });

      // Emit state change event
      if (newState === TaskState.DONE) {
        await emitter.emit("workflow:task_completed", {
          planId: task.planId,
          taskId,
          title: task.title,
          assignee: task.assignee,
          completedBy: AGENT_ID,
        });
      }
      if (newState === TaskState.CANCELLED) {
        await emitter.emit("workflow:task_cancelled", {
          planId: task.planId,
          taskId,
          title: task.title,
          assignee: task.assignee,
          cancelledBy: AGENT_ID,
        });
      }

      // Dependency resolution on terminal states
      const unblockedTasks: Array<{ _id: string; title: string; assignee: unknown }> = [];
      let planCompleted = false;

      if (isTerminal(newState)) {
        const depResult = await resolveDependencies(taskId, task.planId, tasks);
        planCompleted = depResult.planCompleted;

        for (const unblockedId of depResult.unblockedTaskIds) {
          const unblocked = await tasks.findOne({ _id: unblockedId });
          if (unblocked) {
            unblockedTasks.push({ _id: unblocked._id, title: unblocked.title, assignee: unblocked.assignee });
            await emitter.emit("workflow:task_unblocked", {
              planId: task.planId,
              taskId: unblockedId,
              title: unblocked.title,
              assignee: unblocked.assignee,
            });
          }
        }

        if (planCompleted) {
          const plan = await plans.findOne({ _id: task.planId });
          const allTasks = await tasks.find({ planId: task.planId });
          const completedCount = allTasks.filter((t) => t.state === TaskState.DONE).length;
          const cancelledCount = allTasks.filter((t) => t.state === TaskState.CANCELLED).length;
          await emitter.emit("workflow:plan_completed", {
            planId: task.planId,
            name: plan?.name ?? "",
            taskCount: allTasks.length,
            completedCount,
            cancelledCount,
          });
        }
      }

      const result = {
        task: { _id: taskId, state: newState, title: task.title },
        unblockedTasks,
        planCompleted,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: cancel_task ---
server.registerTool(
  "cancel_task",
  {
    title: "Cancel Task",
    description: "Cancel a task. Unblocks dependents (cancelled is terminal).",
    inputSchema: {
      taskId: z.string().describe("Task ID"),
    },
  },
  async ({ taskId }) => {
    // Delegate to update_task_state logic
    const task = await tasks.findOne({ _id: taskId });
    if (!task) return { content: [{ type: "text" as const, text: "Task not found" }], isError: true };
    if (task.state === TaskState.CANCELLED) {
      return { content: [{ type: "text" as const, text: "Task already cancelled" }] };
    }

    // Use the update_task_state handler directly isn't possible via MCP,
    // so we duplicate the core logic here. In practice, cancel is just update_task_state with state=cancelled.
    const updateFields: Record<string, unknown> = {
      state: TaskState.CANCELLED,
      cancelledBy: AGENT_ID,
      updatedAt: new Date(),
    };
    await tasks.updateOne({ _id: taskId }, { $set: updateFields });

    await emitter.emit("workflow:task_cancelled", {
      planId: task.planId,
      taskId,
      title: task.title,
      assignee: task.assignee,
      cancelledBy: AGENT_ID,
    });

    const depResult = await resolveDependencies(taskId, task.planId, tasks);
    const unblockedTasks: Array<{ _id: string; title: string }> = [];
    for (const id of depResult.unblockedTaskIds) {
      const t = await tasks.findOne({ _id: id });
      if (t) {
        unblockedTasks.push({ _id: t._id, title: t.title });
        await emitter.emit("workflow:task_unblocked", {
          planId: task.planId,
          taskId: id,
          title: t.title,
          assignee: t.assignee,
        });
      }
    }

    if (depResult.planCompleted) {
      const plan = await plans.findOne({ _id: task.planId });
      const allTasks = await tasks.find({ planId: task.planId });
      await emitter.emit("workflow:plan_completed", {
        planId: task.planId,
        name: plan?.name ?? "",
        taskCount: allTasks.length,
        completedCount: allTasks.filter((t) => t.state === TaskState.DONE).length,
        cancelledCount: allTasks.filter((t) => t.state === TaskState.CANCELLED).length,
      });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ cancelled: taskId, unblockedTasks, planCompleted: depResult.planCompleted }, null, 2),
        },
      ],
    };
  },
);

// --- Tool: add_task ---
server.registerTool(
  "add_task",
  {
    title: "Add Task",
    description: "Add a task to an existing plan.",
    inputSchema: {
      planId: z.string().describe("Plan ID"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task details"),
      assignee: z.object({
        type: z.enum(["agent", "human"]),
        id: z.string(),
        name: z.string(),
      }),
      dependsOn: z.array(z.string()).optional().describe("Existing task IDs this task depends on"),
    },
  },
  async (input) => {
    try {
      const plan = await plans.findOne({ _id: input.planId });
      if (!plan) return { content: [{ type: "text" as const, text: "Plan not found" }], isError: true };

      const deps = input.dependsOn ?? [];

      // Validate dependencies exist in this plan
      if (deps.length > 0) {
        const existingTasks = await tasks.find({ planId: input.planId });
        const existingIds = new Set(existingTasks.map((t) => t._id));
        for (const d of deps) {
          if (!existingIds.has(d)) {
            return { content: [{ type: "text" as const, text: `Dependency ${d} not found in plan` }], isError: true };
          }
        }

        // Cycle detection: build graph of existing deps + new task
        const newId = "NEW_TASK";
        const graph = new Map<string, string[]>();
        for (const t of existingTasks) {
          graph.set(t._id, t.dependencies);
        }
        graph.set(newId, deps);
        const cycle = detectCycle(graph);
        if (cycle) {
          return {
            content: [{ type: "text" as const, text: `Adding this task would create a cycle: ${cycle.join(" → ")}` }],
            isError: true,
          };
        }

        // Compute initial state
        const allStubs = existingTasks.map((t) => ({ _id: t._id, state: t.state }));
        const initialState = computeInitialState(deps, allStubs);

        const existingCount = existingTasks.length;
        const taskId = randomUUID();
        const now = new Date();
        const doc: IWorkflowTask & { _id: string } = {
          _id: taskId,
          planId: input.planId,
          title: input.title,
          description: input.description,
          assignee: input.assignee,
          state: initialState,
          dependencies: deps,
          order: existingCount,
          createdAt: now,
          updatedAt: now,
        };
        await tasks.insertOne(doc);

        return { content: [{ type: "text" as const, text: JSON.stringify(doc, null, 2) }] };
      }

      // No deps case
      const existingTasks = await tasks.find({ planId: input.planId });
      const taskId = randomUUID();
      const now = new Date();
      const doc: IWorkflowTask & { _id: string } = {
        _id: taskId,
        planId: input.planId,
        title: input.title,
        description: input.description,
        assignee: input.assignee,
        state: TaskState.TODO,
        dependencies: [],
        order: existingTasks.length,
        createdAt: now,
        updatedAt: now,
      };
      await tasks.insertOne(doc);

      return { content: [{ type: "text" as const, text: JSON.stringify(doc, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: add_comment ---
server.registerTool(
  "add_comment",
  {
    title: "Add Comment",
    description: "Add a status update or note to a task.",
    inputSchema: {
      taskId: z.string().describe("Task ID"),
      text: z.string().describe("Comment text"),
    },
  },
  async ({ taskId, text }) => {
    try {
      const task = await tasks.findOne({ _id: taskId });
      if (!task) return { content: [{ type: "text" as const, text: "Task not found" }], isError: true };

      const comment: WorkflowTaskComment = {
        _id: randomUUID(),
        taskId,
        text,
        authorId: AGENT_ID,
        authorName: AGENT_ID, // Agent ID as name for now
        createdAt: new Date(),
      };
      await comments.insertOne(comment as any);

      return { content: [{ type: "text" as const, text: JSON.stringify(comment, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
  },
);

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3:** Commit

```bash
git add src/workflow/workflow-mcp-server.ts
git commit -m "feat(workflow): add workflow MCP server with plan/task/dependency tools"
```

---

### Task 11: Wire workflow server into agent-runner

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify: `src/tools/server-catalog.ts`

- [ ] **Step 1:** Add the workflow server to `buildAllServerConfigs()`, guarded by feature flag (matching the `team` server pattern). Find the section where MCP servers are registered (around line 536 where the `team` server is added) and add after it:

```typescript
// Workflow — plan/task management
if (config.workflow.enabled) {
  servers["workflow"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/workflow/workflow-mcp-server.js")],
    env: {
      AGENT_ID: this.agentConfig.id,
      MONGODB_URI: config.mongo.uri,
      MONGODB_DB: config.mongo.dbName,
      EVENT_SUBSCRIBERS: this.eventSubscribersJson,
    },
  };
}
```

- [ ] **Step 2:** Add workflow to `filterCoreServers()`. Find the block where `team` is conditionally added to `coreSet` (around line 599) and add after it:

```typescript
if (config.workflow.enabled) {
  coreSet.add("workflow");
}
```

- [ ] **Step 3:** Add workflow entry to `SERVER_CATALOG` in `src/tools/server-catalog.ts`. Find the `"event-bus"` entry and add after it:

```typescript
workflow: {
  description: "Plan and task management — create plans, assign tasks, track dependencies",
  usage: "Coordinating multi-step work across agents and humans",
},
```

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: No errors.

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 5:** Commit

```bash
git add src/agents/agent-runner.ts src/tools/server-catalog.ts
git commit -m "feat(workflow): wire workflow MCP server into agent-runner with feature flag"
```

---

### Task 12: Integration tests

**Files:**
- Create: `src/workflow/workflow-mcp-server.test.ts`

- [ ] **Step 1:** Create basic integration tests for the core logic (dependency engine + event emission work correctly when wired together). The full MCP server is harder to test in isolation, so focus on the business logic:

```typescript
import { describe, it, expect } from "vitest";
import { computePlanStatus } from "./types.js";

describe("computePlanStatus", () => {
  it("returns active when tasks are in progress", () => {
    expect(computePlanStatus([{ state: "todo" }, { state: "in_progress" }])).toBe("active");
  });

  it("returns completed when all terminal with at least one done", () => {
    expect(computePlanStatus([{ state: "done" }, { state: "cancelled" }])).toBe("completed");
  });

  it("returns cancelled when all cancelled", () => {
    expect(computePlanStatus([{ state: "cancelled" }, { state: "cancelled" }])).toBe("cancelled");
  });

  it("returns active for empty task list", () => {
    expect(computePlanStatus([])).toBe("active");
  });

  it("returns active when mix of terminal and non-terminal", () => {
    expect(computePlanStatus([{ state: "done" }, { state: "blocked" }])).toBe("active");
  });
});
```

- [ ] **Step 2:** Verify

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 3:** Run full quality check

Run: `npm run check`
Expected: Typecheck + lint + format + test all pass.

- [ ] **Step 4:** Commit

```bash
git add src/workflow/workflow-mcp-server.test.ts
git commit -m "test(workflow): add plan status and integration tests"
```

---

## Dependencies

Before executing this plan, install `@dodi/workflow-core`, `@dodi/fsm-persistence`, and `@dodi/task-core` in the Hive repo. After Task 6 (push dodi-workflow repo), run:

```bash
cd ~/github/hive
npm install ~/github/dodi-workflow/packages/workflow-core
npm install ~/github/dodi-workflow/packages/fsm-persistence
npm install ~/github/dodi-workflow/packages/task-core
```

Or use `file:` references in `package.json` during development, switching to published npm packages when ready.
