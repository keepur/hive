/**
 * KPR-391 (§4.3/§8): construction-parity pins for the Lane B provider-module
 * registry. These are the table-level guarantees the two agent-manager
 * construction sites now delegate to — most importantly the KPR-354 G4
 * context gate (nested codex constructions omit historyStore/agentId
 * entirely) and the model-default chains moved verbatim from the old call
 * sites.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { LANE_B_PROVIDER_MODULES } from "./provider-modules.js";
import { CodexSubscriptionAdapter } from "./codex-subscription-adapter.js";
import { GeminiInteractionsAdapter } from "./gemini-interactions-adapter.js";
import { OpenAIAgentsAdapter } from "./openai-agents-adapter.js";
import { GrokAdapter } from "./grok-adapter.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { LaneBModuleDeps } from "./provider-module.js";
import type { LaneBProviderId } from "./types.js";
import type { TurnHistoryStore } from "../turn-history-store.js";

function makeAssembly(overrides: Partial<ProviderTurnAssembly> = {}): ProviderTurnAssembly {
  return {
    instructions: "Be useful.",
    toolInventory: [],
    omittedTools: [],
    guardrailGate: async () => ({ behavior: "allow" }),
    memory: {},
    skillIndex: [],
    inProcessServers: {},
    sessionCwd: tmpdir(),
    ...overrides,
  };
}

const fakeStore = { load: async () => [], save: async () => {}, clear: async () => {} } as unknown as TurnHistoryStore;

function makeDeps(overrides: Partial<LaneBModuleDeps> = {}): LaneBModuleDeps {
  return {
    providerConfig: { agentModel: "cfg-model" },
    turnHistoryStore: fakeStore,
    agentId: "a1",
    ...overrides,
  };
}

/**
 * Deps carrying ONE provider's own config slice — the shape the manager now
 * resolves per construction. `providerConfig` is deliberately singular: a
 * module is never handed another provider's agentModel or apiKey.
 */
const OWN_SLICE: Record<LaneBProviderId, { agentModel?: string; apiKey?: string; baseUrl?: string }> = {
  codex: { agentModel: "cfg-codex" },
  openai: { agentModel: "cfg-openai" },
  gemini: { agentModel: "cfg-gemini", apiKey: "k" },
  grok: { agentModel: "cfg-grok", apiKey: "gk" },
};

function depsFor(provider: LaneBProviderId, overrides: Partial<LaneBModuleDeps> = {}): LaneBModuleDeps {
  return makeDeps({ providerConfig: { ...OWN_SLICE[provider] }, ...overrides });
}

/** Adapters keep their construction options as a private instance field. */
function optionsOf(adapter: unknown): Record<string, unknown> {
  return (adapter as { options: Record<string, unknown> }).options;
}

