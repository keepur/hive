# KPR-452 plan — chunk 1: the audit-routing leaf

Read with [the main plan](kpr-452-plan.md). Tasks 1–2.

## Task 1: The audit-routing leaf module

**Files:**
- Create: `src/audit/audit-routing.ts`

- [ ] **Step 1:** Create `src/audit/audit-routing.ts` with exactly this content.

```typescript
/**
 * KPR-452: audit-mirror routing.
 *
 * This module is a LEAF **by import graph**: it imports the WorkItem types,
 * `policyFor`, and the Mongo `Collection` type — nothing else. That is what
 * lets the admin MCP server reach the runtime routing control without ever
 * importing the Dispatcher, so no import cycle is created.
 *
 * "Leaf" here means *no engine dependencies*, NOT *pure*. Only
 * `auditCopyDecision` is pure; the module also performs Mongo I/O (the
 * override document, through an injected `Collection`) and holds mutable
 * process state (the module-global control accessor at the bottom). Both are
 * deliberate — the widened responsibility is what keeps the admin server off
 * the Dispatcher — and both are why every test installing the accessor must
 * clear it in `afterEach`.
 */
import type { Collection } from "mongodb";
import type { ChannelKind, WorkItem } from "../types/work-item.js";
import { policyFor } from "../outage/outage-notices.js";

/**
 * Why an audit copy was or was not posted (KPR-452 D2, rules 2-3).
 *
 * ⚠ `reason` has NO runtime consumer: `postAuditLog` reads only `.post`, and
 * no log line carries the suppression reason. It exists solely so the unit
 * tests can distinguish rule 2 from rule 3 — a `{post:false}`-only return
 * would let the two collapse without a test noticing. Do not describe it as
 * observability, and do not add a log line for it here: routing a suppression
 * reason into the logs is a separate decision nobody has made.
 */
export type AuditCopyReason = "same-kind" | "policy-skip" | "post";

export interface AuditCopyDecision {
  post: boolean;
  reason: AuditCopyReason;
}

/**
 * KPR-452 D1/D2 — the ONLY audit-copy predicate in the engine. Do not re-add
 * a `source.kind` check at any call site: a second, drifting predicate is the
 * failure mode KPR-416/KPR-420 were spent fixing.
 *
 * Ownership split (D2): this leaf owns exactly rules 2 and 3 — the only two
 * its signature can decide — and its three `reason` values map one-to-one
 * onto them. Rules 1 (no audit adapter), 4 (destination resolution) and 5
 * (self-post guard) stay in `Dispatcher.postAuditLog`, which holds the state
 * and does the I/O.
 *
 * Rule 2 — same channel kind as the audit adapter: the turn's own delivery
 * already landed in a place a human reads. This is what keeps cron out of
 * scope ALWAYS (cron WorkItems are built `kind: "slack"`,
 * scheduler.ts:230-238) and what keeps SLACK-SOURCED callbacks and `worker:`
 * boss re-entry items out too. No prefix in `policyFor`'s `silent` set carries
 * a blanket exemption — `source.kind` decides.
 *
 * Rule 3 — `policyFor`'s class. `skip` (cron) suppresses: a re-firing job
 * would be mirrored twice. `silent` and `notify` both POST. `silent` posting
 * is the honest consequence of the human ruling on KPR-452 — the ops stream
 * is RELOCATED, not deleted.
 *
 * `policyFor` carries a documented caveat (outage-notices.ts:8-13): ws/app
 * ids are client-supplied, so a client id colliding with a reserved prefix
 * misclassifies. Accepted unchanged — the blast radius here is one misrouted
 * audit copy.
 *
 * ⚠ THE ONE-LINE ALTERNATIVE (spec D2 rule 3). If a human later rules that
 * `silent` should SUPPRESS rather than route, change the policy branch below
 * to `if (policy === "skip" || policy === "silent")`. Nothing else in this
 * design changes.
 */
export function auditCopyDecision(item: WorkItem, auditAdapterKind: ChannelKind): AuditCopyDecision {
  if (item.source.kind === auditAdapterKind) return { post: false, reason: "same-kind" };
  const policy = policyFor(item);
  if (policy === "skip") return { post: false, reason: "policy-skip" };
  return { post: true, reason: "post" };
}

/** The one `instance_settings` document id this ticket writes (KPR-452 D5). */
export const AUDIT_ROUTING_DOC_ID = "audit_routing";

/**
 * The audit-routing override document. No `workItemId` and no turn identity
 * is persisted — KPR-453 canon: identity available inside a handler does not
 * authorize a new write. No TTL, no index beyond `_id`.
 */
export interface AuditRoutingDoc {
  _id: string;
  channelName: string;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * Runtime handle the two admin MCP tools drive. Implemented by
 * `createAuditRoutingControl` over the Dispatcher, the registry and the
 * settings collection.
 */
export interface AuditRoutingControl {
  /** False in the boot window before `setAuditChannel`/`setSlackAdapter` run. */
  ready(): boolean;
  /** Human-readable effective routing state for `audit_channel_get`. */
  describe(): Promise<string>;
  /**
   * Validate, persist and apply. `name` is already normalized by the tool.
   * `""` clears the runtime override and reverts to `config.slack.auditChannel`.
   */
  set(name: string, actor: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * The Dispatcher surface the control needs, declared STRUCTURALLY so this
 * module never imports `dispatcher.js`. Keeping it structural is what makes
 * the leaf claim above true.
 */
export interface AuditRoutingDispatcher {
  auditRoutingReady(): boolean;
  getAuditChannelName(): string | undefined;
  peekAuditChannelId(): string | undefined;
  setAuditChannelName(name: string | undefined): void;
  resolveAuditChannelIdFully(name: string): Promise<string | undefined>;
}

/** Minimal roster surface for the homeBase advisory. */
export interface AuditRoutingRoster {
  getAll(): { name: string; homeBase?: string }[];
}

export interface AuditRoutingControlDeps {
  dispatcher: AuditRoutingDispatcher;
  settings: Collection<AuditRoutingDoc>;
  /** Live roster accessor — read at call time, never captured as an array. */
  roster: () => AuditRoutingRoster;
  /** `config.slack.auditChannel` — the no-override leg of D5's precedence. */
  configuredChannel: string;
  /** Boot-loaded override, or null. Owned (and mutated) by this closure set. */
  initialOverride: AuditRoutingDoc | null;
}

const NOT_READY = "Audit routing is not ready yet — the engine is still starting. Retry in a moment.";

/**
 * KPR-452 D5. Precedence is runtime override → `config.slack.auditChannel` →
 * unset ⇒ mirror off. There is NO default recipient (KPR-456 canon): with no
 * configured channel the mirror is simply off, and the engine never falls back
 * to homeBase, to an operator, or to any agent channel.
 *
 * `config.slack.auditChannel` is read once into `config` at process start;
 * changing it needs a hive.yaml/.env edit plus a restart, and this ticket does
 * not change that. The override document is read once at boot and mutated
 * in-process here, and the Dispatcher is the single in-memory holder — so a
 * CoS change takes effect on the NEXT AUDIT POST, with no restart. SIGUSR1
 * does NOT reload it (SIGUSR1 reloads agent definitions). A restart re-reads
 * the document, so the override survives restarts and engine upgrades.
 */
export function createAuditRoutingControl(deps: AuditRoutingControlDeps): AuditRoutingControl {
  const { dispatcher, settings, roster, configuredChannel } = deps;
  let override: AuditRoutingDoc | null = deps.initialOverride;

  const sourceLabel = (): string =>
    override?.channelName ? "runtime override" : configuredChannel ? "hive.yaml" : "unset";

  return {
    ready: () => dispatcher.auditRoutingReady(),

    describe: async () => {
      if (!dispatcher.auditRoutingReady()) return NOT_READY;
      const name = dispatcher.getAuditChannelName();
      const lines = [
        `Audit channel: ${name ? `#${name}` : "(unset — the audit mirror is OFF)"}`,
        `Source: ${sourceLabel()}`,
        `Resolves to a Slack channel id: ${dispatcher.peekAuditChannelId() ? "yes" : "no"}`,
      ];
      if (override) {
        lines.push(`Override set by ${override.updatedBy} at ${new Date(override.updatedAt).toISOString()}`);
      }
      if (name) {
        // Advisory only — never blocks anything. It exists because `dodi`
        // ships with `slack.auditChannel: agent-jessica` today (spec
        // Prerequisite 1), which on the new code makes one agent's own
        // channel the fleet-wide audit destination.
        const owner = roster()
          .getAll()
          .find((a) => a.homeBase === name);
        if (owner) {
          lines.push(
            `Advisory: #${name} is ${owner.name}'s homeBase channel — the whole fleet's ops stream would land there. A dedicated audit channel is usually what you want.`,
          );
        }
      }
      return lines.join("\n");
    },

    set: async (name, actor) => {
      if (!dispatcher.auditRoutingReady()) return { ok: false, message: NOT_READY };

      if (name === "") {
        await settings.deleteOne({ _id: AUDIT_ROUTING_DOC_ID });
        override = null;
        dispatcher.setAuditChannelName(configuredChannel);
        return {
          ok: true,
          message: configuredChannel
            ? `Override cleared. The audit channel reverts to #${configuredChannel} (hive.yaml).`
            : "Override cleared. No channel is configured in hive.yaml, so the audit mirror is now OFF.",
        };
      }

      // Validation is NOT on a turn's critical path, so — deliberately unlike
      // the Dispatcher's one-page dispatch-path refresh — this paginates
      // fully AND seeds the resolved pair into the name→id map. The seeding
      // is what makes this tool the working escape for a channel beyond page
      // 1; without it the tool would report success while every subsequent
      // audit post kept failing to resolve until the next boot.
      const resolvedId = await dispatcher.resolveAuditChannelIdFully(name);
      if (!resolvedId) {
        return {
          ok: false,
          message: `#${name} did not resolve to a Slack channel — nothing was saved. Either the channel does not exist, or the bot cannot see it (invite the bot to #${name}, then retry).`,
        };
      }

      const doc: AuditRoutingDoc = {
        _id: AUDIT_ROUTING_DOC_ID,
        channelName: name,
        updatedAt: new Date(),
        updatedBy: actor,
      };
      await settings.replaceOne({ _id: AUDIT_ROUTING_DOC_ID }, doc, { upsert: true });
      override = doc;
      dispatcher.setAuditChannelName(name);
      return {
        ok: true,
        message: `Audit channel set to #${name} (id ${resolvedId}). It applies to the next audit post — no restart and no SIGUSR1. The bot must be a member of #${name} to post there.`,
      };
    },
  };
}

