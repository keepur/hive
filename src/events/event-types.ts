import { z } from "zod";

interface EventSchema {
  description: string;
  payload: z.ZodObject<z.ZodRawShape>;
}

// ── Domains ─────────────────────────────────────────────────────────────

export const EVENT_DOMAINS = ["deals", "cases", "jobs", "leads", "system"] as const;
export type EventDomain = (typeof EVENT_DOMAINS)[number];

// ── Schemas (domain:action → schema) ────────────────────────────────────

export const EVENT_SCHEMAS: Record<string, EventSchema> = {
  // ── deals ──
  "deals:won": {
    description: "A deal was marked as won",
    payload: z.object({
      dealId: z.string(),
      dealName: z.string(),
      customerName: z.string(),
      amount: z.number().optional(),
    }),
  },
  "deals:lost": {
    description: "A deal was marked as lost",
    payload: z.object({
      dealId: z.string(),
      dealName: z.string(),
      customerName: z.string(),
      reason: z.string().optional(),
    }),
  },
  "deals:stage_changed": {
    description: "A deal moved to a new pipeline stage",
    payload: z.object({
      dealId: z.string(),
      dealName: z.string(),
      fromStage: z.string(),
      toStage: z.string(),
    }),
  },

  // ── cases ──
  "cases:opened": {
    description: "A customer case was opened",
    payload: z.object({
      caseId: z.string(),
      customerName: z.string(),
      summary: z.string(),
    }),
  },
  "cases:resolved": {
    description: "A customer case was resolved",
    payload: z.object({
      caseId: z.string(),
      customerName: z.string(),
      resolution: z.string(),
    }),
  },
  "cases:escalated": {
    description: "A customer case was escalated",
    payload: z.object({
      caseId: z.string(),
      customerName: z.string(),
      summary: z.string(),
      escalatedTo: z.string(),
    }),
  },

  // ── jobs ──
  "jobs:complete": {
    description: "A production job was completed",
    payload: z.object({
      jobId: z.string(),
      customerName: z.string(),
    }),
  },
  "jobs:schedule_changed": {
    description: "A job milestone date changed",
    payload: z.object({
      jobId: z.string(),
      customerName: z.string(),
      milestone: z.string(),
      oldDate: z.string().optional(),
      newDate: z.string(),
    }),
  },
  "jobs:blocked": {
    description: "A production job is blocked",
    payload: z.object({
      jobId: z.string(),
      customerName: z.string(),
      reason: z.string(),
    }),
  },

  // ── leads ──
  "leads:found": {
    description: "A new lead was identified",
    payload: z.object({
      source: z.string(),
      name: z.string(),
      context: z.string(),
      url: z.string().optional(),
    }),
  },
  "leads:qualified": {
    description: "A lead was qualified for outreach",
    payload: z.object({
      name: z.string(),
      context: z.string(),
      score: z.number().optional(),
    }),
  },

  // ── system ──
  "system:task_blocked": {
    description: "A task is blocked and needs attention",
    payload: z.object({
      taskId: z.string(),
      description: z.string(),
      blockedBy: z.string(),
    }),
  },
  "system:custom": {
    description: "Freeform notification — use when no specific event type fits",
    payload: z.object({
      message: z.string(),
    }),
  },
};

export type EventType = keyof typeof EVENT_SCHEMAS;

/** Extract domain from "domain:action" event type */
export function eventDomain(type: string): string {
  return type.split(":")[0];
}
