/**
 * KPR-394 (§4.1/§4.7): the light manifest layer for provider plugins —
 * normalization, validation, and quiet manifest reading. NO adapter or
 * engine-runtime imports: `hive plugin add`, `hive credentials`, and
 * `hive doctor` consume this without dragging the Lane B implementation
 * layer into the CLI bundle. The runtime registry
 * (src/agents/provider-adapters/provider-registry.ts) builds on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { allCredentialKeys } from "../setup/credential-registry.js";
import type { PluginProviderDecl } from "./types.js";

/** §4.1: model-prefix shape — lowercase, 2–16 chars, letter first. */
export const PROVIDER_ID_REGEX = /^[a-z][a-z0-9-]{1,15}$/;

/**
 * §4.1: the full set resolveProviderModel recognizes plus aliases and the
 * compatibility key: `laneB` itself is unreachable via the lowercase-only id
 * regex (reserved for clarity); `laneb` is its reachable lowercased
 * near-miss.
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "claude",
  "openai",
  "openai-codex",
  "codex",
  "gemini",
  "google-gemini",
  "grok",
  "kimi",
  "deepseek",
  "laneB",
  "laneb",
  // KPR-407 (finding 3): "constructor" is the SOLE Object.prototype member
  // name PROVIDER_ID_REGEX can admit (every other one carries an uppercase
  // letter or "__"), so this is a closed one-entry addition — not the start
  // of a prototype-name list. The two indexed lookups it could reach are
  // hasOwnProperty-guarded independently (provider-registry.ts,
  // tool-transport.ts); reserving the id is the belt to that suspenders.
  "constructor",
]);

/**
 * §4.6: prefixes the engine routes without a plugin — used by the
 * orphan-model warn and doctor. (`claude` included: `claude/x` falls through
 * the unknown-prefix canon to Claude, which is not an orphan condition.)
 */
export const BUILTIN_ROUTABLE_PREFIXES: ReadonlySet<string> = new Set([
  "claude",
  "openai",
  "openai-codex",
  "codex",
  "gemini",
  "google-gemini",
  "grok",
  "kimi",
  "deepseek",
]);

const ENV_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * §4.9: a plugin provider is never handed a sibling's credential. `api-key-env`
 * is otherwise unconstrained — the engine resolves whatever it names through
 * env → Honeypot Keychain and hands the value to the plugin's module — so a
 * manifest naming e.g. ANTHROPIC_API_KEY or GEMINI_API_KEY would be a
 * curated-registry credential grab. Derived from the curated registry itself,
 * never hand-copied, so new engine credentials are covered the day they land.
 * (credential-registry.ts is pure data with no imports of its own — the
 * dependency-light posture of this module is preserved.)
 */
const RESERVED_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(allCredentialKeys());

/**
 * Structural normalization — THROWS on garbage (missing/mistyped required
 * keys, unknown session-semantics), matching normalizeServerEntry's
 * precedent: an unparseable block invalidates the manifest and the loader
 * skips the plugin with an error log. Semantic failures where the id is
 * known (regex, reserved, abi, collision, entry) are validateProviderDecl /
 * registry territory and land declared-broken instead. `hive plugin add`
 * runs both at install time, so the curated path surfaces every class
 * before the restart.
 */
export function normalizeProviderDecl(raw: any): PluginProviderDecl {
  if (!raw || typeof raw !== "object") throw new Error("provider block must be a mapping");
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("provider.id must be a non-empty string");
  const entry = raw.entry;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("provider.entry must be a non-empty string");
  }
  const abi = raw.abi;
  if (typeof abi !== "number" || !Number.isInteger(abi)) {
    throw new Error("provider.abi must be an integer");
  }
  const semantics = raw["session-semantics"] ?? raw.sessionSemantics;
  if (semantics !== "stateless-replay" && semantics !== "server-resumable") {
    throw new Error(
      `provider.session-semantics must be 'stateless-replay' or 'server-resumable' (got ${JSON.stringify(semantics)})`,
    );
  }
  const optStr = (v: unknown, name: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`provider.${name} must be a non-empty string when set`);
    }
    return v;
  };
  return {
    id,
    entry,
    abi,
    sessionSemantics: semantics,
    defaultModel: optStr(raw["default-model"] ?? raw.defaultModel, "default-model"),
    apiKeyEnv: optStr(raw["api-key-env"] ?? raw.apiKeyEnv, "api-key-env"),
    baseUrlEnv: optStr(raw["base-url-env"] ?? raw.baseUrlEnv, "base-url-env"),
    description: optStr(raw.description, "description"),
  };
}

export type ProviderDeclVerdict = { ok: true } | { ok: false; reason: string };

/** §4.1/§4.7 semantic validation — shared by the registry's declare pass,
 *  `hive plugin add`, and doctor's static audit. */
