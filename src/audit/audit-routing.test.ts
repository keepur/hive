import { describe, it, expect, vi, afterEach } from "vitest";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import {
  AUDIT_ROUTING_DOC_ID,
  AUDIT_ROUTING_NOT_READY,
  auditCopyDecision,
  createAuditRoutingControl,
  getAuditRoutingControl,
  setAuditRoutingControl,
  type AuditRoutingControl,
  type AuditRoutingDoc,
} from "./audit-routing.js";

function item(id: string, kind: ChannelKind, sourceId = "src-1"): WorkItem {
  return {
    id,
    text: "hello",
    source: { kind, id: sourceId, label: kind },
    sender: "system",
    timestamp: new Date("2026-09-08T00:00:00Z"),
  };
}

describe("auditCopyDecision (KPR-452 D2 rules 2-3)", () => {
  // AC1 — the ops stream May asked to keep.
  it("posts internal team- and event: items (the silent-class ops stream)", () => {
    expect(auditCopyDecision(item("team-abc", "internal"), "slack")).toEqual({ post: true, reason: "post" });
    expect(auditCopyDecision(item("event:e1:jasper", "internal"), "slack")).toEqual({ post: true, reason: "post" });
  });

  // AC3 — the Gate 1 boundary. Cron and slack-sourced callbacks are excluded
  // by RULE 2, before policyFor is ever consulted.
  it.each([
    ["human slack message", "1788764967.970169"],
    ["cron item (kind slack by construction)", "sched:daily-brief"],
    ["slack-sourced callback item", "callback:cb-1"],
    ["slack meeting worker re-entry", "worker:claim-1"],
  ])("suppresses %s as same-kind", (_label, id) => {
    expect(auditCopyDecision(item(id, "slack"), "slack")).toEqual({ post: false, reason: "same-kind" });
  });

  // AC2 — policy-skip. Unreachable today because rule 2 catches cron first;
  // retained for correctness if a future cron ever targets a non-Slack home.
  it("suppresses a sched: item whose source kind is not the audit adapter's", () => {
    expect(auditCopyDecision(item("sched:daily-brief", "sms"), "slack")).toEqual({
      post: false,
      reason: "policy-skip",
    });
  });

  // AC4 — the one class where "callback" and "audit copy" genuinely overlap.
  // The callback prefix is NOT a blanket exemption; AC3 and AC4 must coexist.
  it.each(["sms", "voice", "imessage"] as const)("posts a callback: item sourced from %s", (kind) => {
    expect(auditCopyDecision(item("callback:cb-2", kind), "slack")).toEqual({ post: true, reason: "post" });
  });

  it("posts a worker: item sourced from a non-Slack meeting channel", () => {
    expect(auditCopyDecision(item("worker:claim-2", "sms"), "slack")).toEqual({ post: true, reason: "post" });
  });

  // AC5 — notify-class non-Slack turns still appear in the ops stream.
  it.each(["voice", "team", "app", "sms"] as const)("posts a notify-class %s turn", (kind) => {
    expect(auditCopyDecision(item("client-supplied-id", kind), "slack")).toEqual({ post: true, reason: "post" });
  });

  it("keys rule 2 on the audit adapter's kind, not the literal 'slack'", () => {
    expect(auditCopyDecision(item("team-abc", "internal"), "internal")).toEqual({
      post: false,
      reason: "same-kind",
    });
  });
});

// ---------------------------------------------------------------------------
// createAuditRoutingControl — AC8 (persist + apply) and AC9 (reject without
// persisting; "" clears).
// ---------------------------------------------------------------------------

function makeControlHarness(opts: {
  ready?: boolean;
  resolves?: string | undefined;
  configuredChannel?: string;
  initialOverride?: AuditRoutingDoc | null;
  homeBaseOwner?: { name: string; homeBase?: string };
}) {
  let effectiveName: string | undefined = opts.initialOverride?.channelName || (opts.configuredChannel ?? "");
  if (!effectiveName) effectiveName = undefined;
  const docs = new Map<string, AuditRoutingDoc>();
  if (opts.initialOverride) docs.set(opts.initialOverride._id, opts.initialOverride);
  const settings = {
    deleteOne: vi.fn(async (f: { _id: string }) => {
      docs.delete(f._id);
      return { deletedCount: 1 };
    }),
    replaceOne: vi.fn(async (f: { _id: string }, doc: AuditRoutingDoc) => {
      docs.set(f._id, doc);
      return { modifiedCount: 1 };
    }),
  };
  const dispatcher = {
    auditRoutingReady: vi.fn(() => opts.ready ?? true),
    getAuditChannelName: vi.fn(() => effectiveName),
    peekAuditChannelId: vi.fn(() => (effectiveName ? "C-AUDIT" : undefined)),
    setAuditChannelName: vi.fn((name: string | undefined) => {
      effectiveName = name ? name : undefined;
    }),
    resolveAuditChannelIdFully: vi.fn(async (_name: string) => opts.resolves),
  };
  const control = createAuditRoutingControl({
    dispatcher,
    settings: settings as never,
    roster: () => ({ getAll: () => (opts.homeBaseOwner ? [opts.homeBaseOwner] : []) }),
    configuredChannel: opts.configuredChannel ?? "",
    initialOverride: opts.initialOverride ?? null,
  });
  return { control, dispatcher, settings, docs };
}

