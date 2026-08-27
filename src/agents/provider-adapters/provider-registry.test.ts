import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

// Assertable logs (collision both-names, orphan warns).
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { loadPlugins } from "../../plugins/plugin-loader.js";
import { LANE_B_PROVIDER_MODULES } from "./provider-modules.js";
import { LaneBTurnScaffold } from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { isSseDone, parseSseEvent, splitSseEvents } from "./sse.js";
import {
  __markBrokenPluginProviderForTests,
  __registerActivePluginProviderForTests,
  __resetPluginProvidersForTests,
  activateDeclaredProviders,
  buildProviderKit,
  declarePluginProviders,
  describeUnroutableProvider,
  getRegisteredProvider,
  isPluginDeclaredProvider,
  listPluginProviderIds,
  sessionSemanticsForRoute,
  sessionSemanticsIfKnown,
  warnOrphanProviderPrefixes,
} from "./provider-registry.js";

const FIXTURE_HOME = resolve(import.meta.dirname, "../../../test-fixtures/provider-home");

function makeDecl(overrides: Record<string, unknown> = {}) {
  return {
    id: "sol",
    entry: "provider.ts",
    abi: 1,
    sessionSemantics: "stateless-replay" as const,
    apiKeyEnv: "SOL_API_KEY",
    ...overrides,
  };
}

function makePlugin(name: string, decl: ReturnType<typeof makeDecl> | undefined) {
  return {
    name,
    dir: `/nonexistent/${name}`,
    manifest: { name, mcpServers: {}, agentSeeds: [], provider: decl },
    brokenServers: {},
  } as any;
}

/** Declares against the real fixture on disk (entry resolves for real). */
function declareFixture(decl = makeDecl()) {
  declarePluginProviders([makePlugin("hive-plugin-sol", decl)], { hiveHome: FIXTURE_HOME });
}

const fakeModule = (id: string) => ({ provider: id, createAdapter: vi.fn(() => ({}) as any) });
const importStubFor = (mod: unknown) => vi.fn(async () => ({ createProviderModule: () => mod }));

afterEach(() => {
  __resetPluginProvidersForTests();
  vi.clearAllMocks();
});

describe("built-in seed", () => {
  it("all four Lane B built-ins are active with their table modules and semantics", () => {
    for (const id of ["codex", "openai", "gemini", "grok"] as const) {
      const p = getRegisteredProvider(id)!;
      expect(p.source).toBe("builtin");
      expect(p.module).toBe(LANE_B_PROVIDER_MODULES[id]);
    }
    expect(getRegisteredProvider("codex")!.semantics).toBe("stateless-replay");
    expect(getRegisteredProvider("gemini")!.semantics).toBe("server-resumable");
  });

  it("built-ins are not plugin-declared (resolveProviderModel's hardcoded arms own them)", () => {
    expect(isPluginDeclaredProvider("codex")).toBe(false);
    expect(listPluginProviderIds()).toEqual([]);
  });
});

