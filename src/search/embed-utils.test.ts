import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chunkText, meanPool, estimateTokens, embedOllama, EMBED_TOKEN_BUDGET } from "./embed-utils.js";

describe("estimateTokens", () => {
  it("charges non-ASCII characters more than ASCII", () => {
    // The bug this whole change exists to fix: a character-only model treats
    // these as identical cost, which is what let dense text through to a 400.
    expect(estimateTokens("的".repeat(100))).toBeGreaterThan(estimateTokens("a".repeat(100)));
  });

  it("approximates ~4 ASCII chars per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("charges roughly one token per CJK character", () => {
    expect(estimateTokens("的".repeat(100))).toBe(100);
  });
});

describe("chunkText", () => {
  it("returns a single chunk when the text fits the budget", () => {
    expect(chunkText("short text")).toEqual(["short text"]);
  });

  it("returns no chunks for empty input", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("keeps every chunk within the token budget", () => {
    const text = "The quarterly review process requires each team to submit metrics. ".repeat(200);
    for (const chunk of chunkText(text)) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
    }
  });

  it("keeps CJK chunks within budget — the case a char-based cap would miss", () => {
    const text = "本季度的审查流程要求每个团队在截止日期前提交指标数据".repeat(60);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
    }
    // Density-aware sizing must produce far shorter chunks than it would for ASCII.
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(600);
  });

  it("tightens chunking around a dense block inside otherwise-ASCII text", () => {
    const text = "word ".repeat(400) + "的".repeat(1000) + "word ".repeat(400);
    for (const chunk of chunkText(text)) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
    }
  });

  it("splits text with no whitespace at all", () => {
    const chunks = chunkText("a".repeat(10000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(EMBED_TOKEN_BUDGET);
    }
  });

  it("loses no content when reassembled", () => {
    const text = "alpha beta gamma delta epsilon ".repeat(150);
    expect(chunkText(text).join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("prefers natural boundaries over hard cuts", () => {
    const para = "Sentence about metrics and reviews. ".repeat(40);
    // Chunks should not begin mid-word.
    for (const chunk of chunkText(para)) {
      expect(chunk.startsWith("Sentence") || chunk.startsWith("about")).toBe(true);
    }
  });

  it("rejects a non-positive budget", () => {
    expect(() => chunkText("text", 0)).toThrow(/budget must be positive/);
  });
});

describe("meanPool", () => {
  it("returns the single vector unchanged", () => {
    expect(meanPool([[0.6, 0.8]])).toEqual([0.6, 0.8]);
  });

  it("averages and renormalizes to unit length", () => {
    const out = meanPool([
      [1, 0],
      [0, 1],
    ]);
    expect(Math.hypot(...out)).toBeCloseTo(1, 10);
    expect(out[0]).toBeCloseTo(out[1], 10);
  });

  it("preserves dimensionality so stored vectors stay valid", () => {
    const a = new Array(1024).fill(0.01);
    const b = new Array(1024).fill(0.02);
    expect(meanPool([a, b])).toHaveLength(1024);
  });

  it("throws on dimension mismatch", () => {
    expect(() => meanPool([[1, 0], [1]])).toThrow(/dimension mismatch/);
  });

  it("throws when given no vectors", () => {
    expect(() => meanPool([])).toThrow(/no vectors/);
  });

  it("returns a zero vector rather than NaNs when it cannot normalize", () => {
    const out = meanPool([
      [1, -1],
      [-1, 1],
    ]);
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("embedOllama", () => {
  const url = "http://ollama.test";
  let fetchMock: ReturnType<typeof vi.fn>;

  const vec = (seed: number) => new Array(1024).fill(seed);
  const okResponse = (n: number) => ({
    ok: true,
    json: async () => ({ embeddings: Array.from({ length: n }, (_, i) => vec(0.01 * (i + 1))) }),
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends short text as a single request and returns its vector", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(1));
    const out = await embedOllama(url, "short text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual(["short text"]);
    expect(out).toHaveLength(1024);
  });

  it("batches long text into one request and pools the result", async () => {
    const long = "word ".repeat(5000);
    fetchMock.mockImplementation(async (_u: string, init: any) => {
      const n = JSON.parse(init.body).input.length;
      expect(n).toBeGreaterThan(1);
      return okResponse(n);
    });
    const out = await embedOllama(url, long);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1024);
  });

  it("re-splits with a halved budget when the server still reports overflow", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_u: string, init: any) => {
      call++;
      const inputs = JSON.parse(init.body).input;
      // Fail the first batched attempt the way Ollama does.
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => '{"error":"the input length exceeds the context length"}',
        };
      }
      return okResponse(inputs.length);
    });
    const out = await embedOllama(url, "word ".repeat(3000));
    expect(call).toBeGreaterThan(1);
    expect(out).toHaveLength(1024);
  });

  it("does not retry on a non-overflow error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(embedOllama(url, "short text")).rejects.toThrow(/Ollama embed 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the server returns the wrong number of embeddings", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: [] }) });
    await expect(embedOllama(url, "short text")).rejects.toThrow(/expected 1 embeddings/);
  });

  it("refuses empty input instead of sending it", async () => {
    await expect(embedOllama(url, "")).rejects.toThrow(/empty text/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
