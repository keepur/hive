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
