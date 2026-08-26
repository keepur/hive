/**
 * KPR-394 (§4.3): the runtime provider registry — the single runtime source
 * of provider truth. Built-ins seed from LANE_B_PROVIDER_MODULES +
 * SESSION_SEMANTICS at module load (both tables stay; they ARE the seed).
 * Plugin providers enter via the two-phase boot load:
 *   phase (a) declarePluginProviders() — synchronous, called from the
 *   AgentManager constructor's manifest pass: every declared id is
 *   registered immediately in a declared-not-yet-loaded state carrying
 *   declared-broken turn semantics, so from the first instant a turn routed
 *   at the prefix gets the honest TurnAssemblyError, never the Claude
 *   fallback.
 *   phase (b) activateDeclaredProviders() — async import() + factory call +
 *   kit injection, awaited by index.ts immediately after manager
 *   construction, BEFORE bgTaskManager.start()/scanOrphans() (their
 *   completion callbacks can already dispatch turns).
 *
 * Module-global state, deliberately: resolveProviderModel is a module-scope
 * pure function in agent-manager.ts, also consumed statically by
 * providerFor and prepareSpawn — threading a manager instance into those
 * call sites is exactly what the spec's §4.3 planner note forbids.
 *
 * Boot-only (§4.6): SIGUSR1 never loads or unloads provider code. ESM
 * import caching makes reload-in-place impossible; the install path
 * restarts anyway.
 */
import { pathToFileURL } from "node:url";
import { createLogger } from "../../logging/logger.js";
import type { LoadedPlugin, PluginProviderDecl } from "../../plugins/types.js";
import { resolvePluginServerPath } from "../../plugins/plugin-loader.js";
import { BUILTIN_ROUTABLE_PREFIXES, validateProviderDecl } from "../../plugins/provider-decl.js";
import { LANE_B_PROVIDER_ABI_VERSION, type LaneBProviderKit } from "./provider-abi.js";
import { LANE_B_PROVIDER_MODULES } from "./provider-modules.js";
import type { LaneBProviderModule } from "./provider-module.js";
import { SESSION_SEMANTICS, type SessionSemantics } from "./types.js";
import { LaneBTurnScaffold } from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";

const log = createLogger("provider-registry");

export interface RegisteredProvider {
  id: string;
  module: LaneBProviderModule;
  semantics: SessionSemantics;
  source: "builtin" | { plugin: string };
  /** Plugin only: the manifest-named slice keys the manager resolves per
   *  spawn (C7/C15 — engine resolves, module consumes opaquely). */
  slice?: Pick<PluginProviderDecl, "defaultModel" | "apiKeyEnv" | "baseUrlEnv">;
}

interface DeclaredPending {
  id: string;
  plugin: string;
  decl: PluginProviderDecl;
  entryPath: string;
}

interface BrokenProvider {
  plugin: string;
  reason: string;
}

const active = new Map<string, RegisteredProvider>();
const declared = new Map<string, DeclaredPending>();
const broken = new Map<string, BrokenProvider>();

// Built-in seed — at module load, once per process.
for (const [id, module] of Object.entries(LANE_B_PROVIDER_MODULES)) {
  active.set(id, {
    id,
    module,
    semantics: SESSION_SEMANTICS[id as keyof typeof SESSION_SEMANTICS],
    source: "builtin",
  });
}

/** §4.2: the engine-injected kit — the RUNNING engine's shared layer by
 *  reference, so shared fixes cover plugin providers structurally. */
export function buildProviderKit(): LaneBProviderKit {
  return {
    abiVersion: LANE_B_PROVIDER_ABI_VERSION,
    LaneBTurnScaffold,
    runBoundedDispatchLoop,
    sse: { splitSseEvents, parseSseEvent, isSseDone },
    createLogger,
  };
}

function pluginOwnerOf(id: string): string | undefined {
  const a = active.get(id);
  if (a && a.source !== "builtin") return a.source.plugin;
  return declared.get(id)?.plugin ?? broken.get(id)?.plugin;
}

function clearPluginState(id: string): void {
  if (active.get(id)?.source !== "builtin") active.delete(id);
  declared.delete(id);
  broken.delete(id);
}

