/**
 * Workflow MCP Server — plan/task management with dependency resolution.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Tool handlers close over
 * the shared engine Db plus the runner-supplied subscriber map (used by the
 * embedded WorkflowEventEmitter).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";
import { randomUUID } from "node:crypto";
import {
  TaskState,
  isTerminal,
  validateTransition,
  resolveDependencies,
  detectCycle,
  computeInitialState,
} from "./task-core.js";
import type { IWorkflowTask, IWorkflowPlan } from "./task-core.js";
import { MongoDBAdapter } from "./mongodb-adapter.js";
import { WorkflowEventEmitter } from "./event-emitter.js";
import { computePlanStatus } from "./types.js";
import type { WorkflowTaskComment } from "./types.js";

export interface WorkflowToolDeps {
  db: Db;
  agentId: string;
  /**
   * JSON-encoded `Record<string, string[]>` mapping event domain → subscriber
   * agent ids. Constructor-stable on AgentRunner — reused across turns.
   */
  eventSubscribersJson: string;
}

export function buildWorkflowTools(deps: WorkflowToolDeps) {
  const { db, agentId, eventSubscribersJson } = deps;
  const plans = new MongoDBAdapter<IWorkflowPlan & { _id: string }>(db.collection("workflow_plans"));
  const tasks = new MongoDBAdapter<IWorkflowTask & { _id: string }>(db.collection("workflow_tasks"));
  const comments = db.collection<WorkflowTaskComment>("workflow_task_comments");
  const emitter = new WorkflowEventEmitter(db, agentId, eventSubscribersJson);

  let indexInit: Promise<unknown[]> | null = null;
  function ensureIndexes(): Promise<unknown[]> {
    if (!indexInit) {
      const tasksCol = db.collection("workflow_tasks");
      indexInit = Promise.all([
        tasksCol.createIndex({ planId: 1 }),
        tasksCol.createIndex({ "assignee.id": 1 }),
        tasksCol.createIndex({ state: 1 }),
        tasksCol.createIndex({ planId: 1, state: 1 }),
        db.collection("workflow_plans").createIndex({ createdBy: 1 }),
        db.collection("workflow_plans").createIndex({ createdAt: -1 }),
        comments.createIndex({ taskId: 1 }),
      ]).catch(() => []);
    }
    return indexInit;
  }

  return [
    tool(
      "create_plan",
      "Create a plan with tasks and dependencies. Tasks reference each other by tempId. Returns the plan with real task IDs.",
      {
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
      async (input) => {
        try {
          await ensureIndexes();
          const graph = new Map<string, string[]>();
          for (const t of input.tasks) {
            graph.set(t.tempId, t.dependsOn ?? []);
          }
          const cycle = detectCycle(graph);
          if (cycle) {
            return {
              isError: true,
              content: [{ type: "text", text: `Dependency cycle detected: ${cycle.join(" → ")}` }],
            };
          }

          const now = new Date();
          const planId = randomUUID();
          const plan: IWorkflowPlan & { _id: string } = {
            _id: planId,
            name: input.name,
            goal: input.goal,
            sourceContext: input.sourceContext,
            createdBy: agentId,
            createdAt: now,
            updatedAt: now,
          };
          await plans.insertOne(plan);

          const idMap = new Map<string, string>();
          for (const t of input.tasks) {
            idMap.set(t.tempId, randomUUID());
          }

          const taskDocs: (IWorkflowTask & { _id: string })[] = [];
          for (let i = 0; i < input.tasks.length; i++) {
            const t = input.tasks[i]!;
            const realId = idMap.get(t.tempId)!;
            const deps = (t.dependsOn ?? []).map((d) => idMap.get(d)!);

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

          for (const doc of taskDocs) {
            await tasks.insertOne(doc);
          }

          await emitter.emit("workflow:plan_created", {
            planId,
            name: input.name,
            taskCount: taskDocs.length,
            createdBy: agentId,
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

          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed to create plan: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "get_plan",
      "Get a plan with all its tasks and computed status.",
      {
        planId: z.string().describe("Plan ID"),
      },
      async ({ planId }) => {
        try {
          const plan = await plans.findOne({ _id: planId });
          if (!plan) return { isError: true, content: [{ type: "text", text: "Plan not found" }] };

          const planTasks = await tasks.find({ planId }, { sort: { order: 1 } });
          const status = computePlanStatus(planTasks);

          return {
            content: [{ type: "text", text: JSON.stringify({ ...plan, status, tasks: planTasks }, null, 2) }],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "list_plans",
      "List plans with optional filters.",
      {
        status: z.enum(["active", "completed", "cancelled"]).optional().describe("Filter by computed status"),
        createdBy: z.string().optional().describe("Filter by creator agent ID"),
        limit: z.number().min(1).max(100).optional().describe("Max results"),
      },
      async (input) => {
        try {
          const filter: Record<string, unknown> = {};
          if (input.createdBy) filter.createdBy = input.createdBy;

          const allPlans = await plans.find(filter, { sort: { createdAt: -1 }, limit: input.limit ?? 20 });

          const results = [];
          for (const plan of allPlans) {
            const planTasks = await tasks.find({ planId: plan._id });
            const status = computePlanStatus(planTasks);
            if (input.status && status !== input.status) continue;
            results.push({ ...plan, status, taskCount: planTasks.length });
          }

          return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "get_my_tasks",
      "Get tasks assigned to you, optionally filtered by state.",
      {
        state: z.enum(["blocked", "todo", "in_progress", "done", "cancelled"]).optional().describe("Filter by state"),
      },
      async (input) => {
        try {
          const filter: Record<string, unknown> = { "assignee.id": agentId };
          if (input.state) filter.state = input.state;

          const myTasks = await tasks.find(filter, { sort: { updatedAt: -1 } });
          return { content: [{ type: "text", text: JSON.stringify(myTasks, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "update_task_state",
      "Advance a task's state. Triggers dependency resolution on terminal states (done/cancelled). Returns updated task and any newly unblocked tasks.",
      {
        taskId: z.string().describe("Task ID"),
        state: z.enum(["todo", "in_progress", "done", "cancelled"]).describe("New state"),
      },
      async ({ taskId, state: newState }) => {
        try {
          const task = await tasks.findOne({ _id: taskId });
          if (!task) return { isError: true, content: [{ type: "text", text: "Task not found" }] };

          if (task.assignee.type === "agent" && task.assignee.id !== agentId) {
            return {
              isError: true,
              content: [{ type: "text", text: "Permission denied: task is assigned to another agent" }],
            };
          }

          if (isTerminal(task.state)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Cannot transition from terminal state: ${task.state}` }],
            };
          }

          if (!validateTransition(task.state, newState)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Invalid transition: ${task.state} → ${newState}` }],
            };
          }

          const updateFields: Record<string, unknown> = {
            state: newState,
            updatedAt: new Date(),
          };
          if (newState === TaskState.DONE) {
            updateFields.completedAt = new Date();
            updateFields.completedBy = agentId;
          }
          if (newState === TaskState.CANCELLED) {
            updateFields.cancelledBy = agentId;
          }

          await tasks.updateOne({ _id: taskId }, { $set: updateFields });

          if (newState === TaskState.DONE) {
            await emitter.emit("workflow:task_completed", {
              planId: task.planId,
              taskId,
              title: task.title,
              assignee: task.assignee,
              completedBy: agentId,
            });
          }
          if (newState === TaskState.CANCELLED) {
            await emitter.emit("workflow:task_cancelled", {
              planId: task.planId,
              taskId,
              title: task.title,
              assignee: task.assignee,
              cancelledBy: agentId,
            });
          }

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
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "cancel_task",
      "Cancel a task. Unblocks dependents (cancelled is terminal).",
      {
        taskId: z.string().describe("Task ID"),
      },
      async ({ taskId }) => {
        try {
          const task = await tasks.findOne({ _id: taskId });
          if (!task) return { isError: true, content: [{ type: "text", text: "Task not found" }] };
          if (isTerminal(task.state)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Cannot cancel task in terminal state: ${task.state}` }],
            };
          }

          const updateFields: Record<string, unknown> = {
            state: TaskState.CANCELLED,
            cancelledBy: agentId,
            updatedAt: new Date(),
          };
          await tasks.updateOne({ _id: taskId }, { $set: updateFields });

          await emitter.emit("workflow:task_cancelled", {
            planId: task.planId,
            taskId,
            title: task.title,
            assignee: task.assignee,
            cancelledBy: agentId,
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
                type: "text",
                text: JSON.stringify(
                  { cancelled: taskId, unblockedTasks, planCompleted: depResult.planCompleted },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "add_task",
      "Add a task to an existing plan.",
      {
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
      async (input) => {
        try {
          const plan = await plans.findOne({ _id: input.planId });
          if (!plan) return { isError: true, content: [{ type: "text", text: "Plan not found" }] };

          const deps = input.dependsOn ?? [];
          const existingTasks = await tasks.find({ planId: input.planId });

          if (deps.length > 0) {
            const existingIds = new Set(existingTasks.map((t) => t._id));
            for (const d of deps) {
              if (!existingIds.has(d)) {
                return {
                  isError: true,
                  content: [{ type: "text", text: `Dependency ${d} not found in plan` }],
                };
              }
            }

            const newId = "NEW_TASK";
            const graph = new Map<string, string[]>();
            for (const t of existingTasks) {
              graph.set(t._id, t.dependencies);
            }
            graph.set(newId, deps);
            const cycle = detectCycle(graph);
            if (cycle) {
              return {
                isError: true,
                content: [{ type: "text", text: `Adding this task would create a cycle: ${cycle.join(" → ")}` }],
              };
            }
          }

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

          return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "add_comment",
      "Add a status update or note to a task.",
      {
        taskId: z.string().describe("Task ID"),
        text: z.string().describe("Comment text"),
      },
      async ({ taskId, text }) => {
        try {
          const task = await tasks.findOne({ _id: taskId });
          if (!task) return { isError: true, content: [{ type: "text", text: "Task not found" }] };

          const comment: WorkflowTaskComment = {
            _id: randomUUID(),
            taskId,
            text,
            authorId: agentId,
            authorName: agentId,
            createdAt: new Date(),
          };
          await comments.insertOne(comment as unknown as Parameters<typeof comments.insertOne>[0]);

          return { content: [{ type: "text", text: JSON.stringify(comment, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `Failed: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createWorkflowMcpServer(deps: WorkflowToolDeps) {
  return createSdkMcpServer({
    name: "workflow",
    version: "0.1.0",
    tools: buildWorkflowTools(deps),
  });
}

// Stdio shim for the publish-ready bundle path.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await (async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { MongoClient } = await import("mongodb");

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

    const tools = buildWorkflowTools({
      db,
      agentId: AGENT_ID,
      eventSubscribersJson: EVENT_SUBSCRIBERS,
    });

    const server = new McpServer({ name: "workflow", version: "0.1.0" });
    for (const t of tools) {
      const def = t as unknown as {
        name: string;
        description: string;
        inputSchema: Record<string, z.ZodTypeAny>;
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      };
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: def.inputSchema },
        def.handler as never,
      );
    }

    const cleanup = (): void => {
      void client.close();
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
