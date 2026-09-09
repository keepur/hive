/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNALED } from "./model-catalog-export.js";
import {
  addNotificationStatus,
  emptyNotificationStatus,
  notificationNote,
  notificationStatusProjection,
  readNotificationStatus,
} from "./model-catalog-notification-status.js";
import {
  makePreparation,
  validDelivery,
  type ChangeDelivery,
  type NoticeBinding,
  type NoticeRoute,
} from "./model-catalog-notification.js";
import { validChange } from "./model-catalog-outbox.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";

const CHANGES = "agent_model_catalog_changes";
const NOW = new Date("2026-09-08T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * MINUTE);
const ROUTE: NoticeRoute = {
  agentId: "chief",
  agentName: "Chief",
  homeBase: "catalog-alerts",
  adapterId: "slack",
  channelId: "C123ABC",
};

function pending(overrides: Partial<ChangeDelivery> = {}): ChangeDelivery {
  return { state: "pending", attempts: 0, nextAttemptAt: at(-5), ...overrides };
}

function change(id: string, provider = "codex", delivery: ChangeDelivery = pending()): CatalogChangeDoc {
  return {
    _id: id,
    provider,
    revision: 1,
    snapshotId: `snapshot-${id}`,
    createdAt: at(-120),
    source: provider === "claude" || provider === "grok" || provider === "codex" ? "discovery" : "manual",
    updatedBy: "status-test",
    modelCount: 1,
    bootstrap: false,
    added: ["new-model"],
    removed: ["old-model"],
    delivery,
  };
}

function preparing(id: string): CatalogChangeDoc {
  return change(id, "codex", {
    state: "claimed",
    attempts: 1,
    nextAttemptAt: at(-5),
    version: 1,
    lastAttemptAt: at(-10),
    claim: {
      token: `token-${id}`,
      owner: "notifier-a",
      startedAt: at(-10),
      leaseExpiresAt: at(110),
      stage: "preparing",
    },
  });
}

function sending(id: string, intentStartedAt = at(-2)): CatalogChangeDoc {
  const row = preparing(id);
  const preparation = makePreparation(row, ROUTE, "Reviewed.", at(-5));
  row.delivery = {
    ...row.delivery,
    preparation,
    claim: {
      ...row.delivery.claim!,
      stage: "sending",
      sendIntent: {
        preparationId: preparation.id,
        startedAt: intentStartedAt,
        previouslyUncertain: false,
      },
    },
  };
  return row;
}

function delivered(
  id: string,
  options: { acknowledgedAt?: Date; uncertainSend?: boolean; diagnosticReason?: "recipient-changed" | "storage" } = {},
): CatalogChangeDoc {
  const row = change(id);
  const preparation = makePreparation(row, ROUTE, "Reviewed.", at(-15));
  const binding: NoticeBinding = preparation.binding;
  row.delivery = {
    state: "delivered",
    attempts: 2,
    nextAttemptAt: at(-5),
    version: 4,
    lastAttemptAt: at(-10),
    preparation,
    receipt: {
      preparationId: preparation.id,
      binding,
      channelId: binding.channelId,
      messageTs: "1788868500.000001",
      acknowledgedAt: options.acknowledgedAt ?? at(-5),
    },
    ...(options.uncertainSend === undefined ? {} : { uncertainSend: options.uncertainSend }),
    ...(options.diagnosticReason ? { diagnostic: { reason: options.diagnosticReason, at: at(-6) } } : {}),
  };
  return row;
}

describe("catalog notification status aggregation", () => {
  it.each([
    { name: "crash recovery", row: delivered("delivered-after-crash", { uncertainSend: true }) },
    {
      name: "uncertain rebinding",
      row: delivered("delivered-after-uncertain-rebinding", {
        uncertainSend: true,
        diagnosticReason: "recipient-changed",
      }),
    },
  ])("retains possible repetition beside a terminal acknowledgment after $name", ({ row }) => {
    const status = emptyNotificationStatus(row.provider);
    addNotificationStatus(status, row, NOW.getTime());

    expect(status).toMatchObject({
      pending: 0,
      claimed: 0,
      prepared: 0,
      uncertain: 1,
      invalid: 0,
      acknowledgedAt: at(-5).getTime(),
      timingTrouble: false,
    });
    const note = notificationNote(status, NOW.getTime());
    expect(note).toContain("possibly repeated 1");
    expect(note).toContain("CoS processed; Slack accepted 2026-09-08T11:55:00.000Z");
    expect(note).not.toContain("operator read");
    expect(note).not.toContain("assignment approved");
  });

  it("aggregates unresolved states, latest safe reason, retry/lease time and malformed delivered storage", () => {
    const status = emptyNotificationStatus("codex");
    const oldest = change("oldest", "codex", pending({ diagnostic: { reason: "turn-failed", at: at(-30) } }));
    oldest.createdAt = at(-240);
    const inProgress = sending("in-progress");
    inProgress.createdAt = at(-180);
    inProgress.delivery.diagnostic = { reason: "delivery-unconfirmed", at: at(-10) };
    const blocked = change(
      "blocked",
      "codex",
      pending({
        retryBlocked: true,
        diagnostic: { reason: "retry-deadline-unrepresentable", at: at(-5) },
      }),
    );
    const malformedDelivered = delivered("malformed-delivered") as any;
    malformedDelivered.delivery.nextAttemptAt = "invalid";

    for (const row of [oldest, inProgress, blocked, malformedDelivered]) {
      addNotificationStatus(status, row, NOW.getTime());
    }

    expect(status).toMatchObject({
      pending: 3,
      claimed: 1,
      prepared: 2,
      uncertain: 1,
      blocked: 1,
      invalid: 1,
      oldest: { id: "oldest", at: at(-240).getTime() },
      nextAt: at(-5).getTime(),
      reason: { code: "retry-deadline-unrepresentable", at: at(-5).getTime() },
      timingTrouble: true,
    });
    expect(status.acknowledgedAt).toBeUndefined();
    const note = notificationNote(status, NOW.getTime());
    expect(note).toContain("notifications pending 3, in progress 1, prepared 2");
    expect(note).toContain('oldest "oldest"; age 240m');
    expect(note).toContain("next retry/lease expiry 2026-09-08T11:55:00.000Z");
    expect(note).toContain("reason retry-deadline-unrepresentable");
    expect(note).toContain("timing unavailable/clock-inconsistent");
    expect(note).not.toContain("Slack accepted");
  });

  it("bounds and escapes provider/change data and never renders an unknown diagnostic value", () => {
    const provider = `<@U123>${"provider".repeat(80)}`;
    const row = change(`${"change".repeat(80)}<script>`, provider) as any;
    row.delivery.diagnostic = { reason: "test-secret reason", at: at(-1) };
    const status = emptyNotificationStatus(provider);
    addNotificationStatus(status, row, NOW.getTime());

    const note = notificationNote(status, NOW.getTime());
    expect(note).toContain("[shortened; sha256");
    expect(note).toContain("\\u003c");
    expect(note).not.toContain("<@U123>");
    expect(note).not.toContain("test-secret reason");
    expect(note).toContain("reason invalid-state");
    expect(note.length).toBeLessThan(700);
  });

  it("streams retained history into one row per provider with the exact projection", async () => {
    const find = vi.fn();
    const collection = vi.fn();
    const rows = Array.from({ length: 500 }, (_, index) => delivered(`delivered-${index}`));
    const cursor = {
      toArray: vi.fn(() => {
        throw new Error("status must stream");
      }),
      async *[Symbol.asyncIterator]() {
        for (const row of rows) yield row;
      },
    };
    find.mockReturnValue(cursor);
    collection.mockReturnValue({ find });
    const report = await readNotificationStatus({ collection } as unknown as Db, NOW.getTime());

    expect(report).toEqual({
      kind: "available",
      rows: [
        expect.objectContaining({
          provider: "codex",
          pending: 0,
          claimed: 0,
          acknowledgedAt: at(-5).getTime(),
        }),
      ],
    });
    expect(collection).toHaveBeenCalledOnce();
    expect(collection).toHaveBeenCalledWith(CHANGES);
    expect(find).toHaveBeenCalledWith({ provider: { $ne: "gemini" } }, { projection: notificationStatusProjection });
    expect(cursor.toArray).not.toHaveBeenCalled();
  });

  it("reports cursor failures as unavailable without trying writes or indexes", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("forbidden diagnostic mutation");
    });
    const db = {
      collection: vi.fn(() => ({
        find: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error("test-secret read failure");
              },
            };
          },
        }),
        createIndex: forbidden,
        updateOne: forbidden,
        insertOne: forbidden,
      })),
    } as unknown as Db;

    await expect(readNotificationStatus(db, NOW.getTime())).resolves.toEqual({ kind: "unavailable" });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("depends only on Mongo types and the pure notification validation contract", () => {
    const source = readFileSync(join(import.meta.dirname, "model-catalog-notification-status.ts"), "utf8");
    expect(source).not.toMatch(
      /model-catalog-(?:store|scanner|notifier|discovery)|\.\.\/config|provider-adapter|agent-sdk/,
    );
    expect(source).not.toMatch(/\.toArray\s*\(|createIndex\s*\(|insertOne\s*\(|updateOne\s*\(|deleteOne\s*\(/);
  });
});

let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;

beforeAll(async () => {
  mongo = await startStandaloneMongo();
}, 30_000);

afterAll(async () => {
  await mongo?.close();
}, 30_000);

beforeEach(async () => {
  expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/);
  await mongo.db.dropDatabase();
}, 30_000);

describe("catalog notification status projection on standalone Mongo", () => {
  it("preserves mutable validation parity, optional presence and malformed parents without loading text or arrays", async () => {
    const initial = change("valid-initial-absent-version");
    const claimed = preparing("valid-claimed");
    const futureIntent = sending("valid-future-send-intent", at(30));
    const terminal = delivered("valid-delivered");
    const crashTerminal = delivered("valid-delivered-after-crash", { uncertainSend: true });
    const reboundTerminal = delivered("valid-delivered-after-rebinding", {
      uncertainSend: true,
      diagnosticReason: "recipient-changed",
    });
    const blocked = change(
      "valid-blocked",
      "codex",
      pending({
        retryBlocked: true,
        diagnostic: { reason: "retry-deadline-unrepresentable", at: at(-1) },
      }),
    );
    const validRows = [initial, claimed, futureIntent, terminal, crashTerminal, reboundTerminal, blocked];

    const malformedDelivered = delivered("malformed-delivered-next-at") as any;
    malformedDelivered.delivery.nextAttemptAt = "invalid";
    const pendingReceipt = change("pending-receipt") as any;
    pendingReceipt.delivery.receipt = terminal.delivery.receipt;
    const strayClaim = change("pending-stray-claim") as any;
    strayClaim.delivery.claim = claimed.delivery.claim;
    const missingIntent = sending("sending-missing-intent") as any;
    delete missingIntent.delivery.claim.sendIntent;
    const mismatchedIntent = sending("sending-mismatched-intent") as any;
    mismatchedIntent.delivery.claim.sendIntent.preparationId = "other-preparation";
    const malformedIntent = sending("sending-malformed-intent") as any;
    malformedIntent.delivery.claim.sendIntent = [];
    const malformedDiagnostic = change("malformed-diagnostic") as any;
    malformedDiagnostic.delivery.diagnostic = { reason: "test-secret", at: at(-1) };
    const malformedLastAttempt = change("malformed-last-attempt") as any;
    malformedLastAttempt.delivery.lastAttemptAt = "invalid";
    const nonBooleanUncertainty = change("nonboolean-uncertainty") as any;
    nonBooleanUncertainty.delivery.uncertainSend = 0;

    const falseyValues: unknown[] = [null, false, 0, "", [], undefined];
    const optionalFields = [
      "version",
      "lastAttemptAt",
      "preparation",
      "claim",
      "receipt",
      "diagnostic",
      "uncertainSend",
      "retryBlocked",
    ] as const;
    const falseyRows = optionalFields.flatMap((field) =>
      falseyValues.map((value, index) => {
        const row = change(`falsey-${field}-${index}`) as any;
        row.delivery[field] = value;
        return row;
      }),
    );

    const corruptedText = sending("corrupted-preparation-text") as any;
    corruptedText.delivery.preparation.text = "";
    const corruptedDigest = sending("corrupted-preparation-digest") as any;
    corruptedDigest.delivery.preparation.id = "wrong-digest";
    corruptedDigest.delivery.claim.sendIntent.preparationId = "wrong-digest";

    const parentRows: Record<string, unknown>[] = [
      { _id: "missing-delivery", provider: "codex", createdAt: at(-1) },
      ...[null, false, 0, "", []].map((delivery, index) => ({
        _id: `scalar-delivery-${index}`,
        provider: "codex",
        createdAt: at(-1),
        delivery,
      })),
      { _id: "gemini-excluded", provider: "gemini", createdAt: at(-1), delivery: pending() },
    ];

    const fixtures: Record<string, unknown>[] = [
      ...validRows,
      malformedDelivered,
      pendingReceipt,
      strayClaim,
      missingIntent,
      mismatchedIntent,
      malformedIntent,
      malformedDiagnostic,
      malformedLastAttempt,
      nonBooleanUncertainty,
      ...falseyRows,
      corruptedText,
      corruptedDigest,
      ...parentRows,
    ];
    await mongo.db.collection(CHANGES).insertMany(fixtures, JOURNALED);

    const full = await mongo.db
      .collection(CHANGES)
      .find({ provider: { $ne: "gemini" } })
      .sort({ _id: 1 })
      .toArray();
    const projected = await mongo.db
      .collection(CHANGES)
      .find({ provider: { $ne: "gemini" } }, { projection: notificationStatusProjection })
      .sort({ _id: 1 })
      .toArray();
    const fullById = new Map(full.map((row) => [String(row._id), row]));
    const projectedById = new Map(projected.map((row) => [String(row._id), row]));

    expect(projected).toHaveLength(fixtures.length - 1);
    expect(projectedById.has("gemini-excluded")).toBe(false);
    for (const [id, fullRow] of fullById) {
      const projectedRow = projectedById.get(id);
      expect(projectedRow, id).toBeDefined();
      expect(validDelivery(projectedRow?.delivery), id).toBe(validDelivery(fullRow.delivery));
      expect(projectedRow).not.toHaveProperty("added");
      expect(projectedRow).not.toHaveProperty("removed");
      expect(projectedRow).not.toHaveProperty("revision");
      if (
        projectedRow?.delivery &&
        typeof projectedRow.delivery === "object" &&
        !Array.isArray(projectedRow.delivery)
      ) {
        const delivery = projectedRow.delivery as Record<string, unknown>;
        if (delivery.preparation && typeof delivery.preparation === "object" && !Array.isArray(delivery.preparation)) {
          expect(delivery.preparation, id).not.toHaveProperty("text");
        }
      }
    }

    for (const row of validRows) {
      expect(validChange(fullById.get(row._id) as CatalogChangeDoc), row._id).toBe(true);
      expect(validDelivery(projectedById.get(row._id)?.delivery), row._id).toBe(true);
    }
    for (const id of ["corrupted-preparation-text", "corrupted-preparation-digest"]) {
      const fullRow = fullById.get(id) as unknown as CatalogChangeDoc;
      expect(validDelivery(fullRow.delivery), id).toBe(true);
      expect(validChange(fullRow), id).toBe(false);
      expect(validDelivery(projectedById.get(id)?.delivery), id).toBe(true);
    }

    expect(projectedById.get("missing-delivery")).not.toHaveProperty("delivery");
    for (let index = 0; index < 5; index++) {
      expect(projectedById.get(`scalar-delivery-${index}`)?.delivery).toEqual(
        fullById.get(`scalar-delivery-${index}`)?.delivery,
      );
    }
    for (const field of optionalFields) {
      for (let index = 0; index < falseyValues.length; index++) {
        const id = `falsey-${field}-${index}`;
        const fullDelivery = fullById.get(id)?.delivery as Record<string, unknown>;
        const projectedDelivery = projectedById.get(id)?.delivery as Record<string, unknown>;
        expect(Object.hasOwn(projectedDelivery, field), id).toBe(Object.hasOwn(fullDelivery, field));
        if (Object.hasOwn(fullDelivery, field)) expect(projectedDelivery[field], id).toEqual(fullDelivery[field]);
      }
    }

    const futureProjected = projectedById.get("valid-future-send-intent");
    const futureStatus = emptyNotificationStatus("codex");
    addNotificationStatus(futureStatus, futureProjected, NOW.getTime());
    expect(futureStatus).toMatchObject({ claimed: 1, uncertain: 1, invalid: 0, timingTrouble: true });
    expect(notificationNote(futureStatus, NOW.getTime())).toContain("timing unavailable/clock-inconsistent");

    const malformedStatus = emptyNotificationStatus("codex");
    addNotificationStatus(malformedStatus, projectedById.get("malformed-delivered-next-at"), NOW.getTime());
    expect(malformedStatus).toMatchObject({ pending: 1, invalid: 1 });
    expect(malformedStatus.acknowledgedAt).toBeUndefined();
    expect(notificationNote(malformedStatus, NOW.getTime())).not.toContain("Slack accepted");

    const report = await readNotificationStatus(mongo.db, NOW.getTime());
    expect(report.kind).toBe("available");
    if (report.kind !== "available") throw new Error("expected available notification report");
    expect(report.rows.map((row) => row.provider)).toEqual(["codex"]);
  });
});
