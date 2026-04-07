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
      state: z.enum(["blocked", "todo", "in_progress", "done", "cancelled"]).optional().describe("Filter by state"),
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
    try {
      const task = await tasks.findOne({ _id: taskId });
      if (!task) return { content: [{ type: "text" as const, text: "Task not found" }], isError: true };
      if (task.state === TaskState.CANCELLED) {
        return { content: [{ type: "text" as const, text: "Task already cancelled" }] };
      }

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
            text: JSON.stringify(
              { cancelled: taskId, unblockedTasks, planCompleted: depResult.planCompleted },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${String(err)}` }], isError: true };
    }
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
      const existingTasks = await tasks.find({ planId: input.planId });

      // Validate dependencies exist in this plan
      if (deps.length > 0) {
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
      }

      // Compute initial state
      const allStubs = existingTasks.map((t) => ({ _id: t._id, state: t.state }));
      const initialState = computeInitialState(deps, allStubs);

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