describe("declare (phase a)", () => {
  it("valid decl → declared-not-yet-loaded: routable, unconstructable, honest text", () => {
    declareFixture();
    expect(isPluginDeclaredProvider("sol")).toBe(true);
    expect(getRegisteredProvider("sol")).toBeUndefined();
    expect(describeUnroutableProvider("sol")).toMatch(/declared but not yet activated/);
  });

  it("reserved id → declared-broken with the reserved reason", () => {
    declarePluginProviders([makePlugin("p1", makeDecl({ id: "kimi" }))], { hiveHome: FIXTURE_HOME });
    expect(isPluginDeclaredProvider("kimi")).toBe(true);
    expect(describeUnroutableProvider("kimi")).toMatch(/reserved/);
  });

  it("abi mismatch → declared-broken naming both numbers", () => {
    declarePluginProviders([makePlugin("p1", makeDecl({ abi: 2 }))], { hiveHome: FIXTURE_HOME });
    expect(describeUnroutableProvider("sol")).toMatch(/ABI 2/);
    expect(describeUnroutableProvider("sol")).toMatch(/provides 1/);
  });

  it("unresolvable entry → declared-broken until restart", () => {
    declarePluginProviders([makePlugin("no-such-plugin", makeDecl())], { hiveHome: FIXTURE_HOME });
    expect(describeUnroutableProvider("sol")).toMatch(/entry not resolvable/);
  });

  it("collision: first wins, second rejected with both names logged — even when the second decl is itself invalid (order fix)", () => {
    declareFixture();
    declarePluginProviders([makePlugin("hive-plugin-sol2", makeDecl({ abi: 2 }))], { hiveHome: FIXTURE_HOME });
    // First registrant's state is untouched: the collision check runs
    // BEFORE validation, so the second plugin's invalid (abi-mismatch)
    // decl never overwrites or shadows the id it doesn't own.
    expect(describeUnroutableProvider("sol")).toMatch(/declared but not yet activated/); // first's state intact
    expect(describeUnroutableProvider("sol")).not.toMatch(/ABI/); // no stray broken row from the second decl
    const collisionLog = mockLog.error.mock.calls.find(([msg]) => String(msg).includes("collision"));
    expect(collisionLog![1]).toMatchObject({ provider: "sol", first: "hive-plugin-sol", second: "hive-plugin-sol2" });
  });

  it("a plugin cannot shadow a BUILT-IN-seeded id — declared-broken, built-in module keeps the slot (edge 2)", () => {
    // 'sol' is deliberately NOT in RESERVED_PROVIDER_IDS: this pins the guard
    // to the live built-in seed, not to the hand-maintained reserved list
    // (which will drift the day a new built-in ships without a list edit).
    const builtinModule = fakeModule("sol");
    __registerActivePluginProviderForTests({
      id: "sol",
      module: builtinModule as any,
      semantics: "stateless-replay",
      source: "builtin",
    });
    declareFixture();
    expect(describeUnroutableProvider("sol")).toMatch(/built-in/);
    const p = getRegisteredProvider("sol")!;
    expect(p.source).toBe("builtin");
    expect(p.module).toBe(builtinModule); // never replaced by the plugin's
  });

  it("re-declare from the SAME plugin is idempotent (manager re-construction)", () => {
    declareFixture();
    declareFixture();
    expect(mockLog.error.mock.calls.filter(([m]) => String(m).includes("collision"))).toHaveLength(0);
    expect(isPluginDeclaredProvider("sol")).toBe(true);
  });
});

describe("activate (phase b)", () => {
  it("success: active with plugin source, manifest semantics, and slice", async () => {
    declareFixture();
    await activateDeclaredProviders(importStubFor(fakeModule("sol")));
    const p = getRegisteredProvider("sol")!;
    expect(p.source).toEqual({ plugin: "hive-plugin-sol" });
    expect(p.semantics).toBe("stateless-replay");
    expect(p.slice).toEqual({ defaultModel: undefined, apiKeyEnv: "SOL_API_KEY", baseUrlEnv: undefined });
    expect(listPluginProviderIds()).toEqual(["sol"]);
  });

  it("kit: abiVersion 1 and the RUNNING engine's layer by reference", () => {
    const kit = buildProviderKit();
    expect(kit.abiVersion).toBe(1);
    expect(kit.LaneBTurnScaffold).toBe(LaneBTurnScaffold);
    expect(kit.runBoundedDispatchLoop).toBe(runBoundedDispatchLoop);
    expect(kit.sse).toEqual({ splitSseEvents, parseSseEvent, isSseDone });
    expect(typeof kit.createLogger).toBe("function");
  });

  it("missing createProviderModule export → declared-broken", async () => {
    declareFixture();
    await activateDeclaredProviders(vi.fn(async () => ({})));
    expect(getRegisteredProvider("sol")).toBeUndefined();
    expect(describeUnroutableProvider("sol")).toMatch(/does not export createProviderModule/);
  });

  it("throwing factory → declared-broken with the thrown message", async () => {
    declareFixture();
    await activateDeclaredProviders(
      vi.fn(async () => ({
        createProviderModule: () => {
          throw new Error("boom at factory");
        },
      })),
    );
    expect(describeUnroutableProvider("sol")).toMatch(/boom at factory/);
  });

  it("non-conforming return (no createAdapter) → declared-broken", async () => {
    declareFixture();
    await activateDeclaredProviders(vi.fn(async () => ({ createProviderModule: () => ({ provider: "sol" }) })));
    expect(describeUnroutableProvider("sol")).toMatch(/missing createAdapter/);
  });

  it("module.provider ≠ manifest id → declared-broken (manifest is curator truth)", async () => {
    declareFixture();
    await activateDeclaredProviders(importStubFor(fakeModule("luna")));
    expect(describeUnroutableProvider("sol")).toMatch(/does not match manifest id/);
  });
});

