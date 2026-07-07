import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { toAgentConfig } from "../types/agent-definition.js";
import { config as appConfig } from "../config.js";
import { getArchetype } from "../archetypes/registry.js";
import { IN_PROCESS_PORTED_SERVERS } from "./in-process-servers.js";
import "../archetypes/index.js";
import type { Collection, ChangeStream } from "mongodb";

const log = createLogger("agent-registry");

const POLL_INTERVAL_MS = 30_000;

/**
 * KPR-221: context-dependent MCP servers that **cannot** appear in
 * `delegateServers`. Sub-agents spawn without channel/thread env vars, so
 * these servers — which embed `CHANNEL_ID`/`THREAD_ID`/`WorkItemContext`
 * — would silently malfunction. Misconfigurations are bugs, not policy
 * choices. Mirrored at `agent-runner.ts:CONTEXT_DEPENDENT_SERVERS` and
 * the admin tool (`admin-mcp-server.ts:checkDelegateContextDependent`).
 *
 * Note `memory` and `structured-memory` overlap with `IN_PROCESS_PORTED_SERVERS`
 * — they're rejected by either guard. `callback`, `background`, `code-task`,
 * and `recall` are uniquely caught here.
 */
const CONTEXT_DEPENDENT_SERVERS = new Set<string>([
  "callback",
  "background",
  "code-task",
  "recall",
  "structured-memory",
  "memory",
]);

/**
 * KPR-184: strip any KPR-122-ported in-process server names from
 * `delegateServers`. The SDK's AgentDefinition.mcpServers type does not
 * accept in-process configs, so a delegate referencing one of these falls
 * back to a stdio path that no longer exists post-KPR-183. The admin tool
 * rejects malformed inputs at create/update; this sanitizer guards
 * pre-existing data on engine boot. Logs an error so the operator notices
 * and can move the entry to coreServers (or remove it).
 */
function sanitizeDelegateServers(agentId: string, delegateServers: string[]): string[] {
  const invalid = delegateServers.filter((s) => IN_PROCESS_PORTED_SERVERS.has(s));
  if (invalid.length === 0) return delegateServers;
  log.error("Invalid delegateServers — in-process-ported servers cannot be delegated. Stripping.", {
    agent: agentId,
    invalid,
    remediation:
      "Move these servers to coreServers (or remove) via admin_agent_update. Per KPR-122, they're in-process and the SDK's AgentDefinition type doesn't accept in-process configs.",
  });
  return delegateServers.filter((s) => !IN_PROCESS_PORTED_SERVERS.has(s));
}

/**
 * KPR-221: hard-reject context-dependent servers in `delegateServers`.
 * Throws so the caller in `load()` can evict the offending agent and
 * surface the error to the operator. The admin tool rejects these at
 * write time; this guard catches stale data and (in test/dev) fixtures
 * that bypass the admin path.
 */
export function validateDelegateServersOrThrow(agentId: string, delegateServers: readonly string[]): void {
  const offending = delegateServers.filter((s) => CONTEXT_DEPENDENT_SERVERS.has(s));
  if (offending.length === 0) return;
  throw new Error(
    `Agent '${agentId}' has context-dependent server(s) in delegateServers: ${offending.join(", ")}. ` +
      `These servers embed channel/thread env vars and cannot work as sub-agents — sub-agents spawn ` +
      `without that context. Move to coreServers or remove. Context-dependent: ` +
      `${[...CONTEXT_DEPENDENT_SERVERS].join(", ")}.`,
  );
}

/**
 * KPR-295 — roster guard state shape, returned by `getRosterGuardState()`.
 * Kept as a standalone interface so `buildRosterStatsDoc` can map it without
 * importing anything Mongo-specific into this file.
 */
export interface RosterGuardState {
  degraded: boolean;
  degradedSince: Date | null;
  blockedReloadCount: number;
  lastBlockedAt: Date | null;
  lastRecoveryAt: Date | null;
  lastGood: {
    docCount: number;
    activeCount: number;
    disabledCount: number;
    at: Date;
    source: "boot" | "reload";
  } | null;
}