/**
 * Module-global accessor pair, following the `listPluginProviderIds`
 * precedent (`provider-adapters/provider-registry.ts`, imported by
 * `agent-runner.ts:84`). The admin MCP server imports ONLY these, never the
 * Dispatcher.
 *
 * ⚠ NAMED LIMIT (spec D5), not a bug to file later: this is a module global
 * in the ENGINE process, so it is reachable only from the IN-PROCESS admin
 * server. When the runner takes its stdio admin fallback
 * (`agent-runner.ts:1123-1133`, reached whenever `this.db` is unset — the
 * in-process branch is gated on `this.db && shouldEnableInProcessServer("admin")`
 * at `:1572`), the tools run in a subprocess with no access to the control and
 * report unreachable PERMANENTLY, not merely during the boot window. That is
 * honest failure of the same shape, and no cross-process channel is built for
 * it: the fallback is not the configuration path this ticket targets.
 */
let auditRoutingControl: AuditRoutingControl | undefined;

export function setAuditRoutingControl(control: AuditRoutingControl | undefined): void {
  auditRoutingControl = control;
}

export function getAuditRoutingControl(): AuditRoutingControl | undefined {
  return auditRoutingControl;
}
```

- [ ] **Step 2:** Verify.

Run: `cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/audit/audit-routing.ts && npm run typecheck`

Expected: prettier rewrites/confirms the file; `tsc` exits 0 with no diagnostics.

- [ ] **Step 3:** Do not commit yet — Task 2 adds this module's test file and they commit together.

---

## Task 2: Unit-test the leaf (AC1–AC5, AC8, AC9)

**Files:**
- Create: `src/audit/audit-routing.test.ts`

- [ ] **Step 1:** Create `src/audit/audit-routing.test.ts`.

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import {
  AUDIT_ROUTING_DOC_ID,
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

  it("reports not-ready during the boot window instead of a spurious not-found", async () => {
    const h = makeControlHarness({ ready: false, resolves: "C-OPS", configuredChannel: "cfg" });
    expect(h.control.ready()).toBe(false);
    expect(await h.control.describe()).toContain("not ready yet");
    const res = await h.control.set("ops-audit", "cos");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not ready yet");
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
```

- [ ] **Step 2:** Verify.

```bash
cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/audit/audit-routing.test.ts && \
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/audit/audit-routing.test.ts
```

Expected: exit 0, every test in the **three** describe blocks passes
(`auditCopyDecision (KPR-452 D2 rules 2-3)`, `createAuditRoutingControl
(KPR-452 D5)`, `audit routing control accessor (KPR-452 D5)`), none skipped.

- [ ] **Step 3:** Commit.

```bash
git add src/audit/audit-routing.ts src/audit/audit-routing.test.ts
git commit -m "feat: add audit-copy decision leaf and runtime routing control"
```