export function validateProviderDecl(decl: PluginProviderDecl, engineAbi: number): ProviderDeclVerdict {
  if (!PROVIDER_ID_REGEX.test(decl.id)) {
    return {
      ok: false,
      reason: `provider id '${decl.id}' is invalid — must match ${String(PROVIDER_ID_REGEX)} (lowercase, 2-16 chars, letter first)`,
    };
  }
  if (RESERVED_PROVIDER_IDS.has(decl.id)) {
    return {
      ok: false,
      reason: `provider id '${decl.id}' is reserved (built-in provider ids, their aliases, and the laneB compatibility key cannot be re-registered)`,
    };
  }
  if (decl.abi !== engineAbi) {
    return {
      ok: false,
      reason: `plugin requires provider ABI ${decl.abi}; engine provides ${engineAbi} — ${
        decl.abi > engineAbi
          ? "upgrade hive or install an older plugin version"
          : "install a newer plugin version built for this engine"
      }`,
    };
  }
  if (decl.apiKeyEnv !== undefined && !ENV_KEY_REGEX.test(decl.apiKeyEnv)) {
    return { ok: false, reason: `provider.api-key-env '${decl.apiKeyEnv}' is not a valid env var name` };
  }
  if (decl.apiKeyEnv !== undefined && RESERVED_CREDENTIAL_KEYS.has(decl.apiKeyEnv)) {
    return {
      ok: false,
      reason: `provider.api-key-env '${decl.apiKeyEnv}' is a curated engine credential key — a provider plugin must declare its own key (§4.9: a plugin provider is never handed a sibling's credential)`,
    };
  }
  if (decl.baseUrlEnv !== undefined && !ENV_KEY_REGEX.test(decl.baseUrlEnv)) {
    return { ok: false, reason: `provider.base-url-env '${decl.baseUrlEnv}' is not a valid env var name` };
  }
  return { ok: true };
}

/**
 * Quiet manifest reader for out-of-engine consumers (credentials CLI,
 * plugin add collision check, doctor). Same dual-path resolution as
 * loadPlugins (npm-installed first, in-tree fallback); unreadable or
 * structurally-invalid manifests are skipped silently — the loader's own
 * pass logs them.
 */
export function readInstalledProviderDecls(
  pluginNames: readonly string[],
  rootDir: string,
): { plugin: string; decl: PluginProviderDecl }[] {
  const out: { plugin: string; decl: PluginProviderDecl }[] = [];
  for (const name of pluginNames) {
    for (const dir of [join(rootDir, "plugins", "node_modules", name), join(rootDir, "plugins", name)]) {
      const manifestPath = join(dir, "plugin.yaml");
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
        if (raw?.provider !== undefined) out.push({ plugin: name, decl: normalizeProviderDecl(raw.provider) });
      } catch {
        // Skipped quietly — the engine loader's pass owns the error log.
      }
      break; // first existing manifest wins, matching loadPlugins
    }
  }
  return out;
}

export interface ProviderDeclAuditRow {
  plugin: string;
  id: string;
  abi: number;
  semantics: string;
  status: "ok" | "broken";
  reason?: string;
}

/**
 * §4.8: doctor's STATIC view — validation + collision + (optionally) entry
 * resolution, derived from manifests alone. Runtime activation faults
 * (a throwing factory) are engine-process facts and surface in engine logs
 * and per-turn errors, not here; the render notes that honestly.
 */
export function auditInstalledProviderDecls(
  pluginNames: readonly string[],
  rootDir: string,
  engineAbi: number,
  resolveEntry?: (plugin: string, entry: string) => boolean,
): ProviderDeclAuditRow[] {
  const rows: ProviderDeclAuditRow[] = [];
  const seen = new Map<string, string>(); // id → first registrant
  for (const { plugin, decl } of readInstalledProviderDecls(pluginNames, rootDir)) {
    const base = { plugin, id: decl.id, abi: decl.abi, semantics: decl.sessionSemantics };
    // Collision keying mirrors the runtime's `pluginOwnerOf`: the FIRST
    // declarant claims the id even when its own decl is invalid (the runtime
    // records it in `broken`, which owns the id for the process's life). So a
    // later valid declarant of the same id renders broken-by-collision here —
    // matching runtime, where every turn on that id fails with the FIRST
    // declarant's reason. Validating before claiming would render the second
    // "ok" in doctor while runtime fails it.
    const first = seen.get(decl.id);
    if (first) {
      rows.push({
        ...base,
        status: "broken",
        reason: `id collision — already registered by plugin '${first}' (first registration wins)`,
      });
      continue;
    }
    seen.set(decl.id, plugin);
    const verdict = validateProviderDecl(decl, engineAbi);
    if (!verdict.ok) {
      rows.push({ ...base, status: "broken", reason: verdict.reason });
      continue;
    }
    if (resolveEntry && !resolveEntry(plugin, decl.entry)) {
      rows.push({
        ...base,
        status: "broken",
        reason: `compiled entry not resolvable (expected dist/${decl.entry.replace(/\.ts$/, "")}.(min.)js)`,
      });
      continue;
    }
    rows.push({ ...base, status: "ok" });
  }
  return rows;
}