/**
 * KPR-295 — pure mapping from `getRosterGuardState()` output to the telemetry
 * doc shape (`db.telemetry`, consumed by `hive doctor` / KPR-296). No `kind`,
 * no `updatedAt` — the caller (`writeRosterStats` in `index.ts`) owns the
 * envelope. This telemetry kind is event-driven — written on every reload
 * outcome, not on a heartbeat cadence (unlike `prefix_cache_stats` /
 * `spawn_coordinator_stats`, which are heartbeat-cadence). No mongodb
 * imports here by design.
 */
export function buildRosterStatsDoc(state: RosterGuardState): {
  docCount: number | null;
  activeCount: number | null;
  disabledCount: number | null;
  lastGoodAt: Date | null;
  lastGoodSource: "boot" | "reload" | null;
  degraded: boolean;
  degradedSince: Date | null;
  blockedReloadCount: number;
  lastBlockedAt: Date | null;
  lastRecoveryAt: Date | null;
} {
  return {
    docCount: state.lastGood?.docCount ?? null,
    activeCount: state.lastGood?.activeCount ?? null,
    disabledCount: state.lastGood?.disabledCount ?? null,
    lastGoodAt: state.lastGood?.at ?? null,
    lastGoodSource: state.lastGood?.source ?? null,
    degraded: state.degraded,
    degradedSince: state.degradedSince,
    blockedReloadCount: state.blockedReloadCount,
    lastBlockedAt: state.lastBlockedAt,
    lastRecoveryAt: state.lastRecoveryAt,
  };
}

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private originToAgent = new Map<string, string>();
  private disabledAgents: AgentConfig[] = [];
  private agentDefs: Collection<AgentDefinition>;
  private changeStream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = new Date(0);
  private onChangeDetected?: () => void;
  private postReloadHandlers: Array<() => void> = [];

  // KPR-295 — empty-roster reload guard state. `hadNonEmptyLoad` arms the
  // guard: it's false only before the first non-empty commit, so a genuinely
  // empty fresh install can still boot/reload without tripping the guard.
  private hadNonEmptyLoad = false;
  private hasLoadedOnce = false;
  private rosterGuard: {
    degraded: boolean;
    degradedSince: Date | null;
    blockedReloadCount: number;
    lastBlockedAt: Date | null;
    lastRecoveryAt: Date | null;
  } = {
    degraded: false,
    degradedSince: null,
    blockedReloadCount: 0,
    lastBlockedAt: null,
    lastRecoveryAt: null,
  };
  private lastGood: {
    docCount: number;
    activeCount: number;
    disabledCount: number;
    at: Date;
    source: "boot" | "reload";
  } | null = null;
  private degradedRetryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(agentDefs: Collection<AgentDefinition>, onChangeDetected?: () => void) {
    this.agentDefs = agentDefs;
    this.onChangeDetected = onChangeDetected;
  }

  /**
   * Subscribe to post-reload events — fired after `load()` commits new state
   * (i.e. after `this.agents` is updated and `rebuildOriginIndex()` runs).
   * Multiple subscribers supported. Returns an unsubscribe function.
   *
   * **Handlers must be synchronous.** The signature is `() => void` and any
   * returned Promise is discarded — `load()` will not await it. If you need
   * async work post-reload, kick it off from the handler and let it run
   * independently (or wire a different mechanism).
   */
  onPostReload(handler: () => void): () => void {
    this.postReloadHandlers.push(handler);
    return () => {
      const i = this.postReloadHandlers.indexOf(handler);
      if (i >= 0) this.postReloadHandlers.splice(i, 1);
    };
  }

  private firePostReload(): void {
    for (const h of this.postReloadHandlers) {
      try {
        h();
      } catch (err) {
        log.warn("onPostReload handler threw", { error: String(err) });
      }
    }
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[]; blocked?: boolean }> {
    // INVARIANT (KPR-295): load() must keep exactly one await before the
    // synchronous commit below; the guard's correctness (and the diff's
    // atomicity) depends on it. Do not introduce another await between the
    // `find().toArray()` resolving and the map mutations further down.
    const docs = await this.agentDefs.find().toArray();

    if (docs.length === 0 && this.hadNonEmptyLoad) {
      return this.blockEmptyReload();
    }

    const previousIds = new Set(this.agents.keys());
    const currentIds = new Set<string>();
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const newDisabled: AgentConfig[] = [];

    for (const doc of docs) {
      const agentConfig = toAgentConfig(doc, appConfig.autonomy);
      // KPR-184: strip in-process-ported servers from delegateServers before
      // any downstream consumer (subagent assembly, toolkit listing, etc.)
      // sees the value. Logs an error if any are stripped.
      agentConfig.delegateServers = sanitizeDelegateServers(agentConfig.id, agentConfig.delegateServers);
      currentIds.add(agentConfig.id);

      // Disabled check FIRST — skip all validation for disabled agents.
      // Without this, a disabled agent with invalid archetypeConfig or with
      // a context-dependent server in delegateServers (KPR-221) would fail
      // validation and get evicted instead of being quietly skipped. The
      // operator-facing contract is "disable first, repair config later" —
      // a disabled agent definition is an offline doc, not a live config.
      //
      // KPR-220 PR #266 review fix: previously, validateDelegateServersOrThrow
      // ran ahead of this block, causing disabled agents with bad
      // delegateServers to be evicted instead of landing in disabledAgents.
      if (agentConfig.disabled) {
        newDisabled.push(agentConfig);
        if (this.agents.has(agentConfig.id)) {
          this.agents.delete(agentConfig.id);
          removed.push(agentConfig.id);
          log.info("Disabled agent removed from active map", { id: agentConfig.id });
        }
        continue;
      }

      // KPR-221: hard-reject context-dependent servers in delegateServers.
      // These can't function as sub-agents (sub-agents spawn without channel/
      // thread env vars). Fail-closed: evict the offending agent and log the
      // error. Operator remedies via admin_agent_update.
      try {
        validateDelegateServersOrThrow(agentConfig.id, agentConfig.delegateServers);
      } catch (err) {
        log.error("Context-dependent server in delegateServers — agent will not load", {
          id: agentConfig.id,
          error: String(err),
        });
        if (this.agents.has(agentConfig.id)) {
          this.agents.delete(agentConfig.id);
          removed.push(agentConfig.id);
          log.warn("Evicted previously-loaded agent due to context-dependent server in delegateServers", {
            id: agentConfig.id,
          });
        }
        continue;
      }

      // Archetype validation (fail-closed on invalid archetypeConfig)
      if (agentConfig.archetype) {
        const def = getArchetype(agentConfig.archetype);
        if (!def) {
          // Graceful degradation — unknown archetype runs as unstructured.
          log.warn("Unknown archetype — loading agent as unstructured", {
            id: agentConfig.id,
            archetype: agentConfig.archetype,
          });
          agentConfig.archetype = undefined;
          agentConfig.archetypeConfig = undefined;
        } else {
          try {
            // Replace raw blob with archetype-validated typed config.
            agentConfig.archetypeConfig = def.validateConfig(agentConfig.archetypeConfig) as Record<string, unknown>;
          } catch (err) {
            log.error("Archetype config validation failed — agent will not load", {
              id: agentConfig.id,
              archetype: agentConfig.archetype,
              error: String(err),
            });
            // Fail-closed: evict any previously-loaded version so a stale valid
            // config doesn't keep serving requests after the DB doc goes bad.
            if (this.agents.has(agentConfig.id)) {
              this.agents.delete(agentConfig.id);
              removed.push(agentConfig.id);
              log.warn("Evicted previously-loaded agent due to archetype validation failure", {
                id: agentConfig.id,
              });
            }
            continue;
          }
        }
      }

      if (previousIds.has(agentConfig.id)) {
        updated.push(agentConfig.id);
      } else {
        added.push(agentConfig.id);
      }

      this.agents.set(agentConfig.id, agentConfig);
      log.info("Loaded agent", { id: agentConfig.id, name: agentConfig.name });

      if (!doc.roles || doc.roles.length === 0) {
        log.warn(
          "Agent has no roles[] — set via admin agent_update or beekeeper tune-instance for proper team_lookup_agent payload",
          {
            id: agentConfig.id,
            name: agentConfig.name,
          },
        );
      }
    }

    this.disabledAgents = newDisabled;

    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        this.agents.delete(id);
        removed.push(id);
        log.info("Removed agent", { id });
      }
    }

    this.lastPollTime = new Date();
    this.rebuildOriginIndex();

    // KPR-295 — commit-path bookkeeping. Runs on every commit (including a
    // genuinely empty fresh-install load), before firePostReload().
    this.hadNonEmptyLoad ||= docs.length > 0;
    const now = new Date();
    this.lastGood = {
      docCount: docs.length,
      activeCount: this.agents.size,
      disabledCount: newDisabled.length,
      at: now,
      source: this.hasLoadedOnce ? "reload" : "boot",
    };
    this.hasLoadedOnce = true;

    if (this.rosterGuard.degraded) {
      this.rosterGuard.degraded = false;
      this.rosterGuard.degradedSince = null;
      this.rosterGuard.lastRecoveryAt = now;
      if (this.degradedRetryTimer) {
        clearInterval(this.degradedRetryTimer);
        this.degradedRetryTimer = null;
      }
      log.info("roster reload recovered — last-good roster replaced", {
        agents: docs.length,
        blockedReloadCount: this.rosterGuard.blockedReloadCount,
      });
    }

    this.firePostReload();
    return { added, updated, removed };
  }

  /**
   * KPR-295 — an empty `find().toArray()` result after a previous non-empty
   * commit is treated as a suspect read (impostor/wiped DB), not a genuine
   * roster shrink-to-zero. Keeps serving the last-good in-memory roster
   * untouched: no map mutation, no `lastPollTime` touch, no post-reload fire.
   * Entire body is try/wrapped so this can never throw and break `load()`'s
   * fail-open contract (spec: throwing logger inside here must not prevent
   * `load()` from resolving `{ blocked: true }`).
   */
  private blockEmptyReload(): { added: string[]; updated: string[]; removed: string[]; blocked: true } {
    try {
      const now = new Date();
      const wasDegraded = this.rosterGuard.degraded;
      this.rosterGuard.degraded = true;
      this.rosterGuard.degradedSince ??= now;
      this.rosterGuard.blockedReloadCount++;
      this.rosterGuard.lastBlockedAt = now;

      // Start the retry timer BEFORE any logging. If the logger throws
      // synchronously on the first blocked load, the catch below must not
      // be able to swallow it before the timer starts — otherwise
      // auto-recovery is dead until some external trigger fires (which may
      // never happen: the poll predicate can't fire on an empty collection
      // and the change stream is typically down in this scenario). The
      // timer-start itself is safe/never-throwing (try-wrapped tick body).
      if (!this.degradedRetryTimer) {
        this.degradedRetryTimer = setInterval(() => {
          try {
            this.onChangeDetected?.();
          } catch (err) {
            log.warn("degraded-retry tick failed", { error: String(err) });
          }
        }, POLL_INTERVAL_MS);
        this.degradedRetryTimer.unref?.();
      }

      try {
        if (!wasDegraded) {
          log.error("EMPTY ROSTER READ — keeping last-good roster", {
            critical: true,
            lastGoodDocCount: this.lastGood?.docCount ?? null,
            lastGoodAt: this.lastGood?.at ?? null,
            hint:
              "DB may be an impostor or wiped — see hive doctor / db_identity_stats. If you intentionally deleted all agents, restart the engine to apply.",
          });
        } else {
          log.info("roster reload still blocked — empty read repeated", {
            blockedReloadCount: this.rosterGuard.blockedReloadCount,
          });
        }
      } catch (logErr) {
        log.warn("blockEmptyReload logging failed", { error: String(logErr) });
      }
    } catch (err) {
      // Fail-open: never let a logging/timer failure here prevent load()
      // from resolving with blocked: true and the roster left untouched.
      try {
        log.warn("blockEmptyReload encountered an internal error", { error: String(err) });
      } catch {
        // Even the warn call is inside the same try — swallow silently as
        // the last resort.
      }
    }

    return { added: [], updated: [], removed: [], blocked: true };
  }

  /**
   * KPR-295 — public snapshot of the roster guard state, for `hive doctor`
   * (KPR-296, out of scope here) and the telemetry heartbeat. Returns copies,
   * not live references, so callers can't mutate internal state.
   */
  getRosterGuardState(): RosterGuardState {
    return {
      degraded: this.rosterGuard.degraded,
      degradedSince: this.rosterGuard.degradedSince ? new Date(this.rosterGuard.degradedSince) : null,
      blockedReloadCount: this.rosterGuard.blockedReloadCount,
      lastBlockedAt: this.rosterGuard.lastBlockedAt ? new Date(this.rosterGuard.lastBlockedAt) : null,
      lastRecoveryAt: this.rosterGuard.lastRecoveryAt ? new Date(this.rosterGuard.lastRecoveryAt) : null,
      lastGood: this.lastGood
        ? {
            docCount: this.lastGood.docCount,
            activeCount: this.lastGood.activeCount,
            disabledCount: this.lastGood.disabledCount,
            at: new Date(this.lastGood.at),
            source: this.lastGood.source,
          }
        : null,
    };
  }

  async startWatching(): Promise<void> {
    try {
      this.changeStream = this.agentDefs.watch([], { fullDocument: "updateLookup" });
      this.changeStream.on("change", () => {
        log.info("Agent definition changed (change stream), triggering reload");
        this.onChangeDetected?.();
      });
      this.changeStream.on("error", (err) => {
        log.warn("Change stream error, falling back to polling", { error: String(err) });
        this.changeStream = null;
        this.startPolling();
      });
      log.info("Agent registry watching via change stream");
    } catch {
      log.info("Change stream not available, using polling fallback");
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const changed = await this.agentDefs.countDocuments({
          updatedAt: { $gt: this.lastPollTime },
        });
        if (changed > 0) {
          log.info("Agent definitions changed (poll), triggering reload", { changed });
          this.onChangeDetected?.();
        }
      } catch (err) {
        log.error("Poll check failed", { error: String(err) });
      }
    }, POLL_INTERVAL_MS);
    log.info("Agent registry watching via polling", { intervalMs: POLL_INTERVAL_MS });
  }

  private rebuildOriginIndex(): void {
    this.originToAgent.clear();
    // Sort by id so conflict resolution is deterministic regardless of Map iteration order.
    const sorted = [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const agent of sorted) {
      for (const slug of agent.catches ?? []) {
        if (this.originToAgent.has(slug)) {
          log.error("Origin conflict — first sorted agent wins", {
            origin: slug,
            winner: this.originToAgent.get(slug),
            loser: agent.id,
          });
          continue;
        }
        this.originToAgent.set(slug, agent.id);
      }
    }
  }

  stopWatching(): void {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.degradedRetryTimer) {
      clearInterval(this.degradedRetryTimer);
      this.degradedRetryTimer = null;
    }
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  async getAllDefinitions(): Promise<AgentDefinition[]> {
    return this.agentDefs.find().toArray();
  }

  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  findByChannel(channelName: string): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.channels.includes(channelName));
  }

  findByOrigin(slug: string): AgentConfig | undefined {
    const agentId = this.originToAgent.get(slug);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  isPassiveChannel(channelName: string): boolean {
    return this.getAll().some((a) => !a.disabled && a.passiveChannels.includes(channelName));
  }

  findByKeyword(text: string): AgentConfig | undefined {
    const lower = text.toLowerCase();
    return this.getAll().find((a) =>
      !a.disabled &&
      a.keywords.some((kw) => {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(lower);
      }),
    );
  }

  findByName(text: string): AgentConfig | undefined {
    return this.findAllByName(text)[0];
  }

  findAllByName(text: string): AgentConfig[] {
    return this.getAll().filter((a) => {
      if (a.disabled) return false;
      if (this.matchesName(a.name, text)) return true;
      // Also match on first name for multi-word names (e.g. "Alex" matches "Alex Chen")
      if (a.name.includes(" ")) {
        const firstName = a.name.split(" ")[0];
        if (this.matchesName(firstName, text)) return true;
      }
      // Match against aliases (e.g. "Sam" matches agent named "Samantha")
      for (const alias of a.aliases) {
        if (this.matchesName(alias, text)) return true;
      }
      return false;
    });
  }

  /** Test whether a name/alias appears in text using standard addressing patterns */
  private matchesName(name: string, text: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|hey\\s+|@)${escaped}\\b|\\b${escaped}[,:]`, "i");
    return pattern.test(text);
  }

  getDefault(): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.isDefault);
  }

  getDisabled(): AgentConfig[] {
    return this.disabledAgents;
  }

  getSubscriberMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const agent of this.getAll()) {
      if (agent.disabled) continue;
      for (const sub of agent.subscribe ?? []) {
        const domain = sub.includes(":") ? sub.split(":")[0] : sub;
        if (!map[domain]) map[domain] = [];
        if (!map[domain].includes(agent.id)) {
          map[domain].push(agent.id);
        }
      }
    }
    return map;
  }
}
