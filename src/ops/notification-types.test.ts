import { describe, it, expect } from "vitest";
import {
  OPS_SYSTEM_PRINCIPAL,
  OPS_STOPPED_STATES,
  OPS_WORKING_STATES,
  OPS_NUDGE_STATES,
  expiresAtFor,
  ledgerRetentionDays,
  stallRecheckAt,
  STALL_RECHECK_MS,
  STALL_JITTER_FRACTION,
  type OpsNotificationState,
} from "./notification-types.js";

describe("OPS_SYSTEM_PRINCIPAL (D2, C9)", () => {
  it("matches neither the agent-id shape nor the Slack user-id shape", () => {
    expect(OPS_SYSTEM_PRINCIPAL).not.toMatch(/^[a-z0-9-]+$/);
    expect(OPS_SYSTEM_PRINCIPAL).not.toMatch(/^[UW][A-Z0-9]+$/);
    expect(OPS_SYSTEM_PRINCIPAL).toContain(":");
  });
});

describe("D9 expiresAt state invariant", () => {
  const ALL: OpsNotificationState[] = ["pending", "delivered", "seen", "dismissed", "snoozed", "cleared"];
  const at = new Date("2026-01-01T00:00:00.000Z");

  it("is a TOTAL map over D7's six states, not an enumeration of transitions", () => {
    for (const state of ALL) {
      const expires = expiresAtFor(state, at, 30);
      if ((OPS_STOPPED_STATES as readonly string[]).includes(state)) {
        expect(expires, state).toEqual(new Date(at.getTime() + 30 * 86_400_000));
      } else {
        expect(expires, state).toBeUndefined();
      }
    }
  });

  it("partitions the six states and scopes nextNudgeAt to the two working NON-snoozed ones", () => {
    expect([...OPS_STOPPED_STATES, ...OPS_WORKING_STATES].sort()).toEqual([...ALL].sort());
    expect([...OPS_NUDGE_STATES]).toEqual(["pending", "delivered"]);
    expect(OPS_WORKING_STATES).toContain("snoozed");
    expect(OPS_NUDGE_STATES).not.toContain("snoozed");
  });
});

describe("ledgerRetentionDays (D9)", () => {
  it("composes against the event TTL so the behavioural half always ages first", () => {
    expect(ledgerRetentionDays(90)).toBe(30); // the config.ts:659 default
    expect(ledgerRetentionDays(14)).toBe(14); // a shortened activity retention
    expect(ledgerRetentionDays(30)).toBe(30);
  });
});

describe("stallRecheckAt (D5)", () => {
  it("stays inside ±STALL_JITTER_FRACTION of the interval at both extremes", () => {
    const now = new Date(1_000_000);
    const span = STALL_RECHECK_MS * STALL_JITTER_FRACTION;
    expect(stallRecheckAt(now, () => 0).getTime()).toBe(now.getTime() + STALL_RECHECK_MS - span);
    expect(stallRecheckAt(now, () => 1).getTime()).toBe(now.getTime() + STALL_RECHECK_MS + span);
    expect(stallRecheckAt(now, () => 0.5).getTime()).toBe(now.getTime() + STALL_RECHECK_MS);
  });

  it("is always strictly in the future — an unset or already-due value is the D5 failure", () => {
    const now = new Date(1_000_000);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(stallRecheckAt(now, () => r).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