/**
 * Phase (a) — synchronous declaration. Deterministic first-wins on
 * collisions (plugin order = appConfig.plugins order); the SECOND registrant
 * of an id is rejected with both plugin names logged, and the id's routing
 * state stays with the first (never last-wins shadowing; edge 1). Re-declare
 * from the SAME plugin is idempotent (test/manager re-construction).
 *
 * Ordering note (plan-review r1 fix): the cross-plugin collision check runs
 * BEFORE validation-driven `broken.set`. Checking collision first means an
 * invalid second declaration for an id another plugin already owns never
 * touches `broken`/`declared` for that id — it is rejected outright. Doing
 * validation first would let the second plugin's (possibly invalid) verdict
 * overwrite/shadow the first registrant's row during the phase a→b window
 * and leave a stale broken entry behind once the first registrant activates.
 */
export function declarePluginProviders(
  plugins: readonly LoadedPlugin[],
  opts: { hiveHome: string; distDir?: string },
): void {
  for (const plugin of plugins) {
    const decl = plugin.manifest.provider;
    if (!decl) continue;
    const id = decl.id;
    const owner = pluginOwnerOf(id);
    if (owner === plugin.name) {
      clearPluginState(id); // idempotent re-declare
    } else if (owner !== undefined) {
      // Cross-plugin collision — checked BEFORE validation (see the note
      // above) so an invalid second declaration can never clobber or
      // shadow the id it doesn't own. First registration wins
      // deterministically; the second is rejected with both plugin names
      // logged, and the id's routing state stays with the first — never
      // last-wins shadowing.
      log.error("Provider id collision — first registration wins, second rejected (KPR-394 edge 1)", {
        provider: id,
        first: owner,
        second: plugin.name,
      });
      continue;
    }
    const verdict = validateProviderDecl(decl, LANE_B_PROVIDER_ABI_VERSION);
    if (!verdict.ok) {
      broken.set(id, { plugin: plugin.name, reason: verdict.reason });
      log.error("Provider plugin declaration invalid — declared-broken (honest per-turn failure)", {
        provider: id,
        plugin: plugin.name,
        reason: verdict.reason,
      });
      continue;
    }
    const resolved = resolvePluginServerPath(plugin.name, decl.entry, {
      hiveHome: opts.hiveHome,
      distDir: opts.distDir,
    });
    if ("reason" in resolved) {
      broken.set(id, {
        plugin: plugin.name,
        reason: `compiled entry not resolvable: ${resolved.reason}`,
      });
      log.error("Provider plugin entry not resolvable — declared-broken until restart (§4.6)", {
        provider: id,
        plugin: plugin.name,
        entry: decl.entry,
        pathsChecked: resolved.pathsChecked,
      });
      continue;
    }
    declared.set(id, { id, plugin: plugin.name, decl, entryPath: resolved.path });
    log.info("Provider plugin declared (phase a) — awaiting boot activation", {
      provider: id,
      plugin: plugin.name,
      semantics: decl.sessionSemantics,
    });
  }
}

/**
 * Phase (b) — async activation. The factory is called once, synchronously
 * after import; a throw, a non-conforming return (missing createAdapter),
 * or a provider/manifest-id mismatch ⇒ declared-broken (§4.2, edge 3 — the
 * manifest is the curator-reviewed truth).
 */
export async function activateDeclaredProviders(
  importFn: (entryPath: string) => Promise<any> = (p) => import(pathToFileURL(p).href),
): Promise<void> {
  for (const [id, pending] of [...declared]) {
    try {
      const mod = await importFn(pending.entryPath);
      const factory = mod?.createProviderModule;
      if (typeof factory !== "function") {
        throw new Error("entry does not export createProviderModule(kit)");
      }
      const module: LaneBProviderModule = factory(buildProviderKit());
      if (!module || typeof module.createAdapter !== "function") {
        throw new Error("factory did not return a LaneBProviderModule (missing createAdapter)");
      }
      if (module.provider !== id) {
        throw new Error(
          `module.provider '${String(module.provider)}' does not match manifest id '${id}' — the manifest is the curator-reviewed truth`,
        );
      }
      declared.delete(id);
      active.set(id, {
        id,
        module,
        semantics: pending.decl.sessionSemantics,
        source: { plugin: pending.plugin },
        slice: {
          defaultModel: pending.decl.defaultModel,
          apiKeyEnv: pending.decl.apiKeyEnv,
          baseUrlEnv: pending.decl.baseUrlEnv,
        },
      });
      log.info("Provider plugin activated — full Lane B surface live", {
        provider: id,
        plugin: pending.plugin,
        semantics: pending.decl.sessionSemantics,
      });
    } catch (err) {
      declared.delete(id);
      const reason = err instanceof Error ? err.message : String(err);
      broken.set(id, { plugin: pending.plugin, reason });
      log.error("Provider plugin failed to load — declared-broken (honest per-turn failure, no Claude fallback)", {
        provider: id,
        plugin: pending.plugin,
        reason,
      });
    }
  }
}

