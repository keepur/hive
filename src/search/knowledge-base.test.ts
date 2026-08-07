import { describe, it, expect } from "vitest";
import { KnowledgeBase } from "./knowledge-base.js";

describe("KnowledgeBase", () => {
  it("exports the KnowledgeBase class", () => {
    expect(KnowledgeBase).toBeDefined();
    expect(typeof KnowledgeBase).toBe("function");
  });

  it("can be instantiated with custom URLs", () => {
    const kb = new KnowledgeBase("http://localhost:6333", "http://localhost:11434");
    expect(kb).toBeInstanceOf(KnowledgeBase);
  });

  it("can be instantiated without arguments (uses env defaults)", () => {
    const kb = new KnowledgeBase();
    expect(kb).toBeInstanceOf(KnowledgeBase);
  });
});
