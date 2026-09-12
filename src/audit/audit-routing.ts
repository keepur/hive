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
 * `policyFor` carries a documented caveat (outage-notices.ts:14-19): ws/app
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

/**
 * Both tools' not-ready answer. It deliberately names BOTH causes (r1
 * CONSIDER 2). `dispatcher.auditRoutingReady()` is a single boolean and it is
 * false in two very different situations: the ordinary boot window before
 * `setAuditChannel` runs, and — permanently, for the life of the process —
 * after the boot channel sweep threw, since `index.ts` wraps that pagination
 * in a try/catch that warns `Failed to configure audit channel` and skips
 * `setAuditChannel` entirely. "The engine is still starting. Retry in a
 * moment." was true of the first and actively misleading about the second,
 * sending the operator into an unbounded retry loop instead of at the boot
 * warn that explains it.
 *
 * Genuinely DISTINGUISHING the two would need a third state out of the
 * Dispatcher (wired-but-sweep-failed), which is a dispatcher change this
 * ticket does not make. The honest fix at this layer is to stop asserting the
 * cause and name where the answer is.
 *
 * ⚠ EXPORTED SO NOTHING MIRRORS IT (r2 CONSIDER 2, `MEETING_ACK_TEXT`
 * precedent). This is the ONLY copy of these bytes in the repo: the control
 * below returns it, and both test suites that assert on it — this module's own
 * (`audit-routing.test.ts`, the contract) and the admin tool surface's
 * (`admin-mcp-server.test.ts`, the passthrough) — import it rather than
 * hand-typing it. A hand-typed copy went stale the moment this wording was
 * rewritten and its suite stayed green, which is exactly the drift the
 * precedent exists to prevent. Text and its assertions change in lockstep, or
 * not at all.
 */
export const AUDIT_ROUTING_NOT_READY =
  'Audit routing is not ready yet. Either the engine is still starting — retry in a moment — or the boot-time Slack channel sweep failed, in which case retrying will never help: check the engine log for "Failed to configure audit channel".';

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
      if (!dispatcher.auditRoutingReady()) return AUDIT_ROUTING_NOT_READY;
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
      if (!dispatcher.auditRoutingReady()) return { ok: false, message: AUDIT_ROUTING_NOT_READY };

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
 * `agent-runner.ts:86`). The admin MCP server imports ONLY these, never the
 * Dispatcher.
 *
 * ⚠ NAMED LIMIT (spec D5), not a bug to file later: this is a module global
 * in the ENGINE process, so it is reachable only from the IN-PROCESS admin
 * server. When the runner takes its stdio admin fallback
 * (`agent-runner.ts:1166-1177`, reached whenever `this.db` is unset — the
 * in-process branch is gated on `this.db && shouldEnableInProcessServer("admin")`
 * at `:1615`), the tools run in a subprocess with no access to the control and
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