describe("LANE_B_PROVIDER_MODULES", () => {
  const assembly = makeAssembly();

  it("is complete and self-consistent: one entry per Lane B provider, key matches module.provider", () => {
    expect(Object.keys(LANE_B_PROVIDER_MODULES).sort()).toEqual(["codex", "gemini", "grok", "openai"]);
    for (const [key, module] of Object.entries(LANE_B_PROVIDER_MODULES)) {
      expect(module.provider).toBe(key);
    }
  });

  it("each module constructs its own adapter class with the matching .provider", () => {
    const args = { route: { model: "m" }, assembly, context: "primary" as const, deps: makeDeps() };
    const codex = LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", ...args });
    const openai = LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", ...args });
    const gemini = LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", ...args });
    const grok = LANE_B_PROVIDER_MODULES.grok.createAdapter({ name: "A", ...args });

    expect(codex).toBeInstanceOf(CodexSubscriptionAdapter);
    expect(codex.provider).toBe("codex");
    expect(openai).toBeInstanceOf(OpenAIAgentsAdapter);
    expect(openai.provider).toBe("openai");
    expect(gemini).toBeInstanceOf(GeminiInteractionsAdapter);
    expect(gemini.provider).toBe("gemini");
    expect(grok).toBeInstanceOf(GrokAdapter);
    expect(grok.provider).toBe("grok");
  });

  describe("codex context gate (KPR-354 G4)", () => {
    it("primary carries historyStore + agentId from the deps slice", () => {
      const adapter = LANE_B_PROVIDER_MODULES.codex.createAdapter({
        name: "A",
        route: { model: "m" },
        assembly,
        context: "primary",
        deps: makeDeps(),
      });
      const options = optionsOf(adapter);
      expect(options.historyStore).toBe(fakeStore);
      expect(options.agentId).toBe("a1");
    });

    it("primary keeps the keys present even when the manager carries no store (historyStore: undefined)", () => {
      const adapter = LANE_B_PROVIDER_MODULES.codex.createAdapter({
        name: "A",
        route: { model: "m" },
        assembly,
        context: "primary",
        deps: makeDeps({ turnHistoryStore: undefined }),
      });
      const options = optionsOf(adapter);
      expect("historyStore" in options).toBe(true);
      expect(options.historyStore).toBeUndefined();
      expect(options.agentId).toBe("a1");
    });

    it("nested OMITS both keys entirely — provider_turn_history is untouchable by construction", () => {
      const adapter = LANE_B_PROVIDER_MODULES.codex.createAdapter({
        name: "A:delegate",
        route: { model: "m" },
        assembly,
        context: "nested",
        deps: makeDeps(),
      });
      const options = optionsOf(adapter);
      expect("historyStore" in options).toBe(false);
      expect("agentId" in options).toBe(false);
    });
  });

  describe("grok context gate (KPR-392, mirrors codex KPR-354 G4)", () => {
    it("primary carries historyStore + agentId from the deps slice", () => {
      const adapter = LANE_B_PROVIDER_MODULES.grok.createAdapter({
        name: "A",
        route: { model: "m" },
        assembly,
        context: "primary",
        deps: makeDeps(),
      });
      const options = optionsOf(adapter);
      expect(options.historyStore).toBe(fakeStore);
      expect(options.agentId).toBe("a1");
    });

    it("primary keeps the keys present even when the manager carries no store (historyStore: undefined)", () => {
      const adapter = LANE_B_PROVIDER_MODULES.grok.createAdapter({
        name: "A",
        route: { model: "m" },
        assembly,
        context: "primary",
        deps: makeDeps({ turnHistoryStore: undefined }),
      });
      const options = optionsOf(adapter);
      expect("historyStore" in options).toBe(true);
      expect(options.historyStore).toBeUndefined();
      expect(options.agentId).toBe("a1");
    });

    it("nested OMITS both keys entirely — provider_turn_history is untouchable by construction", () => {
      const adapter = LANE_B_PROVIDER_MODULES.grok.createAdapter({
        name: "A:delegate",
        route: { model: "m" },
        assembly,
        context: "nested",
        deps: makeDeps(),
      });
      const options = optionsOf(adapter);
      expect("historyStore" in options).toBe(false);
      expect("agentId" in options).toBe(false);
    });
  });

  describe("grok model + option threading (KPR-392, mirrors codex/gemini model + option threading)", () => {
    it("route model wins over the providerConfig slice", () => {
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.grok.createAdapter({ name: "A", route: { model: "route-grok" }, assembly, context: "primary", deps: depsFor("grok") }),
        ).model,
      ).toBe("route-grok");
    });

    it("an empty route model falls back to the providerConfig slice", () => {
      expect(optionsOf(LANE_B_PROVIDER_MODULES.grok.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps: depsFor("grok") })).model).toBe("cfg-grok");
    });

    it("both absent → pins the literal default grok-4.6", () => {
      const deps = makeDeps({ providerConfig: {} });
      expect(optionsOf(LANE_B_PROVIDER_MODULES.grok.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("grok-4.6");
    });

    it("threads apiKey (grok's resolved OAuth access token) from its OWN deps slice", () => {
      const withKey = optionsOf(
        LANE_B_PROVIDER_MODULES.grok.createAdapter({ name: "A", route: { model: "m" }, assembly, context: "primary", deps: depsFor("grok") }),
      );
      expect(withKey.apiKey).toBe("gk");

      const withoutKey = optionsOf(
        LANE_B_PROVIDER_MODULES.grok.createAdapter({
          name: "A",
          route: { model: "m" },
          assembly,
          context: "primary",
          deps: makeDeps({ providerConfig: { agentModel: "cfg-grok" } }),
        }),
      );
      expect(withoutKey.apiKey).toBeUndefined();
    });

    it("passes the route's reasoningEffort through", () => {
      const deps = makeDeps();
      const route = { model: "m", reasoningEffort: "high" as const };
      expect(optionsOf(LANE_B_PROVIDER_MODULES.grok.createAdapter({ name: "A", route, assembly, context: "primary", deps })).reasoningEffort).toBe("high");
    });
  });

  describe("model default chains", () => {
    it("route model wins over the providerConfig slice", () => {
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "route-codex" }, assembly, context: "primary", deps: depsFor("codex") }),
        ).model,
      ).toBe("route-codex");
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route: { model: "route-openai" }, assembly, context: "primary", deps: depsFor("openai") }),
        ).model,
      ).toBe("route-openai");
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "route-gemini" }, assembly, context: "primary", deps: depsFor("gemini") }),
        ).model,
      ).toBe("route-gemini");
    });

    it("an empty route model falls back to the providerConfig slice", () => {
      expect(optionsOf(LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps: depsFor("codex") })).model).toBe("cfg-codex");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps: depsFor("openai") })).model).toBe("cfg-openai");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps: depsFor("gemini") })).model).toBe("cfg-gemini");
    });

    it("both absent → openai/gemini pin their literal defaults; codex stays undefined-tolerant", () => {
      const deps = makeDeps({ providerConfig: {} });
      expect(optionsOf(LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("gpt-5.4-mini");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("gemini-3.6-flash");
      // Mirrors the pre-migration call-site expression (`"" || undefined`):
      // the codex adapter resolves its own default downstream.
      expect(optionsOf(LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBeUndefined();
    });
  });

  describe("per-provider option threading", () => {
    it("gemini threads apiKey from its OWN deps slice (undefined when absent)", () => {
      const withKey = optionsOf(
        LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "m" }, assembly, context: "primary", deps: depsFor("gemini") }),
      );
      expect(withKey.apiKey).toBe("k");

      const withoutKey = optionsOf(
        LANE_B_PROVIDER_MODULES.gemini.createAdapter({
          name: "A",
          route: { model: "m" },
          assembly,
          context: "primary",
          deps: makeDeps({ providerConfig: { agentModel: "cfg-gemini" } }),
        }),
      );
      expect(withoutKey.apiKey).toBeUndefined();
    });

    it("an omitted providerConfig is tolerated — no slice, no credential", () => {
      const deps = makeDeps({ providerConfig: undefined });
      expect(optionsOf(LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBeUndefined();
      const gemini = optionsOf(
        LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps }),
      );
      expect(gemini.model).toBe("gemini-3.6-flash");
      expect(gemini.apiKey).toBeUndefined();
    });

    it("codex + gemini pass the route's reasoningEffort through; openai never carries one", () => {
      const deps = makeDeps();
      const route = { model: "m", reasoningEffort: "high" as const };
      expect(optionsOf(LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route, assembly, context: "primary", deps })).reasoningEffort).toBe("high");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route, assembly, context: "primary", deps })).reasoningEffort).toBe("high");
      // docs/providers.md: openai effort is parsed-but-not-delivered — the
      // options type has no such field.
      const openaiOptions = optionsOf(
        LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route, assembly, context: "primary", deps }),
      );
      expect("reasoningEffort" in openaiOptions).toBe(false);
    });

    it("name + assembly pass through verbatim in both contexts", () => {
      const deps = makeDeps();
      for (const context of ["primary", "nested"] as const) {
        for (const provider of ["codex", "openai", "gemini", "grok"] as const) {
          const options = optionsOf(
            LANE_B_PROVIDER_MODULES[provider].createAdapter({
              name: `Parent:${context}`,
              route: { model: "m" },
              assembly,
              context,
              deps,
            }),
          );
          expect(options.name).toBe(`Parent:${context}`);
          expect(options.assembly).toBe(assembly);
        }
      }
    });
  });

  it("registry miss is containment, not a construction: a non-Lane-B key indexes to undefined", () => {
    // Documents that agent-manager's `provider … does not execute tools`
    // branch is the miss path. Type-unreachable while
    // LaneBProviderId = {openai, codex, gemini, grok}.
    expect((LANE_B_PROVIDER_MODULES as Record<string, unknown>)["claude"]).toBeUndefined();
    expect((LANE_B_PROVIDER_MODULES as Record<string, unknown>)["not-a-provider"]).toBeUndefined();
  });
});