describe("semantics overlay + orphans + fixture e2e", () => {
  it("sessionSemanticsIfKnown: builtin / active plugin / declared plugin / unknown", async () => {
    expect(sessionSemanticsIfKnown("gemini")).toBe("server-resumable");
    declarePluginProviders([makePlugin("hive-plugin-sol", makeDecl({ sessionSemantics: "server-resumable" }))], {
      hiveHome: FIXTURE_HOME,
    });
    expect(sessionSemanticsIfKnown("sol")).toBe("server-resumable"); // declared, pre-activation
    await activateDeclaredProviders(importStubFor(fakeModule("sol")));
    expect(sessionSemanticsIfKnown("sol")).toBe("server-resumable"); // active
    expect(sessionSemanticsIfKnown("zeta")).toBeUndefined();
  });

  it("sessionSemanticsForRoute defaults unknown to stateless-replay (never persist a handle)", () => {
    expect(sessionSemanticsForRoute("zeta")).toBe("stateless-replay");
  });

  // KPR-407 (finding 3): "constructor" is the one Object.prototype member name
  // PROVIDER_ID_REGEX admits. Unguarded, SESSION_SEMANTICS["constructor"]
  // returned Object's constructor function — truthy garbage returned as if it
  // were a SessionSemantics. Own-property guard ⇒ ordinary unknown handling.
  it("prototype-chain id 'constructor' is unknown, not Object's constructor", () => {
    expect(sessionSemanticsIfKnown("constructor")).toBeUndefined();
    expect(sessionSemanticsForRoute("constructor")).toBe("stateless-replay");
  });

  it("warnOrphanProviderPrefixes: bare + builtin + declared skipped; unknown returned + warned", () => {
    declareFixture();
    const orphans = warnOrphanProviderPrefixes([
      { agentId: "a1", model: "claude-opus-5" },
      { agentId: "a2", model: "google-gemini/gemini-3.6-pro" },
      { agentId: "a3", model: "claude/claude-opus-5" },
      { agentId: "a4", model: "sol/sol-large-2" },
      { agentId: "a5", model: "zeta/zeta-9" },
    ]);
    expect(orphans).toEqual([{ agentId: "a5", model: "zeta/zeta-9", prefix: "zeta" }]);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("warnOrphanProviderPrefixes: a malformed agent doc never throws (boot + SIGUSR1 safety)", () => {
    // A throw here reaches main().catch at boot (engine won't start) and
    // aborts the registry reload on SIGUSR1 — one bad doc must not cost that.
    const orphans = warnOrphanProviderPrefixes([
      { agentId: "no-model" },
      { agentId: "undef-model", model: undefined },
      { agentId: "num-model", model: 42 },
      { agentId: "null-model", model: null },
      { agentId: "a5", model: "zeta/zeta-9" },
    ]);
    expect(orphans).toEqual([{ agentId: "a5", model: "zeta/zeta-9", prefix: "zeta" }]);
  });

  it("fixture e2e: real loadPlugins → declare → REAL dynamic import → adapter turn", async () => {
    const plugins = loadPlugins(["hive-plugin-sol"], FIXTURE_HOME);
    expect(plugins).toHaveLength(1);
    declarePluginProviders(plugins, { hiveHome: FIXTURE_HOME });
    await activateDeclaredProviders(); // default importFn — real import()
    const p = getRegisteredProvider("sol")!;
    expect(p.slice?.defaultModel).toBe("sol-large-2");
    const adapter = p.module.createAdapter({
      name: "Sol",
      route: { model: "sol-large-2" },
      assembly: {} as any,
      context: "primary",
      deps: {},
    });
    const result = await adapter.runTurn({ prompt: "hi" });
    expect(result.text).toContain("sol turn ok (model=sol-large-2)");
  });
});
