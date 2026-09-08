import { z } from "zod";

export const idSchema = z.string().regex(/^[a-z0-9-]{1,100}$/);
const label = (max: number) => z.string().trim().min(1).max(max);
export const destinationSchema = z
  .object({
    kind: z.literal("slack"),
    channelId: z.string().regex(/^[CDG][A-Z0-9]{8,31}$/),
    threadTs: z
      .string()
      .max(100)
      .regex(/^\d{10,}\.\d{6}$/)
      .optional(),
  })
  .strict();
export const deadlineSchema = z
  .object({
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "duplicate_weekday")
      .transform((days) => [...days].sort()),
    timezone: z
      .string()
      .max(100)
      .refine((zone) => {
        if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone)) return false;
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
          return true;
        } catch {
          return false;
        }
      }, "invalid_timezone"),
  })
  .strict();
export const registrationSchema = z
  .object({
    _id: idSchema,
    deliverable: label(200),
    producerAgentId: label(100),
    deadline: deadlineSchema,
    destination: destinationSchema,
    noticeDestination: destinationSchema,
    createdBy: label(100),
  })
  .strict();
export type Registration = z.infer<typeof registrationSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export type Deadline = z.infer<typeof deadlineSchema>;
export const admissionSchema = z
  .object({
    occurrenceId: z.string().max(150),
    dueAt: z.date(),
    intentId: z.string().max(180),
    claimToken: z.string().uuid(),
    ownerBootId: z.string().uuid(),
  })
  .strict();
export type Admission = z.infer<typeof admissionSchema>;
export const obligationSchema = registrationSchema
  .extend({
    activeFrom: z.date(),
    createdAt: z.date(),
    scanThrough: z.date(),
    deactivatedAt: z.date().optional(),
    deactivationReason: label(300).optional(),
    deliveryAdmission: admissionSchema.optional(),
  })
  .strict();
export type Obligation = z.infer<typeof obligationSchema>;
export const reasonSchema = z.enum([
  "authoritative_refusal",
  "rate_limited",
  "unconfirmed_response",
  "interrupted_attempt",
  "identity_unverified",
  "storage_unavailable",
  "evidence_integrity",
  "content_invalid",
  "unavailable",
]);
export const attemptSchema = z
  .object({
    intentId: z.string().max(180),
    state: z.enum(["pending", "sending", "acknowledged", "rejected", "unknown"]),
    claimToken: z.string().uuid().optional(),
    ownerBootId: z.string().uuid().optional(),
    startedAt: z.date().optional(),
    acknowledgedAt: z.date().optional(),
    providerMessageTs: z.string().min(1).max(100).optional(),
    reason: reasonSchema.optional(),
    retryAt: z.date().optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.state !== "pending" && (!attempt.claimToken || !attempt.ownerBootId)) {
      ctx.addIssue({ code: "custom", message: "missing_attempt_identity" });
    }
    if (attempt.state === "acknowledged" && (!attempt.acknowledgedAt || !attempt.providerMessageTs)) {
      ctx.addIssue({ code: "custom", message: "missing_acknowledgement" });
    }
  });
export type Attempt = z.infer<typeof attemptSchema>;
export const acknowledgementSchema = z
  .object({
    receiptId: z.string().max(180),
    providerMessageTs: z.string().min(1).max(100),
    acknowledgedAt: z.date(),
    timestamp: z.date(),
    receiptWriteState: z.enum(["pending", "persisted", "expired_unresolved"]),
  })
  .strict();
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
export const occurrenceSchema = z
  .object({
    _id: z.string().max(150),
    obligationId: idSchema,
    producerAgentId: label(100),
    dueAt: z.date(),
    windowStart: z.date(),
    definition: registrationSchema,
    activeFrom: z.date(),
    revision: z.number().int().nonnegative(),
    cancelled: z.boolean(),
    delivery: attemptSchema,
    acknowledgement: acknowledgementSchema.optional(),
    notice: attemptSchema.optional(),
    evaluation: z.enum([
      "pending",
      "on_time",
      "late",
      "no_confirmed_delivery",
      "evidence_incomplete",
      "integrity_error",
    ]),
    evaluatedAt: z.date().optional(),
    checkAt: z.date().nullable(),
    repairAt: z.date().nullable(),
  })
  .strict();
export type Occurrence = z.infer<typeof occurrenceSchema>;
export const receiptSchema = z
  .object({
    recordKind: z.literal("delivery_receipt"),
    receiptId: z.string().max(180),
    obligationId: idSchema,
    dueAt: z.date(),
    producerAgentId: label(100),
    destination: destinationSchema,
    providerMessageTs: z.string().min(1).max(100),
    acknowledgedAt: z.date(),
    timestamp: z.date(),
    schemaVersion: z.literal(1),
  })
  .strict();
export type DeliveryReceiptRecord = z.infer<typeof receiptSchema>;
export const deliveryInputSchema = z
  .object({
    obligationId: idSchema,
    dueAt: z.string().datetime({ offset: false }),
    text: z
      .string()
      .min(1)
      .max(3900)
      .refine((text) => text.trim().length > 0),
  })
  .strict();
export const discoveryInputSchema = z
  .object({
    section: z.enum(["definitions", "overdue"]).default("definitions"),
    cursor: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export interface DeliveryCapability {
  discover(agentId: string, input: unknown): Promise<unknown>;
  deliver(agentId: string, input: unknown): Promise<unknown>;
}
export class ObligationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ObligationError";
  }
}
export function fail(code: string): never {
  throw new ObligationError(code);
}
export function parseStored<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    return fail("evidence_integrity");
  }
}
export function occurrenceId(id: string, dueAt: Date): string {
  return id + "/" + dueAt.toISOString();
}
export function definitionOf(o: Obligation): Registration {
  return {
    _id: o._id,
    deliverable: o.deliverable,
    producerAgentId: o.producerAgentId,
    deadline: o.deadline,
    destination: o.destination,
    noticeDestination: o.noticeDestination,
    createdBy: o.createdBy,
  };
}
export function cancelledAt(o: Obligation, dueAt: Date): boolean {
  return o.deactivatedAt !== undefined && dueAt > o.deactivatedAt;
}
export function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const x = a as Record<string, unknown>,
      y = b as Record<string, unknown>;
    const keys = Object.keys(x)
      .filter((k) => x[k] !== undefined)
      .sort();
    return (
      same(
        keys,
        Object.keys(y)
          .filter((k) => y[k] !== undefined)
          .sort(),
      ) && keys.every((k) => same(x[k], y[k]))
    );
  }
  return a === b;
}
