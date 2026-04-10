import { describe, it, expect, beforeEach } from "vitest";
import {
  registerArchetype,
  getArchetype,
  listArchetypeIds,
  __resetRegistryForTests,
  type ArchetypeDefinition,
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
});
