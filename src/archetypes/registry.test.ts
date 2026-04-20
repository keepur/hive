import { describe, it, expect, beforeEach } from "vitest";
import {
  registerArchetype,
  getArchetype,
  listArchetypeIds,
  __resetRegistryForTests,
  type ArchetypeDefinition,
  type ArchetypeConfigFieldSchema,
} from "./registry.js";

function stub(id: string, overrides: Partial<ArchetypeDefinition> = {}): ArchetypeDefinition {
  return {
    id,
    validateConfig: (c) => c,
    systemPromptCard: () => `card:${id}`,
    preToolUseHooks: () => [],
    memoryScopes: () => [],
    sessionOptions: () => ({}),
    ...overrides,
  };
}

describe("archetype registry", () => {
  beforeEach(() => __resetRegistryForTests());

  it("registers and looks up an archetype by id", () => {
    registerArchetype(stub("software-engineer"));
    expect(getArchetype("software-engineer")?.id).toBe("software-engineer");
  });

  it("returns undefined for unknown ids", () => {
    expect(getArchetype("bookkeeper")).toBeUndefined();
  });

  it("lists registered ids", () => {
    registerArchetype(stub("a"));
    registerArchetype(stub("b"));
    expect(listArchetypeIds().sort()).toEqual(["a", "b"]);
  });

  it("overwrites on duplicate registration (idempotent reload)", () => {
    registerArchetype(stub("x", { systemPromptCard: () => "first" }));
    registerArchetype(stub("x", { systemPromptCard: () => "second" }));
    const card = getArchetype("x")!.systemPromptCard({
      agentConfig: {} as any,
      archetypeConfig: {},
    });
    expect(card).toBe("second");
  });

  it("registers an archetype without description/whenToUse/configSchema (back-compat)", () => {
    registerArchetype(stub("legacy"));
    const def = getArchetype("legacy");
    expect(def).toBeDefined();
    expect(def?.description).toBeUndefined();
    expect(def?.whenToUse).toBeUndefined();
    expect(def?.configSchema).toBeUndefined();
  });

  it("surfaces description/whenToUse/configSchema when provided", () => {
    registerArchetype(
      stub("software-engineer", {
        description: "Owns codebases.",
        whenToUse: "When the role centers on shipping code.",
        configSchema: {
          workshop: { type: "string", required: true, description: "Engineering root." } satisfies ArchetypeConfigFieldSchema,
        },
      }),
    );
    const def = getArchetype("software-engineer");
    expect(def?.description).toBe("Owns codebases.");
    expect(def?.whenToUse).toBe("When the role centers on shipping code.");
    expect(def?.configSchema?.workshop.required).toBe(true);
  });
});