describe("createAuditRoutingControl (KPR-452 D5)", () => {
  it("AC8: persists the override, applies it, and round-trips through describe", async () => {
    const h = makeControlHarness({ resolves: "C-OPS", configuredChannel: "" });
    const res = await h.control.set("ops-audit", "chief-of-staff");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("#ops-audit");
    expect(res.message).toContain("no restart");

    const doc = h.docs.get(AUDIT_ROUTING_DOC_ID)!;
    expect(doc.channelName).toBe("ops-audit");
    expect(doc.updatedBy).toBe("chief-of-staff");
    expect(doc.updatedAt).toBeInstanceOf(Date);
    // KPR-453 canon: no turn identity is persisted.
    expect(Object.keys(doc).sort()).toEqual(["_id", "channelName", "updatedAt", "updatedBy"]);
    expect(h.dispatcher.setAuditChannelName).toHaveBeenCalledWith("ops-audit");

    const described = await h.control.describe();
    expect(described).toContain("Audit channel: #ops-audit");
    expect(described).toContain("Source: runtime override");
    // Testing Contract: describe() must report the resolve state, not only
    // the name — an unresolvable channel reads identically otherwise.
    expect(described).toContain("Resolves to a Slack channel id: yes");
    expect(described).toContain("Override set by chief-of-staff");
  });

  it("AC9: rejects an unresolvable name WITHOUT persisting or applying", async () => {
    const h = makeControlHarness({ resolves: undefined, configuredChannel: "cfg-audit" });
    const res = await h.control.set("ghost-channel", "chief-of-staff");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("did not resolve");
    expect(res.message).toContain("invite the bot");
    expect(h.settings.replaceOne).not.toHaveBeenCalled();
    expect(h.docs.size).toBe(0);
    expect(h.dispatcher.setAuditChannelName).not.toHaveBeenCalled();
  });

  it("AC9: empty name clears the override and reverts to the configured channel", async () => {
    const h = makeControlHarness({
      configuredChannel: "cfg-audit",
      initialOverride: {
        _id: AUDIT_ROUTING_DOC_ID,
        channelName: "ops-audit",
        updatedAt: new Date("2026-09-01T00:00:00Z"),
        updatedBy: "chief-of-staff",
      },
    });
    const res = await h.control.set("", "chief-of-staff");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("#cfg-audit");
    expect(h.settings.deleteOne).toHaveBeenCalledWith({ _id: AUDIT_ROUTING_DOC_ID });
    expect(h.docs.size).toBe(0);
    expect(h.dispatcher.setAuditChannelName).toHaveBeenCalledWith("cfg-audit");
    expect(await h.control.describe()).toContain("Source: hive.yaml");
  });

  it("clearing with no configured channel turns the mirror OFF — no default recipient", async () => {
    const h = makeControlHarness({
      configuredChannel: "",
      initialOverride: {
        _id: AUDIT_ROUTING_DOC_ID,
        channelName: "ops-audit",
        updatedAt: new Date(),
        updatedBy: "cos",
      },
    });
    const res = await h.control.set("", "cos");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("OFF");
    expect(h.dispatcher.setAuditChannelName).toHaveBeenCalledWith("");
    const describedOff = await h.control.describe();
    expect(describedOff).toContain("(unset — the audit mirror is OFF)");
    // Testing Contract: all THREE source labels are asserted across this
    // suite — "runtime override" (AC8), "hive.yaml" (the revert case above),
    // and "unset" here, the only leg no other test reaches.
    expect(describedOff).toContain("Source: unset");
    expect(describedOff).toContain("Resolves to a Slack channel id: no");
  });

  // The message is asserted through the EXPORTED constant, never a hand-typed
  // copy (r2 CONSIDER 2 — `MEETING_ACK_TEXT` precedent). `toBe` rather than
  // `toContain`: this suite owns the contract, so it pins that both surfaces
  // return exactly the one canonical string.
  it("reports not-ready during the boot window instead of a spurious not-found", async () => {
    const h = makeControlHarness({ ready: false, resolves: "C-OPS", configuredChannel: "cfg" });
    expect(h.control.ready()).toBe(false);
    expect(await h.control.describe()).toBe(AUDIT_ROUTING_NOT_READY);
    const res = await h.control.set("ops-audit", "cos");
    expect(res.ok).toBe(false);
    expect(res.message).toBe(AUDIT_ROUTING_NOT_READY);
    expect(h.settings.replaceOne).not.toHaveBeenCalled();
    expect(h.dispatcher.resolveAuditChannelIdFully).not.toHaveBeenCalled();
  });

  it("describe() advises when the effective channel is some agent's homeBase", async () => {
    const h = makeControlHarness({
      configuredChannel: "agent-jessica",
      homeBaseOwner: { name: "Jessica", homeBase: "agent-jessica" },
    });
    const described = await h.control.describe();
    expect(described).toContain("Advisory:");
    expect(described).toContain("Jessica's homeBase channel");
  });
});

describe("audit routing control accessor (KPR-452 D5)", () => {
  afterEach(() => setAuditRoutingControl(undefined));

  it("round-trips and clears", () => {
    expect(getAuditRoutingControl()).toBeUndefined();
    const fake = { ready: () => true } as unknown as AuditRoutingControl;
    setAuditRoutingControl(fake);
    expect(getAuditRoutingControl()).toBe(fake);
    setAuditRoutingControl(undefined);
    expect(getAuditRoutingControl()).toBeUndefined();
  });
});
