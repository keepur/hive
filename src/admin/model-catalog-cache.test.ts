import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GEMINI_CACHE_TTL_MS,
  getCachedGeminiModels,
  setCachedGeminiModels,
  invalidateGeminiModelCache,
} from "./model-catalog-cache.js";

describe("model-catalog-cache", () => {
  beforeEach(() => {
    invalidateGeminiModelCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("misses when empty", () => {
    expect(getCachedGeminiModels()).toBeNull();
  });

  it("hits within TTL", () => {
    setCachedGeminiModels([{ id: "gemini-3.1-pro-preview" }]);
    vi.advanceTimersByTime(GEMINI_CACHE_TTL_MS - 1_000);
    expect(getCachedGeminiModels()).toEqual([{ id: "gemini-3.1-pro-preview" }]);
  });

  it("misses after TTL expiry — stale data is never served", () => {
    setCachedGeminiModels([{ id: "gemini-3.1-pro-preview" }]);
    vi.advanceTimersByTime(GEMINI_CACHE_TTL_MS + 1);
    expect(getCachedGeminiModels()).toBeNull();
  });

  it("invalidate clears an unexpired slice", () => {
    setCachedGeminiModels([{ id: "x" }]);
    invalidateGeminiModelCache();
    expect(getCachedGeminiModels()).toBeNull();
  });
});
