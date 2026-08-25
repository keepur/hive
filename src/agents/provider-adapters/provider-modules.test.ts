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
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { LaneBModuleDeps } from "./provider-module.js";
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
    providerConfig: {
      codex: { agentModel: "cfg-codex" },
      openai: { agentModel: "cfg-openai" },
      gemini: { agentModel: "cfg-gemini", apiKey: "k" },
    },
    turnHistoryStore: fakeStore,
    agentId: "a1",
    ...overrides,
  };
}

/** Adapters keep their construction options as a private instance field. */
function optionsOf(adapter: unknown): Record<string, unknown> {
  return (adapter as { options: Record<string, unknown> }).options;
}

describe("LANE_B_PROVIDER_MODULES", () => {
  const assembly = makeAssembly();

  it("is complete and self-consistent: one entry per Lane B provider, key matches module.provider", () => {
    expect(Object.keys(LANE_B_PROVIDER_MODULES).sort()).toEqual(["codex", "gemini", "openai"]);
    for (const [key, module] of Object.entries(LANE_B_PROVIDER_MODULES)) {
      expect(module.provider).toBe(key);
    }
  });

  it("each module constructs its own adapter class with the matching .provider", () => {
    const args = { route: { model: "m" }, assembly, context: "primary" as const, deps: makeDeps() };
    const codex = LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", ...args });
    const openai = LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", ...args });
    const gemini = LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", ...args });

    expect(codex).toBeInstanceOf(CodexSubscriptionAdapter);
    expect(codex.provider).toBe("codex");
    expect(openai).toBeInstanceOf(OpenAIAgentsAdapter);
    expect(openai.provider).toBe("openai");
    expect(gemini).toBeInstanceOf(GeminiInteractionsAdapter);
    expect(gemini.provider).toBe("gemini");
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

  describe("model default chains", () => {
    it("route model wins over the providerConfig slice", () => {
      const deps = makeDeps();
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "route-codex" }, assembly, context: "primary", deps }),
        ).model,
      ).toBe("route-codex");
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route: { model: "route-openai" }, assembly, context: "primary", deps }),
        ).model,
      ).toBe("route-openai");
      expect(
        optionsOf(
          LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "route-gemini" }, assembly, context: "primary", deps }),
        ).model,
      ).toBe("route-gemini");
    });

    it("an empty route model falls back to the providerConfig slice", () => {
      const deps = makeDeps();
      expect(optionsOf(LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("cfg-codex");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("cfg-openai");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("cfg-gemini");
    });

    it("both absent → openai/gemini pin their literal defaults; codex stays undefined-tolerant", () => {
      const deps = makeDeps({ providerConfig: { codex: {}, openai: {}, gemini: {} } });
      expect(optionsOf(LANE_B_PROVIDER_MODULES.openai.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("gpt-5.4-mini");
      expect(optionsOf(LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBe("gemini-3.6-flash");
      // Mirrors the pre-migration call-site expression (`"" || undefined`):
      // the codex adapter resolves its own default downstream.
      expect(optionsOf(LANE_B_PROVIDER_MODULES.codex.createAdapter({ name: "A", route: { model: "" }, assembly, context: "primary", deps })).model).toBeUndefined();
    });
  });

  describe("per-provider option threading", () => {
    it("gemini threads apiKey from its deps slice (undefined when absent)", () => {
      const withKey = optionsOf(
        LANE_B_PROVIDER_MODULES.gemini.createAdapter({ name: "A", route: { model: "m" }, assembly, context: "primary", deps: makeDeps() }),
      );
      expect(withKey.apiKey).toBe("k");

      const withoutKey = optionsOf(
        LANE_B_PROVIDER_MODULES.gemini.createAdapter({
          name: "A",
          route: { model: "m" },
          assembly,
          context: "primary",
          deps: makeDeps({ providerConfig: { gemini: { agentModel: "cfg-gemini" } } }),
        }),
      );
      expect(withoutKey.apiKey).toBeUndefined();
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
        for (const provider of ["codex", "openai", "gemini"] as const) {
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
    // LaneBProviderId = {openai, codex, gemini}.
    expect((LANE_B_PROVIDER_MODULES as Record<string, unknown>)["claude"]).toBeUndefined();
    expect((LANE_B_PROVIDER_MODULES as Record<string, unknown>)["not-a-provider"]).toBeUndefined();
  });
});