/** Active providers only (built-in or activated plugin) — the construction
 *  sites' lookup. */
export function getRegisteredProvider(id: string): RegisteredProvider | undefined {
  return active.get(id);
}

/** True for any PLUGIN-declared id in any state (active, still-declared,
 *  broken) — the resolveProviderModel consult. Built-ins never reach it
 *  (their hardcoded arms fire first). */
export function isPluginDeclaredProvider(id: string): boolean {
  const a = active.get(id);
  return (a !== undefined && a.source !== "builtin") || declared.has(id) || broken.has(id);
}

/** Plugin ids in any state — the model-catalog acceptance set (§4.11). */
export function listPluginProviderIds(): string[] {
  const ids = new Set<string>();
  for (const [id, p] of active) if (p.source !== "builtin") ids.add(id);
  for (const id of declared.keys()) ids.add(id);
  for (const id of broken.keys()) ids.add(id);
  return [...ids];
}

/** §4.3: honest text for a routed-but-unconstructable provider id. */
export function describeUnroutableProvider(id: string): string {
  const b = broken.get(id);
  if (b) return `provider '${id}' from plugin '${b.plugin}' failed to load: ${b.reason}`;
  const d = declared.get(id);
  if (d) {
    return `provider '${id}' from plugin '${d.plugin}' is declared but not yet activated (boot-ordering fault — activateProviderPlugins() must be awaited before spawn-capable surfaces start)`;
  }
  return `provider '${id}' is not registered`;
}

/**
 * §4.3 semantics overlay: built-in Record first, plugin overlay second
 * (declared and broken ids answer with their manifest semantics — the
 * write side must not persist a handle for a stateless-replay provider
 * even while it is broken). Unknown ⇒ undefined.
 */
export function sessionSemanticsIfKnown(provider: string): SessionSemantics | undefined {
  const builtin = (SESSION_SEMANTICS as Partial<Record<string, SessionSemantics>>)[provider];
  if (builtin) return builtin;
  return active.get(provider)?.semantics ?? declared.get(provider)?.decl.sessionSemantics ?? (broken.has(provider) ? brokenSemantics(provider) : undefined);
}

function brokenSemantics(provider: string): SessionSemantics {
  // A broken provider never runs a turn, so no handle is ever produced;
  // fail-safe stateless-replay (never persist a handle).
  return "stateless-replay";
}

/** Route-side lookup: unreachable-unknown defaults fail-safe (§4.3). */
export function sessionSemanticsForRoute(provider: string): SessionSemantics {
  return sessionSemanticsIfKnown(provider) ?? "stateless-replay";
}

export interface OrphanProviderModel {
  agentId: string;
  model: string;
  prefix: string;
}

/**
 * §4.6: boot/reload-time warn for every agent whose model carries a
 * /-prefix matching no registered or built-in provider — such turns run on
 * Claude via the unknown-prefix canon (e.g. after `hive plugin remove`).
 * Returns the orphan list so callers/tests can observe it.
 */
export function warnOrphanProviderPrefixes(
  agents: readonly { agentId: string; model: string }[],
): OrphanProviderModel[] {
  const orphans: OrphanProviderModel[] = [];
  for (const a of agents) {
    const slash = a.model.indexOf("/");
    if (slash <= 0) continue;
    const prefix = a.model.slice(0, slash).toLowerCase();
    if (BUILTIN_ROUTABLE_PREFIXES.has(prefix) || isPluginDeclaredProvider(prefix)) continue;
    orphans.push({ agentId: a.agentId, model: a.model, prefix });
    log.warn(
      "Agent model carries an unknown provider prefix — turns run on Claude via the unknown-prefix canon; if this id belonged to a removed provider plugin, repoint the agent's model",
      { agentId: a.agentId, model: a.model, prefix },
    );
  }
  return orphans;
}

// ── Test seams (never called in production paths) ──────────────────────────

/** Register an already-built plugin module directly (manager tests). */
export function __registerActivePluginProviderForTests(entry: RegisteredProvider): void {
  active.set(entry.id, entry);
}

/** Mark an id declared-broken directly (manager tests). */
export function __markBrokenPluginProviderForTests(id: string, b: BrokenProvider): void {
  broken.set(id, b);
}

/** Remove all plugin state; built-in seed stays. */
export function __resetPluginProvidersForTests(): void {
  for (const [id, p] of [...active]) if (p.source !== "builtin") active.delete(id);
  declared.clear();
  broken.clear();
}
