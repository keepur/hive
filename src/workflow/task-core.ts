/**
 * Vendored from dodi-workflow/packages/{task-core,fsm-persistence}.
 * Inlined here so @keepur/hive has no runtime dependency on @dodi-hq/* packages.
 *
 * Source: https://github.com/dodi-hq/dodi-workflow (task-core@0.1.1, fsm-persistence@0.1.1)
 */

// ── Task states ──────────────────────────────────────────────────────

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

// ── Task types ───────────────────────────────────────────────────────

export interface TaskAssignee {
  type: "agent" | "human";
  id: string;
  name: string;
}

export interface IWorkflowTask {
  _id: string;
  planId: string;
  title: string;
  description?: string;
  assignee: TaskAssignee;
  state: string;
  dependencies: string[];
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

// ── State transition validation ──────────────────────────────────────

const TASK_STATE_NAMES = new Set<string>([
  TaskState.BLOCKED,
  TaskState.TODO,
  TaskState.IN_PROGRESS,
  TaskState.DONE,
  TaskState.CANCELLED,
]);

export function validateTransition(fromState: string, toState: string): boolean {
  if (fromState === toState) return false;
  return TASK_STATE_NAMES.has(fromState) && TASK_STATE_NAMES.has(toState);
}

// ── Collection adapter (framework-agnostic Mongo interface) ──────────

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

// ── Dependency engine ────────────────────────────────────────────────

export function detectCycle(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (inStack.has(node)) {
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
 * Atomically unblock dependents of a task that just reached terminal state.
 * Returns newly-unblocked task IDs and whether the plan is now fully terminal.
 */
export async function resolveDependencies(
  completedTaskId: string,
  planId: string,
  tasks: ICollectionAdapter<IWorkflowTask>,
): Promise<DependencyResult> {
  const dependents = await tasks.find({
    planId,
    dependencies: completedTaskId,
    state: TaskState.BLOCKED,
  });

  const unblockedTaskIds: string[] = [];

  for (const dep of dependents) {
    const depTasks = await tasks.find({
      _id: { $in: dep.dependencies } as unknown as Record<string, unknown>,
      planId,
    });

    const allTerminal = depTasks.every((t) => isTerminal(t.state));
    if (!allTerminal) continue;

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

    if (updated && updated.state === TaskState.TODO) {
      unblockedTaskIds.push(dep._id);
    }
  }

  const allPlanTasks = await tasks.find({ planId });
  const planCompleted = allPlanTasks.length > 0 && allPlanTasks.every((t) => isTerminal(t.state));

  return { unblockedTaskIds, planCompleted };
}
